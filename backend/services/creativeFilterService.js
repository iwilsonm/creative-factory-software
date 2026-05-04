/**
 * Creative Filter Service — Node.js port of scoring + grouping from filter.sh
 *
 * Runs inline during Director test runs with SSE progress events.
 * Reuses existing anthropic.js wrappers for API calls + cost tracking.
 */

import crypto from 'crypto';
import { chat, chatWithImage, extractJSON } from './anthropic.js';
import { chat as openAIChat } from './openai.js';
import sharp from 'sharp';
import {
  getProject, getLatestDoc, getBatchJob, updateBatchJob,
  getAdsByBatchId, getAd, downloadToBuffer,
  createAdSet, createDeploymentDuplicate, updateDeployment,
  convexClient, api,
  updateAdSet, getAdSetsByProject, getConductorConfig, getActiveConductorAngles,
  ensureDefaultCampaign,
  // Phase 1 — Staging Page lifecycle
  setFilterVerdict,
  // Phase 9 — Auto-posting
  createAutoPostLog, upsertConductorConfig,
} from '../convexClient.js';
import { filterHeadlineCandidatePool, selectDiverseHeadlines } from './headlineDiversity.js';
import { evaluateAutoPostGate } from './autoPostGate.js';
import { postAdSetToMeta } from './metaWriter.js';

// Models — match filter.conf
const SCORE_MODEL = 'claude-sonnet-4-6';
const GROUP_MODEL = 'gpt-4.1-mini';
const GROUP_FALLBACK_MODEL = 'claude-sonnet-4-6';
const SCORE_THRESHOLD = 7;
const DIRECTOR_SCORE_WEIGHTS = {
  copy_polish: 0.10,
  meta_compliance: 0.20,
  effectiveness: 0.10,
  visual_integrity_score: 0.35,
  visual_contract_match: 0.25,
};
const IMAGES_PER_FLEX = 5;
const HEADLINES_TARGET = 5;
const HEADLINE_POOL_TARGET = 7;
const PRIMARY_TEXTS_TARGET = 5;
const HEADLINES_MIN = 3;
const PRIMARY_TEXTS_MIN = 3;

function clampScore(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  if (numeric < 0) return 0;
  if (numeric > 10) return 10;
  return Math.round(numeric * 10) / 10;
}

function normalizeBooleanFlag(value) {
  if (value === true || value === false) return value;
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase();
    if (lowered === 'true') return true;
    if (lowered === 'false') return false;
  }
  return null;
}

function normalizeAdSetImageTarget(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return IMAGES_PER_FLEX;
  return Math.max(1, Math.min(20, Math.floor(numeric)));
}

function buildHardRequirementValue(value, { required = true } = {}) {
  const normalized = normalizeBooleanFlag(value);
  if (normalized === null) return required ? false : null;
  return normalized;
}

export function buildAdScoringContract(ad = {}) {
  const scoringMode = ad?.scoring_mode
    || ((ad?.template_image_id || ad?.inspiration_image_id) ? 'template_copy_on_creative' : 'standard');
  const copyRenderExpectation = ad?.copy_render_expectation
    || (scoringMode === 'template_copy_on_creative' ? 'rendered' : 'not_required');
  const productExpectation = ad?.product_expectation
    || (scoringMode === 'template_copy_on_creative' ? 'diagnostic' : 'not_required');
  return {
    scoring_mode: scoringMode,
    copy_render_expectation: copyRenderExpectation,
    product_expectation: productExpectation,
  };
}

function computeDirectorOverallScore(scores) {
  let weightedTotal = 0;
  let totalWeight = 0;
  for (const [field, weight] of Object.entries(DIRECTOR_SCORE_WEIGHTS)) {
    const score = clampScore(scores[field], 0);
    weightedTotal += score * weight;
    totalWeight += weight;
  }
  if (totalWeight <= 0) return 0;
  return Math.round((weightedTotal / totalWeight) * 10) / 10;
}

export function normalizeDirectorScore(rawScore, contract = {}, { hasImage = true } = {}) {
  const hardRequirements = rawScore?.hard_requirements || {};
  const productRequired = contract.product_expectation === 'required';
  const copyRendered = contract.copy_render_expectation === 'rendered';

  const normalizedHardRequirements = {
    spelling_grammar: buildHardRequirementValue(hardRequirements.spelling_grammar, { required: true }),
    product_present: buildHardRequirementValue(
      hardRequirements.product_present,
      { required: productRequired }
    ),
    correct_product: buildHardRequirementValue(
      hardRequirements.correct_product,
      { required: productRequired }
    ),
    visual_integrity: buildHardRequirementValue(
      hardRequirements.visual_integrity ?? hardRequirements.image_completeness,
      { required: hasImage }
    ),
    rendered_text_integrity: buildHardRequirementValue(
      hardRequirements.rendered_text_integrity,
      { required: copyRendered }
    ),
  };

  const requiredHardRequirementValues = [
    normalizedHardRequirements.spelling_grammar,
    productRequired ? normalizedHardRequirements.product_present : null,
    productRequired ? normalizedHardRequirements.correct_product : null,
    normalizedHardRequirements.visual_integrity,
    copyRendered ? normalizedHardRequirements.rendered_text_integrity : null,
  ];

  const allRequiredPassed = requiredHardRequirementValues
    .filter((value) => value !== null)
    .every((value) => value === true);

  const normalizedScores = {
    copy_polish: clampScore(rawScore?.copy_polish ?? rawScore?.copy_strength, 0),
    meta_compliance: clampScore(rawScore?.meta_compliance ?? rawScore?.compliance, 0),
    effectiveness: clampScore(rawScore?.effectiveness, 0),
    visual_integrity_score: clampScore(rawScore?.visual_integrity_score ?? rawScore?.image_quality, hasImage ? 0 : 5),
    visual_contract_match: clampScore(
      rawScore?.visual_contract_match ?? rawScore?.image_quality ?? rawScore?.effectiveness,
      hasImage ? 0 : 5
    ),
  };

  if (contract.scoring_mode === 'template_copy_on_creative' && allRequiredPassed) {
    normalizedScores.copy_polish = Math.max(normalizedScores.copy_polish, 5);
    normalizedScores.effectiveness = Math.max(normalizedScores.effectiveness, 5);
  }

  const overallScore = computeDirectorOverallScore(normalizedScores);
  const pass = allRequiredPassed && overallScore >= SCORE_THRESHOLD;
  const imageQuality = Math.round(((normalizedScores.visual_integrity_score + normalizedScores.visual_contract_match) / 2) * 10) / 10;

  return {
    ad_id: rawScore?.ad_id,
    scoring_contract: {
      scoring_mode: contract.scoring_mode || 'standard',
      copy_render_expectation: contract.copy_render_expectation || 'not_required',
      product_expectation: contract.product_expectation || 'not_required',
    },
    hard_requirements: {
      ...normalizedHardRequirements,
      all_passed: allRequiredPassed,
    },
    copy_polish: normalizedScores.copy_polish,
    meta_compliance: normalizedScores.meta_compliance,
    effectiveness: normalizedScores.effectiveness,
    visual_integrity_score: normalizedScores.visual_integrity_score,
    visual_contract_match: normalizedScores.visual_contract_match,
    overall_score: allRequiredPassed ? overallScore : 0,
    pass,
    compliance_flags: Array.isArray(rawScore?.compliance_flags) ? rawScore.compliance_flags.filter(Boolean) : [],
    spelling_errors: Array.isArray(rawScore?.spelling_errors) ? rawScore.spelling_errors.filter(Boolean) : [],
    strengths: Array.isArray(rawScore?.strengths) ? rawScore.strengths.filter(Boolean) : [],
    weaknesses: Array.isArray(rawScore?.weaknesses) ? rawScore.weaknesses.filter(Boolean) : [],
    image_issues: Array.isArray(rawScore?.image_issues) ? rawScore.image_issues.filter(Boolean) : [],
    angle_category: rawScore?.angle_category || null,
    // Compatibility aliases for downstream grouping / reporting.
    copy_strength: normalizedScores.copy_polish,
    compliance: normalizedScores.meta_compliance,
    image_quality: imageQuality,
  };
}

async function prepareScoringImageBuffer(imgBuffer) {
  const MAX_ANTHROPIC_IMAGE_BYTES = 5 * 1024 * 1024;
  if (!imgBuffer || imgBuffer.length <= MAX_ANTHROPIC_IMAGE_BYTES) {
    return imgBuffer;
  }

  try {
    let working = sharp(imgBuffer, { failOn: 'none' }).rotate();
    const metadata = await working.metadata();
    const resizeWidth = Math.max(768, Math.min(1536, metadata.width || 1536));
    const resized = working
      .resize({ width: resizeWidth, withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();
    if ((await resized).length <= MAX_ANTHROPIC_IMAGE_BYTES) {
      return await resized;
    }

    const smaller = await sharp(await resized, { failOn: 'none' })
      .resize({ width: Math.max(640, Math.floor(resizeWidth * 0.8)), withoutEnlargement: true })
      .jpeg({ quality: 72, mozjpeg: true })
      .toBuffer();
    return smaller;
  } catch (err) {
    console.warn('[FilterService] Could not compress scoring image:', err.message);
    return imgBuffer;
  }
}

// ── Score a single ad ──────────────────────────────────────────────────────

/**
 * Score a single ad creative using Claude Sonnet vision.
 * Port of dacia-creative-filter/agents/score.sh
 *
 * @param {object} ad - Ad creative row from convexClient
 * @param {string} topPerformers - Text summary of top-performing ads for context
 * @param {object|null} angleBrief - Structured angle brief (parsed JSON) or null
 * @param {string} projectId - For cost tracking
 * @returns {object} Parsed score JSON: { ad_id, hard_requirements, overall_score, pass, ... }
 */
export async function scoreAd(ad, topPerformers, angleBrief, projectId) {
  const headline = ad.headline || '';
  const primaryText = ad.body_copy || '';
  const angle = ad.angle || '';
  const adId = ad.id || 'unknown';
  const scoringContract = buildAdScoringContract(ad);

  // Build angle context from structured brief
  let angleContext = `Angle: ${angle}`;
  if (angleBrief) {
    if (angleBrief.frame) angleContext += `\nFrame: ${angleBrief.frame}`;
    if (angleBrief.core_buyer) angleContext += `\nCore Buyer: ${angleBrief.core_buyer}`;
    if (angleBrief.scene) angleContext += `\nScene: ${angleBrief.scene}`;
    if (angleBrief.tone) angleContext += `\nTone: ${angleBrief.tone}`;
    if (angleBrief.desired_belief_shift) angleContext += `\nDesired Belief Shift: ${angleBrief.desired_belief_shift}`;
  }

  // Download image if available
  let imageBase64 = null;
  let imageMime = 'image/png';
  if (ad.storageId) {
    try {
      const rawBuffer = await downloadToBuffer(ad.storageId);
      const imgBuffer = await prepareScoringImageBuffer(rawBuffer);
      imageBase64 = imgBuffer.toString('base64');
      // Detect MIME from buffer header
      if (imgBuffer[0] === 0xFF && imgBuffer[1] === 0xD8) imageMime = 'image/jpeg';
      else if (imgBuffer[0] === 0x89 && imgBuffer[1] === 0x50) imageMime = 'image/png';
      else if (imgBuffer[0] === 0x52 && imgBuffer[1] === 0x49) imageMime = 'image/webp';
    } catch (err) {
      console.warn(`[FilterService] Could not load image for ad ${adId.slice(0, 8)}: ${err.message}`);
    }
  }

  const hasImage = !!imageBase64;

  const prompt = `You are a senior direct response creative director evaluating Meta (Facebook/Instagram) ad creatives.

Score this ad against the contract below. Be strict about real defects, but do NOT penalize the ad for valid template-ad traits.

AD CREATIVE:
Headline: ${headline}
Primary Text: ${primaryText}
${angleContext}

SCORING CONTRACT:
- scoring_mode: ${scoringContract.scoring_mode}
- copy_render_expectation: ${scoringContract.copy_render_expectation}
- product_expectation: ${scoringContract.product_expectation}

CONTRACT INTERPRETATION:
- In template_copy_on_creative mode, visible rendered copy on the ad is expected and valid.
- In template_copy_on_creative mode, product visibility is useful feedback, but not an automatic fail unless product_expectation is "required".
- In template_copy_on_creative mode, template layout, text hierarchy, badges, and structured ad composition are valid if they are clean and intentional.
- Do NOT fail an ad just because it is not documentary-style.
- Do NOT fail an ad just because the product is visible.
- Do NOT fail an ad just because text is rendered on the creative.
- Only hard-fail for real defects: broken spelling/grammar, broken render, irrational/unrealistic/uncanny image, unreadable rendered text when text is expected, or the wrong product only when product_expectation is "required".
- Missing, ambiguous, or not-prominent-enough product should be recorded in weaknesses/image_issues and reflected in the soft scores, but it should NOT set all_passed false unless product_expectation is "required".
- Upstream generation has already filtered headline/body quality. This scoring pass is NOT a script-faithfulness review.
- Do NOT materially downscore a valid ad just because you would prefer a more literal match to the angle brief, a different opening line, or a stricter copy sequence.
- If the copy is coherent, grammatical, product-relevant, and not contradictory, score it as at least mid-level competent even if it is not the exact phrasing you would have chosen.

TOP PERFORMING ADS FROM THIS BRAND (for reference — what's already working):
${topPerformers}

=== HARD REQUIREMENTS (auto-fail if ANY are violated) ===

These are non-negotiable. Evaluate them objectively:

1. SPELLING & GRAMMAR
- Fail only for actual typos or genuinely broken grammar.
- Do not fail for conversational direct-response style, sentence fragments, emphasis, or numbers written plainly.

2. PRODUCT PRESENT
- If product_expectation is "required", the intended product must be clearly present on the creative.
- If product_expectation is not "required", score this as diagnostic feedback only. Missing or subtle product should not auto-fail the ad.

3. CORRECT PRODUCT
- If the product is shown, it must be the correct product for this brand/ad.
- If product_expectation is "required", fail for the wrong product or clearly unrelated product imagery.
- If product_expectation is not "required", record ambiguity or low prominence as feedback, but do not auto-fail unless the image is incoherent or misleading.

4. VISUAL INTEGRITY
- Fail for broken render, blank placeholder, missing visual element, irrational/unrealistic anatomy or objects, impossible perspective, obvious AI artifacting, or clearly broken composition.

5. RENDERED TEXT INTEGRITY
- If copy_render_expectation is "rendered", the on-creative text must be readable and not visibly mangled.
- Do NOT fail just because text is present. Only fail if the rendered text is broken or unreadable.

=== SCORING DIMENSIONS (1-10) ===

1. COPY POLISH (10%)
- Judge this on clarity, grammar, coherence, and basic direct-response competence.
- Do NOT use this to punish the ad for not matching an exact narrative sequence from the brief.

2. META COMPLIANCE (20%)
- Does this avoid obvious Meta policy risk?
- Penalize guarantee claims, before/after implications, exploitative clickbait, or sensitive-attribute callouts.

3. EFFECTIVENESS (10%)
- Would this likely earn a click from the target buyer?
- Judge this on clarity, specificity, and buyer relevance.
- Do NOT downscore simply because you would have preferred a different hook order or a more literal recreation of the angle brief.

4. VISUAL INTEGRITY SCORE (35%)
- How polished, realistic, and technically sound is the image?
- Penalize broken, irrational, or low-quality visuals heavily.

5. VISUAL CONTRACT MATCH (25%)
- Does the ad successfully execute the intended format?
- In template_copy_on_creative mode, reward clean template hierarchy and readable rendered copy. Product clarity can improve this score, but product absence alone is not a hard fail unless product_expectation is "required".

Return ONLY valid JSON in this exact shape:
{
  "ad_id": "${adId}",
  "hard_requirements": {
    "spelling_grammar": <true/false>,
    "product_present": <true/false/null>,
    "correct_product": <true/false/null>,
    "visual_integrity": <true/false>,
    "rendered_text_integrity": <true/false/null>,
    "all_passed": <true/false>
  },
  "copy_polish": <1-10>,
  "meta_compliance": <1-10>,
  "effectiveness": <1-10>,
  "visual_integrity_score": <1-10>,
  "visual_contract_match": <1-10>,
  "compliance_flags": ["list any specific issues"],
  "spelling_errors": ["list any misspellings or grammar issues found"],
  "strengths": ["top 2 strengths"],
  "weaknesses": ["top 2 weaknesses"],
  "image_issues": ["list any concrete visual defects, or []"],
  "angle_category": "brief label for the angle/theme (e.g. 'fear of chemicals', 'social proof', 'convenience')"
}`;

  let responseText;
  if (hasImage) {
    responseText = await chatWithImage(
      [], prompt, imageBase64, imageMime,
      SCORE_MODEL,
      { max_tokens: 1024, temperature: 0, operation: 'filter_score_ad', projectId }
    );
  } else {
    responseText = await chat(
      [{ role: 'user', content: prompt }],
      SCORE_MODEL,
      { max_tokens: 1024, temperature: 0, operation: 'filter_score_ad', projectId }
    );
  }

  const parsed = extractJSON(responseText);
  if (!parsed) {
    console.warn(`[FilterService] Failed to parse score for ad ${adId.slice(0, 8)}`);
    return { ad_id: adId, overall_score: 0, pass: false, error: 'parse_failed' };
  }
  return normalizeDirectorScore(parsed, scoringContract, { hasImage });
}

// ── Group passing ads into flex ads ────────────────────────────────────────

/**
 * Group scored ads into flex ad clusters.
 * Port of dacia-creative-filter/agents/group.sh
 *
 * @param {Array} scoredAds - Array of { ad, score } objects (passing only)
 * @param {string} projectName - Brand name
 * @param {number} [flexAdCount=1] - Number of flex ads to create
 * @returns {object} { flex_ads: [...], rejected_from_grouping, skipped_clusters }
 */
export async function groupAds(scoredAds, projectName, flexAdCount = 1, imageTarget = IMAGES_PER_FLEX) {
  const targetImages = normalizeAdSetImageTarget(imageTarget);
  const projectId = scoredAds[0]?.ad?.project_id;
  // Build scored ads payload for the grouping model.
  const adsPayload = scoredAds.map(({ ad, score }) => ({
    ad_id: ad.id,
    headline: ad.headline,
    primary_text: ad.body_copy,
    angle: ad.angle,
    overall_score: score.overall_score,
    copy_strength: score.copy_strength,
    compliance: score.compliance,
    effectiveness: score.effectiveness,
    image_quality: score.image_quality,
    angle_category: score.angle_category,
    strengths: score.strengths,
  }));

  const prompt = `You are a media buyer assembling ad sets for Meta advertising.

You have a set of scored ad creatives that all passed quality filtering. You need to:

1. GROUP them by angle/theme into distinct clusters
2. SELECT the ${flexAdCount} strongest clusters (most coherent angle + highest avg scores)
3. PICK the best ${targetImages} ads from each cluster
4. SELECT 3-5 HEADLINES for each cluster (Meta will test combinations)
5. SELECT 3-5 PRIMARY TEXTS for each cluster (Meta will test combinations)

BRAND: ${projectName}

=== AD SET STRUCTURE ===

Each ad set contains:
- ${targetImages} image ads
- 3-5 headlines (Meta rotates and tests which performs best)
- 3-5 primary texts (Meta rotates and tests which performs best)

Target 5 of each, but minimum 3 are required. If you cannot find at least 3 quality headlines or 3 quality primary texts for a cluster, DO NOT create that ad set — skip it.

=== CRITICAL COPY QUALITY RULES ===

EVERY headline and primary text you select MUST meet ALL of these. Do not include ANY that violate even one rule:

1. SPELLING AND GRAMMAR: Every word must be spelled correctly. Grammar must be clean and professional. One error = do not include it.

2. FIRST LINE HOOK (primary texts only): Every primary text MUST have a strong, compelling first line — a pattern interrupt, curiosity gap, bold claim, or emotional opener. This is what people see before clicking 'see more'. Weak first line = do not include it.

3. CTA AT END (primary texts only): Every primary text MUST end with a clear call to action. No CTA = do not include it.

4. THEMATIC ALIGNMENT: Every headline and every primary text must fit the cluster's angle. They do not all need to come from the same ad, but they must all speak to the same core theme/pain point/desire.

5. BROAD ENOUGH FOR ALL IMAGES: Each headline and primary text needs to make sense with any image in the group. Avoid copy that references something too specific to one image.

6. VARIETY: The 3-5 headlines should take different approaches to the same angle (different hooks, different framings). Same for primary texts. Do not pick 5 headlines that say basically the same thing.

SCORED ADS (all passing):
${JSON.stringify(adsPayload, null, 2)}

RULES:
- Each ad set must have exactly ${targetImages} image ads
- Each ad set gets 3-5 headlines AND 3-5 primary texts (target 5, minimum 3)
- If a cluster cannot produce at least 3 quality headlines AND 3 quality primary texts, skip it and try the next best cluster
- The ${flexAdCount} ad sets should target DIFFERENT angles for audience variety
- Prefer ads with higher overall_score within each cluster
- If two ads in the same cluster are nearly identical, prefer the one with higher copy_strength
- Do not include any copy from compliance-flagged ads

Respond ONLY with this exact JSON format:
{
  "flex_ads": [
    {
      "flex_ad_number": 1,
      "angle_theme": "descriptive label for this ad set's angle",
      "headlines": [
        {
          "text": "headline text",
          "source_ad_id": "ad_id it came from",
          "spelling_clean": true
        }
      ],
      "primary_texts": [
        {
          "text": "full primary text",
          "source_ad_id": "ad_id it came from",
          "first_line_hook_strong": true,
          "has_cta_at_end": true,
          "spelling_clean": true
        }
      ],
      "headline_count": <3-5>,
      "primary_text_count": <3-5>,
      "meets_minimum": true,
      "image_ad_ids": ["ad_id_1", "ad_id_2", "... ${targetImages} total"],
      "avg_score": <average overall_score of selected ads>,
      "reasoning": "1 sentence on why this grouping works"
    }
  ],
  "rejected_from_grouping": ["ad_ids that passed scoring but didn't fit a flex group"],
  "skipped_clusters": ["any angle clusters that were skipped because they couldn't meet the minimum 3 headlines + 3 primary texts requirement"]
}`;

  const parseGrouping = (responseText, model) => {
    const parsed = extractJSON(responseText);
    if (!parsed || !Array.isArray(parsed.flex_ads)) {
      return null;
    }
    return { ...parsed, grouping_model: model };
  };

  try {
    const responseText = await openAIChat(
      [{ role: 'user', content: prompt }],
      GROUP_MODEL,
      {
        max_tokens: 8192,
        temperature: 0,
        response_format: { type: 'json_object' },
        operation: 'filter_group_ads',
        projectId,
      }
    );
    const parsed = parseGrouping(responseText, GROUP_MODEL);
    if (parsed) return parsed;
    console.warn(`[FilterService] ${GROUP_MODEL} returned invalid grouping JSON; falling back to ${GROUP_FALLBACK_MODEL}`);
  } catch (err) {
    console.warn(`[FilterService] ${GROUP_MODEL} grouping failed; falling back to ${GROUP_FALLBACK_MODEL}: ${err.message}`);
  }

  const responseText = await chat(
    [{ role: 'user', content: prompt }],
    GROUP_FALLBACK_MODEL,
    { max_tokens: 8192, temperature: 0, operation: 'filter_group_ads_fallback', projectId }
  );

  const parsed = parseGrouping(responseText, GROUP_FALLBACK_MODEL);
  if (!parsed) {
    console.warn('[FilterService] Failed to parse grouping result');
    return { flex_ads: [], error: 'parse_failed' };
  }
  return parsed;
}

// ── Generate fresh copy for flex ads ───────────────────────────────────────

/**
 * Generate fresh headlines + primary texts for a flex ad.
 * Same logic as POST /deployments/filter/generate-copy (deployments.js:1329-1494)
 *
 * @param {string} projectId
 * @param {string} angleTheme - Angle description for the flex ad
 * @param {Array} adCreatives - Ad creative context for the copy prompt
 * @returns {{ primary_texts: string[], headlines: string[] }}
 */
export async function generateFilterCopy(projectId, angleTheme, adCreatives) {
  const project = await getProject(projectId);
  if (!project) throw new Error('Project not found');

  const [avatar, offer_brief, research, beliefs] = await Promise.all([
    getLatestDoc(projectId, 'avatar'),
    getLatestDoc(projectId, 'offer_brief'),
    getLatestDoc(projectId, 'research'),
    getLatestDoc(projectId, 'necessary_beliefs'),
  ]);

  const avatarSnippet = (avatar?.content || '').slice(0, 2000);
  const offerSnippet = (offer_brief?.content || '').slice(0, 1500);
  const researchSnippet = (research?.content || '').slice(0, 1500);
  const beliefsSnippet = (beliefs?.content || '').slice(0, 1000);

  let creativeContext = '';
  if (adCreatives && adCreatives.length > 0) {
    creativeContext = adCreatives.map((ad, i) => `
IMAGE ${i + 1}:
Angle: ${ad.angle || 'N/A'}
Headline: ${ad.headline || 'N/A'}
Body Copy: ${ad.body_copy || 'N/A'}`).join('\n');
  }

  // Step 1: Generate Primary Texts
  const primaryTextSystemPrompt = `You are a world-class direct response copywriter writing Facebook ad primary text (the text that appears ABOVE the ad image).

BRAND: ${project.brand_name || project.name}
PRODUCT: ${project.product_description || ''}

AVATAR (excerpt):
${avatarSnippet}

OFFER BRIEF (excerpt):
${offerSnippet}

${researchSnippet ? `RESEARCH (excerpt):\n${researchSnippet}\n` : ''}
${beliefsSnippet ? `NECESSARY BELIEFS (excerpt):\n${beliefsSnippet}\n` : ''}

AD CREATIVE INFO:
${creativeContext}

ANGLE/THEME FOR THIS AD SET: ${angleTheme}

Your task is to write 5 variations of Facebook ad primary text. Each MUST follow this structure:

FIRST LINE (HOOK): The very first line must be an attention-grabbing hook that stops the scroll. Use a bold claim, surprising fact, provocative question, or pattern interrupt. This line is the most important — if it doesn't grab attention, nothing else matters.

MIDDLE: 2-4 sentences that speak directly to the target audience's pain points and desires. Build curiosity and emotional connection. Sound conversational and natural, not like marketing copy.

LAST LINE (CTA): The final line must be a clear call to action that drives the click. Examples: "Tap the button to learn more.", "Click to see how it works.", "See what's possible →", "Find out how — tap the button." NEVER say "link below" or "tap the link" — always reference a button. Make it feel like the natural next step, not pushy.

Additional rules:
- Work well with multiple creative images that rotate
- All 5 variations should speak to the angle/theme: ${angleTheme}
- IMPORTANT: Split each variation into short, readable paragraphs. Each distinct thought or idea should be its own paragraph (separated by \\n\\n). Do NOT write dense blocks of text — break it up so it's easy to scan on mobile.

ALWAYS return ONLY a JSON object: { "primary_texts": ["text1", "text2", "text3", "text4", "text5"] }
Remember to use \\n\\n between paragraphs within each text variation.`;

  const ptResult = await chat(
    [
      { role: 'system', content: primaryTextSystemPrompt },
      { role: 'user', content: 'Write 5 variations of Facebook ad primary text based on the brand context and ad creative info provided. Focus on the angle/theme specified.' },
    ],
    'claude-sonnet-4-6',
    { max_tokens: 2048, operation: 'filter_primary_text_generation', projectId }
  );

  let primaryTexts = [];
  try {
    const parsed = JSON.parse(ptResult);
    primaryTexts = parsed.primary_texts || [];
  } catch {
    const match = ptResult.match(/\{[\s\S]*"primary_texts"[\s\S]*\}/);
    if (match) {
      try { primaryTexts = JSON.parse(match[0]).primary_texts || []; } catch {}
    }
    if (primaryTexts.length === 0) primaryTexts = [ptResult.trim()];
  }

  // Step 2: Generate Headlines
  const headlineAvatarSnippet = (avatar?.content || '').slice(0, 1500);
  const headlineOfferSnippet = (offer_brief?.content || '').slice(0, 1000);
  const primaryTextList = primaryTexts.map((pt, i) => `${i + 1}. ${pt}`).join('\n');

  const headlineSystemPrompt = `You are a world-class direct response copywriter writing Facebook ad headlines (the short text that appears BELOW the ad image in the link preview area).

BRAND: ${project.brand_name || project.name}

AVATAR (excerpt):
${headlineAvatarSnippet}

OFFER BRIEF (excerpt):
${headlineOfferSnippet}

PRIMARY TEXT VARIATIONS (what appears above the image):
${primaryTextList}

ANGLE/THEME FOR THIS AD SET: ${angleTheme}

Your task is to write ${HEADLINE_POOL_TARGET} punchy headlines that:
- Are under 10 words each
- Align with and complement the primary text above
- Drive curiosity and clicks
- Sound natural, not salesy
- Each has a different angle or emphasis
- No two headlines should reuse the same central claim with slightly different wording
- No two headlines should open with the same phrase or sentence structure
- All speak to the angle/theme: ${angleTheme}

ALWAYS return ONLY a JSON object: { "headlines": ["h1", "h2", "..."] }`;

  const hlResult = await chat(
    [
      { role: 'system', content: headlineSystemPrompt },
      { role: 'user', content: `Write ${HEADLINE_POOL_TARGET} punchy Facebook ad headlines based on the brand context and primary text provided. Return ONLY a JSON object: { "headlines": ["h1", "h2", "..."] }` },
    ],
    'claude-sonnet-4-6',
    { max_tokens: 1024, operation: 'filter_headline_generation', projectId }
  );

  let headlines = [];
  try {
    const parsed = JSON.parse(hlResult);
    headlines = parsed.headlines || [];
  } catch {
    const match = hlResult.match(/\{[\s\S]*"headlines"[\s\S]*\}/);
    if (match) {
      try { headlines = JSON.parse(match[0]).headlines || []; } catch {}
    }
    if (headlines.length === 0) headlines = [hlResult.trim()];
  }

  const dedupedHeadlines = selectDiverseHeadlines(
    filterHeadlineCandidatePool(
      headlines.map((headline, index) => ({
        headline,
        rank: index + 1,
        average_score: HEADLINE_POOL_TARGET - index,
      }))
    ).survivors,
    HEADLINES_TARGET
  ).selected.map((headline) => headline.headline);

  console.log(`[FilterService] Generated ${primaryTexts.length} primary texts + ${headlines.length} headlines (${dedupedHeadlines.length} kept) for ${project.name} (${angleTheme})`);
  return { primary_texts: primaryTexts, headlines: dedupedHeadlines.length > 0 ? dedupedHeadlines : headlines.slice(0, HEADLINES_TARGET) };
}

// ── Deploy flex ad to Ready to Post ────────────────────────────────────────

export async function resolveAutomationCampaign(projectConfig) {
  const configuredCampaignId = projectConfig?.scout_default_campaign || projectConfig?.default_campaign_id;
  if (configuredCampaignId) return configuredCampaignId;

  const campaignId = await ensureDefaultCampaign(projectConfig);
  if (campaignId) return campaignId;

  throw new Error('Could not resolve an automation campaign for this project. Choose or create a campaign in Ad Automation settings.');
}

/**
 * Create ad set + flex ad + deployments, deploying to Ready to Post.
 *
 * @param {object} flexAdDef - Flex ad definition from groupAds()
 * @param {string} projectId
 * @param {object} projectConfig - Project row with scout_* fields
 * @param {string} batchId
 * @param {string} postingDay
 * @param {string} angleName
 * @param {{ primary_texts: string[], headlines: string[] }} generatedCopy - Fresh copy from generateFilterCopy
 * @returns {{ flexAdId: string, deploymentCount: number }}
 */
export async function deployFlexAd(flexAdDef, projectId, projectConfig, batchId, postingDay, angleName, generatedCopy) {
  const campaignId = await resolveAutomationCampaign(projectConfig);

  const effectiveAngle = angleName || flexAdDef.angle_theme || 'Unassigned';
  const cta = projectConfig.scout_cta || '';
  const displayLink = projectConfig.scout_display_link || '';
  const facebookPage = projectConfig.scout_facebook_page || '';
  const duplicateAdsetName = projectConfig.scout_duplicate_adset_name || '';

  // Build default destination URLs from project config
  let resolvedUrls = [];
  if (projectConfig.scout_destination_urls) {
    try { resolvedUrls = JSON.parse(projectConfig.scout_destination_urls); } catch {}
  }
  if (!resolvedUrls.length && projectConfig.scout_destination_url) {
    resolvedUrls = [projectConfig.scout_destination_url];
  }
  let destinationUrl = resolvedUrls[0] || '';

  // Per-angle URLs override project defaults entirely
  try {
    const angles = await getActiveConductorAngles(projectId);
    const matchedAngle = angles.find(a => a.name === effectiveAngle);
    if (matchedAngle?.destination_urls) {
      const parsed = JSON.parse(matchedAngle.destination_urls);
      if (Array.isArray(parsed) && parsed.length > 0) {
        resolvedUrls = parsed;
        destinationUrl = parsed[0];
      }
    }
  } catch (e) { /* fall through to defaults */ }

  // Phase 6 — number this ad_set within the angle's existing ad_sets
  // (replaces the flex_ad numbering scheme). Counts only ad_sets in
  // the new lifecycle namespace; legacy 'staging'/'promoted' don't count.
  const existingAdSets = await getAdSetsByProject(projectId);
  const matchingCount = existingAdSets.filter((s) => {
    return /^Director — /.test(s.name || '') && (s.angle_id ? false : (s.name || '').includes(effectiveAngle));
  }).length;
  const setNum = matchingCount + 1;

  // Auto-name with ISO datetime to prevent same-day collisions across runs.
  const isoTs = new Date().toISOString();
  const adSetName = `Director — ${effectiveAngle} #${setNum} — ${isoTs}`;

  // Use generated copy, falling back to grouped copy
  const headlines = generatedCopy.headlines.length >= HEADLINES_MIN
    ? generatedCopy.headlines.slice(0, HEADLINES_TARGET)
    : flexAdDef.headlines.map(h => h.text).slice(0, HEADLINES_TARGET);

  const primaryTexts = generatedCopy.primary_texts.length >= PRIMARY_TEXTS_MIN
    ? generatedCopy.primary_texts.slice(0, PRIMARY_TEXTS_TARGET)
    : flexAdDef.primary_texts.map(pt => pt.text).slice(0, PRIMARY_TEXTS_TARGET);

  // Create ad set in 'ready' lifecycle — Director's automatic delivery path
  // skips the Planner (draft) stage entirely.
  const adSetId = crypto.randomUUID();
  await createAdSet({
    id: adSetId,
    campaign_id: campaignId,
    project_id: projectId,
    name: adSetName,
    sort_order: 0,
    lifecycle_status: 'ready',
    ready_source: 'creative_director',
    ready_at: isoTs,
  });

  // Create individual deployments for each ad. Copy (primary_texts, headlines,
  // destination_url, CTA) lives on the deployment itself — flex_ads are no
  // longer needed as a copy wrapper.
  const deploymentIds = [];
  const ptJson = JSON.stringify(primaryTexts);
  const hlJson = JSON.stringify(headlines);

  for (const adId of flexAdDef.image_ad_ids) {
    const depId = crypto.randomUUID();
    let ad;
    try { ad = await getAd(adId); } catch {}

    const shortCode = adId.slice(0, 4).toUpperCase();
    const adName = ad?.headline
      ? `${ad.headline} — ${shortCode}`
      : ad?.angle
        ? `${ad.angle} — ${shortCode}`
        : `Ad ${shortCode}`;

    await createDeploymentDuplicate({
      id: depId,
      ad_id: adId,
      project_id: projectId,
      status: 'ready_to_post',
      ad_name: adName,
      local_campaign_id: campaignId,
      local_adset_id: adSetId,
      primary_texts: ptJson,
      ad_headlines: hlJson,
      destination_url: destinationUrl,
      cta_button: cta,
    });

    const extraFields = {};
    if (displayLink) extraFields.display_link = displayLink;
    if (facebookPage) extraFields.facebook_page = facebookPage;
    if (duplicateAdsetName) extraFields.duplicate_adset_name = duplicateAdsetName;
    if (Object.keys(extraFields).length > 0) {
      await updateDeployment(depId, extraFields);
    }

    deploymentIds.push(depId);
  }

  console.log(`[FilterService] Phase6 — Deployed ad_set "${adSetName}" → Ready to Post (${headlines.length} headlines × ${primaryTexts.length} texts × ${deploymentIds.length} images)`);

  // Phase 9 — Auto-post to Meta if enabled
  try {
    const gateResult = await evaluateAutoPostGate(projectId, adSetId);
    if (gateResult.allowed) {
      const startMs = Date.now();
      try {
        const postResult = await postAdSetToMeta(adSetId, projectId, { adStatus: 'ACTIVE' });
        await createAutoPostLog({
          externalId: crypto.randomUUID(),
          project_id: projectId,
          ad_set_id: adSetId,
          meta_adset_id: postResult.meta_adset_id,
          status: 'success',
          duration_ms: Date.now() - startMs,
          created_at: new Date().toISOString(),
        });
        const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
        const config = await getConductorConfig(projectId);
        const todayCount = (config?.auto_post_today_date === today) ? (config?.auto_post_today_count ?? 0) : 0;
        await upsertConductorConfig(projectId, {
          auto_post_today_count: todayCount + 1,
          auto_post_today_date: today,
          auto_post_last_posted_at: Date.now(),
          auto_post_consecutive_errors: 0,
        });
        console.log(`[FilterService] Auto-posted ad_set "${adSetName}" to Meta (${postResult.path_used})`);
      } catch (postErr) {
        await createAutoPostLog({
          externalId: crypto.randomUUID(),
          project_id: projectId,
          ad_set_id: adSetId,
          status: 'failed',
          error_message: postErr.message,
          duration_ms: Date.now() - startMs,
          created_at: new Date().toISOString(),
        });
        const config = await getConductorConfig(projectId);
        const errors = (config?.auto_post_consecutive_errors ?? 0) + 1;
        const threshold = config?.auto_post_error_threshold ?? 3;
        const updates = { auto_post_consecutive_errors: errors };
        if (config?.auto_post_pause_on_error !== false && errors >= threshold) {
          updates.auto_post_enabled = false;
          updates.auto_post_paused_reason = `Auto-paused after ${errors} consecutive errors: ${postErr.message}`;
        }
        await upsertConductorConfig(projectId, updates);
        console.warn(`[FilterService] Auto-post failed for "${adSetName}": ${postErr.message}`);
      }
    } else {
      await createAutoPostLog({
        externalId: crypto.randomUUID(),
        project_id: projectId,
        ad_set_id: adSetId,
        status: 'skipped_gate',
        gate_reason: gateResult.reason,
        created_at: new Date().toISOString(),
      });
    }
  } catch (autoPostErr) {
    console.warn(`[FilterService] Auto-post gate check failed: ${autoPostErr.message}`);
  }

  return { adSetId, deploymentCount: deploymentIds.length };
}

async function markBatchFilterProcessed(batchId) {
  await updateBatchJob(batchId, {
    filter_processed: true,
    filter_processed_at: new Date().toISOString(),
  });
}

// ── Inline filter helpers ──────────────────────────────────────────────────

export async function scoreBatchForInlineFilter(batchId, projectId, onProgress, { roundNumber = 1, totalRounds = 1, shouldCancel = null, requiredPasses = null, priorPassed = 0 } = {}) {
  const emit = (event) => { if (onProgress) try { onProgress(event); } catch {} };
  const throwIfCancelled = async () => {
    if (!shouldCancel) return;
    const cancelled = await shouldCancel();
    if (cancelled) {
      throw new Error('Cancelled by user');
    }
  };

  const batch = await getBatchJob(batchId);
  if (!batch) throw new Error('Batch not found for filtering');

  const project = await getProject(projectId);
  if (!project) throw new Error('Project not found');

  const ads = await getAdsByBatchId(batchId);
  if (ads.length === 0) throw new Error('No ads found in batch');

  let angleBrief = null;
  if (batch.angle_brief) {
    try { angleBrief = JSON.parse(batch.angle_brief); } catch {}
  }

  const roundLabel = totalRounds > 1 ? `Round ${roundNumber}/${totalRounds}` : 'Batch';
  const targetText = requiredPasses ? ` Target: ${requiredPasses} approved ads.` : '';
  const topPerformers = 'No previous top performers available.';

  emit({
    type: 'progress',
    step: 'filter_scoring',
    message: `${roundLabel}: Creative Filter QA is checking ${ads.length} ads.${targetText}`,
    scoringProgress: { current: 0, total: ads.length },
    approvedCount: priorPassed,
    targetCount: requiredPasses || undefined,
  });

  const scoredAds = [];
  let passCount = 0;

  for (let i = 0; i < ads.length; i++) {
    await throwIfCancelled();
    const ad = ads[i];
    emit({
      type: 'progress',
      step: 'filter_scoring',
      message: `${roundLabel}: Creative Filter QA is checking ad ${i + 1} of ${ads.length}...`,
      scoringProgress: { current: i + 1, total: ads.length },
      approvedCount: priorPassed + passCount,
      targetCount: requiredPasses || undefined,
    });

    try {
      const score = await scoreAd(ad, topPerformers, angleBrief, projectId);
      scoredAds.push({ ad, score });
      if (score.pass) passCount++;
      console.log(`[FilterService] Round ${roundNumber} ad ${ad.id.slice(0, 8)}: score=${score.overall_score}, pass=${score.pass}`);
      await throwIfCancelled();
      // Phase 1 — Staging Page lifecycle: write the verdict to the ad_creative.
      // Flips status to "staging" (passed) or "quality_rejected" (rejected),
      // making the ad eligible for the Staging Page Pending or Rejected views.
      // Score normalized 0-10 → 0-1 to fit setFilterVerdict's contract.
      // filter_reasons combines weaknesses + image_issues for the Rejected card.
      try {
        const reasons = [
          ...(Array.isArray(score.weaknesses) ? score.weaknesses : []),
          ...(Array.isArray(score.image_issues) ? score.image_issues : []),
        ].filter(Boolean);
        await setFilterVerdict(ad.id, {
          score: Math.max(0, Math.min(1, (score.overall_score || 0) / 10)),
          verdict: score.pass ? 'passed' : 'rejected',
          reasons: reasons.length > 0 ? JSON.stringify(reasons) : undefined,
        });
      } catch (verdictErr) {
        console.warn(`[FilterService] setFilterVerdict failed for ad ${ad.id.slice(0, 8)}: ${verdictErr.message}`);
      }
    } catch (err) {
      if (err.message === 'Cancelled by user') {
        throw err;
      }
      console.error(`[FilterService] Failed to score ad ${ad.id.slice(0, 8)}: ${err.message}`);
      scoredAds.push({ ad, score: { ad_id: ad.id, overall_score: 0, pass: false, error: err.message } });
      // Score failed entirely → mark as rejected with the error as the reason
      // so the ad doesn't sit in limbo on the Staging Page.
      try {
        await setFilterVerdict(ad.id, {
          score: 0,
          verdict: 'rejected',
          reasons: JSON.stringify([`Scoring error: ${err.message}`]),
        });
      } catch {}
    }
  }

  const passingAds = scoredAds.filter(sa => sa.score.pass);
  console.log(`[FilterService] ${roundLabel} scoring complete: ${passCount}/${ads.length} passed (threshold: ${SCORE_THRESHOLD})`);

  await markBatchFilterProcessed(batchId);

  return {
    batch,
    project,
    scoredAds,
    passingAds,
    ads_scored: ads.length,
    ads_passed: passCount,
  };
}

export async function finalizePassingAds({ passingAds, projectId, batchId, postingDay = 'test', angleName = '', onProgress, targetCount = IMAGES_PER_FLEX }) {
  const emit = (event) => { if (onProgress) try { onProgress(event); } catch {} };
  const imageTarget = normalizeAdSetImageTarget(targetCount);

  if (passingAds.length < imageTarget) {
    return {
      ad_sets_created: 0,
      ad_set_id: null,
      flex_ads_created: 0,
      flex_ad_id: null,
      ready_to_post_count: 0,
      not_enough_passed: true,
    };
  }

  const project = await getProject(projectId);
  if (!project) throw new Error('Project not found');

  emit({
    type: 'progress',
    step: 'filter_grouping',
    message: `Building Ready-to-Post ad set from ${imageTarget} approved ads...`,
    approvedCount: Math.min(passingAds.length, imageTarget),
    targetCount: imageTarget,
  });

  const groupResult = await groupAds(passingAds, project.name, 1, imageTarget);
  const flexAds = groupResult.flex_ads || [];

  if (flexAds.length === 0) {
    console.warn(`[FilterService] Grouping returned 0 ad sets despite ${passingAds.length} passing ads`);
    emit({ type: 'progress', step: 'filter_complete', message: 'The approved ads could not be grouped into a Ready-to-Post ad set. Check copy quality.' });
    return {
      ad_sets_created: 0,
      ad_set_id: null,
      flex_ads_created: 0,
      flex_ad_id: null,
      ready_to_post_count: 0,
      grouping_failed: true,
    };
  }

  const flexAdDef = {
    ...flexAds[0],
    image_ad_ids: [...new Set(Array.isArray(flexAds[0].image_ad_ids) ? flexAds[0].image_ad_ids : [])].slice(0, imageTarget),
  };
  if (flexAdDef.image_ad_ids.length < imageTarget) {
    console.warn(`[FilterService] Grouping returned ${flexAdDef.image_ad_ids.length}/${imageTarget} image ads`);
    emit({ type: 'progress', step: 'filter_complete', message: `Could not find ${imageTarget} approved image ads for the Ready-to-Post ad set.` });
    return {
      ad_sets_created: 0,
      ad_set_id: null,
      flex_ads_created: 0,
      flex_ad_id: null,
      ready_to_post_count: 0,
      grouping_failed: true,
    };
  }
  emit({
    type: 'progress',
    step: 'filter_copy_gen',
    message: `Writing primary texts and headlines for "${flexAdDef.angle_theme}"...`,
    approvedCount: imageTarget,
    targetCount: imageTarget,
  });

  const adCreativesForCopy = flexAdDef.image_ad_ids.slice(0, Math.min(imageTarget, 5)).map(adId => {
    const found = passingAds.find(sa => sa.ad.id === adId);
    return found ? found.ad : { headline: '', body_copy: '', angle: '' };
  });

  const generatedCopy = await generateFilterCopy(projectId, flexAdDef.angle_theme, adCreativesForCopy);

  emit({
    type: 'progress',
    step: 'filter_deploying',
    message: 'Moving the ad set to Ready to Post...',
    approvedCount: imageTarget,
    targetCount: imageTarget,
  });

  try {
    const deployResult = await deployFlexAd(
      flexAdDef,
      projectId,
      project,
      batchId,
      postingDay,
      angleName,
      generatedCopy
    );

    emit({
      type: 'progress',
      step: 'filter_complete',
      message: `Ready-to-Post ad set created with ${deployResult.deploymentCount} approved ads.`,
      approvedCount: imageTarget,
      targetCount: imageTarget,
    });

    return {
      ad_sets_created: 1,
      ad_set_id: deployResult.adSetId,
      flex_ads_created: 1,                      // legacy alias for callers; equals ad_sets_created
      flex_ad_id: deployResult.adSetId,         // legacy alias for callers; equals ad_set_id
      ready_to_post_count: deployResult.deploymentCount,
      selected_ad_ids: flexAdDef.image_ad_ids.slice(),
    };
  } catch (err) {
    console.error(`[FilterService] Deployment failed: ${err.message}`);
    return {
      ad_sets_created: 0,
      ad_set_id: null,
      flex_ads_created: 0,
      flex_ad_id: null,
      ready_to_post_count: 0,
      deploy_error: err.message,
    };
  }
}

// ── Full inline filter orchestrator ────────────────────────────────────────

/**
 * Run the full Creative Filter pipeline inline with SSE progress events.
 *
 * @param {string} batchId
 * @param {string} projectId
 * @param {(event: object) => void} onProgress
 * @returns {{ ads_scored: number, ads_passed: number, flex_ads_created: number, flex_ad_id: string|null }}
 */
export async function runInlineFilter(batchId, projectId, onProgress) {
  const emit = (event) => { if (onProgress) try { onProgress(event); } catch {} };
  const scoreResult = await scoreBatchForInlineFilter(batchId, projectId, emit);
  if (scoreResult.ads_passed < IMAGES_PER_FLEX) {
    const msg = `Only ${scoreResult.ads_passed} of ${scoreResult.ads_scored} ads passed scoring (need ${IMAGES_PER_FLEX}). No ad set created.`;
    console.warn(`[FilterService] ${msg}`);
    emit({ type: 'progress', step: 'filter_complete', message: msg });
    return {
      ads_scored: scoreResult.ads_scored,
      ads_passed: scoreResult.ads_passed,
      ad_sets_created: 0,
      ad_set_id: null,
      flex_ads_created: 0,
      flex_ad_id: null,
      ready_to_post_count: 0,
      not_enough_passed: true,
    };
  }

  const finalizeResult = await finalizePassingAds({
    passingAds: scoreResult.passingAds,
    projectId,
    batchId,
    postingDay: scoreResult.batch.posting_day || 'test',
    angleName: scoreResult.batch.angle_name || '',
    onProgress: emit,
  });

  return {
    ads_scored: scoreResult.ads_scored,
    ads_passed: scoreResult.ads_passed,
    ...finalizeResult,
  };
}

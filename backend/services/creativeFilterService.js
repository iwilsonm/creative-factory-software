/**
 * Creative Filter Service — Node.js port of scoring + grouping from filter.sh
 *
 * Runs inline during Director test runs with SSE progress events.
 * Reuses existing anthropic.js wrappers for API calls + cost tracking.
 */

import crypto from 'crypto';
import { chat, chatWithImage, extractJSON } from './anthropic.js';
import {
  getProject, getLatestDoc, getBatchJob, updateBatchJob,
  getAdsByBatchId, getAd, downloadToBuffer,
  createAdSet, createFlexAd, createDeploymentDuplicate, updateDeployment,
  getFlexAdsByProject, getConductorConfig,
} from '../convexClient.js';

// Models — match filter.conf
const SCORE_MODEL = 'claude-sonnet-4-5-20250929';
const GROUP_MODEL = 'claude-sonnet-4-6';
const SCORE_THRESHOLD = 7;
const IMAGES_PER_FLEX = 10;
const HEADLINES_TARGET = 5;
const PRIMARY_TEXTS_TARGET = 5;
const HEADLINES_MIN = 3;
const PRIMARY_TEXTS_MIN = 3;

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
      const imgBuffer = await downloadToBuffer(ad.storageId);
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

  // Build prompt sections based on image availability
  const imageInstructions = hasImage
    ? '\nYou are also looking at the actual generated ad image. Evaluate the IMAGE for quality issues.'
    : '';

  const imageHardReq = hasImage
    ? `\n5. IMAGE COMPLETENESS: Look at the ad image carefully. If there is a clearly visible blank/empty space where a product image should be (a white rectangle, an empty product placeholder, a gap in the layout where something is obviously missing), auto-fail. This does NOT mean the product must be in every ad — lifestyle shots, text-only designs, and abstract visuals are fine. Only fail if there is an obvious HOLE or BLANK AREA that looks like a broken image or missing product render.`
    : '';

  const imageScoring = hasImage
    ? `\n5. IMAGE QUALITY (20% weight)
- Is the image visually complete? No blank spaces, missing renders, or broken layouts?
- Does the image look professional? No obvious AI artifacts, distorted faces, mangled text?
- Does the image support the ad's message? Does it match the angle and copy tone?
- Would this image stop the scroll on a Facebook/Instagram feed?
- Are there any wrong products shown (competitor products, unrelated items)?
NOTE: You do NOT need the product to appear in every ad. Lifestyle scenes, testimonial-style layouts, and text-heavy designs are all valid. Only dock points for genuinely broken or low-quality visuals.`
    : `\n5. VISUAL-COPY ALIGNMENT (10% weight — image not available for review)
- Does the copy tone match what you'd expect from an ad image?
- Is there a clear visual hook implied by the copy?`;

  const imageJsonFields = hasImage
    ? `\n  "image_quality": <1-10, or 0 if hard req failed>,\n  "image_issues": ["list any visual issues: blank spaces, artifacts, wrong products, etc."],`
    : `\n  "image_quality": null,\n  "image_issues": [],`;

  const prompt = `You are a senior direct response creative director evaluating ad creatives for Meta (Facebook/Instagram) advertising. You specialize in health, wellness, and e-commerce brands.${imageInstructions}

Score this ad creative. Be critical but fair — only genuinely strong ads should score 7+.

AD CREATIVE:
Headline: ${headline}
Primary Text: ${primaryText}
${angleContext}

TOP PERFORMING ADS FROM THIS BRAND (for reference — what's already working):
${topPerformers}

=== HARD REQUIREMENTS (auto-fail if ANY are violated) ===

These are non-negotiable. If ANY of these fail, the ad MUST score 0 and pass=false:

1. SPELLING & GRAMMAR: Actual misspelled words or broken grammar. This means REAL typos (e.g. "teh" instead of "the", "recieve" instead of "receive") and genuinely ungrammatical sentences. IMPORTANT: The following are NOT spelling or grammar errors — do NOT flag these:
   - Numbers without dollar signs or commas (e.g. "4300" or "149" are fine in ad copy — this is a common style choice)
   - Informal/conversational tone (sentence fragments, starting with "And" or "But", casual phrasing — this is direct response style)
   - Intentional stylistic choices like em dashes, ellipses, ALL CAPS for emphasis
   - Missing Oxford commas (style preference, not an error)
   Only flag ACTUAL misspellings and genuinely broken grammar that would make the ad look unprofessional.

2. FIRST LINE HOOK: The very first line of the primary text MUST be a strong hook — a pattern interrupt, curiosity gap, bold claim, or emotional opener that stops the scroll. If the first line is weak, generic, or forgettable, auto-fail.

3. CTA AT END: The primary text MUST end with a clear call to action. The reader should know exactly what to do next (click, shop, learn more, etc.). If there's no CTA or it's buried in the middle, auto-fail.

4. HEADLINE-AD ALIGNMENT: The headline must directly relate to and reinforce the primary text and the ad's angle. If the headline feels disconnected from the primary text or could belong to a completely different ad, auto-fail.
${imageHardReq}
=== SCORING CRITERIA (only score if hard requirements pass) ===

1. COPY STRENGTH (35% weight)
- Is the headline a pattern interrupt? Would it stop the scroll?
- Does it create genuine curiosity or emotional tension?
- Is the first-line hook genuinely compelling (not just present)?
- Is the CTA motivated and urgent (not just present)?
- Does the primary text build a coherent argument from hook to CTA?
- Does it use specific, concrete language (not vague/generic)?
- Does the headline work WITH the primary text as a unified message?

2. META COMPLIANCE (25% weight)
- Any income or earnings claims (explicit or implied)?
- Any before/after implications?
- Any health claims that GUARANTEE specific outcomes (e.g. "this will cure your..." or "eliminates pain 100%")?
- IMPORTANT: General wellness claims are acceptable on Meta. Phrases like "reduce inflammation", "support recovery", "improve sleep quality", "natural pain relief" are compliant and commonly approved. Only flag claims that guarantee specific medical outcomes or diagnose/treat/cure diseases.
- Any "this one trick" / "doctors hate this" style clickbait?
- Any use of "you" in ways that call out personal attributes (e.g. "Are you overweight?", "Is your credit score low?")?
- Would this realistically survive Meta's ad review? (Meta approves most health/wellness product ads that don't make guarantee claims)

3. OVERALL EFFECTIVENESS (20% weight)
- Would this actually convert? Is there a reason to click?
- Does it speak to a real pain point or desire?
- Is the value proposition clear?
- Does the hook → body → CTA flow create momentum?
- How does it compare to the top performers?
${imageScoring}
Respond ONLY with this exact JSON format, nothing else:
{
  "ad_id": "${adId}",
  "hard_requirements": {
    "spelling_grammar": <true/false>,
    "first_line_hook": <true/false>,
    "cta_at_end": <true/false>,
    "headline_alignment": <true/false>,
    "image_completeness": <true/false or null if no image>,
    "all_passed": <true only if ALL requirements (including image if present) are true>
  },
  "copy_strength": <1-10, or 0 if hard req failed>,
  "compliance": <1-10, or 0 if hard req failed>,
  "effectiveness": <1-10, or 0 if hard req failed>,${imageJsonFields}
  "overall_score": <1-10 weighted average, or 0 if hard req failed>,
  "pass": <true ONLY if all hard requirements passed AND overall_score >= ${SCORE_THRESHOLD}>,
  "compliance_flags": ["list any specific issues"],
  "spelling_errors": ["list any misspellings or grammar issues found"],
  "strengths": ["top 2 strengths"],
  "weaknesses": ["top 2 weaknesses"],
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
  return parsed;
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
export async function groupAds(scoredAds, projectName, flexAdCount = 1) {
  // Build scored ads payload for Claude
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

  const prompt = `You are a media buyer assembling flex ads (multi-image ad groups) for Meta advertising.

You have a set of scored ad creatives that all passed quality filtering. You need to:

1. GROUP them by angle/theme into distinct clusters
2. SELECT the ${flexAdCount} strongest clusters (most coherent angle + highest avg scores)
3. PICK the best ${IMAGES_PER_FLEX} ads from each cluster (these will be the images)
4. SELECT 3-5 HEADLINES for each cluster (Meta will test combinations)
5. SELECT 3-5 PRIMARY TEXTS for each cluster (Meta will test combinations)

BRAND: ${projectName}

=== FLEX AD STRUCTURE ===

Each flex ad contains:
- 10 images
- 3-5 headlines (Meta rotates and tests which performs best)
- 3-5 primary texts (Meta rotates and tests which performs best)

Target 5 of each, but minimum 3 are required. If you cannot find at least 3 quality headlines or 3 quality primary texts for a cluster, DO NOT create that flex ad — skip it.

=== CRITICAL COPY QUALITY RULES ===

EVERY headline and primary text you select MUST meet ALL of these. Do not include ANY that violate even one rule:

1. SPELLING AND GRAMMAR: Every word must be spelled correctly. Grammar must be clean and professional. One error = do not include it.

2. FIRST LINE HOOK (primary texts only): Every primary text MUST have a strong, compelling first line — a pattern interrupt, curiosity gap, bold claim, or emotional opener. This is what people see before clicking 'see more'. Weak first line = do not include it.

3. CTA AT END (primary texts only): Every primary text MUST end with a clear call to action. No CTA = do not include it.

4. THEMATIC ALIGNMENT: Every headline and every primary text must fit the cluster's angle. They do not all need to come from the same ad, but they must all speak to the same core theme/pain point/desire.

5. BROAD ENOUGH FOR ALL IMAGES: Each headline and primary text needs to make sense with any of the 10 images in the group. Avoid copy that references something too specific to one image.

6. VARIETY: The 3-5 headlines should take different approaches to the same angle (different hooks, different framings). Same for primary texts. Do not pick 5 headlines that say basically the same thing.

SCORED ADS (all passing):
${JSON.stringify(adsPayload, null, 2)}

RULES:
- Each flex ad must have exactly ${IMAGES_PER_FLEX} images
- Each flex ad gets 3-5 headlines AND 3-5 primary texts (target 5, minimum 3)
- If a cluster cannot produce at least 3 quality headlines AND 3 quality primary texts, skip it and try the next best cluster
- The ${flexAdCount} flex ads should target DIFFERENT angles for audience variety
- Prefer ads with higher overall_score within each cluster
- If two ads in the same cluster are nearly identical, prefer the one with higher copy_strength
- Do not include any copy from compliance-flagged ads

Respond ONLY with this exact JSON format:
{
  "flex_ads": [
    {
      "flex_ad_number": 1,
      "angle_theme": "descriptive label for this flex ad's angle",
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
      "image_ad_ids": ["ad_id_1", "ad_id_2", "... 10 total"],
      "avg_score": <average overall_score of selected ads>,
      "reasoning": "1 sentence on why this grouping works"
    }
  ],
  "rejected_from_grouping": ["ad_ids that passed scoring but didn't fit a flex group"],
  "skipped_clusters": ["any angle clusters that were skipped because they couldn't meet the minimum 3 headlines + 3 primary texts requirement"]
}`;

  const responseText = await chat(
    [{ role: 'user', content: prompt }],
    GROUP_MODEL,
    { max_tokens: 8192, temperature: 0, operation: 'filter_group_ads', projectId: scoredAds[0]?.ad?.project_id }
  );

  const parsed = extractJSON(responseText);
  if (!parsed || !parsed.flex_ads) {
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

Your task is to write 5 punchy headlines that:
- Are under 10 words each
- Align with and complement the primary text above
- Drive curiosity and clicks
- Sound natural, not salesy
- Each has a different angle or emphasis
- All speak to the angle/theme: ${angleTheme}

ALWAYS return ONLY a JSON object: { "headlines": ["h1", "h2", "h3", "h4", "h5"] }`;

  const hlResult = await chat(
    [
      { role: 'system', content: headlineSystemPrompt },
      { role: 'user', content: 'Write 5 punchy Facebook ad headlines based on the brand context and primary text provided. Return ONLY a JSON object: { "headlines": ["h1", "h2", "h3", "h4", "h5"] }' },
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

  console.log(`[FilterService] Generated ${primaryTexts.length} primary texts + ${headlines.length} headlines for ${project.name} (${angleTheme})`);
  return { primary_texts: primaryTexts, headlines };
}

// ── Deploy flex ad to Ready to Post ────────────────────────────────────────

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
  const campaignId = projectConfig.scout_default_campaign;
  if (!campaignId) throw new Error('No default campaign set for project (scout_default_campaign)');

  const effectiveAngle = angleName || flexAdDef.angle_theme || 'Unassigned';
  const cta = projectConfig.scout_cta || '';
  const displayLink = projectConfig.scout_display_link || '';
  const facebookPage = projectConfig.scout_facebook_page || '';
  const destinationUrl = projectConfig.scout_destination_url || '';
  const duplicateAdsetName = projectConfig.scout_duplicate_adset_name || '';

  // Get flex ad number for this angle
  const existingFlexAds = await getFlexAdsByProject(projectId);
  const matchingCount = existingFlexAds.filter(f => f.angle_name === effectiveAngle).length;
  const flexNum = matchingCount + 1;

  const adSetName = `${effectiveAngle} — Flex #${flexNum}`;
  const flexAdName = `Flex — ${effectiveAngle} #${flexNum} (${flexAdDef.image_ad_ids.length} images)`;

  // Use generated copy, falling back to grouped copy
  const headlines = generatedCopy.headlines.length >= HEADLINES_MIN
    ? generatedCopy.headlines.slice(0, HEADLINES_TARGET)
    : flexAdDef.headlines.map(h => h.text).slice(0, HEADLINES_TARGET);

  const primaryTexts = generatedCopy.primary_texts.length >= PRIMARY_TEXTS_MIN
    ? generatedCopy.primary_texts.slice(0, PRIMARY_TEXTS_TARGET)
    : flexAdDef.primary_texts.map(pt => pt.text).slice(0, PRIMARY_TEXTS_TARGET);

  // Create ad set
  const adSetId = crypto.randomUUID();
  await createAdSet({
    id: adSetId,
    campaign_id: campaignId,
    project_id: projectId,
    name: adSetName,
    sort_order: 0,
  });

  // Create individual deployments for each ad
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

  // Create flex ad
  const flexId = crypto.randomUUID();
  await createFlexAd({
    id: flexId,
    project_id: projectId,
    ad_set_id: adSetId,
    name: flexAdName,
    child_deployment_ids: deploymentIds,
    primary_texts: primaryTexts,
    headlines,
    destination_url: destinationUrl,
    display_link: displayLink,
    cta_button: cta,
    facebook_page: facebookPage,
    duplicate_adset_name: duplicateAdsetName,
    posting_day: postingDay || '',
    angle_name: effectiveAngle,
  });

  // Link each deployment to the flex ad
  for (const depId of deploymentIds) {
    await updateDeployment(depId, { flex_ad_id: flexId });
  }

  console.log(`[FilterService] Deployed: ${flexAdName} → Ready to Post (${headlines.length} headlines × ${primaryTexts.length} texts × ${deploymentIds.length} images)`);
  return { flexAdId: flexId, deploymentCount: deploymentIds.length };
}

async function markBatchFilterProcessed(batchId) {
  await updateBatchJob(batchId, {
    filter_processed: true,
    filter_processed_at: new Date().toISOString(),
  });
}

// ── Inline filter helpers ──────────────────────────────────────────────────

export async function scoreBatchForInlineFilter(batchId, projectId, onProgress, { roundNumber = 1, totalRounds = 1 } = {}) {
  const emit = (event) => { if (onProgress) try { onProgress(event); } catch {} };

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
  const topPerformers = 'No previous top performers available.';

  emit({
    type: 'progress',
    step: 'filter_scoring',
    message: `${roundLabel}: scoring ${ads.length} ads...`,
    scoringProgress: { current: 0, total: ads.length },
  });

  const scoredAds = [];
  let passCount = 0;

  for (let i = 0; i < ads.length; i++) {
    const ad = ads[i];
    emit({
      type: 'progress',
      step: 'filter_scoring',
      message: `${roundLabel}: scoring ad ${i + 1} of ${ads.length}...`,
      scoringProgress: { current: i + 1, total: ads.length },
    });

    try {
      const score = await scoreAd(ad, topPerformers, angleBrief, projectId);
      scoredAds.push({ ad, score });
      if (score.pass) passCount++;
      console.log(`[FilterService] Round ${roundNumber} ad ${ad.id.slice(0, 8)}: score=${score.overall_score}, pass=${score.pass}`);
    } catch (err) {
      console.error(`[FilterService] Failed to score ad ${ad.id.slice(0, 8)}: ${err.message}`);
      scoredAds.push({ ad, score: { ad_id: ad.id, overall_score: 0, pass: false, error: err.message } });
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

export async function finalizePassingAds({ passingAds, projectId, batchId, postingDay = 'test', angleName = '', onProgress }) {
  const emit = (event) => { if (onProgress) try { onProgress(event); } catch {} };

  if (passingAds.length < IMAGES_PER_FLEX) {
    return {
      flex_ads_created: 0,
      flex_ad_id: null,
      ready_to_post_count: 0,
      not_enough_passed: true,
    };
  }

  const project = await getProject(projectId);
  if (!project) throw new Error('Project not found');

  emit({ type: 'progress', step: 'filter_grouping', message: `Grouping ${passingAds.length} passing ads into a flex ad...` });

  const groupResult = await groupAds(passingAds, project.name, 1);
  const flexAds = groupResult.flex_ads || [];

  if (flexAds.length === 0) {
    console.warn(`[FilterService] Grouping returned 0 flex ads despite ${passingAds.length} passing ads`);
    emit({ type: 'progress', step: 'filter_complete', message: 'Grouping could not create a flex ad. Check copy quality.' });
    return {
      flex_ads_created: 0,
      flex_ad_id: null,
      ready_to_post_count: 0,
      grouping_failed: true,
    };
  }

  const flexAdDef = flexAds[0];
  emit({ type: 'progress', step: 'filter_copy_gen', message: `Generating copy for "${flexAdDef.angle_theme}"...` });

  const adCreativesForCopy = flexAdDef.image_ad_ids.slice(0, 5).map(adId => {
    const found = passingAds.find(sa => sa.ad.id === adId);
    return found ? found.ad : { headline: '', body_copy: '', angle: '' };
  });

  const generatedCopy = await generateFilterCopy(projectId, flexAdDef.angle_theme, adCreativesForCopy);

  emit({ type: 'progress', step: 'filter_deploying', message: 'Creating flex ad and deploying to Ready to Post...' });

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
      message: `Flex ad deployed: ${passingAds.length} approved ads available, ${deployResult.deploymentCount} images → Ready to Post`,
    });

    return {
      flex_ads_created: 1,
      flex_ad_id: deployResult.flexAdId,
      ready_to_post_count: deployResult.deploymentCount,
      selected_ad_ids: flexAdDef.image_ad_ids.slice(),
    };
  } catch (err) {
    console.error(`[FilterService] Deployment failed: ${err.message}`);
    return {
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
    const msg = `Only ${scoreResult.ads_passed} of ${scoreResult.ads_scored} ads passed scoring (need ${IMAGES_PER_FLEX}). No flex ad created.`;
    console.warn(`[FilterService] ${msg}`);
    emit({ type: 'progress', step: 'filter_complete', message: msg });
    return {
      ads_scored: scoreResult.ads_scored,
      ads_passed: scoreResult.ads_passed,
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

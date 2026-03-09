/**
 * LP Auto-Generator — Orchestrate automatic landing page generation for Director batches.
 *
 * When the Director creates a batch, this service:
 * 1. Checks if LP auto-generation is enabled for the project
 * 2. Runs the generation pipeline (1-5 narrative frames with scoring + retries)
 * 3. Publishes passing LPs to Shopify and verifies they're live
 * 4. Updates the batch record with LP IDs, URLs, and statuses
 *
 * All errors are caught — failures set status to 'failed' + error, never throw to caller.
 */

import { v4 as uuidv4 } from 'uuid';
import {
  getLPAgentConfig,
  getLPTemplatesByProject,
  createLandingPage,
  updateLandingPage,
  updateBatchJob,
  getBatchJob,
  getAdsByBatchId,
  getProject,
  getActiveConductorAngles,
  updateFlexAd,
  getRecentLPHeadlineHistoryByAngle,
  getRecentLPHeadlineHistoryByAngleAndFrame,
  recordLPHeadlineHistory,
} from '../convexClient.js';
import {
  generateAndValidateLP,
  generateAutoLP,
  generateSlotImages,
  preScoreAndRetryImages,
  scoreGauntletLP,
  regenerateFailedImages,
  detectImageMimeType,
  NARRATIVE_FRAMES,
  assembleLandingPage,
  postProcessLP,
  repairLPHeadline,
  repairLPContentAlignment,
} from './lpGenerator.js';
import { getCachedImageContext, getFoundationalDocs } from './lpGenerator.js';
import { publishAndSmokeTest, generateSlug, extractHeadlineForSlug } from './lpPublisher.js';
import { uploadBuffer, downloadToBuffer } from '../convexClient.js';
import { setProgress, clearProgress } from './gauntletProgress.js';
import {
  applyLPHeadlineParts,
  buildLPHeadlineHistoryEntry,
  buildLPHeadlineSignature,
  buildNarrativeFrameBlueprintSummary,
  evaluateTitleFamilyUniqueness,
  evaluateHistoryHeadlineUniqueness,
  evaluateSameRunHeadlineUniqueness,
  extractLPHeadlineParts,
  getNarrativeFrameBlueprint,
  getNarrativeFrameHeadlineContract,
  normalizeLPHeadlineText,
  validateLPFrameBlueprint,
  validateLPHeadlineSourceAlignment,
  validateLPHeadlineFrameAlignment,
} from './lpHeadlineValidation.js';

const LP_BATCH_SYNC_FIELDS = [
  'lp_primary_id',
  'lp_primary_url',
  'lp_primary_status',
  'lp_primary_error',
  'lp_primary_retry_count',
  'lp_secondary_id',
  'lp_secondary_url',
  'lp_secondary_status',
  'lp_secondary_error',
  'lp_secondary_retry_count',
  'lp_narrative_frames',
  'gauntlet_lp_urls',
];

function touchesLPBatchState(fields = {}) {
  return LP_BATCH_SYNC_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(fields, field));
}

async function mirrorBatchLandingPagesToFlexAd(batch) {
  if (!batch?.flex_ad_id) return;

  try {
    await updateFlexAd(batch.flex_ad_id, {
      lp_primary_url: batch.lp_primary_url || '',
      lp_secondary_url: batch.lp_secondary_url || '',
      gauntlet_lp_urls: batch.gauntlet_lp_urls || '',
    });
  } catch (err) {
    console.warn(`[LPAuto] Failed to mirror LP fields from batch ${batch.externalId?.slice(0, 8) || batch.id?.slice(0, 8) || 'unknown'} to flex ${batch.flex_ad_id.slice(0, 8)}:`, err.message);
  }
}

export async function updateBatchJobAndMirror(batchJobId, fields) {
  await updateBatchJob(batchJobId, fields);
  if (!touchesLPBatchState(fields)) return null;

  const batch = await getBatchJob(batchJobId);
  if (!batch) return null;
  await mirrorBatchLandingPagesToFlexAd(batch);
  return batch;
}

function extractOpeningLine(text = '') {
  const value = String(text || '').trim();
  if (!value) return '';
  const firstSentence = value.split(/(?<=[.!?])\s+/)[0] || value;
  return firstSentence.trim();
}

function buildKeywordList(values = [], limit = 14) {
  const tokens = values
    .flatMap((value) => normalizeLPHeadlineText(value || '').split(' '))
    .map((token) => token.trim())
    .filter((token) => token.length > 2);
  return [...new Set(tokens)].slice(0, limit);
}

function buildCampaignMessageBrief({ batchAngle = '', angleBrief = null, approvedAds = [] }) {
  const headlineExamples = approvedAds
    .map((ad) => String(ad?.headline || '').trim())
    .filter(Boolean)
    .slice(0, 6);
  const openingExamples = approvedAds
    .map((ad) => extractOpeningLine(ad?.body_copy || ''))
    .filter(Boolean)
    .slice(0, 6);
  const angleSummaryParts = [batchAngle || angleBrief?.name || 'General'];
  if (angleBrief?.scene) angleSummaryParts.push(`Scene: ${angleBrief.scene}`);
  if (angleBrief?.core_buyer) angleSummaryParts.push(`Core buyer: ${angleBrief.core_buyer}`);
  if (angleBrief?.symptom_pattern) angleSummaryParts.push(`Symptom pattern: ${angleBrief.symptom_pattern}`);
  if (angleBrief?.desired_belief_shift) angleSummaryParts.push(`Desired belief shift: ${angleBrief.desired_belief_shift}`);
  if (angleBrief?.tone) angleSummaryParts.push(`Tone: ${angleBrief.tone}`);

  return {
    sourceMode: headlineExamples.length > 0 || openingExamples.length > 0 ? 'director_ads' : 'angle_only',
    angleName: batchAngle || angleBrief?.name || '',
    angleSummary: angleSummaryParts.join('\n'),
    coreScene: angleBrief?.scene || '',
    desiredBeliefShift: angleBrief?.desired_belief_shift || '',
    headlineExamples,
    openingExamples,
    messageKeywords: buildKeywordList([
      batchAngle,
      angleBrief?.scene,
      angleBrief?.symptom_pattern,
      angleBrief?.desired_belief_shift,
      ...headlineExamples,
      ...openingExamples,
    ]),
  };
}

function buildHeadlineConstraintBundle(frame, usedHeadlines, angleHistory) {
  return {
    contract: getNarrativeFrameHeadlineContract(frame.id),
    frameBlueprint: buildNarrativeFrameBlueprintSummary(frame.id),
    usedHeadlines: usedHeadlines.map((entry) => ({
      narrative_frame: entry.narrative_frame,
      headline_text: entry.headline_text,
      title_family: entry.title_family,
    })),
    historyHeadlines: angleHistory.slice(0, 20).map((entry) => ({
      narrative_frame: entry.narrative_frame,
      headline_text: entry.headline_text,
    })),
  };
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

const LP_HEAVY_UPDATE_KEYS = new Set([
  'copy_sections',
  'image_slots',
  'html_template',
  'assembled_html',
  'swipe_design_analysis',
  'audit_trail',
  'editorial_plan',
  'qa_report',
  'smoke_test_report',
  'final_html',
  'hosting_metadata',
]);

function mapLandingPageMutationError(stage, err) {
  const message = String(err?.message || err || '').trim() || 'Unknown landing-page mutation failure';
  if (/landing page not found/i.test(message)) return message;
  return `LP mutation failed during ${stage}: ${message}`;
}

async function updateLandingPageSafely(externalId, fields, { stage = 'update' } = {}) {
  const baseFields = {};
  const heavyFields = {};

  for (const [key, value] of Object.entries(fields || {})) {
    if (value === undefined) continue;
    if (LP_HEAVY_UPDATE_KEYS.has(key)) {
      heavyFields[key] = value;
    } else {
      baseFields[key] = value;
    }
  }

  try {
    if (Object.keys(baseFields).length > 0) {
      await updateLandingPage(externalId, baseFields);
    }
    for (const [key, value] of Object.entries(heavyFields)) {
      await updateLandingPage(externalId, { [key]: value });
    }
  } catch (err) {
    throw new Error(mapLandingPageMutationError(stage, err));
  }
}

function buildCompactGauntletQAReport(lastScore, passed) {
  const fatalFlaws = ensureArray(lastScore?.fatal_flaws).map((flaw) => ({
    type: flaw?.type || 'fatal_flaw',
    position: flaw?.image_position || flaw?.location || null,
  }));

  return {
    passed,
    score: lastScore ? Math.round((lastScore.score / 11) * 100) : (passed ? 60 : 0),
    summary: lastScore?.reasoning
      ? String(lastScore.reasoning).slice(0, 400)
      : (passed ? 'Gauntlet passed without a detailed score payload.' : 'Gauntlet failed before a score payload was available.'),
    fatal_flaws: fatalFlaws,
    fatal_flaw_count: fatalFlaws.length,
    categories: lastScore ? {
      image_sensibility: lastScore.image_sensibility ?? null,
      visual_coherence: lastScore.visual_coherence ?? null,
      cta_effectiveness: lastScore.cta_effectiveness ?? null,
      copy_quality: lastScore.copy_quality ?? null,
    } : null,
    source: 'gauntlet',
    checked_at: new Date().toISOString(),
  };
}

function buildGauntletDraftFields({
  headlineEvaluation,
  attempt,
  lpSlug,
}) {
  return {
    status: 'draft',
    headline_text: headlineEvaluation.headline || undefined,
    subheadline_text: headlineEvaluation.subheadline || undefined,
    headline_frame_alignment_status: headlineEvaluation.frameAlignment.passed ? 'passed' : 'failed',
    headline_frame_alignment_reason: headlineEvaluation.frameAlignment.reason,
    frame_blueprint_status: headlineEvaluation.frameBlueprint.passed ? 'passed' : 'failed',
    frame_blueprint_reason: headlineEvaluation.frameBlueprint.reason,
    headline_uniqueness_status: headlineEvaluation.uniqueness.passed ? 'passed' : 'failed',
    headline_uniqueness_reason: headlineEvaluation.uniqueness.reason,
    headline_duplicate_of_lp_id: headlineEvaluation.uniqueness.duplicateOf || undefined,
    title_family_uniqueness_status: headlineEvaluation.titleFamilyUniqueness.passed ? 'passed' : 'failed',
    title_family_uniqueness_reason: headlineEvaluation.titleFamilyUniqueness.reason,
    headline_history_status: headlineEvaluation.history.passed ? 'passed' : 'failed',
    headline_history_reason: headlineEvaluation.history.reason,
    headline_signature: headlineEvaluation.headline_signature || undefined,
    gauntlet_attempt: attempt,
    gauntlet_status: 'scoring',
    slug: lpSlug,
  };
}

function buildGauntletPublishFields(lpResult) {
  return {
    copy_sections: JSON.stringify(lpResult.copySections),
    image_slots: JSON.stringify(lpResult.imageSlots),
    html_template: lpResult.htmlTemplate,
    assembled_html: lpResult.assembledHtml,
  };
}

async function persistGauntletScoreResult(lpId, {
  lastScore,
  passed,
  frameResult,
  frameDurationMs,
}) {
  const compactQaReport = buildCompactGauntletQAReport(lastScore, passed);
  const gauntletScore = typeof lastScore?.score === 'number' ? lastScore.score : undefined;
  const gauntletReasoning = lastScore?.reasoning
    ? String(lastScore.reasoning).slice(0, 1200)
    : compactQaReport.summary;
  const primaryFields = {
    gauntlet_score: gauntletScore,
    gauntlet_score_reasoning: gauntletReasoning,
    gauntlet_status: passed ? 'passed' : 'failed',
    gauntlet_image_prescore_attempts: frameResult.imagePrescoreAttempts,
    generation_duration_ms: frameDurationMs,
    qa_status: passed ? 'passed' : 'failed',
    qa_score: compactQaReport.score,
    qa_issues_count: compactQaReport.fatal_flaw_count,
  };

  try {
    await updateLandingPageSafely(lpId, primaryFields, { stage: 'store_gauntlet_score' });
    return { qaReport: compactQaReport, persistenceMode: 'full' };
  } catch (err) {
    console.warn(`[Gauntlet] Compact score persistence failed for ${lpId.slice(0, 8)}:`, err.message);
    const fallbackFields = {
      gauntlet_score: gauntletScore,
      gauntlet_score_reasoning: compactQaReport.summary,
      gauntlet_status: passed ? 'passed' : 'failed',
      gauntlet_image_prescore_attempts: frameResult.imagePrescoreAttempts,
      generation_duration_ms: frameDurationMs,
      qa_status: passed ? 'passed' : 'failed',
      qa_score: compactQaReport.score,
      qa_issues_count: compactQaReport.fatal_flaw_count,
    };
    await updateLandingPageSafely(lpId, fallbackFields, { stage: 'store_gauntlet_score_minimal' });
    return { qaReport: compactQaReport, persistenceMode: 'minimal' };
  }
}

export async function scorePersistOnly({ lpId, lastScore, passed, frameResult, frameDurationMs }) {
  return persistGauntletScoreResult(lpId, { lastScore, passed, frameResult, frameDurationMs });
}

function evaluateFrameHeadline({
  lpResult,
  frame,
  batchAngle,
  messageBrief,
  acceptedHeadlines,
  sameFrameHistory,
  angleHistory,
}) {
  const headlineParts = extractLPHeadlineParts(lpResult.copySections, lpResult.editorialPlan);
  const frameAlignment = validateLPHeadlineFrameAlignment({
    headline: headlineParts.headline,
    narrativeFrame: frame.id,
    angle: batchAngle || '',
  });
  const frameBlueprint = validateLPFrameBlueprint({
    headline: headlineParts.headline,
    narrativeFrame: frame.id,
    copySections: lpResult.copySections,
    angle: batchAngle || '',
  });
  const uniqueness = evaluateSameRunHeadlineUniqueness({
    headline: headlineParts.headline,
    narrativeFrame: frame.id,
    signature: buildLPHeadlineSignature({ headline: headlineParts.headline, narrativeFrame: frame.id }),
    acceptedHeadlines,
  });
  const titleFamilyUniqueness = evaluateTitleFamilyUniqueness({
    headline: headlineParts.headline,
    narrativeFrame: frame.id,
    acceptedHeadlines,
    angle: batchAngle || messageBrief?.angleName || '',
    messageBrief,
  });
  const sourceAlignment = validateLPHeadlineSourceAlignment({
    headline: headlineParts.headline,
    subheadline: headlineParts.subheadline,
    angle: batchAngle || messageBrief?.angleName || '',
    messageBrief,
  });
  const history = batchAngle
    ? evaluateHistoryHeadlineUniqueness({
        headline: headlineParts.headline,
        narrativeFrame: frame.id,
        signature: buildLPHeadlineSignature({ headline: headlineParts.headline, narrativeFrame: frame.id }),
        sameFrameHistory,
        angleHistory,
        angle: batchAngle || messageBrief?.angleName || '',
        messageBrief,
      })
    : { passed: true, reason: 'No batch angle set for cross-run LP history.' };

  return {
    ...headlineParts,
    frameAlignment,
    frameBlueprint,
    uniqueness,
    titleFamilyUniqueness,
    sourceAlignment,
    history,
    passed:
      !!headlineParts.headline &&
      frameAlignment.passed &&
      frameBlueprint.passed &&
      uniqueness.passed &&
      sourceAlignment.passed,
  };
}

async function rebuildLPAfterHeadlineRepair(lpResult, { headline, subheadline }, { project, agentConfig, angle }) {
  const repairedSections = applyLPHeadlineParts(lpResult.copySections, { headline, subheadline });
  const repairedEditorialPlan = {
    ...(lpResult.editorialPlan || {}),
    headline,
    subheadline,
  };

  const rawAssembledHtml = assembleLandingPage({
    htmlTemplate: lpResult.htmlTemplate,
    copySections: repairedSections,
    imageSlots: lpResult.imageSlots,
    ctaElements: lpResult.designAnalysis?.cta_elements || [],
  });
  const postProcessed = postProcessLP(rawAssembledHtml, {
    project,
    agentConfig,
    angle,
    editorialPlan: repairedEditorialPlan,
  });

  return {
    ...lpResult,
    copySections: repairedSections,
    editorialPlan: repairedEditorialPlan,
    assembledHtml: postProcessed.html,
  };
}

async function rebuildLPAfterContentRepair(lpResult, repairedSections, { project, agentConfig, angle }) {
  const rawAssembledHtml = assembleLandingPage({
    htmlTemplate: lpResult.htmlTemplate,
    copySections: repairedSections,
    imageSlots: lpResult.imageSlots,
    ctaElements: lpResult.designAnalysis?.cta_elements || [],
  });
  const postProcessed = postProcessLP(rawAssembledHtml, {
    project,
    agentConfig,
    angle,
    editorialPlan: lpResult.editorialPlan || {},
  });

  return {
    ...lpResult,
    copySections: repairedSections,
    assembledHtml: postProcessed.html,
  };
}

function getBatchTerminalLPStatus(frameResults) {
  const publishedCount = frameResults.filter((result) => !!result.publishedUrl).length;
  if (publishedCount > 0) return 'live';
  if (frameResults.some((result) => result.status === 'headline_failed')) return 'headline_failed';
  if (frameResults.some((result) => result.status === 'smoke_failed')) return 'smoke_failed';
  return 'failed';
}

/**
 * Trigger LP generation for a batch. Fire-and-forget — never throws.
 *
 * @param {string} batchJobId - batch_jobs externalId
 * @param {string} projectId - projects externalId
 * @param {string} angle - The angle name/prompt for this batch
 */
export async function triggerLPGeneration(batchJobId, projectId, angle) {
  try {
    // 1. Check if LP auto-generation is enabled
    const config = await getLPAgentConfig(projectId);
    if (!config || !config.enabled) {
      console.log(`[LPAuto] LP auto-generation disabled for project ${projectId.slice(0, 8)} — skipping`);
      return;
    }

    // 1b. Check per-angle LP control
    const defaultMode = config.lp_default_mode || 'opt_in';
    const angles = await getActiveConductorAngles(projectId);
    const matchedAngle = angles.find(a => a.name === angle);

    // Load structured angle brief from the batch record (set by Director in Phase 3)
    let angleBrief = null;
    try {
      const batch = await getBatchJob(batchJobId);
      if (batch?.angle_brief) {
        angleBrief = JSON.parse(batch.angle_brief);
      }
    } catch { /* non-critical — proceed without brief */ }

    let shouldGenerateLP;
    if (matchedAngle && matchedAngle.lp_enabled !== undefined && matchedAngle.lp_enabled !== null) {
      // Explicit per-angle override
      shouldGenerateLP = matchedAngle.lp_enabled;
    } else {
      // Fall back to project default mode
      shouldGenerateLP = defaultMode === 'all';
    }

    if (!shouldGenerateLP) {
      console.log(`[LPAuto] LP disabled for angle "${angle}" (mode=${defaultMode}, override=${matchedAngle?.lp_enabled ?? 'none'}) — skipping`);
      return;
    }

    // 2. Load templates for the project
    const templates = await getLPTemplatesByProject(projectId);
    const readyTemplates = templates.filter(t => t.status === 'ready');

    if (readyTemplates.length === 0) {
      console.warn(`[LPAuto] No ready templates for project ${projectId.slice(0, 8)} — skipping LP generation`);
      return;
    }

    // 3. Wait for Creative Filter to finish scoring the ads before generating LPs
    //    This ensures LPs align with the approved ads that will actually go live.
    console.log(`[LPAuto] Waiting for Creative Filter to finish scoring batch ${batchJobId.slice(0, 8)}...`);
    let approvedAds = [];
    const POLL_INTERVAL_MS = 30_000; // 30 seconds
    const MAX_WAIT_MS = 2 * 60 * 60 * 1000; // 2 hours
    const waitStart = Date.now();

    while (Date.now() - waitStart < MAX_WAIT_MS) {
      const batch = await getBatchJob(batchJobId);
      if (!batch) {
        console.warn(`[LPAuto] Batch ${batchJobId.slice(0, 8)} not found — proceeding without ad reference`);
        break;
      }
      if (batch.filter_processed) {
        console.log(`[LPAuto] Creative Filter finished for batch ${batchJobId.slice(0, 8)} — loading approved ads`);
        const allAds = await getAdsByBatchId(batchJobId);
        approvedAds = allAds.filter(ad =>
          ad.tags && Array.isArray(ad.tags) && ad.tags.includes('Filter Approved')
        );
        console.log(`[LPAuto] Found ${approvedAds.length} approved ads out of ${allAds.length} total`);
        break;
      }
      const elapsed = Math.round((Date.now() - waitStart) / 60_000);
      console.log(`[LPAuto] Creative Filter not done yet for batch ${batchJobId.slice(0, 8)} — waited ${elapsed}min, polling again in 30s...`);
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    if (Date.now() - waitStart >= MAX_WAIT_MS) {
      console.warn(`[LPAuto] Timed out waiting for Creative Filter (2h) for batch ${batchJobId.slice(0, 8)} — proceeding without ad reference`);
    }

    const messageBrief = buildCampaignMessageBrief({
      batchAngle: angle,
      angleBrief,
      approvedAds,
    });

    // 4. Run the generation pipeline
    console.log(`[LPAuto] Running LP generation for project ${projectId.slice(0, 8)}, batch ${batchJobId.slice(0, 8)}${approvedAds.length > 0 ? ` with ${approvedAds.length} approved ads as reference` : ' (no ad reference)'}`);
    try {
      await updateBatchJobAndMirror(batchJobId, {
        lp_primary_status: 'generating',
        lp_secondary_status: 'generating',
      });

      const makeLogger = (event) => {
        if (event.type === 'progress') {
          console.log(`[LPAuto] ${event.message}`);
        }
      };

      const report = await runGauntlet(projectId, {
        dryRun: false,
        batchJobId,
        angle,
        angleBrief,
        approvedAds,
        messageBrief,
      }, makeLogger);

      // Store LP URLs on the batch for filter.sh to pick up
      if (report.lpUrls && report.lpUrls.length > 0) {
        const updates = {
          gauntlet_lp_urls: JSON.stringify(report.lpUrls),
          lp_primary_url: report.lpUrls[0]?.url || null,
          lp_primary_status: 'live',
          lp_primary_id: report.frames[0]?.lpId || null,
        };
        if (report.lpUrls.length > 1) {
          updates.lp_secondary_url = report.lpUrls[1]?.url || null;
          updates.lp_secondary_status = 'live';
          updates.lp_secondary_id = report.frames[1]?.lpId || null;
        } else {
          updates.lp_secondary_status = 'skipped';
        }
        await updateBatchJobAndMirror(batchJobId, updates);
      } else {
        const terminalStatus = report.summary?.terminalStatus || 'failed';
        const terminalError = terminalStatus === 'headline_failed'
          ? 'LP gauntlet could not produce frame-valid unique headlines after retries'
          : terminalStatus === 'smoke_failed'
            ? 'LPs published but failed smoke checks'
            : 'No LPs passed scoring threshold';
        await updateBatchJobAndMirror(batchJobId, {
          lp_primary_status: terminalStatus,
          lp_primary_error: terminalError,
          lp_secondary_status: terminalStatus,
          lp_secondary_error: terminalError,
        });
      }

      console.log(`[LPAuto] Complete for batch ${batchJobId.slice(0, 8)}: ${report.summary.passed}/${report.summary.total} passed, ${report.summary.published} published`);
    } catch (gErr) {
      console.error(`[LPAuto] Failed for batch ${batchJobId.slice(0, 8)}:`, gErr.message);
      await updateBatchJobAndMirror(batchJobId, {
        lp_primary_status: 'failed',
        lp_primary_error: gErr.message,
        lp_secondary_status: 'failed',
        lp_secondary_error: gErr.message,
      });
    }
  } catch (err) {
    // Top-level catch — never propagate errors to caller
    console.error(`[LPAuto] Fatal error for batch ${batchJobId.slice(0, 8)}:`, err.message);
    try {
      await updateBatchJobAndMirror(batchJobId, {
        lp_primary_status: 'failed',
        lp_primary_error: err.message,
        lp_secondary_status: 'failed',
        lp_secondary_error: err.message,
      });
    } catch {
      // Even updating batch failed — nothing more we can do
    }
  }
}

/**
 * Generate a single LP with QA validation loop, publish to Shopify, and smoke test.
 * Only returns a URL if both QA and smoke test pass.
 * @returns {{ lpId, publishedUrl, verified }}
 */
async function generateAndPublishLP({ projectId, batchJobId, angle, template, frame, label, sendEvent, editorialPassEnabled = true, useProductReferenceImages = true, agentConfig = null }) {
  const lpId = uuidv4();
  const lpName = `${angle.slice(0, 50)} — ${frame.name} (Auto)`;

  // Create the landing page record
  await createLandingPage({
    id: lpId,
    project_id: projectId,
    name: lpName,
    angle,
    status: 'generating',
    auto_generated: true,
    batch_job_id: batchJobId,
    narrative_frame: frame.id,
    template_id: template.id,
  });

  try {
    // Generate with QA validation + auto-fix loop
    const visualQAEnabled = agentConfig?.visual_qa_enabled !== false;
    const { result, qaReport, fixLog, generationAttempts, fixAttempts } = await generateAndValidateLP({
      projectId,
      templateId: template.id,
      angle,
      narrativeFrame: frame.instruction,
      batchJobId,
      editorialPassEnabled,
      useProductReferenceImages,
      agentConfig,
    }, sendEvent, { visualQAEnabled });

    // Handle failed generation (all QA attempts exhausted)
    if (!result) {
      await updateLandingPageSafely(lpId, {
        status: 'failed',
        error_message: 'All generation attempts failed visual QA',
        qa_status: 'failed',
        qa_report: qaReport ? JSON.stringify({ ...qaReport, screenshotBuffer: undefined }) : undefined,
        qa_score: qaReport?.score,
        qa_issues_count: qaReport?.issues?.length ?? 0,
        generation_attempts: generationAttempts,
        fix_attempts: fixAttempts,
      }, { stage: 'store_generate_and_validate_failure' });
      throw new Error(`${label} LP generation failed QA after ${generationAttempts} attempts`);
    }

    // Save generated content + QA results
    const updateFields = {
      status: 'draft',
      copy_sections: JSON.stringify(result.copySections),
      image_slots: JSON.stringify(result.imageSlots),
      html_template: result.htmlTemplate,
      assembled_html: result.assembledHtml,
      swipe_design_analysis: JSON.stringify(result.designAnalysis),
      generation_attempts: generationAttempts,
      fix_attempts: fixAttempts,
    };

    // Persist audit trail + editorial plan
    if (result.auditTrail) updateFields.audit_trail = JSON.stringify(result.auditTrail);
    if (result.editorialPlan) updateFields.editorial_plan = JSON.stringify(result.editorialPlan);

    if (qaReport) {
      let qaScreenshotStorageId = null;
      if (qaReport.screenshotBuffer) {
        qaScreenshotStorageId = await uploadBuffer(qaReport.screenshotBuffer, 'image/jpeg');
      }
      updateFields.qa_status = qaReport.passed ? 'passed' : 'failed';
      updateFields.qa_score = qaReport.score;
      updateFields.qa_report = JSON.stringify({ ...qaReport, screenshotBuffer: undefined });
      updateFields.qa_issues_count = qaReport.issues.length;
      if (qaScreenshotStorageId) updateFields.qa_screenshot_storageId = qaScreenshotStorageId;
    }

    await updateLandingPageSafely(lpId, updateFields, { stage: 'store_generate_and_publish_lp' });

    // Publish + smoke test
    const { publishResult, smokeResult, verified } = await publishAndSmokeTest(lpId, projectId, {
      pdpUrl: agentConfig?.pdp_url,
    });

    // Only return URL if smoke test passed (or wasn't run)
    const smokeOk = !smokeResult || smokeResult.passed;
    return {
      lpId,
      publishedUrl: smokeOk ? publishResult.published_url : null,
      verified: verified && smokeOk,
    };
  } catch (err) {
    // Update LP to failed state
    await updateLandingPageSafely(lpId, {
      status: 'failed',
      error_message: err.message,
    }, { stage: 'store_generate_and_publish_failure' });
    throw err;
  }
}

/**
 * Retry a failed LP for a batch.
 *
 * @param {string} batchJobId - batch_jobs externalId
 * @param {string} which - 'primary', 'secondary', or 'both'
 * @param {object} [options]
 * @param {boolean} [options.switchTemplate] - Use a different template
 * @param {boolean} [options.fullRegenerate] - Complete regeneration from scratch
 */
export async function retryLP(batchJobId, which, { switchTemplate, fullRegenerate } = {}) {
  // This will be called by the Filter gate retry mechanism (Phase 3)
  // For now, re-trigger generation for the failed LP(s)
  console.log(`[LPAuto] Retry requested for batch ${batchJobId.slice(0, 8)}, which=${which}, switchTemplate=${!!switchTemplate}, fullRegenerate=${!!fullRegenerate}`);

  // Load batch to get project and angle info
  const { getBatchJob } = await import('../convexClient.js');
  const batch = await getBatchJob(batchJobId);
  if (!batch) {
    throw new Error(`Batch ${batchJobId} not found`);
  }

  const projectId = batch.project_id;
  const angle = batch.angle_name || batch.angle || 'General';

  // Load templates
  const templates = await getLPTemplatesByProject(projectId);
  const readyTemplates = templates.filter(t => t.status === 'ready');
  if (readyTemplates.length === 0) {
    throw new Error('No ready templates available for retry');
  }

  // Parse existing narrative frames
  let existingFrames = [];
  try {
    existingFrames = JSON.parse(batch.lp_narrative_frames || '[]');
  } catch {}

  const retryPrimary = which === 'primary' || which === 'both';
  const retrySecondary = which === 'secondary' || which === 'both';

  const makeLogger = (label) => (event) => {
    if (event.type === 'progress') {
      console.log(`[LPAuto Retry] ${label}: ${event.message}`);
    }
  };

  if (retryPrimary) {
    const retryCount = (batch.lp_primary_retry_count || 0) + 1;
    await updateBatchJobAndMirror(batchJobId, {
      lp_primary_status: 'generating',
      lp_primary_error: null,
      lp_primary_retry_count: retryCount,
    });

    // Pick template — switch if requested or on 4th+ retry
    const templateIdx = (switchTemplate || retryCount >= 4) ? Math.floor(Math.random() * readyTemplates.length) : 0;
    const template = readyTemplates[templateIdx];
    const frame = NARRATIVE_FRAMES.find(f => f.id === existingFrames[0]) || NARRATIVE_FRAMES[0];

    try {
      const result = await generateAndPublishLP({
        projectId,
        batchJobId,
        angle,
        template,
        frame,
        label: 'Primary Retry',
        sendEvent: makeLogger('Primary Retry'),
      });

      await updateBatchJobAndMirror(batchJobId, {
        lp_primary_id: result.lpId,
        lp_primary_url: result.publishedUrl,
        lp_primary_status: result.verified ? 'live' : 'published',
      });
    } catch (err) {
      await updateBatchJobAndMirror(batchJobId, {
        lp_primary_status: 'failed',
        lp_primary_error: err.message,
      });
    }
  }

  if (retrySecondary) {
    const retryCount = (batch.lp_secondary_retry_count || 0) + 1;
    await updateBatchJobAndMirror(batchJobId, {
      lp_secondary_status: 'generating',
      lp_secondary_error: null,
      lp_secondary_retry_count: retryCount,
    });

    const templateIdx = (switchTemplate || retryCount >= 4)
      ? Math.floor(Math.random() * readyTemplates.length)
      : Math.min(1, readyTemplates.length - 1);
    const template = readyTemplates[templateIdx];
    const frame = NARRATIVE_FRAMES.find(f => f.id === existingFrames[1]) || NARRATIVE_FRAMES[1];

    try {
      const result = await generateAndPublishLP({
        projectId,
        batchJobId,
        angle,
        template,
        frame,
        label: 'Secondary Retry',
        sendEvent: makeLogger('Secondary Retry'),
      });

      await updateBatchJobAndMirror(batchJobId, {
        lp_secondary_id: result.lpId,
        lp_secondary_url: result.publishedUrl,
        lp_secondary_status: result.verified ? 'live' : 'published',
      });
    } catch (err) {
      await updateBatchJobAndMirror(batchJobId, {
        lp_secondary_status: 'failed',
        lp_secondary_error: err.message,
      });
    }
  }
}

// ─── LP Gauntlet ──────────────────────────────────────────────────────────────

/**
 * Run the LP generation pipeline — generate landing pages (one per narrative frame)
 * with image pre-scoring, template caching, full-page scoring, and targeted retries.
 *
 * @param {string} projectId
 * @param {{ dryRun?: boolean }} options
 * @param {(event: object) => void} sendEvent - SSE event callback
 * @returns {Promise<object>} Report with per-frame results + summary
 */
export async function runGauntlet(projectId, options = {}, sendEventRaw) {
  const {
    dryRun = false,
    batchJobId = null,
    angle: batchAngle = null,
    angleBrief = null,
    approvedAds = [],
    messageBrief: providedMessageBrief = null,
    frameIds = null,
  } = options;
  const messageBrief = providedMessageBrief || buildCampaignMessageBrief({
    batchAngle,
    angleBrief,
    approvedAds,
  });
  const gauntletBatchId = uuidv4();
  const startTime = Date.now();
  const batchStartedAt = new Date().toISOString();

  // Sub-step progress weights (same as frontend mapping)
  const SUB_STEPS = {
    'gauntlet_init': 0, 'gauntlet_config': 0, 'gauntlet_frame_start': 0,
    'gauntlet_images': 0.1, 'gauntlet_prescore': 0.3, 'gauntlet_generate': 0.5,
    'gauntlet_template_cached': 0.55, 'gauntlet_scoring': 0.8, 'gauntlet_score_result': 0.85,
    'gauntlet_image_retry': 0.85, 'gauntlet_full_retry': 0.5, 'gauntlet_publishing': 0.9,
    'gauntlet_published': 0.95, 'gauntlet_frame_done': 1, 'gauntlet_complete': 1,
  };

  // Wrap sendEvent to also write to the in-memory progress store
  const sendEvent = (data) => {
    sendEventRaw(data);
    if (data.type === 'progress') {
      let percent = 0;
      if (data.step === 'gauntlet_complete') {
        percent = 100;
      } else if (data.gauntlet?.frame && data.gauntlet?.total) {
        const frameBase = ((data.gauntlet.frame - 1) / data.gauntlet.total) * 100;
        const frameChunk = 100 / data.gauntlet.total;
        const sub = SUB_STEPS[data.step] ?? 0.5;
        percent = Math.round(frameBase + sub * frameChunk);
      } else {
        percent = SUB_STEPS[data.step] != null ? Math.round(SUB_STEPS[data.step] * 5) : 0;
      }
      setProgress(gauntletBatchId, projectId, {
        step: data.step || '',
        message: data.message || '',
        percent,
      });
    }
  };

  sendEvent({ type: 'progress', step: 'gauntlet_init', message: 'Initializing LP generation pipeline...' });

  // 1. Load config, templates, project
  const config = await getLPAgentConfig(projectId);
  if (!config) {
    throw new Error('LP Agent not configured for this project');
  }

  const scoreThreshold = config.gauntlet_score_threshold || 7;
  const maxImageRetries = config.gauntlet_max_image_retries || 5;
  const maxLPRetries = config.gauntlet_max_lp_retries || 2;

  const templates = await getLPTemplatesByProject(projectId);
  const readyTemplates = templates.filter(t => t.status === 'ready');
  if (readyTemplates.length === 0) {
    throw new Error('No ready templates available');
  }

  // Determine frames to run from config
  let framesToRun = NARRATIVE_FRAMES;
  if (config.default_narrative_frames) {
    try {
      const enabledIds = JSON.parse(config.default_narrative_frames);
      const filtered = NARRATIVE_FRAMES.filter(f => enabledIds.includes(f.id));
      if (filtered.length >= 1) framesToRun = filtered;
    } catch {}
  }
  if (Array.isArray(frameIds) && frameIds.length > 0) {
    const requested = new Set(frameIds.map((id) => String(id || '').trim()).filter(Boolean));
    const filtered = framesToRun.filter((frame) => requested.has(frame.id));
    if (filtered.length > 0) {
      framesToRun = filtered;
    }
  }

  // Pick a random template (reuse across all frames)
  const template = readyTemplates[Math.floor(Math.random() * readyTemplates.length)];

  const project = await getProject(projectId);
  if (!project) {
    throw new Error(`Project ${projectId} not found`);
  }

  sendEvent({ type: 'progress', step: 'gauntlet_config', message: `Template: ${template.name || 'unnamed'}, threshold: ${scoreThreshold}/11, dry run: ${dryRun}` });

  // 2. Get cached image context (using getFoundationalDocs which returns content strings + latest version)
  let imageContext;
  try {
    const foundationalDocs = await getFoundationalDocs(projectId);
    imageContext = await getCachedImageContext(projectId, foundationalDocs, project);
  } catch (err) {
    console.warn('[Gauntlet] Failed to get image context:', err.message);
    imageContext = { avatarContext: '', productContext: '' };
  }

  // 3. Load product reference image
  let productImageData = null;
  if (config.use_product_reference_images !== false && project.product_image_storageId) {
    try {
      const buffer = await downloadToBuffer(project.product_image_storageId);
      productImageData = { base64: buffer.toString('base64'), mimeType: detectImageMimeType(buffer) };
    } catch (err) {
      console.warn('[Gauntlet] Failed to load product image:', err.message);
    }
  }

  // 4. Parse template structure for image slots
  let slotDefs;
  try {
    slotDefs = JSON.parse(template.slot_definitions || '[]');
  } catch {
    slotDefs = [];
  }

  const designImageSlots = slotDefs.filter(s => s.type === 'image').map((s, i) => ({
    slot_id: `image_${i + 1}`,
    location: s.description || `Section with ${s.name}`,
    description: s.description || s.name,
    suggested_size: s.suggested_size || '800x600',
    aspect_ratio: '16:9',
  }));

  // Track results per frame
  const frameResults = [];
  let cachedHtmlTemplate = null;
  let totalImagePrescoreAttempts = 0;
  const acceptedHeadlines = [];
  const historySince = new Date(Date.now() - (90 * 24 * 60 * 60 * 1000)).toISOString();
  const angleHistory = batchAngle
    ? await getRecentLPHeadlineHistoryByAngle(projectId, batchAngle, { limit: 200, since: historySince })
    : [];

  // 5. Loop through selected narrative frames
  const totalFrames = framesToRun.length;
  for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
    const frame = framesToRun[frameIndex];
    const frameNum = frameIndex + 1;
    const frameStart = Date.now();

    sendEvent({
      type: 'progress',
      step: 'gauntlet_frame_start',
      message: `LP ${frameNum} of ${totalFrames} — ${frame.name}...`,
      gauntlet: { frame: frameNum, total: totalFrames, name: frame.name },
    });

    let frameResult = {
      frame: frame.id,
      frameName: frame.name,
      lpId: null,
      publishedUrl: null,
      score: null,
      status: 'pending',
      attempts: 0,
      imagePrescoreAttempts: 0,
      durationMs: 0,
    };

    try {
      // 5a. Generate images for this frame
      sendEvent({ type: 'progress', step: 'gauntlet_images', message: `LP ${frameNum} of ${totalFrames} — Generating images...` });

      const frameAngle = frame.instruction || frame.name; // Used for image/copy gen context, NOT stored as LP angle
      const sameFrameHistory = batchAngle
        ? await getRecentLPHeadlineHistoryByAngleAndFrame(projectId, batchAngle, frame.id, { limit: 80, since: historySince })
        : [];
      let imageSlots = await generateSlotImages({
        imageSlots: designImageSlots,
        copySections: [], // No copy yet — images generated before copy
        angle: frameAngle,
        projectId,
        autoContext: {
          narrativeFrame: frame.instruction,
          productImageData,
          editorialPlan: null,
          imageContext,
        },
      }, (e) => { /* suppress sub-events */ });

      // 5b. Pre-score images
      sendEvent({ type: 'progress', step: 'gauntlet_prescore', message: `LP ${frameNum} of ${totalFrames} — Pre-scoring images...` });

      const prescoreResult = await preScoreAndRetryImages(
        imageSlots,
        frameAngle,
        { narrativeFrame: frame.instruction, productImageData, imageContext },
        projectId,
        sendEvent,
        maxImageRetries,
      );
      imageSlots = prescoreResult.imageSlots;
      frameResult.imagePrescoreAttempts = prescoreResult.totalAttempts;
      totalImagePrescoreAttempts += prescoreResult.totalAttempts;

      // 5c. Create LP record
      const lpId = uuidv4();
      frameResult.lpId = lpId;
      const lpName = `LP Batch — ${frame.name}`;

      await createLandingPage({
        id: lpId,
        project_id: projectId,
        name: lpName,
        angle: batchAngle || null, // Director-triggered batches pass the angle name; gauntlet test runs leave it null
        status: 'generating',
        auto_generated: true,
        batch_job_id: batchJobId || undefined,
        narrative_frame: frame.id,
        template_id: template.id || template.externalId,
        gauntlet_batch_id: gauntletBatchId,
        gauntlet_frame: frame.id,
        gauntlet_attempt: 1,
        gauntlet_status: 'generating',
        gauntlet_batch_started_at: batchStartedAt,
      });

      // 5d. Generate LP with pre-generated images + cached template
      sendEvent({ type: 'progress', step: 'gauntlet_generate', message: `LP ${frameNum} of ${totalFrames} — Generating copy + HTML...` });

      let lpResult;
      let attempt = 0;
      let passed = false;
      let lastScore = null;

      let headlineEvaluation = null;

      for (attempt = 1; attempt <= maxLPRetries + 1; attempt++) {
        frameResult.attempts = attempt;

        try {
          lpResult = await generateAutoLP({
            projectId,
            templateId: template.id || template.externalId,
            angle: frameAngle,
            angleBrief,
            narrativeFrame: frame.instruction,
            editorialPassEnabled: config.editorial_pass_enabled !== false,
            useProductReferenceImages: config.use_product_reference_images !== false,
            agentConfig: config,
            approvedAds,
            messageBrief,
            autoContext: {
              preGeneratedImages: imageSlots,
              cachedHtmlTemplate,
            },
            headlineConstraints: buildHeadlineConstraintBundle(frame, acceptedHeadlines, angleHistory),
          }, (e) => {
          // Forward sub-events with frame context
          if (e.type === 'progress') {
            sendEvent({ ...e, gauntlet: { frame: frameNum, total: totalFrames } });
          }
          });
        } catch (genErr) {
          console.error(`[Gauntlet] Frame ${frameNum} generation failed (attempt ${attempt}):`, genErr.message);
          const isRequiredSlotFailure = /Required template slots missing after (repair|post-process repair)/i.test(genErr.message || '');
          if (attempt > maxLPRetries || isRequiredSlotFailure) {
            const failureReason = isRequiredSlotFailure
              ? `missing_required_conversion_slots: ${genErr.message}`
              : genErr.message;
            frameResult.status = 'failed';
            frameResult.error = failureReason;
            await updateLandingPageSafely(lpId, {
              status: 'failed',
              error_message: failureReason,
              gauntlet_status: 'failed',
              gauntlet_attempt: attempt,
            }, { stage: 'generation_failure' });
            break;
          }
          continue;
        }

        // 5e. Cache HTML template from first successful frame
        if (!cachedHtmlTemplate && lpResult.htmlTemplate) {
          cachedHtmlTemplate = lpResult.htmlTemplate;
          sendEvent({ type: 'progress', step: 'gauntlet_template_cached', message: 'HTML template cached for remaining frames' });
        }

        headlineEvaluation = evaluateFrameHeadline({
          lpResult,
          frame,
          batchAngle,
          messageBrief,
          acceptedHeadlines,
          sameFrameHistory,
          angleHistory,
        });

        if (!headlineEvaluation.passed) {
          sendEvent({
            type: 'progress',
            step: 'gauntlet_headline_repair',
            message: `LP ${frameNum} of ${totalFrames} — repairing frame headline...`,
          });

          try {
            const repairedHeadline = await repairLPHeadline({
              projectId,
              angle: batchAngle || frameAngle,
              narrativeFrame: frame.id,
              headline: headlineEvaluation.headline,
              subheadline: headlineEvaluation.subheadline,
              copySections: lpResult.copySections,
              approvedAds,
              messageBrief,
              headlineConstraints: buildHeadlineConstraintBundle(frame, acceptedHeadlines, angleHistory),
            });
            lpResult = await rebuildLPAfterHeadlineRepair(lpResult, repairedHeadline, {
              project,
              agentConfig: config,
              angle: batchAngle || frameAngle,
            });
            headlineEvaluation = evaluateFrameHeadline({
              lpResult,
              frame,
              batchAngle,
              messageBrief,
              acceptedHeadlines,
              sameFrameHistory,
              angleHistory,
            });
          } catch (repairErr) {
            console.warn(`[Gauntlet] Headline repair failed for frame ${frameNum}:`, repairErr.message);
          }
        }

        if (!headlineEvaluation.passed && (headlineEvaluation.frameBlueprint?.passed === false || headlineEvaluation.sourceAlignment?.passed === false)) {
          const repairFocus = frame.id === 'mechanism'
            ? (/why alternatives fail/i.test(headlineEvaluation.frameBlueprint?.reason || '')
                ? 'mechanism_alternatives_fail'
                : (!headlineEvaluation.sourceAlignment?.passed ? 'mechanism_source_alignment' : null))
            : null;

          sendEvent({
            type: 'progress',
            step: 'gauntlet_content_repair',
            message: `LP ${frameNum} of ${totalFrames} — repairing frame/content alignment...`,
          });

          try {
            const repairedContent = await repairLPContentAlignment({
              projectId,
              angle: batchAngle || frameAngle,
              narrativeFrame: frame.id,
              copySections: lpResult.copySections,
              approvedAds,
              messageBrief,
              headlineConstraints: buildHeadlineConstraintBundle(frame, acceptedHeadlines, angleHistory),
              repairFocus,
            });
            lpResult = await rebuildLPAfterContentRepair(lpResult, repairedContent.sections, {
              project,
              agentConfig: config,
              angle: batchAngle || frameAngle,
            });
            headlineEvaluation = evaluateFrameHeadline({
              lpResult,
              frame,
              batchAngle,
              messageBrief,
              acceptedHeadlines,
              sameFrameHistory,
              angleHistory,
            });
          } catch (repairErr) {
            console.warn(`[Gauntlet] Content repair failed for frame ${frameNum}:`, repairErr.message);
          }
        }

        if (!headlineEvaluation.passed) {
          const headlineFailureReason = [
            headlineEvaluation.frameAlignment.passed ? null : headlineEvaluation.frameAlignment.reason,
            headlineEvaluation.frameBlueprint.passed ? null : headlineEvaluation.frameBlueprint.reason,
            headlineEvaluation.uniqueness.passed ? null : headlineEvaluation.uniqueness.reason,
            headlineEvaluation.sourceAlignment.passed ? null : headlineEvaluation.sourceAlignment.reason,
            headlineEvaluation.history.passed ? null : headlineEvaluation.history.reason,
          ].find(Boolean);

          await updateLandingPageSafely(lpId, {
            status: 'failed',
            error_message: headlineFailureReason,
            headline_text: headlineEvaluation.headline || undefined,
            subheadline_text: headlineEvaluation.subheadline || undefined,
            headline_frame_alignment_status: headlineEvaluation.frameAlignment.passed ? 'passed' : 'failed',
            headline_frame_alignment_reason: headlineEvaluation.frameAlignment.reason,
            frame_blueprint_status: headlineEvaluation.frameBlueprint.passed ? 'passed' : 'failed',
            frame_blueprint_reason: headlineEvaluation.frameBlueprint.reason,
            headline_uniqueness_status: headlineEvaluation.uniqueness.passed ? 'passed' : 'failed',
            headline_uniqueness_reason: headlineEvaluation.uniqueness.reason,
            headline_duplicate_of_lp_id: headlineEvaluation.uniqueness.duplicateOf || undefined,
            title_family_uniqueness_status: headlineEvaluation.titleFamilyUniqueness.passed ? 'passed' : 'failed',
            title_family_uniqueness_reason: headlineEvaluation.titleFamilyUniqueness.reason,
            headline_history_status: headlineEvaluation.history.passed ? 'passed' : 'failed',
            headline_history_reason: headlineEvaluation.history.reason,
            headline_signature: headlineEvaluation.headline_signature || undefined,
            gauntlet_attempt: attempt,
            gauntlet_status: 'failed',
            gauntlet_retry_type: 'headline',
          }, { stage: 'headline_validation_failure' });

          if (attempt > maxLPRetries) {
            frameResult.status = 'headline_failed';
            frameResult.error = headlineFailureReason;
            break;
          }

          sendEvent({
            type: 'progress',
            step: 'gauntlet_full_retry',
            message: `LP ${frameNum} of ${totalFrames} — headline failed frame/history checks, regenerating...`,
          });
          continue;
        }

        // Save LP content + generate slug
        const lpSlugSource = extractHeadlineForSlug({
          copy_sections: JSON.stringify(lpResult.copySections),
          angle: frameAngle,
          name: lpName,
        });
        const lpSlug = generateSlug(lpSlugSource);

        await updateLandingPageSafely(
          lpId,
          buildGauntletDraftFields({
            headlineEvaluation,
            attempt,
            lpSlug,
          }),
          { stage: 'store_generated_lp' }
        );

        // 5f. Score the LP
        sendEvent({ type: 'progress', step: 'gauntlet_scoring', message: `LP ${frameNum} of ${totalFrames} — Scoring...` });

        let scoreResult;
        try {
          scoreResult = await scoreGauntletLP(lpResult.assembledHtml, projectId, imageContext, { angle: frameAngle, narrativeFrame: frame.id, productImageData });
          lastScore = scoreResult;
        } catch (scoreErr) {
          console.error(`[Gauntlet] Scoring failed for frame ${frameNum}:`, scoreErr.message);
          // Can't score — treat as passed to avoid waste
          passed = true;
          frameResult.score = null;
          frameResult.status = 'score_error';
          break;
        }

        frameResult.score = scoreResult.score;
        const hasFatalFlaws = scoreResult.fatal_flaws && scoreResult.fatal_flaws.length > 0;

        sendEvent({
          type: 'progress',
          step: 'gauntlet_score_result',
          message: `LP ${frameNum} of ${totalFrames} — Score ${scoreResult.score}/11${hasFatalFlaws ? ` (${scoreResult.fatal_flaws.length} fatal flaw${scoreResult.fatal_flaws.length > 1 ? 's' : ''})` : ''}`,
        });

        // Check pass
        if (scoreResult.score >= scoreThreshold && !hasFatalFlaws) {
          passed = true;
          frameResult.status = 'passed';
          break;
        }

        // 5g. Try targeted image regeneration for image-related fatal flaws
        if (hasFatalFlaws) {
          const imageFlaws = scoreResult.fatal_flaws.filter(f =>
            f.type === 'wrong_product_image' || f.type === 'ai_text_in_image'
          );

          if (imageFlaws.length > 0 && attempt <= maxLPRetries) {
            sendEvent({ type: 'progress', step: 'gauntlet_image_retry', message: `LP ${frameNum} of ${totalFrames} — Regenerating ${imageFlaws.length} flagged image(s)...` });

            const { html: fixedHtml, regeneratedCount } = await regenerateFailedImages(
              lpResult.assembledHtml,
              scoreResult.fatal_flaws,
              lpResult.imageSlots || imageSlots,
              { angle: frameAngle, productImageData, imageContext },
              projectId,
              sendEvent,
            );

            if (regeneratedCount > 0) {
              lpResult.assembledHtml = fixedHtml;
              await updateLandingPageSafely(lpId, {
                assembled_html: fixedHtml,
                gauntlet_retry_type: 'image',
                gauntlet_attempt: attempt + 1,
              }, { stage: 'store_regenerated_images' });

              // Re-score after image fix
              try {
                const rescore = await scoreGauntletLP(fixedHtml, projectId, imageContext, { angle: frameAngle, narrativeFrame: frame.id, productImageData });
                lastScore = rescore;
                frameResult.score = rescore.score;

                if (rescore.score >= scoreThreshold && (!rescore.fatal_flaws || rescore.fatal_flaws.length === 0)) {
                  passed = true;
                  frameResult.status = 'passed';
                  frameResult.attempts = attempt + 0.5; // Mark as image-retry pass
                  break;
                }
              } catch {
                // Re-score failed, continue to next full attempt
              }
            }
          }
        }

        // Full retry on next iteration
        if (attempt <= maxLPRetries) {
          sendEvent({ type: 'progress', step: 'gauntlet_full_retry', message: `LP ${frameNum} of ${totalFrames} — Full regeneration (attempt ${attempt + 1})...` });
          await updateLandingPageSafely(lpId, { gauntlet_retry_type: 'full' }, { stage: 'mark_full_retry' });
        }
      }

      // 5h. Final status update (include duration + QA-equivalent data for QA tab)
      const frameDurationMs = Date.now() - frameStart;
      const { qaReport: qaEquivalent, persistenceMode } = await persistGauntletScoreResult(lpId, {
        lastScore,
        passed,
        frameResult,
        frameDurationMs,
      });
      if (persistenceMode === 'minimal') {
        console.warn(`[Gauntlet] Stored compact score fallback for LP ${lpId.slice(0, 8)}`);
      }

      const finalHeadlineParts = lpResult
        ? extractLPHeadlineParts(lpResult.copySections, lpResult.editorialPlan)
        : { headline: '', subheadline: '' };
      const acceptedHeadline = {
        landing_page_id: lpId,
        narrative_frame: frame.id,
        headline_text: passed ? finalHeadlineParts.headline : null,
        headline_signature: buildLPHeadlineSignature({
          headline: finalHeadlineParts.headline,
          narrativeFrame: frame.id,
        }),
        title_family: getNarrativeFrameBlueprint(frame.id).titleFamily,
        title_focus_tokens: headlineEvaluation?.titleFamilyUniqueness?.titleFocus || [],
      };

      if (passed && acceptedHeadline.headline_text) {
        acceptedHeadlines.push(acceptedHeadline);
        if (batchAngle) {
          const historyEntry = buildLPHeadlineHistoryEntry({
            projectId,
            angleName: batchAngle,
            narrativeFrame: frame.id,
            landingPageId: lpId,
            gauntletBatchId,
            headlineText: acceptedHeadline.headline_text,
            subheadlineText: finalHeadlineParts.subheadline,
          });
          try {
            await recordLPHeadlineHistory([historyEntry]);
            angleHistory.unshift(historyEntry);
          } catch (err) {
            console.warn(`[Gauntlet] Failed to record LP headline history for frame ${frameNum}:`, err.message);
          }
        }
      }

      // 5i. Publish if passed and not dry run
      if (passed && !dryRun) {
        sendEvent({ type: 'progress', step: 'gauntlet_publishing', message: `LP ${frameNum} of ${totalFrames} — Publishing to Shopify...` });

        try {
          await updateLandingPageSafely(lpId, buildGauntletPublishFields(lpResult), {
            stage: 'store_publish_payload',
          });
          const { publishResult, smokeResult, verified } = await publishAndSmokeTest(lpId, projectId, {
            pdpUrl: config.pdp_url,
          });

          const smokeOk = !smokeResult || smokeResult.passed;
          frameResult.publishedUrl = smokeOk ? publishResult.published_url : null;
          frameResult.status = smokeOk ? 'published' : 'smoke_failed';

          sendEvent({
            type: 'progress',
            step: 'gauntlet_published',
            message: `LP ${frameNum} of ${totalFrames} — ${smokeOk ? 'Published successfully' : 'Smoke test failed'}`,
          });
        } catch (pubErr) {
          console.error(`[Gauntlet] Publish failed for frame ${frameNum}:`, pubErr.message);
          frameResult.status = 'publish_failed';
          frameResult.error = pubErr.message;
        }
      } else if (passed && dryRun) {
        frameResult.status = 'passed_dry_run';
      } else if (frameResult.status === 'pending' || frameResult.status === 'passed') {
        frameResult.status = 'failed';
      }
    } catch (err) {
      console.error(`[Gauntlet] Frame ${frameNum} error:`, err.message);
      frameResult.status = 'error';
      frameResult.error = err.message;
    }

    frameResult.durationMs = Date.now() - frameStart;
    frameResults.push(frameResult);

    sendEvent({
      type: 'progress',
      step: 'gauntlet_frame_done',
      message: `LP ${frameNum} of ${totalFrames} complete: ${frameResult.status}${frameResult.score != null ? ` (${frameResult.score}/11)` : ''}`,
      gauntlet: { frame: frameNum, total: totalFrames, result: frameResult },
    });
  }

  // 5f. Update all LPs in the batch with completion timestamp
  const batchCompletedAt = new Date().toISOString();
  for (const result of frameResults) {
    if (result.lpId) {
      try {
        await updateLandingPageSafely(result.lpId, {
          gauntlet_batch_completed_at: batchCompletedAt,
        }, { stage: 'mark_gauntlet_batch_complete' });
      } catch (err) {
        console.warn(`[Gauntlet] Failed to set batch_completed_at for LP ${result.lpId}:`, err.message);
      }
    }
  }

  // 6. Build report
  const totalDuration = Date.now() - startTime;
  const passedFrames = frameResults.filter(r => r.status === 'passed' || r.status === 'published' || r.status === 'passed_dry_run');
  const publishedFrames = frameResults.filter(r => r.publishedUrl);
  const failedFrames = frameResults.filter(r => ['failed', 'error', 'smoke_failed', 'headline_failed', 'publish_failed'].includes(r.status));
  const smokeFailedFrames = frameResults.filter((result) => result.status === 'smoke_failed');
  const headlineFailedFrames = frameResults.filter((result) => result.status === 'headline_failed');
  const avgScore = frameResults.filter(r => r.score != null).reduce((sum, r) => sum + r.score, 0) / Math.max(1, frameResults.filter(r => r.score != null).length);

  const report = {
    gauntletBatchId,
    projectId,
    dryRun,
    template: template.name || template.id || template.externalId,
    scoreThreshold,
    frames: frameResults,
    summary: {
      total: totalFrames,
      passed: passedFrames.length,
      published: publishedFrames.length,
      failed: failedFrames.length,
      smokeFailed: smokeFailedFrames.length,
      headlineFailed: headlineFailedFrames.length,
      avgScore: Math.round(avgScore * 10) / 10,
      totalImagePrescoreAttempts,
      totalDurationMs: totalDuration,
      totalDurationMin: Math.round(totalDuration / 60000 * 10) / 10,
      terminalStatus: getBatchTerminalLPStatus(frameResults),
    },
    lpUrls: publishedFrames.map(r => ({
      frame: r.frame,
      frameName: r.frameName,
      url: r.publishedUrl,
      score: r.score,
    })),
  };

  sendEvent({
    type: 'progress',
    step: 'gauntlet_complete',
    message: `Generation complete: ${passedFrames.length}/${totalFrames} passed, ${publishedFrames.length} published, avg score ${report.summary.avgScore}/11`,
  });

  // Clear in-memory progress — generation is done
  clearProgress(gauntletBatchId);

  return report;
}

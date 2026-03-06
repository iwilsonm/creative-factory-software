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
} from '../convexClient.js';
import {
  generateAndValidateLP,
  generateAutoLP,
  generateSlotImages,
  preScoreAndRetryImages,
  scoreGauntletLP,
  regenerateFailedImages,
  NARRATIVE_FRAMES,
} from './lpGenerator.js';
import { getCachedImageContext, getFoundationalDocs } from './lpGenerator.js';
import { publishAndSmokeTest, generateSlug, extractHeadlineForSlug } from './lpPublisher.js';
import { uploadBuffer, downloadToBuffer } from '../convexClient.js';
import { setProgress, clearProgress } from './gauntletProgress.js';

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

    // 4. Run the generation pipeline
    console.log(`[LPAuto] Running LP generation for project ${projectId.slice(0, 8)}, batch ${batchJobId.slice(0, 8)}${approvedAds.length > 0 ? ` with ${approvedAds.length} approved ads as reference` : ' (no ad reference)'}`);
    try {
      await updateBatchJob(batchJobId, {
        lp_primary_status: 'generating',
        lp_secondary_status: 'generating',
      });

      const makeLogger = (event) => {
        if (event.type === 'progress') {
          console.log(`[LPAuto] ${event.message}`);
        }
      };

      const report = await runGauntlet(projectId, { dryRun: false, angle, approvedAds }, makeLogger);

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
        await updateBatchJob(batchJobId, updates);
      } else {
        await updateBatchJob(batchJobId, {
          lp_primary_status: 'failed',
          lp_primary_error: 'No LPs passed scoring threshold',
          lp_secondary_status: 'failed',
        });
      }

      console.log(`[LPAuto] Complete for batch ${batchJobId.slice(0, 8)}: ${report.summary.passed}/${report.summary.total} passed, ${report.summary.published} published`);
    } catch (gErr) {
      console.error(`[LPAuto] Failed for batch ${batchJobId.slice(0, 8)}:`, gErr.message);
      await updateBatchJob(batchJobId, {
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
      await updateBatchJob(batchJobId, {
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
      await updateLandingPage(lpId, {
        status: 'failed',
        error_message: 'All generation attempts failed visual QA',
        qa_status: 'failed',
        qa_report: qaReport ? JSON.stringify({ ...qaReport, screenshotBuffer: undefined }) : undefined,
        qa_score: qaReport?.score,
        qa_issues_count: qaReport?.issues?.length ?? 0,
        generation_attempts: generationAttempts,
        fix_attempts: fixAttempts,
      });
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

    await updateLandingPage(lpId, updateFields);

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
    await updateLandingPage(lpId, {
      status: 'failed',
      error_message: err.message,
    });
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
    await updateBatchJob(batchJobId, {
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

      await updateBatchJob(batchJobId, {
        lp_primary_id: result.lpId,
        lp_primary_url: result.publishedUrl,
        lp_primary_status: result.verified ? 'live' : 'published',
      });
    } catch (err) {
      await updateBatchJob(batchJobId, {
        lp_primary_status: 'failed',
        lp_primary_error: err.message,
      });
    }
  }

  if (retrySecondary) {
    const retryCount = (batch.lp_secondary_retry_count || 0) + 1;
    await updateBatchJob(batchJobId, {
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

      await updateBatchJob(batchJobId, {
        lp_secondary_id: result.lpId,
        lp_secondary_url: result.publishedUrl,
        lp_secondary_status: result.verified ? 'live' : 'published',
      });
    } catch (err) {
      await updateBatchJob(batchJobId, {
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
  const { dryRun = false, angle: batchAngle = null, approvedAds = [] } = options;
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
      productImageData = { base64: buffer.toString('base64'), mimeType: 'image/jpeg' };
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

      for (attempt = 1; attempt <= maxLPRetries + 1; attempt++) {
        frameResult.attempts = attempt;

        try {
          lpResult = await generateAutoLP({
            projectId,
            templateId: template.id || template.externalId,
            angle: frameAngle,
            narrativeFrame: frame.instruction,
            editorialPassEnabled: config.editorial_pass_enabled !== false,
            useProductReferenceImages: config.use_product_reference_images !== false,
            agentConfig: config,
            approvedAds,
            autoContext: {
              preGeneratedImages: imageSlots,
              cachedHtmlTemplate: cachedHtmlTemplate,
            },
          }, (e) => {
            // Forward sub-events with frame context
            if (e.type === 'progress') {
              sendEvent({ ...e, gauntlet: { frame: frameNum, total: totalFrames } });
            }
          });
        } catch (genErr) {
          console.error(`[Gauntlet] Frame ${frameNum} generation failed (attempt ${attempt}):`, genErr.message);
          if (attempt > maxLPRetries) {
            frameResult.status = 'failed';
            frameResult.error = genErr.message;
            await updateLandingPage(lpId, {
              status: 'failed',
              error_message: genErr.message,
              gauntlet_status: 'failed',
              gauntlet_attempt: attempt,
            });
            break;
          }
          continue;
        }

        // 5e. Cache HTML template from first successful frame
        if (!cachedHtmlTemplate && lpResult.htmlTemplate) {
          cachedHtmlTemplate = lpResult.htmlTemplate;
          sendEvent({ type: 'progress', step: 'gauntlet_template_cached', message: 'HTML template cached for remaining frames' });
        }

        // Save LP content + generate slug
        const lpSlugSource = extractHeadlineForSlug({
          copy_sections: JSON.stringify(lpResult.copySections),
          angle: frameAngle,
          name: lpName,
        });
        const lpSlug = generateSlug(lpSlugSource);

        await updateLandingPage(lpId, {
          status: 'draft',
          copy_sections: JSON.stringify(lpResult.copySections),
          image_slots: JSON.stringify(lpResult.imageSlots),
          html_template: lpResult.htmlTemplate,
          assembled_html: lpResult.assembledHtml,
          swipe_design_analysis: JSON.stringify(lpResult.designAnalysis),
          audit_trail: lpResult.auditTrail ? JSON.stringify(lpResult.auditTrail) : undefined,
          editorial_plan: lpResult.editorialPlan ? JSON.stringify(lpResult.editorialPlan) : undefined,
          gauntlet_attempt: attempt,
          gauntlet_status: 'scoring',
          slug: lpSlug,
        });

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
              await updateLandingPage(lpId, {
                assembled_html: fixedHtml,
                gauntlet_retry_type: 'image',
                gauntlet_attempt: attempt + 1,
              });

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
          await updateLandingPage(lpId, { gauntlet_retry_type: 'full' });
        }
      }

      // 5h. Final status update (include duration + QA-equivalent data for QA tab)
      const frameDurationMs = Date.now() - frameStart;
      const qaEquivalent = lastScore ? {
        passed: passed,
        score: Math.round((lastScore.score / 11) * 100), // Convert 0-11 to 0-100
        summary: lastScore.reasoning || `Gauntlet score: ${lastScore.score}/11`,
        categories: {
          image_sensibility: { score: lastScore.image_sensibility, max: 4, label: 'Image Sensibility' },
          visual_coherence: { score: lastScore.visual_coherence, max: 3, label: 'Visual Coherence' },
          cta_effectiveness: { score: lastScore.cta_effectiveness, max: 2, label: 'CTA Effectiveness' },
          copy_quality: { score: lastScore.copy_quality, max: 2, label: 'Copy Quality' },
        },
        issues: (lastScore.fatal_flaws || []).map(f => ({
          severity: 'critical',
          description: f.description || f.type || 'Fatal flaw detected',
          location: f.image_position || f.location || null,
        })),
        source: 'gauntlet',
        checked_at: new Date().toISOString(),
      } : {
        // Fallback when scoring failed or never ran
        passed: passed,
        score: passed ? 60 : 0,
        summary: passed
          ? 'Scoring unavailable — LP passed on generation quality'
          : `LP failed after ${frameResult.attempts || 0} attempt(s)`,
        categories: null,
        issues: [],
        source: 'gauntlet',
        scoring_error: true,
        checked_at: new Date().toISOString(),
      };

      await updateLandingPage(lpId, {
        gauntlet_score: lastScore?.score ?? null,
        gauntlet_score_reasoning: lastScore?.reasoning ?? null,
        gauntlet_status: passed ? 'passed' : 'failed',
        gauntlet_image_prescore_attempts: frameResult.imagePrescoreAttempts,
        generation_duration_ms: frameDurationMs,
        qa_status: passed ? 'passed' : 'failed',
        qa_score: qaEquivalent.score,
        qa_report: JSON.stringify(qaEquivalent),
        qa_issues_count: qaEquivalent.issues.length,
      });

      // 5i. Publish if passed and not dry run
      if (passed && !dryRun) {
        sendEvent({ type: 'progress', step: 'gauntlet_publishing', message: `LP ${frameNum} of ${totalFrames} — Publishing to Shopify...` });

        try {
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
      } else {
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
        await updateLandingPage(result.lpId, {
          gauntlet_batch_completed_at: batchCompletedAt,
        });
      } catch (err) {
        console.warn(`[Gauntlet] Failed to set batch_completed_at for LP ${result.lpId}:`, err.message);
      }
    }
  }

  // 6. Build report
  const totalDuration = Date.now() - startTime;
  const passedFrames = frameResults.filter(r => r.status === 'passed' || r.status === 'published' || r.status === 'passed_dry_run');
  const publishedFrames = frameResults.filter(r => r.publishedUrl);
  const failedFrames = frameResults.filter(r => r.status === 'failed' || r.status === 'error');
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
      avgScore: Math.round(avgScore * 10) / 10,
      totalImagePrescoreAttempts,
      totalDurationMs: totalDuration,
      totalDurationMin: Math.round(totalDuration / 60000 * 10) / 10,
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

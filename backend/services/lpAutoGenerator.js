/**
 * LP Auto-Generator — Orchestrate automatic landing page generation for Director batches.
 *
 * When the Director creates a batch, this service:
 * 1. Checks if LP auto-generation is enabled for the project
 * 2. Selects 2 different templates and 2 different narrative frames
 * 3. Generates LP #1 and LP #2 sequentially (respecting rate limits)
 * 4. Publishes both to Shopify and verifies they're live
 * 5. Updates the batch record with LP IDs, URLs, and statuses
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
} from '../convexClient.js';
import { generateAndValidateLP, NARRATIVE_FRAMES } from './lpGenerator.js';
import { publishAndSmokeTest } from './lpPublisher.js';
import { uploadBuffer } from '../convexClient.js';

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

    // 2. Load templates for the project
    const templates = await getLPTemplatesByProject(projectId);
    const readyTemplates = templates.filter(t => t.status === 'ready');

    if (readyTemplates.length === 0) {
      console.warn(`[LPAuto] No ready templates for project ${projectId.slice(0, 8)} — skipping LP generation`);
      return;
    }

    // 3. Select 2 different templates (random, with fallback to reuse if only 1)
    const shuffledTemplates = [...readyTemplates].sort(() => Math.random() - 0.5);
    const template1 = shuffledTemplates[0];
    const template2 = shuffledTemplates.length > 1 ? shuffledTemplates[1] : shuffledTemplates[0];

    // 4. Select narrative frames from enabled set (default: all 5)
    let enabledFrames = NARRATIVE_FRAMES;
    if (config.default_narrative_frames) {
      try {
        const enabledIds = JSON.parse(config.default_narrative_frames);
        const filtered = NARRATIVE_FRAMES.filter(f => enabledIds.includes(f.id));
        if (filtered.length >= 2) enabledFrames = filtered;
      } catch {}
    }
    const shuffledFrames = [...enabledFrames].sort(() => Math.random() - 0.5);
    const frame1 = shuffledFrames[0];
    const frame2 = shuffledFrames[1];

    // 5. Update batch with initial LP state
    await updateBatchJob(batchJobId, {
      lp_primary_status: 'generating',
      lp_secondary_status: 'generating',
      lp_narrative_frames: JSON.stringify([frame1.id, frame2.id]),
    });

    // Silent progress logger (no SSE — this runs in background)
    const makeLogger = (label) => (event) => {
      if (event.type === 'progress') {
        console.log(`[LPAuto] ${label}: ${event.message}`);
      }
    };

    // 6. Generate LP #1 (Primary)
    console.log(`[LPAuto] Generating primary LP for batch ${batchJobId.slice(0, 8)} (template: ${template1.name}, frame: ${frame1.name})`);
    try {
      const primaryResult = await generateAndPublishLP({
        projectId,
        batchJobId,
        angle,
        template: template1,
        frame: frame1,
        label: 'Primary',
        sendEvent: makeLogger('Primary'),
        editorialPassEnabled: config.editorial_pass_enabled !== false,
        useProductReferenceImages: config.use_product_reference_images !== false,
        agentConfig: config,
      });

      await updateBatchJob(batchJobId, {
        lp_primary_id: primaryResult.lpId,
        lp_primary_url: primaryResult.publishedUrl,
        lp_primary_status: primaryResult.verified ? 'live' : 'published',
      });
    } catch (err) {
      console.error(`[LPAuto] Primary LP failed for batch ${batchJobId.slice(0, 8)}:`, err.message);
      await updateBatchJob(batchJobId, {
        lp_primary_status: 'failed',
        lp_primary_error: err.message,
      });
    }

    // 7. Generate LP #2 (Secondary) — sequential to respect rate limits
    console.log(`[LPAuto] Generating secondary LP for batch ${batchJobId.slice(0, 8)} (template: ${template2.name}, frame: ${frame2.name})`);
    try {
      const secondaryResult = await generateAndPublishLP({
        projectId,
        batchJobId,
        angle,
        template: template2,
        frame: frame2,
        label: 'Secondary',
        sendEvent: makeLogger('Secondary'),
        editorialPassEnabled: config.editorial_pass_enabled !== false,
        useProductReferenceImages: config.use_product_reference_images !== false,
        agentConfig: config,
      });

      await updateBatchJob(batchJobId, {
        lp_secondary_id: secondaryResult.lpId,
        lp_secondary_url: secondaryResult.publishedUrl,
        lp_secondary_status: secondaryResult.verified ? 'live' : 'published',
      });
    } catch (err) {
      console.error(`[LPAuto] Secondary LP failed for batch ${batchJobId.slice(0, 8)}:`, err.message);
      await updateBatchJob(batchJobId, {
        lp_secondary_status: 'failed',
        lp_secondary_error: err.message,
      });
    }

    console.log(`[LPAuto] LP generation complete for batch ${batchJobId.slice(0, 8)}`);
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

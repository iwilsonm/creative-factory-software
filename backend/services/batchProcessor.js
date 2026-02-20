import { v4 as uuidv4 } from 'uuid';
import { getClient, generateImage } from './gemini.js';
import {
  extractBrief,
  generateHeadlines,
  generateBodyCopies,
  generateImagePrompt,
  selectInspirationImage,
  selectTemplateImage,
  reviewPromptWithGuidelines,
} from './adGenerator.js';
import {
  getProject, getLatestDoc, getBatchJob, updateBatchJob,
  uploadBuffer, downloadToBuffer,
  convexClient, api
} from '../convexClient.js';
import { logGeminiCost } from './costTracker.js';
import { withRetry } from './retry.js';
// Drive upload skipped for batch images — Service Account has no storage quota.
// Images are stored in Convex storage and viewable in the UI.

/**
 * Run a batch job end-to-end.
 * Phase 1: Generate GPT-5.2 prompts (sequential, one per image)
 * Phase 2: Submit to Gemini Batch API
 *
 * Polling for completion is handled by the scheduler.
 *
 * @param {string} batchId
 * @param {(event: object) => void} [onProgress]
 */
export async function runBatch(batchId, onProgress) {
  const emit = (event) => { if (onProgress) try { onProgress(event); } catch {} };

  const batch = await getBatchJob(batchId);
  if (!batch) throw new Error('Batch job not found');
  if (!['pending'].includes(batch.status)) {
    throw new Error(`Batch is already ${batch.status}`);
  }

  const project = await getProject(batch.project_id);
  if (!project) {
    await updateBatchJob(batchId, { status: 'failed', error_message: 'Project not found.' });
    throw new Error('Project not found');
  }

  // Load foundational docs in parallel
  const [research, avatar, offer_brief, necessary_beliefs] = await Promise.all([
    getLatestDoc(batch.project_id, 'research'),
    getLatestDoc(batch.project_id, 'avatar'),
    getLatestDoc(batch.project_id, 'offer_brief'),
    getLatestDoc(batch.project_id, 'necessary_beliefs'),
  ]);
  const docs = { research, avatar, offer_brief, necessary_beliefs };

  const docCount = Object.values(docs).filter(d => d && d.content).length;
  if (docCount === 0) {
    await updateBatchJob(batchId, { status: 'failed', error_message: 'No foundational documents found. Generate docs first.' });
    throw new Error('No foundational documents found.');
  }

  try {
    // Phase 1: Generate GPT prompts
    await updateBatchJob(batchId, { status: 'generating_prompts', started_at: new Date().toISOString() });
    emit({ type: 'status', status: 'generating_prompts', message: `Generating ${batch.batch_size} prompts via GPT-5.2...` });

    const prompts = await generateBatchPrompts(batch, project, docs, onProgress);

    // Store prompts with headline/body in DB (exclude base64 image data to keep DB size reasonable)
    await updateBatchJob(batchId, {
      gpt_prompts: JSON.stringify(prompts.map(p => ({
        prompt: p.prompt,
        headline: p.headline || null,
        body_copy: p.body_copy || null,
      }))),
      status: 'submitting'
    });
    emit({ type: 'status', status: 'submitting', message: 'Submitting to Gemini Batch API...' });

    // Load product image if configured (from Convex storage)
    let productImageData = null;
    if (batch.product_image_storageId) {
      try {
        const imgBuffer = await downloadToBuffer(batch.product_image_storageId);
        productImageData = {
          base64: imgBuffer.toString('base64'),
          mimeType: 'image/png'
        };
        console.log(`[BatchProcessor] Product image loaded from Convex (${(imgBuffer.length / 1024).toFixed(0)} KB)`);
      } catch (err) {
        console.warn(`[BatchProcessor] Could not load product image from Convex: ${err.message}`);
      }
    }

    // Phase 2: Submit to Gemini Batch API
    const geminiBatchName = await submitGeminiBatch(batchId, prompts, batch.aspect_ratio, project.name, productImageData);

    await updateBatchJob(batchId, {
      gemini_batch_job: geminiBatchName,
      status: 'processing'
    });
    emit({ type: 'status', status: 'processing', message: 'Batch submitted to Gemini. Polling for completion...' });

    console.log(`[BatchProcessor] Batch ${batchId.slice(0, 8)} submitted. Gemini job: ${geminiBatchName}`);

  } catch (err) {
    const errorMsg = `Pipeline failed: ${err.message}`;
    emit({ type: 'error', error: errorMsg });
    console.error(`[BatchProcessor] Batch ${batchId.slice(0, 8)} pipeline failed:`, err.message);
    console.error(`[BatchProcessor] Stack:`, err.stack?.split('\n').slice(0, 3).join('\n'));
    // Mark batch as failed — retry the status update in case Convex is also having issues
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await updateBatchJob(batchId, { status: 'failed', error_message: errorMsg.slice(0, 500) });
        break;
      } catch (updateErr) {
        console.error(`[BatchProcessor] Failed to mark batch as failed (attempt ${attempt + 1}/3):`, updateErr.message);
        if (attempt < 2) await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
      }
    }
    throw err;
  }
}

/**
 * 4-Stage Pipeline: Generate GPT-5.2 image prompts for all images in a batch.
 *
 * Stage 0: Brief Extraction (1 API call) — condense foundational docs to angle-specific brief
 * Stage 1: Headline + Sub-Angle Generation (1 API call) — scored/ranked headlines with diversity
 * Stage 2: Body Copy Generation (N/5 API calls) — body copy in batches of 5
 * Stage 3: Image Prompt Generation (N API calls) — one per ad with locked copy + template
 *
 * Returns array of { prompt, headline, body_copy, inspirationBase64, inspirationMimeType, templateFileId } objects.
 */
async function generateBatchPrompts(batch, project, docs, onProgress) {
  const emit = (event) => { if (onProgress) try { onProgress(event); } catch {} };
  const batchId = batch.id;
  const angle = batch.angle || null;

  // ========================================
  // STAGE 0: Brief Extraction (1 API call)
  // ========================================
  emit({ type: 'prompt_progress', current: 0, total: batch.batch_size, message: 'Stage 0: Extracting angle-specific brief...' });
  await updateBatchJob(batchId, {
    pipeline_state: JSON.stringify({ stage: 0, stage_label: 'Extracting brief...' })
  });

  const briefPacket = await extractBrief(project, docs, angle);

  await updateBatchJob(batchId, {
    pipeline_state: JSON.stringify({ stage: 0, stage_label: 'Brief extracted', brief_length: briefPacket.length })
  });

  // ========================================
  // STAGE 1: Headline Generation (1 API call)
  // ========================================
  const headlineCount = Math.ceil(Math.max(batch.batch_size + 10, batch.batch_size * 1.2));
  emit({ type: 'prompt_progress', current: 0, total: batch.batch_size, message: `Stage 1: Generating ${headlineCount} headlines...` });
  await updateBatchJob(batchId, {
    pipeline_state: JSON.stringify({ stage: 1, stage_label: `Generating ${headlineCount} headlines...` })
  });

  const headlineResult = await generateHeadlines(project, briefPacket, angle, headlineCount);

  // Take the top N headlines by rank (they should already be sorted by rank/average_score)
  const topHeadlines = headlineResult.headlines.slice(0, batch.batch_size);

  console.log(`[BatchProcessor] Stage 1 complete: ${headlineResult.headlines.length} generated, top ${topHeadlines.length} selected`);
  await updateBatchJob(batchId, {
    pipeline_state: JSON.stringify({
      stage: 1,
      stage_label: `${topHeadlines.length} headlines selected`,
      headline_count: topHeadlines.length,
      sub_angle_count: (headlineResult.sub_angles || []).length,
    })
  });

  // ========================================
  // STAGE 2: Body Copy Generation (N/5 API calls)
  // ========================================
  const totalBodyBatches = Math.ceil(topHeadlines.length / 5);
  emit({ type: 'prompt_progress', current: 0, total: batch.batch_size, message: `Stage 2: Writing body copy (${totalBodyBatches} batches of 5)...` });
  await updateBatchJob(batchId, {
    pipeline_state: JSON.stringify({ stage: 2, stage_label: `Writing body copy (0/${totalBodyBatches} batches)...` })
  });

  const bodyCopies = await generateBodyCopies(project, briefPacket, topHeadlines);

  console.log(`[BatchProcessor] Stage 2 complete: ${bodyCopies.length} body copies for ${topHeadlines.length} headlines`);
  await updateBatchJob(batchId, {
    pipeline_state: JSON.stringify({
      stage: 2,
      stage_label: `${bodyCopies.length} body copies generated`,
      body_copy_count: bodyCopies.length,
    })
  });

  if (bodyCopies.length === 0) {
    throw new Error('All body copy generations failed. Check your OpenAI API key and project configuration.');
  }

  // ========================================
  // STAGE 3: Image Prompt Generation (1 per ad)
  // ========================================
  emit({ type: 'prompt_progress', current: 0, total: bodyCopies.length, message: `Stage 3: Creating image prompts (0/${bodyCopies.length})...` });
  await updateBatchJob(batchId, {
    pipeline_state: JSON.stringify({ stage: 3, stage_label: `Creating image prompts (0/${bodyCopies.length})...` })
  });

  const prompts = [];

  // Load previously used template IDs for cross-run deduplication
  let usedTemplateIds = [];
  if (batch.used_template_ids) {
    try { usedTemplateIds = JSON.parse(batch.used_template_ids); } catch {}
  }
  const newlyUsedTemplateIds = [];

  for (let i = 0; i < bodyCopies.length; i++) {
    const copy = bodyCopies[i];

    emit({
      type: 'prompt_progress',
      current: i + 1,
      total: bodyCopies.length,
      message: `Stage 3: Creating image prompt ${i + 1} of ${bodyCopies.length}...`
    });

    // Update pipeline_state for frontend polling
    if (i % 5 === 0 || i === bodyCopies.length - 1) {
      await updateBatchJob(batchId, {
        pipeline_state: JSON.stringify({ stage: 3, stage_label: `Creating image prompts (${i + 1}/${bodyCopies.length})...`, current: i + 1, total: bodyCopies.length })
      });
    }

    let success = false;
    for (let attempt = 1; attempt <= 2 && !success; attempt++) {
      try {
        // Select template image — existing logic, unchanged
        const allExcluded = [...usedTemplateIds, ...newlyUsedTemplateIds];

        // Parse multi-template arrays (if present)
        let templatePool = [];
        if (batch.template_image_ids) {
          try { templatePool.push(...JSON.parse(batch.template_image_ids).map(id => ({ type: 'uploaded', id }))); } catch {}
        }
        if (batch.inspiration_image_ids) {
          try { templatePool.push(...JSON.parse(batch.inspiration_image_ids).map(id => ({ type: 'drive', id }))); } catch {}
        }

        let imageData;
        if (templatePool.length > 0) {
          const pick = templatePool[Math.floor(Math.random() * templatePool.length)];
          if (pick.type === 'uploaded') {
            imageData = await selectTemplateImage(pick.id);
          } else {
            imageData = await selectInspirationImage(batch.project_id, pick.id);
          }
        } else if (batch.generation_mode === 'mode2' && batch.template_image_id) {
          imageData = await selectTemplateImage(batch.template_image_id);
        } else if (batch.inspiration_image_id) {
          imageData = await selectInspirationImage(batch.project_id, batch.inspiration_image_id);
        } else {
          imageData = await selectInspirationImage(batch.project_id, null, allExcluded);
        }

        // Track which template was used
        if (imageData.fileId) {
          newlyUsedTemplateIds.push(imageData.fileId);
        }

        // Stage 3: Generate image prompt with locked copy + template image
        let imagePrompt = await generateImagePrompt(
          project,
          copy.headline,
          copy.body_copy,
          copy.primary_emotion || 'curiosity',
          imageData,
          batch.aspect_ratio || '1:1'
        );

        // Apply prompt guidelines if set (uses gpt-4.1-mini, not rate-limited)
        if (project.prompt_guidelines) {
          imagePrompt = await reviewPromptWithGuidelines(imagePrompt, project.prompt_guidelines);
        }

        prompts.push({
          prompt: imagePrompt,
          headline: copy.headline,
          body_copy: copy.body_copy,
          inspirationBase64: imageData.base64,
          inspirationMimeType: imageData.mimeType,
          templateFileId: imageData.fileId || null,
        });
        success = true;

      } catch (err) {
        console.error(`[BatchProcessor] Stage 3 prompt ${i + 1} attempt ${attempt}/2 failed:`, err.message);
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 3000));
        } else {
          prompts.push(null);
        }
      }
    }

    // Small delay between GPT calls
    if (i < bodyCopies.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  // Update used_template_ids on the batch record for cross-run tracking
  if (newlyUsedTemplateIds.length > 0) {
    const updatedUsed = [...usedTemplateIds, ...newlyUsedTemplateIds];
    await updateBatchJob(batchId, { used_template_ids: JSON.stringify(updatedUsed) });
    console.log(`[BatchProcessor] Tracked ${newlyUsedTemplateIds.length} new template IDs (${updatedUsed.length} total used)`);
  }

  // Filter out failed prompts
  const validPrompts = prompts.filter(p => p !== null);
  if (validPrompts.length === 0) {
    throw new Error('All image prompt generations failed. Check your OpenAI API key and project configuration.');
  }

  console.log(`[BatchProcessor] Pipeline complete: ${validPrompts.length}/${bodyCopies.length} prompts generated successfully.`);

  // Clear pipeline_state now that all stages are done
  await updateBatchJob(batchId, {
    pipeline_state: JSON.stringify({ stage: 'complete', prompts_generated: validPrompts.length })
  });

  return validPrompts;
}

/**
 * Submit prompts to Gemini Batch API.
 * Each prompt is an object: { prompt, inspirationBase64?, inspirationMimeType? }
 */
async function submitGeminiBatch(batchId, prompts, aspectRatio, projectName, productImageData = null) {
  const ai = await getClient();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);

  // Build inline requests (with inspiration image + optional product image)
  const inlineRequests = prompts.map(promptObj => {
    const parts = [{ text: promptObj.prompt }];

    // Include inspiration image so Gemini can reference the visual style
    if (promptObj.inspirationBase64) {
      parts.push({
        inlineData: {
          data: promptObj.inspirationBase64,
          mimeType: promptObj.inspirationMimeType || 'image/jpeg'
        }
      });
    }

    // Include product image if configured
    if (productImageData) {
      parts.push({
        inlineData: {
          data: productImageData.base64,
          mimeType: productImageData.mimeType
        }
      });
    }
    return {
      contents: [{ parts, role: 'user' }],
      config: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: {
          aspectRatio: aspectRatio || '1:1',
          imageSize: '2K'
        }
      }
    };
  });

  const batchJob = await withRetry(
    () => ai.batches.create({
      model: 'gemini-3-pro-image-preview',
      src: inlineRequests,
      config: {
        displayName: `${projectName}_batch_${batchId.slice(0, 8)}_${timestamp}`
      }
    }),
    { label: '[Gemini batch create]' }
  );

  return batchJob.name;
}

/**
 * Poll a single batch job for completion.
 * Called by the scheduler's polling loop.
 *
 * @returns {'processing'|'completed'|'failed'}
 */
export async function pollBatchJob(batchId) {
  const batch = await getBatchJob(batchId);
  if (!batch) return 'failed';

  // If the batch is still in the pre-Gemini pipeline stages (generating prompts,
  // submitting, etc.) it won't have a gemini_batch_job yet — that's normal, not a failure.
  if (!batch.gemini_batch_job) {
    if (['generating_prompts', 'submitting'].includes(batch.status)) {
      return 'processing';
    }
    return 'failed';
  }

  const ai = await getClient();

  try {
    const job = await withRetry(
      () => ai.batches.get({ name: batch.gemini_batch_job }),
      { label: '[Gemini batch poll]', maxRetries: 2 }
    );

    if (job.state === 'JOB_STATE_SUCCEEDED') {
      await processBatchResults(batchId, job);
      return 'completed';
    } else if (job.state === 'JOB_STATE_FAILED' || job.state === 'JOB_STATE_EXPIRED') {
      await updateBatchJob(batchId, {
        status: 'failed',
        error_message: `Gemini batch job ${job.state.replace('JOB_STATE_', '').toLowerCase()}`
      });
      return 'failed';
    } else if (job.state === 'JOB_STATE_CANCELLED') {
      await updateBatchJob(batchId, {
        status: 'failed',
        error_message: 'Gemini batch job was cancelled'
      });
      return 'failed';
    }

    // JOB_STATE_PENDING or JOB_STATE_RUNNING — still processing
    // Store batch stats for frontend progress display
    if (job.batchStats) {
      const stats = {
        successfulCount: job.batchStats.successfulCount || 0,
        processingCount: job.batchStats.processingCount || 0,
        failedCount: job.batchStats.failedCount || 0,
        totalCount: job.batchStats.totalCount || 0
      };
      await updateBatchJob(batchId, { batch_stats: JSON.stringify(stats) });
      console.log(`[BatchProcessor] Batch ${batchId.slice(0, 8)}: ${stats.successfulCount} done, ${stats.processingCount} processing`);
    }
    return 'processing';

  } catch (err) {
    console.error(`[BatchProcessor] Poll error for ${batchId.slice(0, 8)}:`, err.message);
    // Don't change status on transient errors — retry next cycle
    return 'processing';
  }
}

/**
 * Process completed batch results: extract images, upload to Convex storage,
 * upload to Drive, create ad_creative records.
 */
async function processBatchResults(batchId, job) {
  const batch = await getBatchJob(batchId);
  if (!batch) throw new Error('Batch not found');

  const project = await getProject(batch.project_id);
  const prompts = JSON.parse(batch.gpt_prompts || '[]');

  // Get responses from the batch job
  const responses = job.dest?.inlinedResponses || [];

  // Load product image for single-image retries (if configured)
  let productImageData = null;
  if (batch.product_image_storageId) {
    try {
      const imgBuffer = await downloadToBuffer(batch.product_image_storageId);
      productImageData = { base64: imgBuffer.toString('base64'), mimeType: 'image/png' };
    } catch {}
  }

  let savedCount = 0;
  let failedCount = 0;

  for (let i = 0; i < responses.length; i++) {
    try {
      const response = responses[i];
      // Navigate the response structure — may vary by SDK version
      const parts = response?.response?.candidates?.[0]?.content?.parts
        || response?.candidates?.[0]?.content?.parts
        || [];

      let imageBuffer = null;
      let mimeType = 'image/png';
      let textResponse = '';

      for (const part of parts) {
        if (part.inlineData) {
          imageBuffer = Buffer.from(part.inlineData.data, 'base64');
          mimeType = part.inlineData.mimeType || 'image/png';
        } else if (part.text) {
          textResponse += part.text;
        }
      }

      // Get the prompt object (may be { prompt, headline, body_copy } or a legacy string)
      const promptObj = prompts[i];
      const promptText = typeof promptObj === 'string' ? promptObj : (promptObj?.prompt || null);

      // If batch response had no image, retry with direct Gemini call (1 attempt)
      if (!imageBuffer && promptText) {
        console.log(`[BatchProcessor] Batch ${batchId.slice(0, 8)}: No image in response ${i}, retrying with direct Gemini call...`);
        try {
          const retryResult = await generateImage(promptText, batch.aspect_ratio || '1:1', productImageData);
          if (retryResult && retryResult.buffer) {
            imageBuffer = retryResult.buffer;
            mimeType = retryResult.mimeType || 'image/png';
            console.log(`[BatchProcessor] Batch ${batchId.slice(0, 8)}: Retry succeeded for response ${i}`);
          }
        } catch (retryErr) {
          console.warn(`[BatchProcessor] Batch ${batchId.slice(0, 8)}: Retry failed for response ${i}: ${retryErr.message}`);
        }
      }

      if (!imageBuffer) {
        console.warn(`[BatchProcessor] Batch ${batchId.slice(0, 8)}: No image in response ${i} (after retry)`);
        failedCount++;
        continue;
      }

      // Upload image to Convex storage
      const storageId = await uploadBuffer(imageBuffer, mimeType);

      // Create ad_creative record with headline/body from pipeline (no extraction needed)
      const adId = uuidv4();
      await convexClient.mutation(api.adCreatives.create, {
        externalId: adId,
        project_id: batch.project_id,
        generation_mode: batch.generation_mode,
        angle: batch.angle || undefined,
        headline: (typeof promptObj === 'object' ? promptObj?.headline : null) || undefined,
        body_copy: (typeof promptObj === 'object' ? promptObj?.body_copy : null) || undefined,
        image_prompt: promptText || undefined,
        gpt_creative_output: promptText || undefined,
        aspect_ratio: batch.aspect_ratio,
        storageId,
        status: 'completed',
        auto_generated: true,
        template_image_id: batch.template_image_id || undefined,
      });

      savedCount++;

      // Log Gemini cost with batch discount (fire-and-forget)
      try { await logGeminiCost(batch.project_id, 1, '2K', true); } catch {}

    } catch (err) {
      console.error(`[BatchProcessor] Failed to process result ${i}:`, err.message);
      failedCount++;
    }
  }

  // Accumulate counts across runs (don't overwrite previous runs' totals)
  await updateBatchJob(batchId, {
    status: 'completed',
    completed_at: new Date().toISOString(),
    completed_count: (batch.completed_count || 0) + savedCount,
    failed_count: (batch.failed_count || 0) + failedCount,
    run_count: (batch.run_count || 0) + 1
  });

  console.log(`[BatchProcessor] Batch ${batchId.slice(0, 8)} completed: ${savedCount} saved, ${failedCount} failed (run ${(batch.run_count || 0) + 1}, total: ${(batch.completed_count || 0) + savedCount} saved).`);
  return { savedCount, failedCount };
}

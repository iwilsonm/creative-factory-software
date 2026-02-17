import { v4 as uuidv4 } from 'uuid';
import { chat, chatWithImage } from './openai.js';
import { getClient, generateImage } from './gemini.js';
import {
  buildCreativeDirectorPrompt,
  buildImageRequestText,
  selectInspirationImage,
  selectTemplateImage,
  reviewPromptWithGuidelines,
  buildAlreadyUsedContext,
  generateSubAngles,
  COPY_FRAMEWORKS
} from './adGenerator.js';
import {
  getProject, getLatestDoc, getBatchJob, updateBatchJob,
  uploadBuffer, downloadToBuffer,
  getRecentAdsForContext,
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

  // Load foundational docs
  const docs = {
    research: await getLatestDoc(batch.project_id, 'research'),
    avatar: await getLatestDoc(batch.project_id, 'avatar'),
    offer_brief: await getLatestDoc(batch.project_id, 'offer_brief'),
    necessary_beliefs: await getLatestDoc(batch.project_id, 'necessary_beliefs')
  };

  const docCount = Object.values(docs).filter(d => d && d.content).length;
  if (docCount === 0) {
    await updateBatchJob(batchId, { status: 'failed', error_message: 'No foundational documents found. Generate docs first.' });
    throw new Error('No foundational documents found.');
  }

  try {
    // Phase 1: Generate GPT prompts
    await updateBatchJob(batchId, { status: 'generating_prompts' });
    emit({ type: 'status', status: 'generating_prompts', message: `Generating ${batch.batch_size} prompts via GPT-5.2...` });

    const prompts = await generateBatchPrompts(batch, project, docs, onProgress);

    // Store text-only prompts in DB (exclude base64 image data to keep DB size reasonable)
    await updateBatchJob(batchId, { gpt_prompts: JSON.stringify(prompts.map(p => p.prompt)), status: 'submitting' });
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
    await updateBatchJob(batchId, { status: 'failed', error_message: err.message });
    emit({ type: 'error', error: err.message });
    console.error(`[BatchProcessor] Batch ${batchId.slice(0, 8)} failed:`, err.message);
    throw err;
  }
}

/**
 * Generate GPT-5.2 image prompts for all images in a batch.
 * Runs sequentially to respect rate limits.
 * Returns array of { prompt, inspirationBase64, inspirationMimeType, templateFileId } objects.
 * Each prompt is retried up to 3 times before being skipped.
 *
 * Diversity features:
 * - Sub-angle expansion: one GPT-4.1-mini call splits the parent angle into N distinct sub-angles
 * - Already-used context: DB history of recent completed ads + accumulating batch context
 * - Template dedup: excludes previously used template IDs across runs
 */
async function generateBatchPrompts(batch, project, docs, onProgress) {
  const emit = (event) => { if (onProgress) try { onProgress(event); } catch {} };
  const prompts = [];

  const creativeDirectorPrompt = buildCreativeDirectorPrompt(project, docs);

  // Use the single angle for all ads in the batch
  const currentAngle = batch.angle || null;

  // ── Diversity setup (before the loop) ──────────────────────────

  // 1. Generate sub-angles (one cheap GPT-4.1-mini call)
  let subAngles = [currentAngle];
  if (currentAngle && batch.batch_size > 1) {
    emit({ type: 'prompt_progress', current: 0, total: batch.batch_size, message: `Expanding "${currentAngle.slice(0, 40)}" into ${batch.batch_size} sub-angles...` });
    subAngles = await generateSubAngles(currentAngle, batch.batch_size, project);
  }

  // 2. Fetch DB history of recent completed ads (one Convex query)
  let recentAds = [];
  try {
    recentAds = await getRecentAdsForContext(batch.project_id, currentAngle, 10);
  } catch (err) {
    console.warn('[BatchProcessor] Could not fetch recent ads for context:', err.message);
  }

  // 3. Accumulator for prompts generated so far in THIS batch run
  const batchGeneratedPrompts = [];

  // ── End diversity setup ────────────────────────────────────────

  // Load previously used template IDs for cross-run deduplication
  let usedTemplateIds = [];
  if (batch.used_template_ids) {
    try { usedTemplateIds = JSON.parse(batch.used_template_ids); } catch {}
  }
  const newlyUsedTemplateIds = [];

  for (let i = 0; i < batch.batch_size; i++) {
    // Assign this ad's sub-angle (cycles if fewer sub-angles than batch size)
    const adSubAngle = subAngles[i % subAngles.length];
    // Assign a copy framework — round-robin through the 5 frameworks
    const copyFramework = COPY_FRAMEWORKS[i % COPY_FRAMEWORKS.length];

    emit({
      type: 'prompt_progress',
      current: i + 1,
      total: batch.batch_size,
      message: `Generating prompt ${i + 1} of ${batch.batch_size}${adSubAngle ? ` — "${adSubAngle.slice(0, 40)}"` : ''} [${copyFramework.name}]...`
    });

    let success = false;
    for (let attempt = 1; attempt <= 3 && !success; attempt++) {
      try {
        // Select image for this iteration
        // Exclude templates used in this run AND previous runs
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
          // Multi-template mode: randomly pick from the pool for this ad
          const pick = templatePool[Math.floor(Math.random() * templatePool.length)];
          if (pick.type === 'uploaded') {
            imageData = await selectTemplateImage(pick.id);
          } else {
            imageData = await selectInspirationImage(batch.project_id, pick.id);
          }
        } else if (batch.generation_mode === 'mode2' && batch.template_image_id) {
          // Legacy single uploaded template (backward compatible)
          imageData = await selectTemplateImage(batch.template_image_id);
        } else if (batch.inspiration_image_id) {
          // Legacy single drive inspiration (backward compatible)
          imageData = await selectInspirationImage(batch.project_id, batch.inspiration_image_id);
        } else {
          // Full random mode: exclude previously used templates
          imageData = await selectInspirationImage(batch.project_id, null, allExcluded);
        }

        // Track which template was used
        if (imageData.fileId) {
          newlyUsedTemplateIds.push(imageData.fileId);
        }

        // GPT-5.2 Message 1: Creative director prompt
        const messages = [{ role: 'user', content: creativeDirectorPrompt }];
        const acknowledgment = await chat(messages, 'gpt-5.2');

        // Build "already used" context — grows with each iteration
        const alreadyUsedContext = buildAlreadyUsedContext(recentAds, batchGeneratedPrompts);

        // GPT-5.2 Message 2: Image + instructions with this ad's sub-angle + copy framework
        const imageRequestText = buildImageRequestText(adSubAngle, batch.aspect_ratio, false, null, null, alreadyUsedContext, copyFramework.instruction);

        const conversationSoFar = [
          { role: 'user', content: creativeDirectorPrompt },
          { role: 'assistant', content: acknowledgment }
        ];

        let imagePrompt = await chatWithImage(
          conversationSoFar,
          imageRequestText,
          imageData.base64,
          imageData.mimeType,
          'gpt-5.2'
        );

        // Apply prompt guidelines if set
        if (project.prompt_guidelines) {
          imagePrompt = await reviewPromptWithGuidelines(imagePrompt, project.prompt_guidelines);
        }

        // Store prompt + inspiration image data for Gemini to reference
        prompts.push({
          prompt: imagePrompt,
          inspirationBase64: imageData.base64,
          inspirationMimeType: imageData.mimeType,
          templateFileId: imageData.fileId || null,
        });

        // Feed a short excerpt into the accumulator for headline dedup in next iterations
        // (buildAlreadyUsedContext caps to last 3 and wraps in quotes)
        batchGeneratedPrompts.push(imagePrompt.slice(0, 80));
        success = true;

      } catch (err) {
        console.error(`[BatchProcessor] Prompt ${i + 1} attempt ${attempt}/3 failed:`, err.message);
        if (attempt < 3) {
          await new Promise(r => setTimeout(r, 2000 * attempt)); // 2s, 4s backoff
        } else {
          // Only give up after all 3 attempts
          prompts.push(null);
        }
      }
    }

    // Delay between GPT calls to avoid rate limiting
    if (i < batch.batch_size - 1) {
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }

  // Update used_template_ids on the batch record for cross-run tracking
  if (newlyUsedTemplateIds.length > 0) {
    const updatedUsed = [...usedTemplateIds, ...newlyUsedTemplateIds];
    await updateBatchJob(batch.id, { used_template_ids: JSON.stringify(updatedUsed) });
    console.log(`[BatchProcessor] Tracked ${newlyUsedTemplateIds.length} new template IDs (${updatedUsed.length} total used)`);
  }

  // Filter out failed prompts
  const validPrompts = prompts.filter(p => p !== null);
  if (validPrompts.length === 0) {
    throw new Error('All GPT prompt generations failed. Check your OpenAI API key and project configuration.');
  }

  console.log(`[BatchProcessor] Generated ${validPrompts.length}/${batch.batch_size} prompts successfully (sub-angles: ${subAngles.length}, DB history: ${recentAds.length}, batch context items: ${batchGeneratedPrompts.length}).`);
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
  if (!batch || !batch.gemini_batch_job) return 'failed';

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

      // If batch response had no image, retry with direct Gemini call (1 attempt)
      if (!imageBuffer && prompts[i]) {
        console.log(`[BatchProcessor] Batch ${batchId.slice(0, 8)}: No image in response ${i}, retrying with direct Gemini call...`);
        try {
          const retryResult = await generateImage(prompts[i], batch.aspect_ratio || '1:1', productImageData);
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

      // Create ad_creative record
      const adId = uuidv4();
      await convexClient.mutation(api.adCreatives.create, {
        externalId: adId,
        project_id: batch.project_id,
        generation_mode: batch.generation_mode,
        angle: batch.angle || undefined,
        image_prompt: prompts[i] || undefined,
        gpt_creative_output: prompts[i] || undefined,
        aspect_ratio: batch.aspect_ratio,
        storageId,
        status: 'completed',
        auto_generated: true,
        template_image_id: batch.template_image_id || undefined,
      });

      // Drive upload skipped — Service Account has no storage quota.
      // Images are stored in Convex and viewable in the UI.

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

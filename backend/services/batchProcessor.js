import { v4 as uuidv4 } from 'uuid';
import { chat, chatWithImage } from './openai.js';
import { getClient } from './gemini.js';
import {
  buildCreativeDirectorPrompt,
  buildImageRequestText,
  selectInspirationImage,
  selectTemplateImage,
  reviewPromptWithGuidelines
} from './adGenerator.js';
import {
  getProject, getLatestDoc, getBatchJob, updateBatchJob,
  uploadBuffer, downloadToBuffer,
  convexClient, api
} from '../convexClient.js';
import { logGeminiCost } from './costTracker.js';
import { withRetry } from './retry.js';
import { uploadBufferToDrive } from '../routes/drive.js';

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

    // Store prompts in DB
    await updateBatchJob(batchId, { gpt_prompts: JSON.stringify(prompts), status: 'submitting' });
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
 */
async function generateBatchPrompts(batch, project, docs, onProgress) {
  const emit = (event) => { if (onProgress) try { onProgress(event); } catch {} };
  const prompts = [];

  const creativeDirectorPrompt = buildCreativeDirectorPrompt(project, docs);

  for (let i = 0; i < batch.batch_size; i++) {
    emit({
      type: 'prompt_progress',
      current: i + 1,
      total: batch.batch_size,
      message: `Generating prompt ${i + 1} of ${batch.batch_size}...`
    });

    try {
      // Select image for this iteration
      let imageData;
      if (batch.generation_mode === 'mode2' && batch.template_image_id) {
        // Mode 2: Use the same uploaded template for every ad
        imageData = await selectTemplateImage(batch.template_image_id);
      } else if (batch.inspiration_image_id) {
        // Mode 1 with a specific Drive template: use the same one for every ad
        imageData = await selectInspirationImage(batch.project_id, batch.inspiration_image_id);
      } else {
        // Mode 1 random: pick a different random template each time
        imageData = await selectInspirationImage(batch.project_id, null);
      }

      // GPT-5.2 Message 1: Creative director prompt
      const messages = [{ role: 'user', content: creativeDirectorPrompt }];
      const acknowledgment = await chat(messages, 'gpt-5.2');

      // GPT-5.2 Message 2: Image + instructions
      const imageRequestText = buildImageRequestText(batch.angle, batch.aspect_ratio);
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

      prompts.push(imagePrompt);

    } catch (err) {
      console.error(`[BatchProcessor] Failed to generate prompt ${i + 1}:`, err.message);
      // Skip this image but continue with the rest
      prompts.push(null);
    }

    // Delay between GPT calls to avoid rate limiting
    if (i < batch.batch_size - 1) {
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }

  // Filter out failed prompts
  const validPrompts = prompts.filter(p => p !== null);
  if (validPrompts.length === 0) {
    throw new Error('All GPT prompt generations failed. Check your OpenAI API key and project configuration.');
  }

  console.log(`[BatchProcessor] Generated ${validPrompts.length}/${batch.batch_size} prompts successfully.`);
  return validPrompts;
}

/**
 * Submit prompts to Gemini Batch API.
 */
async function submitGeminiBatch(batchId, prompts, aspectRatio, projectName, productImageData = null) {
  const ai = await getClient();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);

  // Build inline requests (with optional product image)
  const inlineRequests = prompts.map(prompt => {
    const parts = [{ text: prompt }];
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

      if (!imageBuffer) {
        console.warn(`[BatchProcessor] Batch ${batchId.slice(0, 8)}: No image in response ${i}`);
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

      // Upload to Drive
      if (project && project.drive_folder_id) {
        try {
          const ext = mimeType === 'image/jpeg' ? '.jpg' : '.png';
          const slugAngle = batch.angle
            ? batch.angle.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30)
            : 'batch';
          const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
          const driveName = `${project.name}_Batch_${slugAngle}_${i + 1}_${ts}${ext}`;
          const driveResult = await uploadBufferToDrive(imageBuffer, driveName, project.drive_folder_id, mimeType);

          await convexClient.mutation(api.adCreatives.update, {
            externalId: adId,
            drive_file_id: driveResult.fileId,
            drive_url: driveResult.webViewLink,
          });
        } catch (driveErr) {
          console.error(`[BatchProcessor] Drive upload failed for image ${i}:`, driveErr.message);
          // Non-fatal — image is still saved in Convex storage
        }
      }

      savedCount++;

      // Log Gemini cost with batch discount (fire-and-forget)
      try { await logGeminiCost(batch.project_id, 1, '2K', true); } catch {}

    } catch (err) {
      console.error(`[BatchProcessor] Failed to process result ${i}:`, err.message);
      failedCount++;
    }
  }

  await updateBatchJob(batchId, {
    status: 'completed',
    completed_at: new Date().toISOString(),
    completed_count: savedCount
  });

  console.log(`[BatchProcessor] Batch ${batchId.slice(0, 8)} completed: ${savedCount} saved, ${failedCount} failed.`);
  return { savedCount, failedCount };
}

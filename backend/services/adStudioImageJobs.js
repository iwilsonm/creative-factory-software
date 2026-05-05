import { getClient } from './gemini.js';
import { withRetry } from './retry.js';
import { logGeminiCost } from './costTracker.js';
import {
  api,
  claimAdStudioImageJob,
  convexClient,
  getActiveAdStudioImageJobs,
  getAd,
  getAdImageUrl,
  getProject,
  invalidateQueryCache,
  releaseAdStudioImageJob,
  uploadBuffer,
} from '../convexClient.js';
import { getProjectProductImage } from '../utils/adImages.js';

const GEMINI_MODEL_IDS = {
  'nano-banana-pro': 'gemini-3-pro-image-preview',
  'nano-banana-2': 'gemini-3.1-flash-image-preview',
  'gemini-3-pro': 'gemini-3-pro-image-preview',
};

const GEMINI_MODEL_LABELS = {
  'nano-banana-pro': 'Nano Banana Pro',
  'nano-banana-2': 'Nano Banana 2',
  'gemini-3-pro': 'Gemini 3 Pro',
};

const TERMINAL_FAILED_STATES = new Set([
  'JOB_STATE_FAILED',
  'JOB_STATE_EXPIRED',
  'JOB_STATE_CANCELLED',
]);

export function isDurableGeminiImageModel(imageModel) {
  return !imageModel || !!GEMINI_MODEL_IDS[imageModel];
}

function resolveGeminiModelId(imageModel) {
  return GEMINI_MODEL_IDS[imageModel] || GEMINI_MODEL_IDS['nano-banana-2'];
}

function resolveGeminiModelLabel(imageModel) {
  return GEMINI_MODEL_LABELS[imageModel] || GEMINI_MODEL_LABELS['nano-banana-2'];
}

function buildSingleImageRequest({ prompt, aspectRatio, productImage }) {
  const parts = [{ text: prompt }];
  if (productImage?.base64 && productImage?.mimeType) {
    parts.push({
      inlineData: {
        data: productImage.base64,
        mimeType: productImage.mimeType,
      },
    });
  }
  return {
    contents: [{ parts, role: 'user' }],
    config: {
      responseModalities: ['TEXT', 'IMAGE'],
      imageConfig: {
        aspectRatio: aspectRatio || '1:1',
        imageSize: '2K',
      },
    },
  };
}

function extractImageFromBatchJob(job) {
  const response = job?.dest?.inlinedResponses?.[0] || null;
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

  return { imageBuffer, mimeType, textResponse };
}

async function updateAdFailure(externalId, message, stage = 'image_generation') {
  await convexClient.mutation(api.adCreatives.update, {
    externalId,
    status: 'failed',
    error_message: message.slice(0, 500),
    failure_stage: stage,
    last_progress_at: new Date().toISOString(),
    worker_lease_owner: null,
    worker_lease_expires_at: null,
  });
  invalidateQueryCache('ad_creatives');
}

export async function submitAdStudioImageJob({
  adId,
  projectId,
  project,
  imagePrompt,
  aspectRatio = '1:1',
  productImage = null,
  imageModel,
  emit,
  modeLabel = 'Ad Studio',
}) {
  if (!isDurableGeminiImageModel(imageModel)) {
    throw new Error(`Durable Ad Studio image jobs only support Gemini image models. Received: ${imageModel || 'default'}`);
  }
  const ai = await getClient();
  const modelId = resolveGeminiModelId(imageModel);
  const modelLabel = resolveGeminiModelLabel(imageModel);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
  const request = buildSingleImageRequest({
    prompt: imagePrompt,
    aspectRatio,
    productImage,
  });

  emit?.({
    type: 'status',
    status: 'generating_image',
    message: `Submitting image generation to ${modelLabel}...`,
    progress: 70,
    adId,
  });

  const job = await withRetry(
    () => ai.batches.create({
      model: modelId,
      src: [request],
      config: {
        displayName: `${(project?.name || 'ad_studio').replace(/[^a-z0-9_-]+/gi, '_')}_${modeLabel}_${adId.slice(0, 8)}_${timestamp}`,
      },
    }),
    { label: '[Ad Studio Gemini image batch create]', maxRetries: 2 }
  );

  await convexClient.mutation(api.adCreatives.update, {
    externalId: adId,
    status: 'generating_image',
    gemini_batch_job: job.name,
    error_message: null,
    failure_stage: null,
    last_progress_at: new Date().toISOString(),
  });
  invalidateQueryCache('ad_creatives');

  emit?.({
    type: 'status',
    status: 'generating_image',
    message: `${modelLabel} is generating the image in the background...`,
    progress: 78,
    adId,
  });

  return await getAd(adId);
}

export async function pollAdStudioImageJobs(options = {}) {
  const owner = options.owner || `${options.source || 'ad-studio-image'}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  const leaseMs = options.leaseMs || 4 * 60 * 1000;
  const jobs = await getActiveAdStudioImageJobs();
  let checked = 0;
  let completed = 0;
  let failed = 0;
  let processing = 0;

  for (const job of jobs) {
    if (!job?.id) continue;
    const claim = await claimAdStudioImageJob(job.id, owner, leaseMs).catch(() => ({ claimed: false }));
    if (!claim.claimed) continue;

    checked += 1;
    try {
      const result = await pollClaimedAdStudioImageJob(job);
      if (result === 'completed') completed += 1;
      else if (result === 'failed') failed += 1;
      else processing += 1;
    } finally {
      await releaseAdStudioImageJob(job.id, owner).catch(() => {});
    }
  }

  return { checked, completed, failed, processing };
}

async function pollClaimedAdStudioImageJob(job) {
  if (!job.gemini_batch_job) {
    await updateAdFailure(
      job.id,
      'Image generation was interrupted before Gemini received the image job. Please retry this ad.',
      'image_batch_missing'
    );
    return 'failed';
  }

  const ai = await getClient();
  const batchJob = await withRetry(
    () => ai.batches.get({ name: job.gemini_batch_job }),
    { label: '[Ad Studio Gemini image batch poll]', maxRetries: 2 }
  );

  if (batchJob.state === 'JOB_STATE_SUCCEEDED') {
    const current = await getAd(job.id);
    if (current?.storageId) return 'completed';

    const { imageBuffer, mimeType } = extractImageFromBatchJob(batchJob);
    if (!imageBuffer) {
      await updateAdFailure(
        job.id,
        'Gemini finished but did not return an image. Please retry this ad.',
        'image_batch_result'
      );
      return 'failed';
    }

    const storageId = await uploadBuffer(imageBuffer, mimeType);
    await convexClient.mutation(api.adCreatives.update, {
      externalId: job.id,
      storageId,
      status: 'completed',
      error_message: null,
      failure_stage: null,
      last_progress_at: new Date().toISOString(),
      worker_lease_owner: null,
      worker_lease_expires_at: null,
    });
    invalidateQueryCache('ad_creatives');
    try { await logGeminiCost(job.project_id, 1, '2K', false, 'ad_image_generation'); } catch {}
    return 'completed';
  }

  if (TERMINAL_FAILED_STATES.has(batchJob.state)) {
    const stateLabel = String(batchJob.state || 'JOB_STATE_FAILED').replace('JOB_STATE_', '').toLowerCase();
    await updateAdFailure(job.id, `Gemini image job ${stateLabel}. Please retry this ad.`, 'image_batch_terminal');
    return 'failed';
  }

  await convexClient.mutation(api.adCreatives.update, {
    externalId: job.id,
    last_progress_at: new Date().toISOString(),
  });
  invalidateQueryCache('ad_creatives');
  return 'processing';
}

export async function repairFailedAdStudioImageJob(adId) {
  const ad = await getAd(adId);
  if (!ad) throw new Error(`Ad ${adId} not found`);
  if (ad.storageId) return { repaired: false, reason: 'already_completed', ad };
  if (!ad.image_prompt) throw new Error(`Ad ${adId} does not have a saved image prompt`);

  const project = await getProject(ad.project_id);
  if (!project) throw new Error(`Project ${ad.project_id} not found`);

  let productImage = null;
  if (project.product_image_storageId) {
    try {
      productImage = await getProjectProductImage(project);
    } catch (err) {
      console.warn(`[AdStudioImageJobs] Could not load project product image for repair ${adId}: ${err.message}`);
    }
  }

  await submitAdStudioImageJob({
    adId,
    projectId: ad.project_id,
    project,
    imagePrompt: ad.image_prompt,
    aspectRatio: ad.aspect_ratio || '1:1',
    productImage,
    imageModel: ad.image_model || 'nano-banana-2',
    modeLabel: 'repair',
  });

  return { repaired: true, adId };
}

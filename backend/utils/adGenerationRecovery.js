export function buildStaleAdRepairUpdate(ad, nowIso = new Date().toISOString()) {
  if (!isSingleAdGenerationRecoveryCandidate(ad)) {
    return null;
  }

  if (ad.status === 'generating_image' && ad.storageId) {
    return {
      status: 'completed',
      error_message: null,
      failure_stage: null,
      last_progress_at: nowIso,
      completed_at: nowIso,
    };
  }

  const isImageStage = ad.status === 'generating_image';
  return {
    status: 'failed',
    error_message: isImageStage
      ? 'Image generation timed out before an image was saved. Please retry this ad.'
      : 'Creative direction timed out before image generation started. Please retry this ad.',
    failure_stage: isImageStage ? 'stale_generating_image_timeout' : 'stale_generating_copy_timeout',
    last_progress_at: nowIso,
    completed_at: nowIso,
  };
}

export function isSingleAdGenerationRecoveryCandidate(ad) {
  if (!ad || (ad.status !== 'generating_copy' && ad.status !== 'generating_image')) {
    return false;
  }

  // Batch jobs and Creative Director rows have separate worker recovery. This
  // utility is only for live single Ad Studio requests that can be killed by
  // the request gateway.
  return !(ad.batch_job_id || ad.gemini_batch_job || ad.auto_generated);
}

export function getAdProgressTime(ad) {
  const ts = new Date(ad?.last_progress_at || ad?.created_at || '').getTime();
  return Number.isFinite(ts) ? ts : null;
}

export function buildStaleAdRepairUpdate(ad, nowIso = new Date().toISOString()) {
  if (!ad || (ad.status !== 'generating_copy' && ad.status !== 'generating_image')) {
    return null;
  }

  if (ad.status === 'generating_image' && ad.storageId) {
    return {
      status: 'completed',
      error_message: null,
      failure_stage: null,
      last_progress_at: nowIso,
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
  };
}

export function getAdProgressTime(ad) {
  const ts = new Date(ad?.last_progress_at || ad?.created_at || '').getTime();
  return Number.isFinite(ts) ? ts : null;
}

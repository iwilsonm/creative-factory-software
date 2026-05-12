const IMAGE_ATTEMPT_ERROR_CLASSES = new Set([
  'success',
  'fetch_failed',
  'timeout',
  'rate_limit',
  'api_error',
  'unknown',
  'cancelled',
  'no_image_returned',
  'billing_exhausted',
  'provider_unavailable',
  'batch_failed',
  'batch_image_rejected',
  'batch_unknown',
]);

function sanitizeAttemptMessage(message) {
  if (message === null || message === undefined || message === '') return null;
  return String(message).replace(/\s+/g, ' ').trim().slice(0, 500) || null;
}

function coerceIso(value, fallback = null) {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return fallback;
  return date.toISOString();
}

function coerceDuration(durationMs, startedAt, endedAt) {
  if (Number.isFinite(durationMs)) return Math.max(0, Math.round(durationMs));
  const start = startedAt ? new Date(startedAt).getTime() : NaN;
  const end = endedAt ? new Date(endedAt).getTime() : NaN;
  if (Number.isFinite(start) && Number.isFinite(end)) return Math.max(0, end - start);
  return null;
}

export function buildImageAttemptRecord({
  attemptNumber = 1,
  startedAt = null,
  endedAt = null,
  durationMs = undefined,
  errorClass = 'unknown',
  errorMessage = null,
  queueDepthAtStart = null,
  source = null,
} = {}) {
  const normalizedStartedAt = coerceIso(startedAt);
  const normalizedEndedAt = coerceIso(endedAt, new Date().toISOString());
  const normalizedErrorClass = IMAGE_ATTEMPT_ERROR_CLASSES.has(errorClass) ? errorClass : 'unknown';

  return {
    attempt_number: Number(attemptNumber) || 1,
    started_at: normalizedStartedAt,
    ended_at: normalizedEndedAt,
    duration_ms: coerceDuration(durationMs, normalizedStartedAt, normalizedEndedAt),
    error_class: normalizedErrorClass,
    error_message: sanitizeAttemptMessage(errorMessage),
    queue_depth_at_start: Number.isFinite(queueDepthAtStart) ? queueDepthAtStart : null,
    ...(source ? { source } : {}),
  };
}

export function serializeImageAttempts(attempts) {
  if (!Array.isArray(attempts) || attempts.length === 0) return undefined;
  return JSON.stringify(attempts.map((attempt, index) => buildImageAttemptRecord({
    attemptNumber: attempt.attempt_number ?? index + 1,
    startedAt: attempt.started_at,
    endedAt: attempt.ended_at,
    durationMs: attempt.duration_ms,
    errorClass: attempt.error_class || 'unknown',
    errorMessage: attempt.error_message ?? null,
    queueDepthAtStart: attempt.queue_depth_at_start,
    source: attempt.source || null,
  })));
}

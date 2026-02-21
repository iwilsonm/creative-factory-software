/**
 * Reusable retry wrapper with exponential backoff and rate limit awareness.
 *
 * @param {() => Promise<T>} fn - Async function to execute
 * @param {object} [options]
 * @param {number} [options.maxRetries=5] - Maximum retry attempts
 * @param {number} [options.baseDelayMs=2000] - Base delay in milliseconds
 * @param {number} [options.maxDelayMs=120000] - Maximum delay cap (2 minutes)
 * @param {(err: Error) => boolean} [options.shouldRetry] - Custom retry predicate
 * @param {string} [options.label='[Retry]'] - Logging label
 * @returns {Promise<T>}
 */
export async function withRetry(fn, options = {}) {
  const {
    maxRetries = 5,
    baseDelayMs = 2000,
    maxDelayMs = 120000,
    shouldRetry = defaultShouldRetry,
    label = '[Retry]'
  } = options;

  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // Don't retry if we've exhausted attempts
      if (attempt >= maxRetries) break;

      // Don't retry if the error isn't retryable
      if (!shouldRetry(err)) break;

      // Calculate delay — use longer delays for rate limits
      const is429 = isRateLimitError(err);
      const delay = getDelay(err, attempt, is429 ? Math.max(baseDelayMs, 15000) : baseDelayMs, maxDelayMs);

      console.warn(
        `${label} Attempt ${attempt + 1}/${maxRetries} failed: ${err.message}. ` +
        `${is429 ? '(Rate limited) ' : ''}Retrying in ${Math.round(delay / 1000)}s...`
      );

      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Check if an error is a rate limit (429) error.
 */
function isRateLimitError(err) {
  const status = err.status || err.statusCode || err.httpCode;
  if (status === 429) return true;
  if (err.code === 'rate_limit_exceeded') return true;
  if (err.type === 'rate_limit_error') return true;
  if (err.message && /rate.?limit|too many requests|quota/i.test(err.message)) return true;
  return false;
}

/**
 * Default predicate: retry on network errors, 429, and 5xx.
 * Do NOT retry on 400, 401, 403, 404.
 */
function defaultShouldRetry(err) {
  // Network / connection errors
  const networkCodes = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'FETCH_ERROR', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT'];
  if (err.code && networkCodes.includes(err.code)) return true;

  // Rate limit — always retry
  if (isRateLimitError(err)) return true;

  // HTTP status-based retry
  const status = err.status || err.statusCode || err.httpCode;
  if (status === 429) return true;       // Rate limited
  if (status >= 500) return true;        // Server error
  if (status >= 400 && status < 500) return false; // Client error — don't retry

  // If no status but looks like a network error (e.g., fetch failed)
  if (err.message && /fetch|network|socket|ECONNRESET|ETIMEDOUT/i.test(err.message)) return true;

  // Default: don't retry unknown errors
  return false;
}

/**
 * Calculate delay with exponential backoff, jitter, and Retry-After support.
 */
function getDelay(err, attempt, baseDelayMs, maxDelayMs) {
  // Check for Retry-After header (from OpenAI SDK or custom fetch wrapper)
  // The OpenAI SDK puts headers on the error object
  const retryAfter = err.headers?.get?.('retry-after') ||
                     err.headers?.['retry-after'] ||
                     err.retryAfter ||
                     err.error?.retry_after;
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (!isNaN(seconds) && seconds > 0) {
      // Add a small buffer (2s) on top of what OpenAI says
      const retryMs = (seconds + 2) * 1000;
      console.log(`  Using Retry-After header: ${seconds}s + 2s buffer = ${Math.round(retryMs / 1000)}s`);
      return Math.min(retryMs, maxDelayMs);
    }
    // Try parsing as HTTP date
    const date = new Date(retryAfter);
    if (!isNaN(date.getTime())) {
      const ms = date.getTime() - Date.now() + 2000; // +2s buffer
      if (ms > 0) return Math.min(ms, maxDelayMs);
    }
  }

  // Exponential backoff with jitter
  // For rate limits: 15s, 30s, 60s, 120s (more aggressive)
  // For other errors: 2s, 4s, 8s, 16s, 32s
  const exponential = baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * baseDelayMs * 0.5; // jitter proportional to base delay
  return Math.min(exponential + jitter, maxDelayMs);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Exported for testing
export { isRateLimitError, defaultShouldRetry, getDelay };

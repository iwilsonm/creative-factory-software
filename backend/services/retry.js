/**
 * Reusable retry wrapper with exponential backoff and rate limit awareness.
 *
 * @param {() => Promise<T>} fn - Async function to execute
 * @param {object} [options]
 * @param {number} [options.maxRetries=3] - Maximum retry attempts
 * @param {number} [options.baseDelayMs=1000] - Base delay in milliseconds
 * @param {number} [options.maxDelayMs=60000] - Maximum delay cap
 * @param {(err: Error) => boolean} [options.shouldRetry] - Custom retry predicate
 * @param {string} [options.label='[Retry]'] - Logging label
 * @returns {Promise<T>}
 */
export async function withRetry(fn, options = {}) {
  const {
    maxRetries = 3,
    baseDelayMs = 1000,
    maxDelayMs = 60000,
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

      // Calculate delay
      const delay = getDelay(err, attempt, baseDelayMs, maxDelayMs);

      console.warn(
        `${label} Attempt ${attempt + 1}/${maxRetries} failed: ${err.message}. Retrying in ${Math.round(delay)}ms...`
      );

      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Default predicate: retry on network errors, 429, and 5xx.
 * Do NOT retry on 400, 401, 403, 404.
 */
function defaultShouldRetry(err) {
  // Network / connection errors
  const networkCodes = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'FETCH_ERROR', 'ECONNREFUSED', 'UND_ERR_CONNECT_TIMEOUT'];
  if (err.code && networkCodes.includes(err.code)) return true;

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
  const retryAfter = err.headers?.['retry-after'] || err.retryAfter;
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (!isNaN(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, maxDelayMs);
    }
    // Try parsing as HTTP date
    const date = new Date(retryAfter);
    if (!isNaN(date.getTime())) {
      const ms = date.getTime() - Date.now();
      if (ms > 0) return Math.min(ms, maxDelayMs);
    }
  }

  // Exponential backoff with jitter
  const exponential = baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * 500;
  return Math.min(exponential + jitter, maxDelayMs);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

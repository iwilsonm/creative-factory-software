/**
 * Global rate limiter for OpenAI API calls.
 *
 * Problem: Each ad generation uses ~350K tokens across 3 GPT-5.2 calls.
 * With a 500K TPM limit, 2 concurrent generations blow past the limit.
 *
 * Solution: A simple async mutex/semaphore that serializes heavy GPT calls
 * so only one runs at a time. Lighter calls (gpt-4.1-mini) are not limited.
 */

export class AsyncSemaphore {
  constructor(concurrency) {
    this.concurrency = concurrency;
    this.running = 0;
    this.queue = [];
  }

  async acquire() {
    if (this.running < this.concurrency) {
      this.running++;
      return;
    }
    // Wait in queue
    return new Promise(resolve => {
      this.queue.push(resolve);
    });
  }

  release() {
    this.running--;
    if (this.queue.length > 0) {
      this.running++;
      const next = this.queue.shift();
      next();
    }
  }

  /**
   * Run a function with the semaphore acquired.
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async run(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  get pending() {
    return this.queue.length;
  }

  get active() {
    return this.running;
  }
}

// Global semaphore: allow 2 concurrent heavy GPT calls
// Each ad uses ~350K tokens across 3 sequential GPT-5.2 calls.
// With 500K TPM limit, 2 concurrent ads work because the 3 calls within each
// ad are sequential (not all 350K at once), so the actual concurrent token
// usage stays under the limit. The retry logic handles any occasional 429s.
const gptHeavySemaphore = new AsyncSemaphore(2);

// Minimum gap between heavy GPT calls (ms) to let the TPM window slide
const MIN_GAP_MS = 2000;
let lastHeavyCallEnd = 0;

/**
 * Execute a heavy GPT function (GPT-5.2 calls) with global rate limiting.
 * Up to 2 heavy calls run concurrently, with a minimum gap between new calls.
 *
 * @param {() => Promise<T>} fn - The async function to run
 * @param {string} [label] - Label for logging
 * @returns {Promise<T>}
 */
export async function withGptRateLimit(fn, label = '') {
  const queuePos = gptHeavySemaphore.pending;
  if (queuePos > 0) {
    console.log(`[RateLimiter] ${label} Queued (position ${queuePos}, ${gptHeavySemaphore.active} active)`);
  }

  return gptHeavySemaphore.run(async () => {
    // Enforce minimum gap between heavy calls
    const elapsed = Date.now() - lastHeavyCallEnd;
    if (elapsed < MIN_GAP_MS && lastHeavyCallEnd > 0) {
      const waitMs = MIN_GAP_MS - elapsed;
      console.log(`[RateLimiter] ${label} Waiting ${Math.round(waitMs / 1000)}s gap before next call...`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }

    console.log(`[RateLimiter] ${label} Starting heavy GPT call...`);
    try {
      const result = await fn();
      return result;
    } finally {
      lastHeavyCallEnd = Date.now();
      console.log(`[RateLimiter] ${label} Done. ${gptHeavySemaphore.pending} waiting in queue.`);
    }
  });
}

/**
 * Get current rate limiter stats (for debugging/monitoring).
 */
export function getRateLimiterStats() {
  return {
    activeHeavyCalls: gptHeavySemaphore.active,
    queuedHeavyCalls: gptHeavySemaphore.pending,
    lastHeavyCallEnd: lastHeavyCallEnd ? new Date(lastHeavyCallEnd).toISOString() : null,
  };
}

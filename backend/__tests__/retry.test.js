import { describe, it, expect, vi } from 'vitest';
import { withRetry, isRateLimitError, defaultShouldRetry, getDelay } from '../services/retry.js';

// ── isRateLimitError ────────────────────────────────────────────────────────

describe('isRateLimitError', () => {
  it('detects status 429', () => {
    expect(isRateLimitError({ status: 429, message: '' })).toBe(true);
  });

  it('detects statusCode 429', () => {
    expect(isRateLimitError({ statusCode: 429, message: '' })).toBe(true);
  });

  it('detects httpCode 429', () => {
    expect(isRateLimitError({ httpCode: 429, message: '' })).toBe(true);
  });

  it('detects code rate_limit_exceeded', () => {
    expect(isRateLimitError({ code: 'rate_limit_exceeded', message: '' })).toBe(true);
  });

  it('detects type rate_limit_error', () => {
    expect(isRateLimitError({ type: 'rate_limit_error', message: '' })).toBe(true);
  });

  it('detects "rate limit" in message', () => {
    expect(isRateLimitError({ message: 'Rate limit exceeded for model' })).toBe(true);
  });

  it('detects "too many requests" in message', () => {
    expect(isRateLimitError({ message: 'Too Many Requests' })).toBe(true);
  });

  it('detects "quota" in message', () => {
    expect(isRateLimitError({ message: 'Quota exceeded' })).toBe(true);
  });

  it('returns false for a normal 500 error', () => {
    expect(isRateLimitError({ status: 500, message: 'Internal server error' })).toBe(false);
  });

  it('returns false for a 400 error', () => {
    expect(isRateLimitError({ status: 400, message: 'Bad request' })).toBe(false);
  });
});

// ── defaultShouldRetry ──────────────────────────────────────────────────────

describe('defaultShouldRetry', () => {
  it('retries on ECONNRESET', () => {
    expect(defaultShouldRetry({ code: 'ECONNRESET', message: '' })).toBe(true);
  });

  it('retries on ETIMEDOUT', () => {
    expect(defaultShouldRetry({ code: 'ETIMEDOUT', message: '' })).toBe(true);
  });

  it('retries on ENOTFOUND', () => {
    expect(defaultShouldRetry({ code: 'ENOTFOUND', message: '' })).toBe(true);
  });

  it('retries on ECONNREFUSED', () => {
    expect(defaultShouldRetry({ code: 'ECONNREFUSED', message: '' })).toBe(true);
  });

  it('retries on UND_ERR_CONNECT_TIMEOUT', () => {
    expect(defaultShouldRetry({ code: 'UND_ERR_CONNECT_TIMEOUT', message: '' })).toBe(true);
  });

  it('retries on 429 status', () => {
    expect(defaultShouldRetry({ status: 429, message: '' })).toBe(true);
  });

  it('retries on 500 status', () => {
    expect(defaultShouldRetry({ status: 500, message: '' })).toBe(true);
  });

  it('retries on 503 status', () => {
    expect(defaultShouldRetry({ status: 503, message: '' })).toBe(true);
  });

  it('does NOT retry on 400', () => {
    expect(defaultShouldRetry({ status: 400, message: '' })).toBe(false);
  });

  it('does NOT retry on 401', () => {
    expect(defaultShouldRetry({ status: 401, message: '' })).toBe(false);
  });

  it('does NOT retry on 403', () => {
    expect(defaultShouldRetry({ status: 403, message: '' })).toBe(false);
  });

  it('does NOT retry on 404', () => {
    expect(defaultShouldRetry({ status: 404, message: '' })).toBe(false);
  });

  it('retries on network-like error messages', () => {
    expect(defaultShouldRetry({ message: 'fetch failed' })).toBe(true);
    expect(defaultShouldRetry({ message: 'network error' })).toBe(true);
    expect(defaultShouldRetry({ message: 'socket hang up' })).toBe(true);
  });

  it('does NOT retry unknown errors without status or network code', () => {
    expect(defaultShouldRetry({ message: 'something weird happened' })).toBe(false);
  });
});

// ── getDelay ────────────────────────────────────────────────────────────────

describe('getDelay', () => {
  it('returns exponential backoff (attempt 0 ≈ baseDelay)', () => {
    const delay = getDelay({}, 0, 2000, 120000);
    // baseDelay * 2^0 = 2000, plus jitter up to 1000
    expect(delay).toBeGreaterThanOrEqual(2000);
    expect(delay).toBeLessThanOrEqual(3000);
  });

  it('returns exponential backoff (attempt 2)', () => {
    const delay = getDelay({}, 2, 2000, 120000);
    // baseDelay * 2^2 = 8000, plus jitter up to 1000
    expect(delay).toBeGreaterThanOrEqual(8000);
    expect(delay).toBeLessThanOrEqual(9000);
  });

  it('caps at maxDelay', () => {
    const delay = getDelay({}, 10, 2000, 5000);
    expect(delay).toBeLessThanOrEqual(5000);
  });

  it('uses numeric Retry-After header (object form)', () => {
    const err = { headers: { 'retry-after': '10' } };
    const delay = getDelay(err, 0, 2000, 120000);
    // (10 + 2) * 1000 = 12000
    expect(delay).toBe(12000);
  });

  it('uses numeric Retry-After from headers.get()', () => {
    const err = { headers: { get: (key) => key === 'retry-after' ? '5' : null } };
    const delay = getDelay(err, 0, 2000, 120000);
    // (5 + 2) * 1000 = 7000
    expect(delay).toBe(7000);
  });

  it('uses retryAfter on error object', () => {
    const err = { retryAfter: '8' };
    const delay = getDelay(err, 0, 2000, 120000);
    // (8 + 2) * 1000 = 10000
    expect(delay).toBe(10000);
  });

  it('uses Retry-After date format', () => {
    const futureDate = new Date(Date.now() + 5000);
    const err = { headers: { 'retry-after': futureDate.toUTCString() } };
    const delay = getDelay(err, 0, 2000, 120000);
    // Should be ~5000 + 2000 buffer = ~7000, allow some timing slack
    expect(delay).toBeGreaterThan(4000);
    expect(delay).toBeLessThan(10000);
  });

  it('caps Retry-After at maxDelay', () => {
    const err = { headers: { 'retry-after': '300' } };
    const delay = getDelay(err, 0, 2000, 10000);
    expect(delay).toBe(10000);
  });
});

// ── withRetry ───────────────────────────────────────────────────────────────

describe('withRetry', () => {
  it('returns result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 10 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on retryable error and eventually succeeds', async () => {
    const err = new Error('fetch failed');
    const fn = vi.fn()
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err)
      .mockResolvedValue('ok');

    const result = await withRetry(fn, { maxRetries: 5, baseDelayMs: 10 });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('stops retrying on non-retryable error', async () => {
    const err = new Error('Bad request');
    err.status = 400;
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withRetry(fn, { maxRetries: 5, baseDelayMs: 10 })).rejects.toThrow('Bad request');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws after exhausting maxRetries', async () => {
    const err = new Error('Server error');
    err.status = 500;
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withRetry(fn, { maxRetries: 2, baseDelayMs: 10 })).rejects.toThrow('Server error');
    // attempt 0, 1, 2 = 3 calls total
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('uses custom shouldRetry predicate', async () => {
    const err = new Error('custom error');
    const fn = vi.fn().mockRejectedValue(err);
    const shouldRetry = vi.fn().mockReturnValue(false);

    await expect(withRetry(fn, { maxRetries: 5, baseDelayMs: 10, shouldRetry })).rejects.toThrow('custom error');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(shouldRetry).toHaveBeenCalledWith(err);
  });
});

import { describe, it, expect, vi } from 'vitest';

// Mock convexClient to avoid importing Convex generated code
vi.mock('../convexClient.js', () => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  logCost: vi.fn(),
  getCostAggregates: vi.fn(),
  getDailyCostHistory: vi.fn(),
  deleteCostsBySource: vi.fn(),
  getAllScheduledBatchesForCost: vi.fn(),
  getAllProjects: vi.fn(),
}));

import { parseGeminiImageRates, estimateRunsPerDay } from '../services/costTracker.js';

// ── parseGeminiImageRates ───────────────────────────────────────────────────

describe('parseGeminiImageRates', () => {
  it('extracts rates from HTML with Gemini 3 Pro Image section', () => {
    const html = `
      <h3>Gemini 3 Pro Image Preview</h3>
      <p>Image generation pricing:</p>
      <table>
        <tr><td>Standard</td><td>$0.134 per image</td></tr>
        <tr><td>High resolution</td><td>$0.24 per image</td></tr>
      </table>
    `;
    const rates = parseGeminiImageRates(html);
    expect(rates).not.toBeNull();
    expect(rates.rate_1k).toBe(0.134);
    expect(rates.rate_2k).toBe(0.134);
    expect(rates.rate_4k).toBe(0.24);
  });

  it('extracts rates from Image Generation section', () => {
    const html = `
      <h2>Image Generation</h2>
      <p>Pricing: $0.05 per image (standard), $0.10 per image (HD)</p>
    `;
    const rates = parseGeminiImageRates(html);
    expect(rates).not.toBeNull();
    expect(rates.rate_1k).toBe(0.05);
    expect(rates.rate_4k).toBe(0.10);
  });

  it('returns null for HTML without image pricing section', () => {
    const html = `
      <h2>Text Generation</h2>
      <p>$0.001 per 1K tokens</p>
    `;
    expect(parseGeminiImageRates(html)).toBeNull();
  });

  it('returns null for empty HTML', () => {
    expect(parseGeminiImageRates('')).toBeNull();
  });

  it('rejects prices outside valid bounds ($0.001 - $2.00)', () => {
    const html = `
      <h3>Gemini 3 Pro Image</h3>
      <p>$0.0001 per image and $18.50 per HD image</p>
    `;
    // Both prices are outside bounds, so filtered out → not enough valid prices
    expect(parseGeminiImageRates(html)).toBeNull();
  });

  it('handles Imagen 4 section name', () => {
    const html = `
      <h3>Imagen 4</h3>
      <p>$0.02 per image, $0.04 per HD image</p>
    `;
    const rates = parseGeminiImageRates(html);
    expect(rates).not.toBeNull();
    expect(rates.rate_1k).toBe(0.02);
    expect(rates.rate_4k).toBe(0.04);
  });

  it('returns null on parse error (non-string input)', () => {
    expect(parseGeminiImageRates(null)).toBeNull();
    expect(parseGeminiImageRates(undefined)).toBeNull();
  });
});

// ── estimateRunsPerDay ──────────────────────────────────────────────────────

describe('estimateRunsPerDay', () => {
  it('returns 0 for null/empty cron', () => {
    expect(estimateRunsPerDay(null)).toBe(0);
    expect(estimateRunsPerDay('')).toBe(0);
    expect(estimateRunsPerDay(undefined)).toBe(0);
  });

  it('returns 0 for invalid cron (too few parts)', () => {
    expect(estimateRunsPerDay('* *')).toBe(0);
    expect(estimateRunsPerDay('0 6')).toBe(0);
  });

  it('parses "every hour" (0 * * * *)', () => {
    expect(estimateRunsPerDay('0 * * * *')).toBe(24);
  });

  it('parses "every 6 hours" (0 */6 * * *)', () => {
    expect(estimateRunsPerDay('0 */6 * * *')).toBe(4);
  });

  it('parses "every 12 hours" (0 */12 * * *)', () => {
    expect(estimateRunsPerDay('0 */12 * * *')).toBe(2);
  });

  it('parses "once daily at 6am" (0 6 * * *)', () => {
    expect(estimateRunsPerDay('0 6 * * *')).toBe(1);
  });

  it('parses specific hours (0 6,12,18 * * *)', () => {
    expect(estimateRunsPerDay('0 6,12,18 * * *')).toBe(3);
  });

  it('parses weekdays only (0 6 * * 1-5)', () => {
    const result = estimateRunsPerDay('0 6 * * 1-5');
    // 1 run/day * 5/7 ≈ 0.714
    expect(result).toBeCloseTo(5 / 7, 2);
  });

  it('parses specific days (0 6 * * 1,3,5)', () => {
    const result = estimateRunsPerDay('0 6 * * 1,3,5');
    // 1 run/day * 3/7 ≈ 0.429
    expect(result).toBeCloseTo(3 / 7, 2);
  });

  it('parses single day of week (0 6 * * 0)', () => {
    const result = estimateRunsPerDay('0 6 * * 0');
    // 1/7 ≈ 0.143
    expect(result).toBeCloseTo(1 / 7, 2);
  });

  it('parses every 15 minutes (*/15 * * * *)', () => {
    // 24 hours * 4 runs/hour = 96
    expect(estimateRunsPerDay('*/15 * * * *')).toBe(96);
  });

  it('parses every 30 min during specific hours (*/30 6,12,18 * * *)', () => {
    // 3 hours * 2 runs/hour = 6
    expect(estimateRunsPerDay('*/30 6,12,18 * * *')).toBe(6);
  });

  it('parses every hour on weekdays (0 * * * 1-5)', () => {
    const result = estimateRunsPerDay('0 * * * 1-5');
    // 24 * 5/7 ≈ 17.14
    expect(result).toBeCloseTo(24 * 5 / 7, 1);
  });
});

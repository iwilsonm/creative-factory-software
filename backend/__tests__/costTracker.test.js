import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock convexClient to avoid importing Convex generated code
vi.mock('../convexClient.js', () => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  logCost: vi.fn(),
  getCostAggregates: vi.fn(),
  getDailyCostHistory: vi.fn(),
  getDailyCostHistoryRange: vi.fn(),
  deleteCostsBySource: vi.fn(),
  getAllScheduledBatchesForCost: vi.fn(),
  getAllProjects: vi.fn(),
  getAllConductorConfigs: vi.fn(),
  getAllLPAgentConfigs: vi.fn(),
  getCompletedDirectorBatchStats: vi.fn(),
}));

import { getSetting, logCost } from '../convexClient.js';
import { parseGeminiImageRates, estimateRunsPerDay, normalizeGeminiResolution, logGeminiCost } from '../services/costTracker.js';

beforeEach(() => {
  vi.clearAllMocks();
});

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

// ── normalizeGeminiResolution ───────────────────────────────────────────────

describe('normalizeGeminiResolution', () => {
  it('preserves supported Gemini image resolutions', () => {
    expect(normalizeGeminiResolution('1K')).toBe('1K');
    expect(normalizeGeminiResolution('2K')).toBe('2K');
    expect(normalizeGeminiResolution('4K')).toBe('4K');
  });

  it('maps legacy pixel sizes to configured rate buckets', () => {
    expect(normalizeGeminiResolution('512')).toBe('1K');
    expect(normalizeGeminiResolution('1024')).toBe('1K');
    expect(normalizeGeminiResolution('2048')).toBe('2K');
    expect(normalizeGeminiResolution('4096')).toBe('4K');
  });

  it('defaults unknown values to 2K', () => {
    expect(normalizeGeminiResolution()).toBe('2K');
    expect(normalizeGeminiResolution('')).toBe('2K');
    expect(normalizeGeminiResolution('banana')).toBe('2K');
  });
});

// ── logGeminiCost ───────────────────────────────────────────────────────────

describe('logGeminiCost', () => {
  it('uses the configured 2K Gemini rate for 2K image requests', async () => {
    vi.mocked(getSetting).mockResolvedValue('0.02');

    const record = await logGeminiCost('project-1', 1, '2K', false, 'ad_image_generation');

    expect(getSetting).toHaveBeenCalledWith('gemini_rate_2k');
    expect(logCost).toHaveBeenCalledWith(expect.objectContaining({
      project_id: 'project-1',
      service: 'gemini',
      operation: 'ad_image_generation',
      cost_usd: 0.02,
      rate_used: 0.02,
      image_count: 1,
      resolution: '2K',
    }));
    expect(record).toEqual(expect.objectContaining({ cost_usd: 0.02, resolution: '2K' }));
  });

  it('maps legacy 512 logging to the 1K Gemini rate instead of skipping', async () => {
    vi.mocked(getSetting).mockResolvedValue('0.01');

    await logGeminiCost('project-1', 1, '512', false, 'ad_image_generation');

    expect(getSetting).toHaveBeenCalledWith('gemini_rate_1k');
    expect(logCost).toHaveBeenCalledWith(expect.objectContaining({
      cost_usd: 0.01,
      resolution: '1K',
    }));
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

import { describe, it, expect, vi } from 'vitest';

// Mock modules that depend on convexClient (which needs Convex generated code)
vi.mock('../convexClient.js', () => ({
  getProject: vi.fn(),
  getLatestDoc: vi.fn(),
  uploadBuffer: vi.fn(),
  downloadToBuffer: vi.fn(),
  getInspirationImages: vi.fn(),
  getInspirationImageUrl: vi.fn(),
  getAdImageUrl: vi.fn(),
  getSetting: vi.fn(),
  convexClient: { query: vi.fn(), mutation: vi.fn() },
  api: {},
}));

vi.mock('../services/openai.js', () => ({
  chat: vi.fn(),
  chatWithImage: vi.fn(),
  chatWithImages: vi.fn(),
}));

vi.mock('../services/anthropic.js', () => ({
  chat: vi.fn(),
  chatWithImage: vi.fn(),
}));

vi.mock('../services/gemini.js', () => ({
  generateImage: vi.fn(),
}));

vi.mock('../services/costTracker.js', () => ({
  logGeminiCost: vi.fn(),
}));

vi.mock('../services/rateLimiter.js', () => ({
  withGptRateLimit: vi.fn((fn) => fn()),
  AsyncSemaphore: vi.fn(),
}));

vi.mock('sharp', () => ({
  default: vi.fn(() => ({
    resize: vi.fn().mockReturnThis(),
    jpeg: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from('fake')),
  })),
}));

import { repairJSON, buildCreativeDirectorPrompt, buildImageRequestText } from '../services/adGenerator.js';

// ── repairJSON ──────────────────────────────────────────────────────────────

describe('repairJSON', () => {
  it('parses valid JSON', () => {
    const result = repairJSON('{"key": "value"}');
    expect(result).toEqual({ key: 'value' });
  });

  it('strips markdown code fences (```json)', () => {
    const input = '```json\n{"a": 1}\n```';
    expect(repairJSON(input)).toEqual({ a: 1 });
  });

  it('strips bare markdown code fences (```)', () => {
    const input = '```\n{"b": 2}\n```';
    expect(repairJSON(input)).toEqual({ b: 2 });
  });

  it('fixes trailing commas before }', () => {
    const input = '{"a": 1, "b": 2,}';
    expect(repairJSON(input)).toEqual({ a: 1, b: 2 });
  });

  it('fixes trailing commas before ]', () => {
    const input = '{"arr": [1, 2, 3,]}';
    expect(repairJSON(input)).toEqual({ arr: [1, 2, 3] });
  });

  it('handles fences + trailing commas together', () => {
    const input = '```json\n{"items": ["a", "b",],}\n```';
    expect(repairJSON(input)).toEqual({ items: ['a', 'b'] });
  });

  it('throws on empty input', () => {
    expect(() => repairJSON('')).toThrow('Empty JSON response');
    expect(() => repairJSON('   ')).toThrow('Empty JSON response');
  });

  it('throws on null/undefined input', () => {
    expect(() => repairJSON(null)).toThrow();
    expect(() => repairJSON(undefined)).toThrow();
  });

  it('throws on completely invalid JSON', () => {
    expect(() => repairJSON('not json at all')).toThrow();
  });
});

// ── buildCreativeDirectorPrompt ─────────────────────────────────────────────

describe('buildCreativeDirectorPrompt', () => {
  const project = {
    brand_name: 'TestBrand',
    niche: 'wellness',
    product_description: 'a grounding sleep mat',
  };

  it('includes brand name and product description', () => {
    const result = buildCreativeDirectorPrompt(project, {});
    expect(result).toContain('TestBrand');
    expect(result).toContain('a grounding sleep mat');
    expect(result).toContain('wellness');
  });

  it('includes all 4 doc contents when provided', () => {
    const docs = {
      research: { content: 'RESEARCH_CONTENT_HERE' },
      avatar: { content: 'AVATAR_CONTENT_HERE' },
      offer_brief: { content: 'OFFER_CONTENT_HERE' },
      necessary_beliefs: { content: 'BELIEFS_CONTENT_HERE' },
    };
    const result = buildCreativeDirectorPrompt(project, docs);
    expect(result).toContain('RESEARCH_CONTENT_HERE');
    expect(result).toContain('AVATAR_CONTENT_HERE');
    expect(result).toContain('OFFER_CONTENT_HERE');
    expect(result).toContain('BELIEFS_CONTENT_HERE');
  });

  it('uses placeholder text for missing docs', () => {
    const result = buildCreativeDirectorPrompt(project, {});
    expect(result).toContain('[No research document available]');
    expect(result).toContain('[No avatar sheet available]');
    expect(result).toContain('[No offer brief available]');
    expect(result).toContain('[No necessary beliefs document available]');
  });

  it('handles partial docs (some present, some missing)', () => {
    const docs = {
      research: { content: 'Some research' },
      avatar: null,
      offer_brief: { content: '' },
      necessary_beliefs: undefined,
    };
    const result = buildCreativeDirectorPrompt(project, docs);
    expect(result).toContain('Some research');
    expect(result).toContain('[No avatar sheet available]');
    // Empty string is falsy → falls back to placeholder
    expect(result).toContain('[No offer brief available]');
    expect(result).toContain('[No necessary beliefs document available]');
  });
});

// ── buildImageRequestText ───────────────────────────────────────────────────

describe('buildImageRequestText', () => {
  it('returns base text with no extras', () => {
    const result = buildImageRequestText(null, '1:1', false);
    expect(result).toBe('make a prompt for an image like this');
  });

  it('appends angle instruction', () => {
    const result = buildImageRequestText('pain relief', '1:1', false);
    expect(result).toContain('The ad should focus on this angle/topic: pain relief');
  });

  it('appends aspect ratio when not 1:1', () => {
    const result = buildImageRequestText(null, '9:16', false);
    expect(result).toContain('Use 9:16 aspect ratio instead of 1:1');
  });

  it('does NOT append aspect ratio when 1:1', () => {
    const result = buildImageRequestText(null, '1:1', false);
    expect(result).not.toContain('aspect ratio');
  });

  it('appends product image instruction', () => {
    const result = buildImageRequestText(null, '1:1', true);
    expect(result).toContain('I have attached an image of the product');
  });

  it('appends headline with quotes stripped', () => {
    const result = buildImageRequestText(null, '1:1', false, '"My Headline"');
    expect(result).toContain('The ad must include this headline text exactly as written');
    expect(result).toContain('My Headline');
    // Should not have outer quotes
    expect(result).not.toContain('""');
  });

  it('appends body copy with quotes stripped', () => {
    const result = buildImageRequestText(null, '1:1', false, null, '\u201CSome body copy\u201D');
    expect(result).toContain('The ad must include this body copy text exactly as written');
    expect(result).toContain('Some body copy');
  });

  it('combines all extras', () => {
    const result = buildImageRequestText('sleep angle', '4:5', true, 'My Headline', 'Body text');
    expect(result).toContain('make a prompt for an image like this');
    expect(result).toContain('product');
    expect(result).toContain('My Headline');
    expect(result).toContain('Body text');
    expect(result).toContain('sleep angle');
    expect(result).toContain('4:5');
  });
});

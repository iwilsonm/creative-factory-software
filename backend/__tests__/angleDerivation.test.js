import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the Anthropic wrapper so the helper never hits the real API.
const mockChatWithMultipleImages = vi.fn();

vi.mock('../services/anthropic.js', () => ({
  chat: vi.fn(),
  chatWithImage: vi.fn(),
  chatWithMultipleImages: (...args) => mockChatWithMultipleImages(...args),
  extractJSON: (raw) => {
    if (typeof raw === 'object' && raw !== null) return raw;
    try { return JSON.parse(raw); } catch { return null; }
  },
}));

// Convex surface is unused in this test but the module imports it at top level.
vi.mock('../convexClient.js', () => ({
  getDocsByProject: vi.fn(),
  uploadBuffer: vi.fn(),
  getStorageUrl: vi.fn(),
  getLPTemplate: vi.fn(),
  getProject: vi.fn(),
  downloadToBuffer: vi.fn(),
  getLPAgentConfig: vi.fn(),
  upsertLPAgentConfig: vi.fn(),
  getCostAggregates: vi.fn(),
}));

// Gemini + Shopify fragment are imported at module init too.
vi.mock('../services/gemini.js', () => ({ generateImage: vi.fn() }));
vi.mock('../services/shopifyFragment.js', () => ({ convertToShopifyFragment: (x) => x }));

const baseDocs = {
  research: 'Avatar: women 55-70, chronic early-morning wakeups after bathroom trips.',
  avatar: 'Retired schoolteachers, homeowners.',
  offer_brief: 'Grounding bedsheet, 90-day trial.',
  necessary_beliefs: 'Sleep restoration is a daily need, not a luxury.',
};

const validBrief = {
  listicle_promise: '7 reasons you bolt awake at 3am (and the sheet that fixes it)',
  pain_point: 'Waking up at 3am after a bathroom trip and never falling back asleep.',
  desired_outcome: 'Sleep through the night uninterrupted.',
  installed_beliefs: ['Sleep loss is a body-system problem, not a willpower problem.'],
  removed_objections: ['Grounding sheets are a gimmick.'],
  tone_hint: 'warm maternal authority',
};

const fixtureImages = [
  { buffer: Buffer.from('jpeg-1'), mimeType: 'image/jpeg', storageUrl: 'https://convex/1' },
  { buffer: Buffer.from('jpeg-2'), mimeType: 'image/jpeg', storageUrl: 'https://convex/2' },
];

describe('deriveListicleAngleFromImages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws AngleDerivationError when no images are provided', async () => {
    const { deriveListicleAngleFromImages, AngleDerivationError } = await import('../services/lpGenerator.js');
    await expect(deriveListicleAngleFromImages([], baseDocs, 'proj-1'))
      .rejects.toBeInstanceOf(AngleDerivationError);
    expect(mockChatWithMultipleImages).not.toHaveBeenCalled();
  });

  it('returns the derived brief when Claude responds with a valid object', async () => {
    mockChatWithMultipleImages.mockResolvedValueOnce(validBrief);
    const { deriveListicleAngleFromImages } = await import('../services/lpGenerator.js');
    const brief = await deriveListicleAngleFromImages(fixtureImages, baseDocs, 'proj-1');
    expect(brief.listicle_promise).toBe(validBrief.listicle_promise);
    expect(brief.installed_beliefs).toEqual(validBrief.installed_beliefs);
    expect(brief.removed_objections).toEqual(validBrief.removed_objections);
    expect(brief.tone_hint).toBe('warm maternal authority');
  });

  it('accepts a stringified JSON response too', async () => {
    mockChatWithMultipleImages.mockResolvedValueOnce(JSON.stringify(validBrief));
    const { deriveListicleAngleFromImages } = await import('../services/lpGenerator.js');
    const brief = await deriveListicleAngleFromImages(fixtureImages, baseDocs, 'proj-1');
    expect(brief.listicle_promise).toBe(validBrief.listicle_promise);
  });

  it('caps the images sent to Claude at 5', async () => {
    mockChatWithMultipleImages.mockResolvedValueOnce(validBrief);
    const tenImages = Array.from({ length: 10 }, (_, i) => ({
      buffer: Buffer.from(`jpeg-${i}`),
      mimeType: 'image/jpeg',
      storageUrl: `https://convex/${i}`,
    }));
    const { deriveListicleAngleFromImages } = await import('../services/lpGenerator.js');
    await deriveListicleAngleFromImages(tenImages, baseDocs, 'proj-1');
    // Fourth positional arg to chatWithMultipleImages is `images`. Trim to 5.
    const [, , imagesSent] = mockChatWithMultipleImages.mock.calls[0];
    expect(imagesSent).toHaveLength(5);
  });

  it('throws AngleDerivationError with reason=contradictory_docs when Claude flags a conflict', async () => {
    mockChatWithMultipleImages.mockResolvedValueOnce({
      error: 'contradictory_docs',
      detail: 'Images show a 25-year-old male; avatar is women 55-70.',
    });
    const { deriveListicleAngleFromImages, AngleDerivationError } = await import('../services/lpGenerator.js');
    await expect(deriveListicleAngleFromImages(fixtureImages, baseDocs, 'proj-1'))
      .rejects.toMatchObject({
        name: 'AngleDerivationError',
        reason: 'contradictory_docs',
      });
    try {
      await deriveListicleAngleFromImages(fixtureImages, baseDocs, 'proj-1');
    } catch (err) {
      expect(err).toBeInstanceOf(AngleDerivationError);
    }
  });

  it('throws AngleDerivationError with reason=invalid_shape when required fields are missing', async () => {
    mockChatWithMultipleImages.mockResolvedValueOnce({
      listicle_promise: '7 reasons ...',
      // missing pain_point + desired_outcome
      installed_beliefs: [],
      removed_objections: [],
      tone_hint: 'plain',
    });
    const { deriveListicleAngleFromImages } = await import('../services/lpGenerator.js');
    await expect(deriveListicleAngleFromImages(fixtureImages, baseDocs, 'proj-1'))
      .rejects.toMatchObject({ name: 'AngleDerivationError', reason: 'invalid_shape' });
  });

  it('throws AngleDerivationError with reason=bad_json when the response is garbage', async () => {
    mockChatWithMultipleImages.mockResolvedValueOnce('<h1>hi</h1> not json');
    const { deriveListicleAngleFromImages } = await import('../services/lpGenerator.js');
    await expect(deriveListicleAngleFromImages(fixtureImages, baseDocs, 'proj-1'))
      .rejects.toMatchObject({ name: 'AngleDerivationError', reason: 'bad_json' });
  });

  it('wraps LLM-call failures as AngleDerivationError(reason=llm_error)', async () => {
    mockChatWithMultipleImages.mockRejectedValueOnce(new Error('timed out'));
    const { deriveListicleAngleFromImages } = await import('../services/lpGenerator.js');
    await expect(deriveListicleAngleFromImages(fixtureImages, baseDocs, 'proj-1'))
      .rejects.toMatchObject({ name: 'AngleDerivationError', reason: 'llm_error' });
  });

  it('coerces non-array installed_beliefs/removed_objections to []', async () => {
    mockChatWithMultipleImages.mockResolvedValueOnce({
      ...validBrief,
      installed_beliefs: 'not an array',
      removed_objections: null,
    });
    const { deriveListicleAngleFromImages } = await import('../services/lpGenerator.js');
    const brief = await deriveListicleAngleFromImages(fixtureImages, baseDocs, 'proj-1');
    expect(brief.installed_beliefs).toEqual([]);
    expect(brief.removed_objections).toEqual([]);
  });

  it('base64-encodes image buffers before sending to Claude', async () => {
    mockChatWithMultipleImages.mockResolvedValueOnce(validBrief);
    const { deriveListicleAngleFromImages } = await import('../services/lpGenerator.js');
    await deriveListicleAngleFromImages([fixtureImages[0]], baseDocs, 'proj-1');
    const [, , imagesSent] = mockChatWithMultipleImages.mock.calls[0];
    expect(imagesSent[0].data).toBe(Buffer.from('jpeg-1').toString('base64'));
    expect(imagesSent[0].mimeType).toBe('image/jpeg');
  });
});

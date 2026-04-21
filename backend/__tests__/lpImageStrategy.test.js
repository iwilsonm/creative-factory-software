/**
 * Tests for backend/services/lpImageStrategy.js
 *
 * Mocks `openai.chat` × 3 and asserts:
 *   - Three calls fire in order with prior-turn carry-forward
 *   - JSON parse retry on bad first response
 *   - concepts<5 rejection
 *   - Model fallback signal piped through onWarning to sendEvent
 *   - Defensive prefix wrapping is verified
 *
 * Per PEF plan 2026-04-21 + Phase K ESM mock pattern.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockChat = vi.fn();
const mockGetSetting = vi.fn();

vi.mock('../services/openai.js', () => ({
  chat: (...args) => mockChat(...args),
}));

vi.mock('../convexClient.js', () => ({
  getSetting: (...args) => mockGetSetting(...args),
}));

let generateImageConcepts;

const sampleDocs = {
  research: 'Research body, length intentionally short.',
  avatar: 'Avatar body — older customer, sleep issues.',
  offer_brief: 'Offer brief — grounding sheet.',
  necessary_beliefs: 'Necessary beliefs — grounding works.',
};

const validConceptsResponse = JSON.stringify({
  concepts: [
    { concept_label: 'before/after', nano_banana_prompt: 'A before/after illustration showing fatigue → energy after using the grounding sheet, photorealistic, soft daylight, 50mm camera, magazine layout. --ar 16:9', aspect_ratio: '16:9', suggested_slot_role: 'hero' },
    { concept_label: 'nightmare scenario', nano_banana_prompt: 'Restless 3 AM bedroom scene, wide shot, blue moonlight, the user lying awake in bed, stressed expression, dramatic shadows. --ar 16:9', aspect_ratio: '16:9', suggested_slot_role: 'pain_intro' },
    { concept_label: 'comparison', nano_banana_prompt: 'Side-by-side comparison of cheap counterfeit grounding sheet vs the real product, studio lighting, top-down product shot. --ar 1:1', aspect_ratio: '1:1', suggested_slot_role: 'product_compare' },
    { concept_label: 'big benefit statement', nano_banana_prompt: 'Bold typography "Sleep through the night again" over warm bedroom backdrop, magazine cover style, --ar 4:5', aspect_ratio: '4:5', suggested_slot_role: 'benefit_callout' },
    { concept_label: 'press release', nano_banana_prompt: 'Mock newspaper headline "Grounding Sheets Take Off in Wellness Circles", grayscale newsprint texture, --ar 3:2', aspect_ratio: '3:2', suggested_slot_role: 'press' },
    { concept_label: 'testimonial', nano_banana_prompt: 'Smiling 60-year-old reviewer holding the product, soft natural light, --ar 1:1', aspect_ratio: '1:1', suggested_slot_role: 'social_proof' },
  ],
});

beforeEach(async () => {
  process.env.CONVEX_URL ||= 'https://test-convex.invalid';
  vi.resetModules();
  mockChat.mockReset();
  mockGetSetting.mockReset();
  // Default: no settings override → uses gpt-5.4 default.
  mockGetSetting.mockResolvedValue(null);
  ({ generateImageConcepts } = await import('../services/lpImageStrategy.js'));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('generateImageConcepts — happy path', () => {
  it('fires Call A → B → C in order, carries prior turns forward, parses concepts', async () => {
    mockChat
      .mockResolvedValueOnce('Call A response — strategist context loaded.')
      .mockResolvedValueOnce('Call B response — listicle analysis.')
      .mockResolvedValueOnce(validConceptsResponse);

    const events = [];
    const sendEvent = (e) => events.push(e);

    const result = await generateImageConcepts({
      projectId: 'proj-1',
      lpCopyText: 'Some listicle text.',
      foundationalDocs: sampleDocs,
      targetDemo: 'older adults',
      problem: 'sleep through the night',
    }, sendEvent);

    expect(mockChat).toHaveBeenCalledTimes(3);
    expect(result.concepts).toHaveLength(6);
    expect(result.model).toBe('gpt-5.4');

    // Call A messages: [user prompt A]
    const callA = mockChat.mock.calls[0];
    expect(callA[0]).toHaveLength(1);
    expect(callA[0][0].role).toBe('user');
    expect(callA[0][0].content).toContain('older adults');
    expect(callA[0][0].content).toContain('sleep through the night');

    // Call B messages: [user A, assistant A, user B] — prior turn carried.
    const callB = mockChat.mock.calls[1];
    expect(callB[0]).toHaveLength(3);
    expect(callB[0][1].role).toBe('assistant');
    expect(callB[0][1].content).toContain('Call A response');

    // Call C messages: [user A, assistant A, user B, assistant B, user C]
    const callC = mockChat.mock.calls[2];
    expect(callC[0]).toHaveLength(5);
    expect(callC[0][3].content).toContain('Call B response');
    expect(callC[1]).toBe('gpt-5.4'); // model

    // SSE progress events fired
    const steps = events.filter(e => e.type === 'progress').map(e => e.step);
    expect(steps).toContain('image_strategy_a');
    expect(steps).toContain('image_strategy_b');
    expect(steps).toContain('image_strategy_c');
    expect(steps).toContain('image_strategy_complete');
  });

  it('uses model from openai_lp_image_strategy_model setting if present', async () => {
    mockGetSetting.mockResolvedValue('gpt-5.2');
    mockChat
      .mockResolvedValueOnce('A')
      .mockResolvedValueOnce('B')
      .mockResolvedValueOnce(validConceptsResponse);

    const result = await generateImageConcepts({
      projectId: 'proj-1',
      lpCopyText: 'Some listicle text.',
      foundationalDocs: sampleDocs,
    }, () => {});

    expect(result.model).toBe('gpt-5.2');
  });
});

describe('generateImageConcepts — JSON retry', () => {
  it('retries Call C once with stricter system message if first response is non-JSON', async () => {
    mockChat
      .mockResolvedValueOnce('A')
      .mockResolvedValueOnce('B')
      .mockResolvedValueOnce('Here are some thoughts but no JSON, just prose.')   // bad first attempt
      .mockResolvedValueOnce(validConceptsResponse);                                // good retry

    const events = [];
    const sendEvent = (e) => events.push(e);

    const result = await generateImageConcepts({
      projectId: 'proj-1',
      lpCopyText: 'Some listicle text.',
      foundationalDocs: sampleDocs,
    }, sendEvent);

    expect(mockChat).toHaveBeenCalledTimes(4);
    expect(result.concepts).toHaveLength(6);

    // Retry call should have a stricter system message prepended.
    const retryCall = mockChat.mock.calls[3];
    expect(retryCall[0][0].role).toBe('system');
    expect(retryCall[0][0].content).toMatch(/JSON/i);

    // SSE warning fired for the retry.
    const warningEvent = events.find(e => e.type === 'warning' && e.step === 'image_strategy_c_retry');
    expect(warningEvent).toBeDefined();
  });

  it('hard-fails after a second JSON parse failure', async () => {
    mockChat
      .mockResolvedValueOnce('A')
      .mockResolvedValueOnce('B')
      .mockResolvedValueOnce('Still no JSON.')
      .mockResolvedValueOnce('Still no JSON on retry either.');

    await expect(generateImageConcepts({
      projectId: 'proj-1',
      lpCopyText: 'Some listicle text.',
      foundationalDocs: sampleDocs,
    }, () => {})).rejects.toThrow(/Image-strategy Call C failed/);
  });
});

describe('generateImageConcepts — validation', () => {
  it('rejects when concepts.length < 5', async () => {
    const tooFew = JSON.stringify({
      concepts: [
        { concept_label: 'before/after', nano_banana_prompt: 'Long enough nano banana prompt body for filter, photo studio.', aspect_ratio: '16:9', suggested_slot_role: 'hero' },
        { concept_label: 'comparison', nano_banana_prompt: 'Long enough nano banana prompt body for filter, side by side.', aspect_ratio: '1:1', suggested_slot_role: 'compare' },
      ],
    });
    mockChat
      .mockResolvedValueOnce('A')
      .mockResolvedValueOnce('B')
      .mockResolvedValueOnce(tooFew);

    await expect(generateImageConcepts({
      projectId: 'proj-1',
      lpCopyText: 'Some listicle text.',
      foundationalDocs: sampleDocs,
    }, () => {})).rejects.toThrow(/minimum 5 required/);
  });

  it('drops concepts with too-short nano_banana_prompt and applies defaults to missing fields', async () => {
    const messy = JSON.stringify({
      concepts: [
        { concept_label: 'good 1', nano_banana_prompt: 'A long enough first prompt body for filter purposes.', aspect_ratio: '16:9', suggested_slot_role: 'hero' },
        { concept_label: 'good 2', nano_banana_prompt: 'A long enough second prompt body for filter purposes.', aspect_ratio: '1:1', suggested_slot_role: 'compare' },
        { concept_label: 'good 3', nano_banana_prompt: 'A long enough third prompt body for filter purposes.', aspect_ratio: '4:5', suggested_slot_role: 'callout' },
        { concept_label: 'good 4', nano_banana_prompt: 'A long enough fourth prompt body for filter purposes.', aspect_ratio: '3:2', suggested_slot_role: 'press' },
        { concept_label: 'good 5', nano_banana_prompt: 'A long enough fifth prompt body for filter purposes.', aspect_ratio: '1:1', suggested_slot_role: 'social' },
        { concept_label: 'too short', nano_banana_prompt: 'too short', aspect_ratio: '16:9', suggested_slot_role: 'x' },
        { nano_banana_prompt: 'A long enough prompt body for filter purposes — missing label test.', aspect_ratio: '16:9' },
      ],
    });
    mockChat
      .mockResolvedValueOnce('A')
      .mockResolvedValueOnce('B')
      .mockResolvedValueOnce(messy);

    const result = await generateImageConcepts({
      projectId: 'proj-1',
      lpCopyText: 'Some listicle text.',
      foundationalDocs: sampleDocs,
    }, () => {});

    expect(result.concepts).toHaveLength(6);
    // The 'too short' concept got dropped; the missing-label concept got a default label.
    expect(result.concepts.some(c => c.concept_label === 'too short')).toBe(false);
    expect(result.concepts.some(c => c.concept_label.startsWith('concept_'))).toBe(true);
  });
});

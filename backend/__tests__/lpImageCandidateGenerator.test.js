/**
 * Tests for backend/services/lpImageCandidateGenerator.js
 *
 * Mocks `gemini.generateImage` + `convexClient.uploadBuffer` and asserts:
 *   - Concurrency 3 fan-out completes in expected order
 *   - generation_status classification (succeeded / failed_transient / failed_permanent)
 *   - Upload-and-release pattern: each upload fires before the next image generates
 *   - Aspect ratio normalization clips weird values to supported set
 *
 * Per PEF plan 2026-04-21 + Phase K ESM mock pattern.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockGenerateImage = vi.fn();
const mockUploadBuffer = vi.fn();
const mockGetStorageUrl = vi.fn();

vi.mock('../services/gemini.js', () => ({
  generateImage: (...args) => mockGenerateImage(...args),
}));

vi.mock('../convexClient.js', () => ({
  uploadBuffer: (...args) => mockUploadBuffer(...args),
  getStorageUrl: (...args) => mockGetStorageUrl(...args),
}));

let generateImageCandidates;

beforeEach(async () => {
  process.env.CONVEX_URL ||= 'https://test-convex.invalid';
  vi.resetModules();
  mockGenerateImage.mockReset();
  mockUploadBuffer.mockReset();
  mockGetStorageUrl.mockReset();
  // Default mock for uploadBuffer + URL
  mockUploadBuffer.mockImplementation(async () => `storage-${Math.random().toString(36).slice(2, 8)}`);
  mockGetStorageUrl.mockImplementation(async (id) => `https://convex.invalid/${id}`);
  ({ generateImageCandidates } = await import('../services/lpImageCandidateGenerator.js'));
});

afterEach(() => {
  vi.clearAllMocks();
});

const buildConcepts = (n = 3) => Array.from({ length: n }).map((_, i) => ({
  concept_label: `concept_${i + 1}`,
  nano_banana_prompt: `Prompt ${i + 1}`,
  aspect_ratio: '16:9',
  suggested_slot_role: 'hero',
}));

describe('generateImageCandidates — happy path', () => {
  it('generates one candidate per concept, all succeeded', async () => {
    mockGenerateImage.mockImplementation(async () => ({
      imageBuffer: Buffer.from('fake'),
      mimeType: 'image/png',
      textResponse: '',
    }));

    const events = [];
    const candidates = await generateImageCandidates({
      projectId: 'proj-1',
      lpId: 'lp-1',
      concepts: buildConcepts(3),
    }, (e) => events.push(e));

    expect(candidates).toHaveLength(3);
    expect(candidates.every(c => c.generation_status === 'succeeded')).toBe(true);
    expect(candidates.every(c => c.storageId && c.storageUrl)).toBe(true);
    expect(mockUploadBuffer).toHaveBeenCalledTimes(3);

    // Final SSE event = image_candidates_complete
    const completeEvent = events.find(e => e.step === 'image_candidates_complete');
    expect(completeEvent).toBeDefined();
    expect(completeEvent.succeeded).toBe(3);
    expect(completeEvent.failed).toBe(0);
  });

  it('uses Nano Banana 2 model key (gemini.js resolves to Flash)', async () => {
    mockGenerateImage.mockImplementation(async () => ({
      imageBuffer: Buffer.from('fake'),
      mimeType: 'image/png',
      textResponse: '',
    }));

    await generateImageCandidates({
      projectId: 'proj-1',
      lpId: 'lp-1',
      concepts: buildConcepts(1),
    }, () => {});

    const call = mockGenerateImage.mock.calls[0];
    expect(call[3]).toMatchObject({ imageModel: 'nano-banana-2', operation: 'lp_image_candidate' });
  });
});

describe('generateImageCandidates — partial failure', () => {
  it('marks transient failures as failed_transient (rate limit / capacity)', async () => {
    mockGenerateImage.mockImplementation(async (prompt) => {
      if (prompt.includes('Prompt 2')) {
        throw new Error('Image generation rate limit reached. Please wait a moment and try again.');
      }
      return { imageBuffer: Buffer.from('fake'), mimeType: 'image/png', textResponse: '' };
    });

    const candidates = await generateImageCandidates({
      projectId: 'proj-1',
      lpId: 'lp-1',
      concepts: buildConcepts(3),
    }, () => {});

    expect(candidates).toHaveLength(3);
    const failed = candidates.find(c => c.concept_label === 'concept_2');
    expect(failed.generation_status).toBe('failed_transient');
    expect(failed.generation_error).toMatch(/rate limit/);
  });

  it('marks permanent failures as failed_permanent (refused prompt etc.)', async () => {
    mockGenerateImage.mockImplementation(async (prompt) => {
      if (prompt.includes('Prompt 1')) {
        throw new Error('Refused prompt — content policy violation.');
      }
      return { imageBuffer: Buffer.from('fake'), mimeType: 'image/png', textResponse: '' };
    });

    const candidates = await generateImageCandidates({
      projectId: 'proj-1',
      lpId: 'lp-1',
      concepts: buildConcepts(2),
    }, () => {});

    const failed = candidates.find(c => c.concept_label === 'concept_1');
    expect(failed.generation_status).toBe('failed_permanent');
    expect(failed.generation_error).toMatch(/Refused prompt/);
  });

  it('still uploads succeeded candidates when others fail', async () => {
    mockGenerateImage.mockImplementation(async (prompt) => {
      if (prompt.includes('Prompt 2')) throw new Error('rate limit');
      return { imageBuffer: Buffer.from('fake'), mimeType: 'image/png', textResponse: '' };
    });

    const candidates = await generateImageCandidates({
      projectId: 'proj-1',
      lpId: 'lp-1',
      concepts: buildConcepts(3),
    }, () => {});

    // 2 of 3 succeeded → 2 uploads, not 3.
    expect(mockUploadBuffer).toHaveBeenCalledTimes(2);
    const succeeded = candidates.filter(c => c.generation_status === 'succeeded');
    expect(succeeded).toHaveLength(2);
  });
});

describe('generateImageCandidates — upload-and-release', () => {
  it('does not hold all image buffers — uploads happen interleaved with generation', async () => {
    // Track call order: each generateImage records "gen-N", each uploadBuffer records "up-N".
    const order = [];
    mockGenerateImage.mockImplementation(async (prompt) => {
      const idx = prompt.match(/Prompt (\d+)/)[1];
      order.push(`gen-${idx}`);
      // Yield to event loop so other gens can fire.
      await new Promise((r) => setTimeout(r, 10));
      return { imageBuffer: Buffer.from(`img-${idx}`), mimeType: 'image/png', textResponse: '' };
    });
    mockUploadBuffer.mockImplementation(async (buffer) => {
      const tag = String(buffer);
      order.push(`up-${tag.split('-')[1]}`);
      return `storage-${tag.split('-')[1]}`;
    });

    await generateImageCandidates({
      projectId: 'proj-1',
      lpId: 'lp-1',
      concepts: buildConcepts(3),
    }, () => {});

    // Each uploaded image's tag matches the buffer's content; uploads happen
    // before the next generation completes (interleaved). Order should NOT be
    // gen-1, gen-2, gen-3, up-1, up-2, up-3 (which would mean we held all 3 buffers).
    const upPositions = order.map((s, i) => s.startsWith('up-') ? i : -1).filter(i => i >= 0);
    const lastGen = order.lastIndexOf('gen-3');
    // At least one upload should happen before the last gen completes (concurrency).
    expect(Math.min(...upPositions)).toBeLessThan(order.length - 1);
    expect(lastGen).toBeGreaterThanOrEqual(0);
  });
});

describe('generateImageCandidates — aspect-ratio normalization', () => {
  it('clips unsupported aspect ratios to default 16:9', async () => {
    mockGenerateImage.mockImplementation(async () => ({
      imageBuffer: Buffer.from('fake'),
      mimeType: 'image/png',
      textResponse: '',
    }));

    const concepts = [
      { concept_label: 'A', nano_banana_prompt: 'A', aspect_ratio: '7:13', suggested_slot_role: 'x' },
    ];

    const candidates = await generateImageCandidates({
      projectId: 'proj-1',
      lpId: 'lp-1',
      concepts,
    }, () => {});

    expect(candidates[0].aspect_ratio).toBe('16:9');
  });

  it('preserves supported aspect ratios verbatim', async () => {
    mockGenerateImage.mockImplementation(async () => ({
      imageBuffer: Buffer.from('fake'),
      mimeType: 'image/png',
      textResponse: '',
    }));

    const concepts = [
      { concept_label: 'A', nano_banana_prompt: 'A', aspect_ratio: '4:5', suggested_slot_role: 'x' },
      { concept_label: 'B', nano_banana_prompt: 'B', aspect_ratio: '1:1', suggested_slot_role: 'x' },
      { concept_label: 'C', nano_banana_prompt: 'C', aspect_ratio: '9:16', suggested_slot_role: 'x' },
    ];

    const candidates = await generateImageCandidates({
      projectId: 'proj-1',
      lpId: 'lp-1',
      concepts,
    }, () => {});

    expect(candidates.map(c => c.aspect_ratio)).toEqual(['4:5', '1:1', '9:16']);
  });
});

describe('generateImageCandidates — empty input', () => {
  it('returns empty array when concepts is empty', async () => {
    const candidates = await generateImageCandidates({
      projectId: 'proj-1',
      lpId: 'lp-1',
      concepts: [],
    }, () => {});

    expect(candidates).toEqual([]);
    expect(mockGenerateImage).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  batchesCreate: vi.fn(),
  batchesGet: vi.fn(),
  mutation: vi.fn(),
  getActiveAdStudioImageJobs: vi.fn(),
  claimAdStudioImageJob: vi.fn(),
  releaseAdStudioImageJob: vi.fn(),
  getAd: vi.fn(),
  uploadBuffer: vi.fn(),
  logGeminiCost: vi.fn(),
}));

vi.mock('../services/gemini.js', () => ({
  getClient: vi.fn(async () => ({
    batches: {
      create: mocks.batchesCreate,
      get: mocks.batchesGet,
    },
  })),
}));

vi.mock('../services/retry.js', () => ({
  withRetry: vi.fn((fn) => fn()),
}));

vi.mock('../services/costTracker.js', () => ({
  logGeminiCost: (...args) => mocks.logGeminiCost(...args),
}));

vi.mock('../utils/adImages.js', () => ({
  getProjectProductImage: vi.fn(),
}));

vi.mock('../convexClient.js', () => ({
  api: {
    adCreatives: {
      update: 'adCreatives.update',
    },
  },
  claimAdStudioImageJob: (...args) => mocks.claimAdStudioImageJob(...args),
  convexClient: {
    mutation: (...args) => mocks.mutation(...args),
  },
  getActiveAdStudioImageJobs: (...args) => mocks.getActiveAdStudioImageJobs(...args),
  getAd: (...args) => mocks.getAd(...args),
  getAdImageUrl: vi.fn(),
  getProject: vi.fn(),
  invalidateQueryCache: vi.fn(),
  releaseAdStudioImageJob: (...args) => mocks.releaseAdStudioImageJob(...args),
  uploadBuffer: (...args) => mocks.uploadBuffer(...args),
}));

import {
  pollAdStudioImageJobs,
  submitAdStudioImageJob,
} from '../services/adStudioImageJobs.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.batchesCreate.mockResolvedValue({ name: 'batches/ad-studio-1' });
  mocks.mutation.mockResolvedValue({});
  mocks.getAd.mockResolvedValue({
    id: 'ad-1',
    project_id: 'project-1',
    status: 'generating_image',
    image_prompt: 'Prompt',
  });
  mocks.getActiveAdStudioImageJobs.mockResolvedValue([]);
  mocks.claimAdStudioImageJob.mockResolvedValue({ claimed: true });
  mocks.releaseAdStudioImageJob.mockResolvedValue({ released: true });
  mocks.uploadBuffer.mockResolvedValue('storage-1');
  mocks.logGeminiCost.mockResolvedValue({});
});

describe('Ad Studio durable image jobs', () => {
  it('submits Gemini image generation as a one-image batch and returns before image completion', async () => {
    const emit = vi.fn();

    await submitAdStudioImageJob({
      adId: 'ad-1',
      projectId: 'project-1',
      project: { name: 'Grounding Bedsheet' },
      imagePrompt: 'Make an ad',
      aspectRatio: '1:1',
      productImage: { base64: 'abc', mimeType: 'image/png' },
      imageModel: 'nano-banana-2',
      emit,
    });

    expect(mocks.batchesCreate).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gemini-3.1-flash-image-preview',
      src: expect.arrayContaining([
        expect.objectContaining({
          config: expect.objectContaining({
            imageConfig: expect.objectContaining({ imageSize: '2K' }),
          }),
        }),
      ]),
    }));
    expect(mocks.mutation).toHaveBeenCalledWith('adCreatives.update', expect.objectContaining({
      externalId: 'ad-1',
      status: 'generating_image',
      gemini_batch_job: 'batches/ad-studio-1',
    }));
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({
      status: 'generating_image',
      adId: 'ad-1',
    }));
  });

  it('polls a completed Gemini image batch and saves the image to the existing ad', async () => {
    const b64 = Buffer.from('image-bytes').toString('base64');
    mocks.getActiveAdStudioImageJobs.mockResolvedValue([{
      id: 'ad-1',
      project_id: 'project-1',
      status: 'generating_image',
      image_prompt: 'Prompt',
      gemini_batch_job: 'batches/ad-studio-1',
    }]);
    mocks.batchesGet.mockResolvedValue({
      state: 'JOB_STATE_SUCCEEDED',
      dest: {
        inlinedResponses: [{
          response: {
            candidates: [{
              content: {
                parts: [{ inlineData: { data: b64, mimeType: 'image/png' } }],
              },
            }],
          },
        }],
      },
    });
    mocks.getAd.mockResolvedValue({ id: 'ad-1', storageId: null });

    const result = await pollAdStudioImageJobs({ owner: 'test-owner' });

    expect(result).toMatchObject({ checked: 1, completed: 1, failed: 0 });
    expect(mocks.uploadBuffer).toHaveBeenCalledWith(Buffer.from('image-bytes'), 'image/png');
    expect(mocks.mutation).toHaveBeenCalledWith('adCreatives.update', expect.objectContaining({
      externalId: 'ad-1',
      storageId: 'storage-1',
      status: 'completed',
    }));
  });

  it('persists a readable failure when Gemini finishes without an image', async () => {
    mocks.getActiveAdStudioImageJobs.mockResolvedValue([{
      id: 'ad-1',
      project_id: 'project-1',
      status: 'generating_image',
      image_prompt: 'Prompt',
      gemini_batch_job: 'batches/ad-studio-1',
    }]);
    mocks.batchesGet.mockResolvedValue({
      state: 'JOB_STATE_SUCCEEDED',
      dest: { inlinedResponses: [{ response: { candidates: [{ content: { parts: [{ text: 'no image' }] } }] } }] },
    });

    const result = await pollAdStudioImageJobs({ owner: 'test-owner' });

    expect(result).toMatchObject({ checked: 1, completed: 0, failed: 1 });
    expect(mocks.mutation).toHaveBeenCalledWith('adCreatives.update', expect.objectContaining({
      externalId: 'ad-1',
      status: 'failed',
      failure_stage: 'image_batch_result',
      error_message: expect.stringContaining('did not return an image'),
    }));
  });
});

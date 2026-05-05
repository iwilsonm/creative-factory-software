import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const mocks = vi.hoisted(() => ({
  chat: vi.fn(),
  chatWithImage: vi.fn(),
  chatWithImages: vi.fn(),
  openaiGenerateImage: vi.fn(),
  geminiGenerateImage: vi.fn(),
  convexQuery: vi.fn(),
  convexMutation: vi.fn(),
  getProject: vi.fn(),
  getLatestDoc: vi.fn(),
  uploadBuffer: vi.fn(),
  downloadToBuffer: vi.fn(),
  getAdImageUrl: vi.fn(),
}));

vi.mock('../convexClient.js', () => ({
  getProject: mocks.getProject,
  getLatestDoc: mocks.getLatestDoc,
  uploadBuffer: mocks.uploadBuffer,
  downloadToBuffer: mocks.downloadToBuffer,
  getInspirationImages: vi.fn(),
  getAllInspirationImages: vi.fn(),
  getInspirationImageUrl: vi.fn(),
  getTemplateImagesByProject: vi.fn(),
  getAdImageUrl: mocks.getAdImageUrl,
  invalidateQueryCache: vi.fn(),
  getSetting: vi.fn(),
  convexClient: {
    query: mocks.convexQuery,
    mutation: mocks.convexMutation,
  },
  api: {
    adCreatives: {
      create: 'adCreatives.create',
      update: 'adCreatives.update',
      getByExternalId: 'adCreatives.getByExternalId',
    },
    templateImages: {
      getByExternalId: 'templateImages.getByExternalId',
    },
  },
}));

vi.mock('uuid', () => ({
  v4: vi.fn(() => 'test-ad-id'),
}));

vi.mock('../services/openai.js', () => ({
  chat: mocks.chat,
  chatWithImage: mocks.chatWithImage,
  chatWithImages: mocks.chatWithImages,
  generateImage: mocks.openaiGenerateImage,
}));

vi.mock('../services/gemini.js', () => ({
  generateImage: mocks.geminiGenerateImage,
}));

vi.mock('../services/costTracker.js', () => ({
  logGeminiCost: vi.fn(),
}));

vi.mock('../services/rateLimiter.js', () => ({
  withHeavyLLMLimit: vi.fn((fn) => fn()),
  withGptRateLimit: vi.fn((fn) => fn()),
  AsyncSemaphore: vi.fn(),
}));

vi.mock('sharp', () => ({
  default: vi.fn(() => ({
    resize: vi.fn().mockReturnThis(),
    jpeg: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from('thumb')),
  })),
}));

import { generateAdMode2 } from '../services/adGenerator.js';

const templateBase64 = Buffer.from('template-image').toString('base64');
const generatedImage = Buffer.from('generated-image');

function setupHappyPath() {
  mocks.getProject.mockResolvedValue({
    id: 'project-1',
    brand_name: 'Test Brand',
    niche: 'wellness',
    product_description: 'test product',
    prompt_guidelines: null,
  });
  mocks.getLatestDoc.mockResolvedValue({ content: 'doc content' });
  mocks.downloadToBuffer.mockResolvedValue(Buffer.from('template-image'));
  mocks.convexQuery.mockImplementation(async (fn) => {
    if (fn === 'templateImages.getByExternalId') {
      return {
        externalId: 'template-1',
        storageId: 'storage-template',
        mimeType: 'image/jpeg',
      };
    }
    if (fn === 'adCreatives.getByExternalId') {
      return {
        externalId: 'ad-1',
        project_id: 'project-1',
        generation_mode: 'mode2',
        angle: null,
        headline: 'Headline',
        body_copy: 'Body',
        image_prompt: 'generated prompt',
        gpt_creative_output: 'generated prompt',
        storageId: 'storage-ad',
        aspect_ratio: '1:1',
        status: 'completed',
      };
    }
    return null;
  });
  mocks.chat.mockImplementation(async (_messages, model) => {
    if (model === 'gpt-4.1-mini') {
      return JSON.stringify({ headline: 'Headline', body_copy: 'Body' });
    }
    return 'ack';
  });
  mocks.chatWithImages.mockResolvedValue('generated prompt');
  mocks.chatWithImage.mockResolvedValue(JSON.stringify({
    is_product_only: false,
    has_visible_ad_layout: true,
    headline_visible: true,
    reason: 'looks like an ad',
  }));
  mocks.openaiGenerateImage.mockResolvedValue({
    imageBuffer: generatedImage,
    mimeType: 'image/png',
  });
  mocks.uploadBuffer.mockResolvedValue('storage-ad');
  mocks.getAdImageUrl.mockResolvedValue('https://example.com/ad.png');
}

beforeEach(() => {
  vi.clearAllMocks();
  setupHappyPath();
});

afterEach(() => {
  try {
    fs.unlinkSync(path.join(process.cwd(), '.thumb-cache', 'test-ad-id.jpg'));
  } catch { /* generated thumbnail may not exist */ }
});

describe('GPT Image 2 ad generation plumbing', () => {
  it('passes template and product references into the final OpenAI render', async () => {
    await generateAdMode2('project-1', {
      templateImageId: 'template-1',
      imageModel: 'gpt-image-2',
      productImageBase64: Buffer.from('product-image').toString('base64'),
      productImageMimeType: 'image/png',
      headline: 'Headline',
      bodyCopy: 'Body',
    });

    expect(mocks.openaiGenerateImage).toHaveBeenCalledTimes(1);
    const [prompt, aspectRatio, productArg, options] = mocks.openaiGenerateImage.mock.calls[0];
    expect(prompt).toBe('generated prompt');
    expect(aspectRatio).toBe('1:1');
    expect(productArg).toBeNull();
    expect(options.imageModel).toBe('gpt-image-2');
    expect(options.referenceImages).toEqual([
      { base64: templateBase64, mimeType: 'image/jpeg', role: 'layout' },
      { base64: Buffer.from('product-image').toString('base64'), mimeType: 'image/png', role: 'product' },
    ]);
  });

  it('fails an obvious product-only GPT Image render before upload', async () => {
    mocks.chatWithImage.mockResolvedValueOnce(JSON.stringify({
      is_product_only: true,
      has_visible_ad_layout: false,
      headline_visible: false,
      reason: 'only the product is visible',
    }));

    await expect(generateAdMode2('project-1', {
      templateImageId: 'template-1',
      imageModel: 'gpt-image-2',
      productImageBase64: Buffer.from('product-image').toString('base64'),
      productImageMimeType: 'image/png',
      headline: 'Headline',
    })).rejects.toThrow('product-only');

    expect(mocks.uploadBuffer).not.toHaveBeenCalled();
    expect(mocks.convexMutation).toHaveBeenCalledWith('adCreatives.update', expect.objectContaining({
      status: 'failed',
    }));
  });

  it('allows completion if the QA service itself fails', async () => {
    mocks.chatWithImage.mockRejectedValueOnce(new Error('vision unavailable'));

    const ad = await generateAdMode2('project-1', {
      templateImageId: 'template-1',
      imageModel: 'gpt-image-2',
      productImageBase64: Buffer.from('product-image').toString('base64'),
      productImageMimeType: 'image/png',
      headline: 'Headline',
    });

    expect(mocks.uploadBuffer).toHaveBeenCalledWith(generatedImage, 'image/png');
    expect(ad.status).toBe('completed');
  });
});

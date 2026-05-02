import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  imagesEdit: vi.fn(),
  imagesGenerate: vi.fn(),
  chatCreate: vi.fn(),
  toFile: vi.fn(),
}));

vi.mock('openai', () => ({
  default: vi.fn(function OpenAIMock() {
    return {
    images: {
      edit: mocks.imagesEdit,
      generate: mocks.imagesGenerate,
    },
    chat: {
      completions: {
        create: mocks.chatCreate,
      },
    },
    };
  }),
}));

vi.mock('openai/uploads', () => ({
  toFile: mocks.toFile,
}));

vi.mock('../convexClient.js', () => ({
  getSetting: vi.fn(),
}));

vi.mock('../services/retry.js', () => ({
  withRetry: vi.fn((fn) => fn()),
}));

vi.mock('../services/costTracker.js', () => ({
  logOpenAICost: vi.fn(),
  logOpenAIImageCost: vi.fn().mockResolvedValue(null),
}));

import { getSetting } from '../convexClient.js';
import { buildGPTImageRenderPrompt, generateImage, getOpenAIImageSize } from '../services/openai.js';

const b64 = Buffer.from('fake-image').toString('base64');

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getSetting).mockResolvedValue('sk-test');
  mocks.toFile.mockImplementation(async (buffer, filename, options) => ({
    buffer,
    filename,
    options,
  }));
  mocks.imagesEdit.mockResolvedValue({ data: [{ b64_json: b64 }] });
  mocks.imagesGenerate.mockResolvedValue({ data: [{ b64_json: b64 }] });
});

describe('OpenAI GPT image generation', () => {
  it('uses GPT Image edit with an image array when references are provided', async () => {
    await generateImage('Make a complete ad', '4:5', null, {
      projectId: 'project-1',
      imageModel: 'gpt-image-2',
      referenceImages: [
        { base64: Buffer.from('layout').toString('base64'), mimeType: 'image/jpeg', role: 'layout' },
        { base64: Buffer.from('product').toString('base64'), mimeType: 'image/png', role: 'product' },
      ],
    });

    expect(mocks.imagesGenerate).not.toHaveBeenCalled();
    expect(mocks.imagesEdit).toHaveBeenCalledTimes(1);
    const args = mocks.imagesEdit.mock.calls[0][0];
    expect(args.model).toBe('gpt-image-2');
    expect(args.image).toHaveLength(2);
    expect(args.size).toBe('1024x1536');
    expect(args.output_format).toBe('png');
    expect(args.quality).toBe('auto');
    expect(args.response_format).toBeUndefined();
    expect(args.prompt).toContain('Create a complete paid social ad');
    expect(args.prompt).toContain('Make a complete ad');
  });

  it('uses GPT Image generation without response_format when no references are provided', async () => {
    await generateImage('Make a complete ad', '16:9', null, {
      projectId: 'project-1',
      imageModel: 'gpt-image-2',
    });

    expect(mocks.imagesEdit).not.toHaveBeenCalled();
    expect(mocks.imagesGenerate).toHaveBeenCalledTimes(1);
    const args = mocks.imagesGenerate.mock.calls[0][0];
    expect(args.model).toBe('gpt-image-2');
    expect(args.size).toBe('1536x1024');
    expect(args.output_format).toBe('png');
    expect(args.quality).toBe('auto');
    expect(args.response_format).toBeUndefined();
  });

  it('does not silently fall back to DALL-E 2 for a legacy productImage argument', async () => {
    await generateImage('Make a complete ad', '1:1', {
      base64: Buffer.from('product').toString('base64'),
      mimeType: 'image/png',
    }, {
      projectId: 'project-1',
      imageModel: 'gpt-image-2',
    });

    const args = mocks.imagesEdit.mock.calls[0][0];
    expect(args.model).toBe('gpt-image-2');
    expect(args.model).not.toBe('dall-e-2');
    expect(args.image).toHaveLength(1);
  });

  it('maps aspect ratios to supported GPT image sizes', () => {
    expect(getOpenAIImageSize('1:1')).toBe('1024x1024');
    expect(getOpenAIImageSize('4:5')).toBe('1024x1536');
    expect(getOpenAIImageSize('9:16')).toBe('1024x1536');
    expect(getOpenAIImageSize('16:9')).toBe('1536x1024');
    expect(getOpenAIImageSize('unknown')).toBe('1024x1024');
  });

  it('adds anti-product-only instructions only when references are present', () => {
    expect(buildGPTImageRenderPrompt('plain prompt', [])).toBe('plain prompt');
    const prompt = buildGPTImageRenderPrompt('plain prompt', [{ role: 'layout' }, { role: 'product' }]);
    expect(prompt).toContain('not a product-only render');
    expect(prompt).toContain('Use the first reference image for layout');
    expect(prompt).toContain('plain prompt');
  });
});

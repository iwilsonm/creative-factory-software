import { beforeEach, describe, expect, it, vi } from 'vitest';
import OpenAI from 'openai';

const mocks = vi.hoisted(() => ({
  imagesGenerate: vi.fn(),
}));

vi.mock('openai', () => ({
  default: vi.fn(function OpenAIMock() {
    return {
      images: {
        generate: mocks.imagesGenerate,
      },
    };
  }),
}));

import {
  classifyOpenAIImageAccessError,
  testOpenAIImageAccess,
} from '../services/openaiImageAccess.js';

const b64 = Buffer.from('test-image').toString('base64');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.imagesGenerate.mockResolvedValue({ data: [{ b64_json: b64 }] });
});

describe('OpenAI image access check', () => {
  it('reports a missing API key without calling OpenAI', async () => {
    const result = await testOpenAIImageAccess({ apiKey: '', model: 'gpt-image-2' });

    expect(result.success).toBe(false);
    expect(result.status).toBe('missing_key');
    expect(result.code).toBe('missing_openai_api_key');
    expect(mocks.imagesGenerate).not.toHaveBeenCalled();
  });

  it('uses a low-quality GPT Image 2 generation preflight and discards image data', async () => {
    const result = await testOpenAIImageAccess({ apiKey: 'sk-test', model: 'gpt-image-2' });

    expect(OpenAI).toHaveBeenCalledWith({ apiKey: 'sk-test' });
    expect(mocks.imagesGenerate).toHaveBeenCalledTimes(1);
    expect(mocks.imagesGenerate).toHaveBeenCalledWith({
      model: 'gpt-image-2',
      prompt: 'A tiny neutral test image for API access verification.',
      size: '1024x1024',
      quality: 'low',
      output_format: 'png',
      n: 1,
    });
    expect(result).toEqual({
      success: true,
      model: 'gpt-image-2',
      status: 'available',
      code: null,
      message: 'gpt-image-2 is available for this OpenAI API key.',
    });
  });

  it('maps invalid keys to unauthorized guidance', () => {
    const result = classifyOpenAIImageAccessError(
      { status: 401, code: 'invalid_api_key', message: 'Incorrect API key provided' },
      'gpt-image-2'
    );

    expect(result.success).toBe(false);
    expect(result.status).toBe('unauthorized');
    expect(result.message).toContain('stored key');
  });

  it('maps organization verification failures clearly', () => {
    const result = classifyOpenAIImageAccessError(
      { status: 403, message: 'Your organization must be verified to use this model.' },
      'gpt-image-2'
    );

    expect(result.status).toBe('org_not_verified');
    expect(result.code).toBe('organization_not_verified');
    expect(result.message).toContain('Organization Verification');
  });

  it('maps unavailable image models clearly', () => {
    const result = classifyOpenAIImageAccessError(
      { status: 404, code: 'model_not_found', message: 'The model gpt-image-2 does not exist' },
      'gpt-image-2'
    );

    expect(result.status).toBe('model_unavailable');
    expect(result.message).toContain('not available');
  });

  it('maps rate limits and transient OpenAI failures', () => {
    expect(classifyOpenAIImageAccessError({ status: 429, message: 'rate limit' }).status).toBe('rate_limited');
    expect(classifyOpenAIImageAccessError({ status: 500, message: 'server error' }).status).toBe('transient_error');
  });
});

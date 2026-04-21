/**
 * Tests for the Sonnet 4.6 → Sonnet 4.5 fallback path in backend/services/anthropic.js.
 *
 * Per PEF plan 2026-04-21 — mirrors the OpenAI gpt-5.4 → gpt-5.2 pattern.
 *
 * Mock surface: replace the Anthropic SDK with a stub that throws a
 * synthetic 404 model_not_found on the first call (model=4.6) and returns
 * a normal response on the second call (model=4.5).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the Anthropic SDK before lazy-loading anthropic.js.
const mockCreate = vi.fn();

class FakeAnthropic {
  constructor() {
    this.messages = { create: mockCreate };
  }
}

vi.mock('@anthropic-ai/sdk', () => ({
  default: FakeAnthropic,
}));

// getSetting must return an API key so getClient() doesn't bail.
const mockGetSetting = vi.fn();
vi.mock('../convexClient.js', () => ({
  getSetting: (...args) => mockGetSetting(...args),
}));

// Cost tracker — fire-and-forget, mock to no-op.
vi.mock('../services/costTracker.js', () => ({
  logAnthropicCost: vi.fn(async () => null),
}));

let chat;

beforeEach(async () => {
  process.env.CONVEX_URL ||= 'https://test-convex.invalid';
  vi.resetModules();
  mockCreate.mockReset();
  mockGetSetting.mockReset();
  mockGetSetting.mockResolvedValue('sk-test-anthropic-key');
  ({ chat } = await import('../services/anthropic.js'));
});

afterEach(() => {
  vi.clearAllMocks();
});

function makeOkResponse(text = 'fallback response') {
  return {
    content: [{ type: 'text', text }],
    usage: { input_tokens: 10, output_tokens: 20 },
  };
}

function makeModelNotFoundError() {
  const err = new Error('model claude-sonnet-4-6: not found or no longer supported');
  err.status = 404;
  err.error = { type: 'not_found_error', message: err.message };
  return err;
}

describe('anthropic.chat — model_not_found fallback', () => {
  it('falls back from claude-sonnet-4-6 → claude-sonnet-4-5 on model_not_found', async () => {
    mockCreate
      .mockImplementationOnce(async () => { throw makeModelNotFoundError(); })
      .mockImplementationOnce(async () => makeOkResponse('Hello from 4.5'));

    const warnings = [];
    const onWarning = (w) => warnings.push(w);

    const result = await chat(
      [{ role: 'user', content: 'hi' }],
      'claude-sonnet-4-6',
      { onWarning },
    );

    expect(result).toBe('Hello from 4.5');
    expect(mockCreate).toHaveBeenCalledTimes(2);
    expect(mockCreate.mock.calls[0][0].model).toBe('claude-sonnet-4-6');
    expect(mockCreate.mock.calls[1][0].model).toBe('claude-sonnet-4-5');

    // onWarning fired with the expected shape
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      type: 'warning',
      tag: 'anthropic_model_fallback',
      from: 'claude-sonnet-4-6',
      to: 'claude-sonnet-4-5',
    });
  });

  it('does NOT trigger model-fallback on non-model errors (e.g. 400 bad request)', async () => {
    // Use a synthetic 400 — withRetry treats 4xx (other than 429) as non-retryable,
    // so this test runs fast.
    const err400 = new Error('Bad request — invalid field');
    err400.status = 400;
    mockCreate.mockImplementation(async () => { throw err400; });

    await expect(chat(
      [{ role: 'user', content: 'hi' }],
      'claude-sonnet-4-6',
      {},
    )).rejects.toThrow();
    // We may have tried 4.6 once, but never any fallback model.
    const modelsTried = new Set(mockCreate.mock.calls.map(c => c[0].model));
    expect(modelsTried).toEqual(new Set(['claude-sonnet-4-6']));
  });

  it('does NOT retry models without a fallback target (e.g. opus-4-6)', async () => {
    mockCreate.mockImplementation(async () => { throw makeModelNotFoundError(); });

    await expect(chat(
      [{ role: 'user', content: 'hi' }],
      'claude-opus-4-6',
      {},
    )).rejects.toThrow();
    const modelsTried = new Set(mockCreate.mock.calls.map(c => c[0].model));
    expect(modelsTried).toEqual(new Set(['claude-opus-4-6']));
  });

  it('handler with no onWarning callback still succeeds (does not throw on missing optional)', async () => {
    mockCreate
      .mockImplementationOnce(async () => { throw makeModelNotFoundError(); })
      .mockImplementationOnce(async () => makeOkResponse('Hello'));

    const result = await chat([{ role: 'user', content: 'hi' }], 'claude-sonnet-4-6', {});
    expect(result).toBe('Hello');
  });
});

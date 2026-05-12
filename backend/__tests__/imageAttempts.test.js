import { describe, it, expect } from 'vitest';
import { buildImageAttemptRecord, serializeImageAttempts } from '../utils/imageAttempts.js';

describe('image attempt diagnostics', () => {
  it('builds the shared sync image_attempts shape with source', () => {
    const attempt = buildImageAttemptRecord({
      attemptNumber: 1,
      startedAt: '2026-05-12T00:00:00.000Z',
      endedAt: '2026-05-12T00:00:02.500Z',
      errorClass: 'success',
      queueDepthAtStart: 4,
      source: 'gemini_sync',
    });

    expect(attempt).toEqual({
      attempt_number: 1,
      started_at: '2026-05-12T00:00:00.000Z',
      ended_at: '2026-05-12T00:00:02.500Z',
      duration_ms: 2500,
      error_class: 'success',
      error_message: null,
      queue_depth_at_start: 4,
      source: 'gemini_sync',
    });
  });

  it('builds the shared batch image_attempts shape with provider errors', () => {
    const attempt = buildImageAttemptRecord({
      attemptNumber: 1,
      startedAt: '2026-05-12T00:00:00.000Z',
      endedAt: '2026-05-12T00:01:00.000Z',
      errorClass: 'batch_image_rejected',
      errorMessage: '  blocked   by safety filter  ',
      queueDepthAtStart: 0,
      source: 'gemini_batch',
    });

    expect(attempt).toMatchObject({
      attempt_number: 1,
      duration_ms: 60000,
      error_class: 'batch_image_rejected',
      error_message: 'blocked by safety filter',
      queue_depth_at_start: 0,
      source: 'gemini_batch',
    });
    expect(JSON.parse(serializeImageAttempts([attempt]))[0]).toMatchObject({
      source: 'gemini_batch',
      error_class: 'batch_image_rejected',
    });
  });
});

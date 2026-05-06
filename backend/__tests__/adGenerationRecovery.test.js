import { describe, expect, it } from 'vitest';
import { buildStaleAdRepairUpdate, getAdProgressTime, isSingleAdGenerationRecoveryCandidate } from '../utils/adGenerationRecovery.js';

describe('ad generation recovery decisions', () => {
  it('marks stuck image generations failed with a specific retryable reason', () => {
    expect(buildStaleAdRepairUpdate({
      status: 'generating_image',
      storageId: null,
    }, '2026-05-05T00:00:00.000Z')).toEqual({
      status: 'failed',
      error_message: 'Image generation timed out before an image was saved. Please retry this ad.',
      failure_stage: 'stale_generating_image_timeout',
      last_progress_at: '2026-05-05T00:00:00.000Z',
    });
  });

  it('marks stuck copy generations failed with a specific retryable reason', () => {
    expect(buildStaleAdRepairUpdate({
      status: 'generating_copy',
    }, '2026-05-05T00:00:00.000Z')).toMatchObject({
      status: 'failed',
      failure_stage: 'stale_generating_copy_timeout',
    });
  });

  it('completes image generations that already have storage', () => {
    expect(buildStaleAdRepairUpdate({
      status: 'generating_image',
      storageId: 'storage-1',
    }, '2026-05-05T00:00:00.000Z')).toEqual({
      status: 'completed',
      error_message: null,
      failure_stage: null,
      last_progress_at: '2026-05-05T00:00:00.000Z',
    });
  });

  it('uses last_progress_at before created_at for stale timing', () => {
    expect(getAdProgressTime({
      created_at: '2026-05-05T00:00:00.000Z',
      last_progress_at: '2026-05-05T00:05:00.000Z',
    })).toBe(new Date('2026-05-05T00:05:00.000Z').getTime());
  });

  it('does not repair batch or Creative Director generation rows', () => {
    expect(isSingleAdGenerationRecoveryCandidate({
      status: 'generating_image',
      batch_job_id: 'batch-1',
    })).toBe(false);
    expect(isSingleAdGenerationRecoveryCandidate({
      status: 'generating_image',
      gemini_batch_job: 'gemini-1',
    })).toBe(false);
    expect(isSingleAdGenerationRecoveryCandidate({
      status: 'generating_image',
      auto_generated: true,
    })).toBe(false);
    expect(buildStaleAdRepairUpdate({
      status: 'generating_image',
      storageId: null,
      batch_job_id: 'batch-1',
    })).toBeNull();
  });
});

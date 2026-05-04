import { describe, expect, it } from 'vitest';

describe('backend module import contracts', () => {
  it('exports the optional auto-post log helper from convexClient', async () => {
    const convexClient = await import('../convexClient.js');
    expect(typeof convexClient.createAutoPostLog).toBe('function');
  });

  it('loads the real Creative Filter service without mocked dependencies', async () => {
    const service = await import('../services/creativeFilterService.js');
    expect(typeof service.finalizePassingAds).toBe('function');
    expect(typeof service.scoreBatchForInlineFilter).toBe('function');
  });
});

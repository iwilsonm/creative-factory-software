import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFetch = vi.fn();
const mockGetLPAgentConfig = vi.fn();

vi.mock('node-fetch', () => ({
  default: (...args) => mockFetch(...args),
}));

vi.mock('../convexClient.js', () => ({
  getLandingPage: vi.fn(),
  getLandingPagesByProject: vi.fn(),
  updateLandingPage: vi.fn(),
  createLandingPageVersion: vi.fn(),
  getStorageUrl: vi.fn(),
  downloadToBuffer: vi.fn(),
  getLPAgentConfig: (...args) => mockGetLPAgentConfig(...args),
  getProject: vi.fn(),
}));

describe('lpPublisher verifyLive', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetLPAgentConfig.mockResolvedValue({
      shopify_store_domain: 'example.myshopify.com',
      shopify_access_token: 'shpat_test',
      pdp_url: 'https://example.com/products/foo',
    });
  });

  it('passes when the live URL responds and the Shopify page uses template lander', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => `<html><body>${'x'.repeat(300)}</body></html>`,
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ page: { id: 123, template_suffix: 'lander' } }),
      });

    const { verifyLive } = await import('../services/lpPublisher.js');
    const result = await verifyLive('https://example.myshopify.com/pages/test', {
      projectId: 'project-1',
      shopifyPageId: '123',
      expectedTemplateSuffix: 'lander',
    });

    expect(result).toMatchObject({ verified: true, templateSuffix: 'lander' });
  });

  it('fails when the live URL responds but the Shopify page is on the wrong template', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => `<html><body>${'x'.repeat(300)}</body></html>`,
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ page: { id: 123, template_suffix: 'default' } }),
      });

    const { verifyLive } = await import('../services/lpPublisher.js');
    const result = await verifyLive('https://example.myshopify.com/pages/test', {
      projectId: 'project-1',
      shopifyPageId: '123',
      expectedTemplateSuffix: 'lander',
    });

    expect(result.verified).toBe(false);
    expect(result.error).toContain('template mismatch');
  });
});

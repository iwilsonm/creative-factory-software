import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFetch = vi.fn();
const mockGetLPAgentConfig = vi.fn();
const mockGetLandingPage = vi.fn();
const mockUpdateLandingPage = vi.fn();
const mockCreateLandingPageVersion = vi.fn();
const mockGetProject = vi.fn();

vi.mock('node-fetch', () => ({
  default: (...args) => mockFetch(...args),
}));

vi.mock('../convexClient.js', () => ({
  getLandingPage: (...args) => mockGetLandingPage(...args),
  getLandingPagesByProject: vi.fn(),
  updateLandingPage: (...args) => mockUpdateLandingPage(...args),
  createLandingPageVersion: (...args) => mockCreateLandingPageVersion(...args),
  getStorageUrl: vi.fn(),
  downloadToBuffer: vi.fn(),
  getLPAgentConfig: (...args) => mockGetLPAgentConfig(...args),
  getProject: (...args) => mockGetProject(...args),
}));

describe('lpPublisher verifyLive', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetLPAgentConfig.mockResolvedValue({
      shopify_store_domain: 'example.myshopify.com',
      shopify_access_token: 'shpat_test',
      pdp_url: 'https://example.com/products/foo',
    });
    mockGetProject.mockResolvedValue({
      name: 'Grounding Bedsheet',
      niche: 'Health/Wellness',
    });
    mockUpdateLandingPage.mockResolvedValue(undefined);
    mockCreateLandingPageVersion.mockResolvedValue(undefined);
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

  it('blocks publish before Shopify when required placeholders remain unresolved', async () => {
    mockGetLandingPage.mockResolvedValue({
      externalId: 'lp-1',
      current_version: 1,
      name: 'LP Batch — Myth Busting',
      angle: 'Wakes to Pee, Then Cannot Fall Back Asleep',
      narrative_frame: 'myth_busting',
      html_template: '<section>{{proof}}</section><a href="{{cta_1_url}}">{{cta_1_text}}</a>',
      copy_sections: '[]',
      cta_links: '[]',
      image_slots: '[]',
    });

    const { publishToShopify } = await import('../services/lpPublisher.js');

    await expect(publishToShopify('lp-1', 'project-1')).rejects.toThrow(
      'Required publish placeholders unresolved before publish: proof'
    );
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockUpdateLandingPage).toHaveBeenCalledWith(
      'lp-1',
      expect.objectContaining({
        smoke_test_status: 'failed',
      }),
    );
  });
});

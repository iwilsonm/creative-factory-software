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

vi.mock('../services/lpSmokeTest.js', () => ({
  inspectVisiblePlaceholdersInHtml: vi.fn().mockResolvedValue([]),
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
      headline_text: 'Why Broken Sleep Gets Worse After 2 a.m.',
      angle: 'Wakes to Pee, Then Cannot Fall Back Asleep',
      narrative_frame: 'myth_busting',
      html_template: '<section><h1>{{headline}}</h1><div>{{proof}}</div><a href="{{cta_1_url}}">{{cta_1_text}}</a></section>',
      copy_sections: JSON.stringify([
        { type: 'headline', content: 'Why Broken Sleep Gets Worse After 2 a.m.' },
      ]),
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

  it('repairs an empty hero h1 before publishing to Shopify', async () => {
    mockGetLandingPage.mockResolvedValue({
      externalId: 'lp-hero-fix',
      current_version: 1,
      name: 'LP Batch — Listicle',
      headline_text: 'Broken Sleep / Wake Up at 2 to 4 AM',
      subheadline_text: 'What your body is telling you after 2 a.m.',
      angle: 'Broken Sleep / Wake Up at 2 to 4 AM',
      narrative_frame: 'listicle',
      html_template: '<section class="hero"><h1></h1><p>{{subheadline}}</p><div>{{proof}}</div></section>',
      copy_sections: JSON.stringify([
        { type: 'headline', content: 'Broken Sleep / Wake Up at 2 to 4 AM' },
        { type: 'subheadline', content: 'What your body is telling you after 2 a.m.' },
        { type: 'proof', content: 'Evidence block' },
      ]),
      cta_links: JSON.stringify([{ text: 'Learn more', url: '#order' }]),
      image_slots: '[]',
      assembled_html: '',
      slug: 'broken-sleep-test',
      shopify_page_id: null,
    });

    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ page: { id: 456, handle: 'broken-sleep-test' } }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ page: { id: 456, template_suffix: 'lander' } }),
    });

    const { publishToShopify } = await import('../services/lpPublisher.js');
    const result = await publishToShopify('lp-hero-fix', 'project-1');

    expect(result.shopify_page_id).toBe('456');
    const [_url, options] = mockFetch.mock.calls[0];
    const requestBody = JSON.parse(options.body);
    expect(requestBody.page.body_html).toContain('<h1');
    expect(requestBody.page.body_html).toContain('Broken Sleep / Wake Up at 2 to 4 AM');
    expect(requestBody.page.body_html).toContain('font-size:clamp(2.6rem,5vw,4.5rem)');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFetch = vi.fn();
const mockGetLPAgentConfig = vi.fn();
const mockGetLandingPage = vi.fn();
const mockUpdateLandingPage = vi.fn();
const mockCreateLandingPageVersion = vi.fn();
const mockGetProject = vi.fn();
const mockInspectVisiblePlaceholdersInHtml = vi.fn();

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

vi.mock('../services/lpSmokeTest.js', () => ({
  inspectVisiblePlaceholdersInHtml: (...args) => mockInspectVisiblePlaceholdersInHtml(...args),
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
    mockInspectVisiblePlaceholdersInHtml.mockResolvedValue([]);
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

  it('publishes Shopify body_html as a fragment instead of a nested document', async () => {
    mockGetLandingPage.mockResolvedValue({
      externalId: 'lp-2',
      current_version: 1,
      name: 'LP Batch — Listicle',
      headline_text: '7 Reasons You Keep Waking Up Between 2 and 4 AM',
      angle: 'Broken Sleep / Wake Up at 2 to 4 AM',
      narrative_frame: 'listicle',
      html_template: `<!DOCTYPE html>
<html>
  <head>
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;700&display=swap">
    <style>.hero { color: red; }</style>
  </head>
  <body>
    <section class="hero"><h1>{{headline}}</h1><p>{{subheadline}}</p></section>
  </body>
</html>`,
      copy_sections: JSON.stringify([
        { type: 'headline', content: '7 Reasons You Keep Waking Up Between 2 and 4 AM' },
        { type: 'subheadline', content: 'And what may finally help you sleep through the night.' },
      ]),
      cta_links: '[]',
      image_slots: '[]',
    });

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ page: { id: 456, handle: 'lp-test-fragment' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ page: { id: 456, template_suffix: 'lander' } }),
      });

    const { publishToShopify } = await import('../services/lpPublisher.js');
    const result = await publishToShopify('lp-2', 'project-1');

    expect(result.shopify_page_id).toBe('456');
    expect(mockFetch).toHaveBeenCalledTimes(2);

    const publishBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    const bodyHtml = publishBody.page.body_html;

    expect(bodyHtml).not.toContain('<html');
    expect(bodyHtml).not.toContain('<head');
    expect(bodyHtml).not.toContain('<body');
    expect(bodyHtml).toContain('<style>');
    expect(bodyHtml).toContain("@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;700&display=swap');");
    expect(bodyHtml).toContain('<section class="hero">');
    expect(bodyHtml).toContain('<h1>7 Reasons You Keep Waking Up Between 2 and 4 AM</h1>');
    expect(bodyHtml).toContain('And what may finally help you sleep through the night.');
  });
});

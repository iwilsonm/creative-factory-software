import dns from 'dns/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchUrlText, UrlFetchError } from '../services/urlFetcher.js';

function mockSafeDns() {
  vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: '93.184.216.34' }]);
}

function mockFetch(body, { contentType = 'text/html; charset=utf-8', status = 200, url = 'https://example.com/page' } = {}) {
  vi.stubGlobal('fetch', vi.fn(async () => {
    const response = new Response(body, {
      status,
      headers: {
        'content-type': contentType,
        'content-length': String(Buffer.byteLength(body)),
      },
    });
    Object.defineProperty(response, 'url', { configurable: true, value: url });
    return response;
  }));
}

describe('fetchUrlText', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockSafeDns();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('extracts readable static HTML without browser rendering', async () => {
    mockFetch(`<!doctype html><html><head><title>Static Page</title></head><body><main>
      <h1>Grounding Bedsheet</h1>
      <p>${'Sleep better with conductive cotton. '.repeat(30)}</p>
    </main></body></html>`);

    const result = await fetchUrlText('https://example.com/page', {
      browserRenderer: vi.fn(),
    });

    expect(result.extraction_method).toBe('static_fetch');
    expect(result.title).toBe('Static Page');
    expect(result.text).toContain('Grounding Bedsheet');
    expect(result.attempted_methods).toEqual(['static_fetch']);
  });

  it('uses browser rendering for JavaScript app shells', async () => {
    mockFetch(`<!doctype html><html><head><title>SPA</title></head><body>
      <div id="root"></div><script type="module" src="/assets/app.js"></script>
    </body></html>`);
    const browserRenderer = vi.fn(async () => ({
      title: 'Rendered Sales Page',
      finalUrl: 'https://example.com/page',
      text: `${'Rendered product proof and benefits. '.repeat(20)}`,
    }));

    const result = await fetchUrlText('https://example.com/page', { browserRenderer });

    expect(browserRenderer).toHaveBeenCalledOnce();
    expect(result.extraction_method).toBe('browser_render');
    expect(result.title).toBe('Rendered Sales Page');
    expect(result.attempted_methods).toEqual(['static_fetch', 'browser_render']);
  });

  it('returns manual recovery details when static and rendered extraction are empty', async () => {
    mockFetch(`<!doctype html><html><body><div id="root"></div><script src="/app.js"></script></body></html>`);

    await expect(fetchUrlText('https://example.com/page', {
      browserRenderer: vi.fn(async () => ({ title: 'Blank', finalUrl: 'https://example.com/page', text: '' })),
    })).rejects.toMatchObject({
      reason_code: 'unreadable_page',
      attempted_methods: ['static_fetch', 'browser_render'],
      manual_recovery_steps: expect.arrayContaining(['Choose Save as PDF.']),
    });
  });

  it('classifies blocked access with a specific reason code', async () => {
    mockFetch('Forbidden', { status: 403 });

    await expect(fetchUrlText('https://example.com/private')).rejects.toMatchObject({
      reason_code: 'upstream_forbidden',
      attempted_methods: ['static_fetch'],
    });
  });

  it('keeps private and local URLs blocked', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(fetchUrlText('http://127.0.0.1:3000')).rejects.toBeInstanceOf(UrlFetchError);
    await expect(fetchUrlText('http://127.0.0.1:3000')).rejects.toMatchObject({
      reason_code: 'private_url',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('parses direct PDF links when the PDF contains readable text', async () => {
    mockFetch('fake pdf bytes', {
      contentType: 'application/pdf',
      url: 'https://example.com/sales-page.pdf',
    });
    const result = await fetchUrlText('https://example.com/sales-page.pdf', {
      pdfParser: vi.fn(async () => ({ text: 'PDF sales page text '.repeat(20) })),
    });

    expect(result.extraction_method).toBe('file_parse');
    expect(result.text).toContain('PDF sales page text');
    expect(result.attempted_methods).toEqual(['static_fetch', 'file_parse']);
  });

  it('classifies empty PDF text as scanned or image-only', async () => {
    mockFetch('fake pdf bytes', {
      contentType: 'application/pdf',
      url: 'https://example.com/sales-page.pdf',
    });

    await expect(fetchUrlText('https://example.com/sales-page.pdf', {
      pdfParser: vi.fn(async () => ({ text: '' })),
    })).rejects.toMatchObject({
      reason_code: 'scanned_pdf',
      attempted_methods: ['static_fetch', 'file_parse'],
    });
  });

  it('rejects unsupported media links with recovery steps', async () => {
    mockFetch('image bytes', {
      contentType: 'image/png',
      url: 'https://example.com/product.png',
    });

    await expect(fetchUrlText('https://example.com/product.png')).rejects.toMatchObject({
      reason_code: 'unsupported_media',
      manual_recovery_steps: expect.arrayContaining(['Upload that PDF here using the Upload option.']),
    });
  });
});

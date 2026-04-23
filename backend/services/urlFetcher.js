// URL fetcher for the "Sales Page from URL" feature.
//
// Threat model: authenticated CF staff paste a URL to a real sales page.
// We fetch the page, strip HTML, and return the extracted text. Returned
// text flows into the existing auto-describe pipeline.
//
// SSRF protection is hostname-based (not DNS-based). DNS rebinding is an
// accepted residual risk — the endpoint is auth-gated, read-only, and only
// returns the extracted text so there's no upstream secret to leak.

import * as cheerio from 'cheerio';

const BLOCKED_HOSTNAME_PATTERNS = [
  /^localhost$/i, /^127\./, /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^169\.254\./, /^0\./,
  /^\[?::1\]?$/, /^\[?fe80:/i, /^\[?fc00:/i, /^\[?fd/i,
];

const MAX_EXTRACTED_CHARS = 50_000;

function assertSafeUrl(urlString) {
  const url = new URL(urlString);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Only http/https URLs are allowed');
  }
  if (BLOCKED_HOSTNAME_PATTERNS.some((p) => p.test(url.hostname))) {
    throw new Error('URL blocked (private / local)');
  }
  return url;
}

// Return a safe-for-logs version of the URL — strips userinfo + query string.
export function safeUrlForLogs(urlString) {
  try {
    const u = new URL(urlString);
    return `${u.protocol}//${u.hostname}${u.pathname}`;
  } catch {
    return '(invalid url)';
  }
}

export async function fetchUrlText(urlString, { maxBytes = 2_000_000, timeoutMs = 15_000 } = {}) {
  assertSafeUrl(urlString);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(urlString, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'CreativeFactoryBot/1.0 (+https://creative-factory-software.vercel.app)',
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
      },
    });

    if (!res.ok) throw new Error(`Upstream returned HTTP ${res.status}`);

    // Post-redirect SSRF guard — re-validate the final URL after 3xx follows.
    assertSafeUrl(res.url);

    // Content-length preflight (reject before reading body).
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared && declared > maxBytes) {
      throw new Error('Response body too large');
    }

    // Content-type whitelist — reject binary / unexpected types.
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    if (ct && !ct.includes('text/html') && !ct.includes('text/plain') && !ct.includes('application/xhtml')) {
      throw new Error(`Unexpected content-type: ${ct}`);
    }

    const buf = await res.arrayBuffer();
    if (buf.byteLength > maxBytes) throw new Error('Response body too large (>2MB)');

    const html = new TextDecoder().decode(buf);
    const $ = cheerio.load(html);
    $('script, style, noscript, iframe, svg, nav, header, footer, aside').remove();

    // Prefer content-rich containers; fall back to body.
    const candidates = ['main', 'article', '[role="main"]', '#content', '.content', 'body'];
    let text = '';
    for (const sel of candidates) {
      const extracted = $(sel).first().text().replace(/\s+/g, ' ').trim();
      if (extracted.length > text.length) text = extracted;
      if (text.length > 500) break;
    }
    if (!text) throw new Error('Could not extract readable text from page');

    const truncated = text.length > MAX_EXTRACTED_CHARS;
    if (truncated) text = text.slice(0, MAX_EXTRACTED_CHARS);

    return {
      text,
      title: $('title').first().text().trim() || null,
      truncated,
      sparse: text.length < 200,
      sourceHost: new URL(res.url).hostname,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Convert a full HTML document into a Shopify-safe fragment.
 *
 * Shopify page.body_html is rendered inside the active page template. Sending
 * a full document causes nested <html>/<head>/<body> tags and often drops
 * inner styles. This helper preserves document-level styles and body content
 * while stripping the outer document wrapper.
 */
export function convertToShopifyFragment(html) {
  const source = String(html || '');
  if (!source.trim()) return '';

  // Already a fragment: keep it untouched.
  if (!/<!DOCTYPE/i.test(source) && !/<html[\s>]/i.test(source)) {
    return source;
  }

  const styleBlocks = [];
  const styleRegex = /<style\b[^>]*>[\s\S]*?<\/style>/gi;
  let styleMatch;
  while ((styleMatch = styleRegex.exec(source)) !== null) {
    styleBlocks.push(styleMatch[0]);
  }

  const linkImports = [];
  const seenImports = new Set();
  const linkRegex = /<link\b[^>]*href=["']([^"']+)["'][^>]*>/gi;
  let linkMatch;
  while ((linkMatch = linkRegex.exec(source)) !== null) {
    const tag = linkMatch[0];
    const href = linkMatch[1];
    const isStylesheet = /\brel=["']stylesheet["']/i.test(tag) || href.includes('fonts.googleapis.com');
    if (!isStylesheet || seenImports.has(href)) continue;
    seenImports.add(href);
    linkImports.push(`@import url('${href}');`);
  }

  let bodyContent = source;
  const bodyMatch = source.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) {
    bodyContent = bodyMatch[1].trim();
  } else {
    bodyContent = source
      .replace(/<!DOCTYPE[^>]*>/i, '')
      .replace(/<\/?html\b[^>]*>/gi, '')
      .replace(/<head\b[^>]*>[\s\S]*?<\/head>/i, '')
      .replace(/<\/?body\b[^>]*>/gi, '')
      .trim();
  }

  bodyContent = bodyContent
    .replace(styleRegex, '')
    .replace(/<link\b[^>]*href=["'][^"']+["'][^>]*>/gi, '')
    .trim();

  const parts = [];
  if (linkImports.length > 0) {
    parts.push(`<style>\n${linkImports.join('\n')}\n</style>`);
  }
  parts.push(...styleBlocks);
  if (bodyContent) {
    parts.push(bodyContent);
  }

  return parts.join('\n\n').trim();
}

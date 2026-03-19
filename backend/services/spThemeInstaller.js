import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';
import { withRetry } from './retry.js';

export const SP_THEME_VERSION = '1.0.0';

const SHOPIFY_API_VERSION = '2024-10';

// shopify-theme/ lives at repo root — two levels up from backend/services/
const themeDir = fileURLToPath(new URL('../../shopify-theme', import.meta.url));

async function shopifyFetch(domain, token, method, path, body) {
  const url = `https://${domain}/admin/api/${SHOPIFY_API_VERSION}${path}`;
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const resp = await fetch(url, opts);
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Shopify API ${method} ${path}: ${resp.status} ${text}`);
  }
  return resp.json();
}

function collectFiles(dir, base = dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      results.push(...collectFiles(full, base));
    } else if (entry !== 'README.md') {
      results.push({ full, rel: relative(base, full) });
    }
  }
  return results;
}

/**
 * Check whether the Sales Page theme files are installed on the store's active theme.
 * Detects presence via the `_sp_version` marker in templates/page.sales.json.
 */
export async function checkThemeStatus(domain, token) {
  const themesResp = await shopifyFetch(domain, token, 'GET', '/themes.json');
  const mainTheme = themesResp.themes?.find(t => t.role === 'main');
  if (!mainTheme) return { installed: false, version: null };

  try {
    const assetResp = await shopifyFetch(
      domain, token, 'GET',
      `/themes/${mainTheme.id}/assets.json?asset[key]=templates/page.sales.json`
    );
    const template = JSON.parse(assetResp.asset.value);
    const version = template._sp_version || null;
    if (version) {
      return { installed: true, version, themeId: mainTheme.id, themeName: mainTheme.name };
    }
    return { installed: false, version: null };
  } catch (err) {
    if (err.message.includes('404')) return { installed: false, version: null };
    throw err;
  }
}

/**
 * Upload all files from shopify-theme/ to the store's active theme.
 * Emits SSE progress events via sendEvent.
 * Throws if any files fail to upload.
 */
export async function installTheme(domain, token, sendEvent) {
  const themesResp = await shopifyFetch(domain, token, 'GET', '/themes.json');
  const mainTheme = themesResp.themes?.find(t => t.role === 'main');
  if (!mainTheme) throw new Error('No active (main) theme found on Shopify store');

  const files = collectFiles(themeDir);
  const total = files.length;
  let ok = 0;
  let fail = 0;

  sendEvent({ type: 'progress', step: 'start', message: `Installing ${total} theme files to "${mainTheme.name}"...`, ok: 0, total });

  for (const { full, rel } of files) {
    const assetKey = rel.replace(/\\/g, '/'); // Windows path safety
    const value = readFileSync(full, 'utf8');

    try {
      await withRetry(
        () => shopifyFetch(domain, token, 'PUT', `/themes/${mainTheme.id}/assets.json`, {
          asset: { key: assetKey, value },
        }),
        { maxRetries: 2, baseDelayMs: 1000, label: `[SP Theme] ${assetKey}` }
      );
      ok++;
      sendEvent({ type: 'progress', step: 'upload', message: `Uploaded ${assetKey}`, ok, total });
    } catch (err) {
      fail++;
      sendEvent({ type: 'progress', step: 'upload_error', message: `Failed: ${assetKey} — ${err.message}`, ok, total });
    }

    // 500ms delay to stay under Shopify's 2 req/sec rate limit
    await new Promise(r => setTimeout(r, 500));
  }

  if (fail > 0) {
    throw new Error(`Theme installation completed with ${fail} error(s) out of ${total} files. See progress log above.`);
  }

  sendEvent({ type: 'complete', ok, total });
}

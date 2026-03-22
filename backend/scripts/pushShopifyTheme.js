#!/usr/bin/env node
/**
 * Push Shopify theme files to the store connected to a project.
 *
 * Usage:
 *   CONVEX_URL=https://energized-hare-760.convex.cloud node backend/scripts/pushShopifyTheme.js PROJECT_ID
 *
 * PROJECT_ID is the externalId of a project with Shopify configured in LP Agent Settings.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';
import { getLPAgentConfig } from '../convexClient.js';

const SHOPIFY_API_VERSION = '2024-10';

const projectId = process.argv[2];
if (!projectId) {
  console.error('Usage: node backend/scripts/pushShopifyTheme.js PROJECT_ID');
  process.exit(1);
}

// Resolve shopify-theme/ relative to repo root (two levels up from backend/scripts/)
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const themeDir = join(repoRoot, 'shopify-theme');

async function shopifyPut(domain, token, themeId, assetKey, value) {
  const url = `https://${domain}/admin/api/${SHOPIFY_API_VERSION}/themes/${themeId}/assets.json`;
  const resp = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({ asset: { key: assetKey, value } }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`${resp.status} ${text}`);
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

async function main() {
  // 1. Load Shopify config from Convex
  const config = await getLPAgentConfig(projectId);
  if (!config?.shopify_store_domain || !config?.shopify_access_token) {
    console.error('Shopify not configured for this project. Set credentials in LP Agent Settings.');
    process.exit(1);
  }
  const domain = config.shopify_store_domain.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const token = config.shopify_access_token;

  // 2. Find active theme
  const themesResp = await fetch(
    `https://${domain}/admin/api/${SHOPIFY_API_VERSION}/themes.json`,
    { headers: { 'X-Shopify-Access-Token': token } }
  );
  if (!themesResp.ok) {
    console.error('Failed to fetch themes:', await themesResp.text());
    process.exit(1);
  }
  const { themes } = await themesResp.json();
  const mainTheme = themes.find(t => t.role === 'main');
  if (!mainTheme) {
    console.error('No active (main) theme found on Shopify store.');
    process.exit(1);
  }
  console.log(`Store: ${domain}`);
  console.log(`Theme: ${mainTheme.name} (ID: ${mainTheme.id})\n`);

  // 3. Collect and upload files
  const files = collectFiles(themeDir);
  let ok = 0;
  let fail = 0;

  for (const { full, rel } of files) {
    const assetKey = rel.replace(/\\/g, '/'); // Windows path safety
    const value = readFileSync(full, 'utf8');
    try {
      await shopifyPut(domain, token, mainTheme.id, assetKey, value);
      console.log(`  ✓ ${assetKey}`);
      ok++;
    } catch (err) {
      console.error(`  ✗ ${assetKey}: ${err.message}`);
      fail++;
    }
  }

  console.log(`\n${ok}/${files.length} files uploaded${fail > 0 ? `, ${fail} failed` : ''}.`);
  if (fail > 0) process.exit(1);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});

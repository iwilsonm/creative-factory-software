import { v4 as uuidv4 } from 'uuid';
import { withRetry } from './retry.js';
import { getSalesPage, updateSalesPage, createSalesPageVersion, getLPAgentConfig } from '../convexClient.js';
import { SECTION_SCHEMAS } from './spSectionPrompts.js';

// ── Shopify API helper ──────────────────────────────────────

// Shopify API version — pinned. See https://shopify.dev/docs/api/usage/versioning
const SHOPIFY_API_VERSION = '2024-10';

async function shopifyApi(domain, accessToken, method, path, body) {
  return withRetry(async () => {
    const url = `https://${domain}/admin/api/${SHOPIFY_API_VERSION}${path}`;
    const opts = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
    };
    if (body) opts.body = JSON.stringify(body);
    const resp = await fetch(url, opts);
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Shopify API ${method} ${path}: ${resp.status} ${text}`);
    }
    return resp.json();
  }, { maxRetries: 3, baseDelayMs: 2000 });
}

// ── Helpers ─────────────────────────────────────────────────

function generateSlug(title) {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
  const id = Math.floor(1000 + Math.random() * 9000);
  return `sp-${id}-${base}`;
}

function mapArrayToBlocks(items, blockType) {
  const blocks = {};
  const blockOrder = [];
  items.forEach((item, i) => {
    const id = `${blockType}_${i}`;
    blocks[id] = { type: blockType, settings: { ...item } };
    blockOrder.push(id);
  });
  return { blocks, block_order: blockOrder };
}

function mapSectionToShopify(sectionId, data) {
  const schema = SECTION_SCHEMAS[sectionId];
  const settings = {};
  let blocks = {};
  let blockOrder = [];

  for (const [key, value] of Object.entries(data)) {
    if (schema && schema.blockArrays && schema.blockArrays.includes(key) && Array.isArray(value)) {
      // Prefer explicit blockTypeMap over naive /s$/ → '' derivation
      const blockType = (schema.blockTypeMap?.[key]) || key.replace(/s$/, '');
      const mapped = mapArrayToBlocks(value, blockType);
      blocks = { ...blocks, ...mapped.blocks };
      blockOrder = [...blockOrder, ...mapped.block_order];
    } else {
      settings[key] = value;
    }
  }

  const result = { settings };
  if (Object.keys(blocks).length > 0) {
    result.blocks = blocks;
    result.block_order = blockOrder;
  }
  return result;
}

// ── Publish ─────────────────────────────────────────────────

export async function publishSalesPage(salesPageId, projectId) {
  try {
    return await _publishSalesPage(salesPageId, projectId);
  } catch (err) {
    try {
      await updateSalesPage(salesPageId, { status: 'publish_failed', error_message: err.message });
    } catch (_) { /* best-effort */ }
    throw err;
  }
}

async function _publishSalesPage(salesPageId, projectId) {
  // 1. Load and validate sales page
  const page = await getSalesPage(salesPageId);
  if (!page) throw new Error(`Sales page not found: ${salesPageId}`);
  if (!page.section_data) throw new Error('Sales page has no section_data');
  const PUBLISHABLE_STATUSES = ['completed', 'unpublished', 'publish_failed'];
  if (!PUBLISHABLE_STATUSES.includes(page.status)) {
    throw new Error(`Sales page status is "${page.status}", expected one of: ${PUBLISHABLE_STATUSES.join(', ')}`);
  }

  // Clear previous error if retrying from publish_failed (non-blocking)
  if (page.status === 'publish_failed') {
    updateSalesPage(salesPageId, { error_message: '' }).catch(() => {});
  }

  const sectionData = typeof page.section_data === 'string'
    ? JSON.parse(page.section_data)
    : page.section_data;

  // 2. Get Shopify config
  const config = await getLPAgentConfig(projectId);
  if (!config || !config.shopify_store_domain || !config.shopify_access_token) {
    throw new Error('Shopify not configured for this project. Set store domain and access token in LP Agent settings.');
  }
  const domain = config.shopify_store_domain.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const token = config.shopify_access_token;

  // 3. Get active theme
  const themesResp = await shopifyApi(domain, token, 'GET', '/themes.json');
  const mainTheme = themesResp.themes.find(t => t.role === 'main');
  if (!mainTheme) throw new Error('No active (main) theme found on Shopify store');
  const themeId = mainTheme.id;

  // 3.5. Re-publish check — update existing page instead of creating duplicate
  if (page.shopify_page_id && page.template_key) {
    let existingPage = null;
    try {
      const resp = await shopifyApi(domain, token, 'GET', `/pages/${page.shopify_page_id}.json`);
      existingPage = resp.page;
    } catch (err) {
      if (!err.message.includes('404')) throw err;
      // Shopify page was deleted externally — clear stale IDs and fall through to create
      await updateSalesPage(salesPageId, { shopify_page_id: '', published_url: '' }).catch(() => {});
    }

    if (existingPage) {
      const baseTemplateResp = await shopifyApi(domain, token, 'GET',
        `/themes/${themeId}/assets.json?asset[key]=templates/page.sales.json`);
      const baseTemplate = JSON.parse(baseTemplateResp.asset.value);
      const templateCopy = JSON.parse(JSON.stringify(baseTemplate));

      if (templateCopy.sections) {
        for (const [sectionKey, sectionDef] of Object.entries(templateCopy.sections)) {
          const rawType = sectionDef.type || sectionKey;
          const sectionId = rawType.replace(/^sp-/, '').replace(/-/g, '_');
          if (sectionData[sectionId]) {
            const mapped = mapSectionToShopify(sectionId, sectionData[sectionId]);
            sectionDef.settings = { ...(sectionDef.settings || {}), ...mapped.settings };
            if (mapped.blocks) { sectionDef.blocks = mapped.blocks; sectionDef.block_order = mapped.block_order; }
          }
        }
      }

      await shopifyApi(domain, token, 'PUT', `/themes/${themeId}/assets.json`, {
        asset: { key: page.template_key, value: JSON.stringify(templateCopy) },
      });

      const newVersion = (page.current_version || 0) + 1;
      await createSalesPageVersion({
        id: uuidv4(), sales_page_id: salesPageId, version: newVersion,
        section_data: typeof page.section_data === 'string' ? page.section_data : JSON.stringify(page.section_data),
        source: 'pre-publish',
      });
      await updateSalesPage(salesPageId, { status: 'published', current_version: newVersion });

      const id8 = salesPageId.slice(0, 8);
      return {
        published_url: page.published_url,
        shopify_page_id: existingPage.id,
        editor_url: `https://${domain}/admin/themes/${themeId}/editor?template=page.sales-${id8}`,
      };
    }
  }

  // 4. Read base sales page template
  const baseTemplateResp = await shopifyApi(
    domain, token, 'GET',
    `/themes/${themeId}/assets.json?asset[key]=templates/page.sales.json`
  );
  const baseTemplate = JSON.parse(baseTemplateResp.asset.value);

  // 5. Clone and populate sections
  const id8 = salesPageId.slice(0, 8);
  const templateCopy = JSON.parse(JSON.stringify(baseTemplate));

  if (templateCopy.sections) {
    for (const [sectionKey, sectionDef] of Object.entries(templateCopy.sections)) {
      // Normalize: "sp-announcement-bar" → "announcement_bar" to match generator output keys
      const rawType = sectionDef.type || sectionKey;
      const sectionId = rawType.replace(/^sp-/, '').replace(/-/g, '_');
      if (sectionData[sectionId]) {
        const mapped = mapSectionToShopify(sectionId, sectionData[sectionId]);
        sectionDef.settings = { ...(sectionDef.settings || {}), ...mapped.settings };
        if (mapped.blocks) {
          sectionDef.blocks = mapped.blocks;
          sectionDef.block_order = mapped.block_order;
        }
      }
    }
  }

  // 6. Write per-page template
  const templateKey = `templates/page.sales-${id8}.json`;
  await shopifyApi(domain, token, 'PUT', `/themes/${themeId}/assets.json`, {
    asset: {
      key: templateKey,
      value: JSON.stringify(templateCopy),
    },
  });

  // 7. Create Shopify page — clean up template asset if this fails
  const slug = generateSlug(page.name || 'sales-page');
  let shopifyPage;
  try {
    const pageResp = await shopifyApi(domain, token, 'POST', '/pages.json', {
      page: {
        title: page.name || 'Sales Page',
        handle: slug,
        template_suffix: `sales-${id8}`,
        published: false,
      },
    });
    shopifyPage = pageResp.page;
  } catch (err) {
    try {
      await shopifyApi(domain, token, 'DELETE',
        `/themes/${themeId}/assets.json?asset[key]=${encodeURIComponent(templateKey)}`);
    } catch (_) { /* best-effort cleanup */ }
    throw new Error(`Failed to create Shopify page (template cleaned up): ${err.message}`);
  }

  const publishedUrl = `https://${domain}/pages/${shopifyPage.handle}`;
  const editorUrl = `https://${domain}/admin/themes/${themeId}/editor?template=page.sales-${id8}`;

  // 8. Create version snapshot
  await createSalesPageVersion({
    id: uuidv4(),
    sales_page_id: salesPageId,
    version: (page.current_version || 0) + 1,
    section_data: typeof page.section_data === 'string' ? page.section_data : JSON.stringify(page.section_data),
    source: 'pre-publish',
  });

  // 9. Update sales page record
  await updateSalesPage(salesPageId, {
    status: 'published',
    published_url: publishedUrl,
    shopify_page_id: String(shopifyPage.id),
    shopify_theme_id: String(themeId),
    template_key: templateKey,
    published_at: new Date().toISOString(),
    current_version: (page.current_version || 0) + 1,
  });

  // 10. Return result
  return {
    published_url: publishedUrl,
    shopify_page_id: shopifyPage.id,
    editor_url: editorUrl,
  };
}

// ── Unpublish ───────────────────────────────────────────────

export async function unpublishSalesPage(salesPageId, projectId) {
  // 1. Load and validate
  const page = await getSalesPage(salesPageId);
  if (!page) throw new Error(`Sales page not found: ${salesPageId}`);
  if (!page.shopify_page_id) throw new Error('Sales page has no associated Shopify page');

  // 2. Get Shopify config
  const config = await getLPAgentConfig(projectId);
  if (!config || !config.shopify_store_domain || !config.shopify_access_token) {
    throw new Error('Shopify not configured for this project');
  }
  const domain = config.shopify_store_domain.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const token = config.shopify_access_token;

  // 3. Delete Shopify page
  await shopifyApi(domain, token, 'DELETE', `/pages/${page.shopify_page_id}.json`);

  // 4. Delete template asset if it exists
  if (page.template_key) {
    const themesResp = await shopifyApi(domain, token, 'GET', '/themes.json');
    const mainTheme = themesResp.themes.find(t => t.role === 'main');
    if (mainTheme) {
      try {
        await shopifyApi(
          domain, token, 'DELETE',
          `/themes/${mainTheme.id}/assets.json?asset[key]=${encodeURIComponent(page.template_key)}`
        );
      } catch (err) {
        // Template asset may already be deleted — non-fatal
        console.warn(`Failed to delete template asset ${page.template_key}:`, err.message);
      }
    }
  }

  // 5. Update sales page record
  await updateSalesPage(salesPageId, {
    status: 'unpublished',
    shopify_page_id: '',
    published_url: '',
  });
}

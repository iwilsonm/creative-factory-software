/**
 * LP Publisher — Publish/unpublish landing pages to Shopify.
 *
 * Uses the Shopify Admin REST API to create/update/delete pages.
 * Images are embedded as Convex storage URLs in body_html.
 *
 * Flows:
 *   publishToShopify(pageId, projectId)    — Validate, bake HTML, create/update Shopify page
 *   updateOnShopify(pageId, projectId)     — Update an existing Shopify page
 *   unpublishFromShopify(pageId, projectId) — Delete page from Shopify
 *   verifyLive(url)                        — Verify a published URL is live
 */

import {
  getLandingPage,
  getLandingPagesByProject,
  updateLandingPage,
  createLandingPageVersion,
  getStorageUrl,
  downloadToBuffer,
  getLPAgentConfig,
  getProject,
} from '../convexClient.js';
import { v4 as uuidv4 } from 'uuid';
import { withRetry } from './retry.js';
import fetch from 'node-fetch';
import { postProcessLP } from './lpGenerator.js';
import { inspectVisiblePlaceholdersInHtml } from './lpSmokeTest.js';

const REQUIRED_LP_TEMPLATE_SUFFIX = 'lander';

// =============================================
// Shopify API helpers
// =============================================

/**
 * Get Shopify credentials from lp_agent_config for the project.
 */
async function getShopifyConfig(projectId) {
  const config = await getLPAgentConfig(projectId);
  if (!config) {
    throw new Error('LP Agent config not found for this project. Configure Shopify settings in the Agent Dashboard → LP Agent.');
  }

  const { shopify_store_domain, shopify_access_token } = config;

  if (!shopify_store_domain || !shopify_access_token) {
    throw new Error('Shopify credentials not configured. Connect Shopify in Agent Dashboard → LP Agent Settings.');
  }

  // Normalize domain — strip protocol and trailing slash
  const domain = shopify_store_domain.replace(/^https?:\/\//, '').replace(/\/$/, '');

  return {
    domain,
    accessToken: shopify_access_token,
    templateSuffix: REQUIRED_LP_TEMPLATE_SUFFIX,
    pdpUrl: config.pdp_url || '#',
  };
}

function assertRequiredTemplateSuffix(templateSuffix) {
  if (!templateSuffix || templateSuffix !== REQUIRED_LP_TEMPLATE_SUFFIX) {
    throw new Error(`Landing pages must publish with Shopify template "${REQUIRED_LP_TEMPLATE_SUFFIX}".`);
  }
}

async function fetchShopifyPage(domain, accessToken, shopifyPageId) {
  if (!shopifyPageId) return null;
  const result = await shopifyApi(domain, accessToken, 'GET', `/pages/${shopifyPageId}.json`);
  return result?.page || null;
}

/**
 * Make a Shopify Admin REST API call with retry.
 */
async function shopifyApi(domain, accessToken, method, path, body) {
  return withRetry(async () => {
    const url = `https://${domain}/admin/api/2024-01${path}`;
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': accessToken,
      },
    };
    if (body) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const status = response.status;

      if (status === 401 || status === 403) {
        throw new Error(`Shopify authentication failed (${status}). Check your access token.`);
      }
      if (status === 404) {
        throw new Error(`Shopify resource not found (404). ${text}`);
      }
      if (status === 429) {
        const err = new Error(`Shopify rate limited (429). ${text}`);
        err.status = 429;
        throw err;
      }
      if (status === 422) {
        throw new Error(`Shopify validation error (422): ${text}`);
      }
      throw new Error(`Shopify API error ${status}: ${text}`);
    }

    // DELETE returns 200 with empty body
    if (method === 'DELETE') return { success: true };

    return await response.json();
  }, {
    maxRetries: 3,
    baseDelayMs: 2000,
    label: '[Shopify API]',
  });
}

// =============================================
// HTML preparation
// =============================================

/**
 * Validate a landing page is ready for publishing.
 */
function validateForPublish(page) {
  const errors = [];

  if (!page.html_template) {
    errors.push('No HTML template generated. Regenerate the landing page first.');
  }

  if (!page.copy_sections) {
    errors.push('No copy sections generated.');
  }

  return errors;
}

/**
 * Generate a Shopify page handle in the format: lp-{4-digit number}-{slugified-headline}
 * The "lp-" prefix is required for URL pattern matching (e.g. excluding pop-ups on LPs).
 */
export function generateSlug(name) {
  const num = String(Math.floor(1000 + Math.random() * 9000)); // 4-digit, 1000-9999
  const slugified = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  const prefix = `lp-${num}-`;
  const maxHeadlineLen = 255 - prefix.length;
  const headline = slugified.slice(0, maxHeadlineLen).replace(/-$/, '');
  return `${prefix}${headline}`;
}

/**
 * Extract the best headline text for slug generation.
 * Priority: headline from copy_sections → angle → name (stripped of "Test LP" prefix).
 */
export function extractHeadlineForSlug(page) {
  // Try to get headline from copy_sections
  if (page.copy_sections) {
    try {
      const sections = JSON.parse(page.copy_sections);
      const headlineSection = sections.find(s => s.type === 'headline');
      if (headlineSection?.content) {
        const text = headlineSection.content.replace(/<[^>]*>/g, '').trim();
        if (text.length > 5) return text.slice(0, 80);
      }
    } catch { /* ignore parse errors */ }
  }
  // Fallback to angle
  if (page.angle) {
    return page.angle.slice(0, 80);
  }
  // Fallback to name, stripped of "Test LP — FrameName: " prefix
  const name = (page.name || 'lp')
    .replace(/^Test LP\s*[—–-]\s*[^:]+:\s*/i, '')  // "Test LP — Testimonial Journey: ..." → "..."
    .replace(/^Test LP\s*[—–-]\s*/i, '');            // "Test LP — ..." → "..."
  return name.slice(0, 80);
}

/**
 * Bake the final HTML — replace all placeholders with actual content.
 * Images use Convex storage URLs directly.
 */
async function bakeFinalHtml(page, pdpUrl) {
  const htmlTemplate = page.html_template || '';
  const copySections = page.copy_sections ? JSON.parse(page.copy_sections) : [];
  const ctaLinks = page.cta_links ? JSON.parse(page.cta_links) : [];
  const imageSlots = page.image_slots ? JSON.parse(page.image_slots) : [];

  let html = htmlTemplate;

  // Replace copy section placeholders
  for (const section of copySections) {
    const placeholder = `{{${section.type}}}`;
    const htmlContent = section.content
      .split(/\n\n+/)
      .map(para => para.trim())
      .filter(para => para.length > 0)
      .map(para => {
        if (para.length < 100 && !para.includes('.')) return para;
        return `<p>${para.replace(/\n/g, '<br>')}</p>`;
      })
      .join('\n');
    html = html.replaceAll(placeholder, htmlContent);
  }

  // Replace image placeholders with Convex storage URLs
  for (let i = 0; i < imageSlots.length; i++) {
    const slot = imageSlots[i];
    const placeholder = `{{image_${i + 1}}}`;

    let imageUrl = `https://placehold.co/${slot.suggested_size || '800x400'}/e2e8f0/64748b?text=Image+${i + 1}`;
    if (slot.storageId) {
      try {
        const url = await getStorageUrl(slot.storageId);
        if (url) imageUrl = url;
      } catch (err) {
        console.warn(`[LPPublish] Failed to get storage URL for slot ${i + 1}:`, err.message);
      }
    } else if (slot.storageUrl) {
      imageUrl = slot.storageUrl;
    }

    html = html.replaceAll(placeholder, imageUrl);

    // Replace alt text placeholder
    const altPlaceholder = `{{image_${i + 1}_alt}}`;
    html = html.replaceAll(altPlaceholder, slot.description || `Image ${i + 1}`);
  }

  // Replace CTA placeholders — use pdpUrl from config if CTA URLs are missing/placeholder
  for (let i = 0; i < ctaLinks.length; i++) {
    const urlPlaceholder = `{{cta_${i + 1}_url}}`;
    const textPlaceholder = `{{cta_${i + 1}_text}}`;
    const cta = ctaLinks[i];
    const ctaUrl = (!cta.url || cta.url === '#order' || cta.url === '#') ? pdpUrl : cta.url;
    html = html.replaceAll(urlPlaceholder, ctaUrl);
    html = html.replaceAll(textPlaceholder, cta.text || cta.text_suggestion || 'Order Now');
  }

  return html;
}

// =============================================
// Public API
// =============================================

/**
 * Publish a landing page to Shopify.
 * Creates a new Shopify page or updates an existing one.
 *
 * @param {string} pageId - Landing page externalId
 * @param {string} projectId - Project externalId
 * @returns {object} - { published_url, shopify_page_id, shopify_handle }
 */
export async function publishToShopify(pageId, projectId) {
  const page = await getLandingPage(pageId);
  if (!page) throw new Error('Landing page not found');

  // Validate
  const validationErrors = validateForPublish(page);
  if (validationErrors.length > 0) {
    throw new Error(`Validation failed: ${validationErrors.join(' ')}`);
  }

  // Get Shopify config
  const shopify = await getShopifyConfig(projectId);
  assertRequiredTemplateSuffix(shopify.templateSuffix);

  // Save pre-publish version
  const currentVersion = page.current_version || 1;
  const newVersion = currentVersion + 1;
  const versionId = uuidv4();
  await createLandingPageVersion({
    id: versionId,
    landing_page_id: pageId,
    version: newVersion,
    copy_sections: page.copy_sections || '[]',
    source: 'pre-publish',
    image_slots: page.image_slots || undefined,
    cta_links: page.cta_links || undefined,
    html_template: page.html_template || undefined,
    assembled_html: page.assembled_html || undefined,
  });
  await updateLandingPage(pageId, { current_version: newVersion });

  // Bake final HTML with Convex storage URLs
  let finalHtml = await bakeFinalHtml(page, shopify.pdpUrl);

  // Post-process: fill metadata placeholders, strip remaining, fix duplicate headings, inject contrast CSS
  // This is critical — bakeFinalHtml() rebuilds from html_template which still has {{publish_date}} etc.
  const project = await getProject(projectId);
  const agentConfig = await getLPAgentConfig(projectId).catch(() => null);
  const { html: processedHtml } = postProcessLP(finalHtml, {
    project,
    agentConfig,
    angle: page.angle || '',
  });
  finalHtml = processedHtml;

  const visiblePlaceholderMatches = await inspectVisiblePlaceholdersInHtml(finalHtml);
  if (visiblePlaceholderMatches.length > 0) {
    await updateLandingPage(pageId, {
      smoke_test_status: 'failed',
      smoke_test_report: JSON.stringify({
        passed: false,
        failedCount: 1,
        checks: [
          {
            name: 'no_placeholders',
            passed: false,
            detail: `Visible placeholders before publish: ${visiblePlaceholderMatches.slice(0, 5).join(', ')}`,
          },
        ],
        visiblePlaceholderMatches,
        visiblePlaceholderCount: visiblePlaceholderMatches.length,
        rawHtmlPlaceholderMatches: [],
        rawHtmlPlaceholderCount: 0,
        source: 'pre_publish_validation',
      }),
      smoke_test_at: new Date().toISOString(),
    });
    throw new Error(`Visible placeholder text detected before publish: ${visiblePlaceholderMatches.slice(0, 5).join(', ')}`);
  }

  // Determine slug — use headline from copy, not full LP name
  const slug = page.slug || generateSlug(extractHeadlineForSlug(page));

  let shopifyPageId = page.shopify_page_id;
  let shopifyHandle;

  if (shopifyPageId) {
    // Update existing Shopify page
    const result = await shopifyApi(shopify.domain, shopify.accessToken, 'PUT', `/pages/${shopifyPageId}.json`, {
      page: {
        id: parseInt(shopifyPageId, 10),
        title: page.name,
        body_html: finalHtml,
        published: true,
        template_suffix: shopify.templateSuffix,
      },
    });
    shopifyHandle = result.page?.handle;
  } else {
    // Create new Shopify page
    const pagePayload = {
      page: {
        title: page.name,
        handle: slug,
        body_html: finalHtml,
        published: true,
      },
    };
    if (shopify.templateSuffix) {
      pagePayload.page.template_suffix = shopify.templateSuffix;
    }

    const result = await shopifyApi(shopify.domain, shopify.accessToken, 'POST', '/pages.json', pagePayload);
    shopifyPageId = String(result.page?.id);
    shopifyHandle = result.page?.handle;
  }

  const verifiedPage = await fetchShopifyPage(shopify.domain, shopify.accessToken, shopifyPageId);
  if (!verifiedPage || verifiedPage.template_suffix !== shopify.templateSuffix) {
    throw new Error(`Published Shopify page is not using template "${shopify.templateSuffix}".`);
  }

  const publishedUrl = `https://${shopify.domain}/pages/${shopifyHandle || slug}`;

  // Update landing page record
  await updateLandingPage(pageId, {
    status: 'published',
    slug: shopifyHandle || slug,
    published_url: publishedUrl,
    published_at: new Date().toISOString(),
    final_html: finalHtml,
    shopify_page_id: shopifyPageId,
    shopify_handle: shopifyHandle || slug,
    hosting_metadata: JSON.stringify({
      shopify_page_id: shopifyPageId,
      shopify_handle: shopifyHandle || slug,
      shopify_domain: shopify.domain,
      shopify_template_suffix: shopify.templateSuffix,
    }),
  });

  return {
    published_url: publishedUrl,
    shopify_page_id: shopifyPageId,
    shopify_handle: shopifyHandle || slug,
  };
}

/**
 * Update an existing Shopify page (re-publish with latest content).
 *
 * @param {string} pageId - Landing page externalId
 * @param {string} projectId - Project externalId
 * @returns {object} - { published_url, shopify_page_id, shopify_handle }
 */
export async function updateOnShopify(pageId, projectId) {
  const page = await getLandingPage(pageId);
  if (!page) throw new Error('Landing page not found');

  if (!page.shopify_page_id) {
    throw new Error('Landing page has no Shopify page ID. Publish it first.');
  }

  // This always does a PUT (update) via publishToShopify which checks shopify_page_id
  return publishToShopify(pageId, projectId);
}

/**
 * Unpublish a landing page — delete from Shopify.
 *
 * @param {string} pageId - Landing page externalId
 * @param {string} projectId - Project externalId
 * @returns {boolean}
 */
export async function unpublishFromShopify(pageId, projectId) {
  const page = await getLandingPage(pageId);
  if (!page) throw new Error('Landing page not found');

  if (page.status !== 'published') {
    throw new Error('Landing page is not currently published.');
  }

  const shopifyPageId = page.shopify_page_id;
  if (shopifyPageId) {
    const shopify = await getShopifyConfig(projectId);
    try {
      await shopifyApi(shopify.domain, shopify.accessToken, 'DELETE', `/pages/${shopifyPageId}.json`);
    } catch (err) {
      // Don't throw on 404 — page may already be gone
      if (!err.message.includes('404')) {
        throw err;
      }
    }
  }

  await updateLandingPage(pageId, {
    status: 'unpublished',
  });

  return true;
}

/**
 * Verify a published URL is live (returns HTTP 200 with content).
 *
 * @param {string} url - The published URL to verify
 * @param {object} [options]
 * @returns {object} - { verified: boolean, error?: string }
 */
export async function verifyLive(url, options = {}) {
  try {
    const {
      projectId = null,
      shopifyPageId = null,
      expectedTemplateSuffix = null,
    } = options || {};

    const response = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'DaciaAutomation/1.0' },
      redirect: 'follow',
      timeout: 15000,
    });

    if (!response.ok) {
      return { verified: false, error: `HTTP ${response.status}` };
    }

    const body = await response.text();
    // Verify page has meaningful content (not an empty or error page)
    if (body.length < 200) {
      return { verified: false, error: 'Page content too short — may not have rendered correctly' };
    }

    if (projectId && shopifyPageId && expectedTemplateSuffix) {
      const shopify = await getShopifyConfig(projectId);
      const page = await fetchShopifyPage(shopify.domain, shopify.accessToken, shopifyPageId);
      if (!page) {
        return { verified: false, error: 'Shopify page could not be loaded for template verification' };
      }
      if (page.template_suffix !== expectedTemplateSuffix) {
        return {
          verified: false,
          error: `Shopify page template mismatch: expected "${expectedTemplateSuffix}", got "${page.template_suffix || '(none)'}"`,
        };
      }
      return { verified: true, templateSuffix: page.template_suffix };
    }

    return { verified: true };
  } catch (err) {
    return { verified: false, error: err.message };
  }
}

/**
 * Set a published Shopify page to draft (unpublish without deleting).
 * Used when a published LP fails smoke testing — softer than unpublishFromShopify which DELETEs.
 *
 * @param {string} pageId - Landing page externalId
 * @param {string} projectId - Project externalId
 */
export async function setToDraft(pageId, projectId) {
  const page = await getLandingPage(pageId);
  if (!page || !page.shopify_page_id) {
    console.warn(`[LPPublish] setToDraft: no Shopify page ID for ${pageId}`);
    return;
  }

  try {
    const shopify = await getShopifyConfig(projectId);
    await shopifyApi(shopify.domain, shopify.accessToken, 'PUT', `/pages/${page.shopify_page_id}.json`, {
      page: { id: parseInt(page.shopify_page_id, 10), published: false },
    });
    console.log(`[LPPublish] Set Shopify page ${page.shopify_page_id} to draft`);
  } catch (err) {
    console.error(`[LPPublish] setToDraft failed: ${err.message}`);
  }

  await updateLandingPage(pageId, { status: 'draft' });
}

/**
 * Publish an LP to Shopify, then run a smoke test.
 * If smoke fails, revert to draft. Returns combined results.
 *
 * @param {string} pageId - Landing page externalId
 * @param {string} projectId - Project externalId
 * @param {object} [smokeOptions] - { expectedHeadline, pdpUrl }
 * @returns {Promise<{ publishResult: object, smokeResult: object|null, verified: boolean }>}
 */
export async function publishAndSmokeTest(pageId, projectId, smokeOptions = {}) {
  // 1. Publish to Shopify
  const publishResult = await publishToShopify(pageId, projectId);
  const shopify = await getShopifyConfig(projectId);

  // 2. Verify it's live
  const liveCheck = await verifyLive(publishResult.published_url, {
    projectId,
    shopifyPageId: publishResult.shopify_page_id,
    expectedTemplateSuffix: shopify.templateSuffix,
  });
  if (!liveCheck.verified) {
    console.warn(`[LPPublish] Page not live after publish: ${liveCheck.error}`);
    await updateLandingPage(pageId, {
      smoke_test_status: 'failed',
      smoke_test_report: JSON.stringify({ error: `Page not live: ${liveCheck.error}`, template_suffix: shopify.templateSuffix }),
      smoke_test_at: new Date().toISOString(),
    });
    return { publishResult, smokeResult: null, verified: false };
  }

  // 3. Run smoke test
  let smokeResult;
  try {
    const { runSmokeTest } = await import('./lpSmokeTest.js');
    smokeResult = await runSmokeTest(publishResult.published_url, smokeOptions);
  } catch (smokeErr) {
    console.error(`[LPPublish] Smoke test error: ${smokeErr.message}`);
    await updateLandingPage(pageId, {
      smoke_test_status: 'failed',
      smoke_test_report: JSON.stringify({ error: smokeErr.message }),
      smoke_test_at: new Date().toISOString(),
    });
    return { publishResult, smokeResult: null, verified: true };
  }

  // 4. Update LP with smoke test results
  await updateLandingPage(pageId, {
    smoke_test_status: smokeResult.passed ? 'passed' : 'failed',
    smoke_test_report: JSON.stringify(smokeResult),
    smoke_test_at: new Date().toISOString(),
  });

  // 5. If smoke failed, revert to draft
  if (!smokeResult.passed) {
    console.warn(`[LPPublish] Smoke test FAILED for ${pageId}. Reverting to draft.`);
    await setToDraft(pageId, projectId);
  }

  return { publishResult, smokeResult, verified: true };
}

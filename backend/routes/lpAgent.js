import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  getLPAgentConfig,
  upsertLPAgentConfig,
  getLPTemplate,
  getLPTemplatesByProject,
  createLandingPage,
  updateLandingPage,
  getLandingPagesByProject,
} from '../convexClient.js';
import { withRetry } from '../services/retry.js';
import { generateAutoLP, NARRATIVE_FRAMES } from '../services/lpGenerator.js';
import { publishToShopify, verifyLive } from '../services/lpPublisher.js';
import { createSSEStream } from '../utils/sseHelper.js';

const router = Router();

// ── Config CRUD ──

/**
 * GET /api/projects/:id/lp-agent/config
 * Get LP Agent config for a project.
 */
router.get('/:id/lp-agent/config', async (req, res) => {
  try {
    const config = await getLPAgentConfig(req.params.id);
    res.json({ config: config || null });
  } catch (err) {
    console.error('[LP Agent] Get config error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * PUT /api/projects/:id/lp-agent/config
 * Update LP Agent config. Shopify fields are set via connect/disconnect, not here.
 */
router.put('/:id/lp-agent/config', async (req, res) => {
  try {
    const allowedFields = [
      'enabled', 'pdp_url', 'default_narrative_frames', 'template_selection_mode',
      'editorial_pass_enabled', 'auto_publish', 'daily_budget_cents',
      'use_product_reference_images', 'lifestyle_image_style',
    ];
    const fields = {};
    for (const key of allowedFields) {
      if (req.body[key] !== undefined) fields[key] = req.body[key];
    }
    await upsertLPAgentConfig(req.params.id, fields);
    const config = await getLPAgentConfig(req.params.id);
    res.json({ success: true, config });
  } catch (err) {
    console.error('[LP Agent] Update config error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Shopify Connection ──

/**
 * POST /api/projects/:id/lp-agent/shopify/connect
 * Exchange client credentials for a Shopify Admin API access token.
 */
router.post('/:id/lp-agent/shopify/connect', async (req, res) => {
  try {
    const projectId = req.params.id;
    const { store_domain, client_id, client_secret } = req.body;

    if (!store_domain || !client_id || !client_secret) {
      return res.status(400).json({ error: 'store_domain, client_id, and client_secret are required' });
    }

    // Normalize domain — strip protocol and trailing slashes
    const domain = store_domain.replace(/^https?:\/\//, '').replace(/\/+$/, '');

    // Step 1: Exchange credentials for access token
    let tokenData;
    try {
      tokenData = await withRetry(async () => {
        const resp = await fetch(`https://${domain}/admin/oauth/access_token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id,
            client_secret,
            grant_type: 'client_credentials',
          }),
        });
        if (!resp.ok) {
          const body = await resp.text();
          const err = new Error(`Shopify token exchange failed (${resp.status}): ${body}`);
          err.status = resp.status;
          throw err;
        }
        return resp.json();
      }, { maxRetries: 2, baseDelayMs: 1000, label: 'Shopify token exchange' });
    } catch (err) {
      const status = err.status || 500;
      if (status === 401 || status === 403) {
        return res.status(400).json({ error: 'Invalid Client ID or Client Secret. Check your Shopify app credentials.' });
      }
      if (status === 404) {
        return res.status(400).json({ error: `Store not found: ${domain}. Verify the store domain is correct.` });
      }
      return res.status(400).json({ error: `Token exchange failed: ${err.message}` });
    }

    const accessToken = tokenData.access_token;
    if (!accessToken) {
      return res.status(400).json({ error: 'No access token returned from Shopify. Check your app configuration.' });
    }

    // Step 2: Validate token by listing pages
    try {
      await withRetry(async () => {
        const resp = await fetch(`https://${domain}/admin/api/2024-01/pages.json?limit=1`, {
          headers: { 'X-Shopify-Access-Token': accessToken },
        });
        if (!resp.ok) {
          const body = await resp.text();
          const err = new Error(`Shopify validation failed (${resp.status}): ${body}`);
          err.status = resp.status;
          throw err;
        }
        return resp.json();
      }, { maxRetries: 2, baseDelayMs: 1000, label: 'Shopify token validation' });
    } catch (err) {
      const status = err.status || 500;
      if (status === 403) {
        return res.status(400).json({ error: 'Token is valid but lacks required scopes. Ensure your app has write_content and read_content scopes.' });
      }
      return res.status(400).json({ error: `Token validation failed: ${err.message}` });
    }

    // Step 3: Store credentials in lp_agent_config (never store client_secret)
    await upsertLPAgentConfig(projectId, {
      shopify_store_domain: domain,
      shopify_access_token: accessToken,
      shopify_client_id: client_id,
      shopify_connected: true,
    });

    res.json({ success: true, store_domain: domain, connected: true });
  } catch (err) {
    console.error('[LP Agent] Shopify connect error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/projects/:id/lp-agent/shopify/disconnect
 * Clear the access token. Keep store_domain for easy reconnection.
 */
router.post('/:id/lp-agent/shopify/disconnect', async (req, res) => {
  try {
    await upsertLPAgentConfig(req.params.id, {
      shopify_access_token: '',
      shopify_client_id: '',
      shopify_connected: false,
    });
    res.json({ success: true });
  } catch (err) {
    console.error('[LP Agent] Shopify disconnect error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/projects/:id/lp-agent/shopify/status
 * Check if Shopify is connected and token is valid.
 */
router.get('/:id/lp-agent/shopify/status', async (req, res) => {
  try {
    const config = await getLPAgentConfig(req.params.id);
    const domain = config?.shopify_store_domain || null;
    const token = config?.shopify_access_token || '';

    if (!domain || !token) {
      return res.json({ connected: false, store_domain: domain });
    }

    // Lightweight validation — check token still works
    try {
      const resp = await fetch(`https://${domain}/admin/api/2024-01/shop.json`, {
        headers: { 'X-Shopify-Access-Token': token },
      });
      if (resp.ok) {
        return res.json({ connected: true, store_domain: domain });
      }
      return res.json({ connected: false, store_domain: domain, error: 'Token expired or revoked' });
    } catch {
      return res.json({ connected: true, store_domain: domain, warning: 'Could not verify token — Shopify may be temporarily unreachable' });
    }
  } catch (err) {
    console.error('[LP Agent] Shopify status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Test Generation ──

/**
 * POST /api/projects/:id/lp-agent/generate-test
 * Manual test LP generation — same pipeline as Director auto-generation.
 * SSE endpoint streaming progress.
 */
router.post('/:id/lp-agent/generate-test', async (req, res) => {
  const projectId = req.params.id;
  const { template_id, narrative_frame, angle_description } = req.body;

  if (!template_id || !narrative_frame || !angle_description) {
    return res.status(400).json({ error: 'template_id, narrative_frame, and angle_description are required' });
  }

  // Validate narrative frame
  const frame = NARRATIVE_FRAMES.find(f => f.id === narrative_frame);
  if (!frame) {
    return res.status(400).json({ error: `Invalid narrative_frame. Must be one of: ${NARRATIVE_FRAMES.map(f => f.id).join(', ')}` });
  }

  // Validate template exists and is ready
  let template;
  try {
    template = await getLPTemplate(template_id);
    if (!template || template.status !== 'ready') {
      return res.status(400).json({ error: 'Template not found or not ready' });
    }
  } catch (err) {
    return res.status(400).json({ error: `Failed to load template: ${err.message}` });
  }

  // Load agent config for settings
  const agentConfig = await getLPAgentConfig(projectId).catch(() => null);

  // Create LP record
  const lpId = uuidv4();
  try {
    await createLandingPage({
      id: lpId,
      project_id: projectId,
      name: `Test LP — ${frame.name}: ${angle_description.slice(0, 60)}`,
      angle: angle_description,
      word_count: 1200,
      status: 'generating',
      auto_generated: true,
      batch_job_id: null,
      narrative_frame: frame.id,
      template_id,
    });
  } catch (err) {
    return res.status(500).json({ error: `Failed to create LP record: ${err.message}` });
  }

  // Start SSE stream
  const { sendEvent, end } = createSSEStream(req, res);
  sendEvent({ type: 'started', page_id: lpId });

  try {
    // Generate using the same pipeline as the Director
    sendEvent({ type: 'phase', phase: 'copy_generation', message: 'Generating copy...' });
    const result = await generateAutoLP({
      projectId,
      templateId: template_id,
      angle: angle_description,
      narrativeFrame: frame.instruction,
      batchJobId: null,
      editorialPassEnabled: agentConfig?.editorial_pass_enabled !== false,
      useProductReferenceImages: agentConfig?.use_product_reference_images !== false,
    }, sendEvent);

    // Update LP with generated content
    const updateFields = {
      status: 'draft',
      copy_sections: JSON.stringify(result.copySections || []),
      image_slots: JSON.stringify(result.imageSlots || []),
      html_template: result.htmlTemplate || '',
      assembled_html: result.assembledHtml || '',
    };
    if (result.designAnalysis) {
      updateFields.swipe_design_analysis = JSON.stringify(result.designAnalysis);
    }
    await updateLandingPage(lpId, updateFields);

    // Auto-publish if configured and Shopify is connected
    let publishedUrl = null;
    const shouldAutoPublish = agentConfig?.auto_publish !== false;
    if (shouldAutoPublish && agentConfig?.shopify_access_token && agentConfig?.shopify_store_domain) {
      try {
        sendEvent({ type: 'phase', phase: 'publishing', message: 'Publishing to Shopify...' });
        const pubResult = await publishToShopify(lpId, projectId);
        publishedUrl = pubResult.published_url;

        sendEvent({ type: 'phase', phase: 'verifying', message: 'Verifying live...' });
        await verifyLive(publishedUrl);
      } catch (pubErr) {
        console.warn('[LP Agent] Publish failed (non-fatal):', pubErr.message);
        sendEvent({ type: 'progress', message: `Publish warning: ${pubErr.message}` });
      }
    }

    sendEvent({
      type: 'complete',
      page_id: lpId,
      name: `Test LP — ${frame.name}: ${angle_description.slice(0, 60)}`,
      published_url: publishedUrl,
    });
  } catch (err) {
    console.error('[LP Agent] Generate test error:', err.message);
    await updateLandingPage(lpId, { status: 'failed' }).catch(() => {});
    sendEvent({ type: 'error', message: err.message });
  } finally {
    end();
  }
});

// ── Agent Status ──

/**
 * GET /api/projects/:id/lp-agent/status
 * Health check: config completeness, Shopify connected, templates available, recent LP stats.
 */
router.get('/:id/lp-agent/status', async (req, res) => {
  try {
    const projectId = req.params.id;
    const [config, templates, landingPages] = await Promise.all([
      getLPAgentConfig(projectId).catch(() => null),
      getLPTemplatesByProject(projectId).catch(() => []),
      getLandingPagesByProject(projectId).catch(() => []),
    ]);

    const readyTemplates = (templates || []).filter(t => t.status === 'ready');
    const recentLPs = (landingPages || [])
      .filter(lp => lp.auto_generated)
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
      .slice(0, 5);

    const hasShopify = !!(config?.shopify_access_token && config?.shopify_store_domain);
    const hasTemplates = readyTemplates.length > 0;
    const hasPdpUrl = !!config?.pdp_url;
    const isEnabled = !!config?.enabled;

    let statusLabel = 'inactive';
    if (isEnabled && hasShopify && hasTemplates && hasPdpUrl) {
      statusLabel = 'active';
    } else if (isEnabled) {
      statusLabel = 'missing_config';
    }

    res.json({
      status: statusLabel,
      enabled: isEnabled,
      shopify_connected: hasShopify,
      shopify_domain: config?.shopify_store_domain || null,
      template_count: readyTemplates.length,
      has_pdp_url: hasPdpUrl,
      editorial_pass_enabled: config?.editorial_pass_enabled !== false,
      auto_publish: config?.auto_publish !== false,
      recent_generations: recentLPs.map(lp => ({
        id: lp.externalId || lp.id,
        name: lp.name,
        status: lp.status,
        created_at: lp.created_at,
        published_url: lp.published_url,
      })),
    });
  } catch (err) {
    console.error('[LP Agent] Status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;

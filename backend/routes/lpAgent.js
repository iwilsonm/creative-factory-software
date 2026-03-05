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
import { generateAndValidateLP, NARRATIVE_FRAMES } from '../services/lpGenerator.js';
import { runGauntlet } from '../services/lpAutoGenerator.js';
import { getProjectProgress } from '../services/gauntletProgress.js';
import { uploadBuffer } from '../convexClient.js';
import { publishAndSmokeTest } from '../services/lpPublisher.js';
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
      'default_author_name', 'default_author_title', 'default_warning_text',
      'visual_qa_enabled',
      'gauntlet_score_threshold', 'gauntlet_max_image_retries', 'gauntlet_max_lp_retries',
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
  console.log(`[LP Agent] generate-test: project=${projectId?.slice(0, 8)}, template=${template_id?.slice(0, 8)}, frame=${narrative_frame}`);

  if (!template_id || !narrative_frame || !angle_description) {
    return res.status(400).json({ error: 'template_id, narrative_frame, and angle_description are required' });
  }

  // Validate narrative frame (synchronous — safe before SSE)
  const frame = NARRATIVE_FRAMES.find(f => f.id === narrative_frame);
  if (!frame) {
    return res.status(400).json({ error: `Invalid narrative_frame. Must be one of: ${NARRATIVE_FRAMES.map(f => f.id).join(', ')}` });
  }

  // Open SSE stream IMMEDIATELY — prevents nginx 504 timeouts.
  // All subsequent errors are sent as SSE error events, not HTTP status codes.
  const { sendEvent, end, isClosed } = createSSEStream(req, res);
  sendEvent({ type: 'progress', step: 'initializing', message: 'Initializing...' });
  console.log(`[LP Agent] generate-test: SSE stream open`);

  try {
    // Validate template exists and is ready
    sendEvent({ type: 'progress', step: 'validating', message: 'Validating template...' });
    const template = await getLPTemplate(template_id);
    if (!template || template.status !== 'ready') {
      sendEvent({ type: 'error', message: 'Template not found or not ready' });
      end();
      return;
    }

    // Load agent config for settings
    const agentConfig = await getLPAgentConfig(projectId).catch(() => null);

    // Create LP record
    sendEvent({ type: 'progress', step: 'creating_record', message: 'Creating landing page record...' });
    const lpId = uuidv4();
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

    sendEvent({ type: 'started', page_id: lpId });
    console.log(`[LP Agent] generate-test: LP record created (${lpId.slice(0, 8)}), starting pipeline...`);

    // Generate with QA validation + auto-fix loop
    const visualQAEnabled = agentConfig?.visual_qa_enabled !== false;
    const { result, qaReport, fixLog, generationAttempts, fixAttempts } = await generateAndValidateLP({
      projectId,
      templateId: template_id,
      angle: angle_description,
      narrativeFrame: frame.instruction,
      batchJobId: null,
      editorialPassEnabled: agentConfig?.editorial_pass_enabled !== false,
      useProductReferenceImages: agentConfig?.use_product_reference_images !== false,
      agentConfig,
    }, sendEvent, { visualQAEnabled });

    // Handle failed generation (all QA attempts exhausted)
    if (!result) {
      await updateLandingPage(lpId, {
        status: 'failed',
        error_message: 'All generation attempts failed visual QA',
        qa_status: 'failed',
        qa_report: qaReport ? JSON.stringify({ ...qaReport, screenshotBuffer: undefined }) : undefined,
        qa_score: qaReport?.score,
        qa_issues_count: qaReport?.issues?.length ?? 0,
        generation_attempts: generationAttempts,
        fix_attempts: fixAttempts,
      });
      sendEvent({ type: 'error', message: `LP generation failed QA after ${generationAttempts} attempts. No LP produced.` });
      end();
      return;
    }

    // Update LP with generated content
    const updateFields = {
      status: 'draft',
      copy_sections: JSON.stringify(result.copySections || []),
      image_slots: JSON.stringify(result.imageSlots || []),
      html_template: result.htmlTemplate || '',
      assembled_html: result.assembledHtml || '',
      generation_attempts: generationAttempts,
      fix_attempts: fixAttempts,
    };
    if (result.designAnalysis) {
      updateFields.swipe_design_analysis = JSON.stringify(result.designAnalysis);
    }

    // Persist audit trail + editorial plan
    if (result.auditTrail) updateFields.audit_trail = JSON.stringify(result.auditTrail);
    if (result.editorialPlan) updateFields.editorial_plan = JSON.stringify(result.editorialPlan);

    // Save QA results
    if (qaReport) {
      let qaScreenshotStorageId = null;
      if (qaReport.screenshotBuffer) {
        qaScreenshotStorageId = await uploadBuffer(qaReport.screenshotBuffer, 'image/jpeg');
      }
      updateFields.qa_status = qaReport.passed ? 'passed' : 'failed';
      updateFields.qa_score = qaReport.score;
      updateFields.qa_report = JSON.stringify({ ...qaReport, screenshotBuffer: undefined, checked_at: new Date().toISOString() });
      updateFields.qa_issues_count = qaReport.issues.length;
      if (qaScreenshotStorageId) updateFields.qa_screenshot_storageId = qaScreenshotStorageId;
    }
    await updateLandingPage(lpId, updateFields);

    // Auto-publish + smoke test (only if QA passed and Shopify configured)
    let publishedUrl = null;
    const shouldAutoPublish = agentConfig?.auto_publish !== false;
    const qaOk = !qaReport || qaReport.passed;
    if (shouldAutoPublish && qaOk && agentConfig?.shopify_access_token && agentConfig?.shopify_store_domain) {
      try {
        sendEvent({ type: 'phase', phase: 'publishing', message: 'Publishing to Shopify...' });
        const { publishResult, smokeResult } = await publishAndSmokeTest(lpId, projectId, {
          pdpUrl: agentConfig?.pdp_url,
        });
        publishedUrl = smokeResult?.passed !== false ? publishResult.published_url : null;

        if (smokeResult && !smokeResult.passed) {
          sendEvent({ type: 'progress', message: `Smoke test failed (${smokeResult.failedCount} checks). LP reverted to draft.` });
        } else {
          sendEvent({ type: 'phase', phase: 'verifying', message: 'Published and verified!' });
        }
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
      qa_passed: qaReport?.passed ?? null,
      qa_issues_count: qaReport?.issues?.length ?? 0,
      qa_score: qaReport?.score ?? null,
      generation_attempts: generationAttempts,
      fix_attempts: fixAttempts,
      fix_log: fixLog,
    });
    console.log(`[LP Agent] generate-test: complete (${lpId.slice(0, 8)})`);
  } catch (err) {
    console.error('[LP Agent] Generate test error:', err.message);
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

// ── Gauntlet Progress (polling) ──

/**
 * GET /api/projects/:id/lp-agent/gauntlet-progress
 * Returns current gauntlet progress from in-memory store.
 * Lightweight — no DB calls, safe to poll every 3s.
 */
router.get('/:id/lp-agent/gauntlet-progress', (req, res) => {
  const progress = getProjectProgress(req.params.id);
  res.json({ progress: progress || null });
});

// ── Gauntlet Test ──

/**
 * POST /api/projects/:id/lp-agent/gauntlet-test
 * Run the LP Gauntlet — generate 5 LPs (one per narrative frame) with
 * pre-scoring, template caching, scoring, and targeted retries.
 * SSE stream.
 */
router.post('/:id/lp-agent/gauntlet-test', async (req, res) => {
  const projectId = req.params.id;
  const { dry_run = false } = req.body;
  console.log(`[LP Agent] gauntlet-test: project=${projectId?.slice(0, 8)}, dry_run=${dry_run}`);

  // Open SSE stream IMMEDIATELY
  const { sendEvent, end, isClosed } = createSSEStream(req, res);
  sendEvent({ type: 'progress', step: 'initializing', message: 'Starting LP Gauntlet...' });

  try {
    const report = await runGauntlet(projectId, { dryRun: !!dry_run }, sendEvent);

    sendEvent({
      type: 'complete',
      report,
    });
    console.log(`[LP Agent] gauntlet-test: complete — ${report.summary.passed}/${report.summary.total} passed, ${report.summary.published} published`);
  } catch (err) {
    console.error('[LP Agent] Gauntlet test error:', err.message);
    sendEvent({ type: 'error', message: err.message });
  } finally {
    end();
  }
});

export default router;

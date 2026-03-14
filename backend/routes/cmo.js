import { Router } from 'express';
import { streamService } from '../utils/sseHelper.js';
import {
  getCmoConfig,
  upsertCmoConfig,
  getCmoRuns,
  getCmoRun,
  getCmoAngleHistory,
  getCmoAngleHistoryByAngle,
  getCmoNotifications,
  acknowledgeCmoNotification,
  acknowledgeAllCmoNotifications,
} from '../convexClient.js';
import { runCmoReview, applyDryRunDecisions } from '../services/cmoEngine.js';
import { testConnection as testTwConnection } from '../services/tripleWhale.js';
import { testConnection as testGa4Connection } from '../services/ga4.js';

const router = Router();

// ── Config ────────────────────────────────────────────────────────────────

// GET CMO config for project
router.get('/config/:projectId', async (req, res) => {
  try {
    const config = await getCmoConfig(req.params.projectId);
    if (!config) return res.json({ config: null });

    // Redact sensitive fields
    const redacted = { ...config };
    if (redacted.tw_api_key) redacted.tw_api_key = '***configured***';
    if (redacted.ga4_credentials_json) redacted.ga4_credentials_json = '***configured***';

    res.json({ config: redacted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT update CMO config
router.put('/config/:projectId', async (req, res) => {
  try {
    const allowedFields = [
      'enabled', 'review_schedule', 'review_day_of_week', 'review_hour_utc',
      'target_cpa', 'min_highest_angles', 'evaluation_window_days',
      'meta_campaign_id', 'tracking_start_date',
      'tw_api_key', 'tw_shopify_domain',
      'ga4_property_id', 'ga4_credentials_json',
      'notifications_enabled', 'auto_execute',
    ];

    const fields = {};
    for (const key of allowedFields) {
      if (req.body[key] !== undefined) fields[key] = req.body[key];
    }

    await upsertCmoConfig(req.params.projectId, fields);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Runs ──────────────────────────────────────────────────────────────────

// POST manual run (SSE stream)
router.post('/run/:projectId', async (req, res) => {
  streamService(req, res, async (sendEvent) => {
    await runCmoReview(req.params.projectId, 'manual', sendEvent);
  });
});

// POST dry run (SSE stream)
router.post('/dry-run/:projectId', async (req, res) => {
  streamService(req, res, async (sendEvent) => {
    await runCmoReview(req.params.projectId, 'dry_run', sendEvent);
  });
});

// GET run history
router.get('/runs/:projectId', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const runs = await getCmoRuns(req.params.projectId, limit);
    res.json({ runs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET single run detail
router.get('/runs/:projectId/:runId', async (req, res) => {
  try {
    const run = await getCmoRun(req.params.runId);
    if (!run || run.project_id !== req.params.projectId) {
      return res.status(404).json({ error: 'Run not found' });
    }
    res.json({ run });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST apply pending decisions from dry run
router.post('/runs/:projectId/:runId/apply', async (req, res) => {
  try {
    const result = await applyDryRunDecisions(req.params.projectId, req.params.runId);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── History ──────────────────────────────────────────────────────────────────

// GET angle history ledger
router.get('/history/:projectId', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 500;
    const history = await getCmoAngleHistory(req.params.projectId, limit);
    res.json({ history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET history for specific angle
router.get('/history/:projectId/:angleName', async (req, res) => {
  try {
    const history = await getCmoAngleHistoryByAngle(
      req.params.projectId,
      decodeURIComponent(req.params.angleName)
    );
    res.json({ history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Notifications ────────────────────────────────────────────────────────────

// GET notifications
router.get('/notifications/:projectId', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const notifications = await getCmoNotifications(req.params.projectId, limit);
    // Sort: unacknowledged first, then by created_at desc
    notifications.sort((a, b) => {
      if (a.acknowledged !== b.acknowledged) return a.acknowledged ? 1 : -1;
      return (b.created_at || '').localeCompare(a.created_at || '');
    });
    res.json({ notifications });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT acknowledge notification
router.put('/notifications/:notifId/acknowledge', async (req, res) => {
  try {
    await acknowledgeCmoNotification(req.params.notifId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST acknowledge all notifications
router.post('/notifications/:projectId/acknowledge-all', async (req, res) => {
  try {
    await acknowledgeAllCmoNotifications(req.params.projectId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Dashboard ────────────────────────────────────────────────────────────────

// GET aggregated dashboard data
router.get('/dashboard/:projectId', async (req, res) => {
  try {
    const [config, runs, history, notifications] = await Promise.all([
      getCmoConfig(req.params.projectId),
      getCmoRuns(req.params.projectId, 5),
      getCmoAngleHistory(req.params.projectId, 500),
      getCmoNotifications(req.params.projectId, 20),
    ]);

    // Get latest run's data
    const latestRun = runs[0] || null;
    let angleEvaluations = [];
    let twSummary = null;
    let lpDiagnostics = [];

    if (latestRun) {
      try { angleEvaluations = JSON.parse(latestRun.angle_evaluations || '[]'); } catch {}
      try { twSummary = JSON.parse(latestRun.tw_summary || 'null'); } catch {}
      try { lpDiagnostics = JSON.parse(latestRun.lp_diagnostics || '[]'); } catch {}
    }

    // Tier breakdown
    const tierBreakdown = { T1: 0, T2: 0, T3: 0, T4: 0, too_early: 0 };
    for (const e of angleEvaluations) {
      if (tierBreakdown[e.tier] !== undefined) tierBreakdown[e.tier]++;
    }

    // Totals
    const totalSpend = angleEvaluations.reduce((s, e) => s + (e.spend || 0), 0);
    const totalConversions = angleEvaluations.reduce((s, e) => s + (e.conversions || 0), 0);
    const totalConversionValue = angleEvaluations.reduce((s, e) => s + (e.conversionValue || 0), 0);
    const overallCpa = totalConversions > 0 ? totalSpend / totalConversions : null;
    const overallRoas = totalSpend > 0 ? totalConversionValue / totalSpend : null;

    const unacknowledgedNotifs = notifications.filter(n => !n.acknowledged);

    // Redact config
    const redactedConfig = config ? { ...config } : null;
    if (redactedConfig) {
      if (redactedConfig.tw_api_key) redactedConfig.tw_api_key = '***configured***';
      if (redactedConfig.ga4_credentials_json) redactedConfig.ga4_credentials_json = '***configured***';
    }

    res.json({
      config: redactedConfig,
      latestRun: latestRun ? {
        externalId: latestRun.externalId,
        run_type: latestRun.run_type,
        status: latestRun.status,
        run_at: latestRun.run_at,
        duration_ms: latestRun.duration_ms,
        decisions_count: latestRun.decisions_count,
        decisions_applied: latestRun.decisions_applied,
      } : null,
      tierBreakdown,
      totalSpend: Math.round(totalSpend * 100) / 100,
      totalConversions,
      overallCpa: overallCpa ? Math.round(overallCpa * 100) / 100 : null,
      overallRoas: overallRoas ? Math.round(overallRoas * 100) / 100 : null,
      angleEvaluations,
      twSummary,
      lpDiagnostics,
      unacknowledgedNotifications: unacknowledgedNotifs.length,
      recentNotifications: unacknowledgedNotifs.slice(0, 5),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Connection Tests ─────────────────────────────────────────────────────────

// GET test Triple Whale connection
router.get('/tw-test/:projectId', async (req, res) => {
  try {
    const config = await getCmoConfig(req.params.projectId);
    if (!config?.tw_api_key || !config?.tw_shopify_domain) {
      return res.status(400).json({ error: 'Triple Whale API key and Shopify domain required' });
    }
    const result = await testTwConnection(config.tw_api_key, config.tw_shopify_domain);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET test GA4 connection
router.get('/ga4-test/:projectId', async (req, res) => {
  try {
    const config = await getCmoConfig(req.params.projectId);
    if (!config?.ga4_credentials_json || !config?.ga4_property_id) {
      return res.status(400).json({ error: 'GA4 credentials and property ID required' });
    }
    const result = await testGa4Connection(config.ga4_credentials_json, config.ga4_property_id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

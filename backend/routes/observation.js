// Phase 3 — Observation tab routes (config, ad-set timeline, manual mark,
// pause/resume/extend, archived angles, admin manual cron trigger).
// All require auth + admin/manager unless otherwise noted.

import { Router } from 'express';
import { requireAuth, requireRole } from '../auth.js';
import {
  getProject,
  convexClient,
  api,
  setSetting,
  getSetting,
  getAllSettings,
} from '../convexClient.js';
import {
  resolveProjectBenchmark,
  effectiveDaysObserved,
  effectiveWindow,
  applyManualMark,
  runObservationSweep,
  runAllProjectsObservation,
  DEFAULTS,
} from '../services/observationTracker.js';

const router = Router();
router.use(requireAuth);

// ────────────────────────────────────────────────
// Config
// ────────────────────────────────────────────────

const SETTINGS_KEYS = [
  'phase3_observation_enabled',
  'phase3_observation_window_days',
  'phase3_benchmark_min_spend',
  'phase3_benchmark_primary_gate',
  'phase3_benchmark_roas_min',
  'phase3_benchmark_cpa_max',
  'phase3_benchmark_ctr_min',
  'phase3_benchmark_action_type',
  'phase3_archive_consecutive_fails',
  'phase3_archive_min_unique_posting_days',
  'phase3_archive_min_sample',
  'phase3_archive_pass_rate',
];

function validateConfigUpdate(body) {
  const errs = [];
  const out = {};

  const num = (key, min, max) => {
    if (body[key] == null || body[key] === '') return;
    const n = parseFloat(body[key]);
    if (!Number.isFinite(n) || n < min || n > max) {
      errs.push(`${key} must be a number between ${min} and ${max}`);
    } else {
      out[key] = String(n);
    }
  };

  if (body.observation_enabled != null) {
    out.phase3_observation_enabled = String(body.observation_enabled === true || body.observation_enabled === 'true');
  }
  num('observation_window_days', 1, 60);
  if (out.observation_window_days != null) { out.phase3_observation_window_days = out.observation_window_days; delete out.observation_window_days; }

  num('benchmark_min_spend', 0, 1_000_000);
  if (out.benchmark_min_spend != null) { out.phase3_benchmark_min_spend = out.benchmark_min_spend; delete out.benchmark_min_spend; }

  if (body.benchmark_primary_gate && !['roas', 'cpa'].includes(body.benchmark_primary_gate)) {
    errs.push('benchmark_primary_gate must be "roas" or "cpa"');
  } else if (body.benchmark_primary_gate) {
    out.phase3_benchmark_primary_gate = body.benchmark_primary_gate;
  }

  num('benchmark_roas_min', 0, 1000);
  if (out.benchmark_roas_min != null) { out.phase3_benchmark_roas_min = out.benchmark_roas_min; delete out.benchmark_roas_min; }
  num('benchmark_cpa_max', 0, 1_000_000);
  if (out.benchmark_cpa_max != null) { out.phase3_benchmark_cpa_max = out.benchmark_cpa_max; delete out.benchmark_cpa_max; }

  if (body.benchmark_ctr_min === '' || body.benchmark_ctr_min == null) {
    if (body.benchmark_ctr_min === '') out.phase3_benchmark_ctr_min = '';
  } else {
    const n = parseFloat(body.benchmark_ctr_min);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      errs.push('benchmark_ctr_min must be between 0 and 1 (or empty for no floor)');
    } else {
      out.phase3_benchmark_ctr_min = String(n);
    }
  }

  if (body.benchmark_action_type) out.phase3_benchmark_action_type = body.benchmark_action_type;

  num('archive_consecutive_fails', 1, 100);
  if (out.archive_consecutive_fails != null) { out.phase3_archive_consecutive_fails = out.archive_consecutive_fails; delete out.archive_consecutive_fails; }
  num('archive_min_unique_posting_days', 1, 30);
  if (out.archive_min_unique_posting_days != null) { out.phase3_archive_min_unique_posting_days = out.archive_min_unique_posting_days; delete out.archive_min_unique_posting_days; }
  num('archive_min_sample', 1, 100);
  if (out.archive_min_sample != null) { out.phase3_archive_min_sample = out.archive_min_sample; delete out.archive_min_sample; }
  num('archive_pass_rate', 0, 1);
  if (out.archive_pass_rate != null) { out.phase3_archive_pass_rate = out.archive_pass_rate; delete out.archive_pass_rate; }

  return { errs, out };
}

router.get('/:projectId/observation/config', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const benchmark = await resolveProjectBenchmark(req.params.projectId);
    const versionRaw = await getSetting(`phase3_benchmark_version:${req.params.projectId}`);
    const version = versionRaw ? parseInt(versionRaw, 10) : 1;
    res.json({
      benchmark,
      version,
      account_currency: project.meta_account_currency || 'USD',
      defaults: DEFAULTS,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:projectId/observation/config', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { errs, out } = validateConfigUpdate(req.body || {});
    if (errs.length > 0) return res.status(400).json({ error: errs.join('; ') });

    for (const [k, v] of Object.entries(out)) {
      await setSetting(`${k}:${req.params.projectId}`, String(v));
    }

    // Bump benchmark_version
    const versionRaw = await getSetting(`phase3_benchmark_version:${req.params.projectId}`);
    const version = versionRaw ? parseInt(versionRaw, 10) + 1 : 2;
    await setSetting(`phase3_benchmark_version:${req.params.projectId}`, String(version));

    res.json({ success: true, version });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Auto-suggest defaults from project's last 90d Meta insights.
router.post('/:projectId/observation/suggest', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const project = await convexClient.query(api.projects.getByExternalId, { externalId: req.params.projectId });
    if (!project?.meta_access_token || !project?.meta_account_id) {
      return res.status(400).json({ error: 'Connect Meta + select an ad account first.' });
    }
    // Fetch last 90d account-level insights
    const fetch = (await import('node-fetch')).default;
    const params = new URLSearchParams({
      access_token: project.meta_access_token,
      level: 'account',
      fields: 'spend,purchase_roas,actions,cost_per_action_type',
      date_preset: 'last_90d',
    }).toString();
    const url = `https://graph.facebook.com/v25.0/${project.meta_account_id}/insights?${params}`;
    const resp = await fetch(url);
    const body = await resp.json();
    if (!resp.ok || body?.error) {
      return res.status(500).json({ error: body?.error?.message || `HTTP ${resp.status}` });
    }
    const row = (body.data || [])[0];
    if (!row) return res.json({ suggestion: DEFAULTS, note: 'No 90d insights yet — using defaults.' });

    const spend = parseFloat(row.spend || 0);
    const roasRow = (row.purchase_roas || []).find((r) => r.action_type === 'purchase') || row.purchase_roas?.[0];
    const roas = roasRow ? parseFloat(roasRow.value) : 1.5;
    const dailyAvgSpend = spend / 90;
    const suggestedMinSpend = Math.max(2, Math.round(dailyAvgSpend * 4 * 100) / 100); // ~4 days of avg daily spend
    const suggestedRoas = Math.max(0.5, Math.round((roas * 0.85) * 10) / 10); // 85% of project median

    res.json({
      suggestion: {
        ...DEFAULTS,
        min_spend: suggestedMinSpend,
        roas_min: suggestedRoas,
      },
      based_on: {
        last_90d_spend: spend,
        last_90d_median_roas: roas,
        daily_avg_spend: dailyAvgSpend,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────
// Ad-set timeline + manual actions
// ────────────────────────────────────────────────

const TERMINAL = new Set(['observing', 'passed', 'failed', 'failed_external', 'insufficient_data']);

router.get('/:projectId/observation/ad-sets', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const all = await convexClient.query(api.adSets.getByProject, { projectId: req.params.projectId });
    const filtered = (all || []).filter((a) => TERMINAL.has(a.lifecycle_status));

    // Attach the latest result row for each
    const enriched = await Promise.all(filtered.map(async (adSet) => {
      const results = await convexClient.query(api.observationResults.getByAdSet, { ad_set_id: adSet.externalId });
      const latest = (results || [])[0]; // already sorted DESC
      const days = effectiveDaysObserved(adSet);
      const benchmark = await resolveProjectBenchmark(req.params.projectId);
      const window = effectiveWindow(adSet, benchmark);
      return {
        ...adSet,
        days_observed: days,
        window_total: window,
        is_paused: !!adSet.observation_paused_at,
        latest_result: latest || null,
      };
    }));
    res.json({ ad_sets: enriched });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:projectId/observation/ad-sets/:adSetId', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const adSet = await convexClient.query(api.adSets.getByExternalId, { externalId: req.params.adSetId });
    if (!adSet) return res.status(404).json({ error: 'Ad set not found' });
    const snapshots = await convexClient.query(api.observationSnapshots.getByAdSet, { ad_set_id: req.params.adSetId });
    const results = await convexClient.query(api.observationResults.getByAdSet, { ad_set_id: req.params.adSetId });
    const benchmark = await resolveProjectBenchmark(req.params.projectId);
    const days = effectiveDaysObserved(adSet);
    const window = effectiveWindow(adSet, benchmark);

    res.json({
      ad_set: {
        ...adSet,
        days_observed: days,
        window_total: window,
        is_paused: !!adSet.observation_paused_at,
      },
      snapshots: (snapshots || []).sort((a, b) => a.day_index - b.day_index),
      results: results || [],
      benchmark,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:projectId/observation/ad-sets/:adSetId/snapshot', requireRole('admin', 'manager'), async (req, res) => {
  try {
    // Force a single-project sweep just for this ad set's project (cron-equivalent)
    const result = await runObservationSweep(req.params.projectId);
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:projectId/observation/ad-sets/:adSetId/mark', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { verdict, reason } = req.body || {};
    if (!['manual_passed', 'manual_failed'].includes(verdict)) {
      return res.status(400).json({ error: 'verdict must be "manual_passed" or "manual_failed"' });
    }
    await applyManualMark({
      projectId: req.params.projectId,
      adSetId: req.params.adSetId,
      verdict,
      reason,
      userId: req.session?.userId,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:projectId/observation/ad-sets/:adSetId/pause', requireRole('admin', 'manager'), async (req, res) => {
  try {
    await convexClient.mutation(api.adSets.pauseObservation, { externalId: req.params.adSetId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:projectId/observation/ad-sets/:adSetId/resume', requireRole('admin', 'manager'), async (req, res) => {
  try {
    await convexClient.mutation(api.adSets.resumeObservation, { externalId: req.params.adSetId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:projectId/observation/ad-sets/:adSetId/extend', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { additional_days } = req.body || {};
    const n = parseInt(additional_days, 10);
    if (!Number.isFinite(n) || n < 1 || n > 60) {
      return res.status(400).json({ error: 'additional_days must be between 1 and 60' });
    }
    await convexClient.mutation(api.adSets.extendObservation, {
      externalId: req.params.adSetId,
      additional_days: n,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────
// Health / freshness
// ────────────────────────────────────────────────

router.get('/:projectId/observation/health', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const all = await convexClient.query(api.adSets.getByProject, { projectId: req.params.projectId });
    const archived = await convexClient.query(api.conductor.getArchivedAngles, { projectId: req.params.projectId });
    const counts = {
      observing: 0, passed: 0, failed: 0, failed_external: 0, insufficient_data: 0,
    };
    for (const a of (all || [])) {
      if (counts[a.lifecycle_status] !== undefined) counts[a.lifecycle_status] += 1;
    }
    res.json({
      counts,
      archived_count: (archived || []).length,
      recently_archived: (archived || [])
        .sort((a, b) => (a.updated_at || 0) < (b.updated_at || 0) ? 1 : -1)
        .slice(0, 10)
        .map((a) => ({ name: a.name, externalId: a.externalId, performance_note: a.performance_note, updated_at: a.updated_at })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────
// Archived angles (read + un-archive)
// ────────────────────────────────────────────────

router.get('/:projectId/angles/archived', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const angles = await convexClient.query(api.conductor.getArchivedAngles, { projectId: req.params.projectId });
    res.json({ angles: angles || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:projectId/angles/:angleId/archive', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { reason } = req.body || {};
    await convexClient.mutation(api.conductor.archiveAngle, {
      externalId: req.params.angleId,
      performance_note: reason || 'manual',
      source: 'manual',
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:projectId/angles/:angleId/unarchive', requireRole('admin', 'manager'), async (req, res) => {
  try {
    await convexClient.mutation(api.conductor.unarchiveAngle, { externalId: req.params.angleId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────
// Admin — manual cron trigger + freshness
// ────────────────────────────────────────────────

router.post('/admin/observation/cron-run', requireRole('admin'), async (req, res) => {
  try {
    const dryRun = req.query.dry_run === '1' || req.query.dry_run === 'true';
    const result = await runAllProjectsObservation({ dryRun });
    res.json({ success: true, dry_run: dryRun, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/observation/last-cron', requireRole('admin'), async (req, res) => {
  try {
    const lastRunRaw = await getSetting('phase3_last_cron_run_at');
    const durationRaw = await getSetting('phase3_last_cron_duration_ms');
    const statusRaw = await getSetting('phase3_last_cron_status');
    res.json({
      last_run_at: lastRunRaw ? parseInt(lastRunRaw, 10) : null,
      duration_ms: durationRaw ? parseInt(durationRaw, 10) : null,
      status: statusRaw || 'unknown',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

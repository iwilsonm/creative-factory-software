// Phase 3 — Observation tab routes (config, ad-set timeline, manual mark,
// pause/resume/extend, archived angles, admin manual cron trigger).
// All require auth + admin/manager unless otherwise noted.

import { Router } from 'express';
import { randomUUID } from 'crypto';
import { requireAuth, requireRole } from '../auth.js';
import {
  getProject,
  convexClient,
  api,
  getAdSummariesByExternalIds,
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
import {
  deriveSubAnglesForProject,
  computeAngleStatsForProject,
} from '../services/subAngleDeriver.js';

const router = Router();
const adminRouter = Router();
router.use(requireAuth);
adminRouter.use(requireAuth);
const DEMO_OBSERVATION_NAME = '[Demo] Observation Test Ad Set';
const DEMO_CAMPAIGN_NAME = '[Demo] Observation Campaign';

function latestByAdSet(results) {
  const map = new Map();
  for (const result of results || []) {
    const existing = map.get(result.ad_set_id);
    if (!existing || (result.created_at || '') > (existing.created_at || '')) {
      map.set(result.ad_set_id, result);
    }
  }
  return map;
}

function metricFromLatest(adSet, latest) {
  const source = latest || {};
  return {
    spend: Number(source.spend || 0),
    impressions: Number(source.impressions || 0),
    reach: Number(source.reach || 0),
    clicks: Number(source.clicks || 0),
    ctr: Number(source.ctr || 0),
    cpm: Number(source.cpm || 0),
    cpc: Number(source.cpc || 0),
    roas: source.roas ?? null,
    cpa: source.cpa ?? null,
    conversions: source.conversions ?? null,
    purchase_count: source.conversions ?? null,
    cost_per_purchase: source.cpa ?? null,
    account_currency: source.account_currency || adSet.account_currency || 'USD',
  };
}

async function buildObservationContext(projectId) {
  const [campaigns, angles, deployments, results] = await Promise.all([
    convexClient.query(api.campaigns.getByProject, { projectId }),
    convexClient.query(api.conductor.getAngles, { projectId }),
    convexClient.query(api.ad_deployments.getByProject, { projectId }),
    convexClient.query(api.observationResults.getByProject, { projectId }),
  ]);
  const adIds = [...new Set((deployments || []).map((d) => d.ad_id).filter(Boolean))];
  const adSummaries = await getAdSummariesByExternalIds(adIds);
  const campaignById = new Map((campaigns || []).map((c) => [c.externalId, c]));
  const angleById = new Map((angles || []).map((a) => [a.externalId, a]));
  const adById = new Map((adSummaries || []).map((a) => [a.id, a]));
  const deploymentsByAdSet = new Map();

  for (const deployment of deployments || []) {
    if (!deployment.local_adset_id) continue;
    const list = deploymentsByAdSet.get(deployment.local_adset_id) || [];
    list.push(deployment);
    deploymentsByAdSet.set(deployment.local_adset_id, list);
  }

  return {
    campaignById,
    angleById,
    adById,
    deploymentsByAdSet,
    latestResultsByAdSet: latestByAdSet(results),
  };
}

function childRowsForAdSet(projectId, adSet, context) {
  const campaign = context.campaignById.get(adSet.campaign_id);
  const angle = adSet.angle_id ? context.angleById.get(adSet.angle_id) : null;
  return (context.deploymentsByAdSet.get(adSet.externalId) || []).map((deployment) => {
    const creative = context.adById.get(deployment.ad_id) || {};
    const angleName = creative.angle_name || creative.angle || angle?.name || '';
    const imageUrl = creative.hasImage && deployment.ad_id
      ? `/api/deployments/ad-image/${projectId}/${deployment.ad_id}`
      : null;
    return {
      id: deployment.externalId,
      externalId: deployment.externalId,
      entity_type: 'ad',
      entity_id_kind: 'cf',
      name: deployment.ad_name || creative.headline || deployment.externalId,
      ad_id: deployment.ad_id,
      adset_id: adSet.externalId,
      adset_name: adSet.name,
      campaign_id: adSet.campaign_id,
      campaign_name: campaign?.name || deployment.campaign_name || '',
      angle_name: angleName,
      status: deployment.status || '',
      headline: creative.headline || '',
      body_copy: creative.body_copy || '',
      destination_url: deployment.destination_url || deployment.landing_page_url || '',
      cta_button: deployment.cta_button || '',
      notes: deployment.notes || '',
      thumbnail_url: imageUrl,
      image_url: imageUrl,
      created_at: deployment.created_at || '',
      posted_at: deployment.posted_date || adSet.posted_at || '',
    };
  });
}

function enrichObservationAdSet(projectId, adSet, context, benchmark) {
  const latest = context.latestResultsByAdSet.get(adSet.externalId) || null;
  const campaign = context.campaignById.get(adSet.campaign_id);
  const angle = adSet.angle_id ? context.angleById.get(adSet.angle_id) : null;
  const days = effectiveDaysObserved(adSet);
  const window = effectiveWindow(adSet, benchmark);
  const children = childRowsForAdSet(projectId, adSet, context);
  return {
    ...adSet,
    id: adSet.externalId,
    entity_type: 'ad_set',
    entity_id_kind: 'cf',
    campaign_name: campaign?.name || '',
    campaign_id: adSet.campaign_id || '',
    angle_name: angle?.name || '',
    days_observed: days,
    window_total: window,
    child_count: children.length,
    children,
    is_paused: !!adSet.observation_paused_at,
    latest_result: latest,
    ...metricFromLatest(adSet, latest),
  };
}

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
    const [benchmark, context] = await Promise.all([
      resolveProjectBenchmark(req.params.projectId),
      buildObservationContext(req.params.projectId),
    ]);
    const enriched = filtered.map((adSet) =>
      enrichObservationAdSet(req.params.projectId, adSet, context, benchmark)
    );
    res.json({ ad_sets: enriched });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:projectId/observation/demo-ad-set', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const now = new Date();
    const nowIso = now.toISOString();
    const postedAt = new Date(now.getTime() - 3 * 86400000).toISOString();
    const accountCurrency = project.meta_account_currency || 'USD';

    const adSets = await convexClient.query(api.adSets.getByProject, { projectId: req.params.projectId });
    let demo = (adSets || []).find((a) => a.is_demo && a.name === DEMO_OBSERVATION_NAME);
    const campaignId = await convexClient.mutation(api.campaigns.upsertByProjectAndName, {
      project_id: req.params.projectId,
      name: DEMO_CAMPAIGN_NAME,
    });

    if (!demo) {
      const externalId = randomUUID();
      await convexClient.mutation(api.adSets.create, {
        externalId,
        campaign_id: campaignId,
        project_id: req.params.projectId,
        name: DEMO_OBSERVATION_NAME,
        sort_order: (adSets || []).length,
        lifecycle_status: 'observing',
        posted_at: postedAt,
        meta_adset_id: `demo_${externalId}`,
        meta_campaign_id: 'demo_campaign',
        meta_post_path: 'demo',
        is_demo: true,
        created_at: nowIso,
        updated_at: nowIso,
      });
      demo = await convexClient.query(api.adSets.getByExternalId, { externalId });
    } else {
      await convexClient.mutation(api.adSets.update, {
        externalId: demo.externalId,
        fields: {
          campaign_id: demo.campaign_id || campaignId,
          lifecycle_status: 'observing',
          posted_at: demo.posted_at || postedAt,
          meta_adset_id: demo.meta_adset_id || `demo_${demo.externalId}`,
          meta_campaign_id: demo.meta_campaign_id || 'demo_campaign',
          meta_post_path: 'demo',
          is_demo: true,
        },
      });
      demo = await convexClient.query(api.adSets.getByExternalId, { externalId: demo.externalId });
    }

    const daily = [
      { day: 1, spend: 24.5, impressions: 3200, clicks: 58, roas: 1.15, conversions: 2 },
      { day: 2, spend: 31.25, impressions: 4100, clicks: 86, roas: 1.84, conversions: 4 },
      { day: 3, spend: 29.8, impressions: 3900, clicks: 79, roas: 2.12, conversions: 5 },
    ];
    for (const row of daily) {
      const ctr = row.impressions > 0 ? (row.clicks / row.impressions) * 100 : 0;
      await convexClient.mutation(api.observationSnapshots.upsertByAdSetAndDay, {
        externalId: `demo-snapshot:${demo.externalId}:${row.day}`,
        project_id: req.params.projectId,
        ad_set_id: demo.externalId,
        meta_adset_id: demo.meta_adset_id || `demo_${demo.externalId}`,
        day_index: row.day,
        snapshot_at: new Date(now.getTime() - (3 - row.day) * 86400000).toISOString(),
        spend: row.spend,
        impressions: row.impressions,
        clicks: row.clicks,
        ctr,
        cpm: row.impressions > 0 ? (row.spend / row.impressions) * 1000 : 0,
        cpc: row.clicks > 0 ? row.spend / row.clicks : 0,
        roas: row.roas,
        cpa: row.conversions > 0 ? row.spend / row.conversions : undefined,
        conversions: row.conversions,
        raw_insights: JSON.stringify({ demo: true, source: 'observation-demo-seed' }),
        account_currency: accountCurrency,
      });
    }

    const benchmark = await resolveProjectBenchmark(req.params.projectId);
    const versionRaw = await getSetting(`phase3_benchmark_version:${req.params.projectId}`);
    const version = versionRaw ? parseInt(versionRaw, 10) : 1;
    const totals = daily.reduce((acc, row) => ({
      spend: acc.spend + row.spend,
      impressions: acc.impressions + row.impressions,
      clicks: acc.clicks + row.clicks,
      conversions: acc.conversions + row.conversions,
    }), { spend: 0, impressions: 0, clicks: 0, conversions: 0 });
    await convexClient.mutation(api.observationResults.create, {
      externalId: `demo-result:${demo.externalId}`,
      project_id: req.params.projectId,
      ad_set_id: demo.externalId,
      posted_at: demo.posted_at || postedAt,
      observed_through: nowIso,
      days_observed: 3,
      verdict: 'insufficient_data',
      fail_reason_code: 'demo',
      spend: totals.spend,
      impressions: totals.impressions,
      clicks: totals.clicks,
      ctr: totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0,
      roas: 1.74,
      cpa: totals.conversions > 0 ? totals.spend / totals.conversions : undefined,
      conversions: totals.conversions,
      benchmark_used: JSON.stringify({ ...benchmark, demo: true }),
      benchmark_version: version,
      reason: 'Demo-only observation data. This ad set is not connected to Meta.',
      evaluated_by: `user_${req.session?.userId || 'demo'}`,
      account_currency: accountCurrency,
    });

    res.json({ success: true, ad_set_id: demo.externalId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:projectId/observation/seed-demo', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const projectId = req.params.projectId;
    const project = await getProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const now = new Date();
    const nowIso = now.toISOString();
    const currency = project.meta_account_currency || 'USD';

    const existingAdSets = await convexClient.query(api.adSets.getByProject, { projectId });
    for (const a of (existingAdSets || []).filter((x) => x.is_demo)) {
      await convexClient.mutation(api.adSets.remove, { externalId: a.externalId });
    }

    const campaignId = await convexClient.mutation(api.campaigns.upsertByProjectAndName, {
      project_id: projectId,
      name: DEMO_CAMPAIGN_NAME,
    });

    const SEED = [
      { name: 'Grounding Bedsheet — Sleep Pain', angle: 'Sleep Pain Relief', status: 'observing', days: 4, spend: 142, roas: 1.85 },
      { name: 'Grounding Mat — Energy Focus', angle: 'Energy & Focus', status: 'observing', days: 7, spend: 310, roas: 2.35 },
      { name: 'Recovery Patch — Athletes', angle: 'Athletic Recovery', status: 'observing', days: 2, spend: 68, roas: 0.92 },
      { name: 'Bedsheet — Chronic Inflammation', angle: 'Sleep Pain Relief', status: 'passed', days: 14, spend: 520, roas: 3.10 },
      { name: 'Mat — Desk Worker Fatigue', angle: 'Energy & Focus', status: 'failed', days: 14, spend: 380, roas: 0.65 },
      { name: 'Patch — Weekend Warrior', angle: 'Athletic Recovery', status: 'insufficient_data', days: 9, spend: 18, roas: 0 },
      { name: 'Bedsheet — Joint Stiffness', angle: 'Sleep Pain Relief', status: 'passed', days: 21, spend: 640, roas: 2.80 },
      { name: 'Mat — Morning Energy', angle: 'Energy & Focus', status: 'failed', days: 21, spend: 290, roas: 0.55 },
      { name: 'Bedsheet — Deep Sleep', angle: 'Sleep Pain Relief', status: 'passed', days: 28, spend: 410, roas: 3.50 },
      { name: 'Patch — Recovery After Run', angle: 'Athletic Recovery', status: 'failed', days: 28, spend: 350, roas: 0.42 },
    ];

    const angleIds = {};
    for (const s of SEED) {
      if (!angleIds[s.angle]) {
        const existing = await convexClient.query(api.conductor.getAngles, { projectId });
        const found = (existing || []).find((a) => a.name === s.angle && !a.archived_at);
        if (found) {
          angleIds[s.angle] = found.externalId;
        } else {
          const eid = randomUUID();
          await convexClient.mutation(api.conductor.createAngle, {
            externalId: eid,
            project_id: projectId,
            name: s.angle,
            description: `Demo angle: ${s.angle}`,
            source: 'demo-seed',
            status: 'active',
          });
          angleIds[s.angle] = eid;
        }
      }
    }

    const created = [];
    for (const s of SEED) {
      const eid = randomUUID();
      const postedAt = new Date(now.getTime() - s.days * 86400000).toISOString();
      await convexClient.mutation(api.adSets.create, {
        externalId: eid,
        campaign_id: campaignId,
        project_id: projectId,
        name: s.name,
        sort_order: created.length,
        lifecycle_status: s.status,
        posted_at: postedAt,
        meta_adset_id: `demo_${eid}`,
        meta_campaign_id: 'demo_campaign',
        meta_post_path: 'demo',
        is_demo: true,
        angle_id: angleIds[s.angle],
        created_at: nowIso,
        updated_at: nowIso,
      });

      const resultVerdict = s.status === 'observing' ? undefined : s.status;
      if (resultVerdict) {
        await convexClient.mutation(api.observationResults.create, {
          externalId: `demo-result:${eid}`,
          project_id: projectId,
          ad_set_id: eid,
          posted_at: postedAt,
          observed_through: nowIso,
          days_observed: s.days,
          verdict: resultVerdict,
          fail_reason_code: 'demo',
          spend: s.spend,
          impressions: Math.round(s.spend * 130),
          clicks: Math.round(s.spend * 2.3),
          ctr: 1.77,
          roas: s.roas,
          conversions: Math.round(s.spend * s.roas / 35),
          benchmark_used: JSON.stringify({ demo: true }),
          benchmark_version: 1,
          reason: `Demo seed: ${s.status}`,
          evaluated_by: 'demo-seed',
          account_currency: currency,
        });
      }

      created.push({ id: eid, name: s.name, status: s.status, angle: s.angle });
    }

    res.json({ success: true, created });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:projectId/observation/ad-sets/:adSetId', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const adSet = await convexClient.query(api.adSets.getByExternalId, { externalId: req.params.adSetId });
    if (!adSet) return res.status(404).json({ error: 'Ad set not found' });
    const [snapshots, results, benchmark, context] = await Promise.all([
      convexClient.query(api.observationSnapshots.getByAdSet, { ad_set_id: req.params.adSetId }),
      convexClient.query(api.observationResults.getByAdSet, { ad_set_id: req.params.adSetId }),
      resolveProjectBenchmark(req.params.projectId),
      buildObservationContext(req.params.projectId),
    ]);

    res.json({
      ad_set: enrichObservationAdSet(req.params.projectId, adSet, context, benchmark),
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
// Phase 4 — Sub-angles + lineage + manual derive trigger
// ────────────────────────────────────────────────

router.post('/:projectId/angles/:angleId/derive-now', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const result = await deriveSubAnglesForProject(req.params.projectId, {
      parentAngleId: req.params.angleId,
      force: true,
    });
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:projectId/angles/:angleId/sub-angles', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const children = await convexClient.query(api.conductor.getSubAnglesByParent, {
      parent_angle_id: req.params.angleId,
    });
    res.json({ sub_angles: children || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:projectId/angles/:angleId/lineage', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const lineage = await convexClient.query(api.conductor.getLineage, {
      angle_external_id: req.params.angleId,
    });
    res.json({ lineage: lineage || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:projectId/angles/:angleId/lineage', requireRole('admin'), async (req, res) => {
  try {
    const result = await convexClient.mutation(api.conductor.deleteAngleAndDescendants, {
      externalId: req.params.angleId,
    });
    res.json({ success: true, removed: result.removed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:projectId/angles/recently-derived', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const sinceMs = Date.now() - parseInt(req.query.days || '7', 10) * 86400000;
    const derived = await convexClient.query(api.conductor.getRecentlyDerived, {
      projectId: req.params.projectId,
      since_ms: sinceMs,
    });
    res.json({ derived: derived || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:projectId/angles/pending-review', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const pending = await convexClient.query(api.conductor.getPendingReviewAngles, {
      projectId: req.params.projectId,
    });
    res.json({ angles: pending || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:projectId/angles/:angleId/approve', requireRole('admin', 'manager'), async (req, res) => {
  try {
    await convexClient.mutation(api.conductor.approveSubAngle, { externalId: req.params.angleId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:projectId/angles/:angleId/reject', requireRole('admin', 'manager'), async (req, res) => {
  try {
    await convexClient.mutation(api.conductor.rejectSubAngle, { externalId: req.params.angleId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin — recompute angle stats out-of-band (useful for testing).
adminRouter.post('/projects/:projectId/recompute-angle-stats', requireRole('admin'), async (req, res) => {
  try {
    const result = await computeAngleStatsForProject(req.params.projectId);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────
// Admin — manual cron trigger + freshness
// ────────────────────────────────────────────────

adminRouter.post('/observation/cron-run', requireRole('admin'), async (req, res) => {
  try {
    const dryRun = req.query.dry_run === '1' || req.query.dry_run === 'true';
    const result = await runAllProjectsObservation({ dryRun });
    res.json({ success: true, dry_run: dryRun, result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

adminRouter.get('/observation/last-cron', requireRole('admin'), async (req, res) => {
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

export { adminRouter as observationAdminRouter };
export default router;

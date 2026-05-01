// Phase 3 — Observation orchestrator. Daily Vercel cron entrypoint.
//
// Runs five named phases per project:
//   [phase=token_refresh]  refresh tokens expiring <7d (best-effort)
//   [phase=snapshot]       upsert per-day insights snapshots for observing ad sets
//   [phase=evaluate]       for ad sets at terminal day count, run benchmarkScorer
//                           and write observation_results (idempotent)
//   [phase=archive]        on each newly-failed result with angle_id, run angleArchiver
//   [phase=cleanup]        purge observation_snapshots > 90d post-terminal
//
// Concurrency=3 across projects, 20s soft budget per project. Per-project
// try/catch — one project's failure doesn't kill the whole run.

import { v4 as uuidv4 } from 'uuid';
import fetch from 'node-fetch';
import { withRetry } from './retry.js';
import {
  getAllProjects,
  getProjectRawForMeta,
  updateProject,
  convexClient,
  api,
  upsertDashboardTodo,
  setSetting,
  getSetting,
} from '../convexClient.js';
import { refreshLongLivedToken, isTokenInvalidError } from './metaApi.js';
import { ensureAccountCurrency } from './observationCurrency.js';
import { scoreObservation } from './benchmarkScorer.js';
import { evaluateAngleHealth } from './angleArchiver.js';

const GRAPH_BASE = 'https://graph.facebook.com/v25.0';
const PER_PROJECT_BUDGET_MS = 20_000;
const TOKEN_REFRESH_AHEAD_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SNAPSHOT_RETENTION_DAYS = 90;
const PROJECT_CONCURRENCY = 3;

const TERMINAL_LIFECYCLES = new Set(['passed', 'failed', 'failed_external', 'insufficient_data']);

// ────────────────────────────────────────────────────────
// Settings helpers — composite benchmark resolution
// ────────────────────────────────────────────────────────

const DEFAULTS = {
  enabled: true,
  window_days: 12,
  min_spend: 2,
  primary_gate: 'roas',
  roas_min: 1.5,
  cpa_max: 40,
  ctr_min: '',  // empty = no CTR floor
  action_type: 'purchase',
  benchmark_version: 1,
  archive_consecutive_fails: 5,
  archive_min_unique_posting_days: 1,
  archive_min_sample: 5,
  archive_pass_rate: 0.25,
};

export async function resolveProjectBenchmark(projectId) {
  const keys = [
    'phase3_observation_enabled',
    'phase3_observation_window_days',
    'phase3_benchmark_min_spend',
    'phase3_benchmark_primary_gate',
    'phase3_benchmark_roas_min',
    'phase3_benchmark_cpa_max',
    'phase3_benchmark_ctr_min',
    'phase3_benchmark_action_type',
    'phase3_benchmark_version',
    'phase3_archive_consecutive_fails',
    'phase3_archive_min_unique_posting_days',
    'phase3_archive_min_sample',
    'phase3_archive_pass_rate',
  ];
  const out = { ...DEFAULTS };
  for (const k of keys) {
    const raw = await getSetting(`${k}:${projectId}`);
    if (raw == null || raw === '') continue;
    const shortKey = k.replace('phase3_', '').replace('observation_', '').replace('benchmark_', '').replace('archive_', '');
    if (k === 'phase3_observation_enabled') {
      out.enabled = raw === 'true' || raw === true;
    } else if (k === 'phase3_observation_window_days' || k === 'phase3_archive_consecutive_fails' || k === 'phase3_archive_min_unique_posting_days' || k === 'phase3_archive_min_sample' || k === 'phase3_benchmark_version') {
      out[shortKey] = parseInt(raw, 10) || DEFAULTS[shortKey];
    } else if (k === 'phase3_benchmark_min_spend' || k === 'phase3_benchmark_roas_min' || k === 'phase3_benchmark_cpa_max' || k === 'phase3_archive_pass_rate') {
      out[shortKey] = parseFloat(raw);
    } else if (k === 'phase3_benchmark_ctr_min') {
      out.ctr_min = raw === '' ? '' : parseFloat(raw);
    } else {
      out[shortKey] = raw;
    }
  }
  return out;
}

// ────────────────────────────────────────────────────────
// Day index math (account-tz approximated as UTC for v1)
// ────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

function effectiveDaysObserved(adSet, now = Date.now()) {
  if (!adSet.posted_at) return 0;
  const postedMs = new Date(adSet.posted_at).getTime();
  const pausedTotal = adSet.observation_paused_total_ms || 0;
  const currentlyPausedAdditional = adSet.observation_paused_at
    ? Math.max(0, now - new Date(adSet.observation_paused_at).getTime())
    : 0;
  const elapsed = Math.max(0, now - postedMs - pausedTotal - currentlyPausedAdditional);
  return Math.floor(elapsed / DAY_MS);
}

function effectiveWindow(adSet, benchmark) {
  return (benchmark.window_days || DEFAULTS.window_days) + (adSet.extension_days || 0);
}

// ────────────────────────────────────────────────────────
// Meta insights — one call per ad set with time_increment=1
// ────────────────────────────────────────────────────────

async function fetchAdSetInsights(token, metaAdsetId, sinceISO) {
  const since = sinceISO.slice(0, 10);
  const until = new Date().toISOString().slice(0, 10);
  const fields = [
    'spend', 'impressions', 'clicks', 'reach', 'frequency',
    'ctr', 'cpm', 'cpc', 'cpp',
    'actions', 'action_values', 'cost_per_action_type',
    'purchase_roas',
  ].join(',');

  // Two requests in parallel: one for daily breakdown (snapshots), one
  // for lifetime aggregate (terminal evaluation).
  const dailyParams = new URLSearchParams({
    access_token: token,
    fields,
    time_range: JSON.stringify({ since, until }),
    time_increment: '1',
  }).toString();
  const lifetimeParams = new URLSearchParams({
    access_token: token,
    fields,
    time_range: JSON.stringify({ since, until }),
  }).toString();

  const [dailyResp, lifetimeResp] = await Promise.all([
    withRetry(() => fetch(`${GRAPH_BASE}/${metaAdsetId}/insights?${dailyParams}`), { label: `[obs daily ${metaAdsetId}]` }),
    withRetry(() => fetch(`${GRAPH_BASE}/${metaAdsetId}/insights?${lifetimeParams}`), { label: `[obs lifetime ${metaAdsetId}]` }),
  ]);

  const dailyBody = await dailyResp.json();
  const lifetimeBody = await lifetimeResp.json();

  // Special handling for "ad set not found" → failed_external
  for (const body of [dailyBody, lifetimeBody]) {
    if (body?.error) {
      const code = body.error.code;
      const message = body.error.message || '';
      if (code === 100 || /does not exist|not found/i.test(message)) {
        const e = new Error(`Ad set not found on Meta: ${message}`);
        e.code = 'ADSET_NOT_FOUND';
        throw e;
      }
      const e = new Error(`Meta API error: ${message}`);
      e.code = body.error.code;
      throw e;
    }
  }

  const daily = Array.isArray(dailyBody.data) ? dailyBody.data : [];
  const lifetime = Array.isArray(lifetimeBody.data) && lifetimeBody.data.length > 0
    ? lifetimeBody.data[0]
    : null;

  return { daily, lifetime };
}

// ────────────────────────────────────────────────────────
// Phases
// ────────────────────────────────────────────────────────

async function phaseTokenRefresh(project, log) {
  if (!project.meta_token_expires_at) return;
  const remaining = project.meta_token_expires_at - Date.now();
  if (remaining > TOKEN_REFRESH_AHEAD_MS) return;

  const clientId = process.env.META_APP_ID;
  const clientSecret = process.env.META_APP_SECRET;
  if (!clientId || !clientSecret) {
    log('token_refresh', 'env META_APP_ID / META_APP_SECRET missing — skipping');
    return;
  }
  try {
    const refreshed = await refreshLongLivedToken({
      clientId, clientSecret, currentToken: project.meta_access_token,
    });
    await updateProject(project.externalId, {
      meta_access_token: refreshed.access_token,
      meta_token_expires_at: Date.now() + (refreshed.expires_in * 1000),
    });
    log('token_refresh', `refreshed; new expiry ${new Date(Date.now() + refreshed.expires_in * 1000).toISOString()}`);
  } catch (err) {
    log('token_refresh', `failed: ${err.message}`);
    await upsertDashboardTodo({
      externalId: `phase3-token-${project.externalId}`,
      text: `Reconnect Meta for project "${project.name || project.externalId}"`,
      notes: 'Phase 3 observation cannot run until you reconnect Meta. Go to Project Settings → Meta.',
      author: 'Phase 3 Observation',
      priority: 0,
      sort_order: Date.now(),
    }).catch(() => {});
    throw err;
  }
}

async function phaseSnapshotAndEvaluate(project, benchmark, currency, log, opts = {}) {
  const dryRun = opts.dryRun || false;
  const now = Date.now();
  const adSets = await convexClient.query(api.adSets.getByProjectAndLifecycle, {
    projectId: project.externalId,
    lifecycle_status: 'observing',
  });
  log('snapshot', `${adSets?.length || 0} observing ad sets`);

  let processed = 0;
  let evaluated = 0;
  let archives = 0;
  const newlyFailedAngles = new Set();
  const startMs = Date.now();

  for (const adSet of (adSets || [])) {
    if (Date.now() - startMs > PER_PROJECT_BUDGET_MS) {
      log('snapshot', `budget exceeded; deferring ${adSets.length - processed} ad sets to next tick`);
      break;
    }
    if (!adSet.meta_adset_id || !adSet.posted_at) continue;

    // Skip if currently paused — counter is frozen
    if (adSet.observation_paused_at) {
      log('snapshot', `ad_set=${adSet.externalId.slice(0, 8)} paused; skipping`);
      continue;
    }

    const days = effectiveDaysObserved(adSet, now);
    const windowEffective = effectiveWindow(adSet, benchmark);

    let insights;
    try {
      insights = await fetchAdSetInsights(project.meta_access_token, adSet.meta_adset_id, adSet.posted_at);
    } catch (err) {
      if (err.code === 'ADSET_NOT_FOUND') {
        // Mark as failed_external and write terminal result if not already
        log('snapshot', `ad_set=${adSet.externalId.slice(0, 8)} failed_external (Meta deletion)`);
        if (!dryRun) {
          await writeTerminalResult({
            project, adSet, benchmark, currency,
            verdict: 'failed_external',
            fail_reason_code: 'external_deletion',
            reason: `Ad set deleted on Meta side after ${days} day${days === 1 ? '' : 's'} — counted as failure for archive accounting.`,
            metricsLifetime: null,
            daysObserved: days,
          });
          if (adSet.angle_id) newlyFailedAngles.add(adSet.angle_id);
        }
        continue;
      }
      if (isTokenInvalidError(err)) throw err; // bubble — full project token issue
      log('snapshot', `ad_set=${adSet.externalId.slice(0, 8)} insights error: ${err.message}`);
      continue;
    }

    // Upsert daily snapshots
    if (!dryRun) {
      for (const dailyRow of insights.daily) {
        const dayIndex = computeDayIndex(adSet.posted_at, dailyRow.date_start);
        if (dayIndex < 1) continue;
        await convexClient.mutation(api.observationSnapshots.upsertByAdSetAndDay, {
          externalId: uuidv4(),
          project_id: project.externalId,
          ad_set_id: adSet.externalId,
          meta_adset_id: adSet.meta_adset_id,
          day_index: dayIndex,
          snapshot_at: new Date().toISOString(),
          spend: parseFloat(dailyRow.spend || 0),
          impressions: parseFloat(dailyRow.impressions || 0),
          clicks: parseFloat(dailyRow.clicks || 0),
          ctr: parseFloat(dailyRow.ctr || 0),
          cpm: parseFloat(dailyRow.cpm || 0),
          cpc: parseFloat(dailyRow.cpc || 0),
          roas: pickRoas(dailyRow, benchmark.action_type),
          cpa: pickCpa(dailyRow, benchmark.action_type),
          conversions: pickConversions(dailyRow, benchmark.action_type),
          raw_insights: JSON.stringify(dailyRow),
          account_currency: currency,
        }).catch((err) => log('snapshot', `upsert failed ${adSet.externalId.slice(0, 8)} day ${dayIndex}: ${err.message}`));
      }
    }

    processed += 1;

    // Terminal evaluation if window complete
    if (days >= windowEffective && insights.lifetime) {
      const score = scoreObservation({
        insights: insights.lifetime,
        benchmark,
        daysObserved: days,
        accountCurrency: currency,
      });

      log('evaluate', `ad_set=${adSet.externalId.slice(0, 8)} verdict=${score.verdict} ${score.fail_reason_code || ''} → ${score.reason}`);

      if (!dryRun) {
        const existing = await convexClient.query(api.observationResults.getTerminalByAdSet, { ad_set_id: adSet.externalId });
        if (existing) {
          // Idempotent — already evaluated. Still ensure lifecycle state matches.
          continue;
        }
        await writeTerminalResult({
          project, adSet, benchmark, currency,
          verdict: score.verdict,
          fail_reason_code: score.fail_reason_code,
          reason: score.reason,
          metricsLifetime: score.metrics,
          daysObserved: days,
        });
        if (score.verdict === 'failed' && adSet.angle_id) newlyFailedAngles.add(adSet.angle_id);
      }
      evaluated += 1;
    }
  }

  // Archive phase
  for (const angleId of newlyFailedAngles) {
    if (dryRun) continue;
    try {
      const result = await evaluateAngleHealth(project.externalId, angleId, {
        archive_min_sample: benchmark.min_sample,
        archive_min_unique_posting_days: benchmark.min_unique_posting_days,
      });
      log('archive', `angle=${angleId.slice(0, 8)} archived=${result.archived} reason="${result.reason}"`);
      if (result.archived) archives += 1;
    } catch (err) {
      log('archive', `angle=${angleId.slice(0, 8)} error: ${err.message}`);
    }
  }

  return { processed, evaluated, archives };
}

async function writeTerminalResult({ project, adSet, benchmark, currency, verdict, fail_reason_code, reason, metricsLifetime, daysObserved }) {
  const m = metricsLifetime || { spend: 0, impressions: 0, clicks: 0, ctrFraction: 0, roas: 0, cpa: 0, conversions: 0 };
  await convexClient.mutation(api.observationResults.create, {
    externalId: uuidv4(),
    project_id: project.externalId,
    ad_set_id: adSet.externalId,
    angle_id: adSet.angle_id,
    posted_at: adSet.posted_at,
    observed_through: new Date().toISOString(),
    days_observed: daysObserved,
    verdict,
    fail_reason_code: fail_reason_code || undefined,
    spend: m.spend,
    impressions: m.impressions,
    clicks: m.clicks,
    ctr: m.ctrFraction * 100,
    roas: m.roas || undefined,
    cpa: m.cpa || undefined,
    conversions: m.conversions || undefined,
    benchmark_used: JSON.stringify(benchmark),
    benchmark_version: benchmark.version || 1,
    reason,
    evaluated_by: 'cron',
    account_currency: currency,
  });
  await convexClient.mutation(api.adSets.setLifecycleTerminal, {
    externalId: adSet.externalId,
    verdict,
  });
}

function computeDayIndex(postedAtISO, dailyDateISO) {
  // dailyDateISO is "YYYY-MM-DD" from Meta's time_increment=1 breakdown.
  // Day 1 = the calendar date matching posted_at's UTC day.
  const postedDay = postedAtISO.slice(0, 10);
  const a = new Date(`${postedDay}T00:00:00Z`).getTime();
  const b = new Date(`${dailyDateISO}T00:00:00Z`).getTime();
  return Math.floor((b - a) / DAY_MS) + 1;
}

function pickRoas(row, actionType) {
  const arr = row.purchase_roas;
  if (!Array.isArray(arr)) return undefined;
  const match = arr.find((r) => r?.action_type === actionType);
  return match ? parseFloat(match.value) : (arr[0] ? parseFloat(arr[0].value) : undefined);
}

function pickCpa(row, actionType) {
  const arr = row.cost_per_action_type;
  if (!Array.isArray(arr)) return undefined;
  const match = arr.find((r) => r?.action_type === actionType);
  return match ? parseFloat(match.value) : undefined;
}

function pickConversions(row, actionType) {
  const arr = row.actions;
  if (!Array.isArray(arr)) return undefined;
  const match = arr.find((r) => r?.action_type === actionType);
  return match ? parseFloat(match.value) : undefined;
}

async function phaseCleanup(log) {
  const cutoffMs = Date.now() - SNAPSHOT_RETENTION_DAYS * DAY_MS;
  const cutoffISO = new Date(cutoffMs).toISOString();
  const purged = await convexClient.mutation(api.observationSnapshots.purgeOlderThan, {
    cutoff_iso: cutoffISO,
  });
  log('cleanup', `purged ${purged} snapshot rows older than ${SNAPSHOT_RETENTION_DAYS}d (terminal-only)`);
}

// ────────────────────────────────────────────────────────
// Entry points
// ────────────────────────────────────────────────────────

export async function runObservationSweep(projectId, opts = {}) {
  const dryRun = opts.dryRun || false;
  const project = await getProjectRawForMeta(projectId);
  if (!project) throw new Error(`Project ${projectId} not found`);

  const benchmark = await resolveProjectBenchmark(projectId);
  if (!benchmark.enabled) {
    return { skipped: true, reason: 'observation disabled' };
  }
  if (!project.meta_access_token || !project.meta_account_id) {
    return { skipped: true, reason: 'no Meta connection' };
  }

  const startedAt = Date.now();
  const log = (phase, msg) => {
    console.log(`[obs project=${project.externalId.slice(0, 8)} phase=${phase}${dryRun ? ' DRYRUN' : ''}] ${msg}`);
  };

  try {
    if (!dryRun) await phaseTokenRefresh(project, log);
    const refreshed = await getProjectRawForMeta(projectId); // re-fetch in case token was refreshed
    const currency = await ensureAccountCurrency(refreshed);
    const result = await phaseSnapshotAndEvaluate(refreshed, benchmark, currency, log, { dryRun });
    return { ...result, durationMs: Date.now() - startedAt, currency };
  } catch (err) {
    log('error', err.message);
    return { error: err.message, durationMs: Date.now() - startedAt };
  }
}

// Cron entrypoint — fans out across all projects with concurrency=3.
export async function runAllProjectsObservation(opts = {}) {
  const dryRun = opts.dryRun || false;
  const startedAt = Date.now();
  const projects = await getAllProjects();
  const results = {};

  // Process in chunks of PROJECT_CONCURRENCY
  for (let i = 0; i < projects.length; i += PROJECT_CONCURRENCY) {
    const chunk = projects.slice(i, i + PROJECT_CONCURRENCY);
    const settled = await Promise.allSettled(
      chunk.map((p) => runObservationSweep(p.id, { dryRun }))
    );
    settled.forEach((s, idx) => {
      const projId = chunk[idx].id;
      results[projId] = s.status === 'fulfilled' ? s.value : { error: s.reason?.message || 'unknown' };
    });
  }

  // Final cleanup phase (project-agnostic — runs once per cron tick)
  if (!dryRun) {
    try {
      await phaseCleanup((phase, msg) => console.log(`[obs phase=${phase}] ${msg}`));
    } catch (err) {
      console.warn(`[obs phase=cleanup] failed: ${err.message}`);
    }
  }

  const durationMs = Date.now() - startedAt;
  if (!dryRun) {
    await setSetting('phase3_last_cron_run_at', String(Date.now()));
    await setSetting('phase3_last_cron_duration_ms', String(durationMs));
    await setSetting('phase3_last_cron_status', 'ok');
  }

  return {
    durationMs,
    projectsProcessed: projects.length,
    results,
  };
}

// Manual mark — used by /observation/ad-sets/:adSetId/mark
export async function applyManualMark({ projectId, adSetId, verdict, reason, userId }) {
  const adSet = await convexClient.query(api.adSets.getByExternalId, { externalId: adSetId });
  if (!adSet) throw new Error('Ad set not found');
  const benchmark = await resolveProjectBenchmark(projectId);
  const project = await getProjectRawForMeta(projectId);
  const currency = await ensureAccountCurrency(project);
  const days = effectiveDaysObserved(adSet);

  const previousTerminal = await convexClient.query(api.observationResults.getTerminalByAdSet, { ad_set_id: adSetId });

  await convexClient.mutation(api.observationResults.createManualOverride, {
    externalId: uuidv4(),
    project_id: projectId,
    ad_set_id: adSetId,
    angle_id: adSet.angle_id,
    posted_at: adSet.posted_at || new Date().toISOString(),
    observed_through: new Date().toISOString(),
    days_observed: days,
    verdict,
    spend: 0, impressions: 0, clicks: 0, ctr: 0,
    benchmark_used: JSON.stringify(benchmark),
    benchmark_version: benchmark.version || 1,
    reason: reason || `Manual override by user`,
    evaluated_by: userId ? `user_${userId}` : 'manual',
    account_currency: currency || 'USD',
    replaces_external_id: previousTerminal?.externalId,
  });

  await convexClient.mutation(api.adSets.setLifecycleTerminal, {
    externalId: adSetId,
    verdict: verdict === 'manual_passed' ? 'passed' : 'failed',
  });

  // Trigger angle archive evaluation on manual_failed
  if (verdict === 'manual_failed' && adSet.angle_id) {
    await evaluateAngleHealth(projectId, adSet.angle_id, {
      archive_min_sample: benchmark.min_sample,
      archive_min_unique_posting_days: benchmark.min_unique_posting_days,
    });
  }
}

// Exported for routes
export { effectiveDaysObserved, effectiveWindow, DEFAULTS };

/**
 * CMO Engine — Chief Marketing Officer Agent
 *
 * 8-step weekly review cycle:
 * 1. Pull Triple Whale blended metrics
 * 2. Pull Meta ad-level data with destination URLs
 * 3. Evaluate angles: tier classification + spend classification
 * 4. LP diagnostic: cross-reference with GA4 landing page data
 * 5. Update angle history ledger (append-only)
 * 6. Apply 7 decision rules
 * 7. Execute priority changes + write new angles
 * 8. Pipeline health check + notifications
 */

import { v4 as uuidv4 } from 'uuid';
import {
  getCmoConfig,
  getAllCmoConfigs,
  createCmoRun,
  updateCmoRun,
  getCmoAngleHistory,
  getCmoAngleHistoryByAngle,
  createCmoAngleHistory,
  createCmoNotification,
  getConductorAngles,
  getActiveConductorAngles,
  updateConductorAngle,
} from '../convexClient.js';
import { fetchBlendedMetrics, buildStandardPeriods } from './tripleWhale.js';
import { fetchLandingPageMetrics, crossReferenceWithMeta } from './ga4.js';
import { aggregateAnglePerformance, classifyTier, classifySpend, detectTrend } from './angleEvaluator.js';
import { generateNewAngles } from './angleWriter.js';

// ── Main entry: cycle across all enabled projects ───────────────────────────

/**
 * Run the CMO review cycle for all enabled projects.
 * Called by the scheduler cron job.
 */
export async function runCmoCycle() {
  const configs = await getAllCmoConfigs();
  const enabledProjects = configs.filter(c => c.enabled && c.review_schedule !== 'manual_only');

  const now = new Date();
  const currentDay = now.getUTCDay();
  const currentHour = now.getUTCHours();

  for (const config of enabledProjects) {
    // Check if now is the right day/hour for this project
    if (config.review_day_of_week !== currentDay) continue;
    if (Math.abs(config.review_hour_utc - currentHour) > 0) continue;

    try {
      console.log(`[CMO] Starting weekly review for project ${config.project_id.slice(0, 8)}`);
      await runCmoReview(config.project_id, 'weekly');
    } catch (err) {
      console.error(`[CMO] Weekly review failed for project ${config.project_id.slice(0, 8)}:`, err.message);
    }
  }
}

// ── Single project review ────────────────────────────────────────────────────

/**
 * Run a CMO review for a single project.
 *
 * @param {string} projectId
 * @param {string} runType - "weekly" | "manual" | "dry_run"
 * @param {function} [sendEvent] - Optional SSE event emitter
 * @returns {Promise<object>} The run record
 */
export async function runCmoReview(projectId, runType = 'manual', sendEvent) {
  const emit = sendEvent || (() => {});
  const startTime = Date.now();
  const runId = uuidv4();
  const isDryRun = runType === 'dry_run';

  // Create run record
  await createCmoRun({
    externalId: runId,
    project_id: projectId,
    run_type: runType,
    status: 'running',
    run_at: new Date().toISOString(),
  });

  const config = await getCmoConfig(projectId);
  if (!config) {
    await updateCmoRun(runId, { status: 'failed', error: 'CMO not configured', error_stage: 'init' });
    emit({ type: 'error', message: 'CMO not configured for this project' });
    return;
  }

  try {
    // ── Step 1: Triple Whale blended metrics ──────────────────────────────
    emit({ type: 'progress', step: 'triple_whale', message: 'Pulling Triple Whale blended metrics...' });
    let twSummary = null;
    if (config.tw_api_key && config.tw_shopify_domain) {
      try {
        const periods = buildStandardPeriods();
        twSummary = await fetchBlendedMetrics(config.tw_api_key, config.tw_shopify_domain, periods);
      } catch (err) {
        console.warn(`[CMO] Triple Whale fetch failed: ${err.message}`);
        twSummary = { error: err.message };
      }
    } else {
      twSummary = { skipped: 'Triple Whale not configured' };
    }

    // ── Step 2: Meta ad-level data ────────────────────────────────────────
    emit({ type: 'progress', step: 'meta_data', message: 'Pulling Meta ad performance data...' });
    let metaAds = [];
    let angleEvaluations = [];

    if (config.meta_campaign_id) {
      // Get deployments, flex ads, batch jobs for tracing
      const { getAllDeployments, getAllFlexAds, getAllBatchJobs } = await import('../convexClient.js');
      const [allDeps, allFlex, allBatches] = await Promise.all([
        getAllDeployments(),
        getAllFlexAds ? getAllFlexAds() : Promise.resolve([]),
        getAllBatchJobs ? getAllBatchJobs() : Promise.resolve([]),
      ]);

      const projectDeps = allDeps.filter(d => d.project_id === projectId);
      const projectFlex = allFlex.filter(f => f.project_id === projectId);
      const projectBatches = allBatches.filter(b => b.project_id === projectId);

      const result = await aggregateAnglePerformance(projectId, config.meta_campaign_id, {
        trackingStartDate: config.tracking_start_date,
        targetCpa: config.target_cpa || 50,
        evaluationWindowDays: config.evaluation_window_days || 12,
        deployments: projectDeps,
        flexAds: projectFlex,
        batchJobs: projectBatches,
      });

      metaAds = result.metaAds;
      angleEvaluations = result.angleEvaluations;
    }

    await updateCmoRun(runId, {
      meta_ads_count: metaAds.length,
      angle_evaluations: JSON.stringify(angleEvaluations),
    });

    // ── Step 3: Evaluate angles ───────────────────────────────────────────
    emit({ type: 'progress', step: 'evaluate_angles', message: `Evaluated ${angleEvaluations.length} angles...` });

    // ── Step 4: LP diagnostic ─────────────────────────────────────────────
    emit({ type: 'progress', step: 'lp_diagnostic', message: 'Running LP diagnostics...' });
    let lpDiagnostics = [];
    let ga4PagesCount = 0;

    if (config.ga4_property_id && config.ga4_credentials_json) {
      try {
        const now = new Date();
        const d30ago = new Date(now);
        d30ago.setDate(d30ago.getDate() - 30);

        const ga4Pages = await fetchLandingPageMetrics(
          config.ga4_credentials_json,
          config.ga4_property_id,
          {
            startDate: d30ago.toISOString().slice(0, 10),
            endDate: now.toISOString().slice(0, 10),
            limit: 200,
          }
        );
        ga4PagesCount = ga4Pages.length;
        lpDiagnostics = crossReferenceWithMeta(metaAds, ga4Pages);
      } catch (err) {
        console.warn(`[CMO] GA4 fetch failed: ${err.message}`);
        lpDiagnostics = [{ error: err.message }];
      }
    }

    await updateCmoRun(runId, {
      ga4_pages_count: ga4PagesCount,
      lp_diagnostics: JSON.stringify(lpDiagnostics),
      tw_summary: JSON.stringify(twSummary),
    });

    // ── Step 5: Update angle history ledger ───────────────────────────────
    emit({ type: 'progress', step: 'update_ledger', message: 'Updating angle history ledger...' });
    const today = new Date().toISOString().slice(0, 10);

    // Get existing history for trend detection
    const existingHistory = await getCmoAngleHistory(projectId);

    for (const evaluation of angleEvaluations) {
      if (evaluation.angleName === 'untraced') continue;

      // Compute trends from history
      const angleHistory = existingHistory.filter(h => h.angle_name === evaluation.angleName);
      const spendTrend = detectTrend(angleHistory.map(h => h.spend));
      const cpaTrend = evaluation.cpa != null
        ? detectTrend(angleHistory.filter(h => h.cpa != null).map(h => h.cpa))
        : 'flat';

      // Find LP diagnostic data for this angle
      const lpData = lpDiagnostics.find(d =>
        d.ga4_found && d.angles?.includes(evaluation.angleName)
      );

      await createCmoAngleHistory({
        externalId: uuidv4(),
        project_id: projectId,
        angle_name: evaluation.angleName,
        snapshot_date: today,
        cmo_run_id: runId,
        spend: evaluation.spend,
        impressions: evaluation.impressions,
        clicks: evaluation.clicks,
        conversions: evaluation.conversions,
        conversion_value: evaluation.conversionValue,
        cpa: evaluation.cpa,
        roas: evaluation.roas,
        ctr: evaluation.ctr,
        cpc: evaluation.cpc,
        tier: evaluation.tier,
        spend_class: evaluation.spendClass,
        priority_at_snapshot: evaluation.priority,
        status_at_snapshot: evaluation.status,
        ad_count: evaluation.adCount,
        days_active: evaluation.daysActive,
        spend_trend: spendTrend,
        cpa_trend: cpaTrend,
        lp_bounce_rate: lpData?.bounce_rate,
        lp_cvr: lpData?.cvr,
        lp_sessions: lpData?.sessions,
      });
    }

    // ── Step 6: Apply 7 decision rules ────────────────────────────────────
    emit({ type: 'progress', step: 'decision_rules', message: 'Applying decision rules...' });

    const decisions = await applyDecisionRules(projectId, angleEvaluations, existingHistory, lpDiagnostics, config);

    await updateCmoRun(runId, {
      decisions: JSON.stringify(decisions),
      decisions_count: decisions.length,
    });

    // ── Step 7: Execute changes ───────────────────────────────────────────
    emit({ type: 'progress', step: 'execute_changes', message: isDryRun ? 'Dry run — skipping execution...' : 'Executing priority changes...' });

    let anglesWritten = [];
    if (!isDryRun && (config.auto_execute || runType === 'manual')) {
      for (const decision of decisions) {
        if (decision.action === 'change_priority' && decision.angleName && decision.newPriority) {
          try {
            const angles = await getConductorAngles(projectId);
            const angle = angles.find(a => a.name === decision.angleName);
            if (angle) {
              await updateConductorAngle(angle.externalId, { priority: decision.newPriority });
            }
          } catch (err) {
            console.error(`[CMO] Failed to update priority for ${decision.angleName}:`, err.message);
          }
        }

        if (decision.action === 'write_new_angles' && decision.frame) {
          try {
            const winningAngles = angleEvaluations.filter(
              e => e.frame === decision.frame && e.tier === 'T1'
            );
            const newAngles = await generateNewAngles({
              projectId,
              frame: decision.frame,
              winningAngles,
              count: decision.count || 3,
            });
            anglesWritten.push(...newAngles);
          } catch (err) {
            console.error(`[CMO] Failed to write new angles for frame ${decision.frame}:`, err.message);
          }
        }
      }

      await updateCmoRun(runId, {
        decisions_applied: true,
        angles_written: anglesWritten.length > 0 ? JSON.stringify(anglesWritten) : undefined,
      });
    } else {
      await updateCmoRun(runId, { decisions_applied: false });
    }

    // ── Step 8: Notifications ─────────────────────────────────────────────
    emit({ type: 'progress', step: 'notifications', message: 'Generating notifications...' });

    let notifCount = 0;
    if (config.notifications_enabled) {
      notifCount = await generateNotifications(projectId, runId, {
        twSummary,
        angleEvaluations,
        lpDiagnostics,
        decisions,
        anglesWritten,
        existingHistory,
        config,
      });
    }

    // ── Finalize ──────────────────────────────────────────────────────────
    const duration = Date.now() - startTime;
    await updateCmoRun(runId, {
      status: 'completed',
      duration_ms: duration,
      notifications_sent: notifCount,
    });

    emit({
      type: 'complete',
      runId,
      duration,
      anglesEvaluated: angleEvaluations.length,
      decisionsCount: decisions.length,
      notificationsSent: notifCount,
      anglesWritten: anglesWritten.length,
    });

    return { runId, duration, angleEvaluations, decisions, anglesWritten };

  } catch (err) {
    await updateCmoRun(runId, {
      status: 'failed',
      error: err.message,
      error_stage: err.stage || 'unknown',
      duration_ms: Date.now() - startTime,
    });
    emit({ type: 'error', message: err.message });
    throw err;
  }
}

// ── 7 Decision Rules ──────────────────────────────────────────────────────────

async function applyDecisionRules(projectId, evaluations, history, lpDiagnostics, config) {
  const decisions = [];
  const minHighest = config.min_highest_angles || 8;

  // Get full history per angle for rule evaluation
  const historyByAngle = {};
  for (const h of history) {
    if (!historyByAngle[h.angle_name]) historyByAngle[h.angle_name] = [];
    historyByAngle[h.angle_name].push(h);
  }

  // Sort each angle's history by date
  for (const snapshots of Object.values(historyByAngle)) {
    snapshots.sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));
  }

  // Build LP diagnostic lookup
  const lpByAngle = {};
  for (const lp of lpDiagnostics) {
    if (!lp.angles) continue;
    for (const angle of lp.angles) {
      lpByAngle[angle] = lp;
    }
  }

  // Count current highest-priority angles
  const currentAngles = await getConductorAngles(projectId);
  const highestCount = currentAngles.filter(a => a.priority === 'highest' && a.status === 'active').length;

  for (const evaluation of evaluations) {
    if (evaluation.angleName === 'untraced' || evaluation.tier === 'too_early') continue;

    const angleHist = historyByAngle[evaluation.angleName] || [];
    const lpData = lpByAngle[evaluation.angleName];

    // Rule 7: LP-aware decisions (check FIRST — before any priority lowering)
    if (lpData && lpData.diagnosis && lpData.diagnosis !== 'healthy' && lpData.diagnosis !== 'no_ga4_data') {
      if (evaluation.ctr > 2 && (lpData.diagnosis === 'hook_problem' || lpData.diagnosis === 'lp_not_convincing' || lpData.diagnosis === 'checkout_problem')) {
        decisions.push({
          rule: 'lp_aware',
          action: 'flag_lp',
          angleName: evaluation.angleName,
          reason: `Good CTR (${evaluation.ctr}%) but LP issue: ${lpData.diagnosis_label}. Don't lower angle priority — fix LP instead.`,
          lpDiagnosis: lpData.diagnosis,
        });
        continue; // Skip other rules for this angle
      }
    }

    // Rule 1: Hot streak protection
    if (angleHist.length >= 3) {
      const recent6 = angleHist.slice(-6);
      const profitableWeeks = recent6.filter(h => h.tier === 'T1').length;

      if (profitableWeeks >= 3 && evaluation.tier !== 'T1') {
        const badWeeks = recent6.slice(-3).filter(h => h.tier !== 'T1').length;
        if (badWeeks === 1) {
          decisions.push({
            rule: 'hot_streak',
            action: 'keep',
            angleName: evaluation.angleName,
            reason: `Hot streak: ${profitableWeeks}/6 profitable weeks. One bad week — keeping priority.`,
          });
          continue;
        } else if (badWeeks === 2) {
          decisions.push({
            rule: 'hot_streak',
            action: 'change_priority',
            angleName: evaluation.angleName,
            newPriority: evaluation.priority === 'highest' ? 'high' : 'medium',
            reason: `Hot streak fading: ${profitableWeeks} profitable weeks, but 2 bad weeks. Lowering one tier.`,
          });
          continue;
        }
      }
    }

    // Rule 2: Comeback detection
    if (evaluation.tier === 'T1' && evaluation.priority !== 'highest') {
      const wasDemoted = angleHist.some(h =>
        h.priority_at_snapshot === 'highest' || h.priority_at_snapshot === 'high'
      );
      if (wasDemoted) {
        decisions.push({
          rule: 'comeback',
          action: 'change_priority',
          angleName: evaluation.angleName,
          newPriority: 'high',
          reason: `Comeback: was demoted but showing T1 performance again. Boosting to high.`,
        });
        continue;
      }
    }

    // Rule 3: Fatigue detection
    if (evaluation.tier === 'T1' || evaluation.tier === 'T2') {
      const cpas = angleHist.filter(h => h.cpa != null).map(h => h.cpa);
      if (cpas.length >= 4) {
        const last4 = cpas.slice(-4);
        const isRising = last4.every((v, i) => i === 0 || v >= last4[i - 1]);
        if (isRising) {
          decisions.push({
            rule: 'fatigue',
            action: 'write_new_angles',
            angleName: evaluation.angleName,
            frame: evaluation.frame,
            count: 3,
            reason: `Fatigue detected: CPA rising 4+ consecutive weeks ($${last4[0]} → $${last4[last4.length - 1]}). Writing fresh variations.`,
          });
        }
      }
    }

    // Rule 4: Retirement
    if (angleHist.length >= 24) {
      const first12 = angleHist.slice(0, 12);
      const last12 = angleHist.slice(-12);
      const earlyProfitable = first12.filter(h => h.tier === 'T1').length;
      const recentProfitable = last12.filter(h => h.tier === 'T1').length;

      if (earlyProfitable >= 6 && recentProfitable === 0) {
        decisions.push({
          rule: 'retirement',
          action: 'change_priority',
          angleName: evaluation.angleName,
          newPriority: 'low',
          reason: `Retirement: profitable for 12+ weeks then cold for 12+ weeks. Archiving.`,
        });
        continue;
      }
    }

    // Rule 6: Loser reduction
    if (evaluation.tier === 'T3' || evaluation.tier === 'T4') {
      const hasHistoricalT1 = angleHist.some(h => h.tier === 'T1');
      if (!hasHistoricalT1 && evaluation.priority === 'highest') {
        // Check minimum threshold
        if (highestCount > minHighest) {
          decisions.push({
            rule: 'loser_reduction',
            action: 'change_priority',
            angleName: evaluation.angleName,
            newPriority: 'medium',
            reason: `No T1 performance ever, currently ${evaluation.tier}. Lowering to medium.`,
          });
        }
      }
    }
  }

  // Rule 5: New angle writing (frame-level)
  const frameT1Counts = {};
  for (const e of evaluations) {
    if (e.tier === 'T1' && e.frame) {
      frameT1Counts[e.frame] = (frameT1Counts[e.frame] || 0) + 1;
    }
  }
  for (const [frame, count] of Object.entries(frameT1Counts)) {
    if (count >= 2) {
      // Check if we already have a fatigue-based write for this frame
      const alreadyWriting = decisions.some(d => d.rule === 'fatigue' && d.frame === frame);
      if (!alreadyWriting) {
        decisions.push({
          rule: 'winning_frame',
          action: 'write_new_angles',
          frame,
          count: Math.min(count + 1, 5),
          reason: `Winning frame "${frame}" has ${count} T1 angles. Writing ${Math.min(count + 1, 5)} new variations.`,
        });
      }
    }
  }

  return decisions;
}

// ── Notification Generation ──────────────────────────────────────────────────

async function generateNotifications(projectId, runId, context) {
  const { twSummary, angleEvaluations, lpDiagnostics, decisions, anglesWritten, existingHistory, config } = context;
  let count = 0;

  const notify = async (rule, severity, title, message, angleName, data) => {
    await createCmoNotification({
      externalId: uuidv4(),
      project_id: projectId,
      cmo_run_id: runId,
      rule,
      severity,
      title,
      message,
      angle_name: angleName || undefined,
      data: data ? JSON.stringify(data) : undefined,
    });
    count++;
  };

  // Notification: New T1 breakthrough
  for (const evaluation of angleEvaluations) {
    if (evaluation.tier !== 'T1') continue;
    const history = existingHistory.filter(h => h.angle_name === evaluation.angleName);
    const wasT1Before = history.some(h => h.tier === 'T1');
    if (!wasT1Before && history.length > 0) {
      await notify('new_t1', 'info', 'New T1 Breakthrough',
        `"${evaluation.angleName}" just reached T1! CPA: $${evaluation.cpa}, ROAS: ${evaluation.roas}x`,
        evaluation.angleName, { cpa: evaluation.cpa, roas: evaluation.roas });
    }
  }

  // Notification: 70%+ ads with no spend
  const noSpendCount = angleEvaluations.filter(e => e.tier === 'T4').length;
  const total = angleEvaluations.filter(e => e.tier !== 'too_early').length;
  if (total > 0 && (noSpendCount / total) > 0.7) {
    await notify('ads_no_spend', 'warning', 'Most Ads Not Spending',
      `${noSpendCount}/${total} angles (${Math.round(noSpendCount / total * 100)}%) have zero spend.`,
      undefined, { noSpendCount, total });
  }

  // Notification: Priority changes made
  const priorityChanges = decisions.filter(d => d.action === 'change_priority');
  if (priorityChanges.length > 0) {
    await notify('priority_changes', 'info', 'Priority Changes',
      `${priorityChanges.length} angle priority change(s) applied.`,
      undefined, { changes: priorityChanges.map(d => ({ angle: d.angleName, to: d.newPriority, rule: d.rule })) });
  }

  // Notification: New angles written
  if (anglesWritten && anglesWritten.length > 0) {
    await notify('angles_written', 'info', 'New Angles Created',
      `${anglesWritten.length} new angle(s) generated from winning frames.`,
      undefined, { angles: anglesWritten.map(a => a.name) });
  }

  // Notification: Fatigue detected
  const fatigueDecisions = decisions.filter(d => d.rule === 'fatigue');
  for (const d of fatigueDecisions) {
    await notify('fatigue', 'warning', 'Fatigue Detected',
      d.reason, d.angleName);
  }

  // Notification: Comeback detected
  const comebackDecisions = decisions.filter(d => d.rule === 'comeback');
  for (const d of comebackDecisions) {
    await notify('comeback', 'info', 'Comeback Detected',
      d.reason, d.angleName);
  }

  // Notification: LP problems
  const lpProblems = decisions.filter(d => d.rule === 'lp_aware');
  for (const d of lpProblems) {
    await notify('lp_problem', 'warning', 'LP Issue Detected',
      d.reason, d.angleName, { diagnosis: d.lpDiagnosis });
  }

  // Notification: ROAS thresholds (from Triple Whale)
  if (twSummary && Array.isArray(twSummary) && twSummary.length > 0) {
    const last7d = twSummary.find(t => t.period?.includes('last_7d') || t.period?.startsWith('last_7d'));
    if (last7d && last7d.roas != null) {
      if (last7d.roas < 3) {
        await notify('roas_low', 'critical', 'Low ROAS Alert',
          `Blended ROAS dropped to ${last7d.roas.toFixed(1)}x (below 3x threshold).`,
          undefined, { roas: last7d.roas });
      } else if (last7d.roas > 8) {
        await notify('roas_high', 'info', 'High ROAS',
          `Blended ROAS at ${last7d.roas.toFixed(1)}x — consider scaling spend.`,
          undefined, { roas: last7d.roas });
      }
    }
  }

  return count;
}

/**
 * Apply pending decisions from a dry run.
 *
 * @param {string} projectId
 * @param {string} runId
 * @returns {Promise<{ applied: number }>}
 */
export async function applyDryRunDecisions(projectId, runId) {
  const { getCmoRun } = await import('../convexClient.js');
  const run = await getCmoRun(runId);
  if (!run) throw new Error('Run not found');
  if (run.project_id !== projectId) throw new Error('Project mismatch');
  if (run.decisions_applied) throw new Error('Decisions already applied');

  const decisions = JSON.parse(run.decisions || '[]');
  let applied = 0;

  for (const decision of decisions) {
    if (decision.action === 'change_priority' && decision.angleName && decision.newPriority) {
      try {
        const angles = await getConductorAngles(projectId);
        const angle = angles.find(a => a.name === decision.angleName);
        if (angle) {
          await updateConductorAngle(angle.externalId, { priority: decision.newPriority });
          applied++;
        }
      } catch (err) {
        console.error(`[CMO] Failed to apply decision for ${decision.angleName}:`, err.message);
      }
    }

    if (decision.action === 'write_new_angles' && decision.frame) {
      try {
        const angleEvals = JSON.parse(run.angle_evaluations || '[]');
        const winningAngles = angleEvals.filter(
          e => e.frame === decision.frame && e.tier === 'T1'
        );
        await generateNewAngles({
          projectId,
          frame: decision.frame,
          winningAngles,
          count: decision.count || 3,
        });
        applied++;
      } catch (err) {
        console.error(`[CMO] Failed to write angles for frame ${decision.frame}:`, err.message);
      }
    }
  }

  await updateCmoRun(runId, { decisions_applied: true });
  return { applied };
}

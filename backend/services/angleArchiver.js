// Phase 3 — Angle archive evaluator.
//
// Trigger logic (per Marco's Phase 3 spec):
//   archive iff terminal "failed" results for the angle ≥ archive_min_sample
//                AND failures span ≥ min_unique_posting_days distinct calendar days
//
// "Failed" includes BOTH starvation (Meta refused to spend < $0.50) and
// underperforming (spend ≥ $2 + ROAS < 1.5). Both signals are evidence the
// angle isn't producing winners. insufficient_data is excluded from the count.
// manual_failed counts as failed; manual_passed as passed.
//
// Idempotent: archiveAngle no-ops if status is already 'archived'.
// Best-effort tag application via Phase 5 tag system (failure logged but
// doesn't block archive).

import { v4 as uuidv4 } from 'uuid';
import { convexClient, api } from '../convexClient.js';
import { upsertDashboardTodo } from '../convexClient.js';

const DEFAULT_MIN_SAMPLE = 5;
const DEFAULT_MIN_UNIQUE_POSTING_DAYS = 1;

function calendarDay(isoTimestamp) {
  // YYYY-MM-DD slice — sufficient for "distinct posting days" math.
  return isoTimestamp.slice(0, 10);
}

function effectiveVerdict(verdict) {
  if (verdict === 'manual_passed') return 'passed';
  if (verdict === 'manual_failed') return 'failed';
  return verdict;
}

/**
 * Evaluate a single angle's health and archive if criteria met.
 * Returns { archived, reason, sample, distinctDays }.
 *
 * @param {string} projectId
 * @param {string} angleId — conductor_angles.externalId
 * @param {object} opts — { archive_min_sample, archive_min_unique_posting_days, source }
 */
export async function evaluateAngleHealth(projectId, angleId, opts = {}) {
  if (!angleId) return { archived: false, reason: 'no angle_id' };

  const angle = await convexClient.query(api.conductor.getAngles, { projectId });
  const target = (angle || []).find((a) => a.externalId === angleId);
  if (!target) return { archived: false, reason: 'angle not found' };
  if (target.status === 'archived') return { archived: false, reason: 'already archived' };

  const minSample = opts.archive_min_sample ?? DEFAULT_MIN_SAMPLE;
  const minDays = opts.archive_min_unique_posting_days ?? DEFAULT_MIN_UNIQUE_POSTING_DAYS;

  const results = await convexClient.query(api.observationResults.getByAngle, { angle_id: angleId });
  // Prefer the LATEST manual override per ad set (manual replaces cron). For each
  // ad set, take its most recent row sorted by created_at DESC.
  const byAdSet = new Map();
  for (const r of (results || [])) {
    const existing = byAdSet.get(r.ad_set_id);
    if (!existing || r.created_at > existing.created_at) byAdSet.set(r.ad_set_id, r);
  }
  const terminals = [...byAdSet.values()].map((r) => ({
    ...r,
    eff_verdict: effectiveVerdict(r.verdict),
  }));

  // Exclude insufficient_data and failed_external? The spec says all "failed"
  // verdicts count toward archive. failed_external (Meta deleted the ad set)
  // is also a failure signal. insufficient_data is excluded.
  const failures = terminals.filter((r) => r.eff_verdict === 'failed' || r.eff_verdict === 'failed_external');

  if (failures.length < minSample) {
    return { archived: false, reason: `${failures.length}/${minSample} failures`, sample: failures.length };
  }

  const distinctDays = new Set(failures.map((r) => calendarDay(r.posted_at))).size;
  if (distinctDays < minDays) {
    return { archived: false, reason: `${distinctDays}/${minDays} distinct posting days`, sample: failures.length };
  }

  // Trigger archive
  const performanceNote = `${failures.length} failed ad sets across ${distinctDays} posting days`;
  await convexClient.mutation(api.conductor.archiveAngle, {
    externalId: angleId,
    performance_note: performanceNote,
    source: opts.source || 'auto',
  });

  // Best-effort tag application via Phase 5 tags
  await tryAutoTagArchivedAngle(projectId, target).catch((err) => {
    console.warn(`[angleArchiver] auto-tag failed for angle ${angleId}: ${err.message}`);
  });

  // Surface to dashboard with Undo
  await upsertDashboardTodo({
    externalId: `phase3-archived-${angleId}`,
    text: `Angle "${target.name}" auto-archived — ${performanceNote}`,
    notes: `Project: ${projectId}. Click to un-archive in Creative Director settings.`,
    author: 'Phase 3 Observation',
    priority: 1,
    sort_order: Date.now(),
  }).catch((err) => {
    console.warn(`[angleArchiver] dashboard_todo upsert failed: ${err.message}`);
  });

  return {
    archived: true,
    reason: performanceNote,
    sample: failures.length,
    distinctDays,
  };
}

/**
 * Auto-create an "Archived-{angleName}" tag (idempotent via tags.create) and
 * apply it to all ad sets that referenced this angle. Best-effort; archive
 * succeeds even if this step fails.
 */
async function tryAutoTagArchivedAngle(projectId, angle) {
  const tagName = `Archived-${angle.name}`.slice(0, 60);
  const color = '#8A96A8'; // gray — neutral signal that this is system-generated

  // Look up or create tag
  const existing = await convexClient.query(api.tags.getByProject, { projectId });
  let tagId = (existing || []).find((t) => t.name === tagName)?.externalId;
  if (!tagId) {
    tagId = uuidv4();
    await convexClient.mutation(api.tags.create, {
      externalId: tagId,
      project_id: projectId,
      name: tagName,
      color,
    });
  }

  // Apply tag to every ad set with this angle_id (Meta-side IDs preferred,
  // fall back to CF externalId).
  const adSets = await convexClient.query(api.adSets.getByAngle, { angle_id: angle.externalId });
  for (const adSet of (adSets || [])) {
    const targetId = adSet.meta_adset_id || adSet.externalId;
    const targetKind = adSet.meta_adset_id ? 'meta' : 'cf';
    await convexClient.mutation(api.tagAssignments.create, {
      externalId: uuidv4(),
      project_id: projectId,
      tag_id: tagId,
      entity_type: 'ad_set',
      entity_id: String(targetId),
      entity_id_kind: targetKind,
    }).catch(() => { /* idempotent in tag_assignments — ignore dupes */ });
  }
}

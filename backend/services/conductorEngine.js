/**
 * conductorEngine.js — Dacia Creative Director core logic
 *
 * Runs at 7 AM, 7 PM, and 1 AM ICT. Each run:
 * 1. Iterates enabled projects
 * 2. Determines active posting days (production windows)
 * 3. Calculates flex ad deficit per posting day
 * 4. Creates batches with angle prompts to fill the deficit
 * 5. Logs the run to conductor_runs
 */

import { v4 as uuidv4 } from 'uuid';
import {
  getConductorConfig, upsertConductorConfig,
  getActiveConductorAngles, updateConductorAngle,
  getConductorPlaybook,
  createConductorRun, updateConductorRun, getConductorRuns,
  getConductorSlotsByPostingDay, createConductorSlot, updateConductorSlot,
  createBatchJob, getBatchJob, updateBatchJob,
  getAdsByBatchId, getAd,
  getFlexAdsByProject, getBatchesByProject,
  getProject, getAllConductorConfigs, convexClient, api,
} from '../convexClient.js';
import { getAdaptiveBatchSize } from './conductorLearning.js';
import { runBatch, pollBatchJob } from './batchProcessor.js';
import { triggerLPGeneration } from './lpAutoGenerator.js';
import { buildStructuredAnglePrompt, hasStructuredBrief, buildAngleBriefJSON } from '../utils/angleParser.js';
import {
  cleanupImageData,
  generateImagePrompt,
  regenerateImageOnly,
  repairBodyCopy,
  selectInspirationImage,
  selectTemplateImage,
} from './adGenerator.js';

/**
 * Run the Director cycle for ALL enabled projects.
 * Called by scheduler cron jobs.
 * @param {'planning'|'verification'|'emergency'} runType
 */
export async function runDirectorCycle(runType = 'planning') {
  console.log(`[Director] Starting ${runType} cycle...`);
  const configs = await getAllConductorConfigs();
  const enabledConfigs = configs.filter(c => c.enabled && c.run_schedule !== 'manual_only');

  if (enabledConfigs.length === 0) {
    console.log('[Director] No enabled projects. Skipping.');
    return;
  }

  const results = [];
  for (const config of enabledConfigs) {
    try {
      const result = await runDirectorForProject(config.project_id, runType);
      results.push(result);
    } catch (err) {
      console.error(`[Director] Error for project ${config.project_id.slice(0, 8)}:`, err.message);
      results.push({ project_id: config.project_id, error: err.message });
    }
  }

  console.log(`[Director] Cycle complete. Processed ${results.length} project(s).`);
  return results;
}

/**
 * Run the Director for a single project.
 * Also used for manual triggers from the API.
 * @param {string} projectId
 * @param {'planning'|'verification'|'manual'|'emergency'} runType
 */
export async function runDirectorForProject(projectId, runType = 'manual') {
  const startMs = Date.now();
  const runId = uuidv4();

  const config = await getConductorConfig(projectId);
  if (!config) {
    throw new Error('No conductor config for this project. Create one first.');
  }

  const project = await getProject(projectId);
  if (!project) {
    throw new Error('Project not found');
  }

  // Create the run record immediately
  await createConductorRun({
    externalId: runId,
    project_id: projectId,
    run_type: runType,
    run_at: startMs,
    status: 'running',
  });

  try {
    const now = new Date();
    const activePostingDays = getActivePostingDays(now);

    if (activePostingDays.length === 0) {
      await updateConductorRun(runId, {
        status: 'completed',
        decisions: 'No active posting days in current production window.',
        posting_days: JSON.stringify([]),
        duration_ms: Date.now() - startMs,
      });
      return { runId, batches_created: 0, message: 'No active posting days' };
    }

    // Sort by deadline (closest first)
    activePostingDays.sort((a, b) => new Date(a.deadline) - new Date(b.deadline));

    const allBatches = await getBatchesByProject(projectId);
    const batchesById = new Map((allBatches || []).map(batch => [batch.id, batch]));
    const allBatchesCreated = [];
    const postingDayResults = [];

    for (const pd of activePostingDays) {
      const slots = await ensurePostingDaySlots(projectId, config, pd.date);
      const batchesForDay = [];
      const slotResults = [];

      for (const slot of slots) {
        let workingSlot = slot;
        const slotBatchIds = getSlotBatchIds(slot);
        const latestBatch = slotBatchIds.length > 0 ? batchesById.get(slotBatchIds[slotBatchIds.length - 1]) : null;
        const reconciled = reconcileSchedulerSlot(slot, latestBatch);

        if (hasSlotChanges(slot, reconciled)) {
          await updateConductorSlot(slot.id, reconciled);
          workingSlot = { ...slot, ...reconciled };
        }

        if (workingSlot.status === 'failed') {
          const replacement = await replaceFailedSlot(projectId, config, pd.date, workingSlot, slots);
          if (replacement) {
            workingSlot = replacement;
          }
        }

        const refreshedBatchIds = getSlotBatchIds(workingSlot);
        const latestKnownBatch = refreshedBatchIds.length > 0 ? batchesById.get(refreshedBatchIds[refreshedBatchIds.length - 1]) : null;
        const hasActiveBatch = latestKnownBatch && ['pending', 'generating_prompts', 'submitting', 'processing'].includes(latestKnownBatch.status);

        if (workingSlot.status !== 'reserved' || hasActiveBatch || workingSlot.produced_flex_ad_id) {
          slotResults.push(buildPostingDaySlotResult(workingSlot));
          continue;
        }

        const angleInfo = {
          name: workingSlot.angle_name,
          externalId: workingSlot.angle_external_id,
        };
        const batchId = uuidv4();

        // Adaptive batch size: smaller for emergency runs, learns from pass rates
        const baseBatchSize = runType === 'emergency' ? 12 : config.ads_per_batch;
        const batchSize = await getAdaptiveBatchSize(projectId, angleInfo.name, baseBatchSize);

        // Build the angle prompt — use structured fields if available, else legacy description
        let anglePrompt;
        if (hasStructuredBrief(angleInfo)) {
          anglePrompt = buildStructuredAnglePrompt(angleInfo);
        } else {
          anglePrompt = angleInfo.description;
        }
        if (angleInfo.prompt_hints) {
          anglePrompt += `\n\nCREATIVE DIRECTION:\n${angleInfo.prompt_hints}`;
        }

        // Load playbook for this angle if it exists
        const playbook = await getConductorPlaybook(projectId, angleInfo.name);
        anglePrompt += buildPlaybookPromptBlock(playbook, { templateMode: true });

        // Build structured brief JSON for downstream use (scoring, QA, LP generation)
        const angleBriefJSON = hasStructuredBrief(angleInfo)
          ? JSON.stringify(buildAngleBriefJSON(angleInfo))
          : undefined;

        await createBatchJob({
          id: batchId,
          project_id: projectId,
          generation_mode: 'batch',
          batch_size: batchSize,
          angle: anglePrompt,  // Injected into the ad generator's "angle" field
          aspect_ratio: '1:1',
          product_image_storageId: project.product_image_storageId || undefined,
          filter_assigned: true,
          posting_day: pd.date,
          conductor_run_id: runId,
          angle_name: angleInfo.name,
          angle_prompt: anglePrompt,
          angle_brief: angleBriefJSON,
        });

        // Update angle usage stats (skip for fallback angles with no DB record)
        if (angleInfo.externalId !== 'fallback') {
          await updateConductorAngle(angleInfo.externalId, {
            times_used: (angleInfo.times_used || 0) + 1,
            last_used_at: Date.now(),
          });
        }

        const nextBatchIds = [...refreshedBatchIds, batchId];
        await updateConductorSlot(workingSlot.id, {
          status: 'in_progress',
          batch_ids: stringifyJSON(nextBatchIds, '[]'),
          attempt_count: (workingSlot.attempt_count || 0) + 1,
          last_attempt_at: Date.now(),
          failure_reason: '',
        });

        batchesForDay.push({
          batch_id: batchId,
          angle_name: angleInfo.name,
          ad_count: batchSize,
          posting_day: pd.date,
          slot_index: workingSlot.slot_index,
        });
        slotResults.push({
          ...buildPostingDaySlotResult({
            ...workingSlot,
            status: 'in_progress',
            batch_ids: stringifyJSON(nextBatchIds, '[]'),
            attempt_count: (workingSlot.attempt_count || 0) + 1,
            failure_reason: '',
          }),
          created_batch_id: batchId,
        });
      }

      allBatchesCreated.push(...batchesForDay);
      postingDayResults.push({
        date: pd.date,
        deadline: pd.deadline,
        target: config.daily_flex_target,
        action: batchesForDay.length > 0 ? `Created ${batchesForDay.length} batch(es)` : 'slots already reserved or in progress',
        batches: batchesForDay,
        slots: slotResults,
      });
    }

    // Update run record with results
    const updateTimestamp = runType === 'planning' ? 'last_planning_run' : 'last_verify_run';
    await upsertConductorConfig(projectId, { [updateTimestamp]: Date.now() });

    await updateConductorRun(runId, {
      status: 'completed',
      posting_days: JSON.stringify(postingDayResults),
      batches_created: JSON.stringify(allBatchesCreated),
      decisions: `Checked ${activePostingDays.length} posting day(s). Created ${allBatchesCreated.length} batch(es).`,
      duration_ms: Date.now() - startMs,
    });

    console.log(`[Director] Project ${projectId.slice(0, 8)}: Created ${allBatchesCreated.length} batch(es) for ${postingDayResults.length} posting day(s) in ${Date.now() - startMs}ms`);

    // Fire-and-forget: start all created batches
    for (const b of allBatchesCreated) {
      runBatch(b.batch_id).catch(err => {
        console.error(`[Director] Background batch ${b.batch_id.slice(0, 8)} failed:`, err.message);
      });
    }

    // Fire-and-forget: trigger LP generation per batch
    for (const b of allBatchesCreated) {
      triggerLPGeneration(b.batch_id, projectId, b.angle_name).catch(err => {
        console.warn(`[Director] LP trigger for batch ${b.batch_id.slice(0, 8)} failed:`, err.message);
      });
    }

    return {
      runId,
      batches_created: allBatchesCreated.length,
      posting_days: postingDayResults,
    };

  } catch (err) {
    await updateConductorRun(runId, {
      status: 'failed',
      error: err.message,
      duration_ms: Date.now() - startMs,
    });
    throw err;
  }
}

/**
 * Determine which posting days have their production window currently open.
 *
 * Production windows (all times ICT = UTC+7):
 * - Monday's ads: Sat 7 PM through Mon 3 AM
 * - Tuesday's ads: Sun 7 PM through Tue 3 AM
 * - Wednesday's ads: Mon 7 PM through Wed 3 AM
 * - Thursday's ads: Tue 7 PM through Thu 3 AM
 * - Friday's ads: Wed 7 PM through Fri 3 AM
 *
 * @param {Date} now - current time
 * @returns {Array<{ date: string, deadline: string, dayName: string }>}
 */
export function getActivePostingDays(now) {
  // Convert to ICT (UTC+7)
  const ictOffset = 7 * 60 * 60 * 1000;
  const ictNow = new Date(now.getTime() + ictOffset);
  const ictHour = ictNow.getUTCHours();
  const ictDay = ictNow.getUTCDay(); // 0=Sun, 1=Mon, ..., 6=Sat

  const result = [];
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  // Check each weekday (Mon=1 through Fri=5) as potential posting days
  for (let postDay = 1; postDay <= 5; postDay++) {
    // Production window opens 2 evenings before (7 PM ICT) and closes 3 AM ICT on posting day
    // "2 evenings before" means: for Monday (1), opens Saturday (6) at 7 PM
    // That's postDay - 2, wrapping around (mod 7)
    const openDay = (postDay - 2 + 7) % 7;

    // Window open: openDay 19:00 ICT
    // Window close: postDay 03:00 ICT
    const windowOpen = getICTDate(ictNow, openDay, 19);
    const windowClose = getICTDate(ictNow, postDay, 3);

    // Adjust: if windowClose is before windowOpen, windowClose is next week
    if (windowClose <= windowOpen) {
      windowClose.setUTCDate(windowClose.getUTCDate() + 7);
    }

    const nowMs = ictNow.getTime();
    if (nowMs >= windowOpen.getTime() && nowMs <= windowClose.getTime()) {
      // This posting day's window is open
      // Calculate the actual posting date (the next occurrence of postDay)
      const postingDate = getNextWeekday(now, postDay);
      result.push({
        date: formatDate(postingDate),
        deadline: new Date(windowClose.getTime() - ictOffset).toISOString(),
        dayName: dayNames[postDay],
      });
    }
  }

  return result;
}

/**
 * Calculate the flex ad deficit for a specific posting day.
 * deficit = target - produced - in_progress_batches
 */
async function calculateDeficit(projectId, postingDay, target) {
  const flexAds = await getFlexAdsByProject(projectId);
  const batches = await getBatchesByProject(projectId);

  // Count flex ads tagged for this posting day
  const produced = flexAds.filter(fa => fa.posting_day === postingDay).length;

  // Count batches still in progress for this posting day
  const inProgress = batches.filter(b =>
    b.posting_day === postingDay &&
    ['pending', 'generating_prompts', 'submitting', 'processing'].includes(b.status)
  ).length;

  const deficit = Math.max(0, target - produced - inProgress);
  return { produced, inProgress, deficit };
}

const MAX_ATTEMPTS_PER_ANGLE_SLOT = 2;

function getSlotBatchIds(slot) {
  return parseJSON(slot?.batch_ids, []);
}

function getBatchDiagnosticsSummary(batch) {
  if (!batch) return null;
  const prompts = parseJSON(batch.gpt_prompts, []);
  const state = getBatchPhaseState(batch);
  const stats = parseJSON(batch.batch_stats, {});
  return {
    headline_candidates: batch.headline_candidates || 0,
    scene_alignment_rejections: batch.scene_alignment_rejections || 0,
    scene_alignment_reason_counts: parseJSON(batch.scene_alignment_reason_counts, {}),
    duplicate_rejections: batch.duplicate_rejections || 0,
    history_rejections: batch.history_rejections || 0,
    selected_headline_count: batch.headline_count || 0,
    usable_prompt_count: prompts.length,
    ads_generated: stats.successful ?? prompts.length,
    batch_status: batch.status,
    batch_phase: state?.step || null,
    batch_phase_message: state?.message || null,
    error_message: batch.error_message || null,
    flex_ad_id: batch.flex_ad_id || null,
    filter_processed: batch.filter_processed || false,
  };
}

function getBatchFailureReason(batch) {
  if (!batch || batch.flex_ad_id) return '';
  if (batch.error_message) return batch.error_message;
  const diagnostics = getBatchDiagnosticsSummary(batch);
  if ((diagnostics?.usable_prompt_count || 0) === 0) return 'no_usable_prompts_after_stage1';
  if (batch.status === 'completed' && batch.filter_processed && !batch.flex_ad_id) return 'completed_without_flex_ad';
  if (batch.status === 'completed') return 'completed_without_flex_ad';
  if (batch.status === 'failed') return 'batch_failed';
  return '';
}

function reconcileSchedulerSlot(slot, latestBatch) {
  if (!latestBatch) {
    return {
      status: slot.status,
      produced_flex_ad_id: slot.produced_flex_ad_id || '',
      failure_reason: slot.failure_reason || '',
      diagnostics_summary: slot.diagnostics_summary || '',
    };
  }

  const diagnosticsSummary = stringifyJSON(getBatchDiagnosticsSummary(latestBatch), '{}');
  if (latestBatch.flex_ad_id) {
    return {
      status: 'produced',
      produced_flex_ad_id: latestBatch.flex_ad_id,
      failure_reason: '',
      diagnostics_summary: diagnosticsSummary,
    };
  }

  if (['pending', 'generating_prompts', 'submitting', 'processing'].includes(latestBatch.status)) {
    return {
      status: 'in_progress',
      diagnostics_summary: diagnosticsSummary,
    };
  }

  return {
    status: (slot.attempt_count || 0) >= MAX_ATTEMPTS_PER_ANGLE_SLOT ? 'failed' : 'reserved',
    produced_flex_ad_id: '',
    failure_reason: getBatchFailureReason(latestBatch),
    diagnostics_summary: diagnosticsSummary,
  };
}

function hasSlotChanges(slot, nextFields) {
  return Object.entries(nextFields).some(([key, value]) => {
    const currentValue = slot[key] ?? '';
    return currentValue !== (value ?? '');
  });
}

function buildPostingDaySlotResult(slot) {
  return {
    slot_index: slot.slot_index,
    angle_name: slot.angle_name,
    status: slot.status,
    attempt_count: slot.attempt_count || 0,
    batch_ids: getSlotBatchIds(slot),
    produced_flex_ad_id: slot.produced_flex_ad_id || null,
    failure_reason: slot.failure_reason || null,
    diagnostics_summary: slot.diagnostics_summary ? parseJSON(slot.diagnostics_summary, null) : null,
  };
}

async function ensurePostingDaySlots(projectId, config, postingDay) {
  let slots = await getConductorSlotsByPostingDay(projectId, postingDay);
  const target = config.daily_flex_target || 0;
  if (slots.length >= target) return slots;

  const missing = target - slots.length;
  const existingAngleNames = slots.map(slot => slot.angle_name).filter(Boolean);
  const angles = await selectAngles(projectId, config, missing, existingAngleNames);
  for (let i = 0; i < angles.length; i++) {
    const angleInfo = angles[i];
    await createConductorSlot({
      externalId: uuidv4(),
      project_id: projectId,
      posting_day: postingDay,
      slot_index: slots.length + i,
      angle_name: angleInfo.name,
      angle_external_id: angleInfo.externalId || '',
      status: 'reserved',
      batch_ids: '[]',
      attempt_count: 0,
      failure_reason: '',
      diagnostics_summary: '',
    });
  }
  return await getConductorSlotsByPostingDay(projectId, postingDay);
}

async function replaceFailedSlot(projectId, config, postingDay, slot, allSlots) {
  const excludedAngleNames = allSlots
    .filter(candidate => candidate.id !== slot.id && ['reserved', 'in_progress', 'produced'].includes(candidate.status))
    .map(candidate => candidate.angle_name)
    .filter(Boolean);
  if (slot.angle_name) excludedAngleNames.push(slot.angle_name);

  const replacements = await selectAngles(projectId, config, 1, excludedAngleNames);
  if (replacements.length === 0) return null;

  const replacement = replacements[0];
  const updates = {
    angle_name: replacement.name,
    angle_external_id: replacement.externalId || '',
    status: 'reserved',
    batch_ids: '[]',
    attempt_count: 0,
    failure_reason: '',
    diagnostics_summary: '',
    produced_flex_ad_id: '',
  };
  await updateConductorSlot(slot.id, updates);
  return { ...slot, ...updates };
}

/**
 * Select angles for batch creation based on the project's angle_mode config.
 * Returns an array of angle objects, one per batch needed.
 */
async function selectAngles(projectId, config, count, excludedAngleNames = []) {
  const activeAngles = await getActiveConductorAngles(projectId);

  if (activeAngles.length === 0) {
    // No angles configured — create a "General" angle as fallback
    return Array(count).fill({
      externalId: 'fallback',
      name: 'General',
      description: 'General ad creative — no specific angle targeting.',
      prompt_hints: '',
      times_used: 0,
    });
  }

  const excluded = new Set((excludedAngleNames || []).filter(Boolean));

  // Focus mode: if any active angles are focused, only use those
  const focusedAngles = activeAngles.filter(a => a.focused);
  let anglesToUse = focusedAngles.length > 0 ? focusedAngles : activeAngles;
  const filteredAngles = anglesToUse.filter(angle => !excluded.has(angle.name));
  if (filteredAngles.length > 0) {
    anglesToUse = filteredAngles;
  }

  const mode = config.angle_mode || 'manual';
  const rotation = config.angle_rotation || 'round_robin';

  if (mode === 'manual' || mode === 'mixed') {
    return distributeAngles(anglesToUse, count, rotation);
  }

  // Auto mode — for now, use existing angles with round robin
  // (angle auto-generation will be handled by conductorAngles.js in Phase 4)
  return distributeAngles(anglesToUse, count, rotation);
}

// Priority weights for angle selection — higher = more likely to be selected
const PRIORITY_WEIGHTS = { highest: 4, high: 2, medium: 1, test: 0.25 };

function getPriorityWeight(angle) {
  return PRIORITY_WEIGHTS[angle.priority] || PRIORITY_WEIGHTS.medium;
}

/**
 * Distribute angles across batches using the specified rotation strategy.
 * Priority-aware: angles with higher priority get selected more often.
 */
function distributeAngles(angles, count, rotation) {
  if (angles.length === 0) return [];

  switch (rotation) {
    case 'weighted': {
      // Favor less-recently-used angles, weighted by priority
      const sorted = [...angles].sort((a, b) => {
        const priorityDiff = getPriorityWeight(b) - getPriorityWeight(a);
        if (priorityDiff !== 0) return priorityDiff;
        return (a.last_used_at || 0) - (b.last_used_at || 0);
      });
      const result = [];
      for (let i = 0; i < count; i++) {
        result.push(sorted[i % sorted.length]);
      }
      return result;
    }

    case 'random': {
      const result = [];
      for (let i = 0; i < count; i++) {
        // Weighted random: usage-based weight × priority multiplier
        const weights = angles.map(a => {
          const usageWeight = 1 / (1 + (a.times_used || 0));
          return usageWeight * getPriorityWeight(a);
        });
        const totalWeight = weights.reduce((s, w) => s + w, 0);
        let r = Math.random() * totalWeight;
        let selected = angles[0];
        for (let j = 0; j < angles.length; j++) {
          r -= weights[j];
          if (r <= 0) { selected = angles[j]; break; }
        }
        result.push(selected);
      }
      return result;
    }

    case 'round_robin':
    default: {
      // Sort by priority (desc) then times_used (asc), then rotate
      const sorted = [...angles].sort((a, b) => {
        const priorityDiff = getPriorityWeight(b) - getPriorityWeight(a);
        if (priorityDiff !== 0) return priorityDiff;
        return (a.times_used || 0) - (b.times_used || 0);
      });
      const result = [];
      for (let i = 0; i < count; i++) {
        result.push(sorted[i % sorted.length]);
      }
      return result;
    }
  }
}

const TEST_RUN_INITIAL_ADS_PER_ROUND = 18;
const TEST_RUN_MAX_ROUNDS = 5;
const TEST_RUN_REQUIRED_PASSES = 10;
const TEST_RUN_REFILL_MULTIPLIER = 2;
const TEST_RUN_ORCHESTRATION_FAILURE_STATUS = 'orchestration_failed';
const TEST_RUN_GEMINI_WAIT_MS = 30 * 60 * 1000;
const TEST_RUN_ROUND_CAP_TERMINAL_STATUS = 'failed_under_threshold_after_round_cap';
const DIRECTOR_SCORE_THRESHOLD = 7;

function stringifyJSON(value, fallback = '[]') {
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

function parseJSON(value, fallback = []) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function getTestPostingDays(angleName) {
  return stringifyJSON([{ date: 'test', action: `Testing angle "${angleName}"` }], '[]');
}

function getGeminiTimeoutMessage(roundNumber) {
  return `Round ${roundNumber} Gemini batch timed out after 30 minutes`;
}

function getTestRoundBatchSize(roundNumber, totalAdsPassed) {
  if (roundNumber <= 1) return TEST_RUN_INITIAL_ADS_PER_ROUND;
  const remaining = Math.max(TEST_RUN_REQUIRED_PASSES - totalAdsPassed, 1);
  return Math.max(2, remaining * TEST_RUN_REFILL_MULTIPLIER);
}

function buildTestProgressValue(roundNumber, step, meta = {}) {
  const roundSpan = Math.max(Math.floor(90 / TEST_RUN_MAX_ROUNDS), 1);
  const base = Math.min((roundNumber - 1) * roundSpan, 90);
  const stepValue = (ratio) => base + Math.max(1, Math.round(roundSpan * ratio));
  switch (step) {
    case 'creating_batch':
      return stepValue(0.11);
    case 'batch_brief':
      return stepValue(0.28);
    case 'batch_headlines':
      return stepValue(0.44);
    case 'batch_body_copy':
      return stepValue(0.61);
    case 'batch_image_prompts':
      return stepValue(0.72);
    case 'batch_submitting':
      return stepValue(0.8);
    case 'batch_submitted':
    case 'gemini_waiting':
      return stepValue(0.84);
    case 'gemini_polling':
      return stepValue(0.84) + Math.round(Math.min((meta.elapsed || 0) / 600, 0.95) * Math.max(stepValue(0.95) - stepValue(0.84), 1));
    case 'gemini_complete':
      return stepValue(1);
    case 'filter_scoring':
      if (meta.scoringProgress?.total) {
        return stepValue(1) + Math.round((meta.scoringProgress.current / meta.scoringProgress.total) * 2);
      }
      return stepValue(1);
    case 'repairing_images':
      return stepValue(1) + 2;
    case 'repairing_copy':
      return stepValue(1) + 3;
    case 'round_complete':
      return Math.min(roundNumber * roundSpan, 90);
    case 'filter_grouping':
      return 92;
    case 'filter_copy_gen':
      return 95;
    case 'filter_deploying':
      return 98;
    case 'filter_complete':
      return 100;
    default:
      return undefined;
  }
}

function withTestProgress(roundNumber, event) {
  const progressValue = buildTestProgressValue(roundNumber, event.step, event);
  return progressValue === undefined ? event : { ...event, progressValue };
}

function getBatchPhaseState(batch) {
  const pipelineState = parseJSON(batch?.pipeline_state, {});
  const batchStats = parseJSON(batch?.batch_stats, {});
  return { pipelineState, batchStats };
}

function getBatchPromptProgress(roundNumber, pipelineState) {
  const stage = Number(pipelineState?.stage);
  if (stage === 0) {
    return buildTestProgressValue(roundNumber, 'batch_brief');
  }
  if (stage === 1) {
    return buildTestProgressValue(roundNumber, 'batch_headlines');
  }
  if (stage === 2) {
    return buildTestProgressValue(roundNumber, 'batch_body_copy');
  }
  if (stage === 3) {
    const total = Number(pipelineState?.total) || 0;
    const current = Number(pipelineState?.current) || 0;
    if (total > 0) {
      const base = buildTestProgressValue(roundNumber, 'batch_body_copy');
      const max = buildTestProgressValue(roundNumber, 'batch_image_prompts');
      if (typeof base === 'number' && typeof max === 'number') {
        return base + Math.round((Math.min(current, total) / total) * (max - base));
      }
    }
    return buildTestProgressValue(roundNumber, 'batch_image_prompts');
  }
  return buildTestProgressValue(roundNumber, 'creating_batch');
}

function buildPlaybookPromptBlock(playbook, { templateMode = false } = {}) {
  if (!playbook || playbook.version <= 0) return '';

  const lines = [];
  if (templateMode) {
    if (playbook.copy_patterns) lines.push(`\n- Copy approach: ${playbook.copy_patterns}`);
  } else {
    if (playbook.visual_patterns) lines.push(`\n- Visual approach: ${playbook.visual_patterns}`);
    if (playbook.copy_patterns) lines.push(`\n- Copy approach: ${playbook.copy_patterns}`);
    if (playbook.avoid_patterns) lines.push(`\n- AVOID: ${playbook.avoid_patterns}`);
    if (playbook.generation_hints) lines.push(`\n- Key hints: ${playbook.generation_hints}`);
  }

  if (lines.length === 0) return '';

  const sectionLabel = templateMode
    ? 'COPY DIRECTION FROM PREVIOUS ROUNDS:'
    : 'CREATIVE DIRECTION FROM PREVIOUS ROUNDS:';

  return `\n\n${sectionLabel}${lines.join('')}\n\nCurrent pass rate for this angle: ${Math.round((playbook.pass_rate || 0) * 100)}%\nFollow these patterns to maximize quality.`;
}

function getGeminiWaitingProgress(roundNumber, batch, batchStats) {
  const waitingBase = buildTestProgressValue(roundNumber, 'gemini_waiting') || 22;
  const completeBase = buildTestProgressValue(roundNumber, 'gemini_complete') || (waitingBase + 6);
  const total = Number(batchStats?.totalCount) || 0;
  const successful = Number(batchStats?.successfulCount) || 0;
  const failed = Number(batchStats?.failedCount) || 0;
  if (total > 0) {
    const finished = Math.min(successful + failed, total);
    return waitingBase + Math.round((finished / total) * Math.max(completeBase - waitingBase - 1, 1));
  }

  const startedAt = batch?.started_at ? Date.parse(batch.started_at) : NaN;
  if (Number.isFinite(startedAt)) {
    const elapsed = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    return buildTestProgressValue(roundNumber, 'gemini_polling', { elapsed }) || waitingBase;
  }

  return waitingBase;
}

function getDurableRunPhaseMessage(run, batchInfo, batch, pipelineState, batchStats) {
  const roundNumber = batchInfo?.round || 1;
  const total = Number(batchStats?.totalCount) || 0;
  const successful = Number(batchStats?.successfulCount) || 0;
  const failed = Number(batchStats?.failedCount) || 0;
  const finished = Math.min(successful + failed, total);

  if (!batch) {
    return run?.decisions || 'Test run is still processing in background...';
  }

  if (batch.status === 'pending') {
    return run?.decisions || `Round ${roundNumber}: queued to start...`;
  }

  if (batch.status === 'generating_prompts') {
    return pipelineState?.stage_label
      ? `Round ${roundNumber}: ${pipelineState.stage_label}`
      : `Round ${roundNumber}: building prompts...`;
  }

  if (batch.status === 'submitting') {
    return `Round ${roundNumber}: submitting prompts to Gemini...`;
  }

  if (batch.status === 'processing') {
    if (total > 0) {
      return `Round ${roundNumber}: Gemini is processing images (${finished}/${total} complete)...`;
    }
    return run?.decisions || `Round ${roundNumber}: Gemini is still processing images...`;
  }

  if (batch.status === 'saving_results') {
    return `Round ${roundNumber}: saving generated ads...`;
  }

  if (batch.status === 'completed' && run?.status === 'running') {
    return `Round ${roundNumber}: Gemini finished. Scoring ads...`;
  }

  if (batch.status === 'failed') {
    return batch.error_message || `Round ${roundNumber} failed.`;
  }

  return run?.decisions || 'Test run is still processing in background...';
}

function buildDurableRunProgress(run, batchInfo, batch) {
  const roundNumber = batchInfo?.round || 1;
  const { pipelineState, batchStats } = getBatchPhaseState(batch);
  const waitingProgress = getGeminiWaitingProgress(roundNumber, batch, batchStats);
  const promptProgress = getBatchPromptProgress(roundNumber, pipelineState);

  if (!batch) {
    const fallback = run?.terminal_status === 'waiting_on_gemini'
      ? buildTestProgressValue(roundNumber, 'gemini_waiting')
      : buildTestProgressValue(roundNumber, 'creating_batch');
    return Math.max(2, fallback || 2);
  }

  switch (batch.status) {
    case 'pending':
      return Math.max(2, buildTestProgressValue(roundNumber, 'creating_batch') || 2);
    case 'generating_prompts':
      return Math.max(2, promptProgress || 2);
    case 'submitting':
      return Math.max(2, buildTestProgressValue(roundNumber, 'batch_submitting') || 14);
    case 'processing':
      return Math.max(2, waitingProgress);
    case 'saving_results':
      return Math.max(2, buildTestProgressValue(roundNumber, 'gemini_complete') || waitingProgress);
    case 'completed':
      return Math.max(2, buildTestProgressValue(roundNumber, 'gemini_complete') || waitingProgress);
    case 'failed':
      return 0;
    default:
      return Math.max(2, promptProgress || waitingProgress || 2);
  }
}

async function buildDurableActiveTestRun(projectId) {
  const runs = await getConductorRuns(projectId, 10);
  const testRuns = runs.filter((run) => run.run_type === 'test');
  const candidate = testRuns.find((run) => run.status === 'running')
    || testRuns.find((run) => {
      const failure = run.failure_reason || run.error || '';
      return run.status === 'failed' && failure.includes(getGeminiTimeoutMessage(1).replace('Round 1 ', ''));
    });

  if (!candidate) return null;

  const batchInfos = parseJSON(candidate.batches_created, []);
  const roundDetails = parseJSON(candidate.rounds_json, []);
  const pending = findPendingBatchInfo(batchInfos, roundDetails);
  const currentBatchInfo = pending?.batchInfo || batchInfos[batchInfos.length - 1] || null;
  const batch = currentBatchInfo?.batch_id ? await getBatchJob(currentBatchInfo.batch_id).catch(() => null) : null;
  const { pipelineState, batchStats } = getBatchPhaseState(batch);
  const phase = getDurableRunPhaseMessage(candidate, currentBatchInfo, batch, pipelineState, batchStats);
  const progress = buildDurableRunProgress(candidate, currentBatchInfo, batch);

  return {
    id: candidate.externalId,
    runId: candidate.externalId,
    projectId,
    status: candidate.status === 'completed' ? 'complete' : candidate.status === 'failed' ? 'error' : 'running',
    progress,
    phase,
    startTime: candidate.run_at || Date.now(),
    result: candidate,
    terminal_status: candidate.terminal_status || null,
    batchId: currentBatchInfo?.batch_id || null,
  };
}

export async function getActiveTestRunSnapshot(projectId) {
  const tracked = getActiveTestRun(projectId);
  if (tracked) return tracked;
  return await buildDurableActiveTestRun(projectId);
}

async function loadTestRunContext(projectId, angleOverride) {
  const config = await getConductorConfig(projectId);
  if (!config) {
    throw new Error('No conductor config for this project. Create one first.');
  }

  const project = await getProject(projectId);
  if (!project) {
    throw new Error('Project not found');
  }

  let angleInfo;
  if (angleOverride) {
    const allAngles = await getActiveConductorAngles(projectId);
    angleInfo = allAngles.find(a => a.externalId === angleOverride);
    if (!angleInfo) throw new Error('Selected angle not found or not active');
  } else {
    const angles = await selectAngles(projectId, config, 1);
    angleInfo = angles[0];
  }

  let anglePrompt;
  if (hasStructuredBrief(angleInfo)) {
    anglePrompt = buildStructuredAnglePrompt(angleInfo);
  } else {
    anglePrompt = angleInfo.description;
  }
  if (angleInfo.prompt_hints) {
    anglePrompt += `\n\nCREATIVE DIRECTION:\n${angleInfo.prompt_hints}`;
  }

  const playbook = await getConductorPlaybook(projectId, angleInfo.name);
  anglePrompt += buildPlaybookPromptBlock(playbook, { templateMode: true });

  const angleBriefJSON = hasStructuredBrief(angleInfo)
    ? JSON.stringify(buildAngleBriefJSON(angleInfo))
    : undefined;

  return { config, project, angleInfo, anglePrompt, angleBriefJSON };
}

async function createTestBatchRound({
  projectId,
  project,
  runId,
  angleInfo,
  anglePrompt,
  angleBriefJSON,
  batchSize,
  roundNumber,
  emit,
  updateAngleUsage = false,
}) {
  const batchId = uuidv4();
  emit(withTestProgress(roundNumber, {
    type: 'progress',
    step: 'creating_batch',
    message: `Round ${roundNumber}: creating batch (${batchSize} ads)...`,
  }));

  await createBatchJob({
    id: batchId,
    project_id: projectId,
    generation_mode: 'batch',
    batch_size: batchSize,
    angle: anglePrompt,
    aspect_ratio: '1:1',
    product_image_storageId: project.product_image_storageId || undefined,
    filter_assigned: true,
    posting_day: 'test',
    conductor_run_id: runId,
    angle_name: angleInfo.name,
    angle_prompt: anglePrompt,
    angle_brief: angleBriefJSON,
  });

  if (updateAngleUsage && angleInfo.externalId !== 'fallback') {
    await updateConductorAngle(angleInfo.externalId, {
      times_used: (angleInfo.times_used || 0) + 1,
      last_used_at: Date.now(),
    });
  }

  return {
    batch_id: batchId,
    angle_name: angleInfo.name,
    ad_count: batchSize,
    posting_day: 'test',
    round: roundNumber,
  };
}

async function executeTestBatchRound(batchId, roundNumber, emit, shouldCancel = null) {
  const roundEmit = (event) => emit(withTestProgress(roundNumber, event));
  const throwIfCancelled = async () => {
    if (!shouldCancel || !shouldCancel()) return;
    const batch = await getBatchJob(batchId).catch(() => null);
    if (batch?.gemini_batch_job) {
      try {
        const { getClient } = await import('./gemini.js');
        const ai = await getClient();
        await ai.batches.cancel({ name: batch.gemini_batch_job });
      } catch (err) {
        console.warn(`[Director] Could not cancel Gemini batch ${batchId.slice(0, 8)}:`, err.message);
      }
    }
    try {
      await updateBatchJob(batchId, { status: 'failed', error_message: 'Cancelled by user' });
    } catch {}
    throw new Error('Cancelled by user');
  };

  const batchAdapter = (event) => {
    if (event.type === 'prompt_progress') {
      const msg = event.message || '';
      let step = 'batch_pipeline';
      if (msg.includes('Step 1')) step = 'batch_brief';
      else if (msg.includes('Step 2')) step = 'batch_headlines';
      else if (msg.includes('Step 3')) step = 'batch_body_copy';
      else if (msg.includes('Step 4')) step = 'batch_image_prompts';
      roundEmit({
        type: 'progress',
        step,
        message: `Round ${roundNumber}: ${msg}`,
        imageProgress: (event.current && event.total) ? { current: event.current, total: event.total } : undefined,
      });
    } else if (event.type === 'status') {
      const map = { submitting: 'batch_submitting', processing: 'batch_submitted' };
      if (map[event.status]) {
        roundEmit({
          type: 'progress',
          step: map[event.status],
          message: `Round ${roundNumber}: ${event.message}`,
        });
      }
    } else if (event.type === 'error') {
      emit(event);
    }
  };

  await throwIfCancelled();
  await runBatch(batchId, batchAdapter, { shouldCancel });
  await throwIfCancelled();

  roundEmit({
    type: 'progress',
    step: 'gemini_waiting',
    message: `Round ${roundNumber}: waiting for Gemini to generate images...`,
  });

  const pollStart = Date.now();

  while (true) {
    await new Promise(r => setTimeout(r, 10000));
    await throwIfCancelled();
    const elapsed = Math.round((Date.now() - pollStart) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

    if (Date.now() - pollStart > TEST_RUN_GEMINI_WAIT_MS) {
      return {
        deferred: true,
        step: 'gemini_waiting',
        message: getGeminiTimeoutMessage(roundNumber),
      };
    }

    const result = await pollBatchJob(batchId);
    if (result === 'completed') {
      roundEmit({
        type: 'progress',
        step: 'gemini_complete',
        message: `Round ${roundNumber}: images generated (${timeStr})`,
      });
      break;
    }
    if (result === 'failed') {
      throw new Error(`Round ${roundNumber} Gemini batch processing failed`);
    }

    roundEmit({
      type: 'progress',
      step: 'gemini_polling',
      message: `Round ${roundNumber}: generating images via Gemini... (${timeStr})`,
      elapsed,
    });
  }

  return { deferred: false };
}

function buildTestRunSummary({
  angleName,
  roundsUsed,
  totalAdsGenerated,
  totalAdsPassed,
  readyToPostCount = 0,
  terminalStatus,
  failureReason = '',
}) {
  if (terminalStatus === 'deployed') {
    return `Angle "${angleName}" reached ${TEST_RUN_REQUIRED_PASSES}/${TEST_RUN_REQUIRED_PASSES} passed ads after ${roundsUsed} round${roundsUsed !== 1 ? 's' : ''} (${totalAdsGenerated} generated). ${readyToPostCount} Ready to Post ads created.`;
  }
  if (terminalStatus === TEST_RUN_ROUND_CAP_TERMINAL_STATUS || terminalStatus === 'failed_under_threshold_after_54') {
    return `Angle "${angleName}" reached ${totalAdsPassed}/${TEST_RUN_REQUIRED_PASSES} passed ads after ${roundsUsed} round${roundsUsed !== 1 ? 's' : ''} (${totalAdsGenerated} generated). Round cap reached with no Ready to Post flex ad.`;
  }
  if (terminalStatus === 'cancelled') {
    return `Angle "${angleName}" was cancelled after ${roundsUsed} round${roundsUsed !== 1 ? 's' : ''} (${totalAdsGenerated} generated, ${totalAdsPassed}/${TEST_RUN_REQUIRED_PASSES} passed so far).`;
  }
  return failureReason || `Angle "${angleName}" failed before reaching ${TEST_RUN_REQUIRED_PASSES} passed ads.`;
}

function buildPassingAdsMeta(passingAds) {
  return passingAds.map(({ ad, score }) => ({
    ad_id: ad.id,
    overall_score: score?.overall_score ?? 0,
  }));
}

function getFailedHardRequirements(score) {
  const hardRequirements = score?.hard_requirements && typeof score.hard_requirements === 'object'
    ? score.hard_requirements
    : {};
  const failedHardRequirements = Object.entries(hardRequirements)
    .filter(([key, value]) => key !== 'all_passed' && value === false)
    .map(([key]) => key);
  return { hardRequirements, failedHardRequirements };
}

function hasMeaningfulImageIssues(score) {
  const imageIssues = Array.isArray(score?.image_issues) ? score.image_issues.filter(Boolean) : [];
  if (imageIssues.length > 0) return true;
  const weaknessText = Array.isArray(score?.weaknesses) ? score.weaknesses.join(' ') : '';
  return /broken render|broken text|unreadable|distort|artifact|warped|mangled|deformed|placeholder|blank area|wrong product|missing product|impossible|composit/i.test(weaknessText);
}

function classifyScoreFailure(score) {
  const { hardRequirements, failedHardRequirements } = getFailedHardRequirements(score);
  const grammarFailed = failedHardRequirements.includes('spelling_grammar');
  const productFailed = failedHardRequirements.some((key) => ['product_present', 'correct_product'].includes(key));
  const imageFailed = failedHardRequirements.some((key) => ['visual_integrity', 'rendered_text_integrity', 'image_completeness'].includes(key));
  const legacyCopyFailed = failedHardRequirements.some((key) => ['first_line_hook', 'cta_at_end'].includes(key));
  const legacyHeadlineFailed = failedHardRequirements.includes('headline_alignment');
  const imageIssues = hasMeaningfulImageIssues(score);
  const imageQuality = Number(score?.visual_integrity_score ?? score?.image_quality);
  const copyStrength = Number(score?.copy_polish ?? score?.copy_strength);
  const effectiveness = Number(score?.effectiveness);
  const hardPassed = hardRequirements?.all_passed === true;
  const copyFailed = grammarFailed || legacyCopyFailed;
  const imageSignals = imageFailed || imageIssues || (Number.isFinite(imageQuality) && imageQuality > 0 && imageQuality <= 5);

  if (hardPassed) {
    if (Number.isFinite(imageQuality) && Number.isFinite(copyStrength) && imageQuality < copyStrength) {
      return {
        bucket: 'image_only',
        recommended_fix: 'rewrite_image',
        repairable_without_headline: true,
      };
    }
    if (Number.isFinite(copyStrength) && copyStrength > 0 && copyStrength < 6) {
      return {
        bucket: 'copy_only',
        recommended_fix: 'rewrite_body_copy',
        repairable_without_headline: true,
      };
    }
    if (Number.isFinite(effectiveness) && effectiveness < DIRECTOR_SCORE_THRESHOLD && imageSignals) {
      return {
        bucket: 'image_only',
        recommended_fix: 'rewrite_image',
        repairable_without_headline: true,
      };
    }
  }

  if ((!copyFailed && !legacyHeadlineFailed) && (productFailed || imageSignals)) {
    return {
      bucket: 'image_only',
      recommended_fix: 'rewrite_image',
      repairable_without_headline: true,
    };
  }

  if (copyFailed && !(productFailed || imageSignals)) {
    return {
      bucket: 'copy_only',
      recommended_fix: 'rewrite_body_copy',
      repairable_without_headline: true,
    };
  }

  return {
    bucket: 'mixed',
    recommended_fix: copyFailed ? 'rewrite_body_and_image' : 'rewrite_image',
    repairable_without_headline: true,
  };
}

function summarizeRoundFailures(failedAds) {
  const bucketCounts = {};
  const hardRequirementCounts = {};
  const imageThemeCounts = {};
  const themeMatchers = [
    ['missing_product', /missing product|product missing|no product|product absent/i],
    ['wrong_product', /wrong product|different product|competitor/i],
    ['unreadable_text_on_creative', /unreadable text|mangled text|broken text|illegible/i],
    ['broken_render', /broken render|blank area|placeholder|artifact|glitch|incomplete/i],
    ['irrational_image', /irrational|impossible|warped|deformed|mangled anatomy|extra finger|distorted/i],
    ['copy_polish_low', /copy polish|awkward|stiff|generic|grammar|typo/i],
    ['compliance_risk', /compliance|policy|before\/after|medical claim|guarantee/i],
  ];

  for (const failedAd of failedAds) {
    const bucket = failedAd.failure_bucket || 'unknown';
    bucketCounts[bucket] = (bucketCounts[bucket] || 0) + 1;
    for (const key of failedAd.failed_hard_requirements || []) {
      hardRequirementCounts[key] = (hardRequirementCounts[key] || 0) + 1;
    }
    const issueText = [...(failedAd.image_issues || []), ...(failedAd.weaknesses || [])].join(' ');
    for (const [theme, matcher] of themeMatchers) {
      if (matcher.test(issueText)) {
        imageThemeCounts[theme] = (imageThemeCounts[theme] || 0) + 1;
      }
    }
  }

  return {
    total_failed: failedAds.length,
    bucket_counts: bucketCounts,
    hard_requirement_counts: hardRequirementCounts,
    image_theme_counts: imageThemeCounts,
  };
}

function buildFailedAdsMeta(scoredAds) {
  return scoredAds
    .filter(({ score }) => !score?.pass)
    .map(({ ad, score }) => {
      const { hardRequirements, failedHardRequirements } = getFailedHardRequirements(score);
      const failureClassification = classifyScoreFailure(score);

      return {
        ad_id: ad?.id,
        headline: ad?.headline || '',
        body_copy_preview: (ad?.body_copy || '').slice(0, 320),
        overall_score: score?.overall_score ?? 0,
        copy_strength: score?.copy_strength ?? score?.copy_polish ?? null,
        copy_polish: score?.copy_polish ?? score?.copy_strength ?? null,
        compliance: score?.compliance ?? score?.meta_compliance ?? null,
        meta_compliance: score?.meta_compliance ?? score?.compliance ?? null,
        effectiveness: score?.effectiveness ?? null,
        image_quality: score?.image_quality ?? score?.visual_integrity_score ?? null,
        visual_integrity: score?.visual_integrity_score ?? score?.image_quality ?? null,
        visual_contract_match: score?.visual_contract_match ?? null,
        angle_category: score?.angle_category || null,
        failed_hard_requirements: failedHardRequirements,
        hard_requirements: hardRequirements,
        compliance_flags: Array.isArray(score?.compliance_flags) ? score.compliance_flags.filter(Boolean) : [],
        spelling_errors: Array.isArray(score?.spelling_errors) ? score.spelling_errors.filter(Boolean) : [],
        weaknesses: Array.isArray(score?.weaknesses) ? score.weaknesses.filter(Boolean) : [],
        strengths: Array.isArray(score?.strengths) ? score.strengths.filter(Boolean) : [],
        image_issues: Array.isArray(score?.image_issues) ? score.image_issues.filter(Boolean) : [],
        failure_bucket: failureClassification.bucket,
        recommended_fix: failureClassification.recommended_fix,
        repairable_without_headline: failureClassification.repairable_without_headline,
        error: score?.error || null,
      };
    });
}

function normalizeHeadlineDiagnostics(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const laneDistribution = Object.fromEntries(
    Object.entries(raw.lane_distribution || {})
      .map(([lane, count]) => [lane, Number(count) || 0])
      .filter(([, count]) => count > 0)
  );
  const headlineCandidates = Number(raw.headline_candidates);
  const headlineCount = Number(raw.headline_count);
  const duplicateRejections = Number(raw.duplicate_rejections);
  const historyRejections = Number(raw.history_rejections);
  const laneCount = Number(raw.lane_count) || Object.keys(laneDistribution).length;
  const hasDiagnostics =
    Number.isFinite(headlineCandidates) ||
    Number.isFinite(headlineCount) ||
    Number.isFinite(duplicateRejections) ||
    Number.isFinite(historyRejections) ||
    laneCount > 0;

  if (!hasDiagnostics) return null;

  return {
    ...(Number.isFinite(headlineCandidates) ? { headline_candidates: headlineCandidates } : {}),
    ...(Number.isFinite(headlineCount) ? { headline_count: headlineCount } : {}),
    ...(Number.isFinite(duplicateRejections) ? { duplicate_rejections: duplicateRejections } : {}),
    ...(Number.isFinite(historyRejections) ? { history_rejections: historyRejections } : {}),
    ...(laneCount > 0 ? { lane_count: laneCount } : {}),
    ...(Object.keys(laneDistribution).length > 0 ? { lane_distribution: laneDistribution } : {}),
  };
}

function extractHeadlineDiagnostics(batch) {
  if (!batch) return null;
  const pipelineState = parseJSON(batch.pipeline_state, {});
  const directDiagnostics = normalizeHeadlineDiagnostics(pipelineState?.headline_diagnostics || pipelineState);
  if (directDiagnostics) return directDiagnostics;

  const prompts = parseJSON(batch.gpt_prompts, []);
  if (!Array.isArray(prompts) || prompts.length === 0) return null;

  const laneDistribution = prompts.reduce((distribution, promptObj) => {
    const lane = typeof promptObj?.hook_lane === 'string' && promptObj.hook_lane.trim()
      ? promptObj.hook_lane.trim()
      : 'unassigned';
    distribution[lane] = (distribution[lane] || 0) + 1;
    return distribution;
  }, {});

  return normalizeHeadlineDiagnostics({
    headline_count: prompts.length,
    lane_count: Object.keys(laneDistribution).length,
    lane_distribution: laneDistribution,
  });
}

function extractHeadlineDiagnosticsSafe(batch, context = '') {
  try {
    return extractHeadlineDiagnostics(batch);
  } catch (err) {
    console.warn(`[Director] Failed to extract headline diagnostics${context ? ` for ${context}` : ''}:`, err.message);
    return null;
  }
}

function buildCompletedRoundDetail({
  batch,
  batchInfo,
  angleName,
  roundNumber,
  roundScoreResult,
  totalAdsPassed,
  repairSummary = null,
}) {
  const failedAds = buildFailedAdsMeta(roundScoreResult.scoredAds);
  const roundDetail = {
    round: roundNumber,
    batch_id: batchInfo.batch_id,
    angle_name: angleName,
    ads_generated: batchInfo.ad_count || roundScoreResult.ads_scored,
    ads_scored: roundScoreResult.ads_scored,
    ads_passed: roundScoreResult.ads_passed,
    cumulative_passed: totalAdsPassed,
    status: totalAdsPassed >= TEST_RUN_REQUIRED_PASSES ? 'threshold_reached' : 'below_threshold',
    completed_at: new Date().toISOString(),
    passing_ads: buildPassingAdsMeta(roundScoreResult.passingAds),
    failed_ads: failedAds,
    failure_summary: summarizeRoundFailures(failedAds),
  };

  if (repairSummary && repairSummary.attempted > 0) {
    roundDetail.repair_summary = repairSummary;
    roundDetail.repair_attempts = repairSummary.repair_attempts || [];
  }

  const headlineDiagnostics = extractHeadlineDiagnosticsSafe(
    batch,
    `round ${roundNumber} (${batchInfo.batch_id?.slice(0, 8) || 'unknown batch'})`
  );
  if (headlineDiagnostics) {
    Object.assign(roundDetail, headlineDiagnostics);
  }

  return roundDetail;
}

function updateScoredBatchInfo(batchInfo, roundScoreResult, extra = {}) {
  return {
    ...batchInfo,
    ads_scored: roundScoreResult.ads_scored,
    ads_passed: roundScoreResult.ads_passed,
    ...extra,
  };
}

function getRepairBatchLimit(remainingNeeded) {
  return Math.max(2, Math.min(8, remainingNeeded * 2));
}

function buildImageRepairNotes(score) {
  const notes = [];
  for (const issue of [...(score?.image_issues || []), ...(score?.weaknesses || [])]) {
    if (typeof issue === 'string' && issue.trim()) notes.push(issue.trim());
  }
  if ((score?.hard_requirements || {}).visual_integrity === false || (score?.hard_requirements || {}).image_completeness === false) {
    notes.push('Fix any broken render, placeholder, blank area, unrealistic artifact, or irrational visual detail.');
  }
  if ((score?.hard_requirements || {}).rendered_text_integrity === false) {
    notes.push('Keep the exact headline and body copy visible on the creative with clean, readable, correctly rendered text.');
  }
  if ((score?.hard_requirements || {}).product_present === false) {
    notes.push('Ensure the intended product is clearly present in the ad and positioned where the template implies it should appear.');
  }
  if ((score?.hard_requirements || {}).correct_product === false) {
    notes.push('Show the correct product only. Remove any unrelated or competitor-looking product imagery.');
  }
  if (!notes.some((note) => /headline|body copy|text hierarchy|layout/i.test(note))) {
    notes.push('Keep the exact headline and body copy visible on the creative with clean, readable text hierarchy.');
  }
  if (!notes.some((note) => /template|layout|composition/i.test(note))) {
    notes.push('Preserve a template-led ad layout with strong visual hierarchy and balanced composition.');
  }
  if (!notes.some((note) => /product/i.test(note))) {
    notes.push('Use the product framing and placement that best matches the selected template.');
  }
  return [...new Set(notes)].slice(0, 6);
}

async function loadRepairReferenceImage(projectId, ad) {
  if (ad?.template_image_id) {
    return await selectTemplateImage(ad.template_image_id);
  }
  if (ad?.inspiration_image_id) {
    return await selectInspirationImage(projectId, ad.inspiration_image_id);
  }
  return await selectInspirationImage(projectId, null);
}

async function createCopyRepairVariant({ originalAd, repairedBodyCopy, batchId }) {
  const newAdId = uuidv4();
  await convexClient.mutation(api.adCreatives.create, {
    externalId: newAdId,
    project_id: originalAd.project_id,
    generation_mode: 'copy_repair',
    angle: originalAd.angle || undefined,
    angle_name: originalAd.angle_name || undefined,
    headline: originalAd.headline || undefined,
    body_copy: repairedBodyCopy || undefined,
    hook_lane: originalAd.hook_lane || undefined,
    core_claim: originalAd.core_claim || undefined,
    target_symptom: originalAd.target_symptom || undefined,
    emotional_entry: originalAd.emotional_entry || undefined,
    desired_belief_shift: originalAd.desired_belief_shift || undefined,
    opening_pattern: originalAd.opening_pattern || undefined,
    sub_angle: originalAd.sub_angle || undefined,
    scoring_mode: originalAd.scoring_mode || undefined,
    copy_render_expectation: originalAd.copy_render_expectation || undefined,
    product_expectation: originalAd.product_expectation || undefined,
    image_prompt: originalAd.image_prompt || undefined,
    gpt_creative_output: originalAd.gpt_creative_output || undefined,
    template_image_id: originalAd.template_image_id || undefined,
    inspiration_image_id: originalAd.inspiration_image_id || undefined,
    storageId: originalAd.storageId || undefined,
    aspect_ratio: originalAd.aspect_ratio || '1:1',
    status: 'completed',
    auto_generated: true,
    parent_ad_id: originalAd.id || undefined,
    batch_job_id: batchId,
  });
  return await getAd(newAdId);
}

async function attemptRoundRepairs({
  roundScoreResult,
  projectId,
  batch,
  roundNumber,
  emit,
}) {
  const failedEntries = (roundScoreResult.scoredAds || [])
    .filter(({ score }) => !score?.pass)
    .map(({ ad, score }) => ({
      ad,
      score,
      ...classifyScoreFailure(score),
    }));

  const remainingNeeded = Math.max(TEST_RUN_REQUIRED_PASSES - roundScoreResult.passingAds.length, 0);
  if (failedEntries.length === 0 || remainingNeeded <= 0) {
    return {
      repairedPassingAds: [],
      repairedScoredAds: [],
      repairSummary: {
        attempted: 0,
        passed: 0,
        image_attempted: 0,
        image_passed: 0,
        copy_attempted: 0,
        copy_passed: 0,
      },
    };
  }

  const project = await getProject(projectId);
  if (!project) {
    return {
      repairedPassingAds: [],
      repairedScoredAds: [],
      repairSummary: {
        attempted: 0,
        passed: 0,
        image_attempted: 0,
        image_passed: 0,
        copy_attempted: 0,
        copy_passed: 0,
      },
    };
  }

  let angleBrief = null;
  if (batch?.angle_brief) {
    try { angleBrief = JSON.parse(batch.angle_brief); } catch {}
  }

  const maxAttempts = getRepairBatchLimit(remainingNeeded);
  const repairedScoredAds = [];
  const repairedPassingAds = [];
  const repairAttempts = [];
  const repairSummary = {
    attempted: 0,
    passed: 0,
    image_attempted: 0,
    image_passed: 0,
    copy_attempted: 0,
    copy_passed: 0,
  };

  const { scoreAd } = await import('./creativeFilterService.js');

  const imageCandidates = failedEntries
    .filter((entry) => entry.bucket === 'image_only')
    .sort((left, right) => (Number(right.score?.overall_score) || 0) - (Number(left.score?.overall_score) || 0));
  const copyCandidates = failedEntries
    .filter((entry) => entry.bucket === 'copy_only' && entry.repairable_without_headline)
    .sort((left, right) => (Number(right.score?.overall_score) || 0) - (Number(left.score?.overall_score) || 0));

  for (const entry of imageCandidates) {
    if (repairSummary.attempted >= maxAttempts) break;
    repairSummary.attempted += 1;
    repairSummary.image_attempted += 1;
    emit?.({
      type: 'progress',
      step: 'repairing_images',
      message: `Round ${roundNumber}: repairing image ${repairSummary.image_attempted} of ${Math.min(imageCandidates.length, maxAttempts)}...`,
    });
    let repairReference = null;
    try {
      repairReference = await loadRepairReferenceImage(projectId, entry.ad);
      const imagePrompt = await generateImagePrompt(
        project,
        entry.ad.headline,
        entry.ad.body_copy,
        entry.ad.emotional_entry || 'recognition',
        repairReference,
        entry.ad.aspect_ratio || '1:1',
        angleBrief,
        {
          hook_lane: entry.ad.hook_lane,
          sub_angle: entry.ad.sub_angle,
          core_claim: entry.ad.core_claim,
          target_symptom: entry.ad.target_symptom,
          emotional_entry: entry.ad.emotional_entry,
          desired_belief_shift: entry.ad.desired_belief_shift,
          opening_pattern: entry.ad.opening_pattern,
        },
        {
          repairNotes: buildImageRepairNotes(entry.score),
        }
      );
      const repairedAd = await regenerateImageOnly(projectId, {
        imagePrompt,
        aspectRatio: entry.ad.aspect_ratio || '1:1',
        parentAdId: entry.ad.id,
        angle: entry.ad.angle,
        angleName: entry.ad.angle_name,
        headline: entry.ad.headline,
        bodyCopy: entry.ad.body_copy,
        scoringMode: entry.ad.scoring_mode,
        copyRenderExpectation: entry.ad.copy_render_expectation,
        productExpectation: entry.ad.product_expectation,
        hookLane: entry.ad.hook_lane,
        coreClaim: entry.ad.core_claim,
        targetSymptom: entry.ad.target_symptom,
        emotionalEntry: entry.ad.emotional_entry,
        desiredBeliefShift: entry.ad.desired_belief_shift,
        openingPattern: entry.ad.opening_pattern,
        subAngle: entry.ad.sub_angle,
        templateImageId: entry.ad.template_image_id,
        inspirationImageId: entry.ad.inspiration_image_id,
      });
      const savedAd = await getAd(repairedAd.id);
      const repairedScore = await scoreAd(savedAd, 'No previous top performers available.', angleBrief, projectId);
      const scoredEntry = { ad: savedAd, score: repairedScore, repaired_from_ad_id: entry.ad.id, repair_mode: 'image_only' };
      repairedScoredAds.push(scoredEntry);
      repairAttempts.push({
        mode: 'image_only',
        source_ad_id: entry.ad.id,
        repaired_ad_id: savedAd?.id || null,
        passed: !!repairedScore?.pass,
        overall_score: repairedScore?.overall_score ?? 0,
      });
      if (repairedScore?.pass) {
        repairedPassingAds.push(scoredEntry);
        repairSummary.passed += 1;
        repairSummary.image_passed += 1;
      }
    } catch (err) {
      repairedScoredAds.push({
        ad: { id: entry.ad.id, headline: entry.ad.headline, body_copy: entry.ad.body_copy, angle: entry.ad.angle },
        score: { ad_id: entry.ad.id, overall_score: 0, pass: false, error: err.message },
        repaired_from_ad_id: entry.ad.id,
        repair_mode: 'image_only',
      });
      repairAttempts.push({
        mode: 'image_only',
        source_ad_id: entry.ad.id,
        repaired_ad_id: null,
        passed: false,
        overall_score: 0,
        error: err.message,
      });
    } finally {
      cleanupImageData(repairReference);
    }
  }

  for (const entry of copyCandidates) {
    if (repairSummary.attempted >= maxAttempts) break;
    repairSummary.attempted += 1;
    repairSummary.copy_attempted += 1;
    emit?.({
      type: 'progress',
      step: 'repairing_copy',
      message: `Round ${roundNumber}: repairing copy ${repairSummary.copy_attempted}...`,
    });
    try {
      const repairedCopy = await repairBodyCopy(project, {
        headline: entry.ad.headline,
        bodyCopy: entry.ad.body_copy,
        angleBrief,
        failedReasons: entry.score?.weaknesses || [],
        weaknesses: entry.score?.compliance_flags || [],
      });
      const repairedAd = await createCopyRepairVariant({
        originalAd: entry.ad,
        repairedBodyCopy: repairedCopy.body_copy,
        batchId: batch?.id || batch?.externalId || entry.ad.batch_job_id,
      });
      const repairedScore = await scoreAd(repairedAd, 'No previous top performers available.', angleBrief, projectId);
      const scoredEntry = { ad: repairedAd, score: repairedScore, repaired_from_ad_id: entry.ad.id, repair_mode: 'copy_only' };
      repairedScoredAds.push(scoredEntry);
      repairAttempts.push({
        mode: 'copy_only',
        source_ad_id: entry.ad.id,
        repaired_ad_id: repairedAd?.id || null,
        passed: !!repairedScore?.pass,
        overall_score: repairedScore?.overall_score ?? 0,
      });
      if (repairedScore?.pass) {
        repairedPassingAds.push(scoredEntry);
        repairSummary.passed += 1;
        repairSummary.copy_passed += 1;
      }
    } catch (err) {
      repairedScoredAds.push({
        ad: { id: entry.ad.id, headline: entry.ad.headline, body_copy: entry.ad.body_copy, angle: entry.ad.angle },
        score: { ad_id: entry.ad.id, overall_score: 0, pass: false, error: err.message },
        repaired_from_ad_id: entry.ad.id,
        repair_mode: 'copy_only',
      });
      repairAttempts.push({
        mode: 'copy_only',
        source_ad_id: entry.ad.id,
        repaired_ad_id: null,
        passed: false,
        overall_score: 0,
        error: err.message,
      });
    }
  }

  repairSummary.repair_attempts = repairAttempts;
  return { repairedPassingAds, repairedScoredAds, repairSummary, repairAttempts };
}

async function linkFlexAdToBatches(batchInfos, flexAdId, ...batchIds) {
  if (!flexAdId) return batchInfos;
  const uniqueBatchIds = [...new Set(batchIds.filter(Boolean))];
  if (uniqueBatchIds.length === 0) return batchInfos;

  await Promise.all(uniqueBatchIds.map(async (batchId) => {
    try {
      await updateBatchJob(batchId, { flex_ad_id: flexAdId });
    } catch (err) {
      console.warn(`[Director] Failed to link flex ad ${flexAdId.slice(0, 8)} to batch ${batchId.slice(0, 8)}:`, err.message);
    }
  }));

  return batchInfos.map((info) => (
    uniqueBatchIds.includes(info.batch_id)
      ? { ...info, flex_ad_id: flexAdId }
      : info
  ));
}

function isRunTerminallyDeployed(run) {
  return !!run && (run.status === 'completed' || run.terminal_status === 'deployed');
}

async function getLatestTestRunState(projectId, runId) {
  const runs = await getConductorRuns(projectId, 25);
  return runs.find((candidate) => candidate.externalId === runId) || null;
}

async function supersedePendingTestRunBatches(batchInfos, completedBatchIds = [], reason = 'Superseded after test run already deployed.') {
  const completed = new Set(completedBatchIds.filter(Boolean));
  for (const info of Array.isArray(batchInfos) ? batchInfos : []) {
    if (info?.batch_id && !completed.has(info.batch_id)) {
      info.status = 'superseded';
      info.error_message = reason;
    }
  }
  const pendingBatchIds = [...new Set(
    (Array.isArray(batchInfos) ? batchInfos : [])
      .map((info) => info?.batch_id)
      .filter((batchId) => batchId && !completed.has(batchId))
  )];

  await Promise.all(pendingBatchIds.map(async (batchId) => {
    try {
      await updateBatchJob(batchId, {
        status: 'superseded',
        error_message: reason,
      });
    } catch (err) {
      console.warn(`[Director] Failed to supersede batch ${batchId.slice(0, 8)}:`, err.message);
    }
  }));
}

async function finalizeSuccessfulTestRun({
  runId,
  projectId,
  angleName,
  batchInfos,
  roundDetails,
  currentBatchId = null,
  totalAdsGenerated,
  totalAdsScored,
  totalAdsPassed,
  finalizeResult,
  durationMs,
  skipLPGen = false,
  triggerLabel = 'test run',
}) {
  const readyToPostCount = finalizeResult.ready_to_post_count || 0;
  const flexAdId = finalizeResult.flex_ad_id || null;
  const bestRound = [...roundDetails].sort((a, b) => b.ads_passed - a.ads_passed)[0];
  const completedBatchIds = roundDetails.map((detail) => detail.batch_id).filter(Boolean);

  await supersedePendingTestRunBatches(
    batchInfos,
    completedBatchIds,
    'Superseded after test run already reached deployment threshold.'
  );

  batchInfos.splice(
    0,
    batchInfos.length,
    ...(await linkFlexAdToBatches(
      batchInfos,
      flexAdId,
      currentBatchId,
      bestRound?.batch_id,
    ))
  );

  await updateConductorRun(runId, {
    status: 'completed',
    terminal_status: 'deployed',
    error: '',
    failure_reason: '',
    error_stage: '',
    posting_days: getTestPostingDays(angleName),
    batches_created: stringifyJSON(batchInfos),
    rounds_json: stringifyJSON(roundDetails),
    total_rounds: roundDetails.length,
    total_ads_generated: totalAdsGenerated,
    total_ads_scored: totalAdsScored,
    total_ads_passed: totalAdsPassed,
    ready_to_post_count: readyToPostCount,
    flex_ad_id: flexAdId || undefined,
    duration_ms: durationMs,
    decisions: buildTestRunSummary({
      angleName,
      roundsUsed: roundDetails.length,
      totalAdsGenerated,
      totalAdsPassed,
      readyToPostCount,
      terminalStatus: 'deployed',
    }),
  });

  if (!skipLPGen && bestRound?.batch_id) {
    triggerLPGeneration(bestRound.batch_id, projectId, angleName).catch((err) => {
      console.warn(`[Pipeline] LP trigger for ${triggerLabel} ${runId.slice(0, 8)} failed:`, err.message);
    });
  }

  return {
    readyToPostCount,
    flexAdId,
    bestRound,
  };
}

function getBackgroundWaitingMessage(roundNumber) {
  return `Round ${roundNumber} is still processing in Gemini. Continuing in background.`;
}

async function hydratePassingAdsForRounds(roundDetails, projectId) {
  const hydrated = [];
  const cumulativePassingAds = [];
  let recoveredAny = false;
  let scoreBatchForInlineFilterFn = null;

  for (let i = 0; i < roundDetails.length; i++) {
    const round = { ...roundDetails[i], round: roundDetails[i].round || i + 1 };
    const passingMeta = Array.isArray(round.passing_ads) ? round.passing_ads : [];
    let passingAds = [];

    if (round.batch_id && passingMeta.length > 0) {
      const ads = await getAdsByBatchId(round.batch_id);
      const adMap = new Map(ads.map(ad => [ad.id, ad]));
      passingAds = passingMeta
        .map((meta) => {
          const ad = adMap.get(meta.ad_id);
          if (!ad) return null;
          return {
            ad,
            score: {
              ad_id: ad.id,
              overall_score: meta.overall_score ?? 0,
              pass: true,
            },
          };
        })
        .filter(Boolean);
    } else if (round.batch_id) {
      if (!scoreBatchForInlineFilterFn) {
        ({ scoreBatchForInlineFilter: scoreBatchForInlineFilterFn } = await import('./creativeFilterService.js'));
      }
      const recovered = await scoreBatchForInlineFilterFn(round.batch_id, projectId, null, {
        roundNumber: round.round,
        totalRounds: TEST_RUN_MAX_ROUNDS,
      });
      round.ads_scored = recovered.ads_scored;
      round.ads_passed = recovered.ads_passed;
      round.passing_ads = buildPassingAdsMeta(recovered.passingAds);
      round.failed_ads = buildFailedAdsMeta(recovered.scoredAds);
      passingAds = recovered.passingAds;
      recoveredAny = true;
    }

    cumulativePassingAds.push(...passingAds);
    round.cumulative_passed = cumulativePassingAds.length;
    round.status = cumulativePassingAds.length >= TEST_RUN_REQUIRED_PASSES ? 'threshold_reached' : 'below_threshold';
    hydrated.push(round);
  }

  return { roundDetails: hydrated, cumulativePassingAds, recoveredAny };
}

function findPendingBatchInfo(batchInfos, roundDetails) {
  const nextIndex = roundDetails.length;
  if (nextIndex >= batchInfos.length) return null;
  return { nextIndex, batchInfo: batchInfos[nextIndex] };
}

async function markTestRunWaitingOnGemini({
  runId,
  angleName,
  roundNumber,
  batchInfos,
  roundDetails,
  totalAdsGenerated,
  totalAdsScored,
  totalAdsPassed,
}) {
  await updateConductorRun(runId, {
    status: 'running',
    terminal_status: 'waiting_on_gemini',
    error: '',
    failure_reason: '',
    posting_days: angleName ? getTestPostingDays(angleName) : stringifyJSON([{ date: 'test', action: 'Waiting on Gemini' }]),
    batches_created: stringifyJSON(batchInfos),
    rounds_json: stringifyJSON(roundDetails),
    total_rounds: Math.max(roundDetails.length, roundNumber),
    total_ads_generated: totalAdsGenerated,
    total_ads_scored: totalAdsScored,
    total_ads_passed: totalAdsPassed,
    decisions: getBackgroundWaitingMessage(roundNumber),
  });
}

async function markTestRunBackgroundFailure({
  runId,
  angleName,
  batchInfos,
  roundDetails,
  totalAdsGenerated,
  totalAdsScored,
  totalAdsPassed,
  failureReason,
  terminalStatus = 'generation_failed',
  errorStage = undefined,
  durationMs = undefined,
}) {
  await updateConductorRun(runId, {
    status: 'failed',
    terminal_status: terminalStatus,
    error: failureReason,
    failure_reason: failureReason,
    error_stage: errorStage,
    posting_days: angleName ? getTestPostingDays(angleName) : stringifyJSON([{ date: 'test', action: 'Background test run failed' }]),
    batches_created: stringifyJSON(batchInfos),
    rounds_json: stringifyJSON(roundDetails),
    total_rounds: Math.max(roundDetails.length, batchInfos.length, 1),
    total_ads_generated: totalAdsGenerated,
    total_ads_scored: totalAdsScored,
    total_ads_passed: totalAdsPassed,
    ready_to_post_count: 0,
    ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
    decisions: buildTestRunSummary({
      angleName: angleName || 'Unknown angle',
      roundsUsed: Math.max(roundDetails.length, batchInfos.length, 1),
      totalAdsGenerated,
      totalAdsPassed,
      terminalStatus,
      failureReason,
    }),
  });
}

async function continueBackgroundTestRun(run) {
  const runId = run.externalId;
  const projectId = run.project_id;
  const batchInfos = parseJSON(run.batches_created, []);
  let roundDetails = parseJSON(run.rounds_json, []);
  const latestRun = await getLatestTestRunState(projectId, runId);
  if (isRunTerminallyDeployed(latestRun)) {
    await supersedePendingTestRunBatches(
      batchInfos,
      roundDetails.map((detail) => detail.batch_id).filter(Boolean)
    );
    return true;
  }
  const pending = findPendingBatchInfo(batchInfos, roundDetails);
  if (!pending) {
    return false;
  }

  const { batchInfo } = pending;
  const batch = await getBatchJob(batchInfo.batch_id);
  if (!batch) {
    await markTestRunBackgroundFailure({
      runId,
      angleName: batchInfo.angle_name || '',
      batchInfos,
      roundDetails,
      totalAdsGenerated: run.total_ads_generated || batchInfos.reduce((sum, info) => sum + (info.ad_count || 0), 0),
      totalAdsScored: run.total_ads_scored || 0,
      totalAdsPassed: run.total_ads_passed || 0,
      failureReason: `Round ${batchInfo.round || (roundDetails.length + 1)} batch record could not be found.`,
    });
    return true;
  }

  if (['pending', 'generating_prompts', 'submitting', 'processing'].includes(batch.status)) {
    const roundNumber = batchInfo.round || (roundDetails.length + 1);
    const terminalStatus = batch.gemini_batch_job ? 'waiting_on_gemini' : 'building_round';
    const phaseMessage = batch.gemini_batch_job
      ? getBackgroundWaitingMessage(roundNumber)
      : `Round ${roundNumber} is still building prompts. Continuing in background.`;
    await updateConductorRun(runId, {
      status: 'running',
      terminal_status: terminalStatus,
      error: '',
      failure_reason: '',
      posting_days: getTestPostingDays(batchInfo.angle_name || batch.angle_name || ''),
      batches_created: stringifyJSON(batchInfos),
      rounds_json: stringifyJSON(roundDetails),
      total_rounds: Math.max(roundDetails.length, roundNumber),
      total_ads_generated: run.total_ads_generated || batchInfos.reduce((sum, info) => sum + (info.ad_count || 0), 0),
      total_ads_scored: run.total_ads_scored || 0,
      total_ads_passed: run.total_ads_passed || 0,
      decisions: phaseMessage,
    });
    return false;
  }

  if (batch.status === 'failed') {
    await markTestRunBackgroundFailure({
      runId,
      angleName: batchInfo.angle_name || batch.angle_name || '',
      batchInfos,
      roundDetails,
      totalAdsGenerated: run.total_ads_generated || batchInfos.reduce((sum, info) => sum + (info.ad_count || 0), 0),
      totalAdsScored: run.total_ads_scored || 0,
      totalAdsPassed: run.total_ads_passed || 0,
      failureReason: batch.error_message || `Round ${batchInfo.round || (roundDetails.length + 1)} batch failed.`,
      terminalStatus: 'provider_failed',
    });
    return true;
  }

  if (batch.status !== 'completed') {
    return false;
  }

  let backgroundErrorStage = 'post_score_round_processing';
  let activeRoundState = null;

  try {
    const { scoreBatchForInlineFilter, finalizePassingAds } = await import('./creativeFilterService.js');
    const hydrated = await hydratePassingAdsForRounds(roundDetails, projectId);
    roundDetails = hydrated.roundDetails;
    const cumulativePassingAds = [...hydrated.cumulativePassingAds];

    const roundNumber = batchInfo.round || (roundDetails.length + 1);
    backgroundErrorStage = 'filter_scoring';
    const roundScoreResult = await scoreBatchForInlineFilter(batchInfo.batch_id, projectId, null, {
      roundNumber,
      totalRounds: TEST_RUN_MAX_ROUNDS,
    });
    backgroundErrorStage = 'post_score_round_processing';
    activeRoundState = {
      batchInfo,
      roundNumber,
      batch: roundScoreResult.batch || batch,
      rawScoreResult: roundScoreResult,
      mergedRoundScoreResult: roundScoreResult,
      repairSummary: null,
      countsApplied: false,
      detailPersisted: false,
    };

    const repairResult = await attemptRoundRepairs({
      roundScoreResult,
      projectId,
      batch: roundScoreResult.batch || batch,
      roundNumber,
      emit: null,
    });
    activeRoundState.repairSummary = repairResult.repairSummary;
    activeRoundState.mergedRoundScoreResult = {
      ...roundScoreResult,
      passingAds: [...roundScoreResult.passingAds, ...repairResult.repairedPassingAds],
      scoredAds: [...roundScoreResult.scoredAds, ...repairResult.repairedScoredAds],
      ads_passed: roundScoreResult.ads_passed + (repairResult.repairSummary?.passed || 0),
    };

    if (repairResult.repairedPassingAds.length > 0) {
      cumulativePassingAds.push(...repairResult.repairedPassingAds);
    }
    cumulativePassingAds.push(...roundScoreResult.passingAds);
    const totalAdsGenerated = batchInfos.reduce((sum, info) => sum + (info.ad_count || 0), 0);
    const totalAdsScored = roundDetails.reduce((sum, detail) => sum + (detail.ads_scored || 0), 0) + roundScoreResult.ads_scored + (repairResult.repairSummary?.attempted || 0);
    const totalAdsPassed = cumulativePassingAds.length;
    activeRoundState.countsApplied = true;
    const angleName = batchInfo.angle_name || batch.angle_name || '';

    const roundDetail = buildCompletedRoundDetail({
      batch: roundScoreResult.batch || batch,
      batchInfo,
      angleName,
      roundNumber,
      roundScoreResult: activeRoundState.mergedRoundScoreResult,
      totalAdsPassed,
      repairSummary: repairResult.repairSummary,
    });
    roundDetails.push(roundDetail);
    activeRoundState.detailPersisted = true;

    batchInfos[batchInfos.length - 1] = updateScoredBatchInfo(batchInfo, roundScoreResult, {
      repair_attempts: repairResult.repairSummary?.attempted || 0,
      repair_passes: repairResult.repairSummary?.passed || 0,
    });

    if (totalAdsPassed >= TEST_RUN_REQUIRED_PASSES) {
      backgroundErrorStage = 'filter_finalization';
      const finalizeResult = await finalizePassingAds({
        passingAds: cumulativePassingAds,
        projectId,
        batchId: batchInfo.batch_id,
        postingDay: 'test',
        angleName,
      });

      if (finalizeResult.flex_ads_created === 0) {
        let failureReason = 'Unknown error during Creative Filter';
        let terminalStatus = 'deploy_failed';
        if (finalizeResult.grouping_failed) {
          failureReason = `${totalAdsPassed} approved ads were available, but grouping could not create a flex ad.`;
          terminalStatus = 'grouping_failed';
        } else if (finalizeResult.deploy_error) {
          failureReason = `Reached ${totalAdsPassed}/${TEST_RUN_REQUIRED_PASSES} passed ads, but deployment failed: ${finalizeResult.deploy_error}`;
        }

        await updateConductorRun(runId, {
          status: 'failed',
          terminal_status: terminalStatus,
          error: failureReason,
          failure_reason: failureReason,
          error_stage: backgroundErrorStage,
          posting_days: getTestPostingDays(angleName),
          batches_created: stringifyJSON(batchInfos),
          rounds_json: stringifyJSON(roundDetails),
          total_rounds: roundDetails.length,
          total_ads_generated: totalAdsGenerated,
          total_ads_scored: totalAdsScored,
          total_ads_passed: totalAdsPassed,
          ready_to_post_count: 0,
          duration_ms: Date.now() - run.run_at,
          decisions: buildTestRunSummary({
            angleName,
            roundsUsed: roundDetails.length,
            totalAdsGenerated,
            totalAdsPassed,
            terminalStatus,
            failureReason,
          }),
        });
        return true;
      }

      await finalizeSuccessfulTestRun({
        runId,
        projectId,
        angleName,
        batchInfos,
        roundDetails,
        currentBatchId: batchInfo.batch_id,
        totalAdsGenerated,
        totalAdsScored,
        totalAdsPassed,
        finalizeResult,
        durationMs: Date.now() - run.run_at,
        skipLPGen: !!run.skip_lp_gen,
        triggerLabel: 'background test run',
      });

      console.log(`[Director] Resumed test run ${runId.slice(0, 8)} completed in background: ${totalAdsPassed}/${TEST_RUN_REQUIRED_PASSES} passed`);
      return true;
    }

    if (roundNumber >= TEST_RUN_MAX_ROUNDS) {
      const failureReason = `Reached ${totalAdsPassed}/${TEST_RUN_REQUIRED_PASSES} passed ads after ${totalAdsGenerated} generated across ${TEST_RUN_MAX_ROUNDS} rounds. Round cap reached with no Ready to Post flex ad.`;
      await updateConductorRun(runId, {
        status: 'failed',
        terminal_status: TEST_RUN_ROUND_CAP_TERMINAL_STATUS,
        error: failureReason,
        failure_reason: failureReason,
        error_stage: backgroundErrorStage,
        posting_days: getTestPostingDays(angleName),
        batches_created: stringifyJSON(batchInfos),
        rounds_json: stringifyJSON(roundDetails),
        total_rounds: roundDetails.length,
        total_ads_generated: totalAdsGenerated,
        total_ads_scored: totalAdsScored,
        total_ads_passed: totalAdsPassed,
        ready_to_post_count: 0,
        duration_ms: Date.now() - run.run_at,
        decisions: buildTestRunSummary({
          angleName,
          roundsUsed: roundDetails.length,
          totalAdsGenerated,
          totalAdsPassed,
          terminalStatus: TEST_RUN_ROUND_CAP_TERMINAL_STATUS,
        }),
      });
      console.warn(`[Director] Background test run ${runId.slice(0, 8)} failed at hard cap`);
      return true;
    }

    backgroundErrorStage = 'building_next_round';
    const latestBeforeNextRound = await getLatestTestRunState(projectId, runId);
    if (isRunTerminallyDeployed(latestBeforeNextRound)) {
      await supersedePendingTestRunBatches(
        batchInfos,
        roundDetails.map((detail) => detail.batch_id).filter(Boolean)
      );
      console.log(`[Director] Ignoring stale background continuation for deployed run ${runId.slice(0, 8)}`);
      return true;
    }
    const project = await getProject(projectId);
    if (!project) {
      await markTestRunBackgroundFailure({
        runId,
        angleName,
        batchInfos,
        roundDetails,
        totalAdsGenerated,
        totalAdsScored,
        totalAdsPassed,
        failureReason: 'Project not found while preparing the next round.',
        terminalStatus: TEST_RUN_ORCHESTRATION_FAILURE_STATUS,
        errorStage: backgroundErrorStage,
        durationMs: Date.now() - run.run_at,
      });
      return true;
    }

    const nextBatchSize = getTestRoundBatchSize(roundNumber + 1, totalAdsPassed);
    const nextBatchInfo = await createTestBatchRound({
      projectId,
      project,
      runId,
      angleInfo: { name: angleName, externalId: 'background' },
      anglePrompt: batch.angle_prompt || batch.angle || batchInfo.angle_prompt || '',
      angleBriefJSON: batch.angle_brief || batchInfo.angle_brief,
      batchSize: nextBatchSize,
      roundNumber: roundNumber + 1,
      emit: () => {},
      updateAngleUsage: false,
    });

    batchInfos.push(nextBatchInfo);
    const roundPassDisplay = roundScoreResult.ads_passed + (repairResult.repairSummary?.passed || 0);
    const nextRoundMessage = `Round ${roundNumber} complete: ${roundPassDisplay}/${roundScoreResult.ads_scored} passed, ${totalAdsPassed}/${TEST_RUN_REQUIRED_PASSES} total. Starting round ${roundNumber + 1} with ${nextBatchSize} ads in background...`;

    await updateConductorRun(runId, {
      status: 'running',
      terminal_status: 'building_round',
      error: '',
      failure_reason: '',
      error_stage: '',
      posting_days: getTestPostingDays(angleName),
      batches_created: stringifyJSON(batchInfos),
      rounds_json: stringifyJSON(roundDetails),
      total_rounds: roundDetails.length + 1,
      total_ads_generated: totalAdsGenerated + nextBatchInfo.ad_count,
      total_ads_scored: totalAdsScored,
      total_ads_passed: totalAdsPassed,
      decisions: nextRoundMessage,
    });

    runBatch(nextBatchInfo.batch_id).catch(async (err) => {
      console.error(`[Director] Background batch ${nextBatchInfo.batch_id.slice(0, 8)} failed for test run ${runId.slice(0, 8)}:`, err.message);
      try {
        await markTestRunBackgroundFailure({
          runId,
          angleName,
          batchInfos,
          roundDetails,
          totalAdsGenerated: totalAdsGenerated + nextBatchInfo.ad_count,
          totalAdsScored,
          totalAdsPassed,
          failureReason: err.message,
          errorStage: 'building_next_round',
          durationMs: Date.now() - run.run_at,
        });
      } catch (updateErr) {
        console.error(`[Director] Failed to mark background test run ${runId.slice(0, 8)} as failed:`, updateErr.message);
      }
    });

    console.log(`[Director] Resumed test run ${runId.slice(0, 8)} started round ${roundNumber + 1} in background`);
    return true;
  } catch (err) {
    if (activeRoundState?.rawScoreResult) {
      const priorScored = run.total_ads_scored || roundDetails.reduce((sum, detail) => sum + (detail.ads_scored || 0), 0);
      const priorPassed = run.total_ads_passed || roundDetails.at(-1)?.cumulative_passed || 0;
      const repairedAttempts = activeRoundState.repairSummary?.attempted || 0;
      const repairedPasses = activeRoundState.repairSummary?.passed || 0;

      if (!activeRoundState.countsApplied) {
        batchInfos[batchInfos.length - 1] = updateScoredBatchInfo(activeRoundState.batchInfo, activeRoundState.rawScoreResult, {
          repair_attempts: repairedAttempts,
          repair_passes: repairedPasses,
        });
      }

      if (!activeRoundState.detailPersisted) {
        const recoveredTotalAdsPassed = priorPassed + (activeRoundState.mergedRoundScoreResult?.ads_passed || activeRoundState.rawScoreResult.ads_passed || 0);
        roundDetails.push(buildCompletedRoundDetail({
          batch: activeRoundState.batch,
          batchInfo: activeRoundState.batchInfo,
          angleName: batchInfo.angle_name || batch.angle_name || '',
          roundNumber: activeRoundState.roundNumber,
          roundScoreResult: activeRoundState.mergedRoundScoreResult || activeRoundState.rawScoreResult,
          totalAdsPassed: recoveredTotalAdsPassed,
          repairSummary: activeRoundState.repairSummary,
        }));
        activeRoundState.detailPersisted = true;
      }

      run.total_ads_scored = priorScored + activeRoundState.rawScoreResult.ads_scored + repairedAttempts;
      run.total_ads_passed = priorPassed + (activeRoundState.mergedRoundScoreResult?.ads_passed || activeRoundState.rawScoreResult.ads_passed || 0);
    }

    await markTestRunBackgroundFailure({
      runId,
      angleName: batchInfo.angle_name || batch.angle_name || '',
      batchInfos,
      roundDetails,
      totalAdsGenerated: run.total_ads_generated || batchInfos.reduce((sum, info) => sum + (info.ad_count || 0), 0),
      totalAdsScored: run.total_ads_scored || roundDetails.reduce((sum, detail) => sum + (detail.ads_scored || 0), 0),
      totalAdsPassed: run.total_ads_passed || roundDetails.at(-1)?.cumulative_passed || 0,
      failureReason: err.message || 'Background test run failed during post-score processing.',
      terminalStatus: TEST_RUN_ORCHESTRATION_FAILURE_STATUS,
      errorStage: backgroundErrorStage,
      durationMs: Date.now() - run.run_at,
    });
    console.error(`[Director] Background test run ${runId.slice(0, 8)} failed during ${backgroundErrorStage}:`, err.message);
    return true;
  }
}

export async function resumeBackgroundTestRuns() {
  const configs = await getAllConductorConfigs();
  const projectIds = [...new Set(configs.map(config => config.project_id))];

  for (const projectId of projectIds) {
    if (findTrackedTestRun(projectId)) continue;

    const runs = await getConductorRuns(projectId, 10);
    const testRuns = runs.filter((run) => run.run_type === 'test');
    const candidate = testRuns.find((run) => run.status === 'running')
      || testRuns.find((run) => {
        const failure = run.failure_reason || run.error || '';
        return run.status === 'failed' && failure.includes(getGeminiTimeoutMessage(1).replace('Round 1 ', ''));
      });

    if (!candidate) continue;

    try {
      await continueBackgroundTestRun(candidate);
    } catch (err) {
      console.error(`[Director] Background resume error for test run ${candidate.externalId.slice(0, 8)}:`, err.message);
    }
  }
}

/**
 * Run a single test batch for a project — bypasses production windows and deficit checks.
 * Creates one full batch, fires it, and lets the Filter pick it up end-to-end.
 * @param {string} projectId
 */
export async function runTestBatch(projectId, sendEvent, { skipBatchLaunch = false, batchSizeOverride = null, angleOverride = null } = {}) {
  const emit = sendEvent || (() => {});
  const startMs = Date.now();
  const runId = uuidv4();

  emit({ type: 'progress', step: 'initializing', message: 'Loading project config...' });

  await createConductorRun({
    externalId: runId,
    project_id: projectId,
    run_type: 'test',
    run_at: startMs,
    status: 'running',
    required_passes: TEST_RUN_REQUIRED_PASSES,
    ads_per_round: batchSizeOverride || TEST_RUN_INITIAL_ADS_PER_ROUND,
    max_rounds: 1,
  });

  try {
    emit({ type: 'progress', step: 'selecting_angle', message: 'Selecting angle...' });
    const { project, angleInfo, anglePrompt, angleBriefJSON } = await loadTestRunContext(projectId, angleOverride);

    emit({ type: 'progress', step: 'building_prompt', message: `Building prompt for "${angleInfo.name}"...` });
    const batchSize = batchSizeOverride || TEST_RUN_INITIAL_ADS_PER_ROUND;
    const batchInfo = await createTestBatchRound({
      projectId,
      project,
      runId,
      angleInfo,
      anglePrompt,
      angleBriefJSON,
      batchSize,
      roundNumber: 1,
      emit,
      updateAngleUsage: true,
    });

    emit({ type: 'progress', step: 'saving_run', message: 'Saving run record...' });
    await updateConductorRun(runId, {
      status: 'completed',
      terminal_status: 'batch_created',
      posting_days: getTestPostingDays(angleInfo.name),
      batches_created: stringifyJSON([batchInfo]),
      decisions: `Test run: created 1 batch (${batchSize} ads) with angle "${angleInfo.name}".`,
      total_rounds: 1,
      total_ads_generated: batchSize,
      duration_ms: Date.now() - startMs,
    });

    console.log(`[Director] Test run for ${projectId.slice(0, 8)}: Created 1 batch (${batchSize} ads, angle: ${angleInfo.name}) in ${Date.now() - startMs}ms`);

    if (!skipBatchLaunch) {
      emit({ type: 'progress', step: 'launching_batch', message: `Launching batch pipeline for "${angleInfo.name}"...` });
      runBatch(batchInfo.batch_id).catch(err => {
        console.error(`[Director] Test batch ${batchInfo.batch_id.slice(0, 8)} failed:`, err.message);
      });
      triggerLPGeneration(batchInfo.batch_id, projectId, angleInfo.name).catch(err => {
        console.warn(`[Director] LP trigger for test batch ${batchInfo.batch_id.slice(0, 8)} failed:`, err.message);
      });
    } else {
      emit({ type: 'progress', step: 'launching_batch', message: 'Batch created, starting full pipeline...' });
    }

    return {
      runId,
      batches_created: 1,
      batch_id: batchInfo.batch_id,
      angle: angleInfo.name,
      ad_count: batchSize,
    };
  } catch (err) {
    await updateConductorRun(runId, {
      status: 'failed',
      terminal_status: 'generation_failed',
      error: err.message,
      failure_reason: err.message,
      duration_ms: Date.now() - startMs,
    });
    throw err;
  }
}

// ── In-memory progress tracking for test runs (survives SSE disconnect) ──────
const activeTestRuns = new Map();

const PIPELINE_STEP_PROGRESS = {
  'initializing': 1, 'selecting_angle': 1, 'building_prompt': 1,
  'creating_batch': 2, 'saving_run': 2, 'launching_batch': 2,
  'batch_brief': 4, 'batch_headlines': 6, 'batch_body_copy': 9,
  'batch_image_prompts': 12, 'batch_submitting': 14, 'batch_submitted': 15,
  'gemini_waiting': 15, 'gemini_complete': 60,
  'filter_scoring': 62, 'repairing_images': 68, 'repairing_copy': 72, 'filter_grouping': 82, 'filter_copy_gen': 86,
  'filter_deploying': 92, 'filter_complete': 95,
};

function findTrackedTestRun(projectId) {
  for (const [id, run] of activeTestRuns) {
    if (run.projectId === projectId && run.status === 'running') {
      return [id, run];
    }
  }
  return null;
}

async function hasDurableActiveTestRun(projectId) {
  const runs = await getConductorRuns(projectId, 10);
  return runs.some((run) => run.run_type === 'test' && run.status === 'running');
}

/**
 * Get the active test run for a project (if any).
 * @param {string} projectId
 * @returns {{ id: string, projectId: string, status: string, progress: number, phase: string, startTime: number, result: object|null }|null}
 */
export function getActiveTestRun(projectId) {
  const tracked = findTrackedTestRun(projectId);
  if (!tracked) return null;
  const [id, run] = tracked;
  return { id, ...run };
}

/**
 * Cancel the active test run for a project.
 * Marks the in-memory tracking entry so the pipeline cooperatively stops.
 */
export function cancelTestRun(projectId) {
  const tracked = findTrackedTestRun(projectId);
  if (!tracked) return false;
  const [, run] = tracked;
  run.cancelRequested = true;
  run.phase = 'Cancelling...';
  return true;
}

// ── Full Test Pipeline (Director → Batch → Gemini → Filter → Ready to Post) ──

/**
 * Run the full test pipeline with a single SSE stream tracking all phases.
 *
 * @param {string} projectId
 * @param {(event: object) => void} sendEvent - SSE event emitter
 * @param {{ angleOverride?: string }} options
 * @returns {object} Combined result from Director + Filter phases
 */
export async function runFullTestPipeline(projectId, sendEvent, { angleOverride = null, skipLPGen = false } = {}) {
  const rawEmit = sendEvent || (() => {});

  if (findTrackedTestRun(projectId) || await hasDurableActiveTestRun(projectId)) {
    throw new Error('A test run is already in progress for this project. Cancel it or wait for it to finish before starting another.');
  }

  // Track progress in-memory so polling endpoint can serve it after SSE disconnect
  const runProgress = {
    projectId,
    status: 'running',
    progress: 0,
    phase: 'Starting...',
    startTime: Date.now(),
    result: null,
    cancelRequested: false,
    currentBatchId: null,
    runId: null,
  };
  const trackingId = `pending-${Date.now()}`;
  activeTestRuns.set(trackingId, runProgress);

  const throwIfRunCancelled = () => {
    if (runProgress.cancelRequested) {
      throw new Error('Cancelled by user');
    }
  };

  const emit = (event) => {
    rawEmit(event);
    if (event.type === 'progress') {
      if (!runProgress.cancelRequested) {
        runProgress.phase = event.message || runProgress.phase;
        if (typeof event.progressValue === 'number') {
          runProgress.progress = Math.max(runProgress.progress, event.progressValue);
        }
        if (event.step && PIPELINE_STEP_PROGRESS[event.step] !== undefined) {
          runProgress.progress = Math.max(runProgress.progress, PIPELINE_STEP_PROGRESS[event.step]);
        }
        if (event.step === 'gemini_polling' && event.elapsed) {
          const ratio = Math.min(event.elapsed / 600, 0.95);
          const pct = 15 + Math.round(ratio * 43);
          runProgress.progress = Math.max(runProgress.progress, pct);
        }
        if (event.step === 'filter_scoring' && event.scoringProgress) {
          const { current, total } = event.scoringProgress;
          const pct = 62 + Math.round((current / total) * 18);
          runProgress.progress = Math.max(runProgress.progress, pct);
        }
      }
    } else if (event.type === 'complete') {
      runProgress.status = 'complete';
      runProgress.progress = 100;
      runProgress.phase = 'Complete';
      runProgress.result = event;
      setTimeout(() => activeTestRuns.delete(trackingId), 60000);
    } else if (event.type === 'error') {
      runProgress.status = 'error';
      runProgress.progress = 0;
      runProgress.phase = event.message || 'Failed';
      runProgress.result = event;
      setTimeout(() => activeTestRuns.delete(trackingId), 60000);
    }
  };
  let runId = null;
  let angleName = '';
  const batchInfos = [];
  const roundDetails = [];
  let totalAdsGenerated = 0;
  let totalAdsScored = 0;
  let totalAdsPassed = 0;
  let errorStage = 'initializing';
  let activeRoundState = null;

  try {
    emit({ type: 'progress', step: 'initializing', message: 'Loading project config...' });
    runId = uuidv4();
    runProgress.runId = runId;

    await createConductorRun({
      externalId: runId,
      project_id: projectId,
      run_type: 'test',
      run_at: runProgress.startTime,
      status: 'running',
      required_passes: TEST_RUN_REQUIRED_PASSES,
      ads_per_round: TEST_RUN_INITIAL_ADS_PER_ROUND,
      max_rounds: TEST_RUN_MAX_ROUNDS,
      skip_lp_gen: !!skipLPGen,
    });

    throwIfRunCancelled();
    errorStage = 'selecting_angle';
    emit({ type: 'progress', step: 'selecting_angle', message: 'Selecting angle...' });
    const { project, angleInfo, anglePrompt, angleBriefJSON } = await loadTestRunContext(projectId, angleOverride);
    angleName = angleInfo.name;
    errorStage = 'building_prompt';
    emit({ type: 'progress', step: 'building_prompt', message: `Building prompt for "${angleName}"...` });

    const { scoreBatchForInlineFilter, finalizePassingAds } = await import('./creativeFilterService.js');
    const cumulativePassingAds = [];

    for (let roundNumber = 1; roundNumber <= TEST_RUN_MAX_ROUNDS; roundNumber++) {
      throwIfRunCancelled();
      errorStage = 'creating_batch';
      const batchSize = getTestRoundBatchSize(roundNumber, totalAdsPassed);
      console.log(`[Director] Test run ${runId.slice(0, 8)} round ${roundNumber}/${TEST_RUN_MAX_ROUNDS}: creating ${batchSize} ads for "${angleName}"`);
      const batchInfo = await createTestBatchRound({
        projectId,
        project,
        runId,
        angleInfo,
        anglePrompt,
        angleBriefJSON,
        batchSize,
        roundNumber,
        emit,
        updateAngleUsage: roundNumber === 1,
      });

      batchInfos.push(batchInfo);
      runProgress.currentBatchId = batchInfo.batch_id;
      totalAdsGenerated += batchInfo.ad_count;

      await updateConductorRun(runId, {
        status: 'running',
        posting_days: getTestPostingDays(angleName),
        batches_created: stringifyJSON(batchInfos),
        rounds_json: stringifyJSON(roundDetails),
        total_rounds: roundNumber,
        total_ads_generated: totalAdsGenerated,
        total_ads_scored: totalAdsScored,
        total_ads_passed: totalAdsPassed,
        decisions: `Testing "${angleName}" — round ${roundNumber} of ${TEST_RUN_MAX_ROUNDS} started.`,
      });

      const roundExecution = await executeTestBatchRound(batchInfo.batch_id, roundNumber, emit, () => runProgress.cancelRequested);
      if (roundExecution?.deferred) {
        const backgroundMessage = getBackgroundWaitingMessage(roundNumber);
        await markTestRunWaitingOnGemini({
          runId,
          angleName,
          roundNumber,
          batchInfos,
          roundDetails,
          totalAdsGenerated,
          totalAdsScored,
          totalAdsPassed,
        });
        activeTestRuns.delete(trackingId);
        return {
          runId,
          angle: angleName,
          rounds_used: roundDetails.length,
          total_ads_generated: totalAdsGenerated,
          ads_scored: totalAdsScored,
          ads_passed: totalAdsPassed,
          ready_to_post_count: 0,
          terminal_status: 'waiting_on_gemini',
          run_in_background: true,
          background_message: backgroundMessage,
          phase: backgroundMessage,
        };
      }
      throwIfRunCancelled();

      errorStage = 'filter_scoring';
      const roundScoreResult = await scoreBatchForInlineFilter(
        batchInfo.batch_id,
        projectId,
        (event) => emit(withTestProgress(roundNumber, event)),
        { roundNumber, totalRounds: TEST_RUN_MAX_ROUNDS }
      );
      throwIfRunCancelled();
      errorStage = 'post_score_round_processing';
      activeRoundState = {
        batchInfo,
        roundNumber,
        batch: roundScoreResult.batch,
        rawScoreResult: roundScoreResult,
        mergedRoundScoreResult: roundScoreResult,
        repairSummary: null,
        countsApplied: false,
        detailPersisted: false,
      };

      const repairResult = await attemptRoundRepairs({
        roundScoreResult,
        projectId,
        batch: roundScoreResult.batch,
        roundNumber,
        emit: (event) => emit(withTestProgress(roundNumber, event)),
      });
      activeRoundState.repairSummary = repairResult.repairSummary;
      activeRoundState.mergedRoundScoreResult = {
        ...roundScoreResult,
        passingAds: [...roundScoreResult.passingAds, ...repairResult.repairedPassingAds],
        scoredAds: [...roundScoreResult.scoredAds, ...repairResult.repairedScoredAds],
        ads_passed: roundScoreResult.ads_passed + (repairResult.repairSummary?.passed || 0),
      };

      if (repairResult.repairedPassingAds.length > 0) {
        cumulativePassingAds.push(...repairResult.repairedPassingAds);
      }
      cumulativePassingAds.push(...roundScoreResult.passingAds);
      totalAdsScored += roundScoreResult.ads_scored + (repairResult.repairSummary?.attempted || 0);
      totalAdsPassed = cumulativePassingAds.length;
      activeRoundState.countsApplied = true;
      console.log(`[Director] Test run ${runId.slice(0, 8)} round ${roundNumber}/${TEST_RUN_MAX_ROUNDS}: ${roundScoreResult.ads_passed}+${repairResult.repairSummary?.passed || 0}/${roundScoreResult.ads_scored} passed, ${totalAdsPassed}/${TEST_RUN_REQUIRED_PASSES} cumulative`);
      const roundDetail = buildCompletedRoundDetail({
        batch: roundScoreResult.batch,
        batchInfo,
        angleName,
        roundNumber,
        roundScoreResult: activeRoundState.mergedRoundScoreResult,
        totalAdsPassed,
        repairSummary: repairResult.repairSummary,
      });
      roundDetails.push(roundDetail);
      activeRoundState.detailPersisted = true;

      batchInfos[batchInfos.length - 1] = updateScoredBatchInfo(batchInfo, roundScoreResult, {
        repair_attempts: repairResult.repairSummary?.attempted || 0,
        repair_passes: repairResult.repairSummary?.passed || 0,
      });

      if (totalAdsPassed >= TEST_RUN_REQUIRED_PASSES) {
        errorStage = 'filter_finalization';
        const finalizeResult = await finalizePassingAds({
          passingAds: cumulativePassingAds,
          projectId,
          batchId: batchInfo.batch_id,
          postingDay: 'test',
          angleName,
          onProgress: (event) => emit(withTestProgress(TEST_RUN_MAX_ROUNDS, event)),
        });

        if (finalizeResult.flex_ads_created === 0) {
          let failureReason = 'Unknown error during Creative Filter';
          let terminalStatus = 'deploy_failed';
          if (finalizeResult.grouping_failed) {
            failureReason = `${totalAdsPassed} approved ads were available, but grouping could not create a flex ad.`;
            terminalStatus = 'grouping_failed';
          } else if (finalizeResult.deploy_error) {
            failureReason = `Reached ${totalAdsPassed}/${TEST_RUN_REQUIRED_PASSES} passed ads, but deployment failed: ${finalizeResult.deploy_error}`;
          }

          await updateConductorRun(runId, {
            status: 'failed',
            terminal_status: terminalStatus,
            error: failureReason,
            failure_reason: failureReason,
            error_stage: errorStage,
            posting_days: getTestPostingDays(angleName),
            batches_created: stringifyJSON(batchInfos),
            rounds_json: stringifyJSON(roundDetails),
            total_rounds: roundDetails.length,
            total_ads_generated: totalAdsGenerated,
            total_ads_scored: totalAdsScored,
            total_ads_passed: totalAdsPassed,
            ready_to_post_count: 0,
            duration_ms: Date.now() - runProgress.startTime,
            decisions: buildTestRunSummary({
              angleName,
              roundsUsed: roundDetails.length,
              totalAdsGenerated,
              totalAdsPassed,
              terminalStatus,
              failureReason,
            }),
          });

          runProgress.status = 'error';
          runProgress.progress = 0;
          runProgress.phase = failureReason;
          runProgress.result = { failure_reason: failureReason };
          setTimeout(() => activeTestRuns.delete(trackingId), 60000);

          return {
            runId,
            angle: angleName,
            rounds_used: roundDetails.length,
            total_ads_generated: totalAdsGenerated,
            ads_scored: totalAdsScored,
            ads_passed: totalAdsPassed,
            ready_to_post_count: 0,
            terminal_status: terminalStatus,
            failure_reason: failureReason,
            rounds: roundDetails,
            pipeline_failed: true,
          };
        }

        errorStage = 'persist_success';
        const successResult = await finalizeSuccessfulTestRun({
          runId,
          projectId,
          angleName,
          batchInfos,
          roundDetails,
          currentBatchId: batchInfo.batch_id,
          totalAdsGenerated,
          totalAdsScored,
          totalAdsPassed,
          finalizeResult,
          durationMs: Date.now() - runProgress.startTime,
          skipLPGen,
          triggerLabel: 'test run',
        });

        console.log(`[Director] Test run ${runId.slice(0, 8)} succeeded after ${roundDetails.length} round(s): ${totalAdsPassed} passed, flex ${successResult.flexAdId || 'none'}`);

        runProgress.status = 'complete';
        runProgress.progress = 100;
        runProgress.phase = 'Complete';
        runProgress.result = { flex_ad_id: successResult.flexAdId, ready_to_post_count: successResult.readyToPostCount };
        setTimeout(() => activeTestRuns.delete(trackingId), 60000);

        return {
          runId,
          angle: angleName,
          rounds_used: roundDetails.length,
          total_ads_generated: totalAdsGenerated,
          ads_scored: totalAdsScored,
          ads_passed: totalAdsPassed,
          ready_to_post_count: successResult.readyToPostCount,
          flex_ads_created: finalizeResult.flex_ads_created,
          flex_ad_id: successResult.flexAdId,
          terminal_status: 'deployed',
          rounds: roundDetails,
        };
      }

      if (roundNumber < TEST_RUN_MAX_ROUNDS) {
        const nextBatchSize = getTestRoundBatchSize(roundNumber + 1, totalAdsPassed);
        const roundPassDisplay = roundScoreResult.ads_passed + (repairResult.repairSummary?.passed || 0);
        emit(withTestProgress(roundNumber, {
          type: 'progress',
          step: 'round_complete',
          message: `Round ${roundNumber} complete: ${roundPassDisplay}/${roundScoreResult.ads_scored} passed, ${totalAdsPassed}/${TEST_RUN_REQUIRED_PASSES} total. Starting round ${roundNumber + 1} with ${nextBatchSize} ads...`,
        }));
      }

      const roundPassDisplay = roundScoreResult.ads_passed + (repairResult.repairSummary?.passed || 0);
      const nextDecisionMessage = roundNumber < TEST_RUN_MAX_ROUNDS
        ? `Round ${roundNumber} complete: ${roundPassDisplay}/${roundScoreResult.ads_scored} passed, ${totalAdsPassed}/${TEST_RUN_REQUIRED_PASSES} total. Starting round ${roundNumber + 1} with ${getTestRoundBatchSize(roundNumber + 1, totalAdsPassed)} ads...`
        : `Round ${roundNumber} complete: ${roundPassDisplay}/${roundScoreResult.ads_scored} passed, ${totalAdsPassed}/${TEST_RUN_REQUIRED_PASSES} total.`;

      errorStage = 'persist_round_progress';
      await updateConductorRun(runId, {
        status: 'running',
        error_stage: '',
        posting_days: getTestPostingDays(angleName),
        batches_created: stringifyJSON(batchInfos),
        rounds_json: stringifyJSON(roundDetails),
        total_rounds: roundDetails.length,
        total_ads_generated: totalAdsGenerated,
        total_ads_scored: totalAdsScored,
        total_ads_passed: totalAdsPassed,
        decisions: nextDecisionMessage,
      });
      activeRoundState = null;
    }

    const failureReason = `Reached ${totalAdsPassed}/${TEST_RUN_REQUIRED_PASSES} passed ads after ${totalAdsGenerated} generated across ${TEST_RUN_MAX_ROUNDS} rounds. Round cap reached with no Ready to Post flex ad.`;
    console.warn(`[Director] Test run ${runId.slice(0, 8)} failed at hard cap: ${totalAdsPassed}/${TEST_RUN_REQUIRED_PASSES} passed after ${totalAdsGenerated} generated`);

    await updateConductorRun(runId, {
      status: 'failed',
      terminal_status: TEST_RUN_ROUND_CAP_TERMINAL_STATUS,
      error: failureReason,
      failure_reason: failureReason,
      error_stage: '',
      posting_days: getTestPostingDays(angleName),
      batches_created: stringifyJSON(batchInfos),
      rounds_json: stringifyJSON(roundDetails),
      total_rounds: roundDetails.length,
      total_ads_generated: totalAdsGenerated,
      total_ads_scored: totalAdsScored,
      total_ads_passed: totalAdsPassed,
      ready_to_post_count: 0,
      duration_ms: Date.now() - runProgress.startTime,
      decisions: buildTestRunSummary({
        angleName,
        roundsUsed: roundDetails.length,
        totalAdsGenerated,
        totalAdsPassed,
        terminalStatus: TEST_RUN_ROUND_CAP_TERMINAL_STATUS,
      }),
    });

    runProgress.status = 'error';
    runProgress.progress = 0;
    runProgress.phase = failureReason;
    runProgress.result = { failure_reason: failureReason };
    setTimeout(() => activeTestRuns.delete(trackingId), 60000);

    return {
      runId,
      angle: angleName,
      rounds_used: roundDetails.length,
      total_ads_generated: totalAdsGenerated,
      ads_scored: totalAdsScored,
      ads_passed: totalAdsPassed,
      ready_to_post_count: 0,
      terminal_status: TEST_RUN_ROUND_CAP_TERMINAL_STATUS,
      failure_reason: failureReason,
      rounds: roundDetails,
      pipeline_failed: true,
    };
  } catch (err) {
    const failureReason = err.message || 'Test run failed';
    const cancelled = failureReason === 'Cancelled by user' || runProgress.cancelRequested;
    if (!cancelled && activeRoundState?.rawScoreResult) {
      if (!activeRoundState.countsApplied) {
        totalAdsScored += activeRoundState.rawScoreResult.ads_scored + (activeRoundState.repairSummary?.attempted || 0);
        totalAdsPassed += activeRoundState.mergedRoundScoreResult?.ads_passed || activeRoundState.rawScoreResult.ads_passed || 0;
        batchInfos[batchInfos.length - 1] = updateScoredBatchInfo(activeRoundState.batchInfo, activeRoundState.rawScoreResult, {
          repair_attempts: activeRoundState.repairSummary?.attempted || 0,
          repair_passes: activeRoundState.repairSummary?.passed || 0,
        });
        activeRoundState.countsApplied = true;
      }

      if (!activeRoundState.detailPersisted) {
        roundDetails.push(buildCompletedRoundDetail({
          batch: activeRoundState.batch,
          batchInfo: activeRoundState.batchInfo,
          angleName,
          roundNumber: activeRoundState.roundNumber,
          roundScoreResult: activeRoundState.mergedRoundScoreResult || activeRoundState.rawScoreResult,
          totalAdsPassed,
          repairSummary: activeRoundState.repairSummary,
        }));
        activeRoundState.detailPersisted = true;
      }
    }
    const terminalStatus = cancelled
      ? 'cancelled'
      : (totalAdsScored > 0 || errorStage === 'post_score_round_processing' || errorStage === 'filter_finalization' || errorStage === 'persist_round_progress' || errorStage === 'persist_success')
        ? TEST_RUN_ORCHESTRATION_FAILURE_STATUS
        : 'generation_failed';
    if (runId) {
      try {
        await updateConductorRun(runId, {
          status: 'failed',
          terminal_status: terminalStatus,
          error: failureReason,
          failure_reason: failureReason,
          error_stage: cancelled ? undefined : errorStage,
          posting_days: angleName
            ? getTestPostingDays(angleName)
            : stringifyJSON([{ date: 'test', action: cancelled ? 'Test run cancelled before angle selection' : 'Test run failed before angle selection' }]),
          batches_created: stringifyJSON(batchInfos),
          rounds_json: stringifyJSON(roundDetails),
          total_rounds: Math.max(roundDetails.length, batchInfos.length, 1),
          total_ads_generated: totalAdsGenerated,
          total_ads_scored: totalAdsScored,
          total_ads_passed: totalAdsPassed,
          ready_to_post_count: 0,
          duration_ms: Date.now() - runProgress.startTime,
          decisions: buildTestRunSummary({
            angleName: angleName || 'Unknown angle',
            roundsUsed: Math.max(roundDetails.length, batchInfos.length, 1),
            totalAdsGenerated,
            totalAdsPassed,
            terminalStatus,
            failureReason,
          }),
        });
      } catch (updateErr) {
        console.warn('[Pipeline] Failed to update run record after test-run error:', updateErr.message);
      }
    }

    runProgress.status = 'error';
    runProgress.progress = 0;
    runProgress.phase = failureReason;
    runProgress.result = { failure_reason: failureReason, terminal_status: terminalStatus };
    setTimeout(() => activeTestRuns.delete(trackingId), 60000);

    return {
      runId,
      angle: angleName || null,
      rounds_used: roundDetails.length,
      total_ads_generated: totalAdsGenerated,
      ads_scored: totalAdsScored,
      ads_passed: totalAdsPassed,
      ready_to_post_count: 0,
      terminal_status: terminalStatus,
      failure_reason: failureReason,
      rounds: roundDetails,
      pipeline_failed: true,
    };
  }
}

// ── Date helpers ─────────────────────────────────────────────────────────────

/**
 * Get an ICT date for a specific day of week and hour, relative to the current week.
 */
function getICTDate(ictNow, dayOfWeek, hour) {
  const d = new Date(ictNow);
  const currentDay = d.getUTCDay();
  let diff = dayOfWeek - currentDay;
  // Look backward up to 6 days to find the right day
  if (diff > 3) diff -= 7;
  if (diff < -3) diff += 7;
  d.setUTCDate(d.getUTCDate() + diff);
  d.setUTCHours(hour, 0, 0, 0);
  return d;
}

/**
 * Get the next occurrence of a specific weekday from a given date.
 */
function getNextWeekday(fromDate, targetDay) {
  const d = new Date(fromDate);
  const currentDay = d.getUTCDay();
  let diff = targetDay - currentDay;
  if (diff <= 0) diff += 7;
  d.setUTCDate(d.getUTCDate() + diff);
  return d;
}

/**
 * Format a Date to YYYY-MM-DD string.
 */
function formatDate(d) {
  return d.toISOString().split('T')[0];
}

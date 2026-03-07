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
  createBatchJob, getBatchJob, updateBatchJob,
  getAdsByBatchId,
  getFlexAdsByProject, getBatchesByProject,
  getProject, getAllConductorConfigs,
} from '../convexClient.js';
import { getAdaptiveBatchSize } from './conductorLearning.js';
import { runBatch, pollBatchJob } from './batchProcessor.js';
import { triggerLPGeneration } from './lpAutoGenerator.js';
import { buildStructuredAnglePrompt, hasStructuredBrief, buildAngleBriefJSON } from '../utils/angleParser.js';

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

    const allBatchesCreated = [];
    const postingDayResults = [];

    for (const pd of activePostingDays) {
      const { produced, inProgress, deficit } = await calculateDeficit(
        projectId, pd.date, config.daily_flex_target
      );

      const pdResult = {
        date: pd.date,
        deadline: pd.deadline,
        target: config.daily_flex_target,
        produced,
        in_progress: inProgress,
        deficit,
      };

      if (deficit <= 0) {
        pdResult.action = 'skip — quota met or pipeline will fill';
        postingDayResults.push(pdResult);
        continue;
      }

      // Select angles for the batches
      const angles = await selectAngles(projectId, config, deficit);

      // Create batches
      const batchesForDay = [];
      for (let i = 0; i < deficit; i++) {
        const angleInfo = angles[i % angles.length];
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
        if (playbook && playbook.version > 0) {
          anglePrompt += `\n\nCREATIVE DIRECTION FROM PREVIOUS ROUNDS:`;
          if (playbook.visual_patterns) anglePrompt += `\n- Visual approach: ${playbook.visual_patterns}`;
          if (playbook.copy_patterns) anglePrompt += `\n- Copy approach: ${playbook.copy_patterns}`;
          if (playbook.avoid_patterns) anglePrompt += `\n- AVOID: ${playbook.avoid_patterns}`;
          if (playbook.generation_hints) anglePrompt += `\n- Key hints: ${playbook.generation_hints}`;
          anglePrompt += `\n\nCurrent pass rate for this angle: ${Math.round((playbook.pass_rate || 0) * 100)}%`;
          anglePrompt += `\nFollow these patterns to maximize quality.`;
        }

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

        batchesForDay.push({
          batch_id: batchId,
          angle_name: angleInfo.name,
          ad_count: batchSize,
          posting_day: pd.date,
        });
      }

      allBatchesCreated.push(...batchesForDay);
      pdResult.action = `Created ${batchesForDay.length} batch(es)`;
      pdResult.batches = batchesForDay;
      postingDayResults.push(pdResult);
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

/**
 * Select angles for batch creation based on the project's angle_mode config.
 * Returns an array of angle objects, one per batch needed.
 */
async function selectAngles(projectId, config, count) {
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

  // Focus mode: if any active angles are focused, only use those
  const focusedAngles = activeAngles.filter(a => a.focused);
  const anglesToUse = focusedAngles.length > 0 ? focusedAngles : activeAngles;

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

const TEST_RUN_ADS_PER_ROUND = 18;
const TEST_RUN_MAX_ROUNDS = 3;
const TEST_RUN_REQUIRED_PASSES = 10;
const TEST_RUN_GEMINI_WAIT_MS = 30 * 60 * 1000;

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

function buildTestProgressValue(roundNumber, step, meta = {}) {
  const base = Math.min((roundNumber - 1) * 30, 90);
  switch (step) {
    case 'creating_batch':
      return base + 2;
    case 'batch_brief':
      return base + 5;
    case 'batch_headlines':
      return base + 8;
    case 'batch_body_copy':
      return base + 12;
    case 'batch_image_prompts':
      return base + 16;
    case 'batch_submitting':
      return base + 20;
    case 'batch_submitted':
    case 'gemini_waiting':
      return base + 22;
    case 'gemini_polling':
      return base + 22 + Math.round(Math.min((meta.elapsed || 0) / 600, 0.95) * 6);
    case 'gemini_complete':
      return base + 28;
    case 'filter_scoring':
      if (meta.scoringProgress?.total) {
        return base + 28 + Math.round((meta.scoringProgress.current / meta.scoringProgress.total) * 2);
      }
      return base + 28;
    case 'round_complete':
      return Math.min(roundNumber * 30, 90);
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
  if (playbook && playbook.version > 0) {
    anglePrompt += `\n\nCREATIVE DIRECTION FROM PREVIOUS ROUNDS:`;
    if (playbook.visual_patterns) anglePrompt += `\n- Visual approach: ${playbook.visual_patterns}`;
    if (playbook.copy_patterns) anglePrompt += `\n- Copy approach: ${playbook.copy_patterns}`;
    if (playbook.avoid_patterns) anglePrompt += `\n- AVOID: ${playbook.avoid_patterns}`;
    if (playbook.generation_hints) anglePrompt += `\n- Key hints: ${playbook.generation_hints}`;
    anglePrompt += `\n\nCurrent pass rate for this angle: ${Math.round((playbook.pass_rate || 0) * 100)}%`;
    anglePrompt += `\nFollow these patterns to maximize quality.`;
  }

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
  if (terminalStatus === 'failed_under_threshold_after_54') {
    return `Angle "${angleName}" reached ${totalAdsPassed}/${TEST_RUN_REQUIRED_PASSES} passed ads after ${roundsUsed} rounds (${totalAdsGenerated} generated). Hard cap reached with no Ready to Post flex ad.`;
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
}) {
  await updateConductorRun(runId, {
    status: 'failed',
    terminal_status: terminalStatus,
    error: failureReason,
    failure_reason: failureReason,
    posting_days: angleName ? getTestPostingDays(angleName) : stringifyJSON([{ date: 'test', action: 'Background test run failed' }]),
    batches_created: stringifyJSON(batchInfos),
    rounds_json: stringifyJSON(roundDetails),
    total_rounds: Math.max(roundDetails.length, batchInfos.length, 1),
    total_ads_generated: totalAdsGenerated,
    total_ads_scored: totalAdsScored,
    total_ads_passed: totalAdsPassed,
    ready_to_post_count: 0,
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

  const { scoreBatchForInlineFilter, finalizePassingAds } = await import('./creativeFilterService.js');
  const hydrated = await hydratePassingAdsForRounds(roundDetails, projectId);
  roundDetails = hydrated.roundDetails;
  const cumulativePassingAds = [...hydrated.cumulativePassingAds];

  const roundNumber = batchInfo.round || (roundDetails.length + 1);
  const roundScoreResult = await scoreBatchForInlineFilter(batchInfo.batch_id, projectId, null, {
    roundNumber,
    totalRounds: TEST_RUN_MAX_ROUNDS,
  });

  cumulativePassingAds.push(...roundScoreResult.passingAds);
  const totalAdsGenerated = batchInfos.reduce((sum, info) => sum + (info.ad_count || 0), 0);
  const totalAdsScored = roundDetails.reduce((sum, detail) => sum + (detail.ads_scored || 0), 0) + roundScoreResult.ads_scored;
  const totalAdsPassed = cumulativePassingAds.length;
  const angleName = batchInfo.angle_name || batch.angle_name || '';

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
  };
  roundDetails.push(roundDetail);

  batchInfos[batchInfos.length - 1] = {
    ...batchInfo,
    ads_scored: roundScoreResult.ads_scored,
    ads_passed: roundScoreResult.ads_passed,
  };

  if (totalAdsPassed >= TEST_RUN_REQUIRED_PASSES) {
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
        posting_days: getTestPostingDays(angleName),
        batches_created: stringifyJSON(batchInfos),
        rounds_json: stringifyJSON(roundDetails),
        total_rounds: roundDetails.length,
        total_ads_generated: totalAdsGenerated,
        total_ads_scored: totalAdsScored,
        total_ads_passed: totalAdsPassed,
        ready_to_post_count: 0,
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

    const readyToPostCount = finalizeResult.ready_to_post_count || 0;
    const flexAdId = finalizeResult.flex_ad_id || null;
    if (flexAdId) {
      batchInfos[batchInfos.length - 1] = {
        ...batchInfos[batchInfos.length - 1],
        flex_ad_id: flexAdId,
      };
    }

    await updateConductorRun(runId, {
      status: 'completed',
      terminal_status: 'deployed',
      error: '',
      failure_reason: '',
      posting_days: getTestPostingDays(angleName),
      batches_created: stringifyJSON(batchInfos),
      rounds_json: stringifyJSON(roundDetails),
      total_rounds: roundDetails.length,
      total_ads_generated: totalAdsGenerated,
      total_ads_scored: totalAdsScored,
      total_ads_passed: totalAdsPassed,
      ready_to_post_count: readyToPostCount,
      flex_ad_id: flexAdId || undefined,
      decisions: buildTestRunSummary({
        angleName,
        roundsUsed: roundDetails.length,
        totalAdsGenerated,
        totalAdsPassed,
        readyToPostCount,
        terminalStatus: 'deployed',
      }),
    });
    console.log(`[Director] Resumed test run ${runId.slice(0, 8)} completed in background: ${totalAdsPassed}/${TEST_RUN_REQUIRED_PASSES} passed`);
    return true;
  }

  if (roundNumber >= TEST_RUN_MAX_ROUNDS) {
    const failureReason = `Reached ${totalAdsPassed}/${TEST_RUN_REQUIRED_PASSES} passed ads after ${totalAdsGenerated} generated across ${TEST_RUN_MAX_ROUNDS} rounds. Hard cap reached with no Ready to Post flex ad.`;
    await updateConductorRun(runId, {
      status: 'failed',
      terminal_status: 'failed_under_threshold_after_54',
      error: failureReason,
      failure_reason: failureReason,
      posting_days: getTestPostingDays(angleName),
      batches_created: stringifyJSON(batchInfos),
      rounds_json: stringifyJSON(roundDetails),
      total_rounds: roundDetails.length,
      total_ads_generated: totalAdsGenerated,
      total_ads_scored: totalAdsScored,
      total_ads_passed: totalAdsPassed,
      ready_to_post_count: 0,
      decisions: buildTestRunSummary({
        angleName,
        roundsUsed: roundDetails.length,
        totalAdsGenerated,
        totalAdsPassed,
        terminalStatus: 'failed_under_threshold_after_54',
      }),
    });
    console.warn(`[Director] Background test run ${runId.slice(0, 8)} failed at hard cap`);
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
    });
    return true;
  }

  const nextBatchInfo = await createTestBatchRound({
    projectId,
    project,
    runId,
    angleInfo: { name: angleName, externalId: 'background' },
    anglePrompt: batch.angle_prompt || batch.angle || batchInfo.angle_prompt || '',
    angleBriefJSON: batch.angle_brief || batchInfo.angle_brief,
    batchSize: TEST_RUN_ADS_PER_ROUND,
    roundNumber: roundNumber + 1,
    emit: () => {},
    updateAngleUsage: false,
  });

  batchInfos.push(nextBatchInfo);

  await updateConductorRun(runId, {
    status: 'running',
    terminal_status: 'building_round',
    error: '',
    failure_reason: '',
    posting_days: getTestPostingDays(angleName),
    batches_created: stringifyJSON(batchInfos),
    rounds_json: stringifyJSON(roundDetails),
    total_rounds: roundDetails.length + 1,
    total_ads_generated: totalAdsGenerated + nextBatchInfo.ad_count,
    total_ads_scored: totalAdsScored,
    total_ads_passed: totalAdsPassed,
    decisions: `Round ${roundNumber} complete: ${roundScoreResult.ads_passed}/${roundScoreResult.ads_scored} passed, ${totalAdsPassed}/${TEST_RUN_REQUIRED_PASSES} total. Starting round ${roundNumber + 1} in background...`,
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
      });
    } catch (updateErr) {
      console.error(`[Director] Failed to mark background test run ${runId.slice(0, 8)} as failed:`, updateErr.message);
    }
  });

  console.log(`[Director] Resumed test run ${runId.slice(0, 8)} started round ${roundNumber + 1} in background`);
  return true;
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
    ads_per_round: batchSizeOverride || TEST_RUN_ADS_PER_ROUND,
    max_rounds: 1,
  });

  try {
    emit({ type: 'progress', step: 'selecting_angle', message: 'Selecting angle...' });
    const { project, angleInfo, anglePrompt, angleBriefJSON } = await loadTestRunContext(projectId, angleOverride);

    emit({ type: 'progress', step: 'building_prompt', message: `Building prompt for "${angleInfo.name}"...` });
    const batchSize = batchSizeOverride || TEST_RUN_ADS_PER_ROUND;
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
  'filter_scoring': 62, 'filter_grouping': 82, 'filter_copy_gen': 86,
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
      ads_per_round: TEST_RUN_ADS_PER_ROUND,
      max_rounds: TEST_RUN_MAX_ROUNDS,
    });

    throwIfRunCancelled();
    emit({ type: 'progress', step: 'selecting_angle', message: 'Selecting angle...' });
    const { project, angleInfo, anglePrompt, angleBriefJSON } = await loadTestRunContext(projectId, angleOverride);
    angleName = angleInfo.name;
    emit({ type: 'progress', step: 'building_prompt', message: `Building prompt for "${angleName}"...` });

    const { scoreBatchForInlineFilter, finalizePassingAds } = await import('./creativeFilterService.js');
    const cumulativePassingAds = [];

    for (let roundNumber = 1; roundNumber <= TEST_RUN_MAX_ROUNDS; roundNumber++) {
      throwIfRunCancelled();
      console.log(`[Director] Test run ${runId.slice(0, 8)} round ${roundNumber}/${TEST_RUN_MAX_ROUNDS}: creating ${TEST_RUN_ADS_PER_ROUND} ads for "${angleName}"`);
      const batchInfo = await createTestBatchRound({
        projectId,
        project,
        runId,
        angleInfo,
        anglePrompt,
        angleBriefJSON,
        batchSize: TEST_RUN_ADS_PER_ROUND,
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

      const roundScoreResult = await scoreBatchForInlineFilter(
        batchInfo.batch_id,
        projectId,
        (event) => emit(withTestProgress(roundNumber, event)),
        { roundNumber, totalRounds: TEST_RUN_MAX_ROUNDS }
      );
      throwIfRunCancelled();

      cumulativePassingAds.push(...roundScoreResult.passingAds);
      totalAdsScored += roundScoreResult.ads_scored;
      totalAdsPassed = cumulativePassingAds.length;
      console.log(`[Director] Test run ${runId.slice(0, 8)} round ${roundNumber}/${TEST_RUN_MAX_ROUNDS}: ${roundScoreResult.ads_passed}/${roundScoreResult.ads_scored} passed, ${totalAdsPassed}/${TEST_RUN_REQUIRED_PASSES} cumulative`);

      const roundDetail = {
        round: roundNumber,
        batch_id: batchInfo.batch_id,
        angle_name: angleName,
        ads_generated: batchInfo.ad_count,
        ads_scored: roundScoreResult.ads_scored,
        ads_passed: roundScoreResult.ads_passed,
        cumulative_passed: totalAdsPassed,
        status: totalAdsPassed >= TEST_RUN_REQUIRED_PASSES ? 'threshold_reached' : 'below_threshold',
        completed_at: new Date().toISOString(),
        passing_ads: buildPassingAdsMeta(roundScoreResult.passingAds),
      };
      roundDetails.push(roundDetail);

      batchInfos[batchInfos.length - 1] = {
        ...batchInfo,
        ads_scored: roundScoreResult.ads_scored,
        ads_passed: roundScoreResult.ads_passed,
      };

      if (totalAdsPassed >= TEST_RUN_REQUIRED_PASSES) {
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

        const readyToPostCount = finalizeResult.ready_to_post_count || 0;
        const flexAdId = finalizeResult.flex_ad_id || null;
        const bestRound = [...roundDetails].sort((a, b) => b.ads_passed - a.ads_passed)[0];

        if (flexAdId) {
          batchInfos[batchInfos.length - 1] = {
            ...batchInfos[batchInfos.length - 1],
            flex_ad_id: flexAdId,
          };
        }

        await updateConductorRun(runId, {
          status: 'completed',
          terminal_status: 'deployed',
          posting_days: getTestPostingDays(angleName),
          batches_created: stringifyJSON(batchInfos),
          rounds_json: stringifyJSON(roundDetails),
          total_rounds: roundDetails.length,
          total_ads_generated: totalAdsGenerated,
          total_ads_scored: totalAdsScored,
          total_ads_passed: totalAdsPassed,
          ready_to_post_count: readyToPostCount,
          flex_ad_id: flexAdId || undefined,
          duration_ms: Date.now() - runProgress.startTime,
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
          triggerLPGeneration(bestRound.batch_id, projectId, angleName).catch(err => {
            console.warn(`[Pipeline] LP trigger for test run ${runId.slice(0, 8)} failed:`, err.message);
          });
        }

        console.log(`[Director] Test run ${runId.slice(0, 8)} succeeded after ${roundDetails.length} round(s): ${totalAdsPassed} passed, flex ${flexAdId || 'none'}`);

        runProgress.status = 'complete';
        runProgress.progress = 100;
        runProgress.phase = 'Complete';
        runProgress.result = { flex_ad_id: flexAdId, ready_to_post_count: readyToPostCount };
        setTimeout(() => activeTestRuns.delete(trackingId), 60000);

        return {
          runId,
          angle: angleName,
          rounds_used: roundDetails.length,
          total_ads_generated: totalAdsGenerated,
          ads_scored: totalAdsScored,
          ads_passed: totalAdsPassed,
          ready_to_post_count: readyToPostCount,
          flex_ads_created: finalizeResult.flex_ads_created,
          flex_ad_id: flexAdId,
          terminal_status: 'deployed',
          rounds: roundDetails,
        };
      }

      if (roundNumber < TEST_RUN_MAX_ROUNDS) {
        emit(withTestProgress(roundNumber, {
          type: 'progress',
          step: 'round_complete',
          message: `Round ${roundNumber} complete: ${roundScoreResult.ads_passed}/${roundScoreResult.ads_scored} passed, ${totalAdsPassed}/${TEST_RUN_REQUIRED_PASSES} total. Starting round ${roundNumber + 1}...`,
        }));
      }

      await updateConductorRun(runId, {
        status: 'running',
        posting_days: getTestPostingDays(angleName),
        batches_created: stringifyJSON(batchInfos),
        rounds_json: stringifyJSON(roundDetails),
        total_rounds: roundDetails.length,
        total_ads_generated: totalAdsGenerated,
        total_ads_scored: totalAdsScored,
        total_ads_passed: totalAdsPassed,
        decisions: `Round ${roundNumber} complete: ${roundScoreResult.ads_passed}/${roundScoreResult.ads_scored} passed, ${totalAdsPassed}/${TEST_RUN_REQUIRED_PASSES} total.`,
      });
    }

    const failureReason = `Reached ${totalAdsPassed}/${TEST_RUN_REQUIRED_PASSES} passed ads after ${totalAdsGenerated} generated across ${TEST_RUN_MAX_ROUNDS} rounds. Hard cap reached with no Ready to Post flex ad.`;
    console.warn(`[Director] Test run ${runId.slice(0, 8)} failed at hard cap: ${totalAdsPassed}/${TEST_RUN_REQUIRED_PASSES} passed after ${totalAdsGenerated} generated`);

    await updateConductorRun(runId, {
      status: 'failed',
      terminal_status: 'failed_under_threshold_after_54',
      error: failureReason,
      failure_reason: failureReason,
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
        terminalStatus: 'failed_under_threshold_after_54',
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
      terminal_status: 'failed_under_threshold_after_54',
      failure_reason: failureReason,
      rounds: roundDetails,
      pipeline_failed: true,
    };
  } catch (err) {
    const failureReason = err.message || 'Test run failed';
    const cancelled = failureReason === 'Cancelled by user' || runProgress.cancelRequested;
    const terminalStatus = cancelled ? 'cancelled' : 'generation_failed';
    if (runId) {
      try {
        await updateConductorRun(runId, {
          status: 'failed',
          terminal_status: terminalStatus,
          error: failureReason,
          failure_reason: failureReason,
          posting_days: angleName
            ? getTestPostingDays(angleName)
            : stringifyJSON([{ date: 'test', action: cancelled ? 'Test run cancelled before angle selection' : 'Test run failed before angle selection' }]),
          batches_created: stringifyJSON(batchInfos),
          rounds_json: stringifyJSON(roundDetails),
          total_rounds: roundDetails.length,
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

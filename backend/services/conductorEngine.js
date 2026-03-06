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
  createConductorRun, updateConductorRun,
  createBatchJob,
  getFlexAdsByProject, getBatchesByProject,
  getProject, getAllConductorConfigs,
} from '../convexClient.js';
import { getAdaptiveBatchSize } from './conductorLearning.js';
import { runBatch } from './batchProcessor.js';
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

/**
 * Run a single test batch for a project — bypasses production windows and deficit checks.
 * Creates one full batch, fires it, and lets the Filter pick it up end-to-end.
 * @param {string} projectId
 */
export async function runTestBatch(projectId) {
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

  await createConductorRun({
    externalId: runId,
    project_id: projectId,
    run_type: 'test',
    run_at: startMs,
    status: 'running',
  });

  try {
    // Pick an angle using the project's rotation strategy
    const angles = await selectAngles(projectId, config, 1);
    const angleInfo = angles[0];

    const batchSize = config.ads_per_batch || 18;
    const batchId = uuidv4();

    // Build angle prompt with playbook context (same as normal runs)
    let anglePrompt = angleInfo.description;
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
    });

    if (angleInfo.externalId !== 'fallback') {
      await updateConductorAngle(angleInfo.externalId, {
        times_used: (angleInfo.times_used || 0) + 1,
        last_used_at: Date.now(),
      });
    }

    const batchInfo = [{ batch_id: batchId, angle_name: angleInfo.name, ad_count: batchSize, posting_day: 'test' }];

    await updateConductorRun(runId, {
      status: 'completed',
      posting_days: JSON.stringify([{ date: 'test', action: 'Test batch created' }]),
      batches_created: JSON.stringify(batchInfo),
      decisions: `Test run: created 1 batch (${batchSize} ads) with angle "${angleInfo.name}".`,
      duration_ms: Date.now() - startMs,
    });

    console.log(`[Director] Test run for ${projectId.slice(0, 8)}: Created 1 batch (${batchSize} ads, angle: ${angleInfo.name}) in ${Date.now() - startMs}ms`);

    // Fire-and-forget: start the batch
    runBatch(batchId).catch(err => {
      console.error(`[Director] Test batch ${batchId.slice(0, 8)} failed:`, err.message);
    });

    // Fire-and-forget: trigger LP generation for test batch
    triggerLPGeneration(batchId, projectId, angleInfo.name).catch(err => {
      console.warn(`[Director] LP trigger for test batch ${batchId.slice(0, 8)} failed:`, err.message);
    });

    return { runId, batches_created: 1, batch_id: batchId, angle: angleInfo.name, ad_count: batchSize };

  } catch (err) {
    await updateConductorRun(runId, {
      status: 'failed',
      error: err.message,
      duration_ms: Date.now() - startMs,
    });
    throw err;
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

import { getActiveBatchJobs, getScheduledBatchJobs, updateBatchJob } from '../convexClient.js';
import { pollBatchJob, runBatch } from './batchProcessor.js';

const POLL_INTERVAL_MS = 60 * 1000;
const ACTIVE_STATUSES = new Set(['generating_prompts', 'submitting', 'processing', 'saving_results']);

let intervalHandle = null;
let tickInProgress = false;
const runningBatchIds = new Set();
const pollingBatchIds = new Set();
const scheduledMinuteRuns = new Set();

const state = {
  initialized: false,
  startedAt: null,
  lastTickAt: null,
  lastPollAt: null,
  lastScheduleScanAt: null,
  lastError: null,
  pollIntervalMs: POLL_INTERVAL_MS,
  activePolls: 0,
  activeRuns: 0,
  scheduledCount: 0,
};

function localMinuteKey(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    pad(date.getHours()),
    pad(date.getMinutes()),
  ].join('-');
}

function normalizeCronValue(value, field) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return null;
  if (field === 'dow' && parsed === 7) return 0;
  return parsed;
}

function cronFieldMatches(expression, value, min, max, field) {
  if (!expression || expression === '*') return true;

  return expression.split(',').some((part) => {
    const trimmed = part.trim();
    if (!trimmed) return false;

    if (trimmed.startsWith('*/')) {
      const step = parseInt(trimmed.slice(2), 10);
      return Number.isFinite(step) && step > 0 && (value - min) % step === 0;
    }

    const [rangeExpr, stepExpr] = trimmed.split('/');
    const step = stepExpr ? parseInt(stepExpr, 10) : 1;
    if (!Number.isFinite(step) || step < 1) return false;

    if (rangeExpr.includes('-')) {
      const [rawStart, rawEnd] = rangeExpr.split('-');
      const start = normalizeCronValue(rawStart, field);
      const end = normalizeCronValue(rawEnd, field);
      if (start === null || end === null) return false;

      const inRange = start <= end
        ? value >= start && value <= end
        : value >= start || value <= end;
      return inRange && ((value - start + (max - min + 1)) % step === 0);
    }

    const target = normalizeCronValue(rangeExpr, field);
    return target !== null && value === target;
  });
}

export function cronMatchesDate(cronExpression, date = new Date()) {
  if (!cronExpression || typeof cronExpression !== 'string') return false;
  const parts = cronExpression.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const minuteOk = cronFieldMatches(minute, date.getMinutes(), 0, 59, 'minute');
  const hourOk = cronFieldMatches(hour, date.getHours(), 0, 23, 'hour');
  const monthOk = cronFieldMatches(month, date.getMonth() + 1, 1, 12, 'month');
  const domOk = cronFieldMatches(dayOfMonth, date.getDate(), 1, 31, 'dom');
  const dowOk = cronFieldMatches(dayOfWeek, date.getDay(), 0, 6, 'dow');

  const dayOk = dayOfMonth !== '*' && dayOfWeek !== '*'
    ? domOk || dowOk
    : domOk && dowOk;

  return minuteOk && hourOk && monthOk && dayOk;
}

function runBatchInBackground(batchId, source) {
  if (runningBatchIds.has(batchId)) return false;
  runningBatchIds.add(batchId);
  state.activeRuns = runningBatchIds.size;

  runBatch(batchId)
    .catch((err) => {
      console.error(`[Scheduler] ${source} batch ${batchId.slice(0, 8)} failed:`, err.message);
    })
    .finally(() => {
      runningBatchIds.delete(batchId);
      state.activeRuns = runningBatchIds.size;
    });

  return true;
}

async function pollActiveBatches() {
  const activeBatches = await getActiveBatchJobs();
  state.lastPollAt = new Date().toISOString();

  const polls = [];
  for (const batch of activeBatches) {
    if (!batch?.id || pollingBatchIds.has(batch.id)) continue;

    pollingBatchIds.add(batch.id);
    state.activePolls = pollingBatchIds.size;
    polls.push(
      pollBatchJob(batch.id)
        .catch((err) => {
          console.error(`[Scheduler] Poll failed for batch ${batch.id.slice(0, 8)}:`, err.message);
        })
        .finally(() => {
          pollingBatchIds.delete(batch.id);
          state.activePolls = pollingBatchIds.size;
        })
    );
  }

  await Promise.allSettled(polls);
}

async function runDueScheduledBatches(now = new Date()) {
  const scheduledBatches = await getScheduledBatchJobs();
  state.lastScheduleScanAt = new Date().toISOString();
  state.scheduledCount = scheduledBatches.length;

  const minuteKey = localMinuteKey(now);
  for (const batch of scheduledBatches) {
    if (!batch?.id || !batch.schedule_cron) continue;
    if (!cronMatchesDate(batch.schedule_cron, now)) continue;
    if (ACTIVE_STATUSES.has(batch.status) || runningBatchIds.has(batch.id)) continue;

    const runKey = `${batch.id}:${minuteKey}`;
    if (scheduledMinuteRuns.has(runKey)) continue;
    scheduledMinuteRuns.add(runKey);

    await updateBatchJob(batch.id, {
      status: 'pending',
      error_message: null,
      gemini_batch_job: null,
      gpt_prompts: null,
      batch_stats: null,
    });

    console.log(`[Scheduler] Starting scheduled batch ${batch.id.slice(0, 8)} (${batch.schedule_cron})`);
    runBatchInBackground(batch.id, 'scheduled');
  }

  if (scheduledMinuteRuns.size > 2000) {
    const currentKeys = new Set(scheduledBatches.map((batch) => `${batch.id}:${minuteKey}`));
    for (const key of scheduledMinuteRuns) {
      if (!currentKeys.has(key)) scheduledMinuteRuns.delete(key);
    }
  }
}

async function schedulerTick() {
  if (tickInProgress) return;
  tickInProgress = true;

  try {
    await pollActiveBatches();
    await runDueScheduledBatches();
    state.lastTickAt = new Date().toISOString();
    state.lastError = null;
  } catch (err) {
    state.lastError = err.message;
    console.error('[Scheduler] Tick failed:', err.message);
  } finally {
    tickInProgress = false;
  }
}

export function initializeScheduler() {
  if (state.initialized) return getSchedulerStatus();

  state.initialized = true;
  state.startedAt = new Date().toISOString();
  intervalHandle = setInterval(() => {
    void schedulerTick();
  }, POLL_INTERVAL_MS);

  if (typeof intervalHandle.unref === 'function') {
    intervalHandle.unref();
  }

  void schedulerTick();
  console.log(`[Scheduler] Initialized batch polling/schedule loop (${POLL_INTERVAL_MS / 1000}s)`);
  return getSchedulerStatus();
}

export function getSchedulerStatus() {
  return {
    ...state,
    activePolls: pollingBatchIds.size,
    activeRuns: runningBatchIds.size,
  };
}

export function registerCronJob(batch) {
  if (!batch?.id) return;
  console.log(`[Scheduler] Registered scheduled batch ${batch.id.slice(0, 8)} (${batch.schedule_cron || 'no cron'})`);
}

export function unregisterCronJob(batchId) {
  if (!batchId) return;
  for (const key of scheduledMinuteRuns) {
    if (key.startsWith(`${batchId}:`)) scheduledMinuteRuns.delete(key);
  }
  console.log(`[Scheduler] Unregistered scheduled batch ${batchId.slice(0, 8)}`);
}

export async function loadScheduledBatches() {
  const scheduledBatches = await getScheduledBatchJobs();
  state.scheduledCount = scheduledBatches.length;
  return scheduledBatches;
}

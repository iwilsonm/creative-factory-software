import cron from 'node-cron';
import { getActiveBatchJobs, getScheduledBatchJobs, getBatchJob, updateBatchJob, getMetaEnabledProjects, purgeDeletedDeployments, purgeDeletedFlexAds } from '../convexClient.js';
import { runBatch, pollBatchJob } from './batchProcessor.js';
import { syncOpenAICosts, refreshGeminiRates } from './costTracker.js';
import { syncMetaPerformance, refreshMetaTokenIfNeeded } from './metaAds.js';

// Store active cron jobs so we can stop/restart them
const activeCronJobs = new Map(); // batchId -> cron.ScheduledTask

// ── Scheduler status tracking ────────────────────────────────────────────────
let schedulerInitialized = false;
let lastPollAt = null;
let lastPollResult = null;
let lastCostSyncAt = null;
let lastRateRefreshAt = null;
let lastMetaSyncAt = null;
let lastMetaTokenRefreshAt = null;
let lastDirectorRunAt = null;

/**
 * Initialize the scheduler on server startup.
 * 1. Register cron jobs for all scheduled batches
 * 2. Start polling loop for active (processing) batch jobs
 */
export async function initScheduler() {
  console.log('[Scheduler] Initializing...');

  // Register scheduled batches
  await loadScheduledBatches();

  // Poll active batch jobs every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    try { await pollActiveBatches(); } catch (e) { console.error('[Scheduler] Poll error:', e.message); }
  });

  // Sync OpenAI costs every hour
  cron.schedule('0 * * * *', async () => {
    try {
      await syncOpenAICosts();
      lastCostSyncAt = new Date().toISOString();
    } catch (e) { console.error('[Scheduler] OpenAI cost sync error:', e.message); }
  });

  // Purge soft-deleted records older than 30 days (daily at 1:00 AM)
  cron.schedule('0 1 * * *', async () => {
    try {
      const depsPurged = await purgeDeletedDeployments(30);
      const flexPurged = await purgeDeletedFlexAds(30);
      if (depsPurged > 0 || flexPurged > 0) {
        console.log(`[Scheduler] Purged ${depsPurged} deployments + ${flexPurged} flex ads (>30 days deleted)`);
      }
    } catch (e) { console.error('[Scheduler] Soft delete purge error:', e.message); }
  });

  // Refresh Gemini rates daily at midnight
  cron.schedule('0 0 * * *', async () => {
    try {
      await refreshGeminiRates();
      lastRateRefreshAt = new Date().toISOString();
    } catch (e) { console.error('[Scheduler] Gemini rate refresh error:', e.message); }
  });

  // Sync Meta performance data every 30 minutes (per-project)
  cron.schedule('*/30 * * * *', async () => {
    try {
      const projects = await getMetaEnabledProjects();
      for (const project of projects) {
        try {
          await syncMetaPerformance(project.externalId);
        } catch (e) {
          console.error(`[Scheduler] Meta sync error for project ${project.externalId.slice(0, 8)}:`, e.message);
        }
      }
      lastMetaSyncAt = new Date().toISOString();
    } catch (e) { console.error('[Scheduler] Meta performance sync error:', e.message); }
  });

  // Refresh Meta tokens weekly (Monday 3am) if near expiry (per-project)
  cron.schedule('0 3 * * 1', async () => {
    try {
      const projects = await getMetaEnabledProjects();
      for (const project of projects) {
        try {
          await refreshMetaTokenIfNeeded(project.externalId);
        } catch (e) {
          console.error(`[Scheduler] Meta token refresh error for project ${project.externalId.slice(0, 8)}:`, e.message);
        }
      }
      lastMetaTokenRefreshAt = new Date().toISOString();
    } catch (e) { console.error('[Scheduler] Meta token refresh error:', e.message); }
  });

  // ── Dacia Creative Director cron jobs ──────────────────────────────────────
  // Director runs at 7 AM, 7 PM, and 1 AM ICT (UTC+7) = 0:00, 12:00, 18:00 UTC
  // Active Saturday through Thursday (off Friday ICT)

  // 7 AM ICT = 0:00 UTC — runs Sun-Fri (ICT Sun-Thu 7 AM + opening new posting days)
  cron.schedule('0 0 * * 0-5', async () => {
    try {
      const { runDirectorCycle } = await import('./conductorEngine.js');
      await runDirectorCycle('planning');
      lastDirectorRunAt = new Date().toISOString();
    } catch (e) { console.error('[Scheduler] Director 7AM run error:', e.message); }
  });

  // 7 PM ICT = 12:00 UTC — runs Sat-Thu (opens new production windows)
  cron.schedule('0 12 * * 0-5', async () => {
    try {
      const { runDirectorCycle } = await import('./conductorEngine.js');
      await runDirectorCycle('planning');
      lastDirectorRunAt = new Date().toISOString();
    } catch (e) { console.error('[Scheduler] Director 7PM run error:', e.message); }
  });

  // 1 AM ICT = 18:00 UTC (previous day) — final verification before deadline
  cron.schedule('0 18 * * 0-5', async () => {
    try {
      const { runDirectorCycle } = await import('./conductorEngine.js');
      await runDirectorCycle('verification');
      lastDirectorRunAt = new Date().toISOString();
    } catch (e) { console.error('[Scheduler] Director 1AM verification error:', e.message); }
  });

  schedulerInitialized = true;
  console.log('[Scheduler] Active. Polling every 5 minutes for batch completion. Cost sync hourly, rate refresh daily. Meta sync every 30 min. Director runs 3x/day.');
}

/**
 * Load all scheduled batch jobs from DB and register cron tasks.
 */
export async function loadScheduledBatches() {
  // Clear existing cron jobs
  for (const [, task] of activeCronJobs) {
    task.stop();
  }
  activeCronJobs.clear();

  const scheduled = await getScheduledBatchJobs();
  for (const batch of scheduled) {
    registerCronJob(batch);
  }

  if (scheduled.length > 0) {
    console.log(`[Scheduler] Loaded ${scheduled.length} scheduled batch(es).`);
  }
}

/**
 * Register a cron job for a single scheduled batch.
 */
export function registerCronJob(batch) {
  if (!batch.schedule_cron || !cron.validate(batch.schedule_cron)) {
    console.warn(`[Scheduler] Invalid cron expression for batch ${batch.id.slice(0, 8)}: "${batch.schedule_cron}"`);
    return;
  }

  // Stop existing job if any
  if (activeCronJobs.has(batch.id)) {
    activeCronJobs.get(batch.id).stop();
  }

  const task = cron.schedule(batch.schedule_cron, async () => {
    console.log(`[Scheduler] Triggering scheduled batch ${batch.id.slice(0, 8)}`);
    try {
      // Re-fetch to ensure it still exists and is still scheduled
      const current = await getBatchJob(batch.id);
      if (!current || !current.scheduled) {
        task.stop();
        activeCronJobs.delete(batch.id);
        return;
      }

      // Only run if not already running
      if (['pending', 'completed', 'failed'].includes(current.status)) {
        // Reset status to pending for re-execution
        await updateBatchJob(batch.id, { status: 'pending', error_message: null });
        await runBatch(batch.id);
      } else {
        console.log(`[Scheduler] Batch ${batch.id.slice(0, 8)} already ${current.status}, skipping.`);
      }
    } catch (err) {
      console.error(`[Scheduler] Scheduled batch ${batch.id.slice(0, 8)} failed:`, err.message);
    }
  });

  activeCronJobs.set(batch.id, task);
  console.log(`[Scheduler] Registered cron for batch ${batch.id.slice(0, 8)}: "${batch.schedule_cron}"`);
}

/**
 * Unregister a cron job for a batch.
 */
export function unregisterCronJob(batchId) {
  if (activeCronJobs.has(batchId)) {
    activeCronJobs.get(batchId).stop();
    activeCronJobs.delete(batchId);
  }
}

/**
 * Poll all active (processing/submitting) batch jobs for completion.
 */
async function pollActiveBatches() {
  const active = await getActiveBatchJobs();
  lastPollAt = new Date().toISOString();

  if (active.length === 0) {
    lastPollResult = { checked: 0 };
    return;
  }

  console.log(`[Scheduler] Polling ${active.length} active batch job(s)...`);
  let completed = 0;
  let failed = 0;

  for (const batch of active) {
    try {
      const result = await pollBatchJob(batch.id);
      if (result === 'completed') completed++;
      if (result === 'failed') {
        failed++;
        // Check if eligible for auto-retry
        const current = await getBatchJob(batch.id);
        const retryCount = current?.retry_count || 0;
        if (retryCount < 3 && current?.error_message !== 'Cancelled by user') {
          const delay = Math.pow(2, retryCount) * 60000; // 1m, 2m, 4m
          console.log(`[Scheduler] Batch ${batch.id.slice(0, 8)}: auto-retry ${retryCount + 1}/3 in ${delay / 1000}s`);
          // Immediately mark as pending so next poll doesn't pick it up again
          await updateBatchJob(batch.id, {
            status: 'pending',
            error_message: null,
            retry_count: retryCount + 1
          });
          setTimeout(async () => {
            try {
              await runBatch(batch.id);
            } catch (err) {
              console.error(`[Scheduler] Auto-retry failed for ${batch.id.slice(0, 8)}:`, err.message);
            }
          }, delay);
        } else {
          // Mark as failed so it stops appearing in active queries
          await updateBatchJob(batch.id, { status: 'failed' });
          console.log(`[Scheduler] Batch ${batch.id.slice(0, 8)}: failed permanently (${retryCount}/3 retries exhausted)`);
        }
      } else if (result !== 'processing') {
        console.log(`[Scheduler] Batch ${batch.id.slice(0, 8)}: ${result}`);
      }
    } catch (err) {
      console.error(`[Scheduler] Poll error for batch ${batch.id.slice(0, 8)}:`, err.message);
    }
  }

  lastPollResult = { checked: active.length, completed, failed };
}

// ── Status reporting ─────────────────────────────────────────────────────────

/**
 * Get current scheduler status for the health endpoint.
 * @returns {{ initialized: boolean, activeCronJobs: number, lastPollAt: string|null, lastPollResult: object|null, lastCostSyncAt: string|null, lastRateRefreshAt: string|null, lastMetaSyncAt: string|null, lastMetaTokenRefreshAt: string|null }}
 */
export function getSchedulerStatus() {
  return {
    initialized: schedulerInitialized,
    activeCronJobs: activeCronJobs.size,
    lastPollAt,
    lastPollResult,
    lastCostSyncAt,
    lastRateRefreshAt,
    lastMetaSyncAt,
    lastMetaTokenRefreshAt,
    lastDirectorRunAt,
  };
}

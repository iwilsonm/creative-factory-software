import cron from 'node-cron';
import { getActiveBatchJobs, getScheduledBatchJobs, getBatchJob, updateBatchJob } from '../convexClient.js';
import { runBatch, pollBatchJob } from './batchProcessor.js';
import { syncOpenAICosts, refreshGeminiRates } from './costTracker.js';

// Store active cron jobs so we can stop/restart them
const activeCronJobs = new Map(); // batchId -> cron.ScheduledTask

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
    try { await syncOpenAICosts(); } catch (e) { console.error('[Scheduler] OpenAI cost sync error:', e.message); }
  });

  // Refresh Gemini rates daily at midnight
  cron.schedule('0 0 * * *', async () => {
    try { await refreshGeminiRates(); } catch (e) { console.error('[Scheduler] Gemini rate refresh error:', e.message); }
  });

  console.log('[Scheduler] Active. Polling every 5 minutes for batch completion. Cost sync hourly, rate refresh daily.');
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
  if (active.length === 0) return;

  console.log(`[Scheduler] Polling ${active.length} active batch job(s)...`);

  for (const batch of active) {
    try {
      const result = await pollBatchJob(batch.id);
      if (result === 'failed') {
        // Check if eligible for auto-retry
        const current = await getBatchJob(batch.id);
        const retryCount = current?.retry_count || 0;
        if (retryCount < 3 && current?.error_message !== 'Cancelled by user') {
          const delay = Math.pow(2, retryCount) * 60000; // 1m, 2m, 4m
          console.log(`[Scheduler] Batch ${batch.id.slice(0, 8)}: auto-retry ${retryCount + 1}/3 in ${delay / 1000}s`);
          setTimeout(async () => {
            await updateBatchJob(batch.id, {
              status: 'pending',
              error_message: null,
              retry_count: retryCount + 1
            });
            try {
              await runBatch(batch.id);
            } catch (err) {
              console.error(`[Scheduler] Auto-retry failed for ${batch.id.slice(0, 8)}:`, err.message);
            }
          }, delay);
        } else {
          console.log(`[Scheduler] Batch ${batch.id.slice(0, 8)}: failed permanently (${retryCount}/3 retries exhausted)`);
        }
      } else if (result !== 'processing') {
        console.log(`[Scheduler] Batch ${batch.id.slice(0, 8)}: ${result}`);
      }
    } catch (err) {
      console.error(`[Scheduler] Poll error for batch ${batch.id.slice(0, 8)}:`, err.message);
    }
  }
}

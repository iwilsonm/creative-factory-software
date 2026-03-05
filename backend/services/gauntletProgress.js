/**
 * In-memory progress store for active gauntlet (LP batch generation) runs.
 * Keyed by gauntletBatchId. Ephemeral — cleared on server restart or generation completion.
 */

const activeProgress = new Map();

/**
 * Update progress for an active gauntlet run.
 */
export function setProgress(batchId, projectId, { step, message, percent }) {
  activeProgress.set(batchId, {
    projectId,
    step,
    message,
    percent,
    startedAt: activeProgress.get(batchId)?.startedAt || Date.now(),
    updatedAt: Date.now(),
  });
}

/**
 * Get the active progress for a project (returns null if no active run).
 * Only one gauntlet runs per project at a time.
 */
export function getProjectProgress(projectId) {
  for (const [batchId, data] of activeProgress) {
    if (data.projectId === projectId) return { batchId, ...data };
  }
  return null;
}

/**
 * Clear progress when generation completes (success or error).
 */
export function clearProgress(batchId) {
  activeProgress.delete(batchId);
}

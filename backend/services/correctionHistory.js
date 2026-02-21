/**
 * Correction history service — manages the changelog of document corrections.
 *
 * History is stored as a JSON array in the Convex settings table under
 * key `correction_history_{projectId}`. Each entry captures before/after
 * snapshots so corrections can be reverted.
 */

import { getSetting, setSetting } from '../convexClient.js';
import { convexClient, api } from '../convexClient.js';

const DOC_LABELS = {
  research: 'Research Document',
  avatar: 'Avatar Sheet',
  offer_brief: 'Offer Brief',
  necessary_beliefs: 'Necessary Beliefs',
};

// ── Internal helpers ────────────────────────────────────────────────────────

async function loadHistory(projectId) {
  const raw = await getSetting(`correction_history_${projectId}`);
  return raw ? JSON.parse(raw) : [];
}

async function saveHistory(projectId, history) {
  // Cap at 50 entries
  if (history.length > 50) history.length = 50;

  // Convex has a 1MB document limit — trim older entries if needed
  let payload = JSON.stringify(history);
  if (payload.length > 900000) {
    console.log(`[Changelog] History payload too large (${(payload.length / 1024).toFixed(0)}KB), trimming older entries...`);
    // Keep full data only for the last 5 entries
    for (let i = 5; i < history.length; i++) {
      if (history[i].changes) {
        for (const c of history[i].changes) {
          delete c.before_content;
          delete c.after_content;
        }
      }
    }
    payload = JSON.stringify(history);
  }

  await setSetting(`correction_history_${projectId}`, payload);
  console.log(`[Changelog] Saved ${history.length} entries (${(payload.length / 1024).toFixed(0)}KB)`);
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Get the correction history for a project.
 * @param {string} projectId
 * @returns {Promise<Array<{ id: number, correction: string, timestamp: string, manual?: boolean, changes: Array<{ doc_type: string, doc_id: string, doc_label: string, old_text: string, new_text: string, before_content?: string, after_content?: string }> }>>}
 */
export async function getHistory(projectId) {
  return loadHistory(projectId);
}

/**
 * Log a manual edit to the correction history.
 * Fire-and-forget from the route — errors are caught internally.
 * @param {string} projectId
 * @param {string} docId - The foundational doc's externalId
 * @param {string} beforeContent - Full content before the edit
 * @param {string} afterContent - Full content after the edit
 * @param {string} docType - One of 'research', 'avatar', 'offer_brief', 'necessary_beliefs'
 * @returns {Promise<void>}
 */
export async function logManualEdit(projectId, docId, beforeContent, afterContent, docType) {
  console.log(`[Changelog] Manual edit detected for ${docType} (project: ${projectId})`);

  const history = await loadHistory(projectId);

  const oldSnippet = beforeContent.length > 200 ? beforeContent.slice(0, 200) + '...' : beforeContent;
  const newSnippet = afterContent.length > 200 ? afterContent.slice(0, 200) + '...' : afterContent;

  history.unshift({
    id: Date.now(),
    correction: `Manual edit to ${DOC_LABELS[docType] || docType}`,
    timestamp: new Date().toISOString(),
    manual: true,
    changes: [{
      doc_type: docType,
      doc_id: docId,
      doc_label: DOC_LABELS[docType] || docType,
      old_text: oldSnippet,
      new_text: newSnippet,
      before_content: beforeContent,
      after_content: afterContent,
    }],
  });

  await saveHistory(projectId, history);
}

/**
 * Apply proposed AI corrections: update each doc, capture before/after snapshots,
 * and log everything to the correction history.
 * @param {string} projectId
 * @param {Array<{ doc_id: string, doc_type: string, doc_label: string, old_text: string, new_text: string, full_updated_content: string }>} corrections
 * @param {string} correctionText - The user's original correction instruction
 * @returns {Promise<{ updated_count: number, updated_doc_ids: string[] }>}
 */
export async function applyCorrections(projectId, corrections, correctionText) {
  console.log(`[Changelog] Apply corrections: ${corrections.length} items for project ${projectId}`);

  const changes = [];
  const updated = [];

  for (const c of corrections) {
    if (!c.doc_id || !c.full_updated_content) {
      console.log(`[Changelog] Skipping correction: doc_id=${JSON.stringify(c.doc_id)}, full_updated_content=${!!c.full_updated_content}, doc_type=${c.doc_type}, keys=${Object.keys(c).join(',')}`);
      continue;
    }
    try {
      const currentDoc = await convexClient.query(api.foundationalDocs.getByExternalId, { externalId: c.doc_id });
      const beforeContent = currentDoc?.content || '';

      await convexClient.mutation(api.foundationalDocs.update, {
        externalId: c.doc_id,
        content: c.full_updated_content,
      });
      updated.push(c.doc_id);

      changes.push({
        doc_type: c.doc_type,
        doc_id: c.doc_id,
        doc_label: c.doc_label,
        old_text: c.old_text,
        new_text: c.new_text,
        before_content: beforeContent,
        after_content: c.full_updated_content,
      });
    } catch (err) {
      console.error(`[CopyCorrection] Failed to update doc ${c.doc_id}:`, err.message);
    }
  }

  // Save to correction history
  if (changes.length > 0) {
    console.log(`[Changelog] AI fix applied: ${changes.length} doc(s) changed for project ${projectId}`);
    try {
      const history = await loadHistory(projectId);
      history.unshift({
        id: Date.now(),
        correction: correctionText || 'Unknown correction',
        timestamp: new Date().toISOString(),
        changes,
      });
      await saveHistory(projectId, history);
    } catch (err) {
      console.error('[Changelog] Failed to save AI fix history:', err.message);
    }
  }

  return { updated_count: updated.length, updated_doc_ids: updated };
}

/**
 * Revert a correction — restore each doc to its before_content and remove
 * the entry from history.
 * @param {string} projectId
 * @param {number} correctionId - The correction's `id` (timestamp-based)
 * @returns {Promise<{ reverted_count: number }>}
 */
export async function revertCorrection(projectId, correctionId) {
  const history = await loadHistory(projectId);

  const entry = history.find(h => h.id === correctionId);
  if (!entry) {
    const err = new Error('Correction not found in history');
    err.status = 404;
    throw err;
  }

  const reverted = [];
  for (const change of entry.changes) {
    if (!change.doc_id || !change.before_content) continue;
    try {
      await convexClient.mutation(api.foundationalDocs.update, {
        externalId: change.doc_id,
        content: change.before_content,
      });
      reverted.push(change.doc_id);
    } catch (err) {
      console.error(`[CopyCorrection] Failed to revert doc ${change.doc_id}:`, err.message);
    }
  }

  // Remove this entry from history
  const updatedHistory = history.filter(h => h.id !== correctionId);
  await setSetting(`correction_history_${projectId}`, JSON.stringify(updatedHistory));

  return { reverted_count: reverted.length };
}

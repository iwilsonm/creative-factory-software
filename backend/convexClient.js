/**
 * convexClient.js — Drop-in async replacement for db.js
 *
 * All functions have the same names and parameters as db.js,
 * but they are ASYNC and call Convex instead of SQLite.
 *
 * Usage: change `import { X } from './db.js'` to `import { X } from './convexClient.js'`
 * and add `await` to every call site.
 */

import { ConvexHttpClient } from 'convex/browser';
import { api } from '../convex/_generated/api.js';
import fetch from 'node-fetch';
import { withRetry } from './services/retry.js';

// Read Convex URL from environment
const CONVEX_URL = process.env.CONVEX_URL;
if (!CONVEX_URL) {
  throw new Error('CONVEX_URL environment variable not set. Add it to .env.local or PM2 config.');
}

const client = new ConvexHttpClient(CONVEX_URL);

// Retry-wrapped Convex calls — handles transient ECONNRESET from VPS → Convex cloud
async function queryWithRetry(fnRef, args) {
  return withRetry(() => client.query(fnRef, args), { maxRetries: 3, label: 'Convex query' });
}

async function mutationWithRetry(fnRef, args) {
  return withRetry(() => client.mutation(fnRef, args), { maxRetries: 3, label: 'Convex mutation' });
}

// =============================================
// Settings helpers
// =============================================

export async function getSetting(key) {
  return await queryWithRetry(api.settings.get, { key });
}

export async function setSetting(key, value) {
  await mutationWithRetry(api.settings.set, { key, value });
}

export async function getAllSettings() {
  return await queryWithRetry(api.settings.getAll, {});
}

// =============================================
// Project helpers
// =============================================

export async function createProject({ id, name, brand_name, niche, product_description, sales_page_content, drive_folder_id, inspiration_folder_id }) {
  await mutationWithRetry(api.projects.create, {
    externalId: id,
    name,
    brand_name: brand_name || '',
    niche: niche || '',
    product_description: product_description || '',
    sales_page_content: sales_page_content || '',
    drive_folder_id: drive_folder_id || '',
    inspiration_folder_id: inspiration_folder_id || '',
  });
}

export async function getProject(id) {
  const project = await queryWithRetry(api.projects.getByExternalId, { externalId: id });
  if (!project) return null;
  return convexProjectToRow(project);
}

export async function getAllProjects() {
  const projects = await queryWithRetry(api.projects.getAll, {});
  return projects.map(convexProjectToRow);
}

export async function getAllProjectsWithStats() {
  const projects = await queryWithRetry(api.projects.getAllWithStats, {});
  return projects.map(p => ({
    ...convexProjectToRow(p),
    docCount: p.docCount,
    adCount: p.adCount,
  }));
}

export async function updateProject(id, fields) {
  const allowed = ['name', 'brand_name', 'niche', 'product_description', 'sales_page_content', 'drive_folder_id', 'inspiration_folder_id', 'prompt_guidelines', 'status'];
  const updates = { externalId: id };
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      updates[key] = fields[key];
    }
  }
  await mutationWithRetry(api.projects.update, updates);
}

export async function deleteProject(id) {
  await mutationWithRetry(api.projects.remove, { externalId: id });
}

function convexProjectToRow(p) {
  return {
    id: p.externalId,
    name: p.name,
    brand_name: p.brand_name || null,
    niche: p.niche || null,
    product_description: p.product_description || null,
    sales_page_content: p.sales_page_content || null,
    drive_folder_id: p.drive_folder_id || null,
    inspiration_folder_id: p.inspiration_folder_id || null,
    prompt_guidelines: p.prompt_guidelines || null,
    status: p.status || 'setup',
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}

// =============================================
// Foundational doc helpers
// =============================================

export async function getDocsByProject(projectId) {
  const docs = await queryWithRetry(api.foundationalDocs.getByProject, { projectId });
  return docs.map(convexDocToRow);
}

export async function getLatestDoc(projectId, docType) {
  const doc = await queryWithRetry(api.foundationalDocs.getLatest, { projectId, docType });
  if (!doc) return null;
  return convexDocToRow(doc);
}

function convexDocToRow(d) {
  return {
    id: d.externalId,
    project_id: d.project_id,
    doc_type: d.doc_type,
    content: d.content || null,
    version: d.version,
    approved: d.approved ? 1 : 0,
    source: d.source || 'generated',
    created_at: d.created_at,
    updated_at: d.updated_at,
  };
}

// =============================================
// Ad creative helpers
// =============================================

export async function getAdsByProject(projectId) {
  const ads = await queryWithRetry(api.adCreatives.getByProjectWithUrls, { projectId });
  return ads.map(a => ({
    ...convexAdToRow(a),
    resolvedImageUrl: a.resolvedImageUrl || null,
  }));
}

export async function getAd(id) {
  const ad = await queryWithRetry(api.adCreatives.getByExternalId, { externalId: id });
  if (!ad) return null;
  return convexAdToRow(ad);
}

export async function getAdImageUrl(id) {
  return await queryWithRetry(api.adCreatives.getImageUrl, { externalId: id });
}

function convexAdToRow(a) {
  return {
    id: a.externalId,
    project_id: a.project_id,
    generation_mode: a.generation_mode,
    angle: a.angle || null,
    headline: a.headline || null,
    body_copy: a.body_copy || null,
    image_prompt: a.image_prompt || null,
    gpt_creative_output: a.gpt_creative_output || null,
    template_image_id: a.template_image_id || null,
    inspiration_image_id: a.inspiration_image_id || null,
    storageId: a.storageId || null,
    image_path: null, // no longer used — use storageId
    drive_file_id: a.drive_file_id || null,
    drive_url: a.drive_url || null,
    aspect_ratio: a.aspect_ratio || '1:1',
    status: a.status || 'generating_copy',
    auto_generated: a.auto_generated ? 1 : 0,
    parent_ad_id: a.parent_ad_id || null,
    created_at: a.created_at,
  };
}

// =============================================
// Stats helpers
// =============================================

export async function getProjectStats(projectId) {
  return await queryWithRetry(api.projects.getStats, { projectId });
}

// =============================================
// Batch job helpers
// =============================================

export async function createBatchJob({ id, project_id, generation_mode, batch_size, angle, aspect_ratio, template_image_id, inspiration_image_id, product_image_storageId, scheduled, schedule_cron }) {
  await mutationWithRetry(api.batchJobs.create, {
    externalId: id,
    project_id,
    generation_mode,
    batch_size: batch_size || 1,
    angle: angle || undefined,
    aspect_ratio: aspect_ratio || '1:1',
    template_image_id: template_image_id || undefined,
    inspiration_image_id: inspiration_image_id || undefined,
    product_image_storageId: product_image_storageId || undefined,
    scheduled: !!scheduled,
    schedule_cron: schedule_cron || undefined,
  });
}

export async function getBatchJob(id) {
  const batch = await queryWithRetry(api.batchJobs.getByExternalId, { externalId: id });
  if (!batch) return null;
  return convexBatchToRow(batch);
}

export async function getBatchesByProject(projectId) {
  const batches = await queryWithRetry(api.batchJobs.getByProject, { projectId });
  return batches.map(convexBatchToRow);
}

export async function getActiveBatchJobs() {
  const batches = await queryWithRetry(api.batchJobs.getActive, {});
  return batches.map(convexBatchToRow);
}

export async function getScheduledBatchJobs() {
  const batches = await queryWithRetry(api.batchJobs.getScheduled, {});
  return batches.map(convexBatchToRow);
}

export async function getAllScheduledBatchesForCost() {
  return await queryWithRetry(api.batchJobs.getAllScheduledForCost, {});
}

export async function updateBatchJob(id, fields) {
  const allowed = ['status', 'gemini_batch_job', 'gpt_prompts', 'error_message', 'completed_at', 'completed_count', 'scheduled', 'schedule_cron', 'retry_count', 'batch_stats', 'angle', 'batch_size', 'aspect_ratio'];
  const updates = { externalId: id };
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      updates[key] = fields[key];
    }
  }
  // Convert scheduled boolean 0/1 to actual boolean for Convex
  if (updates.scheduled !== undefined) {
    updates.scheduled = !!updates.scheduled;
  }
  await mutationWithRetry(api.batchJobs.update, updates);
}

export async function deleteBatchJob(id) {
  await mutationWithRetry(api.batchJobs.remove, { externalId: id });
}

function convexBatchToRow(b) {
  return {
    id: b.externalId,
    project_id: b.project_id,
    generation_mode: b.generation_mode,
    batch_size: b.batch_size,
    angle: b.angle || null,
    aspect_ratio: b.aspect_ratio || '1:1',
    template_image_id: b.template_image_id || null,
    inspiration_image_id: b.inspiration_image_id || null,
    product_image_storageId: b.product_image_storageId || null,
    product_image_path: null, // no longer used
    gemini_batch_job: b.gemini_batch_job || null,
    gpt_prompts: b.gpt_prompts || null,
    status: b.status || 'pending',
    scheduled: b.scheduled ? 1 : 0,
    schedule_cron: b.schedule_cron || null,
    error_message: b.error_message || null,
    completed_count: b.completed_count || 0,
    retry_count: b.retry_count || 0,
    batch_stats: b.batch_stats || null,
    created_at: b.created_at,
    completed_at: b.completed_at || null,
  };
}

// =============================================
// API Cost helpers
// =============================================

export async function logCost({ id, project_id, service, operation, cost_usd, rate_used, image_count, resolution, source, period_date }) {
  await mutationWithRetry(api.apiCosts.log, {
    externalId: id,
    project_id: project_id || undefined,
    service,
    operation: operation || undefined,
    cost_usd: cost_usd || 0,
    rate_used: rate_used || undefined,
    image_count: image_count || undefined,
    resolution: resolution || undefined,
    source: source || 'calculated',
    period_date: period_date || new Date().toISOString().split('T')[0],
  });
}

export async function getCostAggregates(startDate, endDate, projectId = null) {
  return await queryWithRetry(api.apiCosts.getAggregates, {
    startDate,
    endDate,
    projectId: projectId || undefined,
  });
}

export async function getDailyCostHistory(days = 30, projectId = null) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  const startStr = startDate.toISOString().split('T')[0];

  return await queryWithRetry(api.apiCosts.getDailyHistory, {
    startDate: startStr,
    projectId: projectId || undefined,
  });
}

export async function deleteCostsBySource(source, startDate) {
  return await mutationWithRetry(api.apiCosts.deleteBySourceAndDate, { source, startDate });
}

// =============================================
// Inspiration image helpers (new)
// =============================================

export async function getInspirationImages(projectId) {
  return await queryWithRetry(api.inspirationImages.getByProject, { projectId });
}

export async function getInspirationImage(projectId, driveFileId) {
  return await queryWithRetry(api.inspirationImages.getByDriveFileId, { projectId, driveFileId });
}

export async function getInspirationImageUrl(projectId, driveFileId) {
  return await queryWithRetry(api.inspirationImages.getImageUrl, { projectId, driveFileId });
}

// =============================================
// File storage helpers
// =============================================

export async function generateUploadUrl() {
  return await mutationWithRetry(api.fileStorage.generateUploadUrl, {});
}

export async function getStorageUrl(storageId) {
  return await queryWithRetry(api.fileStorage.getUrl, { storageId });
}

export async function deleteStorageFile(storageId) {
  await mutationWithRetry(api.fileStorage.deleteFile, { storageId });
}

/**
 * Upload a Buffer to Convex file storage.
 * Returns the storageId that can be stored in any record.
 */
export async function uploadBuffer(buffer, contentType = 'image/png') {
  return withRetry(async () => {
    // Fresh upload URL on each attempt (previous one may be stale after ECONNRESET)
    const uploadUrl = await generateUploadUrl();

    const response = await fetch(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: buffer,
    });

    if (!response.ok) {
      throw new Error(`Convex upload failed: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();
    return result.storageId;
  }, { maxRetries: 3, label: 'Convex upload' });
}

/**
 * Download a file from Convex storage and return it as a Buffer.
 * Useful for passing to external APIs (Drive, Gemini).
 */
export async function downloadToBuffer(storageId) {
  const url = await getStorageUrl(storageId);
  if (!url) throw new Error('No storage URL for storageId');

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download from Convex storage: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

// =============================================
// Template image helpers
// =============================================

export async function getTemplateImageUrl(externalId) {
  return await queryWithRetry(api.templateImages.getImageUrl, { externalId });
}

// =============================================
// Direct Convex client access (for advanced use cases)
// =============================================

export { client as convexClient, api };

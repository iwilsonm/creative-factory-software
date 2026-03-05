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

// Custom retry predicate for Convex calls.
// Convex errors are plain Error objects with no status/code properties, so the
// default retry predicate (which checks status codes) would never retry them.
// We retry on: Server Error (transient Convex platform issues), fetch failed,
// ECONNRESET, and other network errors.
function convexShouldRetry(err) {
  const msg = err.message || '';
  // Convex "Server Error" — can be transient platform issues (502/503 from Cloudflare)
  if (/Server Error/i.test(msg)) return true;
  // Network / connection errors
  if (/fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED|socket|network/i.test(msg)) return true;
  // Convex overloaded
  if (/overloaded|too many requests|rate.?limit/i.test(msg)) return true;
  return false;
}

// Retry-wrapped Convex calls — handles transient ECONNRESET + Server Error from VPS → Convex cloud
export async function queryWithRetry(fnRef, args) {
  return withRetry(() => client.query(fnRef, args), { maxRetries: 3, baseDelayMs: 2000, shouldRetry: convexShouldRetry, label: 'Convex query' });
}

export async function mutationWithRetry(fnRef, args) {
  return withRetry(() => client.mutation(fnRef, args), { maxRetries: 3, baseDelayMs: 2000, shouldRetry: convexShouldRetry, label: 'Convex mutation' });
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
  // Fetch projects first (lightweight), then stats per-project in parallel.
  // The old monolithic Convex getAllWithStats query loaded ALL ads + LPs + docs
  // in a single execution (~15+ MB), exceeding Convex query bandwidth limits.
  const projects = await getAllProjects();
  const statsResults = await Promise.allSettled(
    projects.map(p => queryWithRetry(api.projects.getStats, { projectId: p.id }))
  );
  return projects.map((p, i) => {
    const stats = statsResults[i].status === 'fulfilled' ? statsResults[i].value : {};
    return {
      ...p,
      docCount: stats.docCount ?? 0,
      adCount: stats.adCount ?? 0,
      lpCount: stats.lpCount ?? 0,
      lpPublishedCount: stats.lpPublishedCount ?? 0,
    };
  });
}

export async function updateProject(id, fields) {
  const allowed = ['name', 'brand_name', 'niche', 'product_description', 'sales_page_content', 'drive_folder_id', 'inspiration_folder_id', 'prompt_guidelines', 'status', 'meta_app_id', 'meta_app_secret', 'meta_access_token', 'meta_token_expires_at', 'meta_ad_account_id', 'meta_user_name', 'meta_user_id', 'meta_last_sync_at', 'scout_enabled', 'scout_default_campaign', 'scout_cta', 'scout_display_link', 'scout_facebook_page', 'scout_score_threshold', 'scout_daily_flex_ads', 'scout_destination_url', 'scout_duplicate_adset_name'];
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
    product_image_storageId: p.product_image_storageId || null,
    status: p.status || 'setup',
    meta_app_id: p.meta_app_id || null,
    meta_app_secret: p.meta_app_secret || null,
    meta_access_token: p.meta_access_token || null,
    meta_token_expires_at: p.meta_token_expires_at || null,
    meta_ad_account_id: p.meta_ad_account_id || null,
    meta_user_name: p.meta_user_name || null,
    meta_user_id: p.meta_user_id || null,
    meta_last_sync_at: p.meta_last_sync_at || null,
    // Dacia Creative Filter per-project config
    scout_enabled: p.scout_enabled ?? null,
    scout_default_campaign: p.scout_default_campaign || null,
    scout_cta: p.scout_cta || null,
    scout_display_link: p.scout_display_link || null,
    scout_facebook_page: p.scout_facebook_page || null,
    scout_score_threshold: p.scout_score_threshold ?? null,
    scout_daily_flex_ads: p.scout_daily_flex_ads ?? null,
    scout_destination_url: p.scout_destination_url || null,
    scout_duplicate_adset_name: p.scout_duplicate_adset_name || null,
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}

export async function setProjectProductImage(projectId, storageId) {
  await mutationWithRetry(api.projects.setProductImage, {
    externalId: projectId,
    storageId: storageId || undefined,
  });
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

export async function getAllAds() {
  const ads = await queryWithRetry(api.adCreatives.getAll, {});
  return ads.map(a => convexAdToRow(a));
}

export async function getInProgressAdsByProject(projectId) {
  const ads = await queryWithRetry(api.adCreatives.getInProgressByProject, { projectId });
  return ads.map(a => convexAdToRow(a));
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
    aspect_ratio: a.aspect_ratio || '1:1',
    status: a.status || 'generating_copy',
    auto_generated: a.auto_generated ? 1 : 0,
    parent_ad_id: a.parent_ad_id || null,
    tags: a.tags || [],
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

export async function createBatchJob({ id, project_id, generation_mode, batch_size, angle, angles, aspect_ratio, template_image_id, template_image_ids, inspiration_image_id, inspiration_image_ids, product_image_storageId, scheduled, schedule_cron, filter_assigned, posting_day, conductor_run_id, angle_name, angle_prompt }) {
  await mutationWithRetry(api.batchJobs.create, {
    externalId: id,
    project_id,
    generation_mode,
    batch_size: batch_size || 1,
    angle: angle || undefined,
    angles: angles || undefined,
    aspect_ratio: aspect_ratio || '1:1',
    template_image_id: template_image_id || undefined,
    template_image_ids: template_image_ids || undefined,
    inspiration_image_id: inspiration_image_id || undefined,
    inspiration_image_ids: inspiration_image_ids || undefined,
    product_image_storageId: product_image_storageId || undefined,
    scheduled: !!scheduled,
    schedule_cron: schedule_cron || undefined,
    filter_assigned: filter_assigned ? true : undefined,
    posting_day: posting_day || undefined,
    conductor_run_id: conductor_run_id || undefined,
    angle_name: angle_name || undefined,
    angle_prompt: angle_prompt || undefined,
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
  const allowed = ['status', 'gemini_batch_job', 'gpt_prompts', 'error_message', 'started_at', 'completed_at', 'completed_count', 'failed_count', 'run_count', 'scheduled', 'schedule_cron', 'retry_count', 'batch_stats', 'pipeline_state', 'angle', 'angles', 'batch_size', 'aspect_ratio', 'used_template_ids', 'filter_assigned', 'filter_processed', 'filter_processed_at', 'posting_day', 'conductor_run_id', 'angle_name', 'angle_prompt', 'lp_primary_id', 'lp_primary_url', 'lp_primary_status', 'lp_primary_error', 'lp_primary_retry_count', 'lp_secondary_id', 'lp_secondary_url', 'lp_secondary_status', 'lp_secondary_error', 'lp_secondary_retry_count', 'lp_narrative_frames', 'gauntlet_lp_urls'];
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
    angles: b.angles || null,
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
    failed_count: b.failed_count || 0,
    run_count: b.run_count || 0,
    retry_count: b.retry_count || 0,
    used_template_ids: b.used_template_ids || null,
    batch_stats: b.batch_stats || null,
    pipeline_state: b.pipeline_state || null,
    filter_assigned: !!b.filter_assigned,
    filter_processed: !!b.filter_processed,
    filter_processed_at: b.filter_processed_at || null,
    posting_day: b.posting_day || null,
    conductor_run_id: b.conductor_run_id || null,
    angle_name: b.angle_name || null,
    angle_prompt: b.angle_prompt || null,
    lp_primary_id: b.lp_primary_id || null,
    lp_primary_url: b.lp_primary_url || null,
    lp_primary_status: b.lp_primary_status || null,
    lp_primary_error: b.lp_primary_error || null,
    lp_primary_retry_count: b.lp_primary_retry_count || 0,
    lp_secondary_id: b.lp_secondary_id || null,
    lp_secondary_url: b.lp_secondary_url || null,
    lp_secondary_status: b.lp_secondary_status || null,
    lp_secondary_error: b.lp_secondary_error || null,
    lp_secondary_retry_count: b.lp_secondary_retry_count || 0,
    lp_narrative_frames: b.lp_narrative_frames || null,
    gauntlet_lp_urls: b.gauntlet_lp_urls || null,
    created_at: b.created_at,
    started_at: b.started_at || null,
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

export async function getAgentCosts(startDate, endDate) {
  return await queryWithRetry(api.apiCosts.getAgentCosts, { startDate, endDate });
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
  return withRetry(async () => {
    const url = await getStorageUrl(storageId);
    if (!url) throw new Error('No storage URL for storageId');

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download from Convex storage: ${response.status}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }, { maxRetries: 3, label: 'Convex storage download' });
}

// =============================================
// Template image helpers
// =============================================

export async function getTemplateImageUrl(externalId) {
  return await queryWithRetry(api.templateImages.getImageUrl, { externalId });
}

// =============================================
// Ad Deployment helpers (Ad Tracker feature)
// =============================================

export async function getAllDeployments() {
  return await queryWithRetry(api.ad_deployments.getAll, {});
}

export async function getDeploymentsByProject(projectId) {
  return await queryWithRetry(api.ad_deployments.getByProject, { projectId });
}

export async function getDeploymentsByStatus(status) {
  return await queryWithRetry(api.ad_deployments.getByStatus, { status });
}

export async function getDeploymentByAdId(adId) {
  return await queryWithRetry(api.ad_deployments.getByAdId, { adId });
}

export async function createDeployment({ id, ad_id, project_id, status, ad_name, local_campaign_id }) {
  return await mutationWithRetry(api.ad_deployments.create, {
    externalId: id,
    ad_id,
    project_id,
    status,
    ...(ad_name ? { ad_name } : {}),
    ...(local_campaign_id ? { local_campaign_id } : {}),
    created_at: new Date().toISOString(),
  });
}

export async function updateDeployment(id, fields) {
  return await mutationWithRetry(api.ad_deployments.update, { externalId: id, fields });
}

export async function updateDeploymentStatus(id, status) {
  return await mutationWithRetry(api.ad_deployments.updateStatus, { externalId: id, status });
}

export async function deleteDeployment(id) {
  return await mutationWithRetry(api.ad_deployments.remove, { externalId: id });
}

export async function restoreDeployment(id) {
  return await mutationWithRetry(api.ad_deployments.restore, { externalId: id });
}

export async function getDeletedDeployments(projectId) {
  const results = await queryWithRetry(api.ad_deployments.getDeleted, { projectId: projectId || undefined });
  return results.map(d => ({
    ...d,
    id: d.externalId,
  }));
}

export async function purgeDeletedDeployments(olderThanDays = 30) {
  return await mutationWithRetry(api.ad_deployments.purgeDeleted, { olderThanDays });
}

// =============================================
// Campaign helpers (local campaign organization)
// =============================================

export async function getCampaignsByProject(projectId) {
  const campaigns = await queryWithRetry(api.campaigns.getByProject, { projectId });
  return campaigns.map(c => ({
    id: c.externalId,
    project_id: c.project_id,
    name: c.name,
    sort_order: c.sort_order,
    created_at: c.created_at,
    updated_at: c.updated_at,
  }));
}

export async function createCampaign({ id, project_id, name, sort_order }) {
  const now = new Date().toISOString();
  return await mutationWithRetry(api.campaigns.create, {
    externalId: id,
    project_id,
    name,
    sort_order: sort_order || 0,
    created_at: now,
    updated_at: now,
  });
}

export async function updateCampaign(id, fields) {
  return await mutationWithRetry(api.campaigns.update, { externalId: id, fields });
}

export async function deleteCampaign(id) {
  return await mutationWithRetry(api.campaigns.remove, { externalId: id });
}

// =============================================
// Ad Set helpers (local ad set organization)
// =============================================

export async function getAdSet(id) {
  const adSet = await queryWithRetry(api.adSets.getByExternalId, { externalId: id });
  if (!adSet) return null;
  return {
    id: adSet.externalId,
    campaign_id: adSet.campaign_id,
    project_id: adSet.project_id,
    name: adSet.name,
    sort_order: adSet.sort_order,
    created_at: adSet.created_at,
    updated_at: adSet.updated_at,
  };
}

export async function getAdSetsByProject(projectId) {
  const adSets = await queryWithRetry(api.adSets.getByProject, { projectId });
  return adSets.map(a => ({
    id: a.externalId,
    campaign_id: a.campaign_id,
    project_id: a.project_id,
    name: a.name,
    sort_order: a.sort_order,
    created_at: a.created_at,
    updated_at: a.updated_at,
  }));
}

export async function getAdSetsByCampaign(campaignId) {
  const adSets = await queryWithRetry(api.adSets.getByCampaign, { campaignId });
  return adSets.map(a => ({
    id: a.externalId,
    campaign_id: a.campaign_id,
    project_id: a.project_id,
    name: a.name,
    sort_order: a.sort_order,
    created_at: a.created_at,
    updated_at: a.updated_at,
  }));
}

export async function createAdSet({ id, campaign_id, project_id, name, sort_order }) {
  const now = new Date().toISOString();
  return await mutationWithRetry(api.adSets.create, {
    externalId: id,
    campaign_id,
    project_id,
    name,
    sort_order: sort_order || 0,
    created_at: now,
    updated_at: now,
  });
}

export async function updateAdSet(id, fields) {
  return await mutationWithRetry(api.adSets.update, { externalId: id, fields });
}

export async function deleteAdSet(id) {
  return await mutationWithRetry(api.adSets.remove, { externalId: id });
}

// =============================================
// Flex Ad helpers
// =============================================

export async function getFlexAdsByProject(projectId) {
  const flexAds = await queryWithRetry(api.flexAds.getByProject, { projectId });
  return flexAds.map(f => ({
    id: f.externalId,
    project_id: f.project_id,
    ad_set_id: f.ad_set_id,
    name: f.name,
    child_deployment_ids: f.child_deployment_ids,
    primary_texts: f.primary_texts || null,
    headlines: f.headlines || null,
    destination_url: f.destination_url || null,
    display_link: f.display_link || null,
    cta_button: f.cta_button || null,
    facebook_page: f.facebook_page || null,
    planned_date: f.planned_date || null,
    posted_by: f.posted_by || null,
    duplicate_adset_name: f.duplicate_adset_name || null,
    notes: f.notes || null,
    posting_day: f.posting_day || null,
    angle_name: f.angle_name || null,
    lp_primary_url: f.lp_primary_url || null,
    lp_secondary_url: f.lp_secondary_url || null,
    gauntlet_lp_urls: f.gauntlet_lp_urls || null,
    destination_urls_used: f.destination_urls_used || null,
    created_at: f.created_at,
    updated_at: f.updated_at,
  }));
}

export async function getFlexAdsByAdSet(adSetId) {
  const flexAds = await queryWithRetry(api.flexAds.getByAdSet, { adSetId });
  return flexAds.map(f => ({
    id: f.externalId,
    project_id: f.project_id,
    ad_set_id: f.ad_set_id,
    name: f.name,
    child_deployment_ids: f.child_deployment_ids,
    primary_texts: f.primary_texts || null,
    headlines: f.headlines || null,
    destination_url: f.destination_url || null,
    display_link: f.display_link || null,
    cta_button: f.cta_button || null,
    facebook_page: f.facebook_page || null,
    planned_date: f.planned_date || null,
    posted_by: f.posted_by || null,
    duplicate_adset_name: f.duplicate_adset_name || null,
    lp_primary_url: f.lp_primary_url || null,
    lp_secondary_url: f.lp_secondary_url || null,
    gauntlet_lp_urls: f.gauntlet_lp_urls || null,
    destination_urls_used: f.destination_urls_used || null,
    created_at: f.created_at,
    updated_at: f.updated_at,
  }));
}

export async function getFlexAd(id) {
  const f = await queryWithRetry(api.flexAds.getByExternalId, { externalId: id });
  if (!f) return null;
  return {
    id: f.externalId,
    project_id: f.project_id,
    ad_set_id: f.ad_set_id,
    name: f.name,
    child_deployment_ids: f.child_deployment_ids,
    primary_texts: f.primary_texts || null,
    headlines: f.headlines || null,
    destination_url: f.destination_url || null,
    display_link: f.display_link || null,
    cta_button: f.cta_button || null,
    facebook_page: f.facebook_page || null,
    planned_date: f.planned_date || null,
    posted_by: f.posted_by || null,
    duplicate_adset_name: f.duplicate_adset_name || null,
    notes: f.notes || null,
    posting_day: f.posting_day || null,
    angle_name: f.angle_name || null,
    lp_primary_url: f.lp_primary_url || null,
    lp_secondary_url: f.lp_secondary_url || null,
    gauntlet_lp_urls: f.gauntlet_lp_urls || null,
    destination_urls_used: f.destination_urls_used || null,
    created_at: f.created_at,
    updated_at: f.updated_at,
  };
}

export async function createFlexAd({ id, project_id, ad_set_id, name, child_deployment_ids, primary_texts, headlines, display_link, cta_button, facebook_page, destination_url, duplicate_adset_name, posting_day, angle_name, lp_primary_url, lp_secondary_url, gauntlet_lp_urls }) {
  const now = new Date().toISOString();
  return await mutationWithRetry(api.flexAds.create, {
    externalId: id,
    project_id,
    ad_set_id,
    name,
    child_deployment_ids: JSON.stringify(child_deployment_ids),
    ...(primary_texts ? { primary_texts: JSON.stringify(primary_texts) } : {}),
    ...(headlines ? { headlines: JSON.stringify(headlines) } : {}),
    ...(display_link ? { display_link } : {}),
    ...(cta_button ? { cta_button } : {}),
    ...(facebook_page ? { facebook_page } : {}),
    ...(destination_url ? { destination_url } : {}),
    ...(duplicate_adset_name ? { duplicate_adset_name } : {}),
    ...(posting_day ? { posting_day } : {}),
    ...(angle_name ? { angle_name } : {}),
    ...(lp_primary_url ? { lp_primary_url } : {}),
    ...(lp_secondary_url ? { lp_secondary_url } : {}),
    ...(gauntlet_lp_urls ? { gauntlet_lp_urls } : {}),
    created_at: now,
    updated_at: now,
  });
}

export async function updateFlexAd(id, fields) {
  return await mutationWithRetry(api.flexAds.update, { externalId: id, fields });
}

export async function deleteFlexAd(id) {
  return await mutationWithRetry(api.flexAds.remove, { externalId: id });
}

export async function restoreFlexAd(id) {
  return await mutationWithRetry(api.flexAds.restore, { externalId: id });
}

export async function purgeDeletedFlexAds(olderThanDays = 30) {
  return await mutationWithRetry(api.flexAds.purgeDeleted, { olderThanDays });
}

// Duplicate a deployment (skips dedup guard)
export async function createDeploymentDuplicate({ id, ad_id, project_id, status, ad_name, local_campaign_id, local_adset_id, flex_ad_id, destination_url, cta_button, primary_texts, ad_headlines, planned_date }) {
  return await mutationWithRetry(api.ad_deployments.createWithoutDedup, {
    externalId: id,
    ad_id,
    project_id,
    status,
    ...(ad_name ? { ad_name } : {}),
    ...(local_campaign_id ? { local_campaign_id } : {}),
    ...(local_adset_id ? { local_adset_id } : {}),
    ...(flex_ad_id ? { flex_ad_id } : {}),
    ...(destination_url ? { destination_url } : {}),
    ...(cta_button ? { cta_button } : {}),
    ...(primary_texts ? { primary_texts } : {}),
    ...(ad_headlines ? { ad_headlines } : {}),
    ...(planned_date ? { planned_date } : {}),
    created_at: new Date().toISOString(),
  });
}

// =============================================
// Quote Mining Run helpers
// =============================================

export async function getQuoteMiningRunsByProject(projectId) {
  const runs = await queryWithRetry(api.quote_mining_runs.getByProject, { projectId });
  return runs.map(r => ({
    id: r.externalId,
    project_id: r.project_id,
    status: r.status,
    target_demographic: r.target_demographic,
    problem: r.problem,
    root_cause: r.root_cause || null,
    keywords: r.keywords,
    subreddits: r.subreddits || null,
    forums: r.forums || null,
    num_quotes: r.num_quotes || 20,
    quotes: r.quotes || null,
    quote_count: r.quote_count || 0,
    sources_used: r.sources_used || null,
    error_message: r.error_message || null,
    duration_ms: r.duration_ms || null,
    created_at: r.created_at,
    completed_at: r.completed_at || null,
  }));
}

export async function getQuoteMiningRun(externalId) {
  const r = await queryWithRetry(api.quote_mining_runs.getByExternalId, { externalId });
  if (!r) return null;
  return {
    id: r.externalId,
    project_id: r.project_id,
    status: r.status,
    target_demographic: r.target_demographic,
    problem: r.problem,
    root_cause: r.root_cause || null,
    keywords: r.keywords,
    subreddits: r.subreddits || null,
    forums: r.forums || null,
    num_quotes: r.num_quotes || 20,
    quotes: r.quotes || null,
    perplexity_raw: r.perplexity_raw || null,
    claude_raw: r.claude_raw || null,
    quote_count: r.quote_count || 0,
    sources_used: r.sources_used || null,
    error_message: r.error_message || null,
    duration_ms: r.duration_ms || null,
    headlines: r.headlines || null,
    headlines_generated_at: r.headlines_generated_at || null,
    created_at: r.created_at,
    completed_at: r.completed_at || null,
  };
}

// =============================================
// Quote Bank helpers
// =============================================

export async function getQuoteBankByProject(projectId) {
  const quotes = await queryWithRetry(api.quote_bank.getByProject, { projectId });
  return quotes.map(q => ({
    id: q.externalId,
    project_id: q.project_id,
    quote: q.quote,
    source: q.source || null,
    source_url: q.source_url || null,
    emotion: q.emotion || null,
    emotional_intensity: q.emotional_intensity || null,
    context: q.context || null,
    run_id: q.run_id,
    problem: q.problem || null,
    tags: q.tags || [],
    is_favorite: q.is_favorite || false,
    headlines: q.headlines || null,
    headlines_generated_at: q.headlines_generated_at || null,
    created_at: q.created_at,
  }));
}

export async function getQuoteBankQuote(externalId) {
  const q = await queryWithRetry(api.quote_bank.getByExternalId, { externalId });
  if (!q) return null;
  return {
    id: q.externalId,
    project_id: q.project_id,
    quote: q.quote,
    source: q.source || null,
    source_url: q.source_url || null,
    emotion: q.emotion || null,
    emotional_intensity: q.emotional_intensity || null,
    context: q.context || null,
    run_id: q.run_id,
    problem: q.problem || null,
    tags: q.tags || [],
    is_favorite: q.is_favorite || false,
    headlines: q.headlines || null,
    headlines_generated_at: q.headlines_generated_at || null,
    created_at: q.created_at,
  };
}

export async function updateQuoteBankQuote(externalId, updates) {
  await mutationWithRetry(api.quote_bank.update, { externalId, ...updates });
}

export async function deleteQuoteBankQuote(externalId) {
  await mutationWithRetry(api.quote_bank.remove, { externalId });
}

export async function getAdsWithSourceQuote(projectId) {
  const ads = await queryWithRetry(api.adCreatives.getByProjectWithSourceQuote, { projectId });
  return ads.map(ad => ({
    id: ad.externalId,
    source_quote_id: ad.source_quote_id,
    headline: ad.headline || null,
    body_copy: ad.body_copy || null,
    status: ad.status || null,
    created_at: ad.created_at,
  }));
}

export async function backfillQuoteBankProblems(updates) {
  return await mutationWithRetry(api.quote_bank.backfillProblems, {
    updates: JSON.stringify(updates),
  });
}

// =============================================
// Meta Performance helpers
// =============================================

export async function getMetaPerformanceByDeployment(deploymentId) {
  return await queryWithRetry(api.metaPerformance.getByDeployment, { deploymentId });
}

export async function getMetaPerformanceByMetaAdId(metaAdId) {
  return await queryWithRetry(api.metaPerformance.getByMetaAdId, { metaAdId });
}

export async function upsertMetaPerformance(record) {
  return await mutationWithRetry(api.metaPerformance.upsert, record);
}

export async function deleteMetaPerformanceByDeployment(deploymentId) {
  return await mutationWithRetry(api.metaPerformance.removeByDeployment, { deploymentId });
}

/**
 * Get all projects that have a Meta access token set (for scheduler sync).
 */
export async function getMetaEnabledProjects() {
  const all = await getAllProjects();
  return all.filter(p => p.meta_access_token);
}

// =============================================
// Chat Thread helpers
// =============================================

export async function getActiveChatThread(projectId) {
  return await queryWithRetry(api.chatThreads.getActiveByProject, { projectId });
}

export async function createChatThread({ id, project_id, title }) {
  await mutationWithRetry(api.chatThreads.create, {
    externalId: id,
    project_id,
    title: title || undefined,
  });
}

export async function archiveChatThread(threadId) {
  await mutationWithRetry(api.chatThreads.archive, { externalId: threadId });
}

export async function getChatMessages(threadId) {
  return await queryWithRetry(api.chatThreads.getMessagesByThread, { threadId });
}

export async function createChatMessage({ id, thread_id, project_id, role, content, is_context_message }) {
  await mutationWithRetry(api.chatThreads.createMessage, {
    externalId: id,
    thread_id,
    project_id,
    role,
    content,
    is_context_message: is_context_message || undefined,
  });
}

// =============================================
// Correction History (dedicated table)
// =============================================

export async function getCorrectionHistoryByProject(projectId) {
  const rows = await queryWithRetry(api.correction_history.getByProject, { projectId });
  return (rows || []).map(row => ({
    id: row.externalId,
    correction: row.correction,
    timestamp: row.timestamp,
    manual: row.manual || false,
    changes: row.changes ? JSON.parse(row.changes) : [],
  }));
}

export async function createCorrectionHistory({ id, project_id, correction, timestamp, manual, changes }) {
  await mutationWithRetry(api.correction_history.create, {
    externalId: id,
    project_id,
    correction,
    timestamp,
    manual: manual || undefined,
    changes: typeof changes === 'string' ? changes : JSON.stringify(changes),
  });
}

export async function deleteCorrectionHistory(externalId) {
  await mutationWithRetry(api.correction_history.remove, { externalId });
}

// =============================================
// Dashboard Todos (dedicated table)
// =============================================

export async function getDashboardTodos() {
  const rows = await queryWithRetry(api.dashboard_todos.getAll, {});
  return (rows || [])
    .sort((a, b) => a.sort_order - b.sort_order)
    .map(row => ({
      id: row.externalId,
      text: row.text,
      done: row.done,
      author: row.author || undefined,
      notes: row.notes || undefined,
      priority: typeof row.priority === 'number' ? row.priority : undefined,
    }));
}

export async function replaceDashboardTodos(todos) {
  await mutationWithRetry(api.dashboard_todos.replaceAll, {
    todos: JSON.stringify(todos),
  });
}

// =============================================
// Landing Page helpers
// =============================================

export async function getLandingPagesByProject(projectId) {
  return await queryWithRetry(api.landingPages.getByProject, { projectId });
}

export async function getLandingPage(externalId) {
  return await queryWithRetry(api.landingPages.getByExternalId, { externalId });
}

export async function createLandingPage({ id, project_id, name, angle, word_count, additional_direction, swipe_text, swipe_filename, swipe_url, swipe_screenshot_storageId, status, auto_generated, batch_job_id, narrative_frame, template_id, gauntlet_batch_id, gauntlet_frame, gauntlet_attempt, gauntlet_status }) {
  await mutationWithRetry(api.landingPages.create, {
    externalId: id,
    project_id,
    name,
    angle: angle || undefined,
    word_count: word_count || undefined,
    additional_direction: additional_direction || undefined,
    swipe_text: swipe_text || undefined,
    swipe_filename: swipe_filename || undefined,
    swipe_url: swipe_url || undefined,
    swipe_screenshot_storageId: swipe_screenshot_storageId || undefined,
    status: status || 'draft',
    auto_generated: auto_generated || undefined,
    batch_job_id: batch_job_id || undefined,
    narrative_frame: narrative_frame || undefined,
    template_id: template_id || undefined,
    gauntlet_batch_id: gauntlet_batch_id || undefined,
    gauntlet_frame: gauntlet_frame || undefined,
    gauntlet_attempt: gauntlet_attempt || undefined,
    gauntlet_status: gauntlet_status || undefined,
  });
}

export async function updateLandingPage(externalId, fields) {
  await mutationWithRetry(api.landingPages.update, { externalId, ...fields });
}

export async function deleteLandingPage(externalId) {
  // Delete all versions first
  const versions = await queryWithRetry(api.landingPageVersions.getByLandingPage, { landingPageId: externalId });
  for (const v of versions) {
    await mutationWithRetry(api.landingPageVersions.remove, { externalId: v.externalId });
  }
  await mutationWithRetry(api.landingPages.remove, { externalId });
}

export async function getLandingPageVersions(landingPageId) {
  return await queryWithRetry(api.landingPageVersions.getByLandingPage, { landingPageId });
}

export async function createLandingPageVersion({ id, landing_page_id, version, copy_sections, source, image_slots, cta_links, html_template, assembled_html }) {
  await mutationWithRetry(api.landingPageVersions.create, {
    externalId: id,
    landing_page_id,
    version,
    copy_sections,
    source,
    image_slots: image_slots || undefined,
    cta_links: cta_links || undefined,
    html_template: html_template || undefined,
    assembled_html: assembled_html || undefined,
  });
}

export async function getLandingPageVersion(externalId) {
  return await queryWithRetry(api.landingPageVersions.getByExternalId, { externalId });
}

// =============================================
// LP Template helpers
// =============================================

function convexLPTemplateToRow(t) {
  return {
    id: t.externalId,
    project_id: t.project_id || null,
    source_url: t.source_url || null,
    name: t.name || null,
    skeleton_html: t.skeleton_html || null,
    design_brief: t.design_brief || null,
    slot_definitions: t.slot_definitions || null,
    screenshot_storage_id: t.screenshot_storage_id || null,
    status: t.status || null,
    error_message: t.error_message || null,
    created_at: t.created_at || null,
  };
}

export async function getLPTemplatesByProject(projectId) {
  const templates = await queryWithRetry(api.lpTemplates.getByProject, { projectId });
  return templates.map(convexLPTemplateToRow);
}

export async function getLPTemplate(externalId) {
  const t = await queryWithRetry(api.lpTemplates.getByExternalId, { externalId });
  if (!t) return null;
  return convexLPTemplateToRow(t);
}

export async function createLPTemplate({ id, project_id, source_url, name, skeleton_html, design_brief, slot_definitions, screenshot_storage_id, status }) {
  await mutationWithRetry(api.lpTemplates.create, {
    externalId: id,
    project_id,
    source_url,
    name,
    skeleton_html,
    design_brief,
    slot_definitions,
    screenshot_storage_id: screenshot_storage_id || undefined,
    status: status || 'extracting',
  });
}

export async function updateLPTemplate(externalId, fields) {
  const allowed = ['name', 'skeleton_html', 'design_brief', 'slot_definitions', 'screenshot_storage_id', 'status', 'error_message'];
  const filtered = {};
  for (const key of allowed) {
    if (fields[key] !== undefined) filtered[key] = fields[key];
  }
  await mutationWithRetry(api.lpTemplates.update, { externalId, ...filtered });
}

export async function deleteLPTemplate(externalId) {
  await mutationWithRetry(api.lpTemplates.remove, { externalId });
}

// =============================================
// User helpers
// =============================================

export async function getUserByUsername(username) {
  return await queryWithRetry(api.users.getByUsername, { username });
}

export async function getUserByExternalId(externalId) {
  return await queryWithRetry(api.users.getByExternalId, { externalId });
}

export async function getAllUsers() {
  return await queryWithRetry(api.users.getAll, {});
}

export async function getUserCount() {
  return await queryWithRetry(api.users.count, {});
}

export async function createUser({ externalId, username, display_name, password_hash, role, is_active, created_by }) {
  await mutationWithRetry(api.users.create, {
    externalId,
    username,
    display_name,
    password_hash,
    role,
    is_active: is_active !== false,
    created_by: created_by || undefined,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

export async function updateUser(externalId, updates) {
  await mutationWithRetry(api.users.update, {
    externalId,
    ...updates,
    updated_at: new Date().toISOString(),
  });
}

export async function updateUserPassword(externalId, password_hash) {
  await mutationWithRetry(api.users.updatePassword, {
    externalId,
    password_hash,
    updated_at: new Date().toISOString(),
  });
}

export async function deleteUser(externalId) {
  await mutationWithRetry(api.users.remove, { externalId });
}

// =============================================
// Session store helpers (for ConvexSessionStore)
// =============================================

export async function getSession(sid) {
  return await queryWithRetry(api.sessions.get, { sid });
}

export async function setSession(sid, sessionData, expiresAt) {
  await mutationWithRetry(api.sessions.set, {
    sid,
    session_data: sessionData,
    expires_at: expiresAt,
  });
}

export async function destroySession(sid) {
  await mutationWithRetry(api.sessions.destroy, { sid });
}

export async function cleanupExpiredSessions() {
  return await mutationWithRetry(api.sessions.cleanupExpired, {});
}

// =============================================
// Conductor Config helpers (Dacia Creative Director)
// =============================================

export async function getConductorConfig(projectId) {
  return await queryWithRetry(api.conductor.getConfig, { projectId });
}

export async function upsertConductorConfig(projectId, fields) {
  await mutationWithRetry(api.conductor.upsertConfig, { project_id: projectId, ...fields });
}

export async function getAllConductorConfigs() {
  return await queryWithRetry(api.conductor.getAllConfigs, {});
}

// =============================================
// LP Agent Config helpers (Landing Page Agent)
// =============================================

export async function getLPAgentConfig(projectId) {
  return await queryWithRetry(api.lpAgentConfig.getByProject, { projectId });
}

export async function upsertLPAgentConfig(projectId, fields) {
  await mutationWithRetry(api.lpAgentConfig.upsertConfig, { project_id: projectId, ...fields });
}

export async function getAllLPAgentConfigs() {
  return await queryWithRetry(api.lpAgentConfig.getAllConfigs, {});
}

// =============================================
// Conductor Angles helpers
// =============================================

export async function getConductorAngles(projectId) {
  return await queryWithRetry(api.conductor.getAngles, { projectId });
}

export async function getActiveConductorAngles(projectId) {
  return await queryWithRetry(api.conductor.getActiveAngles, { projectId });
}

export async function createConductorAngle({ id, project_id, name, description, prompt_hints, source, status }) {
  await mutationWithRetry(api.conductor.createAngle, {
    externalId: id,
    project_id,
    name,
    description,
    prompt_hints: prompt_hints || undefined,
    source: source || 'manual',
    status: status || 'active',
  });
}

export async function updateConductorAngle(id, fields) {
  await mutationWithRetry(api.conductor.updateAngle, { externalId: id, ...fields });
}

export async function deleteConductorAngle(id) {
  await mutationWithRetry(api.conductor.deleteAngle, { externalId: id });
}

// =============================================
// Conductor Runs helpers (audit log)
// =============================================

export async function getConductorRuns(projectId, limit = 50) {
  return await queryWithRetry(api.conductor.getRuns, { projectId, limit });
}

export async function createConductorRun(fields) {
  await mutationWithRetry(api.conductor.createRun, fields);
}

export async function updateConductorRun(id, fields) {
  await mutationWithRetry(api.conductor.updateRun, { externalId: id, ...fields });
}

// =============================================
// Conductor Health helpers (Fixer monitoring)
// =============================================

export async function getConductorHealth(limit = 50) {
  return await queryWithRetry(api.conductor.getHealth, { limit });
}

export async function getConductorHealthByAgent(agent, limit = 20) {
  return await queryWithRetry(api.conductor.getHealthByAgent, { agent, limit });
}

export async function createConductorHealth(fields) {
  await mutationWithRetry(api.conductor.createHealth, fields);
}

// =============================================
// Conductor Playbooks helpers (per-angle learning)
// =============================================

export async function getConductorPlaybooks(projectId) {
  return await queryWithRetry(api.conductor.getPlaybooks, { projectId });
}

export async function getConductorPlaybook(projectId, angleName) {
  return await queryWithRetry(api.conductor.getPlaybook, { projectId, angleName });
}

export async function upsertConductorPlaybook(fields) {
  await mutationWithRetry(api.conductor.upsertPlaybook, fields);
}

// =============================================
// Fixer Playbook helpers (Fixer learning memory)
// =============================================

export async function getFixerPlaybooks() {
  return await queryWithRetry(api.conductor.getFixerPlaybooks, {});
}

export async function getFixerPlaybook(issueCategory) {
  return await queryWithRetry(api.conductor.getFixerPlaybook, { issueCategory });
}

export async function upsertFixerPlaybook(fields) {
  await mutationWithRetry(api.conductor.upsertFixerPlaybook, fields);
}

// =============================================
// Direct Convex client access (for advanced use cases)
// =============================================

export { client as convexClient, api };

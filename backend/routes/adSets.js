// Phase 6 — Unified Ad Set routes. Replaces both the legacy flex-ad endpoints
// (in routes/deployments.js) and the Phase 1 Staging Page endpoints (in
// routes/staging.js). Single source of truth for ad_set lifecycle CRUD.
//
// Lifecycle graph: draft → ready → observing → {passed | failed | failed_external | insufficient_data}
//
// Backwards-compat aliases (mounted at the bottom) preserve `/staging/adsets/*`
// paths that may still be called by external scripts. They delegate to the
// new endpoints with byte-identical response shapes. Marked DEPRECATED;
// removed in Phase 6.1 once production logs show zero hits for 7 days.
//
// All endpoints emit X-API-Version: phase6-v1 header. Frontend checks for
// version mismatch on every response and prompts a refresh.

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth, requireRole } from '../auth.js';
import {
  getProject,
  getStagingPending,
  getStagingPromoted,
  getStagingRejected,
  getAdSet,
  getAdSetsByProject,
  promoteAdSet,
  regroupAds,
  createAdSetFromDeployments,
  createEmptyAdSet,
  forcePromoteAd,
  updateAdSet,
  deleteAdSet,
  ensureDefaultCampaign,
  getCampaignsByProject,
  parseAdSetDefaults,
  convexClient,
  api,
  getDeploymentsByProject,
  updateDeployment,
  getConvexHost,
} from '../convexClient.js';
import { postAdSetToMeta } from '../services/metaWriter.js';
import {
  buildManualAdSetCreateInput,
  getManualCombineErrorResponse,
  normalizeDeploymentIds,
} from '../services/adSetPlanner.js';

const router = Router();
router.use(requireAuth);

// Every Phase 6 endpoint emits this header so the frontend can detect
// stale-bundle scenarios after a deploy and prompt a refresh.
router.use((req, res, next) => {
  res.setHeader('X-API-Version', 'phase6-v1');
  next();
});

// ────────────────────────────────────────────────
// Ad-set CRUD
// ────────────────────────────────────────────────

// GET /api/projects/:projectId/ad-sets?lifecycle=draft,ready,observing
//   Returns ad_sets in the given lifecycle states. Comma-separated; defaults
//   to all non-terminal states. Each ad_set comes with member ads/deployments.
router.get('/:projectId/ad-sets', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const requested = (req.query.lifecycle || 'draft,ready,observing,passed,failed,failed_external,insufficient_data')
      .split(',').map((s) => s.trim()).filter(Boolean);
    const adSets = await convexClient.query(api.adSets.getByProjectAndLifecycles, {
      projectId: req.params.projectId,
      lifecycles: requested,
    });
    res.json({ adSets: adSets || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/:projectId/ad-sets
//   Body: { name, campaign_id, deployment_ids[], create_new_campaign? }
//   Groups N deployments into a new ad_set with lifecycle='draft'.
//   If create_new_campaign is set + non-empty, upserts it first.
router.post('/:projectId/ad-sets', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    let { name, campaign_id, deployment_ids, create_new_campaign, angle_id } = req.body || {};

    // Validation per Phase 6 spec
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'name required' });
    }
    name = name.trim();
    if (name.length > 80) {
      return res.status(400).json({ error: 'name must be 80 chars or fewer' });
    }
    if (!Array.isArray(deployment_ids) || deployment_ids.length === 0) {
      return res.status(400).json({ error: 'deployment_ids must be a non-empty array' });
    }
    const normalizedDeploymentIds = normalizeDeploymentIds(deployment_ids);
    if (normalizedDeploymentIds.error) {
      return res.status(400).json({ error: normalizedDeploymentIds.error });
    }
    deployment_ids = normalizedDeploymentIds.ids;

    // Resolve campaign: explicit id, or upsert "create new", or project default.
    let resolvedCampaignId = typeof campaign_id === 'string' ? campaign_id.trim() : campaign_id;
    if (resolvedCampaignId) {
      const projectCampaigns = await getCampaignsByProject(req.params.projectId);
      if (!projectCampaigns.some((campaign) => campaign.id === resolvedCampaignId)) {
        return res.status(400).json({ error: 'Campaign not found or does not belong to this project' });
      }
    }
    if (!resolvedCampaignId && create_new_campaign && typeof create_new_campaign === 'string') {
      const campaignName = create_new_campaign.trim();
      if (!campaignName) {
        return res.status(400).json({ error: 'create_new_campaign must not be empty' });
      }
      if (campaignName.length > 80) {
        return res.status(400).json({ error: 'create_new_campaign must be 80 chars or fewer' });
      }
      resolvedCampaignId = await convexClient.mutation(api.campaigns.upsertByProjectAndName, {
        project_id: req.params.projectId,
        name: campaignName,
      });
    }
    if (!resolvedCampaignId) {
      resolvedCampaignId = await ensureDefaultCampaign(project);
    }

    const defaults = parseAdSetDefaults(project);
    const adSetId = uuidv4();
    await createAdSetFromDeployments({
      ...buildManualAdSetCreateInput({
        adSetId,
        projectId: req.params.projectId,
        campaignId: resolvedCampaignId,
        angleId: angle_id,
        name,
        defaults,
      }),
      deployment_ids,
    });

    res.json({ success: true, adSetId, campaign_id: resolvedCampaignId });
  } catch (err) {
    const { status, message } = getManualCombineErrorResponse(err, { convexHost: getConvexHost() });
    res.status(status).json({ error: message });
  }
});

// PUT /api/projects/:projectId/ad-sets/:adSetId
//   Body: whitelist of fields. Updates an ad_set in any lifecycle.
router.put('/:projectId/ad-sets/:adSetId', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const adSet = await getAdSet(req.params.adSetId);
    if (!adSet) return res.status(404).json({ error: 'Ad set not found' });
    if (adSet.project_id !== project.id) {
      return res.status(403).json({ error: 'Ad set does not belong to this project' });
    }

    const allowed = [
      'name', 'campaign_id', 'lifecycle_status', 'angle_id',
      'meta_targeting', 'meta_budget_type', 'meta_budget_amount_cents',
      'meta_schedule', 'meta_optimization_goal', 'meta_billing_event',
      'observation_paused_at', 'observation_paused_total_ms', 'extension_days',
    ];
    const fields = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) fields[key] = req.body[key];
    }
    if (Object.keys(fields).length === 0) {
      return res.status(400).json({ error: 'No allowed fields supplied' });
    }
    await updateAdSet(req.params.adSetId, fields);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/:projectId/ad-sets/:adSetId/move-to-ready
//   Convenience endpoint: flips lifecycle to 'ready'. Replaces the legacy
//   /staging/adsets/:adSetId/promote route.
router.post('/:projectId/ad-sets/:adSetId/move-to-ready', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const adSet = await getAdSet(req.params.adSetId);
    if (!adSet) return res.status(404).json({ error: 'Ad set not found' });
    if (adSet.project_id !== project.id) {
      return res.status(403).json({ error: 'Ad set does not belong to this project' });
    }
    if (!['draft', 'staging'].includes(adSet.lifecycle_status || '')) {
      return res.status(400).json({
        error: `Cannot move to Ready from "${adSet.lifecycle_status}" — only draft sets can be moved to Ready.`,
      });
    }
    await updateAdSet(req.params.adSetId, { lifecycle_status: 'ready' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/:projectId/ad-sets/:adSetId/regroup
//   Body: { adIds: string[] } — moves the listed ad deployments INTO this ad_set.
//   Wraps the existing regroupAds helper.
router.post('/:projectId/ad-sets/:adSetId/regroup', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const target = await getAdSet(req.params.adSetId);
    if (!target) return res.status(404).json({ error: 'Target ad set not found' });
    if (target.project_id !== project.id) {
      return res.status(403).json({ error: 'Target ad set does not belong to this project' });
    }
    const { adIds } = req.body || {};
    if (!Array.isArray(adIds) || adIds.length === 0) {
      return res.status(400).json({ error: 'adIds must be a non-empty array' });
    }
    await regroupAds(adIds, req.params.adSetId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/:projectId/ad-sets/:adSetId/ungroup
//   Removes the ad_set entirely. Member deployments revert to local_adset_id=null
//   (back to "ungrouped" in Planner). Only allowed in draft/ready lifecycle.
router.post('/:projectId/ad-sets/:adSetId/ungroup', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const adSet = await getAdSet(req.params.adSetId);
    if (!adSet) return res.status(404).json({ error: 'Ad set not found' });
    if (adSet.project_id !== project.id) {
      return res.status(403).json({ error: 'Ad set does not belong to this project' });
    }
    if (!['draft', 'ready', 'staging', 'promoted'].includes(adSet.lifecycle_status || '')) {
      return res.status(400).json({
        error: `Cannot ungroup ad set in "${adSet.lifecycle_status}" lifecycle — only draft and ready ad sets can be ungrouped.`,
      });
    }

    // Detach all member deployments
    const deployments = await getDeploymentsByProject(req.params.projectId);
    const members = deployments.filter((d) => d.local_adset_id === req.params.adSetId);
    for (const dep of members) {
      await updateDeployment(dep.externalId, { local_adset_id: '' });
    }
    await deleteAdSet(req.params.adSetId);
    res.json({ success: true, deployments_detached: members.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/:projectId/ad-sets/:adSetId/post-to-meta
//   Phase 2B Meta posting — preserved verbatim from staging.js. Operates on
//   ad sets in 'ready' lifecycle.
router.post('/:projectId/ad-sets/:adSetId/post-to-meta', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const adSet = await getAdSet(req.params.adSetId);
    if (!adSet) return res.status(404).json({ error: 'Ad set not found' });
    if (adSet.project_id !== project.id) {
      return res.status(403).json({ error: 'Ad set does not belong to this project' });
    }
    if (!['ready', 'promoted'].includes(adSet.lifecycle_status || '')) {
      return res.status(400).json({
        error: `Cannot post ad set with lifecycle "${adSet.lifecycle_status}" — only Ready ad sets can be posted.`,
      });
    }
    const result = await postAdSetToMeta(req.params.adSetId, req.params.projectId);
    res.json({ success: true, ...result });
  } catch (err) {
    const status = err.code === 'TOKEN_EXPIRED' ? 401
      : err.code === 'NO_PAGE' || err.code === 'NO_ACCOUNT' || err.code === 'NOT_CONNECTED' || err.code === 'NO_ADS' ? 400
      : err.code === 'WRONG_PROJECT' ? 403
      : err.code === 'MCP_NOT_AUTHORIZED' ? 403
      : 500;
    res.status(status).json({ error: err.message, code: err.code || null });
  }
});

// PUT /api/projects/:projectId/ad-sets/:adSetId/meta-settings
//   Update Meta-side fields on an ad set. Same body shape as the legacy
//   /staging/adsets/:adSetId/meta-settings route.
router.put('/:projectId/ad-sets/:adSetId/meta-settings', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const adSet = await getAdSet(req.params.adSetId);
    if (!adSet) return res.status(404).json({ error: 'Ad set not found' });
    if (adSet.project_id !== project.id) {
      return res.status(403).json({ error: 'Ad set does not belong to this project' });
    }
    const allowed = [
      'name', 'campaign_id',
      'meta_targeting', 'meta_budget_type', 'meta_budget_amount_cents',
      'meta_schedule', 'meta_optimization_goal', 'meta_billing_event',
    ];
    const fields = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) fields[key] = req.body[key];
    }
    if (Object.keys(fields).length === 0) {
      return res.status(400).json({ error: 'No allowed fields supplied' });
    }
    await updateAdSet(req.params.adSetId, fields);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────
// Pipeline read views — GET /pending, /promoted, /rejected
// (mapped to /draft, /ready, /rejected for new naming; aliases preserved)
// ────────────────────────────────────────────────

// GET /api/projects/:projectId/ad-sets/draft — replaces /staging/pending
router.get('/:projectId/ad-sets/draft', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const groups = await getStagingPending(req.params.projectId);
    res.json({ groups });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/projects/:projectId/ad-sets/ready — replaces /staging/promoted
router.get('/:projectId/ad-sets/ready', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const adSets = await getStagingPromoted(req.params.projectId);
    res.json({ adSets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/projects/:projectId/ad-sets/rejected — replaces /staging/rejected
router.get('/:projectId/ad-sets/rejected', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const ads = await getStagingRejected(req.params.projectId);
    res.json({ ads });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/:projectId/ad-sets/:adSetId/lock-deployments
//   Body: { deployment_ids[], ttlMs? }
//   Soft-locks deployments for 30s during the Combine modal so concurrent
//   deletes from another session can't break the save. Phase 6 PEF item.
router.post('/:projectId/lock-deployments', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { deployment_ids, ttlMs } = req.body || {};
    if (!Array.isArray(deployment_ids) || deployment_ids.length === 0) {
      return res.status(400).json({ error: 'deployment_ids must be a non-empty array' });
    }
    const result = await convexClient.mutation(api.migrations.softLockDeployments, {
      deployment_ids,
      ttlMs: ttlMs || 30_000,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

// POST /api/projects/:projectId/ads/:adId/force-promote
//   Operator override: flip a quality_rejected ad back to staging (the
//   ad_creatives.status — pre-Phase-1 contract). Preserved verbatim.
router.post('/:projectId/ads/:adId/force-promote', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    await forcePromoteAd(req.params.adId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────
// DEPRECATED — Phase 6 backwards-compat aliases.
// Drop in Phase 6.1 after 7 consecutive days of zero hits in production logs.
// All aliases delegate to the new endpoints with byte-identical response shape.
// ────────────────────────────────────────────────

// /staging/pending → /ad-sets/draft
router.get('/:projectId/staging/pending', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const groups = await getStagingPending(req.params.projectId);
    res.json({ groups });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// /staging/promoted → /ad-sets/ready
router.get('/:projectId/staging/promoted', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const adSets = await getStagingPromoted(req.params.projectId);
    res.json({ adSets });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// /staging/rejected
router.get('/:projectId/staging/rejected', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const ads = await getStagingRejected(req.params.projectId);
    res.json({ ads });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// /staging/adsets/:adSetId/meta-settings → /ad-sets/:adSetId/meta-settings
router.put('/:projectId/staging/adsets/:adSetId/meta-settings', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const adSet = await getAdSet(req.params.adSetId);
    if (!adSet) return res.status(404).json({ error: 'Ad set not found' });
    if (adSet.project_id !== project.id) {
      return res.status(403).json({ error: 'Ad set does not belong to this project' });
    }
    const allowed = ['name', 'campaign_id', 'meta_targeting', 'meta_budget_type', 'meta_budget_amount_cents', 'meta_schedule', 'meta_optimization_goal', 'meta_billing_event'];
    const fields = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) fields[key] = req.body[key];
    }
    if (Object.keys(fields).length === 0) return res.status(400).json({ error: 'No allowed fields supplied' });
    await updateAdSet(req.params.adSetId, fields);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// /staging/adsets/:adSetId/promote → /ad-sets/:adSetId/move-to-ready
router.post('/:projectId/staging/adsets/:adSetId/promote', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const adSet = await getAdSet(req.params.adSetId);
    if (!adSet) return res.status(404).json({ error: 'Ad set not found' });
    if (adSet.project_id !== project.id) {
      return res.status(403).json({ error: 'Ad set does not belong to this project' });
    }
    await promoteAdSet(req.params.adSetId);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// /staging/regroup
router.post('/:projectId/staging/regroup', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const { adIds, targetAdSetId } = req.body || {};
    if (!Array.isArray(adIds) || adIds.length === 0) return res.status(400).json({ error: 'adIds must be a non-empty array' });
    if (!targetAdSetId) return res.status(400).json({ error: 'targetAdSetId is required' });
    const target = await getAdSet(targetAdSetId);
    if (!target) return res.status(404).json({ error: 'Target ad set not found' });
    if (target.project_id !== project.id) return res.status(403).json({ error: 'Target ad set does not belong to this project' });
    await regroupAds(adIds, targetAdSetId);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// /staging/adsets/new — preserved for legacy callers
router.post('/:projectId/staging/adsets/new', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const { angle_id, name, campaign_id } = req.body || {};
    if (!angle_id) return res.status(400).json({ error: 'angle_id is required' });
    const resolvedCampaignId = campaign_id || await ensureDefaultCampaign(project);
    const defaults = parseAdSetDefaults(project);
    const adSetId = uuidv4();
    const adSetName = name && typeof name === 'string' && name.trim()
      ? name.trim()
      : `New ad set — ${new Date().toISOString().slice(0, 10)}`;
    await createEmptyAdSet({
      id: adSetId,
      project_id: project.id,
      campaign_id: resolvedCampaignId,
      angle_id,
      name: adSetName,
      sort_order: 0,
      meta_targeting: defaults.meta_targeting,
      meta_budget_type: defaults.meta_budget_type,
      meta_budget_amount_cents: defaults.meta_budget_amount_cents,
      meta_schedule: defaults.meta_schedule,
      meta_optimization_goal: defaults.meta_optimization_goal,
      meta_billing_event: defaults.meta_billing_event,
    });
    res.json({ success: true, adSetId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// /staging/adsets/:adSetId/post-to-meta — preserved verbatim
router.post('/:projectId/staging/adsets/:adSetId/post-to-meta', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const adSet = await getAdSet(req.params.adSetId);
    if (!adSet) return res.status(404).json({ error: 'Ad set not found' });
    if (adSet.project_id !== project.id) {
      return res.status(403).json({ error: 'Ad set does not belong to this project' });
    }
    if (!['ready', 'promoted'].includes(adSet.lifecycle_status || '')) {
      return res.status(400).json({
        error: `Cannot post ad set with lifecycle "${adSet.lifecycle_status}" — only Ready/promoted sets can be posted`,
      });
    }
    const result = await postAdSetToMeta(req.params.adSetId, req.params.projectId);
    res.json({ success: true, ...result });
  } catch (err) {
    const status = err.code === 'TOKEN_EXPIRED' ? 401
      : err.code === 'NO_PAGE' || err.code === 'NO_ACCOUNT' || err.code === 'NOT_CONNECTED' || err.code === 'NO_ADS' ? 400
      : err.code === 'WRONG_PROJECT' ? 403
      : err.code === 'MCP_NOT_AUTHORIZED' ? 403
      : 500;
    res.status(status).json({ error: err.message, code: err.code || null });
  }
});

// ────────────────────────────────────────────────
// Flat (project-agnostic) ad-set routes — used by legacy api.updateFlexAd /
// api.deleteFlexAd which had only an ID parameter, no projectId. Looks up
// project from the ad_set itself, then enforces same rules as scoped routes.
// Exported separately so server.js can mount at /api (not /api/projects).
// ────────────────────────────────────────────────

export const adSetsFlatRouter = Router();
adSetsFlatRouter.use(requireAuth);
adSetsFlatRouter.use((req, res, next) => {
  res.setHeader('X-API-Version', 'phase6-v1');
  next();
});

adSetsFlatRouter.put('/ad-sets/:adSetId', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const adSet = await getAdSet(req.params.adSetId);
    if (!adSet) return res.status(404).json({ error: 'Ad set not found' });
    const allowed = [
      'name', 'campaign_id', 'lifecycle_status', 'angle_id',
      'meta_targeting', 'meta_budget_type', 'meta_budget_amount_cents',
      'meta_schedule', 'meta_optimization_goal', 'meta_billing_event',
    ];
    const fields = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) fields[key] = req.body[key];
    }
    if (Object.keys(fields).length === 0) {
      return res.status(400).json({ error: 'No allowed fields supplied' });
    }
    await updateAdSet(req.params.adSetId, fields);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

adSetsFlatRouter.post('/ad-sets/:adSetId/ungroup', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const adSet = await getAdSet(req.params.adSetId);
    if (!adSet) return res.status(404).json({ error: 'Ad set not found' });
    if (!['draft', 'ready', 'staging', 'promoted'].includes(adSet.lifecycle_status || '')) {
      return res.status(400).json({
        error: `Cannot ungroup ad set in "${adSet.lifecycle_status}" lifecycle.`,
      });
    }
    const deployments = await getDeploymentsByProject(adSet.project_id);
    const members = deployments.filter((d) => d.local_adset_id === req.params.adSetId);
    for (const dep of members) {
      await updateDeployment(dep.externalId, { local_adset_id: '' });
    }
    await deleteAdSet(req.params.adSetId);
    res.json({ success: true, deployments_detached: members.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

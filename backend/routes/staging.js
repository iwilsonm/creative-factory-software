// Phase 1 — Staging Page routes.
// All routes are admin/manager only and project-scoped.

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth, requireRole } from '../auth.js';
import {
  getProject,
  getStagingPending,
  getStagingPromoted,
  getStagingRejected,
  getAdSet,
  promoteAdSet,
  regroupAds,
  createEmptyAdSet,
  forcePromoteAd,
  updateAdSet,
  ensureDefaultCampaign,
  parseAdSetDefaults,
} from '../convexClient.js';

const router = Router();
router.use(requireAuth);

// ----- READ -----

// GET /api/projects/:id/staging/pending
// Returns ad sets in "staging" lifecycle, each with their member ads.
router.get('/:projectId/staging/pending', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const groups = await getStagingPending(req.params.projectId);
    res.json({ groups });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/projects/:id/staging/rejected
router.get('/:projectId/staging/rejected', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const ads = await getStagingRejected(req.params.projectId);
    res.json({ ads });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/projects/:id/staging/promoted
router.get('/:projectId/staging/promoted', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const adSets = await getStagingPromoted(req.params.projectId);
    res.json({ adSets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----- WRITE -----

// PUT /api/projects/:id/staging/adsets/:adSetId/meta-settings
// Update an ad set's Meta-side settings (targeting, budget, schedule, etc.).
// Body shape: { meta_targeting?, meta_budget_type?, meta_budget_amount_cents?,
//   meta_schedule?, meta_optimization_goal?, meta_billing_event?, name?, campaign_id? }
router.put('/:projectId/staging/adsets/:adSetId/meta-settings', requireRole('admin', 'manager'), async (req, res) => {
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

// POST /api/projects/:id/staging/adsets/:adSetId/promote
// Flips lifecycle_status: "staging" -> "promoted" (moves to Ready-to-Post).
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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/:id/staging/regroup
// Body: { adIds: string[], targetAdSetId: string }
router.post('/:projectId/staging/regroup', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { adIds, targetAdSetId } = req.body || {};
    if (!Array.isArray(adIds) || adIds.length === 0) {
      return res.status(400).json({ error: 'adIds must be a non-empty array' });
    }
    if (!targetAdSetId || typeof targetAdSetId !== 'string') {
      return res.status(400).json({ error: 'targetAdSetId is required' });
    }
    const target = await getAdSet(targetAdSetId);
    if (!target) return res.status(404).json({ error: 'Target ad set not found' });
    if (target.project_id !== project.id) {
      return res.status(403).json({ error: 'Target ad set does not belong to this project' });
    }
    await regroupAds(adIds, targetAdSetId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/:id/staging/adsets/new
// Body: { angle_id: string, name?: string, campaign_id?: string }
// Creates an empty ad_set in "staging" lifecycle. Caller can then regroup ads into it.
router.post('/:projectId/staging/adsets/new', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { angle_id, name, campaign_id } = req.body || {};
    if (!angle_id || typeof angle_id !== 'string') {
      return res.status(400).json({ error: 'angle_id is required (every ad set tests one angle)' });
    }

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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/:id/ads/:adId/force-promote
// Operator override: flip a quality_rejected ad back to staging.
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

export default router;

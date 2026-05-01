// Phase 5 — Analytics tab routes.
// All require auth + admin/manager.

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth, requireRole } from '../auth.js';
import {
  getProject,
  getProjectRawForMeta,
  convexClient,
  api,
} from '../convexClient.js';
import {
  getCampaignsWithInsights,
  getAdSetsWithInsights,
  getAdsWithInsights,
} from '../services/metaAnalytics.js';
import { isTokenInvalidError } from '../services/metaApi.js';

const router = Router();
router.use(requireAuth);

// ────────────────────────────────────────────────
// Analytics data — pulls from Meta + cross-references local Convex
// ────────────────────────────────────────────────

async function readDateOpts(req) {
  return {
    datePreset: req.query.datePreset || 'last_7d',
    dateFrom: req.query.dateFrom || null,
    dateTo: req.query.dateTo || null,
    campaignId: req.query.campaignId || null,
    adsetId: req.query.adsetId || null,
  };
}

// Build Meta-id → CF metadata map for cross-referencing display.
async function buildCfBackmap(projectId, level) {
  if (level === 'campaign') {
    const list = await convexClient.query(api.campaigns.getByProject, { projectId });
    const map = new Map();
    for (const c of list || []) {
      if (c.meta_campaign_id) map.set(c.meta_campaign_id, { cf_id: c.externalId, cf_name: c.name });
    }
    return map;
  }
  if (level === 'ad_set') {
    const list = await convexClient.query(api.adSets.getByProject, { projectId });
    const map = new Map();
    for (const s of list || []) {
      if (s.meta_adset_id) map.set(s.meta_adset_id, {
        cf_id: s.externalId,
        cf_name: s.name,
        cf_lifecycle: s.lifecycle_status,
      });
    }
    return map;
  }
  if (level === 'ad') {
    const all = await convexClient.query(api.adCreatives.getAll, {});
    const map = new Map();
    for (const a of all || []) {
      if (a.project_id === projectId && a.meta_ad_id) {
        map.set(a.meta_ad_id, { cf_id: a.externalId, cf_headline: a.headline });
      }
    }
    return map;
  }
  return new Map();
}

async function attachCfMetadata(rows, level, projectId) {
  const map = await buildCfBackmap(projectId, level);
  return rows.map((r) => {
    const cf = map.get(r.id);
    return cf ? { ...r, cf_source: cf } : r;
  });
}

router.get('/:projectId/analytics/campaigns', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const project = await getProjectRawForMeta(req.params.projectId);
    if (!project?.meta_access_token || !project?.meta_account_id) {
      return res.status(400).json({ error: 'Connect Meta + select an ad account first.' });
    }
    const opts = await readDateOpts(req);
    const campaigns = await getCampaignsWithInsights(project.meta_access_token, project.meta_account_id, opts);
    const enriched = await attachCfMetadata(campaigns, 'campaign', req.params.projectId);
    res.json({ campaigns: enriched });
  } catch (err) {
    if (isTokenInvalidError(err)) return res.status(401).json({ error: 'Meta token expired. Reconnect.', code: 'TOKEN_EXPIRED' });
    res.status(500).json({ error: err.message });
  }
});

router.get('/:projectId/analytics/adsets', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const project = await getProjectRawForMeta(req.params.projectId);
    if (!project?.meta_access_token || !project?.meta_account_id) {
      return res.status(400).json({ error: 'Connect Meta + select an ad account first.' });
    }
    const opts = await readDateOpts(req);
    const adsets = await getAdSetsWithInsights(project.meta_access_token, project.meta_account_id, opts);
    const enriched = await attachCfMetadata(adsets, 'ad_set', req.params.projectId);
    res.json({ adsets: enriched });
  } catch (err) {
    if (isTokenInvalidError(err)) return res.status(401).json({ error: 'Meta token expired. Reconnect.', code: 'TOKEN_EXPIRED' });
    res.status(500).json({ error: err.message });
  }
});

router.get('/:projectId/analytics/ads', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const project = await getProjectRawForMeta(req.params.projectId);
    if (!project?.meta_access_token || !project?.meta_account_id) {
      return res.status(400).json({ error: 'Connect Meta + select an ad account first.' });
    }
    const opts = await readDateOpts(req);
    const ads = await getAdsWithInsights(project.meta_access_token, project.meta_account_id, opts);
    const enriched = await attachCfMetadata(ads, 'ad', req.params.projectId);
    res.json({ ads: enriched });
  } catch (err) {
    if (isTokenInvalidError(err)) return res.status(401).json({ error: 'Meta token expired. Reconnect.', code: 'TOKEN_EXPIRED' });
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────
// Tags CRUD
// ────────────────────────────────────────────────

router.get('/:projectId/tags', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const tags = await convexClient.query(api.tags.getByProject, { projectId: req.params.projectId });
    res.json({ tags: tags || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:projectId/tags', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { name, color } = req.body || {};
    if (!name || !color) return res.status(400).json({ error: 'name + color required' });
    const externalId = uuidv4();
    await convexClient.mutation(api.tags.create, {
      externalId, project_id: req.params.projectId, name, color,
    });
    res.json({ success: true, externalId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:projectId/tags/:tagId', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { name, color } = req.body || {};
    await convexClient.mutation(api.tags.update, {
      externalId: req.params.tagId,
      ...(name !== undefined ? { name } : {}),
      ...(color !== undefined ? { color } : {}),
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:projectId/tags/:tagId', requireRole('admin', 'manager'), async (req, res) => {
  try {
    await convexClient.mutation(api.tags.remove, { externalId: req.params.tagId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────
// Tag assignments
// ────────────────────────────────────────────────

router.get('/:projectId/tags/assignments', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const entity_type = req.query.entity_type;
    if (!entity_type) return res.status(400).json({ error: 'entity_type required' });
    const assignments = await convexClient.query(api.tagAssignments.getByProjectAndEntityType, {
      projectId: req.params.projectId,
      entity_type,
    });
    res.json({ assignments: assignments || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:projectId/tags/assignments', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { tag_id, entity_type, entity_id, entity_id_kind = 'meta' } = req.body || {};
    if (!tag_id || !entity_type || !entity_id) {
      return res.status(400).json({ error: 'tag_id + entity_type + entity_id required' });
    }
    const externalId = uuidv4();
    await convexClient.mutation(api.tagAssignments.create, {
      externalId,
      project_id: req.params.projectId,
      tag_id,
      entity_type,
      entity_id: String(entity_id),
      entity_id_kind,
    });
    res.json({ success: true, externalId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:projectId/tags/assignments', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { tag_id, entity_id, entity_type } = req.body || {};
    if (!tag_id || !entity_id || !entity_type) {
      return res.status(400).json({ error: 'tag_id + entity_id + entity_type required' });
    }
    await convexClient.mutation(api.tagAssignments.removeByEntityAndTag, {
      tag_id,
      entity_id: String(entity_id),
      entity_type,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────
// Saved views
// ────────────────────────────────────────────────

router.get('/:projectId/analytics/views', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const userId = req.session?.userId;
    const views = await convexClient.query(api.analyticsSavedViews.getVisibleToUser, {
      projectId: req.params.projectId,
      userId,
    });
    res.json({ views: views || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:projectId/analytics/views', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { name, scope, level, config } = req.body || {};
    if (!name || !scope || !level || !config) {
      return res.status(400).json({ error: 'name + scope + level + config required' });
    }
    if (scope !== 'private' && scope !== 'project') {
      return res.status(400).json({ error: 'scope must be "private" or "project"' });
    }
    const externalId = uuidv4();
    await convexClient.mutation(api.analyticsSavedViews.create, {
      externalId,
      project_id: req.params.projectId,
      owner_user_id: req.session?.userId,
      scope,
      name,
      level,
      config: typeof config === 'string' ? config : JSON.stringify(config),
    });
    res.json({ success: true, externalId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:projectId/analytics/views/:viewId', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const updates = {};
    for (const key of ['name', 'scope', 'level', 'config']) {
      if (req.body[key] !== undefined) {
        updates[key] = key === 'config' && typeof req.body[key] !== 'string'
          ? JSON.stringify(req.body[key])
          : req.body[key];
      }
    }
    await convexClient.mutation(api.analyticsSavedViews.update, {
      externalId: req.params.viewId, ...updates,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:projectId/analytics/views/:viewId', requireRole('admin', 'manager'), async (req, res) => {
  try {
    await convexClient.mutation(api.analyticsSavedViews.remove, {
      externalId: req.params.viewId,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

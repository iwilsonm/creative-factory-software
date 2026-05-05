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
  getSetting,
} from '../convexClient.js';
import {
  getCampaignsWithInsights,
  getAdSetsWithInsights,
  getAdsWithInsights,
  getTimeseriesInsights,
  getHourlyInsights,
} from '../services/metaAnalytics.js';
import { isTokenInvalidError } from '../services/metaApi.js';
import {
  MCPReadUnavailableError,
  getCampaignsWithInsightsViaMcp,
  getAdSetsWithInsightsViaMcp,
  getAdsWithInsightsViaMcp,
} from '../services/metaMcpRead.js';
import { MCPNotAuthorizedError } from '../services/metaMcp.js';

const router = Router();
router.use(requireAuth);

// ────────────────────────────────────────────────
// Analytics data — pulls from Meta + cross-references local Convex
// ────────────────────────────────────────────────

async function readDateOpts(req) {
  const datePreset = req.query.datePreset || 'last_7d';
  const dateFrom = req.query.dateFrom || null;
  const dateTo = req.query.dateTo || null;
  if (dateFrom || dateTo) {
    const validDate = /^\d{4}-\d{2}-\d{2}$/;
    if (!validDate.test(dateFrom || '') || !validDate.test(dateTo || '')) {
      const err = new Error('Custom date range requires dateFrom and dateTo as YYYY-MM-DD.');
      err.status = 400;
      throw err;
    }
    if (dateFrom > dateTo) {
      const err = new Error('Custom date range start must be before or equal to end.');
      err.status = 400;
      throw err;
    }
  }
  return {
    datePreset,
    dateFrom,
    dateTo,
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

function isMcpRead(project) {
  return (project?.meta_read_path || 'api') === 'mcp';
}

async function mcpReadArgs(project, opts, projectId) {
  return {
    anthropicApiKey: await getSetting('anthropic_api_key'),
    metaToken: project.meta_access_token,
    accountId: project.meta_account_id,
    opts,
    projectId,
  };
}

function sendAnalyticsError(res, err) {
  if (isTokenInvalidError(err)) return res.status(401).json({ error: 'Meta token expired. Reconnect.', code: 'TOKEN_EXPIRED' });
  if (err instanceof MCPReadUnavailableError || err instanceof MCPNotAuthorizedError || err.code === 'MCP_READ_UNAVAILABLE' || err.code === 'MCP_NOT_AUTHORIZED') {
    return res.status(err.status || 424).json({
      error: 'Meta MCP reads are not available for this account/app. Switch Read Path to API or request MCP read access.',
      code: err.code || 'MCP_READ_UNAVAILABLE',
      details: err.message,
    });
  }
  if (err.status === 400) return res.status(400).json({ error: err.message });
  return res.status(500).json({ error: err.message });
}

router.get('/:projectId/analytics/campaigns', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const project = await getProjectRawForMeta(req.params.projectId);
    if (!project?.meta_access_token || !project?.meta_account_id) {
      return res.status(400).json({ error: 'Connect Meta + select an ad account first.' });
    }
    const opts = await readDateOpts(req);
    const campaigns = isMcpRead(project)
      ? await getCampaignsWithInsightsViaMcp(await mcpReadArgs(project, opts, req.params.projectId))
      : await getCampaignsWithInsights(project.meta_access_token, project.meta_account_id, opts);
    const enriched = await attachCfMetadata(campaigns, 'campaign', req.params.projectId);
    res.json({ campaigns: enriched });
  } catch (err) {
    sendAnalyticsError(res, err);
  }
});

router.get('/:projectId/analytics/adsets', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const project = await getProjectRawForMeta(req.params.projectId);
    if (!project?.meta_access_token || !project?.meta_account_id) {
      return res.status(400).json({ error: 'Connect Meta + select an ad account first.' });
    }
    const opts = await readDateOpts(req);
    const adsets = isMcpRead(project)
      ? await getAdSetsWithInsightsViaMcp(await mcpReadArgs(project, opts, req.params.projectId))
      : await getAdSetsWithInsights(project.meta_access_token, project.meta_account_id, opts);
    const enriched = await attachCfMetadata(adsets, 'ad_set', req.params.projectId);
    res.json({ adsets: enriched });
  } catch (err) {
    sendAnalyticsError(res, err);
  }
});

router.get('/:projectId/analytics/ads', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const project = await getProjectRawForMeta(req.params.projectId);
    if (!project?.meta_access_token || !project?.meta_account_id) {
      return res.status(400).json({ error: 'Connect Meta + select an ad account first.' });
    }
    const opts = await readDateOpts(req);
    const ads = isMcpRead(project)
      ? await getAdsWithInsightsViaMcp(await mcpReadArgs(project, opts, req.params.projectId))
      : await getAdsWithInsights(project.meta_access_token, project.meta_account_id, opts);
    const enriched = await attachCfMetadata(ads, 'ad', req.params.projectId);
    res.json({ ads: enriched });
  } catch (err) {
    sendAnalyticsError(res, err);
  }
});

router.get('/:projectId/analytics/timeseries', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const project = await getProjectRawForMeta(req.params.projectId);
    if (!project?.meta_access_token || !project?.meta_account_id) {
      return res.status(400).json({ error: 'Connect Meta + select an ad account first.' });
    }
    if (isMcpRead(project)) {
      throw new MCPReadUnavailableError('Timeseries charts are not yet supported through the Meta MCP read adapter.');
    }
    const opts = await readDateOpts(req);
    const data = await getTimeseriesInsights(project.meta_access_token, project.meta_account_id, opts);
    res.json(data);
  } catch (err) {
    sendAnalyticsError(res, err);
  }
});

router.get('/:projectId/analytics/hourly', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const project = await getProjectRawForMeta(req.params.projectId);
    if (!project?.meta_access_token || !project?.meta_account_id) {
      return res.status(400).json({ error: 'Connect Meta + select an ad account first.' });
    }
    if (isMcpRead(project)) {
      throw new MCPReadUnavailableError('Hourly charts are not yet supported through the Meta MCP read adapter.');
    }
    const opts = await readDateOpts(req);
    const data = await getHourlyInsights(project.meta_access_token, project.meta_account_id, opts);
    res.json(data);
  } catch (err) {
    sendAnalyticsError(res, err);
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
    if (/tag not found|assignment not found/i.test(err.message || '')) {
      return res.json({ success: true, message: 'Tag was already removed from this row.' });
    }
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
    if (/tag not found|assignment not found/i.test(err.message || '')) {
      return res.json({ success: true, count: 0, message: 'Tag was already removed from these rows.' });
    }
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
    const result = await convexClient.mutation(api.tags.remove, {
      externalId: req.params.tagId,
      projectId: req.params.projectId,
    });
    res.json({ success: true, deleted: result?.deleted !== false });
  } catch (err) {
    if (/tag not found/i.test(err.message || '')) {
      return res.json({ success: true, deleted: false, message: 'Tag was already removed.' });
    }
    const status = /does not belong/i.test(err.message || '') ? 404 : 500;
    res.status(status).json({ error: err.message });
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
    if (/tag not found|assignment not found/i.test(err.message || '')) {
      return res.json({ success: true, message: 'Tag was already removed from this row.' });
    }
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
    if (/tag not found|assignment not found/i.test(err.message || '')) {
      return res.json({ success: true, count: 0, message: 'Tag was already removed from these rows.' });
    }
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

router.post('/:projectId/tags/assignments/bulk', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const {
      tag_id,
      entity_type,
      entity_ids,
      entity_id_kind = 'meta',
    } = req.body || {};
    const ids = Array.isArray(entity_ids) ? [...new Set(entity_ids.map(String).filter(Boolean))] : [];
    if (!tag_id || !entity_type || ids.length === 0) {
      return res.status(400).json({ error: 'tag_id + entity_type + entity_ids required' });
    }

    for (const entity_id of ids) {
      await convexClient.mutation(api.tagAssignments.create, {
        externalId: uuidv4(),
        project_id: req.params.projectId,
        tag_id,
        entity_type,
        entity_id,
        entity_id_kind,
      });
    }
    res.json({ success: true, count: ids.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:projectId/tags/assignments/bulk', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { tag_id, entity_type, entity_ids } = req.body || {};
    const ids = Array.isArray(entity_ids) ? [...new Set(entity_ids.map(String).filter(Boolean))] : [];
    if (!tag_id || !entity_type || ids.length === 0) {
      return res.status(400).json({ error: 'tag_id + entity_type + entity_ids required' });
    }

    for (const entity_id of ids) {
      await convexClient.mutation(api.tagAssignments.removeByEntityAndTag, {
        tag_id,
        entity_id,
        entity_type,
      });
    }
    res.json({ success: true, count: ids.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────
// Entity notes
// ────────────────────────────────────────────────

function formatNoteEntry(note) {
  return String(note || '').trim();
}

async function syncDeploymentNote(entityId, note) {
  const deployment = await convexClient.query(api.ad_deployments.getByExternalId, { externalId: entityId });
  if (!deployment) return;
  await convexClient.mutation(api.ad_deployments.update, {
    externalId: entityId,
    fields: { notes: note },
  });
}

async function appendDeploymentNote(entityId, entry) {
  const deployment = await convexClient.query(api.ad_deployments.getByExternalId, { externalId: entityId });
  if (!deployment) return;
  const next = deployment.notes?.trim() ? `${deployment.notes.trim()}\n\n${entry}` : entry;
  await convexClient.mutation(api.ad_deployments.update, {
    externalId: entityId,
    fields: { notes: next },
  });
}

router.get('/:projectId/entity-notes', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const entity_type = req.query.entity_type;
    if (!entity_type) return res.status(400).json({ error: 'entity_type required' });
    const notes = await convexClient.query(api.entityNotes.getByProjectAndEntityType, {
      projectId: req.params.projectId,
      entity_type,
    });
    res.json({ notes: notes || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:projectId/entity-notes', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const {
      entity_type,
      entity_id,
      entity_id_kind = 'meta',
      note = '',
    } = req.body || {};
    if (!entity_type || !entity_id) {
      return res.status(400).json({ error: 'entity_type + entity_id required' });
    }

    const externalId = await convexClient.mutation(api.entityNotes.upsert, {
      externalId: uuidv4(),
      project_id: req.params.projectId,
      entity_type,
      entity_id: String(entity_id),
      entity_id_kind,
      note: String(note || ''),
      updated_by: req.session?.userId ? String(req.session.userId) : undefined,
    });

    if (entity_type === 'ad' && entity_id_kind === 'cf') {
      await syncDeploymentNote(String(entity_id), String(note || ''));
    }

    res.json({ success: true, externalId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:projectId/entity-notes/bulk', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const {
      entity_type,
      entity_ids,
      entity_id_kind = 'meta',
      mode = 'append',
      note,
    } = req.body || {};
    const ids = Array.isArray(entity_ids) ? [...new Set(entity_ids.map(String).filter(Boolean))] : [];
    const normalizedMode = ['append', 'replace', 'clear'].includes(mode) ? mode : 'append';
    if (!entity_type || ids.length === 0) {
      return res.status(400).json({ error: 'entity_type + entity_ids required' });
    }
    if (normalizedMode !== 'clear' && !String(note || '').trim()) {
      return res.status(400).json({ error: 'note required' });
    }

    const entry = normalizedMode === 'clear' ? '' : formatNoteEntry(note);
    const externalIds = ids.map(() => uuidv4());
    const result = await convexClient.mutation(api.entityNotes.appendMany, {
      externalIds,
      project_id: req.params.projectId,
      entity_type,
      entity_ids: ids,
      entity_id_kind,
      entry,
      mode: normalizedMode,
      updated_by: req.session?.userId ? String(req.session.userId) : undefined,
    });

    if (entity_type === 'ad' && entity_id_kind === 'cf') {
      for (const entityId of ids) {
        if (normalizedMode === 'append') {
          await appendDeploymentNote(entityId, entry);
        } else {
          await syncDeploymentNote(entityId, normalizedMode === 'clear' ? '' : entry);
        }
      }
    }

    res.json({ success: true, mode: normalizedMode, count: ids.length, changed: result?.changed || [] });
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

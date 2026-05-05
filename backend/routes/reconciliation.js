import { Router } from 'express';
import { randomUUID } from 'crypto';
import { requireAuth, requireRole } from '../auth.js';
import {
  getProjectRawForMeta,
  getAdSetsByProject,
  getAdSet,
  updateAdSet,
  createReconciliationLog,
  convexClient,
  api,
  getSetting,
} from '../convexClient.js';
import { getAdSetsWithInsights, getAdsWithInsights } from '../services/metaAnalytics.js';
import {
  MCPReadUnavailableError,
  getAdSetsWithInsightsViaMcp,
  getAdsWithInsightsViaMcp,
} from '../services/metaMcpRead.js';
import { MCPNotAuthorizedError } from '../services/metaMcp.js';

const router = Router();
router.use(requireAuth, requireRole('admin', 'manager'));

function actorName(user) {
  return user?.displayName || user?.username || 'Unknown user';
}

function normalizeArchiveEntries(body) {
  const raw = Array.isArray(body?.ad_sets)
    ? body.ad_sets
    : Array.isArray(body?.items)
      ? body.items
      : Array.isArray(body?.metaAdsetIds)
        ? body.metaAdsetIds.map((id) => ({ meta_adset_id: id }))
        : [];

  const entries = [];
  const seen = new Set();
  for (const item of raw) {
    const metaAdSetId = String(item?.meta_adset_id || item?.metaAdsetId || item?.id || '').trim();
    if (!metaAdSetId || seen.has(metaAdSetId)) continue;
    seen.add(metaAdSetId);
    const entry = {
      meta_adset_id: metaAdSetId,
      snapshot_json: JSON.stringify(item || { meta_adset_id: metaAdSetId }),
    };
    if (item?.name) entry.name = String(item.name);
    if (item?.campaign_name) entry.campaign_name = String(item.campaign_name);
    if (item?.status) entry.status = String(item.status);
    entries.push(entry);
  }
  return entries;
}

function normalizeMetaAdSetIds(body) {
  const raw = Array.isArray(body?.meta_adset_ids)
    ? body.meta_adset_ids
    : Array.isArray(body?.metaAdsetIds)
      ? body.metaAdsetIds
      : Array.isArray(body?.ad_sets)
        ? body.ad_sets.map((item) => item?.meta_adset_id || item?.metaAdsetId || item?.id)
        : [];
  return [...new Set(raw.map((id) => String(id || '').trim()).filter(Boolean))];
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

function sendReconciliationError(res, err) {
  if (err instanceof MCPReadUnavailableError || err instanceof MCPNotAuthorizedError || err.code === 'MCP_READ_UNAVAILABLE' || err.code === 'MCP_NOT_AUTHORIZED') {
    return res.status(err.status || 424).json({
      error: 'Meta MCP is connected, but this ad account does not expose the read tools Observation needs. Go to Project Settings → Meta and switch Analytics & Observation Read Path to API.',
      code: err.code || 'MCP_READ_UNAVAILABLE',
      details: err.message,
      action: 'SWITCH_READ_PATH_TO_API',
      settings_path: 'overview',
      settings_subtab: 'meta',
    });
  }
  return res.status(500).json({ error: err.message });
}

// GET /:projectId/reconciliation/unlinked-adsets
// Returns Meta ad sets that have no matching CF ad set (not linked).
router.get('/:projectId/reconciliation/unlinked-adsets', async (req, res) => {
  try {
    const { projectId } = req.params;
    const project = await getProjectRawForMeta(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!project.meta_access_token || !project.meta_account_id) {
      return res.status(400).json({ error: 'Project not connected to Meta' });
    }

    const readOpts = { datePreset: 'last_30d' };
    const [metaAdSets, cfAdSets] = await Promise.all([
      isMcpRead(project)
        ? getAdSetsWithInsightsViaMcp(await mcpReadArgs(project, readOpts, projectId))
        : getAdSetsWithInsights(project.meta_access_token, project.meta_account_id, readOpts),
      getAdSetsByProject(projectId),
    ]);
    const archivedRows = await convexClient.query(api.conductor.getArchivedUnlinkedAdSetsByProject, { projectId });

    const linkedMetaIds = new Set(
      cfAdSets.filter(a => a.meta_adset_id).map(a => a.meta_adset_id)
    );
    const archivedMetaIds = new Set((archivedRows || []).map((row) => row.meta_adset_id));

    const unlinked = metaAdSets
      .filter(m => !linkedMetaIds.has(m.id))
      .filter(m => !archivedMetaIds.has(m.id))
      .map(m => ({
        meta_adset_id: m.id,
        name: m.name,
        status: m.effective_status || m.status,
        campaign_name: m.campaign_name || '',
        created_time: m.created_time,
        daily_budget: m.daily_budget,
        lifetime_budget: m.lifetime_budget,
        impressions: m.impressions || '0',
        spend: m.spend || '0',
      }));

    res.json({ unlinked });
  } catch (err) {
    sendReconciliationError(res, err);
  }
});

// GET /:projectId/reconciliation/archived-unlinked-adsets
// Returns archived unlinked Meta ad sets hidden from the active reconciliation list.
router.get('/:projectId/reconciliation/archived-unlinked-adsets', async (req, res) => {
  try {
    const { projectId } = req.params;
    const project = await getProjectRawForMeta(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const archived = await convexClient.query(api.conductor.getArchivedUnlinkedAdSetsByProject, { projectId });
    res.json({ archived: archived || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /:projectId/reconciliation/archive-unlinked-adsets
// Body: { ad_sets: [{ meta_adset_id, name?, campaign_name?, status? }] }
router.post('/:projectId/reconciliation/archive-unlinked-adsets', async (req, res) => {
  try {
    const { projectId } = req.params;
    const project = await getProjectRawForMeta(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const entries = normalizeArchiveEntries(req.body);
    if (entries.length === 0) {
      return res.status(400).json({ error: 'At least one Meta ad set is required.' });
    }

    const archivedBy = actorName(req.user);
    const result = await convexClient.mutation(api.conductor.archiveUnlinkedAdSets, {
      projectId,
      archived_by: archivedBy,
      ad_sets: entries,
    });

    await Promise.all(entries.map((entry) => createReconciliationLog({
      externalId: randomUUID(),
      project_id: projectId,
      action: 'archive_unlinked_adset',
      cf_entity_id: entry.meta_adset_id,
      cf_entity_type: 'meta_ad_set',
      meta_entity_id: entry.meta_adset_id,
      linked_by: archivedBy,
      notes: entry.name || '',
      created_at: new Date().toISOString(),
    })));

    res.json({ success: true, archived: result?.archived || entries.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /:projectId/reconciliation/unarchive-unlinked-adsets
// Body: { meta_adset_ids: string[] }
router.post('/:projectId/reconciliation/unarchive-unlinked-adsets', async (req, res) => {
  try {
    const { projectId } = req.params;
    const project = await getProjectRawForMeta(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const metaAdSetIds = normalizeMetaAdSetIds(req.body);
    if (metaAdSetIds.length === 0) {
      return res.status(400).json({ error: 'At least one Meta ad set is required.' });
    }

    const unarchivedBy = actorName(req.user);
    const result = await convexClient.mutation(api.conductor.unarchiveUnlinkedAdSets, {
      projectId,
      unarchived_by: unarchivedBy,
      meta_adset_ids: metaAdSetIds,
    });

    await Promise.all(metaAdSetIds.map((metaAdSetId) => createReconciliationLog({
      externalId: randomUUID(),
      project_id: projectId,
      action: 'unarchive_unlinked_adset',
      cf_entity_id: metaAdSetId,
      cf_entity_type: 'meta_ad_set',
      meta_entity_id: metaAdSetId,
      linked_by: unarchivedBy,
      notes: '',
      created_at: new Date().toISOString(),
    })));

    res.json({ success: true, unarchived: result?.unarchived || 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /:projectId/reconciliation/unlinked-ads?metaAdsetId=XXX
// Returns Meta ads within a given Meta ad set that aren't linked to any CF ad.
router.get('/:projectId/reconciliation/unlinked-ads', async (req, res) => {
  try {
    const { projectId } = req.params;
    const { metaAdsetId } = req.query;
    if (!metaAdsetId) return res.status(400).json({ error: 'metaAdsetId query param required' });

    const project = await getProjectRawForMeta(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!project.meta_access_token || !project.meta_account_id) {
      return res.status(400).json({ error: 'Project not connected to Meta' });
    }

    const readOpts = {
      adsetId: metaAdsetId,
      datePreset: 'last_30d',
    };
    const metaAds = isMcpRead(project)
      ? await getAdsWithInsightsViaMcp(await mcpReadArgs(project, readOpts, projectId))
      : await getAdsWithInsights(project.meta_access_token, project.meta_account_id, readOpts);

    const cfAds = await convexClient.query(api.adCreatives.getByProject, { projectId });
    const linkedMetaAdIds = new Set(
      (cfAds || []).filter(a => a.meta_ad_id).map(a => a.meta_ad_id)
    );

    const unlinked = metaAds
      .filter(a => !linkedMetaAdIds.has(a.id))
      .map(a => ({
        meta_ad_id: a.id,
        name: a.name,
        status: a.effective_status || a.status,
        thumbnail_url: a.thumbnail_url || '',
        created_time: a.created_time,
        impressions: a.impressions || '0',
        spend: a.spend || '0',
      }));

    res.json({ unlinked });
  } catch (err) {
    sendReconciliationError(res, err);
  }
});

// POST /:projectId/reconciliation/link-adset
// Body: { cfAdSetId, metaAdsetId, metaCampaignId?, postedAt? }
router.post('/:projectId/reconciliation/link-adset', async (req, res) => {
  try {
    const { projectId } = req.params;
    const { cfAdSetId, metaAdsetId, metaCampaignId, postedAt } = req.body;
    if (!cfAdSetId || !metaAdsetId) {
      return res.status(400).json({ error: 'cfAdSetId and metaAdsetId are required' });
    }

    const adSet = await getAdSet(cfAdSetId);
    if (!adSet) return res.status(404).json({ error: 'CF ad set not found' });
    if (adSet.project_id !== projectId) {
      return res.status(400).json({ error: 'Ad set does not belong to this project' });
    }

    await updateAdSet(cfAdSetId, {
      meta_adset_id: metaAdsetId,
      meta_campaign_id: metaCampaignId || null,
      posted_at: postedAt || new Date().toISOString(),
      lifecycle_status: 'observing',
    });

    await createReconciliationLog({
      externalId: randomUUID(),
      project_id: projectId,
      action: 'link_adset',
      cf_entity_id: cfAdSetId,
      cf_entity_type: 'ad_set',
      meta_entity_id: metaAdsetId,
      linked_by: req.user.displayName || req.user.username,
      notes: metaCampaignId ? `campaign: ${metaCampaignId}` : '',
      created_at: new Date().toISOString(),
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /:projectId/reconciliation/link-ad
// Body: { cfAdId, metaAdId }
router.post('/:projectId/reconciliation/link-ad', async (req, res) => {
  try {
    const { projectId } = req.params;
    const { cfAdId, metaAdId } = req.body;
    if (!cfAdId || !metaAdId) {
      return res.status(400).json({ error: 'cfAdId and metaAdId are required' });
    }

    await convexClient.mutation(api.adCreatives.update, {
      externalId: cfAdId,
      meta_ad_id: metaAdId,
    });

    await createReconciliationLog({
      externalId: randomUUID(),
      project_id: projectId,
      action: 'link_ad',
      cf_entity_id: cfAdId,
      cf_entity_type: 'ad',
      meta_entity_id: metaAdId,
      linked_by: req.user.displayName || req.user.username,
      notes: '',
      created_at: new Date().toISOString(),
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

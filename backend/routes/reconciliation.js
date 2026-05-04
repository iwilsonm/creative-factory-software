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
} from '../convexClient.js';
import { getAdSetsWithInsights, getAdsWithInsights } from '../services/metaAnalytics.js';

const router = Router();
router.use(requireAuth, requireRole('admin', 'manager'));

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

    const [metaAdSets, cfAdSets] = await Promise.all([
      getAdSetsWithInsights(project.meta_access_token, project.meta_account_id, { datePreset: 'last_30d' }),
      getAdSetsByProject(projectId),
    ]);

    const linkedMetaIds = new Set(
      cfAdSets.filter(a => a.meta_adset_id).map(a => a.meta_adset_id)
    );

    const unlinked = metaAdSets
      .filter(m => !linkedMetaIds.has(m.id))
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

    const metaAds = await getAdsWithInsights(project.meta_access_token, project.meta_account_id, {
      adsetId: metaAdsetId,
      datePreset: 'last_30d',
    });

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
    res.status(500).json({ error: err.message });
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

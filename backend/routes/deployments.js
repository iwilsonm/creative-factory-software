import { Router } from 'express';
import crypto from 'crypto';
import { requireAuth, requireRole } from '../auth.js';
import {
  getAllDeployments,
  getDeploymentsByProject,
  createDeployment,
  createDeploymentDuplicate,
  updateDeployment,
  updateDeploymentStatus,
  deleteDeployment,
  getAd,
  getAllAds,
  getAdsByProject,
  getAdImageUrl,
  getProject,
  getLatestDoc,
  getCampaignsByProject,
  createCampaign,
  updateCampaign,
  deleteCampaign,
  getAdSetsByProject,
  getAdSetsByCampaign,
  createAdSet,
  updateAdSet,
  deleteAdSet,
  getFlexAdsByProject,
  getFlexAd,
  getAdSet,
  createFlexAd,
  updateFlexAd,
  deleteFlexAd,
  restoreDeployment,
  getDeletedDeployments,
  restoreFlexAd,
  convexClient,
  api,
} from '../convexClient.js';
import { chat as claudeChat } from '../services/anthropic.js';

const router = Router();
router.use(requireAuth);

/**
 * GET /deployments — List deployments with resolved ad + project data
 * Optional query param: ?projectId=xxx to filter by project
 */
router.get('/deployments', async (req, res) => {
  try {
    const { projectId } = req.query;
    const deployments = projectId
      ? await getDeploymentsByProject(projectId)
      : await getAllDeployments();

    // ── Batch-fetch ads and project data to avoid N+1 queries ──
    // When filtering by project, bulk-fetch all ads for that project at once
    // instead of making individual getAd + getAdImageUrl calls per deployment
    let adsMap = new Map();   // ad_id → { ad, imageUrl }
    let projectName = null;

    if (projectId && deployments.length > 0) {
      // Parallel fetch: project name + all ads for this project (2 queries instead of N+1)
      const [projectResult, adsResult] = await Promise.allSettled([
        getProject(projectId),
        getAdsByProject(projectId),
      ]);
      if (projectResult.status === 'fulfilled' && projectResult.value) {
        projectName = projectResult.value.name || null;
      }
      if (adsResult.status === 'fulfilled' && adsResult.value) {
        for (const ad of adsResult.value) {
          adsMap.set(ad.id, { ad, imageUrl: ad.resolvedImageUrl || null });
        }
      }
    }

    const enriched = await Promise.all(
      deployments.map(async (dep) => {
        let ad = null;
        let imageUrl = null;
        let depProjectName = projectName;

        // Try batch cache first, fall back to individual fetch
        const cached = adsMap.get(dep.ad_id);
        if (cached) {
          ad = cached.ad;
          imageUrl = cached.imageUrl;
        } else {
          // Fallback for ads not in the batch (e.g. cross-project or no projectId filter)
          try {
            ad = await getAd(dep.ad_id);
            if (ad?.storageId) {
              imageUrl = await getAdImageUrl(dep.ad_id);
            }
          } catch {}
        }

        if (!depProjectName) {
          try {
            const project = await getProject(dep.project_id);
            depProjectName = project?.name || null;
          } catch {}
        }

        return {
          ...dep,
          id: dep.externalId,
          ad: ad ? {
            angle: ad.angle,
            headline: ad.headline,
            body_copy: ad.body_copy,
            image_prompt: ad.image_prompt,
            aspect_ratio: ad.aspect_ratio,
            generation_mode: ad.generation_mode,
            tags: ad.tags || [],
          } : null,
          imageUrl,
          projectName: depProjectName,
          flex_ad_id: dep.flex_ad_id || null,
          primary_texts: dep.primary_texts || null,
          ad_headlines: dep.ad_headlines || null,
          destination_url: dep.destination_url || null,
          display_link: dep.display_link || null,
          cta_button: dep.cta_button || null,
          facebook_page: dep.facebook_page || null,
          posted_by: dep.posted_by || null,
          duplicate_adset_name: dep.duplicate_adset_name || null,
        };
      })
    );

    res.json({ deployments: enriched });
  } catch (err) {
    console.error('Failed to list deployments:', err);
    res.status(500).json({ error: 'Failed to list deployments' });
  }
});

/**
 * POST /deployments — Bulk create deployments from ad IDs
 * Body: { adIds: string[], projectId?: string }
 */
router.post('/deployments', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { adIds } = req.body;
    if (!Array.isArray(adIds) || adIds.length === 0) {
      return res.status(400).json({ error: 'adIds must be a non-empty array' });
    }

    const results = [];
    for (const adId of adIds) {
      // Look up the ad to get its project_id
      let ad;
      try {
        ad = await getAd(adId);
      } catch {
        results.push({ adId, success: false, error: 'Ad not found' });
        continue;
      }

      if (!ad) {
        results.push({ adId, success: false, error: 'Ad not found' });
        continue;
      }

      const id = crypto.randomUUID();
      const shortCode = adId.slice(0, 4).toUpperCase();
      const adName = ad.headline
        ? `${ad.headline} — ${shortCode}`
        : ad.angle
          ? `${ad.angle} — ${shortCode}`
          : `Ad ${shortCode}`;
      const result = await createDeployment({
        id,
        ad_id: adId,
        project_id: ad.project_id,
        status: 'selected',
        ad_name: adName,
        local_campaign_id: 'unplanned', // Go straight to Planner queue
      });

      // result is null if dedup guard caught it (already deployed)
      results.push({
        adId,
        success: true,
        deploymentId: result ? id : null,
        alreadyDeployed: !result,
      });
    }

    const created = results.filter(r => r.success && r.deploymentId).length;
    const skipped = results.filter(r => r.alreadyDeployed).length;

    res.json({ success: true, created, skipped, results });
  } catch (err) {
    console.error('Failed to create deployments:', err);
    res.status(500).json({ error: 'Failed to create deployments' });
  }
});

/**
 * GET /deployments/deleted — List soft-deleted deployments (for recovery)
 */
router.get('/deployments/deleted', async (req, res) => {
  try {
    const { projectId } = req.query;
    const deleted = await getDeletedDeployments(projectId);
    // Enrich with ad data + image URLs (same pattern as main GET /deployments)
    const enriched = await Promise.all(
      deleted.map(async (dep) => {
        let ad = null;
        let imageUrl = null;
        try {
          ad = await getAd(dep.ad_id);
          if (ad?.storageId) imageUrl = await getAdImageUrl(dep.ad_id);
        } catch { /* ignore */ }
        return {
          ...dep,
          ad: ad ? { angle: ad.angle, headline: ad.headline, body_copy: ad.body_copy, tags: ad.tags || [] } : null,
          imageUrl,
        };
      })
    );
    res.json({ deployments: enriched });
  } catch (err) {
    console.error('Failed to list deleted deployments:', err);
    res.status(500).json({ error: 'Failed to list deleted deployments' });
  }
});

/**
 * PUT /deployments/:id — Update deployment fields
 */
router.put('/deployments/:id', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { id } = req.params;
    const allowedFields = [
      'campaign_name', 'ad_set_name', 'ad_name',
      'landing_page_url', 'notes', 'planned_date', 'posted_date',
      'local_campaign_id', 'local_adset_id',
      'flex_ad_id', 'primary_texts', 'ad_headlines',
      'destination_url', 'display_link', 'cta_button', 'facebook_page', 'posted_by', 'duplicate_adset_name',
    ];

    const fields = {};
    for (const key of allowedFields) {
      if (req.body[key] !== undefined) {
        // Convex v.optional(v.string()) doesn't accept null — coerce to empty string
        fields[key] = req.body[key] === null ? '' : req.body[key];
      }
    }

    if (Object.keys(fields).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    await updateDeployment(id, fields);
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to update deployment:', err.message || err);
    console.error('Failed to update deployment — full body was:', JSON.stringify(req.body));
    res.status(500).json({ error: 'Failed to update deployment' });
  }
});

/**
 * PUT /deployments/:id/status — Update deployment status
 */
router.put('/deployments/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const validStatuses = ['selected', 'ready_to_post', 'posted', 'analyzing'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
    }

    await updateDeploymentStatus(id, status);
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to update deployment status:', err);
    res.status(500).json({ error: 'Failed to update deployment status' });
  }
});

/**
 * PUT /deployments/:id/posted-by — Set who posted this ad (poster-accessible)
 */
router.put('/deployments/:id/posted-by', async (req, res) => {
  try {
    const { posted_by } = req.body;
    await updateDeployment(req.params.id, { posted_by: posted_by || '' });
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to update posted_by:', err);
    res.status(500).json({ error: 'Failed to update posted_by' });
  }
});

/**
 * PUT /deployments/flex-ads/:id/posted-by — Set who posted this flex ad (poster-accessible)
 */
router.put('/deployments/flex-ads/:id/posted-by', async (req, res) => {
  try {
    const { posted_by } = req.body;
    await updateFlexAd(req.params.id, { posted_by: posted_by || '' });
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to update posted_by:', err);
    res.status(500).json({ error: 'Failed to update posted_by' });
  }
});

/**
 * DELETE /deployments/:id — Remove a deployment
 */
router.delete('/deployments/:id', requireRole('admin', 'manager'), async (req, res) => {
  try {
    await deleteDeployment(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to delete deployment:', err);
    res.status(500).json({ error: 'Failed to delete deployment' });
  }
});

/**
 * POST /deployments/:id/restore — Restore a soft-deleted deployment
 */
router.post('/deployments/:id/restore', requireRole('admin', 'manager'), async (req, res) => {
  try {
    await restoreDeployment(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to restore deployment:', err);
    res.status(500).json({ error: 'Failed to restore deployment' });
  }
});

/**
 * POST /deployments/rename-all — Rename all deployments to headline-based naming
 */
router.post('/deployments/rename-all', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const deployments = await getAllDeployments();
    let renamed = 0;
    for (const dep of deployments) {
      try {
        const ad = await getAd(dep.ad_id);
        if (!ad) continue;
        const shortCode = dep.ad_id.slice(0, 4).toUpperCase();
        const newName = ad.headline
          ? `${ad.headline} — ${shortCode}`
          : ad.angle
            ? `${ad.angle} — ${shortCode}`
            : `Ad ${shortCode}`;
        if (dep.ad_name !== newName) {
          await updateDeployment(dep.externalId, { ad_name: newName });
          renamed++;
        }
      } catch {}
    }
    res.json({ success: true, renamed, total: deployments.length });
  } catch (err) {
    console.error('Failed to rename deployments:', err);
    res.status(500).json({ error: 'Failed to rename deployments' });
  }
});

/**
 * POST /deployments/backfill-headlines — Extract headlines from existing ads that don't have one
 */
router.post('/deployments/backfill-headlines', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { extractHeadlineAndBody } = await import('../services/adGenerator.js');
    const ads = await getAllAds();
    let updated = 0;
    for (const ad of ads) {
      if (ad.headline || !ad.gpt_creative_output) continue;
      try {
        const { headline, body_copy } = await extractHeadlineAndBody(ad.gpt_creative_output);
        if (headline || body_copy) {
          const updates = { externalId: ad.externalId };
          if (headline) updates.headline = headline;
          if (body_copy) updates.body_copy = body_copy;
          await convexClient.mutation(api.adCreatives.update, updates);
          updated++;
        }
      } catch {}
    }
    res.json({ success: true, updated, total: ads.length });
  } catch (err) {
    console.error('Failed to backfill headlines:', err);
    res.status(500).json({ error: 'Failed to backfill headlines' });
  }
});

// =============================================
// Campaign & Ad Set CRUD (local organization)
// =============================================

/**
 * GET /deployments/campaigns?projectId=xxx — List campaigns for project
 */
router.get('/deployments/campaigns', async (req, res) => {
  try {
    const { projectId } = req.query;
    if (!projectId) return res.status(400).json({ error: 'projectId required' });
    const [campaigns, adSets] = await Promise.all([
      getCampaignsByProject(projectId),
      getAdSetsByProject(projectId),
    ]);
    res.json({ campaigns, adSets });
  } catch (err) {
    console.error('Failed to list campaigns:', err);
    res.status(500).json({ error: 'Failed to list campaigns' });
  }
});

/**
 * POST /deployments/campaigns — Create campaign
 * Body: { projectId, name }
 */
router.post('/deployments/campaigns', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { projectId, name } = req.body;
    if (!projectId || !name) return res.status(400).json({ error: 'projectId and name required' });
    const existing = await getCampaignsByProject(projectId);
    const id = crypto.randomUUID();
    await createCampaign({ id, project_id: projectId, name, sort_order: existing.length });
    res.json({ success: true, id });
  } catch (err) {
    console.error('Failed to create campaign:', err);
    res.status(500).json({ error: 'Failed to create campaign' });
  }
});

/**
 * PUT /deployments/campaigns/:id — Update campaign
 */
router.put('/deployments/campaigns/:id', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { id } = req.params;
    const allowed = ['name', 'sort_order'];
    const fields = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) fields[key] = req.body[key];
    }
    if (Object.keys(fields).length === 0) return res.status(400).json({ error: 'No valid fields' });
    await updateCampaign(id, fields);
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to update campaign:', err);
    res.status(500).json({ error: 'Failed to update campaign' });
  }
});

/**
 * DELETE /deployments/campaigns/:id — Delete campaign + cascade
 * Unassigns all deployments, deletes all ad sets, then deletes campaign
 */
router.delete('/deployments/campaigns/:id', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { id } = req.params;
    // Get all ad sets for this campaign
    const adSets = await getAdSetsByCampaign(id);
    // Get all deployments in this project and unassign those linked to this campaign
    // (We need to find deployments by checking local_campaign_id)
    const allDeps = await getAllDeployments();
    const linked = allDeps.filter(d => d.local_campaign_id === id || d.local_campaign_id === id);
    for (const dep of linked) {
      await updateDeployment(dep.externalId, { local_campaign_id: 'unplanned', local_adset_id: '', flex_ad_id: '' });
    }
    // Delete all ad sets
    for (const adSet of adSets) {
      await deleteAdSet(adSet.id);
    }
    // Delete the campaign
    await deleteCampaign(id);
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to delete campaign:', err);
    res.status(500).json({ error: 'Failed to delete campaign' });
  }
});

/**
 * POST /deployments/campaigns/:id/adsets — Create ad set in campaign
 * Body: { name, projectId }
 */
router.post('/deployments/campaigns/:campaignId/adsets', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { campaignId } = req.params;
    const { name, projectId } = req.body;
    if (!name || !projectId) return res.status(400).json({ error: 'name and projectId required' });
    const existing = await getAdSetsByCampaign(campaignId);
    const id = crypto.randomUUID();
    await createAdSet({ id, campaign_id: campaignId, project_id: projectId, name, sort_order: existing.length });
    res.json({ success: true, id });
  } catch (err) {
    console.error('Failed to create ad set:', err);
    res.status(500).json({ error: 'Failed to create ad set' });
  }
});

/**
 * PUT /deployments/adsets/:id — Update ad set
 */
router.put('/deployments/adsets/:id', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { id } = req.params;
    const allowed = ['name', 'sort_order', 'campaign_id'];
    const fields = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) fields[key] = req.body[key];
    }
    if (Object.keys(fields).length === 0) return res.status(400).json({ error: 'No valid fields' });
    await updateAdSet(id, fields);
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to update ad set:', err);
    res.status(500).json({ error: 'Failed to update ad set' });
  }
});

/**
 * DELETE /deployments/adsets/:id — Delete ad set, unassign deployments back to unplanned
 */
router.delete('/deployments/adsets/:id', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { id } = req.params;
    // Unassign all deployments in this ad set
    const allDeps = await getAllDeployments();
    const linked = allDeps.filter(d => d.local_adset_id === id);
    for (const dep of linked) {
      await updateDeployment(dep.externalId, { local_campaign_id: 'unplanned', local_adset_id: '', flex_ad_id: '' });
    }
    await deleteAdSet(id);
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to delete ad set:', err);
    res.status(500).json({ error: 'Failed to delete ad set' });
  }
});

/**
 * POST /deployments/move-to-unplanned — Move deployments to Campaigns (Unplanned section)
 * Body: { deploymentIds: string[] }
 */
router.post('/deployments/move-to-unplanned', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { deploymentIds } = req.body;
    if (!deploymentIds?.length) return res.status(400).json({ error: 'deploymentIds required' });
    const results = await Promise.allSettled(deploymentIds.map(id =>
      updateDeployment(id, { local_campaign_id: 'unplanned', local_adset_id: '', flex_ad_id: '' })
    ));
    // Retry any failures sequentially
    for (const [i, result] of results.entries()) {
      if (result.status === 'rejected') {
        try { await updateDeployment(deploymentIds[i], { local_campaign_id: 'unplanned', local_adset_id: '', flex_ad_id: '' }); } catch { /* logged below */ }
      }
    }
    res.json({ success: true, count: deploymentIds.length });
  } catch (err) {
    console.error('Failed to move to unplanned:', err);
    res.status(500).json({ error: 'Failed to move to unplanned' });
  }
});

/**
 * POST /deployments/assign-to-adset — Assign deployments to a campaign + ad set
 * Body: { deploymentIds: string[], campaignId: string, adsetId: string }
 */
router.post('/deployments/assign-to-adset', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { deploymentIds, campaignId, adsetId } = req.body;
    if (!deploymentIds?.length || !campaignId) {
      return res.status(400).json({ error: 'deploymentIds and campaignId required' });
    }
    // Use allSettled to avoid partial failure causing total rollback
    const results = await Promise.allSettled(deploymentIds.map(id =>
      updateDeployment(id, { local_campaign_id: campaignId, local_adset_id: adsetId })
    ));
    const failed = results.filter(r => r.status === 'rejected');
    if (failed.length > 0) {
      console.error(`Assign to ad set: ${failed.length}/${deploymentIds.length} failed`, failed[0].reason);
      // Retry failures once sequentially
      for (const [i, result] of results.entries()) {
        if (result.status === 'rejected') {
          try {
            await updateDeployment(deploymentIds[i], { local_campaign_id: campaignId, local_adset_id: adsetId });
          } catch (retryErr) {
            console.error(`Retry failed for ${deploymentIds[i]}:`, retryErr);
          }
        }
      }
    }
    res.json({ success: true, count: deploymentIds.length });
  } catch (err) {
    console.error('Failed to assign to ad set:', err);
    res.status(500).json({ error: 'Failed to assign to ad set' });
  }
});

/**
 * POST /deployments/unassign — Move deployments back to Unplanned
 * Body: { deploymentIds: string[] }
 */
router.post('/deployments/unassign', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { deploymentIds } = req.body;
    if (!deploymentIds?.length) return res.status(400).json({ error: 'deploymentIds required' });
    const results = await Promise.allSettled(deploymentIds.map(id =>
      updateDeployment(id, { local_campaign_id: 'unplanned', local_adset_id: '', flex_ad_id: '' })
    ));
    // Retry any failures sequentially
    for (const [i, result] of results.entries()) {
      if (result.status === 'rejected') {
        try { await updateDeployment(deploymentIds[i], { local_campaign_id: 'unplanned', local_adset_id: '', flex_ad_id: '' }); } catch { /* logged below */ }
      }
    }
    res.json({ success: true, count: deploymentIds.length });
  } catch (err) {
    console.error('Failed to unassign:', err);
    res.status(500).json({ error: 'Failed to unassign' });
  }
});

// =============================================
// Duplicate a deployment
// =============================================

/**
 * POST /deployments/:id/duplicate — Clone a deployment (same ad_id, same ad set)
 * Body (optional): { overrides?: { ad_name?, destination_url?, cta_button?, primary_texts?, ad_headlines?, planned_date? } }
 */
router.post('/deployments/:id/duplicate', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { id } = req.params;
    const { overrides } = req.body || {};
    // Look up source deployment
    const allDeps = await getAllDeployments();
    const source = allDeps.find(d => d.externalId === id);
    if (!source) return res.status(404).json({ error: 'Deployment not found' });

    // Look up the ad for naming
    let ad;
    try { ad = await getAd(source.ad_id); } catch {}

    const newId = crypto.randomUUID();
    const adName = overrides?.ad_name || (source.ad_name || ad?.headline || ad?.angle || 'Ad') + ' (Copy)';

    const dupFields = {
      id: newId,
      ad_id: source.ad_id,
      project_id: source.project_id,
      status: source.status || 'selected',
      ad_name: adName,
      local_campaign_id: source.local_campaign_id,
      local_adset_id: source.local_adset_id,
    };
    // Apply any additional overrides to the duplicate
    if (overrides?.destination_url !== undefined) dupFields.destination_url = overrides.destination_url;
    if (overrides?.cta_button !== undefined) dupFields.cta_button = overrides.cta_button;
    if (overrides?.primary_texts !== undefined) dupFields.primary_texts = overrides.primary_texts;
    if (overrides?.ad_headlines !== undefined) dupFields.ad_headlines = overrides.ad_headlines;
    if (overrides?.planned_date !== undefined) dupFields.planned_date = overrides.planned_date;

    await createDeploymentDuplicate(dupFields);

    res.json({ success: true, id: newId });
  } catch (err) {
    console.error('Failed to duplicate deployment:', err);
    res.status(500).json({ error: 'Failed to duplicate deployment' });
  }
});

// =============================================
// Flex Ad CRUD
// =============================================

/**
 * GET /deployments/flex-ads?projectId=xxx — List flex ads
 */
router.get('/deployments/flex-ads', async (req, res) => {
  try {
    const { projectId } = req.query;
    if (!projectId) return res.status(400).json({ error: 'projectId required' });
    const flexAds = await getFlexAdsByProject(projectId);
    res.json({ flexAds });
  } catch (err) {
    console.error('Failed to list flex ads:', err);
    res.status(500).json({ error: 'Failed to list flex ads' });
  }
});

/**
 * POST /deployments/flex-ads — Create flex ad
 * Body: { projectId, adSetId, name, deploymentIds: string[] }
 */
router.post('/deployments/flex-ads', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { projectId, adSetId, name, deploymentIds } = req.body;
    if (!projectId || !deploymentIds?.length) {
      return res.status(400).json({ error: 'projectId and deploymentIds required' });
    }
    if (deploymentIds.length > 10) {
      return res.status(400).json({ error: 'Maximum 10 ads per Flex ad' });
    }

    const id = crypto.randomUUID();
    const flexName = name || `Flex Ad (${deploymentIds.length} images)`;

    await createFlexAd({ id, project_id: projectId, ad_set_id: adSetId, name: flexName, child_deployment_ids: deploymentIds });

    // Update each child deployment with flex_ad_id
    await Promise.all(deploymentIds.map(depId =>
      updateDeployment(depId, { flex_ad_id: id })
    ));

    res.json({ success: true, id });
  } catch (err) {
    console.error('Failed to create flex ad:', err);
    res.status(500).json({ error: 'Failed to create flex ad' });
  }
});

/**
 * PUT /deployments/flex-ads/:id — Update flex ad fields
 */
router.put('/deployments/flex-ads/:id', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { id } = req.params;
    const allowed = ['name', 'child_deployment_ids', 'primary_texts', 'headlines', 'destination_url', 'display_link', 'cta_button', 'facebook_page', 'planned_date', 'posted_by', 'ad_set_id', 'duplicate_adset_name', 'notes', 'posting_day', 'angle_name'];
    const fields = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        // Convex v.optional(v.string()) doesn't accept null — coerce to empty string
        fields[key] = req.body[key] === null ? '' : req.body[key];
      }
    }
    if (Object.keys(fields).length === 0) return res.status(400).json({ error: 'No valid fields' });
    await updateFlexAd(id, fields);
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to update flex ad:', err.message || err);
    console.error('Failed to update flex ad — full body was:', JSON.stringify(req.body));
    res.status(500).json({ error: 'Failed to update flex ad' });
  }
});

/**
 * DELETE /deployments/flex-ads/:id — Delete flex ad (clears flex_ad_id from children)
 */
router.delete('/deployments/flex-ads/:id', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { id } = req.params;
    const flexAd = await getFlexAd(id);
    if (!flexAd) return res.status(404).json({ error: 'Flex ad not found' });

    // Clear flex_ad_id from all child deployments
    const childIds = JSON.parse(flexAd.child_deployment_ids || '[]');
    await Promise.all(childIds.map(depId =>
      updateDeployment(depId, { flex_ad_id: '' })
    ));

    await deleteFlexAd(id);
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to delete flex ad:', err);
    res.status(500).json({ error: 'Failed to delete flex ad' });
  }
});

/**
 * POST /deployments/flex-ads/:id/restore — Restore a soft-deleted flex ad
 */
router.post('/deployments/flex-ads/:id/restore', requireRole('admin', 'manager'), async (req, res) => {
  try {
    await restoreFlexAd(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to restore flex ad:', err);
    res.status(500).json({ error: 'Failed to restore flex ad' });
  }
});

// =============================================
// Dacia Creative Filter convenience endpoints
// =============================================

/**
 * POST /deployments/adsets — Create ad set (convenience for Dacia Creative Filter)
 * Body: { campaign_id, name, project_id }
 * Returns: { success: true, id, externalId }
 */
router.post('/deployments/adsets', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { campaign_id, name, project_id } = req.body;
    if (!campaign_id || !name || !project_id) {
      return res.status(400).json({ error: 'campaign_id, name, and project_id required' });
    }
    const existing = await getAdSetsByCampaign(campaign_id);
    const id = crypto.randomUUID();
    await createAdSet({ id, campaign_id, project_id, name, sort_order: existing.length });
    res.json({ success: true, id, externalId: id });
  } catch (err) {
    console.error('Failed to create ad set (filter):', err);
    res.status(500).json({ error: 'Failed to create ad set' });
  }
});

/**
 * POST /deployments/flex — Create flex ad with deployments (convenience for Dacia Creative Filter)
 * Body: { ad_set_id, name, headlines: [], primary_texts: [], cta, display_link, facebook_page, ad_ids: [], project_id, status }
 * Creates: flex ad + individual deployments for each ad_id, all linked to the flex ad
 * Status "ready" maps to "ready_to_post" in the deployment system
 */
router.post('/deployments/flex', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { ad_set_id, name, headlines, primary_texts, cta, display_link, facebook_page, ad_ids, project_id, status, posting_day, angle_name, destination_url, duplicate_adset_name, lp_primary_url, lp_secondary_url } = req.body;

    if (!ad_set_id || !project_id || !ad_ids?.length) {
      return res.status(400).json({ error: 'ad_set_id, project_id, and ad_ids required' });
    }

    // Look up the ad set to get its parent campaign
    let campaignId = 'unplanned';
    try {
      const adSet = await getAdSet(ad_set_id);
      if (adSet?.campaign_id) campaignId = adSet.campaign_id;
    } catch {}

    // Create individual deployments for each ad
    const deploymentIds = [];
    const depStatus = status === 'ready' ? 'ready_to_post' : (status || 'selected');
    const ptJson = JSON.stringify(primary_texts || []);
    const hlJson = JSON.stringify(headlines || []);

    for (const adId of ad_ids) {
      const depId = crypto.randomUUID();
      let ad;
      try { ad = await getAd(adId); } catch {}

      const shortCode = adId.slice(0, 4).toUpperCase();
      const adName = ad?.headline
        ? `${ad.headline} — ${shortCode}`
        : ad?.angle
          ? `${ad.angle} — ${shortCode}`
          : `Ad ${shortCode}`;

      await createDeploymentDuplicate({
        id: depId,
        ad_id: adId,
        project_id,
        status: depStatus,
        ad_name: adName,
        local_campaign_id: campaignId,
        local_adset_id: ad_set_id,
        primary_texts: ptJson,
        ad_headlines: hlJson,
        destination_url: destination_url || '',
        cta_button: cta || '',
      });

      // Set display_link, facebook_page, duplicate_adset_name via update
      const extraFields = {};
      if (display_link) extraFields.display_link = display_link;
      if (facebook_page) extraFields.facebook_page = facebook_page;
      if (duplicate_adset_name) extraFields.duplicate_adset_name = duplicate_adset_name;
      if (Object.keys(extraFields).length > 0) {
        await updateDeployment(depId, extraFields);
      }

      deploymentIds.push(depId);
    }

    // Create the flex ad grouping them
    const flexId = crypto.randomUUID();
    await createFlexAd({
      id: flexId,
      project_id,
      ad_set_id,
      name: name || `Filter Flex Ad (${ad_ids.length} images)`,
      child_deployment_ids: deploymentIds,
      primary_texts: primary_texts || [],
      headlines: headlines || [],
      destination_url: destination_url || '',
      display_link: display_link || '',
      cta_button: cta || '',
      facebook_page: facebook_page || '',
      duplicate_adset_name: duplicate_adset_name || '',
      posting_day: posting_day || '',
      angle_name: angle_name || '',
      lp_primary_url: lp_primary_url || '',
      lp_secondary_url: lp_secondary_url || '',
    });

    // Link each deployment to the flex ad
    for (const depId of deploymentIds) {
      await updateDeployment(depId, { flex_ad_id: flexId });
    }

    res.json({ success: true, flexAdId: flexId, deploymentIds });
  } catch (err) {
    console.error('Failed to create flex ad (filter):', err);
    res.status(500).json({ error: 'Failed to create flex ad' });
  }
});

/**
 * GET /deployments/flex-ads/count — Count non-deleted flex ads by project and optional angle
 * Query: projectId, angleName (optional)
 * Used by the Creative Filter to compute incrementing flex ad numbers per angle
 */
router.get('/deployments/flex-ads/count', requireAuth, async (req, res) => {
  try {
    const { projectId, angleName } = req.query;
    if (!projectId) return res.status(400).json({ error: 'projectId required' });

    const flexAds = await getFlexAdsByProject(projectId);
    if (angleName) {
      const filtered = flexAds.filter(f => f.angle_name === angleName);
      return res.json({ count: filtered.length });
    }
    res.json({ count: flexAds.length });
  } catch (err) {
    console.error('Failed to count flex ads:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /ads/:adId/tag — Add/set a tag on an ad creative (convenience for Dacia Creative Filter)
 * Body: { tag }
 * Appends the tag to existing tags (deduplicates)
 */
router.post('/ads/:adId/tag', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { adId } = req.params;
    const { tag } = req.body;
    if (!tag) return res.status(400).json({ error: 'tag required' });

    // Get current ad to read existing tags
    let ad;
    try { ad = await getAd(adId); } catch {}
    if (!ad) return res.status(404).json({ error: 'Ad not found' });

    const existing = ad.tags || [];
    const tagStr = String(tag).trim();
    const updated = existing.includes(tagStr) ? existing : [...existing, tagStr];

    await convexClient.mutation(api.adCreatives.update, {
      externalId: adId,
      tags: updated,
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Failed to tag ad:', err);
    res.status(500).json({ error: 'Failed to tag ad' });
  }
});

// =============================================
// AI Generation: Primary Text & Headlines
// =============================================

/**
 * POST /deployments/:id/generate-primary-text — AI-generate primary text
 * Body: { flexAdId?: string, direction?: string }
 */
router.post('/deployments/:id/generate-primary-text', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { id } = req.params;
    const { flexAdId, direction, messages: threadMessages } = req.body;

    // Get the deployment to find project_id
    const allDeps = await getAllDeployments();
    const dep = allDeps.find(d => d.externalId === id);
    if (!dep) return res.status(404).json({ error: 'Deployment not found' });

    const projectId = dep.project_id;
    const project = await getProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // Load foundational docs
    const [avatar, offer_brief, research, beliefs] = await Promise.all([
      getLatestDoc(projectId, 'avatar'),
      getLatestDoc(projectId, 'offer_brief'),
      getLatestDoc(projectId, 'research'),
      getLatestDoc(projectId, 'necessary_beliefs'),
    ]);

    const avatarSnippet = (avatar?.content || '').slice(0, 2000);
    const offerSnippet = (offer_brief?.content || '').slice(0, 1500);
    const researchSnippet = (research?.content || '').slice(0, 1500);
    const beliefsSnippet = (beliefs?.content || '').slice(0, 1000);

    if (!avatarSnippet && !offerSnippet) {
      return res.status(400).json({ error: 'Generate foundational docs first.' });
    }

    // Build creative context from ad(s)
    let creativeContext = '';
    if (flexAdId) {
      const flexAd = await getFlexAd(flexAdId);
      if (flexAd) {
        const childIds = JSON.parse(flexAd.child_deployment_ids || '[]');
        const childAds = [];
        for (const cid of childIds) {
          const childDep = allDeps.find(d => d.externalId === cid);
          if (childDep) {
            try {
              const ad = await getAd(childDep.ad_id);
              if (ad) childAds.push(ad);
            } catch {}
          }
        }
        creativeContext = childAds.map((ad, i) => `
IMAGE ${i + 1}:
Angle: ${ad.angle || 'N/A'}
Headline: ${ad.headline || 'N/A'}
Body Copy: ${ad.body_copy || 'N/A'}`).join('\n');
      }
    } else {
      try {
        const ad = await getAd(dep.ad_id);
        if (ad) {
          creativeContext = `
Angle: ${ad.angle || 'N/A'}
Headline: ${ad.headline || 'N/A'}
Body Copy: ${ad.body_copy || 'N/A'}
Image Prompt: ${(ad.image_prompt || '').slice(0, 500)}`;
        }
      } catch {}
    }

    // ── Build system prompt (context that stays the same across the conversation) ──
    const systemPrompt = `You are a world-class direct response copywriter writing Facebook ad primary text (the text that appears ABOVE the ad image).

BRAND: ${project.brand_name || project.name}
PRODUCT: ${project.product_description || ''}

AVATAR (excerpt):
${avatarSnippet}

OFFER BRIEF (excerpt):
${offerSnippet}

${researchSnippet ? `RESEARCH (excerpt):\n${researchSnippet}\n` : ''}
${beliefsSnippet ? `NECESSARY BELIEFS (excerpt):\n${beliefsSnippet}\n` : ''}

AD CREATIVE INFO:
${creativeContext}

Your task is to write 5 variations of Facebook ad primary text. Each MUST follow this structure:

FIRST LINE (HOOK): The very first line must be an attention-grabbing hook that stops the scroll. Use a bold claim, surprising fact, provocative question, or pattern interrupt. This line is the most important — if it doesn't grab attention, nothing else matters.

MIDDLE: 2-4 sentences that speak directly to the target audience's pain points and desires. Build curiosity and emotional connection. Sound conversational and natural, not like marketing copy.

LAST LINE (CTA): The final line must be a clear call to action that drives the click. Examples: "Tap the button to learn more.", "Click to see how it works.", "See what's possible →", "Find out how — tap the button." NEVER say "link below" or "tap the link" — always reference a button. Make it feel like the natural next step, not pushy.

Additional rules:
- ${flexAdId ? 'Work well with multiple creative images that rotate' : 'Align with the specific ad creative described above'}
- IMPORTANT: Split each variation into short, readable paragraphs. Each distinct thought or idea should be its own paragraph (separated by \\n\\n). Do NOT write dense blocks of text — break it up so it's easy to scan on mobile.

ALWAYS return ONLY a JSON object: { "primary_texts": ["text1", "text2", "text3", "text4", "text5"] }
Remember to use \\n\\n between paragraphs within each text variation.`;

    // ── Auto-detect and fetch URLs in the creative direction ──
    let fetchedPageContent = '';
    if (direction) {
      const urlRegex = /https?:\/\/[^\s"'<>]+/gi;
      const urls = direction.match(urlRegex);
      if (urls && urls.length > 0) {
        // Block private/internal IPs to prevent SSRF
        const blockedPatterns = [
          /^localhost$/i, /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./,
          /^192\.168\./, /^169\.254\./, /^0\./, /^\[?::1\]?$/, /^\[?fe80:/i, /^\[?fc00:/i, /^\[?fd/i,
        ];
        const safeUrls = urls.filter(u => {
          try { return !blockedPatterns.some(p => p.test(new URL(u).hostname)); } catch { return false; }
        });
        for (const url of safeUrls.slice(0, 2)) { // Limit to 2 URLs max
          try {
            const fetchModule = await import('node-fetch');
            const fetchFn = fetchModule.default;
            const response = await fetchFn(url, {
              headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' },
              timeout: 15000,
              redirect: 'follow',
            });
            if (response.ok) {
              const html = await response.text();
              // Extract text: strip script/style/tags, collapse whitespace
              const text = html
                .replace(/<script[\s\S]*?<\/script>/gi, '')
                .replace(/<style[\s\S]*?<\/style>/gi, '')
                .replace(/<nav[\s\S]*?<\/nav>/gi, '')
                .replace(/<footer[\s\S]*?<\/footer>/gi, '')
                .replace(/<header[\s\S]*?<\/header>/gi, '')
                .replace(/<[^>]+>/g, ' ')
                .replace(/&nbsp;/g, ' ')
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&#?\w+;/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 4000); // Cap at 4000 chars
              if (text.length > 100) {
                fetchedPageContent += `\n\n--- REFERENCED PAGE: ${url} ---\n${text}\n--- END PAGE ---`;
              }
            }
          } catch (e) {
            console.log(`[PrimaryText] Failed to fetch URL ${url}: ${e.message}`);
          }
        }
      }
    }

    // ── Build conversation messages ──
    // Thread-based: each refinement round builds on the previous conversation
    const conversationMessages = [{ role: 'system', content: systemPrompt }];

    // Build user direction with fetched page content if any
    const directionWithPages = direction
      ? (fetchedPageContent ? `${direction}\n${fetchedPageContent}` : direction)
      : '';

    if (threadMessages && threadMessages.length > 0) {
      // Continuation: replay previous user/assistant exchanges, then add new direction
      for (const msg of threadMessages) {
        conversationMessages.push({ role: msg.role, content: msg.content });
      }
      // New refinement instruction
      conversationMessages.push({
        role: 'user',
        content: `The advertiser wants refinements to the primary text variations you just wrote.

Their feedback: "${directionWithPages || 'Generate new variations with a different approach.'}"

Write 5 NEW refined variations that incorporate this feedback while keeping what worked from the previous versions. Return ONLY a JSON object: { "primary_texts": ["text1", "text2", "text3", "text4", "text5"] }`,
      });
    } else {
      // First generation — include creative direction in the initial user message
      conversationMessages.push({
        role: 'user',
        content: directionWithPages
          ? `Write 5 variations of Facebook ad primary text.\n\nCREATIVE DIRECTION FROM THE ADVERTISER — follow this closely:\n"${directionWithPages}"\n\nThis is the most important instruction. Shape every variation around this direction. If it specifies a hook angle, tone, length, or structure, follow it exactly.`
          : 'Write 5 variations of Facebook ad primary text based on the brand context and ad creative info provided.',
      });
    }

    const result = await claudeChat(conversationMessages, 'claude-sonnet-4-6', {
      max_tokens: 2048,
      operation: 'primary_text_generation',
      projectId,
    });

    // Parse JSON response
    let primaryTexts = [];
    try {
      const parsed = JSON.parse(result);
      primaryTexts = parsed.primary_texts || [];
    } catch {
      // Try to extract JSON from response
      const match = result.match(/\{[\s\S]*"primary_texts"[\s\S]*\}/);
      if (match) {
        try {
          const parsed = JSON.parse(match[0]);
          primaryTexts = parsed.primary_texts || [];
        } catch {}
      }
      if (primaryTexts.length === 0) {
        primaryTexts = [result.trim()];
      }
    }

    // Build updated thread history (exclude system message — only user/assistant turns)
    const updatedThread = threadMessages ? [...threadMessages] : [];
    // Add the user's direction from this round
    updatedThread.push({
      role: 'user',
      content: direction || '(initial generation)',
    });
    // Add Claude's response
    updatedThread.push({
      role: 'assistant',
      content: JSON.stringify({ primary_texts: primaryTexts }),
    });

    res.json({ primary_texts: primaryTexts, messages: updatedThread });
  } catch (err) {
    console.error('Failed to generate primary text:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /deployments/:id/generate-ad-headlines — AI-generate headlines from primary text
 * Body: { primaryTexts: string[], flexAdId?: string, direction?: string, messages?: array }
 */
router.post('/deployments/:id/generate-ad-headlines', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { id } = req.params;
    const { primaryTexts, flexAdId, direction, messages: threadMessages } = req.body;

    if (!primaryTexts?.length) {
      return res.status(400).json({ error: 'primaryTexts required' });
    }

    // Get the deployment to find project_id
    const allDeps = await getAllDeployments();
    const dep = allDeps.find(d => d.externalId === id);
    if (!dep) return res.status(404).json({ error: 'Deployment not found' });

    const projectId = dep.project_id;
    const project = await getProject(projectId);

    const [avatar, offer_brief] = await Promise.all([
      getLatestDoc(projectId, 'avatar'),
      getLatestDoc(projectId, 'offer_brief'),
    ]);

    const avatarSnippet = (avatar?.content || '').slice(0, 1500);
    const offerSnippet = (offer_brief?.content || '').slice(0, 1000);

    // ── Build system prompt (context that stays the same across the conversation) ──
    const systemPrompt = `You are a world-class direct response copywriter writing Facebook ad headlines (the short text that appears BELOW the ad image in the link preview area).

BRAND: ${project?.brand_name || project?.name || ''}

AVATAR (excerpt):
${avatarSnippet}

OFFER BRIEF (excerpt):
${offerSnippet}

PRIMARY TEXT VARIATIONS (what appears above the image):
${primaryTexts.map((t, i) => `${i + 1}. ${t}`).join('\n')}

Your task is to write 5 punchy headlines that:
- Are under 10 words each
- Align with and complement the primary text above
- Drive curiosity and clicks
- Sound natural, not salesy
- Each has a different angle or emphasis

ALWAYS return ONLY a JSON object: { "headlines": ["h1", "h2", "h3", "h4", "h5"] }`;

    // ── Build conversation messages ──
    const conversationMessages = [{ role: 'system', content: systemPrompt }];

    if (threadMessages && threadMessages.length > 0) {
      // Continuation: replay previous user/assistant exchanges, then add new direction
      for (const msg of threadMessages) {
        conversationMessages.push({ role: msg.role, content: msg.content });
      }
      conversationMessages.push({
        role: 'user',
        content: `The advertiser wants refinements to the headlines you just wrote.

Their feedback: "${direction || 'Generate new headlines with a different approach.'}"

Write 5 NEW refined headlines that incorporate this feedback while keeping what worked from the previous versions. Return ONLY a JSON object: { "headlines": ["h1", "h2", "h3", "h4", "h5"] }`,
      });
    } else {
      // First generation
      conversationMessages.push({
        role: 'user',
        content: direction
          ? `Write 5 punchy Facebook ad headlines.\n\nCREATIVE DIRECTION FROM THE ADVERTISER — follow this closely:\n"${direction}"\n\nShape every headline around this direction. Return ONLY a JSON object: { "headlines": ["h1", "h2", "h3", "h4", "h5"] }`
          : 'Write 5 punchy Facebook ad headlines based on the brand context and primary text provided. Return ONLY a JSON object: { "headlines": ["h1", "h2", "h3", "h4", "h5"] }',
      });
    }

    const result = await claudeChat(conversationMessages, 'claude-sonnet-4-6', {
      max_tokens: 1024,
      operation: 'ad_headline_generation_sidebar',
      projectId,
    });

    // Parse JSON response
    let headlines = [];
    try {
      const parsed = JSON.parse(result);
      headlines = parsed.headlines || [];
    } catch {
      const match = result.match(/\{[\s\S]*"headlines"[\s\S]*\}/);
      if (match) {
        try {
          const parsed = JSON.parse(match[0]);
          headlines = parsed.headlines || [];
        } catch {}
      }
      if (headlines.length === 0) {
        headlines = [result.trim()];
      }
    }

    // Build updated thread history
    const updatedThread = threadMessages ? [...threadMessages] : [];
    updatedThread.push({
      role: 'user',
      content: direction || '(initial generation)',
    });
    updatedThread.push({
      role: 'assistant',
      content: JSON.stringify({ headlines }),
    });

    res.json({ headlines, messages: updatedThread });
  } catch (err) {
    console.error('Failed to generate ad headlines:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Filter Copy Generation ─────────────────────────────────────────────────
// Used by the Creative Filter agent to generate Planner-quality primary text
// and headlines for flex ads. Uses the exact same prompts and model as the
// Planner's manual generation endpoints.
// ─────────────────────────────────────────────────────────────────────────────

router.post('/deployments/filter/generate-copy', async (req, res) => {
  try {
    const { project_id, angle_theme, ad_creatives } = req.body;

    if (!project_id) return res.status(400).json({ error: 'project_id required' });
    if (!angle_theme) return res.status(400).json({ error: 'angle_theme required' });

    const project = await getProject(project_id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // Load foundational docs (same as Planner)
    const [avatar, offer_brief, research, beliefs] = await Promise.all([
      getLatestDoc(project_id, 'avatar'),
      getLatestDoc(project_id, 'offer_brief'),
      getLatestDoc(project_id, 'research'),
      getLatestDoc(project_id, 'necessary_beliefs'),
    ]);

    const avatarSnippet = (avatar?.content || '').slice(0, 2000);
    const offerSnippet = (offer_brief?.content || '').slice(0, 1500);
    const researchSnippet = (research?.content || '').slice(0, 1500);
    const beliefsSnippet = (beliefs?.content || '').slice(0, 1000);

    if (!avatarSnippet && !offerSnippet) {
      return res.status(400).json({ error: 'Generate foundational docs first.' });
    }

    // Build creative context from ad creatives (same format as Planner flex ad context)
    let creativeContext = '';
    if (ad_creatives && ad_creatives.length > 0) {
      creativeContext = ad_creatives.map((ad, i) => `
IMAGE ${i + 1}:
Angle: ${ad.angle || 'N/A'}
Headline: ${ad.headline || 'N/A'}
Body Copy: ${ad.body_copy || 'N/A'}`).join('\n');
    }

    // ── Step 1: Generate Primary Texts (identical to Planner system prompt) ──
    const primaryTextSystemPrompt = `You are a world-class direct response copywriter writing Facebook ad primary text (the text that appears ABOVE the ad image).

BRAND: ${project.brand_name || project.name}
PRODUCT: ${project.product_description || ''}

AVATAR (excerpt):
${avatarSnippet}

OFFER BRIEF (excerpt):
${offerSnippet}

${researchSnippet ? `RESEARCH (excerpt):\n${researchSnippet}\n` : ''}
${beliefsSnippet ? `NECESSARY BELIEFS (excerpt):\n${beliefsSnippet}\n` : ''}

AD CREATIVE INFO:
${creativeContext}

ANGLE/THEME FOR THIS AD SET: ${angle_theme}

Your task is to write 5 variations of Facebook ad primary text. Each MUST follow this structure:

FIRST LINE (HOOK): The very first line must be an attention-grabbing hook that stops the scroll. Use a bold claim, surprising fact, provocative question, or pattern interrupt. This line is the most important — if it doesn't grab attention, nothing else matters.

MIDDLE: 2-4 sentences that speak directly to the target audience's pain points and desires. Build curiosity and emotional connection. Sound conversational and natural, not like marketing copy.

LAST LINE (CTA): The final line must be a clear call to action that drives the click. Examples: "Tap the button to learn more.", "Click to see how it works.", "See what's possible →", "Find out how — tap the button." NEVER say "link below" or "tap the link" — always reference a button. Make it feel like the natural next step, not pushy.

Additional rules:
- Work well with multiple creative images that rotate
- All 5 variations should speak to the angle/theme: ${angle_theme}
- IMPORTANT: Split each variation into short, readable paragraphs. Each distinct thought or idea should be its own paragraph (separated by \\n\\n). Do NOT write dense blocks of text — break it up so it's easy to scan on mobile.

ALWAYS return ONLY a JSON object: { "primary_texts": ["text1", "text2", "text3", "text4", "text5"] }
Remember to use \\n\\n between paragraphs within each text variation.`;

    const ptResult = await claudeChat(
      [
        { role: 'system', content: primaryTextSystemPrompt },
        { role: 'user', content: 'Write 5 variations of Facebook ad primary text based on the brand context and ad creative info provided. Focus on the angle/theme specified.' },
      ],
      'claude-sonnet-4-6',
      { max_tokens: 2048, operation: 'filter_primary_text_generation', projectId: project_id }
    );

    // Parse primary texts
    let primaryTexts = [];
    try {
      const parsed = JSON.parse(ptResult);
      primaryTexts = parsed.primary_texts || [];
    } catch {
      const match = ptResult.match(/\{[\s\S]*"primary_texts"[\s\S]*\}/);
      if (match) {
        try {
          const parsed = JSON.parse(match[0]);
          primaryTexts = parsed.primary_texts || [];
        } catch {}
      }
      if (primaryTexts.length === 0) {
        primaryTexts = [ptResult.trim()];
      }
    }

    // ── Step 2: Generate Headlines (identical to Planner headline system prompt) ──
    const headlineAvatarSnippet = (avatar?.content || '').slice(0, 1500);
    const headlineOfferSnippet = (offer_brief?.content || '').slice(0, 1000);

    const primaryTextList = primaryTexts.map((pt, i) => `${i + 1}. ${pt}`).join('\n');

    const headlineSystemPrompt = `You are a world-class direct response copywriter writing Facebook ad headlines (the short text that appears BELOW the ad image in the link preview area).

BRAND: ${project.brand_name || project.name}

AVATAR (excerpt):
${headlineAvatarSnippet}

OFFER BRIEF (excerpt):
${headlineOfferSnippet}

PRIMARY TEXT VARIATIONS (what appears above the image):
${primaryTextList}

ANGLE/THEME FOR THIS AD SET: ${angle_theme}

Your task is to write 5 punchy headlines that:
- Are under 10 words each
- Align with and complement the primary text above
- Drive curiosity and clicks
- Sound natural, not salesy
- Each has a different angle or emphasis
- All speak to the angle/theme: ${angle_theme}

ALWAYS return ONLY a JSON object: { "headlines": ["h1", "h2", "h3", "h4", "h5"] }`;

    const hlResult = await claudeChat(
      [
        { role: 'system', content: headlineSystemPrompt },
        { role: 'user', content: 'Write 5 punchy Facebook ad headlines based on the brand context and primary text provided. Return ONLY a JSON object: { "headlines": ["h1", "h2", "h3", "h4", "h5"] }' },
      ],
      'claude-sonnet-4-6',
      { max_tokens: 1024, operation: 'filter_headline_generation', projectId: project_id }
    );

    // Parse headlines
    let headlines = [];
    try {
      const parsed = JSON.parse(hlResult);
      headlines = parsed.headlines || [];
    } catch {
      const match = hlResult.match(/\{[\s\S]*"headlines"[\s\S]*\}/);
      if (match) {
        try {
          const parsed = JSON.parse(match[0]);
          headlines = parsed.headlines || [];
        } catch {}
      }
      if (headlines.length === 0) {
        headlines = [hlResult.trim()];
      }
    }

    console.log(`[FilterCopy] Generated ${primaryTexts.length} primary texts + ${headlines.length} headlines for ${project.name} (${angle_theme})`);

    res.json({ primary_texts: primaryTexts, headlines });
  } catch (err) {
    console.error('Failed to generate filter copy:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;

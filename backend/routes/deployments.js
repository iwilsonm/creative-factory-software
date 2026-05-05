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
  getAdSummariesByExternalIds,
  getProject,
  getLatestDoc,
  getDeploymentByExternalId,
  getCampaign,
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
  getAdImageUrl,
  convexClient,
  api,
} from '../convexClient.js';
import { chat as claudeChat } from '../services/anthropic.js';
import { listSafeFieldNames } from '../security.js';
import { fetchUrlText, safeUrlForLogs } from '../services/urlFetcher.js';
import { moveDeploymentsToPlanner } from '../services/adSetPlanner.js';
import { postDeploymentToMeta } from '../services/metaWriter.js';

const router = Router();
router.use(requireAuth);

function compactDeploymentAd(ad) {
  if (!ad) return null;
  return {
    angle: ad.angle || null,
    angle_name: ad.angle_name || null,
    headline: ad.headline || null,
    body_copy: ad.body_copy || null,
    tags: ad.tags || [],
  };
}

function buildDeploymentImageUrl(projectId, adId, hasImage) {
  return projectId && adId && hasImage ? `/api/deployments/ad-image/${projectId}/${adId}` : null;
}

function isAdminOrManager(req) {
  return req.user?.role === 'admin' || req.user?.role === 'manager';
}

function isPoster(req) {
  return req.user?.role === 'poster';
}

async function getDeploymentOr404(res, id) {
  const deployment = await getDeploymentByExternalId(id);
  if (!deployment || deployment.deleted_at) {
    res.status(404).json({ error: 'Deployment not found' });
    return null;
  }
  return deployment;
}

async function getCampaignOr404(res, id) {
  const campaign = await getCampaign(id);
  if (!campaign) {
    res.status(404).json({ error: 'Campaign not found' });
    return null;
  }
  return campaign;
}

async function getAdSetOr404(res, id) {
  const adSet = await getAdSet(id);
  if (!adSet) {
    res.status(404).json({ error: 'Ad set not found' });
    return null;
  }
  return adSet;
}

function sendPlannerMoveResult(res, result) {
  if (result.success) {
    return res.json({ success: true, count: result.count, projectId: result.projectId });
  }
  const { status = 500, success: _success, ...body } = result;
  return res.status(status).json(body);
}

function moveDeploymentsToPlannerResult(deploymentIds) {
  return moveDeploymentsToPlanner({
    deploymentIds,
    getDeploymentByExternalId,
    updateDeployment,
    logger: console,
  });
}

/**
 * GET /deployments — List deployments with resolved ad + project data
 * Optional query param: ?projectId=xxx to filter by project
 */
router.get('/deployments', async (req, res) => {
  try {
    const { projectId } = req.query;
    if (!projectId && !isAdminOrManager(req)) {
      return res.status(403).json({ error: 'projectId is required for this role.' });
    }
    const deployments = projectId
      ? await getDeploymentsByProject(projectId)
      : await getAllDeployments();

    const uniqueAdIds = [...new Set(deployments.map(d => d.ad_id).filter(Boolean))];
    const uniqueProjectIds = [...new Set(deployments.map(d => d.project_id).filter(Boolean))];

    const [adSummaries, projectResults] = await Promise.all([
      getAdSummariesByExternalIds(uniqueAdIds),
      Promise.all(uniqueProjectIds.map(pid => getProject(pid).catch(() => null))),
    ]);

    const adsMap = new Map(adSummaries.map(ad => [ad.id, ad]));
    const projectsMap = new Map(
      projectResults
        .filter(Boolean)
        .map(project => [project.id, project.name || null])
    );

    const enriched = await Promise.all(
      deployments.map(async (dep) => {
        let ad = adsMap.get(dep.ad_id) || null;
        if (!ad && dep.ad_id) {
          try {
            const fullAd = await getAd(dep.ad_id);
            if (fullAd) {
              ad = {
                id: fullAd.id,
                project_id: fullAd.project_id,
                angle: fullAd.angle,
                angle_name: fullAd.angle_name,
                headline: fullAd.headline,
                body_copy: fullAd.body_copy,
                tags: fullAd.tags || [],
                hasImage: !!fullAd.storageId,
              };
            }
          } catch {}
        }

        let depProjectName = projectsMap.get(dep.project_id) || null;
        if (!depProjectName && dep.project_id) {
          try {
            const project = await getProject(dep.project_id);
            depProjectName = project?.name || null;
          } catch {}
        }

        const imageUrl = buildDeploymentImageUrl(dep.project_id, dep.ad_id, ad?.hasImage);

        return {
          id: dep.externalId,
          externalId: dep.externalId,
          ad_id: dep.ad_id,
          project_id: dep.project_id,
          status: dep.status,
          ad_name: dep.ad_name || null,
          local_campaign_id: dep.local_campaign_id || null,
          local_adset_id: dep.local_adset_id || null,
          created_at: dep.created_at || null,
          notes: dep.notes || null,
          planned_date: dep.planned_date || null,
          posted_date: dep.posted_date || null,
          posted_by: dep.posted_by || null,
          posted_at: dep.posted_at || null,
          flex_ad_id: dep.flex_ad_id || null,
          primary_texts: dep.primary_texts || null,
          ad_headlines: dep.ad_headlines || null,
          destination_url: dep.destination_url || null,
          landing_page_url: dep.landing_page_url || null,
          display_link: dep.display_link || null,
          cta_button: dep.cta_button || null,
          facebook_page: dep.facebook_page || null,
          duplicate_adset_name: dep.duplicate_adset_name || null,
          campaign_name: dep.campaign_name || null,
          ad_set_name: dep.ad_set_name || null,
          meta_ad_id: dep.meta_ad_id || null,
          meta_post_error: dep.meta_post_error || null,
          ad: compactDeploymentAd(ad),
          imageUrl,
          projectName: depProjectName,
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
router.get('/deployments/deleted', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { projectId } = req.query;
    const deleted = await getDeletedDeployments(projectId);
    const adSummaries = await getAdSummariesByExternalIds(deleted.map(dep => dep.ad_id));
    const adsMap = new Map(adSummaries.map(ad => [ad.id, ad]));
    const enriched = deleted.map((dep) => {
      const ad = adsMap.get(dep.ad_id) || null;
      return {
        ...dep,
        ad: compactDeploymentAd(ad),
        imageUrl: buildDeploymentImageUrl(dep.project_id, dep.ad_id, ad?.hasImage),
      };
    });
    res.json({ deployments: enriched });
  } catch (err) {
    console.error('Failed to list deleted deployments:', err);
    res.status(500).json({ error: 'Failed to list deleted deployments' });
  }
});

/**
 * GET /deployments/ad-image/:projectId/:adId — Serve ad image (poster-accessible)
 */
router.get('/deployments/ad-image/:projectId/:adId', async (req, res) => {
  const url = await getAdImageUrl(req.params.adId);
  if (!url) return res.status(404).json({ error: 'Image file not found' });
  res.set('Cache-Control', 'public, max-age=3600');
  res.redirect(url);
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
    console.error('Failed to update deployment:', {
      id: req.params.id,
      fields: listSafeFieldNames(req.body, [
        'campaign_name', 'ad_set_name', 'ad_name',
        'landing_page_url', 'notes', 'planned_date', 'posted_date',
        'local_campaign_id', 'local_adset_id',
        'flex_ad_id', 'primary_texts', 'ad_headlines',
        'destination_url', 'display_link', 'cta_button', 'facebook_page', 'posted_by', 'duplicate_adset_name',
      ]),
      error: err.message || String(err),
    });
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

    const deployment = await getDeploymentOr404(res, id);
    if (!deployment) return;
    if (isPoster(req)) {
      if (deployment.status !== 'ready_to_post' || status !== 'posted') {
        return res.status(403).json({ error: 'Posters can only mark Ready to Post items as Posted.' });
      }
    } else if (!isAdminOrManager(req)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    await updateDeploymentStatus(id, status);
    if (status === 'posted') {
      await updateDeployment(id, { posted_by: req.user?.displayName || req.user?.username || '' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to update deployment status:', err);
    res.status(500).json({ error: 'Failed to update deployment status' });
  }
});

/**
 * POST /deployments/:id/post-to-meta — Create this Ready-to-Post ad in Meta,
 * then move it to Posted only after Meta confirms the ad was created.
 */
router.post('/deployments/:id/post-to-meta', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { projectId, ...options } = req.body || {};
    if (!projectId) {
      return res.status(400).json({ error: 'projectId required', code: 'PROJECT_REQUIRED' });
    }
    const result = await postDeploymentToMeta(req.params.id, projectId, options);
    res.json({ success: true, ...result });
  } catch (err) {
    const status = err.code === 'TOKEN_EXPIRED' ? 401
      : ['NO_PAGE', 'NO_ACCOUNT', 'NOT_CONNECTED', 'NO_ADS', 'NOT_READY', 'API_CONFIRMATION_REQUIRED', 'IMAGE_UPLOAD_FAILED'].includes(err.code) ? 400
      : err.code === 'WRONG_PROJECT' ? 403
      : err.code === 'MCP_NOT_AUTHORIZED' ? 403
      : err.code === 'NOT_FOUND' ? 404
      : 500;
    const message = err.code === 'MCP_NOT_AUTHORIZED'
      ? 'Meta did not authorize MCP for this selected ad account/app. Go to Project Settings → Meta and run Check MCP Access, or switch Posting Path if you intentionally want another path.'
      : err.message;
    res.status(status).json({
      error: message,
      code: err.code || null,
      stage: err.stage || null,
      details: err.details || null,
    });
  }
});

/**
 * PUT /deployments/:id/posted-by — Set who posted this ad (poster-accessible)
 */
router.put('/deployments/:id/posted-by', async (req, res) => {
  try {
    const deployment = await getDeploymentOr404(res, req.params.id);
    if (!deployment) return;
    if (isPoster(req) && deployment.status !== 'ready_to_post' && deployment.status !== 'posted') {
      return res.status(403).json({ error: 'Posters can only set attribution for posting workflow items.' });
    }
    if (!isPoster(req) && !isAdminOrManager(req)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    const postedBy = req.user?.displayName || req.user?.username || '';
    await updateDeployment(req.params.id, { posted_by: postedBy });
    res.json({ success: true, posted_by: postedBy });
  } catch (err) {
    console.error('Failed to update posted_by:', err);
    res.status(500).json({ error: 'Failed to update posted_by' });
  }
});

/**
 * Phase 6 — DEPRECATED. Flex ads are gone. posted_by is now a per-deployment
 * field (already on ad_deployments). This endpoint returns 410 Gone with a
 * pointer to the new pattern. Frontend migrated to PUT /deployments/:id with
 * { posted_by } in the body.
 */
router.put('/deployments/flex-ads/:id/posted-by', async (req, res) => {
  res.status(410).json({
    error: 'This old grouping endpoint is no longer available. Update the individual ad deployment instead.',
    code: 'FLEX_ADS_GONE',
  });
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
    if (!isAdminOrManager(req)) return res.status(403).json({ error: 'Insufficient permissions' });
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
    const campaign = await getCampaignOr404(res, id);
    if (!campaign) return;
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
    const campaign = await getCampaignOr404(res, id);
    if (!campaign) return;
    // Get all ad sets for this campaign
    const adSets = await getAdSetsByCampaign(id);
    // Get all deployments in this project and unassign those linked to this campaign
    // (We need to find deployments by checking local_campaign_id)
    const projectDeps = await getDeploymentsByProject(campaign.project_id);
    const linked = projectDeps.filter(d => d.local_campaign_id === id);
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
    const campaign = await getCampaignOr404(res, campaignId);
    if (!campaign) return;
    if (campaign.project_id !== projectId) {
      return res.status(400).json({ error: 'Campaign does not belong to this project.' });
    }
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
    const adSet = await getAdSetOr404(res, id);
    if (!adSet) return;
    const allowed = ['name', 'sort_order', 'campaign_id'];
    const fields = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) fields[key] = req.body[key];
    }
    if (fields.campaign_id) {
      const campaign = await getCampaignOr404(res, fields.campaign_id);
      if (!campaign) return;
      if (campaign.project_id !== adSet.project_id) {
        return res.status(400).json({ error: 'Target campaign does not belong to this project.' });
      }
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
    const adSet = await getAdSetOr404(res, id);
    if (!adSet) return;
    // Unassign all deployments in this ad set
    const projectDeps = await getDeploymentsByProject(adSet.project_id);
    const linked = projectDeps.filter(d => d.local_adset_id === id);
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
 * POST /deployments/move-to-planner — Move deployments into Planner
 * Body: { deploymentIds: string[] }
 */
router.post('/deployments/move-to-planner', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const result = await moveDeploymentsToPlannerResult(req.body?.deploymentIds);
    return sendPlannerMoveResult(res, result);
  } catch (err) {
    console.error('Failed to move to Planner:', err);
    res.status(500).json({ error: 'Failed to move ads to Planner' });
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
    if (campaignId === 'planned') {
      const result = await moveDeploymentsToPlannerResult(deploymentIds);
      return sendPlannerMoveResult(res, result);
    }
    const campaign = await getCampaignOr404(res, campaignId);
    if (!campaign) return;
    if (adsetId) {
      const adSet = await getAdSetOr404(res, adsetId);
      if (!adSet) return;
      if (adSet.project_id !== campaign.project_id || adSet.campaign_id !== campaignId) {
        return res.status(400).json({ error: 'Ad set does not belong to the selected campaign/project.' });
      }
    }
    for (const deploymentId of deploymentIds) {
      const deployment = await getDeploymentOr404(res, deploymentId);
      if (!deployment) return;
      if (deployment.project_id !== campaign.project_id) {
        return res.status(400).json({ error: 'All selected deployments must belong to the campaign project.' });
      }
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
 * Phase 6 — Flex ads removed (Meta retired the concept). All endpoints
 * return 410 Gone. Frontend uses POST /api/projects/:projectId/ad-sets
 * (in routes/adSets.js) to group deployments into ad_sets instead.
 */
const flexAdsGoneHandler = (req, res) => {
  res.status(410).json({
    error: 'This old grouping endpoint is no longer available. Use ad sets in the Ad Pipeline instead.',
    code: 'FLEX_ADS_GONE',
  });
};
router.get('/deployments/flex-ads', flexAdsGoneHandler);
router.post('/deployments/flex-ads', requireRole('admin', 'manager'), flexAdsGoneHandler);
router.put('/deployments/flex-ads/:id', requireRole('admin', 'manager'), flexAdsGoneHandler);
router.delete('/deployments/flex-ads/:id', requireRole('admin', 'manager'), flexAdsGoneHandler);
router.post('/deployments/flex-ads/:id/restore', requireRole('admin', 'manager'), flexAdsGoneHandler);

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
    const campaign = await getCampaignOr404(res, campaign_id);
    if (!campaign) return;
    if (campaign.project_id !== project_id) {
      return res.status(400).json({ error: 'Campaign does not belong to this project.' });
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
 * Phase 6 — DEPRECATED. /deployments/flex (the Filter shell-script convenience
 * endpoint) is gone. The new Filter (creativeFilterService.js) writes ad_sets
 * directly via the conductor pipeline. Returning 410 Gone for any external
 * caller still hitting this path.
 */
router.post('/deployments/flex', requireRole('admin', 'manager'), flexAdsGoneHandler);

/**
 * Phase 6 — DEPRECATED. Flex ad count endpoint. Returns 0 always (no flex ads
 * exist post-Phase 6). External callers should migrate to ad_set count.
 */
router.get('/deployments/flex-ads/count', requireAuth, async (req, res) => {
  // Always 0 post-Phase 6. Maintained as 200/0 (not 410) so legacy poller
  // scripts that compute "next flex ad number" don't crash; they'll just see 0.
  res.json({ count: 0 });
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

function clampCopyVariationCount(value, fallback = 5) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(5, Math.max(1, parsed));
}

function normalizeReplaceIndex(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * POST /deployments/:id/generate-primary-text — AI-generate primary text
 * Body: { flexAdId?: string, direction?: string, count?: number, replaceIndex?: number }
 */
router.post('/deployments/:id/generate-primary-text', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { id } = req.params;
    const { flexAdId, direction, messages: threadMessages, existingItems } = req.body;
    const replaceIndex = normalizeReplaceIndex(req.body?.replaceIndex);
    const variationCount = replaceIndex !== null ? 1 : clampCopyVariationCount(req.body?.count, 5);
    const variationLabel = variationCount === 1 ? '1 variation' : `${variationCount} variations`;

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

${Array.isArray(existingItems) && existingItems.length > 0 ? `EXISTING PRIMARY TEXT VARIATIONS:\n${existingItems.map((t, i) => `${i + 1}. ${String(t).slice(0, 700)}`).join('\n\n')}\n` : ''}

Your task is to write exactly ${variationLabel} of Facebook ad primary text. Each MUST follow this structure:

FIRST LINE (HOOK): The very first line must be an attention-grabbing hook that stops the scroll. Use a bold claim, surprising fact, provocative question, or pattern interrupt. This line is the most important — if it doesn't grab attention, nothing else matters.

MIDDLE: 2-4 sentences that speak directly to the target audience's pain points and desires. Build curiosity and emotional connection. Sound conversational and natural, not like marketing copy.

LAST LINE (CTA): The final line must be a clear call to action that drives the click. Examples: "Tap the button to learn more.", "Click to see how it works.", "See what's possible →", "Find out how — tap the button." NEVER say "link below" or "tap the link" — always reference a button. Make it feel like the natural next step, not pushy.

Additional rules:
- ${flexAdId ? 'Work well with multiple creative images that rotate' : 'Align with the specific ad creative described above'}
- IMPORTANT: Split each variation into short, readable paragraphs. Each distinct thought or idea should be its own paragraph (separated by \\n\\n). Do NOT write dense blocks of text — break it up so it's easy to scan on mobile.

${replaceIndex !== null ? `You are replacing variation #${replaceIndex + 1}. Make the replacement meaningfully different from the existing version while staying on strategy.` : ''}

ALWAYS return ONLY a JSON object: { "primary_texts": [${Array.from({ length: variationCount }, (_, i) => `"text${i + 1}"`).join(', ')}] }
Remember to use \\n\\n between paragraphs within each text variation.`;

    // ── Auto-detect and fetch URLs in the creative direction ──
    let fetchedPageContent = '';
    if (direction) {
      const urlRegex = /https?:\/\/[^\s"'<>]+/gi;
      const urls = direction.match(urlRegex);
      if (urls && urls.length > 0) {
        for (const url of urls.slice(0, 2)) { // Limit to 2 URLs max
          try {
            const result = await fetchUrlText(url, { maxBytes: 2_000_000, timeoutMs: 15_000 });
            const clipped = String(result.text || '').trim().slice(0, 4000);
            if (clipped.length > 100) {
              fetchedPageContent += `\n\n--- REFERENCED PAGE: ${safeUrlForLogs(url)} ---\n${clipped}\n--- END PAGE ---`;
            }
          } catch (e) {
            console.log(`[PrimaryText] Failed to fetch URL ${safeUrlForLogs(url)}: ${e.message}`);
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

Write exactly ${variationLabel} NEW refined ${variationCount === 1 ? 'variation' : 'variations'} that incorporate this feedback while keeping what worked from the previous versions. Return ONLY a JSON object: { "primary_texts": [${Array.from({ length: variationCount }, (_, i) => `"text${i + 1}"`).join(', ')}] }`,
      });
    } else {
      // First generation — include creative direction in the initial user message
      conversationMessages.push({
        role: 'user',
        content: directionWithPages
          ? `Write exactly ${variationLabel} of Facebook ad primary text.\n\nCREATIVE DIRECTION FROM THE ADVERTISER — follow this closely:\n"${directionWithPages}"\n\nThis is the most important instruction. Shape every variation around this direction. If it specifies a hook angle, tone, length, or structure, follow it exactly.`
          : `Write exactly ${variationLabel} of Facebook ad primary text based on the brand context and ad creative info provided.`,
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
    primaryTexts = primaryTexts.map(t => String(t || '').trim()).filter(Boolean).slice(0, variationCount);

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
 * Body: { primaryTexts: string[], flexAdId?: string, direction?: string, messages?: array, count?: number, replaceIndex?: number }
 */
router.post('/deployments/:id/generate-ad-headlines', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { id } = req.params;
    const { primaryTexts, flexAdId, direction, messages: threadMessages, existingItems } = req.body;
    const replaceIndex = normalizeReplaceIndex(req.body?.replaceIndex);
    const variationCount = replaceIndex !== null ? 1 : clampCopyVariationCount(req.body?.count, 5);
    const variationLabel = variationCount === 1 ? '1 punchy headline' : `${variationCount} punchy headlines`;

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

${Array.isArray(existingItems) && existingItems.length > 0 ? `EXISTING HEADLINES:\n${existingItems.map((h, i) => `${i + 1}. ${String(h).slice(0, 160)}`).join('\n')}\n` : ''}

Your task is to write exactly ${variationLabel} that:
- Are under 10 words each
- Align with and complement the primary text above
- Drive curiosity and clicks
- Sound natural, not salesy
- Each has a different angle or emphasis

${replaceIndex !== null ? `You are replacing headline #${replaceIndex + 1}. Make the replacement meaningfully different from the existing version while staying on strategy.` : ''}

ALWAYS return ONLY a JSON object: { "headlines": [${Array.from({ length: variationCount }, (_, i) => `"h${i + 1}"`).join(', ')}] }`;

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

Write exactly ${variationLabel} that incorporate this feedback while keeping what worked from the previous versions. Return ONLY a JSON object: { "headlines": [${Array.from({ length: variationCount }, (_, i) => `"h${i + 1}"`).join(', ')}] }`,
      });
    } else {
      // First generation
      conversationMessages.push({
        role: 'user',
        content: direction
          ? `Write exactly ${variationLabel} for Facebook ads.\n\nCREATIVE DIRECTION FROM THE ADVERTISER — follow this closely:\n"${direction}"\n\nShape every headline around this direction. Return ONLY a JSON object: { "headlines": [${Array.from({ length: variationCount }, (_, i) => `"h${i + 1}"`).join(', ')}] }`
          : `Write exactly ${variationLabel} based on the brand context and primary text provided. Return ONLY a JSON object: { "headlines": [${Array.from({ length: variationCount }, (_, i) => `"h${i + 1}"`).join(', ')}] }`,
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
    headlines = headlines.map(h => String(h || '').trim()).filter(Boolean).slice(0, variationCount);

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

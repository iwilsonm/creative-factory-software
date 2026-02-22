import { Router } from 'express';
import crypto from 'crypto';
import { requireAuth } from '../auth.js';
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
  createFlexAd,
  updateFlexAd,
  deleteFlexAd,
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

    // Resolve ad creative and project data for each deployment
    const enriched = await Promise.all(
      deployments.map(async (dep) => {
        let ad = null;
        let imageUrl = null;
        let projectName = null;

        try {
          ad = await getAd(dep.ad_id);
          if (ad?.storageId) {
            imageUrl = await getAdImageUrl(dep.ad_id);
          }
        } catch {}

        try {
          const project = await getProject(dep.project_id);
          projectName = project?.name || null;
        } catch {}

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
          projectName,
          flex_ad_id: dep.flex_ad_id || null,
          primary_texts: dep.primary_texts || null,
          ad_headlines: dep.ad_headlines || null,
          destination_url: dep.destination_url || null,
          cta_button: dep.cta_button || null,
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
router.post('/deployments', async (req, res) => {
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
 * PUT /deployments/:id — Update deployment fields
 */
router.put('/deployments/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const allowedFields = [
      'campaign_name', 'ad_set_name', 'ad_name',
      'landing_page_url', 'notes', 'planned_date', 'posted_date',
      'local_campaign_id', 'local_adset_id',
      'flex_ad_id', 'primary_texts', 'ad_headlines',
      'destination_url', 'cta_button',
    ];

    const fields = {};
    for (const key of allowedFields) {
      if (req.body[key] !== undefined) {
        fields[key] = req.body[key];
      }
    }

    if (Object.keys(fields).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    await updateDeployment(id, fields);
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to update deployment:', err);
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
 * DELETE /deployments/:id — Remove a deployment
 */
router.delete('/deployments/:id', async (req, res) => {
  try {
    await deleteDeployment(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to delete deployment:', err);
    res.status(500).json({ error: 'Failed to delete deployment' });
  }
});

/**
 * POST /deployments/rename-all — Rename all deployments to headline-based naming
 */
router.post('/deployments/rename-all', async (req, res) => {
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
router.post('/deployments/backfill-headlines', async (req, res) => {
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
    const campaigns = await getCampaignsByProject(projectId);
    const adSets = await getAdSetsByProject(projectId);
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
router.post('/deployments/campaigns', async (req, res) => {
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
router.put('/deployments/campaigns/:id', async (req, res) => {
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
router.delete('/deployments/campaigns/:id', async (req, res) => {
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
router.post('/deployments/campaigns/:campaignId/adsets', async (req, res) => {
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
router.put('/deployments/adsets/:id', async (req, res) => {
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
router.delete('/deployments/adsets/:id', async (req, res) => {
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
router.post('/deployments/move-to-unplanned', async (req, res) => {
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
router.post('/deployments/assign-to-adset', async (req, res) => {
  try {
    const { deploymentIds, campaignId, adsetId } = req.body;
    if (!deploymentIds?.length || !campaignId || !adsetId) {
      return res.status(400).json({ error: 'deploymentIds, campaignId, and adsetId required' });
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
router.post('/deployments/unassign', async (req, res) => {
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
router.post('/deployments/:id/duplicate', async (req, res) => {
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
router.post('/deployments/flex-ads', async (req, res) => {
  try {
    const { projectId, adSetId, name, deploymentIds } = req.body;
    if (!projectId || !adSetId || !deploymentIds?.length) {
      return res.status(400).json({ error: 'projectId, adSetId, and deploymentIds required' });
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
router.put('/deployments/flex-ads/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const allowed = ['name', 'child_deployment_ids', 'primary_texts', 'headlines', 'destination_url', 'cta_button', 'planned_date'];
    const fields = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) fields[key] = req.body[key];
    }
    if (Object.keys(fields).length === 0) return res.status(400).json({ error: 'No valid fields' });
    await updateFlexAd(id, fields);
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to update flex ad:', err);
    res.status(500).json({ error: 'Failed to update flex ad' });
  }
});

/**
 * DELETE /deployments/flex-ads/:id — Delete flex ad (clears flex_ad_id from children)
 */
router.delete('/deployments/flex-ads/:id', async (req, res) => {
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

// =============================================
// AI Generation: Primary Text & Headlines
// =============================================

/**
 * POST /deployments/:id/generate-primary-text — AI-generate primary text
 * Body: { flexAdId?: string, direction?: string }
 */
router.post('/deployments/:id/generate-primary-text', async (req, res) => {
  try {
    const { id } = req.params;
    const { flexAdId, direction } = req.body;

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

    const result = await claudeChat([{
      role: 'user',
      content: `You are a world-class direct response copywriter writing Facebook ad primary text (the text that appears ABOVE the ad image).

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

Write 5 variations of Facebook ad primary text. Each MUST follow this structure:

FIRST LINE (HOOK): The very first line must be an attention-grabbing hook that stops the scroll. Use a bold claim, surprising fact, provocative question, or pattern interrupt. This line is the most important — if it doesn't grab attention, nothing else matters.

MIDDLE: 2-4 sentences that speak directly to the target audience's pain points and desires. Build curiosity and emotional connection. Sound conversational and natural, not like marketing copy.

LAST LINE (CTA): The final line must be a clear call to action that drives the click. Examples: "Tap the button to learn more.", "Click to see how it works.", "See what's possible →", "Find out how — tap the button." NEVER say "link below" or "tap the link" — always reference a button. Make it feel like the natural next step, not pushy.

Additional rules:
- ${flexAdId ? 'Work well with multiple creative images that rotate' : 'Align with the specific ad creative described above'}
- IMPORTANT: Split each variation into short, readable paragraphs. Each distinct thought or idea should be its own paragraph (separated by \\n\\n). Do NOT write dense blocks of text — break it up so it's easy to scan on mobile.
${direction ? `\nCREATIVE DIRECTION FROM THE ADVERTISER — follow this closely:\n"${direction}"\n\nThis is the most important instruction. Shape every variation around this direction. If it specifies a hook angle, tone, length, or structure, follow it exactly.` : ''}

Return ONLY a JSON object: { "primary_texts": ["text1", "text2", "text3", "text4", "text5"] }
Remember to use \\n\\n between paragraphs within each text variation.`,
    }], 'claude-sonnet-4-6', {
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

    res.json({ primary_texts: primaryTexts });
  } catch (err) {
    console.error('Failed to generate primary text:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /deployments/:id/generate-ad-headlines — AI-generate headlines from primary text
 * Body: { primaryTexts: string[], flexAdId?: string }
 */
router.post('/deployments/:id/generate-ad-headlines', async (req, res) => {
  try {
    const { id } = req.params;
    const { primaryTexts, flexAdId } = req.body;

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

    const result = await claudeChat([{
      role: 'user',
      content: `You are a world-class direct response copywriter writing Facebook ad headlines (the short text that appears BELOW the ad image in the link preview area).

BRAND: ${project?.brand_name || project?.name || ''}

AVATAR (excerpt):
${avatarSnippet}

OFFER BRIEF (excerpt):
${offerSnippet}

PRIMARY TEXT VARIATIONS (what appears above the image):
${primaryTexts.map((t, i) => `${i + 1}. ${t}`).join('\n')}

Write 5 punchy headlines that:
- Are under 10 words each
- Align with and complement the primary text above
- Drive curiosity and clicks
- Sound natural, not salesy
- Each has a different angle or emphasis

Return ONLY a JSON object: { "headlines": ["h1", "h2", "h3", "h4", "h5"] }`,
    }], 'claude-sonnet-4-6', {
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

    res.json({ headlines });
  } catch (err) {
    console.error('Failed to generate ad headlines:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;

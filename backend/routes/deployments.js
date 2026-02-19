import { Router } from 'express';
import crypto from 'crypto';
import { requireAuth } from '../auth.js';
import {
  getAllDeployments,
  getDeploymentsByProject,
  createDeployment,
  updateDeployment,
  updateDeploymentStatus,
  deleteDeployment,
  getAd,
  getAdImageUrl,
  getProject,
} from '../convexClient.js';

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
            aspect_ratio: ad.aspect_ratio,
            generation_mode: ad.generation_mode,
            tags: ad.tags || [],
          } : null,
          imageUrl,
          projectName,
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
      const adName = [ad.angle, ad.headline].filter(Boolean).join(' — ') || `Ad ${adId.slice(0, 8)}`;
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

    const validStatuses = ['selected', 'scheduled', 'posted', 'analyzing'];
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

export default router;

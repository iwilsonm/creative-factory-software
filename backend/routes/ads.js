import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { getProject, getAdsByProject, getAd, getAdImageUrl, convexClient, api } from '../convexClient.js';
import { generateAd, generateAdMode2, regenerateImageOnly } from '../services/adGenerator.js';

const router = Router();
router.use(requireAuth);

// Generate an ad creative (SSE stream)
router.post('/:projectId/generate-ad', async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { mode = 'mode1', aspect_ratio, angle, inspiration_image_id, uploaded_image, uploaded_image_mime, product_image, product_image_mime, headline, body_copy, template_image_id } = req.body;

  if (mode !== 'mode1' && mode !== 'mode2') {
    return res.status(400).json({ error: 'Mode must be "mode1" or "mode2".' });
  }

  if (mode === 'mode2' && !template_image_id) {
    return res.status(400).json({ error: 'template_image_id is required for Mode 2 generation.' });
  }

  // Set up SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  const sendEvent = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    let ad;

    if (mode === 'mode2') {
      ad = await generateAdMode2(req.params.projectId, {
        templateImageId: template_image_id,
        angle,
        aspectRatio: aspect_ratio || '1:1',
        productImageBase64: product_image || undefined,
        productImageMimeType: product_image_mime || undefined,
        headline: headline || undefined,
        bodyCopy: body_copy || undefined,
        onEvent: sendEvent
      });
    } else {
      ad = await generateAd(req.params.projectId, {
        angle,
        aspectRatio: aspect_ratio || '1:1',
        inspirationImageId: inspiration_image_id,
        uploadedImageBase64: uploaded_image || undefined,
        uploadedImageMimeType: uploaded_image_mime || undefined,
        productImageBase64: product_image || undefined,
        productImageMimeType: product_image_mime || undefined,
        headline: headline || undefined,
        bodyCopy: body_copy || undefined,
        onEvent: sendEvent
      });
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    sendEvent({ type: 'error', error: err.message });
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

// Regenerate image only — skip GPT, use provided prompt (SSE stream)
router.post('/:projectId/regenerate-image', async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { image_prompt, aspect_ratio, parent_ad_id, product_image, product_image_mime, angle, headline, body_copy } = req.body;

  if (!image_prompt || !image_prompt.trim()) {
    return res.status(400).json({ error: 'image_prompt is required for image-only regeneration.' });
  }

  // Set up SSE
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  const sendEvent = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const ad = await regenerateImageOnly(req.params.projectId, {
      imagePrompt: image_prompt.trim(),
      aspectRatio: aspect_ratio || '1:1',
      parentAdId: parent_ad_id || undefined,
      productImageBase64: product_image || undefined,
      productImageMimeType: product_image_mime || undefined,
      angle: angle || undefined,
      headline: headline || undefined,
      bodyCopy: body_copy || undefined,
      onEvent: sendEvent
    });

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    sendEvent({ type: 'error', error: err.message });
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

// List all ads for a project
router.get('/:projectId/ads', async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const ads = await getAdsByProject(req.params.projectId);

  // Add image URLs — storageId means we use Convex redirect
  const withUrls = ads.map(ad => ({
    ...ad,
    imageUrl: ad.storageId ? `/api/projects/${req.params.projectId}/ads/${ad.id}/image` : null
  }));

  res.json({ ads: withUrls, total: withUrls.length });
});

// Get single ad
router.get('/:projectId/ads/:adId', async (req, res) => {
  const ad = await getAd(req.params.adId);
  if (!ad || ad.project_id !== req.params.projectId) {
    return res.status(404).json({ error: 'Ad not found' });
  }

  ad.imageUrl = ad.storageId ? `/api/projects/${req.params.projectId}/ads/${ad.id}/image` : null;
  res.json(ad);
});

// Serve ad image file (redirect to Convex storage URL)
router.get('/:projectId/ads/:adId/image', async (req, res) => {
  const url = await getAdImageUrl(req.params.adId);
  if (!url) {
    return res.status(404).json({ error: 'Image file not found' });
  }
  res.redirect(url);
});

// Delete an ad
router.delete('/:projectId/ads/:adId', async (req, res) => {
  const ad = await getAd(req.params.adId);
  if (!ad || ad.project_id !== req.params.projectId) {
    return res.status(404).json({ error: 'Ad not found' });
  }

  // Delete from Convex (also deletes storage file)
  await convexClient.mutation(api.adCreatives.remove, {
    externalId: req.params.adId,
  });

  res.json({ success: true, id: req.params.adId });
});

export default router;

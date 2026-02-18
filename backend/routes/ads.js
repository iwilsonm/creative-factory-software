import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { getProject, getAdsByProject, getInProgressAdsByProject, getAd, getAdImageUrl, downloadToBuffer, convexClient, api } from '../convexClient.js';
import { generateAd, generateAdMode2, regenerateImageOnly, applyPromptEdit } from '../services/adGenerator.js';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const THUMB_CACHE_DIR = path.join(__dirname, '..', '.thumb-cache');

// Ensure thumbnail cache directory exists
if (!fs.existsSync(THUMB_CACHE_DIR)) {
  fs.mkdirSync(THUMB_CACHE_DIR, { recursive: true });
}

const router = Router();
router.use(requireAuth);

/**
 * Load project-level product image as base64 if available.
 * Returns { base64, mimeType } or null.
 */
async function getProjectProductImage(project) {
  if (!project.product_image_storageId) return null;
  try {
    const buffer = await downloadToBuffer(project.product_image_storageId);
    return { base64: buffer.toString('base64'), mimeType: 'image/png' };
  } catch (err) {
    console.warn('[Ads] Could not load project product image:', err.message);
    return null;
  }
}

// Generate an ad creative (SSE stream)
router.post('/:projectId/generate-ad', async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  let { mode = 'mode1', aspect_ratio, angle, inspiration_image_id, uploaded_image, uploaded_image_mime, product_image, product_image_mime, headline, body_copy, template_image_id } = req.body;

  // Auto-inject project-level product image if none provided
  if (!product_image && project.product_image_storageId) {
    const projImg = await getProjectProductImage(project);
    if (projImg) {
      product_image = projImg.base64;
      product_image_mime = projImg.mimeType;
    }
  }

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

  let { image_prompt, aspect_ratio, parent_ad_id, product_image, product_image_mime, angle, headline, body_copy } = req.body;

  // Auto-inject project-level product image if none provided
  if (!product_image && project.product_image_storageId) {
    const projImg = await getProjectProductImage(project);
    if (projImg) {
      product_image = projImg.base64;
      product_image_mime = projImg.mimeType;
    }
  }

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

// Apply a natural-language edit to an existing image prompt (returns modified prompt, no image generation)
router.post('/:projectId/edit-prompt', async (req, res) => {
  const { original_prompt, edit_instruction, reference_image, reference_image_mime } = req.body;

  if (!original_prompt || !original_prompt.trim()) {
    return res.status(400).json({ error: 'original_prompt is required.' });
  }
  if (!edit_instruction || !edit_instruction.trim()) {
    return res.status(400).json({ error: 'edit_instruction is required.' });
  }

  try {
    const referenceImage = reference_image ? { base64: reference_image, mimeType: reference_image_mime || 'image/jpeg' } : null;
    const revisedPrompt = await applyPromptEdit(original_prompt.trim(), edit_instruction.trim(), referenceImage);
    res.json({ revised_prompt: revisedPrompt });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List all ads for a project
router.get('/:projectId/ads', async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const ads = await getAdsByProject(req.params.projectId);

  // Full-size URL: pre-resolved Convex CDN URL (direct), with redirect fallback
  // Thumbnail URL: resized 400px endpoint with disk cache
  const projectId = req.params.projectId;
  const withUrls = ads.map(ad => ({
    ...ad,
    imageUrl: ad.resolvedImageUrl
      || (ad.storageId ? `/api/projects/${projectId}/ads/${ad.id}/image` : null),
    thumbnailUrl: ad.storageId ? `/api/projects/${projectId}/ads/${ad.id}/thumbnail` : null
  }));

  res.json({ ads: withUrls, total: withUrls.length });
});

// Get in-progress ads for queue restoration
router.get('/:projectId/ads/in-progress', async (req, res) => {
  try {
    const ads = await getInProgressAdsByProject(req.params.projectId);
    res.json({ ads });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

// Serve ad image file (redirect to Convex storage URL — fallback for direct links)
router.get('/:projectId/ads/:adId/image', async (req, res) => {
  const url = await getAdImageUrl(req.params.adId);
  if (!url) {
    return res.status(404).json({ error: 'Image file not found' });
  }
  res.set('Cache-Control', 'public, max-age=3600');
  res.redirect(url);
});

// Serve resized thumbnail (~400px wide, JPEG 80%) with disk cache
router.get('/:projectId/ads/:adId/thumbnail', async (req, res) => {
  const adId = req.params.adId;
  const thumbPath = path.join(THUMB_CACHE_DIR, `${adId}.jpg`);

  // Serve from disk cache if available
  if (fs.existsSync(thumbPath)) {
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    return fs.createReadStream(thumbPath).pipe(res);
  }

  // Generate thumbnail: download original → resize → cache → serve
  try {
    const url = await getAdImageUrl(adId);
    if (!url) {
      return res.status(404).json({ error: 'Image not found' });
    }

    const imgRes = await fetch(url);
    if (!imgRes.ok) {
      return res.status(502).json({ error: 'Failed to fetch original image' });
    }

    const arrayBuffer = await imgRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const thumb = await sharp(buffer)
      .resize({ width: 400, withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();

    // Write to disk cache (fire-and-forget)
    fs.writeFile(thumbPath, thumb, () => {});

    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.end(thumb);
  } catch (err) {
    console.error(`[Thumbnail] Failed for ${adId}:`, err.message);
    // Fallback: redirect to full image
    try {
      const url = await getAdImageUrl(adId);
      if (url) return res.redirect(url);
    } catch {}
    res.status(500).json({ error: 'Thumbnail generation failed' });
  }
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

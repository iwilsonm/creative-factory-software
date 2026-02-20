import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { getProject, getLatestDoc, getAdsByProject, getInProgressAdsByProject, getAd, getAdImageUrl, downloadToBuffer, getQuoteBankQuote, convexClient, api } from '../convexClient.js';
import { generateAd, generateAdMode2, regenerateImageOnly, applyPromptEdit } from '../services/adGenerator.js';
import { generateBodyCopy } from '../services/bodyCopyGenerator.js';
import { chat as claudeChat } from '../services/anthropic.js';
import { withRetry } from '../services/retry.js';
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

  let { mode = 'mode1', aspect_ratio, angle, inspiration_image_id, uploaded_image, uploaded_image_mime, product_image, product_image_mime, headline, body_copy, template_image_id, headline_juicer, source_quote_id, skip_product_image } = req.body;

  // Auto-inject project-level product image if none provided (and not explicitly skipped)
  if (!product_image && !skip_product_image && project.product_image_storageId) {
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
        headlineJuicer: !!headline_juicer,
        sourceQuoteId: source_quote_id || undefined,
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
        headlineJuicer: !!headline_juicer,
        sourceQuoteId: source_quote_id || undefined,
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

  let { image_prompt, aspect_ratio, parent_ad_id, product_image, product_image_mime, angle, headline, body_copy, skip_product_image } = req.body;

  // Auto-inject project-level product image if none provided (and not explicitly skipped)
  if (!product_image && !skip_product_image && project.product_image_storageId) {
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

// Generate a random angle/topic from foundational docs
router.post('/:projectId/generate-angle', async (req, res) => {
  try {
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const [avatar, offer_brief] = await Promise.all([
      getLatestDoc(req.params.projectId, 'avatar'),
      getLatestDoc(req.params.projectId, 'offer_brief'),
    ]);

    const avatarSnippet = (avatar?.content || '').slice(0, 2000);
    const offerSnippet = (offer_brief?.content || '').slice(0, 2000);

    if (!avatarSnippet && !offerSnippet) {
      return res.status(400).json({ error: 'Generate foundational docs first.' });
    }

    const result = await claudeChat([{
      role: 'user',
      content: `You are a direct response ad strategist. Based on the brand and audience docs below, suggest ONE specific, unexpected ad angle/topic.

BRAND: ${project.brand_name || project.name}
PRODUCT: ${project.product_description || ''}

AVATAR (excerpt):
${avatarSnippet}

OFFER BRIEF (excerpt):
${offerSnippet}

Return ONLY a short angle phrase (3-10 words). No explanation, no quotes, no numbering. Just the angle.
Examples of good angles: "the 3am bathroom trip nobody talks about", "why your doctor never mentioned this", "what grandma knew that science just proved"`,
    }], 'claude-sonnet-4-6', { max_tokens: 100, operation: 'ad_angle_generation', projectId: req.params.projectId });

    const angle = result.trim().replace(/^["'"]+|["'"]+$/g, '');
    res.json({ angle });
  } catch (err) {
    console.error('Failed to generate angle:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Generate a headline from foundational docs + angle
router.post('/:projectId/generate-headline', async (req, res) => {
  try {
    const { angle } = req.body;
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const [avatar, offer_brief, research] = await Promise.all([
      getLatestDoc(req.params.projectId, 'avatar'),
      getLatestDoc(req.params.projectId, 'offer_brief'),
      getLatestDoc(req.params.projectId, 'research'),
    ]);

    const avatarSnippet = (avatar?.content || '').slice(0, 2000);
    const offerSnippet = (offer_brief?.content || '').slice(0, 1500);
    const researchSnippet = (research?.content || '').slice(0, 1500);

    if (!avatarSnippet && !offerSnippet) {
      return res.status(400).json({ error: 'Generate foundational docs first.' });
    }

    const result = await claudeChat([{
      role: 'user',
      content: `You are a world-class direct response copywriter who writes scroll-stopping Facebook ad headlines for health/wellness products targeting women 55-75.

BRAND: ${project.brand_name || project.name}
PRODUCT: ${project.product_description || ''}
${angle ? `AD ANGLE: "${angle}"` : ''}

AVATAR (excerpt):
${avatarSnippet}

OFFER BRIEF (excerpt):
${offerSnippet}

${researchSnippet ? `RESEARCH (excerpt):\n${researchSnippet}` : ''}

Write ONE scroll-stopping headline that:
- Sounds like something a real person would say, not marketing copy
- Is specific and emotional
- Speaks directly to the target audience
- ${angle ? `Focuses on the angle: "${angle}"` : 'Picks a compelling angle from the docs'}

Return ONLY the headline text. No quotes, no labels, no explanation. Under 15 words.`,
    }], 'claude-sonnet-4-6', { max_tokens: 150, operation: 'ad_headline_generation', projectId: req.params.projectId });

    const headline = result.trim().replace(/^["'"]+|["'"]+$/g, '');
    res.json({ headline });
  } catch (err) {
    console.error('Failed to generate headline:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Generate body copy for Ad Studio (standalone, without a specific quote bank entry)
router.post('/:projectId/generate-body-copy', async (req, res) => {
  try {
    const { headline, angle, style, source_quote_id } = req.body;
    if (!headline) {
      return res.status(400).json({ error: 'headline is required' });
    }

    let quote;
    if (source_quote_id) {
      // Load the source quote for emotional context
      quote = await getQuoteBankQuote(source_quote_id);
    }

    // If no source quote, construct a minimal quote-like object
    if (!quote) {
      quote = {
        quote: headline,
        emotion: 'persuasive',
        emotional_intensity: 'medium',
      };
    }

    const project = await getProject(req.params.projectId);
    const targetDemographic = project?.niche || '';
    const problem = angle || '';

    const bodyCopy = await generateBodyCopy(headline, quote, targetDemographic, problem, style || 'short');
    res.json({ body_copy: bodyCopy });
  } catch (err) {
    console.error('Failed to generate body copy:', err);
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

  // Resolve source quote text for ads linked to quote bank
  const quoteIds = [...new Set(ads.filter(a => a.source_quote_id).map(a => a.source_quote_id))];
  const quoteTexts = {};
  await Promise.all(quoteIds.map(async (qid) => {
    try {
      const q = await getQuoteBankQuote(qid);
      if (q) quoteTexts[qid] = q.quote;
    } catch { /* non-critical */ }
  }));

  const withUrls = ads.map(ad => ({
    ...ad,
    imageUrl: ad.resolvedImageUrl
      || (ad.storageId ? `/api/projects/${projectId}/ads/${ad.id}/image` : null),
    thumbnailUrl: ad.storageId ? `/api/projects/${projectId}/ads/${ad.id}/thumbnail` : null,
    source_quote_text: ad.source_quote_id ? (quoteTexts[ad.source_quote_id] || null) : null,
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

// Update tags on an ad
router.patch('/:projectId/ads/:adId/tags', async (req, res) => {
  try {
    const { tags } = req.body;
    if (!Array.isArray(tags)) return res.status(400).json({ error: 'tags must be an array of strings' });
    await convexClient.mutation(api.adCreatives.update, {
      externalId: req.params.adId,
      tags: tags.map(t => String(t).trim()).filter(Boolean),
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Toggle favorite on an ad
router.patch('/:projectId/ads/:adId/favorite', async (req, res) => {
  try {
    const { is_favorite } = req.body;
    await convexClient.mutation(api.adCreatives.update, {
      externalId: req.params.adId,
      is_favorite: !!is_favorite,
    });
    res.json({ success: true, is_favorite: !!is_favorite });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

    const buffer = await withRetry(async () => {
      const imgRes = await fetch(url);
      if (!imgRes.ok) {
        throw new Error(`Failed to fetch original image: ${imgRes.status}`);
      }
      const ab = await imgRes.arrayBuffer();
      return Buffer.from(ab);
    }, { maxRetries: 3, label: 'Thumbnail fetch' });

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

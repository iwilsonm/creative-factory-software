import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { requireAuth } from '../auth.js';
import { getProject, uploadBuffer, downloadToBuffer, getTemplateImageUrl, getAllTemplateImages, convexClient, api } from '../convexClient.js';
import { chatWithImage } from '../services/openai.js';

const router = Router();
router.use(requireAuth);

// Use os.tmpdir() for multer uploads — we read and upload to Convex, then delete
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${ext} not supported. Use JPG, PNG, WebP, or GIF.`));
    }
  }
});

// MIME type detection from extension
const EXT_TO_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

// List all template images for a project
router.get('/:projectId/templates', async (req, res) => {
  try {
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const templates = await getAllTemplateImages();

    // Add thumbnail URLs + analysis cache
    const withUrls = templates.map(t => ({
      id: t.externalId,
      project_id: t.project_id,
      filename: t.filename,
      description: t.description || '',
      analysis: t.analysis || null,
      created_at: t.created_at,
      thumbnailUrl: `/api/projects/${req.params.projectId}/templates/${t.externalId}/file`
    }));

    res.json({ templates: withUrls, total: withUrls.length });
  } catch (err) {
    console.error('[Templates] List error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Upload a new template image
router.post('/:projectId/templates', upload.single('image'), async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  if (!req.file) return res.status(400).json({ error: 'No image file provided' });

  try {
    const id = uuidv4();
    const ext = path.extname(req.file.originalname).toLowerCase();
    const mimeType = EXT_TO_MIME[ext] || 'application/octet-stream';

    // Read file into buffer and upload to Convex
    const buffer = fs.readFileSync(req.file.path);
    const storageId = await uploadBuffer(buffer, mimeType);

    // Clean up temp file
    fs.unlinkSync(req.file.path);

    const description = req.body.description || '';

    await convexClient.mutation(api.templateImages.create, {
      externalId: id,
      project_id: req.params.projectId,
      filename: req.file.originalname,
      storageId,
      description,
    });

    res.json({
      id,
      project_id: req.params.projectId,
      filename: req.file.originalname,
      description,
      thumbnailUrl: `/api/projects/${req.params.projectId}/templates/${id}/file`
    });
  } catch (err) {
    // Clean up file on error
    if (req.file?.path && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: `Upload failed: ${err.message}` });
  }
});

// Update template description
router.put('/:projectId/templates/:imageId', async (req, res) => {
  try {
    const template = await convexClient.query(api.templateImages.getByExternalId, {
      externalId: req.params.imageId,
    });
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    const { description } = req.body;
    if (description === undefined) return res.status(400).json({ error: 'Description is required' });

    await convexClient.mutation(api.templateImages.update, {
      externalId: req.params.imageId,
      description,
    });

    res.json({
      id: template.externalId,
      project_id: template.project_id,
      filename: template.filename,
      description,
      created_at: template.created_at,
      thumbnailUrl: `/api/projects/${req.params.projectId}/templates/${template.externalId}/file`
    });
  } catch (err) {
    console.error('[Templates] Update error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Delete a template image
router.delete('/:projectId/templates/:imageId', async (req, res) => {
  try {
    const template = await convexClient.query(api.templateImages.getByExternalId, {
      externalId: req.params.imageId,
    });
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    // Delete from Convex (also deletes storage file)
    await convexClient.mutation(api.templateImages.remove, {
      externalId: req.params.imageId,
    });

    res.json({ success: true, id: req.params.imageId });
  } catch (err) {
    console.error('[Templates] Delete error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Serve template image file (redirect to Convex storage URL)
router.get('/:projectId/templates/:imageId/file', async (req, res) => {
  try {
    const url = await getTemplateImageUrl(req.params.imageId);
    if (!url) {
      return res.status(404).json({ error: 'Image file not found' });
    }
    res.redirect(url);
  } catch (err) {
    console.error('[Templates] Serve file error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Analyze template image with GPT-4.1-mini vision ─────────────────────────
const TEMPLATE_ANALYSIS_SYSTEM = `You are analyzing an ad template image for a direct response advertising platform. Return a JSON object with exactly these fields:
- "recommended_style": one of "short", "bullets", "paragraph", or "story" — the body copy style that best fits this template's text layout
- "needs_product_image": boolean — true if the template has a prominent area for a product photo or product showcase, false if the template is text/graphic-only or already contains imagery that would conflict with a product overlay
- "layout_description": 1-2 sentences describing the layout (where text goes, how much space, visual hierarchy)
- "text_space": one of "minimal", "limited", "moderate", "generous" — how much room there is for body copy text
- "visual_tone": brief description of the mood/style (e.g., "bold, high-contrast", "elegant, minimal", "playful, colorful")

Return ONLY valid JSON. No markdown code fences, no explanation.`;

router.post('/:projectId/templates/:templateId/analyze', async (req, res) => {
  try {
    const { force } = req.body || {};

    const template = await convexClient.query(api.templateImages.getByExternalId, {
      externalId: req.params.templateId,
    });
    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    // Check cache (unless force re-analyze)
    if (template.analysis && !force) {
      try {
        return res.json({ analysis: JSON.parse(template.analysis), cached: true });
      } catch { /* parse failed, re-analyze */ }
    }

    if (!template.storageId) {
      return res.status(400).json({ error: 'Template has no stored image' });
    }

    // Download image from Convex storage
    const buffer = await downloadToBuffer(template.storageId);
    const base64 = buffer.toString('base64');

    // GPT-4.1-mini vision analysis
    const raw = await chatWithImage(
      [{ role: 'system', content: TEMPLATE_ANALYSIS_SYSTEM }],
      'Analyze this ad template image and return the JSON analysis.',
      base64,
      'image/jpeg',
      'gpt-4.1-mini',
      { operation: 'template_analysis', projectId: req.params.projectId }
    );

    // Parse response — strip markdown fences if present
    let analysis;
    try {
      const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
      analysis = JSON.parse(cleaned);
    } catch {
      // Fallback defaults
      analysis = {
        recommended_style: 'short',
        needs_product_image: true,
        layout_description: 'Could not parse template analysis',
        text_space: 'unknown',
        visual_tone: 'unknown',
      };
    }

    // Cache to DB
    await convexClient.mutation(api.templateImages.update, {
      externalId: req.params.templateId,
      analysis: JSON.stringify(analysis),
    });

    res.json({ analysis, cached: false });
  } catch (err) {
    console.error('Failed to analyze template:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;

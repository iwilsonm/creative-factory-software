import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { requireAuth, requireRole } from '../auth.js';
import { getProject, uploadBuffer, downloadToBuffer, getTemplateImageUrl, getTemplateImagesByProject, getStorageUrl, invalidateQueryCache, convexClient, api } from '../convexClient.js';
import { chatWithImage } from '../services/openai.js';
import { adoptSharedTemplatesIntoProject } from '../services/templateAdoption.js';

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

function normalizeTemplateTags(value) {
  const raw = Array.isArray(value)
    ? value
    : String(value || '').split(',');
  return [...new Set(raw
    .map(tag => String(tag || '').trim())
    .filter(Boolean)
    .slice(0, 20))]
    .map(tag => tag.slice(0, 40));
}

function templateResponse(req, template) {
  return {
    id: template.externalId,
    project_id: template.project_id,
    filename: template.filename,
    description: template.description || '',
    tags: Array.isArray(template.tags) ? template.tags : [],
    archived_at: template.archived_at || null,
    analysis: template.analysis || null,
    source_template_id: template.source_template_id || null,
    source_project_id: template.source_project_id || null,
    created_at: template.created_at,
    updated_at: template.updated_at || null,
    imageUrl: template.imageUrl || null,
    thumbnailUrl: template.imageUrl || `/api/projects/${req.params.projectId}/templates/${template.externalId}/file`
  };
}

// List all template images for a project
router.get('/:projectId/templates', async (req, res) => {
  try {
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const templates = await getTemplateImagesByProject(req.params.projectId);

    const includeArchived = req.query.include_archived === 'true';
    const visibleTemplates = templates
      .filter(t => includeArchived || !t.archived_at)
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));

    const withUrls = await Promise.all(visibleTemplates.map(async (template) => (
      templateResponse(req, {
        ...template,
        imageUrl: template.storageId ? await getStorageUrl(template.storageId).catch(() => null) : null,
      })
    )));

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
    const tags = normalizeTemplateTags(req.body.tags);

    await convexClient.mutation(api.templateImages.create, {
      externalId: id,
      project_id: req.params.projectId,
      filename: req.file.originalname,
      storageId,
      description,
      tags,
    });
    invalidateQueryCache('template_images');

    res.json({
      id,
      project_id: req.params.projectId,
      filename: req.file.originalname,
      description,
      tags,
      archived_at: null,
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

    const { description, tags, archived_at } = req.body;
    if (description === undefined && tags === undefined && archived_at === undefined) {
      return res.status(400).json({ error: 'Template update requires description, tags, or archive state.' });
    }

    const updates = {
      externalId: req.params.imageId,
    };
    if (description !== undefined) updates.description = description;
    if (tags !== undefined) updates.tags = normalizeTemplateTags(tags);
    if (archived_at !== undefined) updates.archived_at = archived_at || null;

    await convexClient.mutation(api.templateImages.update, updates);
    invalidateQueryCache('template_images');

    const updated = await convexClient.query(api.templateImages.getByExternalId, {
      externalId: req.params.imageId,
    });

    res.json(templateResponse(req, { ...updated, imageUrl: null }));
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
    invalidateQueryCache('template_images');

    res.json({ success: true, id: req.params.imageId });
  } catch (err) {
    console.error('[Templates] Delete error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/:projectId/templates/adopt-shared', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const result = await adoptSharedTemplatesIntoProject(req.params.projectId);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[Templates] Adopt shared error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to adopt shared templates' });
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

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { requireAuth } from '../auth.js';
import { getProject, uploadBuffer, getTemplateImageUrl, convexClient, api } from '../convexClient.js';

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
  const project = await getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const templates = await convexClient.query(api.templateImages.getByProject, {
    projectId: req.params.projectId,
  });

  // Add thumbnail URLs
  const withUrls = templates.map(t => ({
    id: t.externalId,
    project_id: t.project_id,
    filename: t.filename,
    description: t.description || '',
    created_at: t.created_at,
    thumbnailUrl: `/api/projects/${req.params.projectId}/templates/${t.externalId}/file`
  }));

  res.json({ templates: withUrls, total: withUrls.length });
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
  const template = await convexClient.query(api.templateImages.getByExternalId, {
    externalId: req.params.imageId,
  });
  if (!template || template.project_id !== req.params.projectId) {
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
});

// Delete a template image
router.delete('/:projectId/templates/:imageId', async (req, res) => {
  const template = await convexClient.query(api.templateImages.getByExternalId, {
    externalId: req.params.imageId,
  });
  if (!template || template.project_id !== req.params.projectId) {
    return res.status(404).json({ error: 'Template not found' });
  }

  // Delete from Convex (also deletes storage file)
  await convexClient.mutation(api.templateImages.remove, {
    externalId: req.params.imageId,
  });

  res.json({ success: true, id: req.params.imageId });
});

// Serve template image file (redirect to Convex storage URL)
router.get('/:projectId/templates/:imageId/file', async (req, res) => {
  const url = await getTemplateImageUrl(req.params.imageId);
  if (!url) {
    return res.status(404).json({ error: 'Image file not found' });
  }
  res.redirect(url);
});

export default router;

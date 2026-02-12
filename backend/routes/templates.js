import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { requireAuth } from '../auth.js';
import { getProject } from '../db.js';
import db from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = path.join(__dirname, '..', '..', 'data', 'templates');

// Ensure templates dir exists
if (!fs.existsSync(TEMPLATES_DIR)) fs.mkdirSync(TEMPLATES_DIR, { recursive: true });

const upload = multer({
  dest: TEMPLATES_DIR,
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

const router = Router();
router.use(requireAuth);

// List all template images for a project
router.get('/:projectId/templates', (req, res) => {
  const project = getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const templates = db.prepare(
    'SELECT * FROM template_images WHERE project_id = ? ORDER BY created_at DESC'
  ).all(req.params.projectId);

  // Add thumbnail URLs
  const withUrls = templates.map(t => ({
    ...t,
    thumbnailUrl: `/api/projects/${req.params.projectId}/templates/${t.id}/file`
  }));

  res.json({ templates: withUrls, total: withUrls.length });
});

// Upload a new template image
router.post('/:projectId/templates', upload.single('image'), (req, res) => {
  const project = getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  if (!req.file) return res.status(400).json({ error: 'No image file provided' });

  try {
    const id = uuidv4();
    const ext = path.extname(req.file.originalname).toLowerCase();
    const projectDir = path.join(TEMPLATES_DIR, req.params.projectId);
    fs.mkdirSync(projectDir, { recursive: true });

    const filename = `${id}${ext}`;
    const filePath = path.join(projectDir, filename);

    // Move uploaded file to project directory with proper name
    fs.renameSync(req.file.path, filePath);

    const description = req.body.description || '';

    db.prepare(`
      INSERT INTO template_images (id, project_id, filename, file_path, description)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, req.params.projectId, req.file.originalname, filePath, description);

    const template = db.prepare('SELECT * FROM template_images WHERE id = ?').get(id);
    res.json({
      ...template,
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
router.put('/:projectId/templates/:imageId', (req, res) => {
  const template = db.prepare(
    'SELECT * FROM template_images WHERE id = ? AND project_id = ?'
  ).get(req.params.imageId, req.params.projectId);
  if (!template) return res.status(404).json({ error: 'Template not found' });

  const { description } = req.body;
  if (description === undefined) return res.status(400).json({ error: 'Description is required' });

  db.prepare('UPDATE template_images SET description = ? WHERE id = ?').run(description, req.params.imageId);

  const updated = db.prepare('SELECT * FROM template_images WHERE id = ?').get(req.params.imageId);
  res.json({
    ...updated,
    thumbnailUrl: `/api/projects/${req.params.projectId}/templates/${updated.id}/file`
  });
});

// Delete a template image
router.delete('/:projectId/templates/:imageId', (req, res) => {
  const template = db.prepare(
    'SELECT * FROM template_images WHERE id = ? AND project_id = ?'
  ).get(req.params.imageId, req.params.projectId);
  if (!template) return res.status(404).json({ error: 'Template not found' });

  // Delete the file
  if (template.file_path && fs.existsSync(template.file_path)) {
    fs.unlinkSync(template.file_path);
  }

  // Delete from DB
  db.prepare('DELETE FROM template_images WHERE id = ?').run(req.params.imageId);

  res.json({ success: true, id: req.params.imageId });
});

// Serve template image file
router.get('/:projectId/templates/:imageId/file', (req, res) => {
  const template = db.prepare(
    'SELECT * FROM template_images WHERE id = ? AND project_id = ?'
  ).get(req.params.imageId, req.params.projectId);
  if (!template) return res.status(404).json({ error: 'Template not found' });

  if (!template.file_path || !fs.existsSync(template.file_path)) {
    return res.status(404).json({ error: 'Image file not found' });
  }

  res.sendFile(template.file_path);
});

export default router;

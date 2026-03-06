import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { requireAuth, requireRole } from '../auth.js';
import {
  createProject,
  getProject,
  getAllProjects,
  getAllProjectsWithStats,
  updateProject,
  deleteProject,
  getProjectStats,
  uploadBuffer,
  getStorageUrl,
  setProjectProductImage
} from '../convexClient.js';

const imgUpload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  }
});

const EXT_TO_MIME = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
};

const router = Router();
router.use(requireAuth);

// List all projects (single Convex query with embedded stats)
router.get('/', async (req, res) => {
  try {
    const projects = await getAllProjectsWithStats();
    res.json(projects);
  } catch (err) {
    console.error('[Projects] List error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get single project
router.get('/:id', async (req, res) => {
  try {
    const project = await getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    // Run stats + image URL in parallel (both depend on project existing)
    const [stats, productImageUrl] = await Promise.all([
      getProjectStats(project.id),
      project.product_image_storageId
        ? getStorageUrl(project.product_image_storageId).catch(() => null)
        : Promise.resolve(null),
    ]);

    res.json({ ...project, ...stats, productImageUrl });
  } catch (err) {
    console.error('[Projects] Get error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Create project
router.post('/', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { name, brand_name, niche, product_description, sales_page_content, drive_folder_id, inspiration_folder_id } = req.body;
    if (!name) return res.status(400).json({ error: 'Project name is required' });

    const id = uuidv4();
    await createProject({
      id,
      name,
      brand_name: brand_name || '',
      niche: niche || '',
      product_description: product_description || '',
      sales_page_content: sales_page_content || '',
      drive_folder_id: drive_folder_id || '',
      inspiration_folder_id: inspiration_folder_id || ''
    });

    const project = await getProject(id);
    res.status(201).json(project);
  } catch (err) {
    console.error('[Projects] Create error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Update project
router.put('/:id', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const project = await getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    await updateProject(req.params.id, req.body);
    const updated = await getProject(req.params.id);
    res.json(updated);
  } catch (err) {
    console.error('[Projects] Update error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Delete project
router.delete('/:id', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const project = await getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    await deleteProject(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error('[Projects] Delete error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Upload / replace project product image
router.post('/:id/product-image', requireRole('admin', 'manager'), imgUpload.single('image'), async (req, res) => {
  const project = await getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!req.file) return res.status(400).json({ error: 'No image file provided' });

  try {
    const ext = path.extname(req.file.originalname).toLowerCase();
    const mimeType = EXT_TO_MIME[ext] || 'application/octet-stream';

    const buffer = fs.readFileSync(req.file.path);
    const storageId = await uploadBuffer(buffer, mimeType);
    fs.unlinkSync(req.file.path);

    // This mutation also deletes the old image from storage
    await setProjectProductImage(req.params.id, storageId);

    const url = await getStorageUrl(storageId);
    res.json({ success: true, productImageUrl: url });
  } catch (err) {
    if (req.file?.path) try { fs.unlinkSync(req.file.path); } catch {}
    console.error('[Projects] Product image upload error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Delete project product image
router.delete('/:id/product-image', requireRole('admin', 'manager'), async (req, res) => {
  try {
    const project = await getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    if (!project.product_image_storageId) {
      return res.json({ success: true });
    }

    // Pass undefined to clear; mutation handles storage deletion
    await setProjectProductImage(req.params.id, undefined);
    res.json({ success: true });
  } catch (err) {
    console.error('[Projects] Product image delete error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;

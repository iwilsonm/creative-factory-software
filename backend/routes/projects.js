import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth } from '../auth.js';
import {
  createProject,
  getProject,
  getAllProjects,
  updateProject,
  deleteProject,
  getProjectStats
} from '../convexClient.js';

const router = Router();
router.use(requireAuth);

// List all projects
router.get('/', async (req, res) => {
  const projects = await getAllProjects();
  const projectsWithStats = [];
  for (const p of projects) {
    const stats = await getProjectStats(p.id);
    projectsWithStats.push({ ...p, ...stats });
  }
  res.json(projectsWithStats);
});

// Get single project
router.get('/:id', async (req, res) => {
  const project = await getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const stats = await getProjectStats(project.id);
  res.json({ ...project, ...stats });
});

// Create project
router.post('/', async (req, res) => {
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
});

// Update project
router.put('/:id', async (req, res) => {
  const project = await getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  await updateProject(req.params.id, req.body);
  const updated = await getProject(req.params.id);
  res.json(updated);
});

// Delete project
router.delete('/:id', async (req, res) => {
  const project = await getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  await deleteProject(req.params.id);
  res.json({ success: true });
});

export default router;

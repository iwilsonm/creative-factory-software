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
} from '../db.js';

const router = Router();
router.use(requireAuth);

// List all projects
router.get('/', (req, res) => {
  const projects = getAllProjects();
  const projectsWithStats = projects.map(p => ({
    ...p,
    ...getProjectStats(p.id)
  }));
  res.json(projectsWithStats);
});

// Get single project
router.get('/:id', (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  res.json({ ...project, ...getProjectStats(project.id) });
});

// Create project
router.post('/', (req, res) => {
  const { name, brand_name, niche, product_description, sales_page_content, drive_folder_id, inspiration_folder_id } = req.body;
  if (!name) return res.status(400).json({ error: 'Project name is required' });

  const id = uuidv4();
  createProject({
    id,
    name,
    brand_name: brand_name || '',
    niche: niche || '',
    product_description: product_description || '',
    sales_page_content: sales_page_content || '',
    drive_folder_id: drive_folder_id || '',
    inspiration_folder_id: inspiration_folder_id || ''
  });

  const project = getProject(id);
  res.status(201).json(project);
});

// Update project
router.put('/:id', (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  updateProject(req.params.id, req.body);
  const updated = getProject(req.params.id);
  res.json(updated);
});

// Delete project
router.delete('/:id', (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  deleteProject(req.params.id);
  res.json({ success: true });
});

export default router;

import { Router } from 'express';
import { requireAuth, requireRole } from '../auth.js';
import { getProject, getLPTemplatesByProject, getLPTemplate, updateLPTemplate, deleteLPTemplate } from '../convexClient.js';
import { extractTemplate } from '../services/lpTemplateExtractor.js';
import { createSSEStream } from '../utils/sseHelper.js';

const router = Router();
router.use(requireAuth);
router.use(requireRole('admin', 'manager'));

// ─── List all templates for a project ─────────────────────────────────────────
router.get('/:projectId/lp-templates', async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const templates = await getLPTemplatesByProject(req.params.projectId);
  // Sort newest first
  templates.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json({ templates });
});

// ─── Get single template ──────────────────────────────────────────────────────
router.get('/:projectId/lp-templates/:templateId', async (req, res) => {
  const template = await getLPTemplate(req.params.templateId);
  if (!template || template.project_id !== req.params.projectId) {
    return res.status(404).json({ error: 'Template not found' });
  }
  res.json(template);
});

// ─── Extract template from URL (SSE stream for progress) ─────────────────────
router.post('/:projectId/lp-templates', async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { url } = req.body;
  if (!url || !url.trim()) {
    return res.status(400).json({ error: 'URL is required' });
  }

  const sse = createSSEStream(req, res);
  sse.sendEvent({ type: 'started', message: 'Starting template extraction...' });

  (async () => {
    try {
      const result = await extractTemplate(url.trim(), req.params.projectId, sse.sendEvent);
      sse.sendEvent({
        type: 'completed',
        templateId: result.templateId,
        name: result.name,
        status: result.status,
      });
      sse.end();
    } catch (err) {
      console.error('[LPTemplate] Extraction error:', err.message);
      sse.sendEvent({ type: 'error', message: err.message });
      sse.end();
    }
  })();
});

// ─── Update template (name, status) ──────────────────────────────────────────
router.put('/:projectId/lp-templates/:templateId', async (req, res) => {
  const template = await getLPTemplate(req.params.templateId);
  if (!template || template.project_id !== req.params.projectId) {
    return res.status(404).json({ error: 'Template not found' });
  }

  const updates = {};
  if (req.body.name !== undefined) updates.name = req.body.name;
  if (req.body.status !== undefined) updates.status = req.body.status;

  await updateLPTemplate(req.params.templateId, updates);
  const updated = await getLPTemplate(req.params.templateId);
  res.json(updated);
});

// ─── Delete template ─────────────────────────────────────────────────────────
router.delete('/:projectId/lp-templates/:templateId', async (req, res) => {
  const template = await getLPTemplate(req.params.templateId);
  if (!template || template.project_id !== req.params.projectId) {
    return res.status(404).json({ error: 'Template not found' });
  }

  await deleteLPTemplate(req.params.templateId);
  res.json({ success: true });
});

export default router;

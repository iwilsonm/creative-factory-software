import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  getProject,
  getSalesPagesByProject,
  getSalesPage,
  createSalesPage,
  updateSalesPage,
  deleteSalesPage,
  getSalesPageVersions,
  getDocsByProject,
} from '../convexClient.js';
import { generateSalesPage } from '../services/spGenerator.js';
import { publishSalesPage, unpublishSalesPage } from '../services/spPublisher.js';
import { renderSalesPageHtml } from '../services/spPreviewRenderer.js';
import { createSSEStream } from '../utils/sseHelper.js';

const router = Router();

// List all sales pages for a project
router.get('/:projectId/sales-pages', async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const pages = await getSalesPagesByProject(req.params.projectId);
  pages.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  res.json({ pages });
});

// Get a single sales page
router.get('/:projectId/sales-pages/:pageId', async (req, res) => {
  const page = await getSalesPage(req.params.pageId);
  if (!page) return res.status(404).json({ error: 'Sales page not found' });

  res.json({ page });
});

// Generate a sales page (SSE stream)
router.post('/:projectId/generate-sales-page', async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { product_brief } = req.body;
  if (!product_brief || !product_brief.name) {
    return res.status(400).json({ error: 'Product brief with name is required' });
  }

  // Verify foundational docs exist
  const docs = await getDocsByProject(req.params.projectId);
  if (!docs || docs.length === 0) {
    return res.status(400).json({ error: 'Foundational docs not yet generated for this project. Generate docs first.' });
  }

  // Create the sales page record
  const pageId = uuidv4();
  const pageName = product_brief.name || 'Sales Page';
  await createSalesPage({
    id: pageId,
    project_id: req.params.projectId,
    name: pageName,
    status: 'generating',
    product_brief: JSON.stringify(product_brief),
  });

  // Set up SSE stream
  const sse = createSSEStream(req, res);

  // Run generation in background
  generateSalesPage(
    {
      projectId: req.params.projectId,
      productBrief: product_brief,
      pageId,
    },
    sse.sendEvent
  )
    .then(() => {
      sse.end();
    })
    .catch((err) => {
      console.error('[Sales Page] Generation error:', err.message);
      sse.sendEvent({ type: 'error', message: err.message, error: err.message });
      sse.end();
    });
});

// HTML preview of a sales page
router.get('/:projectId/sales-pages/:pageId/preview', async (req, res) => {
  const page = await getSalesPage(req.params.pageId);
  if (!page) return res.status(404).send('<h1>Sales page not found</h1>');
  if (!page.section_data) return res.status(400).send('<h1>No content generated yet</h1>');

  const sectionData = JSON.parse(page.section_data);
  const html = renderSalesPageHtml({ ...page, section_data: sectionData });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// Update a sales page
router.put('/:projectId/sales-pages/:pageId', async (req, res) => {
  const page = await getSalesPage(req.params.pageId);
  if (!page) return res.status(404).json({ error: 'Sales page not found' });

  await updateSalesPage(req.params.pageId, req.body);
  res.json({ success: true });
});

// Delete a sales page
router.delete('/:projectId/sales-pages/:pageId', async (req, res) => {
  const page = await getSalesPage(req.params.pageId);
  if (!page) return res.status(404).json({ error: 'Sales page not found' });

  await deleteSalesPage(req.params.pageId);
  res.json({ success: true });
});

// Publish a sales page to Shopify
router.post('/:projectId/sales-pages/:pageId/publish', async (req, res) => {
  const page = await getSalesPage(req.params.pageId);
  if (!page) return res.status(404).json({ error: 'Sales page not found' });

  if (page.status !== 'completed' && page.status !== 'unpublished') {
    return res.status(400).json({ error: `Cannot publish page with status "${page.status}". Must be completed or unpublished.` });
  }

  const result = await publishSalesPage(req.params.pageId, req.params.projectId);
  res.json({ success: true, ...result });
});

// Unpublish a sales page from Shopify
router.post('/:projectId/sales-pages/:pageId/unpublish', async (req, res) => {
  const page = await getSalesPage(req.params.pageId);
  if (!page) return res.status(404).json({ error: 'Sales page not found' });

  if (page.status !== 'published') {
    return res.status(400).json({ error: 'Page is not published' });
  }

  await unpublishSalesPage(req.params.pageId, req.params.projectId);
  res.json({ success: true });
});

// Get versions for a sales page
router.get('/:projectId/sales-pages/:pageId/versions', async (req, res) => {
  const versions = await getSalesPageVersions(req.params.pageId);
  res.json({ versions: versions || [] });
});

export default router;

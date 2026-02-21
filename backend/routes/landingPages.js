import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import os from 'os';
import fs from 'fs';
import { requireAuth } from '../auth.js';
import {
  getProject,
  getLandingPagesByProject,
  getLandingPage,
  createLandingPage,
  updateLandingPage,
  deleteLandingPage,
  createLandingPageVersion,
} from '../convexClient.js';
import { extractPdfText, generateLandingPageCopy, checkDocsReady } from '../services/lpGenerator.js';
import { createSSEStream } from '../utils/sseHelper.js';

const router = Router();
router.use(requireAuth);

// Multer for swipe PDF upload (temp directory)
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf')) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are supported for swipe uploads.'));
    }
  },
});

// ─── List all landing pages for a project ────────────────────────────────────
router.get('/:projectId/landing-pages', async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const pages = await getLandingPagesByProject(req.params.projectId);
  // Sort newest first
  pages.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  res.json({ pages });
});

// ─── Get single landing page ─────────────────────────────────────────────────
router.get('/:projectId/landing-pages/:pageId', async (req, res) => {
  const page = await getLandingPage(req.params.pageId);
  if (!page || page.project_id !== req.params.projectId) {
    return res.status(404).json({ error: 'Landing page not found' });
  }
  res.json(page);
});

// ─── Check docs readiness ────────────────────────────────────────────────────
router.get('/:projectId/landing-pages-check', async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const result = await checkDocsReady(req.params.projectId);
  res.json(result);
});

// ─── Generate landing page (SSE stream + multipart for swipe PDF) ────────────
router.post('/:projectId/landing-pages/generate', upload.single('swipe_pdf'), async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) {
    if (req.file?.path) fs.unlinkSync(req.file.path);
    return res.status(404).json({ error: 'Project not found' });
  }

  const { angle, word_count, additional_direction } = req.body;

  if (!angle || !angle.trim()) {
    if (req.file?.path) fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'Angle is required' });
  }

  // Check foundational docs
  const docsCheck = await checkDocsReady(req.params.projectId);
  if (!docsCheck.ready) {
    if (req.file?.path) fs.unlinkSync(req.file.path);
    return res.status(400).json({
      error: `Missing foundational documents: ${docsCheck.missing.join(', ')}. Generate or upload these first.`,
    });
  }

  // Extract swipe PDF text if uploaded
  let swipeText = '';
  let swipeFilename = '';
  if (req.file) {
    try {
      swipeText = await extractPdfText(req.file.path);
      swipeFilename = req.file.originalname;
    } catch (err) {
      console.error('[LPGen] PDF extraction error:', err.message);
      // Non-fatal — continue without swipe text
      swipeText = '';
    } finally {
      // Clean up temp file
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    }
  }

  // Create landing page record
  const pageId = uuidv4();
  const wordCountNum = parseInt(word_count) || 1200;
  const pageName = `LP — ${angle.trim().slice(0, 60)}`;

  await createLandingPage({
    id: pageId,
    project_id: req.params.projectId,
    name: pageName,
    angle: angle.trim(),
    word_count: wordCountNum,
    additional_direction: additional_direction?.trim() || undefined,
    swipe_text: swipeText || undefined,
    swipe_filename: swipeFilename || undefined,
    status: 'generating',
  });

  // SSE stream setup
  const sse = createSSEStream(req, res);

  sse.sendEvent({ type: 'started', pageId, name: pageName });

  generateLandingPageCopy({
    projectId: req.params.projectId,
    angle: angle.trim(),
    swipeText,
    wordCount: wordCountNum,
    additionalDirection: additional_direction?.trim() || undefined,
  }, sse.sendEvent)
    .then(async (result) => {
      // Save result to landing page
      const copySectionsJson = JSON.stringify(result.sections);
      await updateLandingPage(pageId, {
        status: 'completed',
        copy_sections: copySectionsJson,
      });

      // Create version 1
      const versionId = uuidv4();
      await createLandingPageVersion({
        id: versionId,
        landing_page_id: pageId,
        version: 1,
        copy_sections: copySectionsJson,
        source: 'generated',
      });

      sse.sendEvent({
        type: 'completed',
        pageId,
        sections: result.sections,
        versionId,
      });
      sse.end();
    })
    .catch(async (err) => {
      console.error('[LPGen] Generation error:', err.message);
      await updateLandingPage(pageId, {
        status: 'failed',
        error_message: err.message,
      });
      sse.sendEvent({ type: 'error', message: err.message, error: err.message });
      sse.end();
    });
});

// ─── Update landing page (name, copy sections) ──────────────────────────────
router.put('/:projectId/landing-pages/:pageId', async (req, res) => {
  const page = await getLandingPage(req.params.pageId);
  if (!page || page.project_id !== req.params.projectId) {
    return res.status(404).json({ error: 'Landing page not found' });
  }

  const updates = {};
  if (req.body.name !== undefined) updates.name = req.body.name;
  if (req.body.copy_sections !== undefined) updates.copy_sections =
    typeof req.body.copy_sections === 'string'
      ? req.body.copy_sections
      : JSON.stringify(req.body.copy_sections);

  await updateLandingPage(req.params.pageId, updates);
  const updated = await getLandingPage(req.params.pageId);
  res.json(updated);
});

// ─── Delete landing page ─────────────────────────────────────────────────────
router.delete('/:projectId/landing-pages/:pageId', async (req, res) => {
  const page = await getLandingPage(req.params.pageId);
  if (!page || page.project_id !== req.params.projectId) {
    return res.status(404).json({ error: 'Landing page not found' });
  }

  await deleteLandingPage(req.params.pageId);
  res.json({ success: true });
});

export default router;

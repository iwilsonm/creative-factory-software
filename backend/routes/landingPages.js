import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { requireAuth } from '../auth.js';
import {
  getProject,
  getLandingPagesByProject,
  getLandingPage,
  createLandingPage,
  updateLandingPage,
  deleteLandingPage,
  createLandingPageVersion,
  getStorageUrl,
} from '../convexClient.js';
import {
  extractPdfText,
  generateLandingPageCopy,
  checkDocsReady,
  analyzeSwipeDesign,
  generateSlotImages,
  generateHtmlTemplate,
  assembleLandingPage,
} from '../services/lpGenerator.js';
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

  // Resolve image URLs for any image slots that have storageIds
  for (const page of pages) {
    if (page.image_slots) {
      try {
        const slots = JSON.parse(page.image_slots);
        for (const slot of slots) {
          if (slot.storageId && !slot.storageUrl) {
            slot.storageUrl = await getStorageUrl(slot.storageId);
          }
        }
        page.image_slots = JSON.stringify(slots);
      } catch {}
    }
  }

  res.json({ pages });
});

// ─── Get single landing page ─────────────────────────────────────────────────
router.get('/:projectId/landing-pages/:pageId', async (req, res) => {
  const page = await getLandingPage(req.params.pageId);
  if (!page || page.project_id !== req.params.projectId) {
    return res.status(404).json({ error: 'Landing page not found' });
  }

  // Resolve image URLs
  if (page.image_slots) {
    try {
      const slots = JSON.parse(page.image_slots);
      for (const slot of slots) {
        if (slot.storageId && !slot.storageUrl) {
          slot.storageUrl = await getStorageUrl(slot.storageId);
        }
      }
      page.image_slots = JSON.stringify(slots);
    } catch {}
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
// Phase 2 pipeline: Design Analysis → Copy Gen → Image Gen → HTML Gen → Assemble
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

  // Keep the PDF file path for Phase 2A design analysis (don't delete it yet)
  let swipeText = '';
  let swipeFilename = '';
  let pdfPath = null;

  if (req.file) {
    pdfPath = req.file.path;
    swipeFilename = req.file.originalname;
    try {
      swipeText = await extractPdfText(req.file.path);
    } catch (err) {
      console.error('[LPGen] PDF text extraction error:', err.message);
      swipeText = '';
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
  sse.sendEvent({ type: 'started', pageId, name: pageName, hasSwipePdf: !!pdfPath });

  // Run the full generation pipeline
  (async () => {
    try {
      // ── Phase 2A: Design Analysis (only if swipe PDF provided) ──
      let designAnalysis = null;
      if (pdfPath) {
        try {
          sse.sendEvent({ type: 'phase', phase: 'design_analysis', message: 'Analyzing swipe PDF design...' });
          designAnalysis = await analyzeSwipeDesign(pdfPath, sse.sendEvent, req.params.projectId);

          // Save design analysis
          await updateLandingPage(pageId, {
            swipe_design_analysis: JSON.stringify(designAnalysis),
          });
        } catch (err) {
          console.error('[LPGen] Design analysis error (non-fatal):', err.message);
          sse.sendEvent({
            type: 'progress',
            step: 'design_error',
            message: `Design analysis failed: ${err.message}. Continuing with default layout.`,
          });
          designAnalysis = null;
        } finally {
          // Clean up PDF now that design analysis is done
          if (fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
          pdfPath = null;
        }
      }

      // ── Phase B: Copy Generation ──
      sse.sendEvent({ type: 'phase', phase: 'copy_generation', message: 'Generating landing page copy...' });
      const copyResult = await generateLandingPageCopy({
        projectId: req.params.projectId,
        angle: angle.trim(),
        swipeText,
        wordCount: wordCountNum,
        additionalDirection: additional_direction?.trim() || undefined,
      }, sse.sendEvent);

      const copySectionsJson = JSON.stringify(copyResult.sections);
      await updateLandingPage(pageId, {
        copy_sections: copySectionsJson,
      });

      // ── Phase 2C: Image Generation (if design analysis has image slots) ──
      let imageSlots = designAnalysis?.image_slots || [];
      let populatedImageSlots = [];

      if (imageSlots.length > 0) {
        sse.sendEvent({ type: 'phase', phase: 'image_generation', message: `Generating ${imageSlots.length} images...` });
        populatedImageSlots = await generateSlotImages({
          imageSlots,
          copySections: copyResult.sections,
          angle: angle.trim(),
          projectId: req.params.projectId,
        }, sse.sendEvent);

        // Save image slots (with storageIds)
        await updateLandingPage(pageId, {
          image_slots: JSON.stringify(populatedImageSlots),
        });
      }

      // ── Phase 2D: HTML Generation ──
      const ctaElements = designAnalysis?.cta_elements || [];

      // If no design analysis, create a default one for HTML generation
      const effectiveDesign = designAnalysis || createDefaultDesignSpec(copyResult.sections);

      sse.sendEvent({ type: 'phase', phase: 'html_generation', message: 'Generating HTML template...' });
      const htmlTemplate = await generateHtmlTemplate({
        designAnalysis: effectiveDesign,
        copySections: copyResult.sections,
        imageSlots: populatedImageSlots.length > 0 ? populatedImageSlots : imageSlots,
        ctaElements,
        projectId: req.params.projectId,
      }, sse.sendEvent);

      await updateLandingPage(pageId, {
        html_template: htmlTemplate,
      });

      // ── Phase 2E: Assemble final HTML ──
      sse.sendEvent({ type: 'phase', phase: 'assembling', message: 'Assembling final landing page...' });
      const assembledHtml = assembleLandingPage({
        htmlTemplate,
        copySections: copyResult.sections,
        imageSlots: populatedImageSlots,
        ctaElements,
      });

      // Save everything
      await updateLandingPage(pageId, {
        status: 'completed',
        assembled_html: assembledHtml,
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
        sections: copyResult.sections,
        versionId,
        hasDesignAnalysis: !!designAnalysis,
        imageCount: populatedImageSlots.filter(s => s.generated).length,
        hasHtml: true,
      });
      sse.end();
    } catch (err) {
      console.error('[LPGen] Generation error:', err.message);

      // Clean up PDF if still exists
      if (pdfPath && fs.existsSync(pdfPath)) {
        fs.unlinkSync(pdfPath);
      }

      await updateLandingPage(pageId, {
        status: 'failed',
        error_message: err.message,
      });
      sse.sendEvent({ type: 'error', message: err.message, error: err.message });
      sse.end();
    }
  })();
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

// ─── Helper: Default design spec when no swipe PDF is provided ──────────────
function createDefaultDesignSpec(copySections) {
  return {
    layout: {
      max_width: '800px',
      alignment: 'center',
      background_color: '#ffffff',
      content_padding: '20px 40px',
    },
    typography: {
      heading_font: 'Georgia, serif',
      body_font: 'system-ui, -apple-system, sans-serif',
      heading_color: '#1a1a2e',
      body_color: '#333333',
      heading_sizes: { h1: '42px', h2: '32px', h3: '24px' },
      body_size: '18px',
      line_height: '1.7',
    },
    colors: {
      primary: '#2563eb',
      secondary: '#1e40af',
      background: '#ffffff',
      text: '#333333',
      accent: '#dc2626',
      cta_background: '#2563eb',
      cta_text: '#ffffff',
    },
    sections: copySections.map(s => ({
      id: s.type,
      type: s.type === 'headline' ? 'hero' : 'text',
      background: '#ffffff',
      padding: '40px 0',
      notes: `${s.type} section`,
    })),
    image_slots: [],
    cta_elements: [
      {
        cta_id: 'cta_1',
        location: 'After offer section',
        style: 'button',
        text_suggestion: 'Order Now',
        background: '#2563eb',
        text_color: '#ffffff',
        border_radius: '8px',
        padding: '16px 48px',
        font_size: '20px',
        font_weight: 'bold',
      },
    ],
    spacing: {
      section_gap: '48px',
      element_gap: '24px',
      paragraph_gap: '16px',
    },
    style_notes: 'Clean, professional direct response landing page with strong typography and clear CTAs.',
  };
}

export default router;

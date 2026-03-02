import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import os from 'os';
import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer';
import { requireAuth } from '../auth.js';
import {
  getProject,
  getLandingPagesByProject,
  getLandingPage,
  createLandingPage,
  updateLandingPage,
  deleteLandingPage,
  createLandingPageVersion,
  getLandingPageVersions,
  getLandingPageVersion,
  getStorageUrl,
  uploadBuffer,
  getLPTemplate,
} from '../convexClient.js';
import {
  generateLandingPageCopy,
  checkDocsReady,
  analyzeSwipeDesign,
  generateSlotImages,
  generateHtmlTemplate,
  assembleLandingPage,
  generateAutoLP,
  NARRATIVE_FRAMES,
} from '../services/lpGenerator.js';
import { fetchSwipePage } from '../services/lpSwipeFetcher.js';
import { generateImage } from '../services/gemini.js';
import { createSSEStream } from '../utils/sseHelper.js';
import { publishToShopify, unpublishFromShopify, verifyLive } from '../services/lpPublisher.js';

const router = Router();
router.use(requireAuth);

// Multer for image uploads (jpg, png, webp, gif)
const imageUpload = multer({
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
  },
});

const EXT_TO_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

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

// ─── Download landing page as PDF ────────────────────────────────────────────
router.get('/:projectId/landing-pages/:pageId/download-pdf', async (req, res) => {
  let browser;
  try {
    const page = await getLandingPage(req.params.pageId);
    if (!page || page.project_id !== req.params.projectId) {
      return res.status(404).json({ error: 'Landing page not found' });
    }

    const html = page.assembled_html;
    if (!html) {
      return res.status(400).json({ error: 'Landing page has no assembled HTML yet' });
    }

    // Launch headless Chromium (same config as lpSwipeFetcher.js)
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--single-process',
      ],
    });

    const browserPage = await browser.newPage();
    await browserPage.setViewport({ width: 1440, height: 900 });
    await browserPage.setContent(html, { waitUntil: 'networkidle2', timeout: 30000 });

    const pdfBuffer = await browserPage.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '0.5cm', bottom: '0.5cm', left: '0.5cm', right: '0.5cm' },
    });

    // Sanitize filename
    const safeName = (page.name || 'Landing-Page').replace(/[^a-zA-Z0-9_\- ]/g, '').slice(0, 80).trim();

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('[LandingPages] PDF download error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to generate PDF' });
    }
  } finally {
    if (browser) {
      try { await browser.close(); } catch {}
    }
  }
});

// ─── Check docs readiness ────────────────────────────────────────────────────
router.get('/:projectId/landing-pages-check', async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const result = await checkDocsReady(req.params.projectId);
  res.json(result);
});

// ─── Generate landing page (SSE stream + JSON body with swipe URL) ───────────
// Phase 2 pipeline: URL Fetch → Design Analysis → Copy Gen → Image Gen → HTML Gen → Assemble
router.post('/:projectId/landing-pages/generate', async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }

  const { angle, swipe_url, word_count, additional_direction, swipe_pdf_base64, swipe_pdf_filename } = req.body;

  if (!angle || !angle.trim()) {
    return res.status(400).json({ error: 'Angle is required' });
  }

  // Check foundational docs
  const docsCheck = await checkDocsReady(req.params.projectId);
  if (!docsCheck.ready) {
    return res.status(400).json({
      error: `Missing foundational documents: ${docsCheck.missing.join(', ')}. Generate or upload these first.`,
    });
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
    swipe_url: swipe_url?.trim() || undefined,
    status: 'generating',
  });

  // SSE stream setup
  const sse = createSSEStream(req, res);
  const hasSwipeRef = !!swipe_url || !!swipe_pdf_base64;
  sse.sendEvent({ type: 'started', pageId, name: pageName, hasSwipeUrl: hasSwipeRef, hasSwipePdf: !!swipe_pdf_base64 });

  // Run the full generation pipeline
  (async () => {
    try {
      let swipeText = '';
      let screenshotBuffer = null;

      // ── Phase A: Fetch swipe page (URL) or read swipe PDF ──
      if (swipe_url && swipe_url.trim()) {
        try {
          sse.sendEvent({ type: 'phase', phase: 'fetch', message: 'Loading swipe page...' });
          const fetchResult = await fetchSwipePage(swipe_url.trim(), sse.sendEvent);

          swipeText = fetchResult.textContent;
          screenshotBuffer = fetchResult.screenshotBuffer;

          // Save fetched data to the landing page record
          await updateLandingPage(pageId, {
            swipe_text: swipeText || undefined,
            swipe_screenshot_storageId: fetchResult.screenshotStorageId,
          });
        } catch (err) {
          console.error('[LPGen] Swipe page fetch error:', err.message);
          throw new Error(`Failed to fetch swipe page: ${err.message}`);
        }
      } else if (swipe_pdf_base64) {
        try {
          sse.sendEvent({ type: 'phase', phase: 'fetch', message: 'Reading swipe PDF...' });

          // Extract base64 data from data URL
          const base64Match = swipe_pdf_base64.match(/^data:application\/pdf;base64,(.+)$/);
          if (!base64Match) throw new Error('Invalid PDF data');
          const pdfBuffer = Buffer.from(base64Match[1], 'base64');

          // Use the PDF buffer directly as the "screenshot" for design analysis
          // Claude can analyze PDFs natively as document blocks
          screenshotBuffer = pdfBuffer;

          // Extract text from PDF for copy guidance
          try {
            const { createRequire } = await import('module');
            const require = createRequire(import.meta.url);
            const pdfParse = require('pdf-parse');
            const pdfData = await pdfParse(pdfBuffer);
            swipeText = pdfData.text || '';
          } catch {
            // Text extraction failed, continue with visual analysis only
            swipeText = '';
          }

          sse.sendEvent({ type: 'progress', message: `PDF loaded${swipeText ? ` — ${swipeText.length.toLocaleString()} characters extracted` : ''}` });
        } catch (err) {
          console.error('[LPGen] Swipe PDF read error:', err.message);
          throw new Error(`Failed to read swipe PDF: ${err.message}`);
        }
      }

      // ── Phase 2A: Design Analysis (only if we have a screenshot) ──
      let designAnalysis = null;
      if (screenshotBuffer) {
        try {
          sse.sendEvent({ type: 'phase', phase: 'design_analysis', message: 'Analyzing swipe page design...' });
          designAnalysis = await analyzeSwipeDesign(screenshotBuffer, sse.sendEvent, req.params.projectId);

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
  if (req.body.cta_links !== undefined) updates.cta_links =
    typeof req.body.cta_links === 'string'
      ? req.body.cta_links
      : JSON.stringify(req.body.cta_links);
  if (req.body.slug !== undefined) updates.slug = req.body.slug;
  if (req.body.assembled_html !== undefined) updates.assembled_html = req.body.assembled_html;
  if (req.body.image_slots !== undefined) updates.image_slots =
    typeof req.body.image_slots === 'string'
      ? req.body.image_slots
      : JSON.stringify(req.body.image_slots);
  if (req.body.html_template !== undefined) updates.html_template = req.body.html_template;
  if (req.body.current_version !== undefined) updates.current_version = req.body.current_version;

  await updateLandingPage(req.params.pageId, updates);
  const updated = await getLandingPage(req.params.pageId);
  res.json(updated);
});

// ─── Regenerate a single image slot (SSE stream) ─────────────────────────────
router.post('/:projectId/landing-pages/:pageId/regenerate-image', async (req, res) => {
  const page = await getLandingPage(req.params.pageId);
  if (!page || page.project_id !== req.params.projectId) {
    return res.status(404).json({ error: 'Landing page not found' });
  }

  const { slot_index, prompt, aspect_ratio } = req.body;
  if (slot_index === undefined || !prompt) {
    return res.status(400).json({ error: 'slot_index and prompt are required' });
  }

  const imageSlots = page.image_slots ? JSON.parse(page.image_slots) : [];
  if (slot_index < 0 || slot_index >= imageSlots.length) {
    return res.status(400).json({ error: 'Invalid slot_index' });
  }

  const sse = createSSEStream(req, res);
  sse.sendEvent({ type: 'started', slot_index });

  (async () => {
    try {
      sse.sendEvent({ type: 'progress', message: `Generating image for slot ${slot_index + 1}...` });

      const result = await generateImage(prompt, aspect_ratio || '1:1', null, {
        projectId: req.params.projectId, operation: 'lp_image_generation',
      });

      if (!result?.imageBuffer) {
        throw new Error('Image generation returned no image');
      }

      // Upload to Convex storage
      const storageId = await uploadBuffer(result.imageBuffer, result.mimeType || 'image/png');
      const storageUrl = await getStorageUrl(storageId);

      // Preserve original storageId for revert
      if (!imageSlots[slot_index].original_storageId) {
        imageSlots[slot_index].original_storageId = imageSlots[slot_index].storageId || null;
      }

      // Update the slot
      imageSlots[slot_index].storageId = storageId;
      imageSlots[slot_index].storageUrl = storageUrl;
      imageSlots[slot_index].generated = true;

      // Re-assemble HTML
      const copySections = page.copy_sections ? JSON.parse(page.copy_sections) : [];
      const ctaLinks = page.cta_links ? JSON.parse(page.cta_links) : [];
      const ctaElements = ctaLinks.length > 0 ? ctaLinks : (page.swipe_design_analysis ? JSON.parse(page.swipe_design_analysis).cta_elements || [] : []);

      const assembledHtml = assembleLandingPage({
        htmlTemplate: page.html_template || '',
        copySections,
        imageSlots,
        ctaElements: ctaLinks.length > 0 ? ctaLinks : ctaElements,
      });

      // Save everything
      await updateLandingPage(req.params.pageId, {
        image_slots: JSON.stringify(imageSlots),
        assembled_html: assembledHtml,
      });

      sse.sendEvent({
        type: 'completed',
        slot_index,
        storageId,
        storageUrl,
        imageSlots,
        assembled_html: assembledHtml,
      });
      sse.end();
    } catch (err) {
      console.error('[LPGen] Image regeneration error:', err.message);
      sse.sendEvent({ type: 'error', message: err.message });
      sse.end();
    }
  })();
});

// ─── Upload an image for a specific slot ──────────────────────────────────────
router.post('/:projectId/landing-pages/:pageId/upload-image', imageUpload.single('image'), async (req, res) => {
  const page = await getLandingPage(req.params.pageId);
  if (!page || page.project_id !== req.params.projectId) {
    if (req.file?.path) fs.unlinkSync(req.file.path);
    return res.status(404).json({ error: 'Landing page not found' });
  }

  const slotIndex = parseInt(req.body.slot_index);
  if (isNaN(slotIndex)) {
    if (req.file?.path) fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'slot_index is required' });
  }

  const imageSlots = page.image_slots ? JSON.parse(page.image_slots) : [];
  if (slotIndex < 0 || slotIndex >= imageSlots.length) {
    if (req.file?.path) fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'Invalid slot_index' });
  }

  try {
    const fileBuffer = fs.readFileSync(req.file.path);
    const ext = path.extname(req.file.originalname).toLowerCase();
    const mime = EXT_TO_MIME[ext] || 'image/png';

    // Upload to Convex storage
    const storageId = await uploadBuffer(fileBuffer, mime);
    const storageUrl = await getStorageUrl(storageId);

    // Preserve original storageId for revert
    if (!imageSlots[slotIndex].original_storageId) {
      imageSlots[slotIndex].original_storageId = imageSlots[slotIndex].storageId || null;
    }

    imageSlots[slotIndex].storageId = storageId;
    imageSlots[slotIndex].storageUrl = storageUrl;
    imageSlots[slotIndex].generated = true;

    // Re-assemble HTML
    const copySections = page.copy_sections ? JSON.parse(page.copy_sections) : [];
    const ctaLinks = page.cta_links ? JSON.parse(page.cta_links) : [];
    const ctaElements = ctaLinks.length > 0 ? ctaLinks : (page.swipe_design_analysis ? JSON.parse(page.swipe_design_analysis).cta_elements || [] : []);

    const assembledHtml = assembleLandingPage({
      htmlTemplate: page.html_template || '',
      copySections,
      imageSlots,
      ctaElements: ctaLinks.length > 0 ? ctaLinks : ctaElements,
    });

    await updateLandingPage(req.params.pageId, {
      image_slots: JSON.stringify(imageSlots),
      assembled_html: assembledHtml,
    });

    res.json({ slot: imageSlots[slotIndex], assembled_html: assembledHtml });
  } catch (err) {
    console.error('[LPGen] Image upload error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
  }
});

// ─── Revert an image slot to original ─────────────────────────────────────────
router.post('/:projectId/landing-pages/:pageId/revert-image', async (req, res) => {
  const page = await getLandingPage(req.params.pageId);
  if (!page || page.project_id !== req.params.projectId) {
    return res.status(404).json({ error: 'Landing page not found' });
  }

  const { slot_index } = req.body;
  const imageSlots = page.image_slots ? JSON.parse(page.image_slots) : [];
  if (slot_index < 0 || slot_index >= imageSlots.length) {
    return res.status(400).json({ error: 'Invalid slot_index' });
  }

  const slot = imageSlots[slot_index];
  if (!slot.original_storageId) {
    return res.status(400).json({ error: 'No original image to revert to' });
  }

  // Copy original back
  slot.storageId = slot.original_storageId;
  try {
    slot.storageUrl = await getStorageUrl(slot.storageId);
  } catch {
    slot.storageUrl = null;
  }

  // Re-assemble HTML
  const copySections = page.copy_sections ? JSON.parse(page.copy_sections) : [];
  const ctaLinks = page.cta_links ? JSON.parse(page.cta_links) : [];
  const ctaElements = ctaLinks.length > 0 ? ctaLinks : (page.swipe_design_analysis ? JSON.parse(page.swipe_design_analysis).cta_elements || [] : []);

  const assembledHtml = assembleLandingPage({
    htmlTemplate: page.html_template || '',
    copySections,
    imageSlots,
    ctaElements: ctaLinks.length > 0 ? ctaLinks : ctaElements,
  });

  await updateLandingPage(req.params.pageId, {
    image_slots: JSON.stringify(imageSlots),
    assembled_html: assembledHtml,
  });

  res.json({ slot: imageSlots[slot_index], assembled_html: assembledHtml });
});

// ─── Get all versions for a landing page ──────────────────────────────────────
router.get('/:projectId/landing-pages/:pageId/versions', async (req, res) => {
  const page = await getLandingPage(req.params.pageId);
  if (!page || page.project_id !== req.params.projectId) {
    return res.status(404).json({ error: 'Landing page not found' });
  }

  const versions = await getLandingPageVersions(req.params.pageId);
  versions.sort((a, b) => b.version - a.version);
  res.json({ versions });
});

// ─── Save a new version snapshot ──────────────────────────────────────────────
router.post('/:projectId/landing-pages/:pageId/versions', async (req, res) => {
  const page = await getLandingPage(req.params.pageId);
  if (!page || page.project_id !== req.params.projectId) {
    return res.status(404).json({ error: 'Landing page not found' });
  }

  const currentVersion = page.current_version || 1;
  const newVersion = currentVersion + 1;
  const versionId = uuidv4();

  await createLandingPageVersion({
    id: versionId,
    landing_page_id: req.params.pageId,
    version: newVersion,
    copy_sections: page.copy_sections || '[]',
    source: 'edited',
    image_slots: page.image_slots || undefined,
    cta_links: page.cta_links || undefined,
    html_template: page.html_template || undefined,
    assembled_html: page.assembled_html || undefined,
  });

  await updateLandingPage(req.params.pageId, { current_version: newVersion });

  res.json({ versionId, version: newVersion });
});

// ─── Restore a version ─────────────────────────────────────────────────────────
router.post('/:projectId/landing-pages/:pageId/versions/:versionId/restore', async (req, res) => {
  const page = await getLandingPage(req.params.pageId);
  if (!page || page.project_id !== req.params.projectId) {
    return res.status(404).json({ error: 'Landing page not found' });
  }

  const targetVersion = await getLandingPageVersion(req.params.versionId);
  if (!targetVersion || targetVersion.landing_page_id !== req.params.pageId) {
    return res.status(404).json({ error: 'Version not found' });
  }

  // Safety: save current state as a new version first
  const currentVersion = page.current_version || 1;
  const safetyVersion = currentVersion + 1;
  const safetyId = uuidv4();

  await createLandingPageVersion({
    id: safetyId,
    landing_page_id: req.params.pageId,
    version: safetyVersion,
    copy_sections: page.copy_sections || '[]',
    source: 'auto-save',
    image_slots: page.image_slots || undefined,
    cta_links: page.cta_links || undefined,
    html_template: page.html_template || undefined,
    assembled_html: page.assembled_html || undefined,
  });

  // Restore target version's data
  const restoredVersion = safetyVersion + 1;
  const updates = {
    copy_sections: targetVersion.copy_sections,
    current_version: restoredVersion,
  };
  if (targetVersion.image_slots) updates.image_slots = targetVersion.image_slots;
  if (targetVersion.cta_links) updates.cta_links = targetVersion.cta_links;
  if (targetVersion.html_template) updates.html_template = targetVersion.html_template;
  if (targetVersion.assembled_html) updates.assembled_html = targetVersion.assembled_html;

  await updateLandingPage(req.params.pageId, updates);

  const updated = await getLandingPage(req.params.pageId);

  // Resolve image URLs for the restored page
  if (updated.image_slots) {
    try {
      const slots = JSON.parse(updated.image_slots);
      for (const slot of slots) {
        if (slot.storageId && !slot.storageUrl) {
          slot.storageUrl = await getStorageUrl(slot.storageId);
        }
      }
      updated.image_slots = JSON.stringify(slots);
    } catch {}
  }

  res.json(updated);
});

// ─── Publish landing page to Shopify ──────────────────────────────────────────
router.post('/:projectId/landing-pages/:pageId/publish', async (req, res) => {
  const page = await getLandingPage(req.params.pageId);
  if (!page || page.project_id !== req.params.projectId) {
    return res.status(404).json({ error: 'Landing page not found' });
  }

  try {
    const result = await publishToShopify(req.params.pageId, req.params.projectId);
    res.json({
      success: true,
      published_url: result.published_url,
      shopify_page_id: result.shopify_page_id,
      shopify_handle: result.shopify_handle,
    });
  } catch (err) {
    console.error('[LPPublish] Publish error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Unpublish landing page from Shopify ──────────────────────────────────────
router.post('/:projectId/landing-pages/:pageId/unpublish', async (req, res) => {
  const page = await getLandingPage(req.params.pageId);
  if (!page || page.project_id !== req.params.projectId) {
    return res.status(404).json({ error: 'Landing page not found' });
  }

  try {
    await unpublishFromShopify(req.params.pageId, req.params.projectId);
    res.json({ success: true });
  } catch (err) {
    console.error('[LPPublish] Unpublish error:', err.message);
    res.status(500).json({ error: err.message });
  }
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

// ─── Duplicate a landing page (copies config, not generated content) ────────
router.post('/:projectId/landing-pages/:pageId/duplicate', async (req, res) => {
  const page = await getLandingPage(req.params.pageId);
  if (!page || page.project_id !== req.params.projectId) {
    return res.status(404).json({ error: 'Landing page not found' });
  }

  const newId = uuidv4();
  const baseName = page.name || page.angle || 'Landing Page';
  const newName = `${baseName} (copy)`;

  await createLandingPage({
    id: newId,
    project_id: req.params.projectId,
    name: newName,
    angle: page.angle || undefined,
    word_count: page.word_count || undefined,
    additional_direction: page.additional_direction || undefined,
    swipe_text: page.swipe_text || undefined,
    swipe_url: page.swipe_url || undefined,
    swipe_screenshot_storageId: page.swipe_screenshot_storageId || undefined,
    status: 'draft',
  });

  // Copy design analysis if it exists (enables regenerating without re-fetching URL)
  if (page.swipe_design_analysis) {
    await updateLandingPage(newId, {
      swipe_design_analysis: page.swipe_design_analysis,
    });
  }

  const newPage = await getLandingPage(newId);
  res.status(201).json(newPage);
});

// ─── Helper: Default design spec when no swipe URL is provided ──────────────
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

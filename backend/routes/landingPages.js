import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import os from 'os';
import fs from 'fs';
import path from 'path';
import puppeteer from 'puppeteer';
import { requireAuth, requireRole } from '../auth.js';
import {
  getProject,
  getLandingPageSummariesByProject,
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
  getDocsByProject,
  getSetting,
  countLandingPagesCreatedToday,
  tryAcquireLPGenerationLock,
  releaseLPGenerationLock,
  getLPCostEstimate,
  getLPsWithCandidatesByProject,
} from '../convexClient.js';
import {
  generateLandingPageCopy,
  checkDocsReady,
  // analyzeSwipeDesign deleted per PEF plan 2026-04-21 — template skeleton supplies design.
  generateSlotImages,
  generateHtmlTemplate,
  assembleLandingPage,
  postProcessLP,
  injectContrastSafetyCSS,
  ensureMinLightness,
  enforceBackgroundLightness,
  extractImageContext,
  generateAutoLP,
  runVisualQA,
  assignBeliefOrObjectionToSlots,
  NARRATIVE_FRAMES,
} from '../services/lpGenerator.js';
import { fetchSwipePage } from '../services/lpSwipeFetcher.js';
import { generateImage } from '../services/gemini.js';
import { createSSEStream } from '../utils/sseHelper.js';
import { publishToShopify, unpublishFromShopify, verifyLive } from '../services/lpPublisher.js';
import { appendLPAuditTrail, clearChiefReviewTodo } from '../services/lpAutoGenerator.js';
import { generateImageConcepts } from '../services/lpImageStrategy.js';
import { generateImageCandidates } from '../services/lpImageCandidateGenerator.js';

// PEF plan 2026-04-21 — config gates for the new manual image-selection flow.
const DEFAULT_DAILY_LP_GEN_CAP = 10;
const DEFAULT_DAILY_LP_REGEN_CAP = 30;
const CANDIDATE_LIBRARY_CAP = 30;

/**
 * Read the per-project Chief Image Selection feature flag. Stored in the
 * `lp_manual_image_selection_enabled_by_project` setting as a JSON string map.
 * Default: false (existing flow runs).
 */
async function isManualImageSelectionEnabled(projectId) {
  try {
    const raw = await getSetting('lp_manual_image_selection_enabled_by_project');
    if (!raw) return false;
    const map = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return !!map?.[projectId];
  } catch {
    return false;
  }
}

async function readDailyCap(key, fallback) {
  try {
    const raw = await getSetting(key);
    const num = parseInt(raw, 10);
    if (!Number.isFinite(num) || num <= 0) return fallback;
    return num;
  } catch {
    return fallback;
  }
}

async function appendChiefImageAuditEntry(pageId, entry) {
  try {
    await appendLPAuditTrail(pageId, entry);
  } catch (err) {
    console.warn('[LPChiefImage] Audit append failed:', err.message);
  }
}

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

function parseMaybeJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return value;
}

function resolveDraftState(page, body = {}) {
  const draftState = parseMaybeJson(body.draft_state, null) || {};
  return {
    copySections: parseMaybeJson(draftState.copy_sections ?? body.copy_sections, page.copy_sections ? JSON.parse(page.copy_sections) : []),
    imageSlots: parseMaybeJson(draftState.image_slots ?? body.image_slots, page.image_slots ? JSON.parse(page.image_slots) : []),
    ctaLinks: parseMaybeJson(draftState.cta_links ?? body.cta_links, page.cta_links ? JSON.parse(page.cta_links) : []),
    htmlTemplate: draftState.html_template ?? body.html_template ?? page.html_template ?? '',
  };
}

function isPersistEnabled(value) {
  if (value === undefined || value === null || value === '') return true;
  if (typeof value === 'boolean') return value;
  return String(value).toLowerCase() !== 'false';
}

// ─── List all landing pages for a project ────────────────────────────────────
router.get('/:projectId/landing-pages', async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const pages = await getLandingPageSummariesByProject(req.params.projectId);
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

  // Resolve QA screenshot URL
  if (page.qa_screenshot_storageId) {
    try {
      page.qa_screenshot_url = await getStorageUrl(page.qa_screenshot_storageId);
    } catch {}
  }

  res.json(page);
});

// ─── Phase 2 (PEF item H) — unplaced candidates archive ────────────────────
// Returns every candidate across the project's LPs that wasn't placed in a
// slot, with the source LP context. Used by the new Archive view.
router.get('/:projectId/landing-pages-archive/unplaced-candidates', async (req, res) => {
  try {
    const lps = await getLPsWithCandidatesByProject(req.params.projectId);
    const items = [];
    for (const lp of (lps || [])) {
      let candidates = [];
      let assignments = [];
      try { candidates = lp.image_candidates ? JSON.parse(lp.image_candidates) : []; } catch { candidates = []; }
      try { assignments = lp.image_slot_assignments ? JSON.parse(lp.image_slot_assignments) : []; } catch { assignments = []; }
      const placedIds = new Set(assignments.map(a => a.candidate_id).filter(Boolean));
      for (const c of candidates) {
        if (!c?.candidate_id || placedIds.has(c.candidate_id)) continue;
        if (c.generation_status !== 'succeeded') continue;
        if (!c.storageUrl) continue;
        items.push({
          candidate_id: c.candidate_id,
          concept_label: c.concept_label,
          aspect_ratio: c.aspect_ratio,
          storageUrl: c.storageUrl,
          generated_at: c.generated_at,
          source_lp_id: lp.externalId,
          source_lp_name: lp.name,
          source_lp_status: lp.status,
        });
      }
    }
    // Sort newest first.
    items.sort((a, b) => (b.generated_at || '').localeCompare(a.generated_at || ''));
    res.json({ items, count: items.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Phase 2 (PEF item D) — per-LP cost rollup ──────────────────────────────
router.get('/:projectId/landing-pages/:pageId/cost-estimate', async (req, res) => {
  const page = await getLandingPage(req.params.pageId);
  if (!page || page.project_id !== req.params.projectId) {
    return res.status(404).json({ error: 'Landing page not found' });
  }
  try {
    const result = await getLPCostEstimate(req.params.projectId, page.created_at);
    res.json({
      lpId: page.externalId,
      created_at: page.created_at,
      total_usd: result.totalUsd,
      by_operation: result.byOperation,
      note: 'Approximate — sums all LP-tagged costs for this project on the LP creation date.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

    const pdfData = await browserPage.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '0.5cm', bottom: '0.5cm', left: '0.5cm', right: '0.5cm' },
    });

    // Puppeteer returns Uint8Array — must convert to Buffer for Express
    const pdfBuffer = Buffer.from(pdfData);

    // Sanitize filename
    const safeName = (page.name || 'Landing-Page').replace(/[^a-zA-Z0-9_\- ]/g, '').slice(0, 80).trim();

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.end(pdfBuffer);
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

  // Mark Builds Brands SOP: no word-count target (the listicle is whatever
  // length it needs to be). We intentionally don't destructure `word_count`
  // from the body — stale clients that still send it are silently ignored.
  const { angle, swipe_url, additional_direction, swipe_pdf_base64, swipe_pdf_filename } = req.body;

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

  // ── PEF plan 2026-04-21 invariants — new flow gates ──
  const useNewFlow = await isManualImageSelectionEnabled(req.params.projectId);

  // Daily LP generation cap — applies to BOTH flows (denial-of-wallet guard).
  const dailyCap = await readDailyCap('daily_lp_generation_cap', DEFAULT_DAILY_LP_GEN_CAP);
  const todayCount = await countLandingPagesCreatedToday(req.params.projectId);
  if (todayCount >= dailyCap) {
    return res.status(429).json({
      error: `Daily LP generation cap (${dailyCap}/day) reached for this project. Try again tomorrow or raise the cap in Settings.`,
      cap: dailyCap,
      generated_today: todayCount,
    });
  }

  // Per-project generation lock — prevents concurrent /generate calls (PEF
  // invariant #9). Falls into 409 if another LP is already generating.
  const lockResult = await tryAcquireLPGenerationLock(
    req.params.projectId,
    600_000,
    `manual_generate user=${req.user?.username || 'unknown'}`
  );
  if (!lockResult?.acquired) {
    return res.status(409).json({
      error: 'Another LP is generating for this project. Try again in a moment.',
      ms_until_expiry: lockResult?.ms_until_expiry || null,
      holder_label: lockResult?.holder_label || null,
    });
  }

  // Create landing page record
  const pageId = uuidv4();
  const pageName = `LP — ${angle.trim().slice(0, 60)}`;

  await createLandingPage({
    id: pageId,
    project_id: req.params.projectId,
    name: pageName,
    angle: angle.trim(),
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

      // ── Audit trail for manual generation ──
      const auditTrail = [];
      const audit = (step, action, detail) => {
        auditTrail.push({ timestamp: new Date().toISOString(), step, action, detail });
      };
      audit('init', 'started', `Manual generation — angle: "${(angle || '').slice(0, 50)}"`);

      // ── Phase 2A REMOVED: Claude vision design analysis ──
      // Per PEF plan 2026-04-21: template skeletons supply layout/colors/fonts;
      // the vision call was redundant and added ~$0.05 per LP. designAnalysis
      // stays null — image_slots come from `template.slot_definitions` (or empty
      // for the legacy auto-image branch below until the new lpImageStrategy
      // pipeline is wired in Chunk H).
      const designAnalysis = null;

      // ── Phase B: Copy Generation (Turn 3 → Turn 4 → scrub → parse) ──
      sse.sendEvent({ type: 'phase', phase: 'copy_generation', message: 'Generating landing page copy...' });
      const copyResult = await generateLandingPageCopy({
        projectId: req.params.projectId,
        angle: angle.trim(),
        swipeText,
        additionalDirection: additional_direction?.trim() || undefined,
      }, sse.sendEvent);

      const copySectionsJson = JSON.stringify(copyResult.sections);
      await updateLandingPage(pageId, {
        copy_sections: copySectionsJson,
      });
      audit('copy', 'generated', `${copyResult.sections?.length || 0} sections`);
      if (copyResult.suspiciousHits?.length) {
        audit('security', 'scan', `Suspicious-command patterns in copy: ${copyResult.suspiciousHits.join(', ')}`);
      }

      // ── Branch on feature flag ──
      if (useNewFlow) {
        // ── PEF plan 2026-04-21 manual-image-selection flow ──
        // Step 1: GPT-5.4 image-strategy concepts.
        sse.sendEvent({ type: 'phase', phase: 'image_strategy', message: 'GPT-5.4 is building the image strategy...' });
        const foundationalDocs = await getDocsByProject(req.params.projectId).catch(() => ({}));
        const targetDemo = (project?.avatar_summary || project?.avatar || '').toString().trim().slice(0, 240);
        const problem = (project?.problem_summary || project?.product_description || '').toString().trim().slice(0, 240);
        const lpCopyText = (copyResult.sections || [])
          .map((s) => `${s.type}: ${s.content}`)
          .join('\n\n');

        // Phase 2 (PEF item F) — pass template slot count if a template was selected.
        let templateSlotCount = null;
        try {
          const templateId = req.body?.template_id || null;
          if (templateId) {
            const tpl = await getLPTemplate(templateId).catch(() => null);
            if (tpl?.slot_definitions) {
              const slotDefs = typeof tpl.slot_definitions === 'string'
                ? JSON.parse(tpl.slot_definitions)
                : tpl.slot_definitions;
              templateSlotCount = (slotDefs || []).filter(s => s?.type === 'image').length;
            }
          }
        } catch { /* fall back to default */ }

        const { concepts, model: imageStrategyModel } = await generateImageConcepts({
          projectId: req.params.projectId,
          lpCopyText,
          foundationalDocs,
          targetDemo,
          problem,
          templateSlotCount,
        }, sse.sendEvent);
        audit('image_strategy', 'concepts_generated', `${concepts.length} concepts via ${imageStrategyModel}`);

        // Step 2: Nano Banana 2 candidate generation.
        sse.sendEvent({ type: 'phase', phase: 'image_candidates', message: `Generating ${concepts.length} image candidates with Nano Banana 2...` });
        const candidates = await generateImageCandidates({
          projectId: req.params.projectId,
          lpId: pageId,
          concepts,
        }, sse.sendEvent);
        const succeeded = candidates.filter((c) => c.generation_status === 'succeeded').length;
        const failed = candidates.length - succeeded;
        audit('image_candidates', 'generated', `${succeeded}/${candidates.length} succeeded, ${failed} failed`);

        // Step 3: Persist candidates + flip status to pending_image_selection.
        // HTML assembly + post-processing deferred to Approve & Publish (we
        // don't know yet which images Ian will place into which slots).
        await updateLandingPage(pageId, {
          status: 'pending_image_selection',
          image_candidates: JSON.stringify(candidates),
          image_slot_assignments: JSON.stringify([]),
          audit_trail: JSON.stringify(auditTrail),
        });
        audit('flow', 'pending_image_selection', 'Awaiting Chief image selection.');

        sse.sendEvent({
          type: 'completed',
          pageId,
          sections: copyResult.sections,
          versionId: null, // version snapshot happens at Approve & Publish
          imageCandidatesCount: candidates.length,
          imageCandidatesSucceeded: succeeded,
          imageCandidatesFailed: failed,
          status: 'pending_image_selection',
          flow: 'manual_image_selection',
        });
        sse.end();
        return;
      }

      // ── Legacy flow (feature flag OFF) ──
      // ── Phase 2C: Image Generation (if design analysis has image slots) ──
      let imageSlots = designAnalysis?.image_slots || [];
      let populatedImageSlots = [];

      if (imageSlots.length > 0) {
        sse.sendEvent({ type: 'phase', phase: 'image_generation', message: `Generating ${imageSlots.length} images...` });
        const imageContext = await extractImageContext(req.params.projectId);

        try {
          const foundationalDocs = await getDocsByProject(req.params.projectId);
          await assignBeliefOrObjectionToSlots(imageSlots, foundationalDocs, req.params.projectId, sse.sendEvent);
        } catch (err) {
          console.warn('[LPGen] Belief/objection enrichment skipped:', err.message);
        }

        populatedImageSlots = await generateSlotImages({
          imageSlots,
          copySections: copyResult.sections,
          angle: angle.trim(),
          brandColors: designAnalysis?.colors || null,
          projectId: req.params.projectId,
          autoContext: { imageContext, brandColors: designAnalysis?.colors || null },
        }, sse.sendEvent);

        await updateLandingPage(pageId, {
          image_slots: JSON.stringify(populatedImageSlots),
        });
        audit('images', 'generated', `${populatedImageSlots.filter(s => s.generated).length}/${imageSlots.length} images generated`);
      }

      // ── Phase 2D: HTML Generation ──
      const ctaElements = designAnalysis?.cta_elements || [];
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
      const rawAssembledHtml = assembleLandingPage({
        htmlTemplate,
        copySections: copyResult.sections,
        imageSlots: populatedImageSlots,
        ctaElements,
      });

      audit('html', 'generated', `HTML template: ${htmlTemplate.length} chars, assembled: ${rawAssembledHtml.length} chars`);

      const { html: assembledHtml } = postProcessLP(rawAssembledHtml, { project });
      audit('postprocess', 'applied', `Post-processed: ${rawAssembledHtml.length} → ${assembledHtml.length} chars`);
      audit('complete', 'finished', `Final LP: ${assembledHtml.length} chars`);

      await updateLandingPage(pageId, {
        status: 'completed',
        assembled_html: assembledHtml,
        audit_trail: JSON.stringify(auditTrail),
      });

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
    } finally {
      // ALWAYS release the per-project generation lock so a stuck-mid-generation
      // never blocks the next /generate call. PEF plan 2026-04-21 invariant #9.
      try {
        await releaseLPGenerationLock(req.params.projectId);
      } catch (releaseErr) {
        console.warn('[LPGen] releaseLPGenerationLock failed:', releaseErr.message);
      }
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

  // ── Inline placeholder safety net — never store {{...}} in assembled_html ──
  if (updates.assembled_html) {
    updates.assembled_html = updates.assembled_html.replace(/\{\{[\s]*publish_date[\s]*\}\}/gi, new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }));
    updates.assembled_html = updates.assembled_html.replace(/\{\{[\s]*author_name[\s]*\}\}/gi, 'Sarah Mitchell');
    updates.assembled_html = updates.assembled_html.replace(/\{\{[\s]*author_title[\s]*\}\}/gi, 'Health & Wellness Editor');
    updates.assembled_html = updates.assembled_html.replace(/\{\{[\s]*warning_box_text[\s]*\}\}/gi, 'The following article discusses findings that may change how you think about the products you use every day.');
    updates.assembled_html = updates.assembled_html.replace(/\{\{[\s]*TRENDING_CATEGORY[\s]*\}\}/gi, 'Health & Wellness');
    updates.assembled_html = updates.assembled_html.replace(/\{\{[^}]+\}\}/g, '');
    // Strip existing contrast safety CSS (may be outdated) then re-inject fresh
    updates.assembled_html = updates.assembled_html.replace(/<style[^>]*data-safety="contrast"[^>]*>[\s\S]*?<\/style>/gi, '');
    // Enforce background lightness floor then re-inject contrast CSS
    updates.assembled_html = enforceBackgroundLightness(updates.assembled_html).html;
    updates.assembled_html = injectContrastSafetyCSS(updates.assembled_html);
  }

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

  const persist = isPersistEnabled(req.body.persist);
  const { imageSlots, copySections, ctaLinks, htmlTemplate } = resolveDraftState(page, req.body);
  if (slot_index < 0 || slot_index >= imageSlots.length) {
    return res.status(400).json({ error: 'Invalid slot_index' });
  }

  const sse = createSSEStream(req, res);
  sse.sendEvent({ type: 'started', slot_index });

  (async () => {
    try {
      // Load project for post-processing metadata
      const regenProject = await getProject(req.params.projectId);
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
      const ctaElements = ctaLinks.length > 0 ? ctaLinks : (page.swipe_design_analysis ? JSON.parse(page.swipe_design_analysis).cta_elements || [] : []);

      const rawAssembledHtml = assembleLandingPage({
        htmlTemplate,
        copySections,
        imageSlots,
        ctaElements: ctaLinks.length > 0 ? ctaLinks : ctaElements,
      });
      const { html: assembledHtml } = postProcessLP(rawAssembledHtml, { project: regenProject });

      if (persist) {
        await updateLandingPage(req.params.pageId, {
          image_slots: JSON.stringify(imageSlots),
          assembled_html: assembledHtml,
        });
      }

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

  const persist = isPersistEnabled(req.body.persist);
  const { imageSlots, copySections, ctaLinks, htmlTemplate } = resolveDraftState(page, req.body);
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

    // Load project for post-processing metadata
    const uploadProject = await getProject(req.params.projectId);

    // Re-assemble HTML
    const ctaElements = ctaLinks.length > 0 ? ctaLinks : (page.swipe_design_analysis ? JSON.parse(page.swipe_design_analysis).cta_elements || [] : []);

    const rawAssembledHtml = assembleLandingPage({
      htmlTemplate,
      copySections,
      imageSlots,
      ctaElements: ctaLinks.length > 0 ? ctaLinks : ctaElements,
    });
    const { html: assembledHtml } = postProcessLP(rawAssembledHtml, { project: uploadProject });

    if (persist) {
      await updateLandingPage(req.params.pageId, {
        image_slots: JSON.stringify(imageSlots),
        assembled_html: assembledHtml,
      });
    }

    res.json({ slot: imageSlots[slotIndex], imageSlots, assembled_html: assembledHtml });
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
  const persist = isPersistEnabled(req.body.persist);
  const { imageSlots, copySections, ctaLinks, htmlTemplate } = resolveDraftState(page, req.body);
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

  // Load project for post-processing metadata
  const revertProject = await getProject(req.params.projectId);

  // Re-assemble HTML
  const ctaElements = ctaLinks.length > 0 ? ctaLinks : (page.swipe_design_analysis ? JSON.parse(page.swipe_design_analysis).cta_elements || [] : []);

  const rawAssembledHtml = assembleLandingPage({
    htmlTemplate,
    copySections,
    imageSlots,
    ctaElements: ctaLinks.length > 0 ? ctaLinks : ctaElements,
  });
  const { html: assembledHtml } = postProcessLP(rawAssembledHtml, { project: revertProject });

  if (persist) {
    await updateLandingPage(req.params.pageId, {
      image_slots: JSON.stringify(imageSlots),
      assembled_html: assembledHtml,
    });
  }

  res.json({ slot: imageSlots[slot_index], imageSlots, assembled_html: assembledHtml });
});

// ─── Visual QA Check ──────────────────────────────────────────────────────────
router.post('/:projectId/landing-pages/:pageId/visual-qa', async (req, res) => {
  const page = await getLandingPage(req.params.pageId);
  if (!page || page.project_id !== req.params.projectId) {
    return res.status(404).json({ error: 'Landing page not found' });
  }

  if (!page.assembled_html) {
    return res.status(400).json({ error: 'Landing page has no assembled HTML to check' });
  }

  try {
    // Mark QA as running
    await updateLandingPage(req.params.pageId, { qa_status: 'running' });

    // Run the visual QA check
    const qaResult = await runVisualQA(page.assembled_html, req.params.projectId);

    // Upload QA screenshot to Convex storage
    let qaScreenshotStorageId = null;
    if (qaResult.screenshotBuffer) {
      qaScreenshotStorageId = await uploadBuffer(qaResult.screenshotBuffer, 'image/jpeg');
    }

    // Save QA results
    const qaReport = JSON.stringify({
      passed: qaResult.passed,
      issues: qaResult.issues,
      summary: qaResult.summary,
      score: qaResult.score,
      checked_at: new Date().toISOString(),
    });

    await updateLandingPage(req.params.pageId, {
      qa_status: qaResult.passed ? 'passed' : 'failed',
      qa_report: qaReport,
      qa_issues_count: qaResult.issues.length,
      qa_screenshot_storageId: qaScreenshotStorageId,
    });

    res.json({
      success: true,
      passed: qaResult.passed,
      issues: qaResult.issues,
      summary: qaResult.summary,
      score: qaResult.score,
      issues_count: qaResult.issues.length,
      screenshot_storageId: qaScreenshotStorageId,
    });
  } catch (err) {
    console.error('[LPGen] Visual QA error:', err.message);
    await updateLandingPage(req.params.pageId, {
      qa_status: 'failed',
      qa_report: JSON.stringify({ error: err.message, checked_at: new Date().toISOString() }),
    });
    res.status(500).json({ error: err.message });
  }
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

  // ── Inline placeholder safety net — versions saved before fix may have {{...}} ──
  if (updates.assembled_html) {
    updates.assembled_html = updates.assembled_html.replace(/\{\{[\s]*publish_date[\s]*\}\}/gi, new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }));
    updates.assembled_html = updates.assembled_html.replace(/\{\{[\s]*author_name[\s]*\}\}/gi, 'Sarah Mitchell');
    updates.assembled_html = updates.assembled_html.replace(/\{\{[\s]*author_title[\s]*\}\}/gi, 'Health & Wellness Editor');
    updates.assembled_html = updates.assembled_html.replace(/\{\{[\s]*warning_box_text[\s]*\}\}/gi, 'The following article discusses findings that may change how you think about the products you use every day.');
    updates.assembled_html = updates.assembled_html.replace(/\{\{[\s]*TRENDING_CATEGORY[\s]*\}\}/gi, 'Health & Wellness');
    updates.assembled_html = updates.assembled_html.replace(/\{\{[^}]+\}\}/g, '');
    // Strip existing contrast safety CSS (may be outdated) then re-inject fresh
    updates.assembled_html = updates.assembled_html.replace(/<style[^>]*data-safety="contrast"[^>]*>[\s\S]*?<\/style>/gi, '');
    // Enforce background lightness floor then re-inject contrast CSS
    updates.assembled_html = enforceBackgroundLightness(updates.assembled_html).html;
    updates.assembled_html = injectContrastSafetyCSS(updates.assembled_html);
  }

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

  // Chief Checkpoint guard: pages awaiting review must go through
  // /approve-and-publish so the approval event lands in audit_trail and the
  // dashboard reminder is cleared. Expired reviews need to be restored first.
  if (page.status === 'pending_review') {
    return res.status(400).json({ error: 'Use /approve-and-publish for pages in review.' });
  }
  if (page.status === 'expired_review') {
    return res.status(400).json({ error: 'Restore this page to pending_review before publishing.' });
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

// ─── Approve & publish (Chief Checkpoint) ─────────────────────────────────────
// Accepts both `pending_review` (legacy auto-gen flow) AND
// `pending_image_selection` (PEF plan 2026-04-21 manual flow). For
// `pending_image_selection`: validates that every required image slot has
// an assignment, materializes the final image_slots from the assignments,
// then runs HTML template + assembly + post-processing before publishing.
router.post(
  '/:projectId/landing-pages/:pageId/approve-and-publish',
  requireRole('admin', 'manager'),
  async (req, res) => {
    const { projectId, pageId } = req.params;
    const page = await getLandingPage(pageId);
    if (!page || page.project_id !== projectId) {
      return res.status(404).json({ error: 'Landing page not found' });
    }

    // Idempotency: already-published → return the existing URL.
    if (page.status === 'published' && page.shopify_page_id) {
      return res.json({
        success: true,
        already_published: true,
        published_url: page.published_url,
        shopify_page_id: page.shopify_page_id,
        shopify_handle: page.shopify_handle,
      });
    }
    if (page.status === 'publishing') {
      return res.status(409).json({ error: 'Publish in progress.' });
    }
    if (page.status !== 'pending_review' && page.status !== 'pending_image_selection') {
      return res.status(409).json({ error: 'Page is not pending review.' });
    }

    const fromImageSelection = page.status === 'pending_image_selection';

    // ── pending_image_selection: validate slot assignments + materialize ──
    if (fromImageSelection) {
      let assignments = [];
      let candidates = [];
      try {
        assignments = page.image_slot_assignments ? JSON.parse(page.image_slot_assignments) : [];
        candidates = page.image_candidates ? JSON.parse(page.image_candidates) : [];
      } catch (parseErr) {
        return res.status(500).json({ error: `Failed to parse image candidates/assignments: ${parseErr.message}` });
      }

      // Required slots come from the LP's template.slot_definitions filtered to image slots.
      // If no template (manual flow without template selected), require at least 1 image.
      let requiredSlotIds = [];
      if (page.template_id) {
        try {
          const template = await getLPTemplate(page.template_id);
          const slotDefs = template?.slot_definitions ? (
            typeof template.slot_definitions === 'string'
              ? JSON.parse(template.slot_definitions)
              : template.slot_definitions
          ) : [];
          requiredSlotIds = slotDefs
            .filter((s) => s?.type === 'image' && (s.required ?? true))
            .map((s) => s.id || s.slot_id || s.name)
            .filter(Boolean);
        } catch (tplErr) {
          console.warn('[LPChiefApprove] Could not load template slot defs:', tplErr.message);
        }
      }
      if (requiredSlotIds.length === 0 && Array.isArray(candidates) && candidates.length > 0) {
        // No template-declared required slots — require at least one assignment.
        if (assignments.length === 0) {
          return res.status(400).json({
            error: 'No image assignments found. Place at least one image before publishing.',
          });
        }
      } else {
        const filledSlotIds = new Set(assignments.map((a) => a.slot_id));
        const missing = requiredSlotIds.filter((id) => !filledSlotIds.has(id));
        if (missing.length > 0) {
          return res.status(400).json({
            error: `Not all image slots filled. Place an image in: ${missing.join(', ')}`,
            missing_slots: missing,
          });
        }
      }

      // Materialize final image_slots from candidate-assignment join.
      const candidateById = new Map(candidates.map((c) => [c.candidate_id, c]));
      const materializedImageSlots = assignments.map((a) => {
        const candidate = candidateById.get(a.candidate_id);
        if (!candidate) return null;
        return {
          slot_id: a.slot_id,
          storageId: candidate.storageId,
          storageUrl: candidate.storageUrl,
          aspect_ratio: candidate.aspect_ratio,
          concept_label: candidate.concept_label,
          assigned_at: a.assigned_at,
        };
      }).filter(Boolean);

      await updateLandingPage(pageId, {
        image_slots: JSON.stringify(materializedImageSlots),
      });

      // Generate HTML template + assemble + post-process — deferred from /generate.
      try {
        let copySections = [];
        try {
          copySections = page.copy_sections ? JSON.parse(page.copy_sections) : [];
        } catch { copySections = []; }
        const sse = { sendEvent: () => {} };  // approve-and-publish is request/response, no SSE
        const effectiveDesign = createDefaultDesignSpec(copySections);
        const htmlTemplate = await generateHtmlTemplate({
          designAnalysis: effectiveDesign,
          copySections,
          imageSlots: materializedImageSlots,
          ctaElements: [],
          projectId,
        }, sse.sendEvent);
        await updateLandingPage(pageId, { html_template: htmlTemplate });

        const rawAssembledHtml = assembleLandingPage({
          htmlTemplate,
          copySections,
          imageSlots: materializedImageSlots,
          ctaElements: [],
        });
        const project = await getProject(projectId).catch(() => null);
        const { html: assembledHtml } = postProcessLP(rawAssembledHtml, { project });
        await updateLandingPage(pageId, { assembled_html: assembledHtml });
      } catch (htmlErr) {
        console.error('[LPChiefApprove] HTML assembly failed:', htmlErr.message);
        return res.status(500).json({ error: `HTML assembly failed: ${htmlErr.message}` });
      }

      // Write the batched image-selection-session audit entry.
      await appendChiefImageAuditEntry(pageId, {
        step: 'image_selection',
        action: 'session_committed',
        detail: `${assignments.length} slot assignment(s) committed at approve time`,
        assignments,
      });
    }

    // Set a mutex status so a double-click lands on the 409 branch above.
    await updateLandingPage(pageId, { status: 'publishing' });
    await appendLPAuditTrail(pageId, {
      step: 'approval',
      action: 'approved',
      detail: `approved by ${req.user?.username || 'unknown'}${fromImageSelection ? ' (with chief image selection)' : ''}`,
    });

    try {
      const result = await publishToShopify(pageId, projectId);
      await clearChiefReviewTodo(pageId);
      return res.json({
        success: true,
        published_url: result.published_url,
        shopify_page_id: result.shopify_page_id,
        shopify_handle: result.shopify_handle,
        from_image_selection: fromImageSelection,
      });
    } catch (err) {
      console.error('[LPChiefApprove] Publish error:', err.message);
      // Rollback: put the LP back into the previous review status so the user can retry.
      const rollbackStatus = fromImageSelection ? 'pending_image_selection' : 'pending_review';
      try {
        await updateLandingPage(pageId, { status: rollbackStatus });
        await appendLPAuditTrail(pageId, {
          step: 'approval',
          action: 'publish_failed',
          detail: err.message,
        });
      } catch (rollbackErr) {
        console.warn('[LPChiefApprove] Rollback failed:', rollbackErr.message);
      }
      return res.status(500).json({ error: err.message });
    }
  }
);

// ─── Retry publish (after publish_failed) ─────────────────────────────────────
// PEF plan 2026-04-21 — when Shopify flakes mid-publish and the LP lands in
// `publish_failed`, this re-runs the publish step without re-doing copy/images.
router.post(
  '/:projectId/landing-pages/:pageId/retry-publish',
  requireRole('admin', 'manager'),
  async (req, res) => {
    const { projectId, pageId } = req.params;
    const page = await getLandingPage(pageId);
    if (!page || page.project_id !== projectId) {
      return res.status(404).json({ error: 'Landing page not found' });
    }
    if (page.status !== 'publish_failed' && page.status !== 'smoke_failed') {
      return res.status(409).json({ error: `Cannot retry publish from status "${page.status}".` });
    }
    if (!page.assembled_html) {
      return res.status(400).json({ error: 'No assembled_html on page; cannot retry publish.' });
    }

    await updateLandingPage(pageId, { status: 'publishing' });
    try {
      const result = await publishToShopify(pageId, projectId);
      await appendLPAuditTrail(pageId, {
        step: 'publish',
        action: 'retry_succeeded',
        detail: `Retried by ${req.user?.username || 'unknown'}`,
      });
      return res.json({ success: true, published_url: result.published_url, shopify_page_id: result.shopify_page_id });
    } catch (err) {
      console.error('[LPRetryPublish] Publish error:', err.message);
      try {
        await updateLandingPage(pageId, { status: 'publish_failed' });
      } catch {}
      await appendLPAuditTrail(pageId, {
        step: 'publish',
        action: 'retry_failed',
        detail: err.message,
      });
      return res.status(500).json({ error: err.message });
    }
  }
);

// ─── Place image into a slot (Chief Image Selection) ──────────────────────────
// PEF plan 2026-04-21 — drag-and-drop placement endpoint. Validates project
// match (cross-project guard), optimistic-lock on updated_at (concurrent-tab
// race guard), then upserts into image_slot_assignments.
router.post(
  '/:projectId/landing-pages/:pageId/place-image',
  requireRole('admin', 'manager'),
  async (req, res) => {
    const { projectId, pageId } = req.params;
    const { slot_id, candidate_id, updated_at } = req.body || {};
    if (!slot_id || typeof slot_id !== 'string') {
      return res.status(400).json({ error: 'slot_id is required' });
    }
    if (!candidate_id || typeof candidate_id !== 'string') {
      return res.status(400).json({ error: 'candidate_id is required' });
    }

    const page = await getLandingPage(pageId);
    if (!page || page.project_id !== projectId) {
      return res.status(404).json({ error: 'Landing page not found' });
    }
    if (page.status !== 'pending_image_selection') {
      return res.status(409).json({ error: `Cannot place image when LP is in status "${page.status}".` });
    }

    let candidates = [];
    try {
      candidates = page.image_candidates ? JSON.parse(page.image_candidates) : [];
    } catch (parseErr) {
      return res.status(500).json({ error: `Failed to parse image_candidates: ${parseErr.message}` });
    }

    // Cross-project guard — all candidates on a page belong to that page's project.
    // Verify the candidate is in this LP's library; if not, 403.
    const candidate = candidates.find((c) => c.candidate_id === candidate_id);
    if (!candidate) {
      return res.status(403).json({ error: 'Candidate not in this LP\'s library (cross-project placement forbidden).' });
    }

    let assignments = [];
    try {
      assignments = page.image_slot_assignments ? JSON.parse(page.image_slot_assignments) : [];
    } catch {
      assignments = [];
    }

    // Upsert: replace existing assignment for this slot_id.
    const filtered = assignments.filter((a) => a.slot_id !== slot_id);
    filtered.push({ slot_id, candidate_id, assigned_at: new Date().toISOString() });

    try {
      await updateLandingPage(pageId, {
        image_slot_assignments: JSON.stringify(filtered),
        expected_updated_at: updated_at || undefined,
      });
    } catch (err) {
      const msg = String(err.message || '');
      if (msg.includes('OPTIMISTIC_LOCK_CONFLICT')) {
        const fresh = await getLandingPage(pageId);
        return res.status(409).json({
          error: 'Page changed since you loaded it. Refresh to see latest state.',
          fresh_updated_at: fresh?.updated_at,
        });
      }
      throw err;
    }

    return res.json({ success: true, assignments: filtered });
  }
);

// ─── Remove image from a slot ────────────────────────────────────────────────
router.post(
  '/:projectId/landing-pages/:pageId/remove-image',
  requireRole('admin', 'manager'),
  async (req, res) => {
    const { projectId, pageId } = req.params;
    const { slot_id, updated_at } = req.body || {};
    if (!slot_id || typeof slot_id !== 'string') {
      return res.status(400).json({ error: 'slot_id is required' });
    }

    const page = await getLandingPage(pageId);
    if (!page || page.project_id !== projectId) {
      return res.status(404).json({ error: 'Landing page not found' });
    }
    if (page.status !== 'pending_image_selection') {
      return res.status(409).json({ error: `Cannot remove image when LP is in status "${page.status}".` });
    }

    let assignments = [];
    try {
      assignments = page.image_slot_assignments ? JSON.parse(page.image_slot_assignments) : [];
    } catch {
      assignments = [];
    }
    const filtered = assignments.filter((a) => a.slot_id !== slot_id);

    try {
      await updateLandingPage(pageId, {
        image_slot_assignments: JSON.stringify(filtered),
        expected_updated_at: updated_at || undefined,
      });
    } catch (err) {
      const msg = String(err.message || '');
      if (msg.includes('OPTIMISTIC_LOCK_CONFLICT')) {
        const fresh = await getLandingPage(pageId);
        return res.status(409).json({
          error: 'Page changed since you loaded it. Refresh to see latest state.',
          fresh_updated_at: fresh?.updated_at,
        });
      }
      throw err;
    }

    return res.json({ success: true, assignments: filtered });
  }
);

// ─── Regenerate a single candidate (re-fire Nano Banana 2 with same prompt) ──
// Library cap of CANDIDATE_LIBRARY_CAP — past that, oldest *unplaced* candidate
// is evicted (placed candidates are protected).
router.post(
  '/:projectId/landing-pages/:pageId/regenerate-candidate',
  requireRole('admin', 'manager'),
  async (req, res) => {
    const { projectId, pageId } = req.params;
    const { candidate_id } = req.body || {};
    if (!candidate_id || typeof candidate_id !== 'string') {
      return res.status(400).json({ error: 'candidate_id is required' });
    }

    const page = await getLandingPage(pageId);
    if (!page || page.project_id !== projectId) {
      return res.status(404).json({ error: 'Landing page not found' });
    }
    if (page.status !== 'pending_image_selection') {
      return res.status(409).json({ error: `Cannot regenerate when LP is in status "${page.status}".` });
    }

    // Daily regenerate cap.
    const dailyRegenCap = await readDailyCap('daily_lp_regenerate_cap', DEFAULT_DAILY_LP_REGEN_CAP);
    // (Cap counter check — best-effort; relies on audit_trail or separate counter
    // table for full accuracy. For Phase 1 we do a simple per-LP-session count.)
    let auditTrail = [];
    try { auditTrail = page.audit_trail ? JSON.parse(page.audit_trail) : []; } catch { auditTrail = []; }
    const regenToday = auditTrail.filter((e) => e.step === 'regenerate' && e.timestamp?.startsWith(new Date().toISOString().slice(0, 10))).length;
    if (regenToday >= dailyRegenCap) {
      return res.status(429).json({
        error: `Daily regenerate cap (${dailyRegenCap}/day per project) reached. Try again tomorrow.`,
      });
    }

    let candidates = [];
    try { candidates = page.image_candidates ? JSON.parse(page.image_candidates) : []; } catch { candidates = []; }
    const original = candidates.find((c) => c.candidate_id === candidate_id);
    if (!original) {
      return res.status(404).json({ error: 'Candidate not found in library.' });
    }

    // LRU eviction if at cap. Protect placed candidates.
    let assignments = [];
    try { assignments = page.image_slot_assignments ? JSON.parse(page.image_slot_assignments) : []; } catch { assignments = []; }
    const placedIds = new Set(assignments.map((a) => a.candidate_id));
    if (candidates.length >= CANDIDATE_LIBRARY_CAP) {
      // Evict oldest unplaced candidate.
      const unplaced = candidates.filter((c) => !placedIds.has(c.candidate_id));
      if (unplaced.length > 0) {
        unplaced.sort((a, b) => (a.generated_at || '').localeCompare(b.generated_at || ''));
        const evicted = unplaced[0];
        candidates = candidates.filter((c) => c.candidate_id !== evicted.candidate_id);
      }
    }

    // Re-fire Nano Banana 2 with the same prompt.
    try {
      const newCandidates = await generateImageCandidates({
        projectId,
        lpId: pageId,
        concepts: [{
          concept_label: original.concept_label,
          nano_banana_prompt: original.nano_banana_prompt,
          aspect_ratio: original.aspect_ratio,
          suggested_slot_role: original.suggested_slot_role,
        }],
      }, () => {});
      candidates.push(...newCandidates);

      await updateLandingPage(pageId, {
        image_candidates: JSON.stringify(candidates),
      });
      await appendLPAuditTrail(pageId, {
        step: 'regenerate',
        action: 'candidate_regenerated',
        detail: `Concept: ${original.concept_label}; new candidate count: ${candidates.length}`,
      });

      return res.json({
        success: true,
        new_candidate: newCandidates[0] || null,
        total_candidates: candidates.length,
      });
    } catch (err) {
      console.error('[LPRegenCandidate] error:', err.message);
      return res.status(500).json({ error: err.message });
    }
  }
);

// ─── Reject with notes (Chief Checkpoint) ─────────────────────────────────────
// Accepts both `pending_review` and `pending_image_selection`.
router.post(
  '/:projectId/landing-pages/:pageId/reject-with-notes',
  requireRole('admin', 'manager'),
  async (req, res) => {
    const { projectId, pageId } = req.params;
    const notes = typeof req.body?.notes === 'string' ? req.body.notes.trim() : '';
    if (!notes) {
      return res.status(400).json({ error: 'notes is required' });
    }

    const page = await getLandingPage(pageId);
    if (!page || page.project_id !== projectId) {
      return res.status(404).json({ error: 'Landing page not found' });
    }
    if (page.status !== 'pending_review' && page.status !== 'pending_image_selection') {
      return res.status(409).json({ error: 'Page is not pending review.' });
    }

    await updateLandingPage(pageId, { status: 'draft' });
    await appendLPAuditTrail(pageId, {
      step: 'approval',
      action: 'rejected',
      detail: notes,
      by: req.user?.username,
    });
    await clearChiefReviewTodo(pageId);
    res.json({ success: true });
  }
);

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

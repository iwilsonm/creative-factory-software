/**
 * LP (Landing Page) Generator Service — Phase 1 + Phase 2
 *
 * Phase A: Extract text from uploaded swipe PDF using existing PDF extraction logic
 * Phase B: Generate landing page copy via Claude Sonnet multi-message conversation
 * Phase 2A: Design analysis — convert PDF pages to images, analyze via Claude vision
 * Phase 2C: Image generation — generate images for each slot via Gemini
 * Phase 2D: HTML generation — generate self-contained HTML page via Claude
 * Phase 2E: Placeholder replacement — assemble final HTML with copy, images, CTAs
 *
 * Uses the same Anthropic wrapper (services/anthropic.js) as the rest of the platform.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pdf = require('pdf-parse');

import { chat, chatWithMultipleImages } from './anthropic.js';
import { generateImage } from './gemini.js';
import { getDocsByProject, uploadBuffer, getStorageUrl } from '../convexClient.js';

// ─── Phase A: Extract text from a swipe PDF buffer ──────────────────────────

/**
 * Extract text content from a PDF file on disk.
 * Reuses the same pdf-parse library as routes/upload.js.
 *
 * @param {string} filePath - Path to the PDF file
 * @returns {Promise<string>} Extracted text
 */
export async function extractPdfText(filePath) {
  const buffer = fs.readFileSync(filePath);
  const data = await pdf(buffer);
  return data.text.trim();
}

// ─── Phase 2A: PDF to images + Claude vision design analysis ────────────────

/**
 * Convert PDF pages to images using pdftoppm.
 * Falls back to a single-page approach if pdftoppm is not available.
 *
 * @param {string} pdfPath - Path to the PDF file
 * @param {number} [maxPages=5] - Maximum pages to convert
 * @returns {Promise<Array<{base64: string, mimeType: string, pageNum: number}>>}
 */
async function pdfToImages(pdfPath, maxPages = 5) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-pdf-'));
  const outputPrefix = path.join(tmpDir, 'page');

  try {
    // Use pdftoppm to convert PDF pages to JPEG images
    // -jpeg for JPEG output, -r 150 for 150 DPI (good balance of quality/size),
    // -l maxPages to limit pages
    execSync(
      `pdftoppm -jpeg -r 150 -l ${maxPages} "${pdfPath}" "${outputPrefix}"`,
      { timeout: 30000 }
    );

    // Read generated images
    const files = fs.readdirSync(tmpDir)
      .filter(f => f.endsWith('.jpg'))
      .sort(); // pdftoppm names: page-01.jpg, page-02.jpg, etc.

    const images = [];
    for (let i = 0; i < files.length && i < maxPages; i++) {
      const imgPath = path.join(tmpDir, files[i]);
      const imgBuffer = fs.readFileSync(imgPath);
      images.push({
        base64: imgBuffer.toString('base64'),
        mimeType: 'image/jpeg',
        pageNum: i + 1,
      });
    }

    return images;
  } finally {
    // Clean up temp directory
    try {
      const files = fs.readdirSync(tmpDir);
      for (const f of files) {
        fs.unlinkSync(path.join(tmpDir, f));
      }
      fs.rmdirSync(tmpDir);
    } catch {}
  }
}

/**
 * Analyze swipe PDF design using Claude Sonnet vision API.
 * Converts PDF pages to images, sends them to Claude, and returns a design specification JSON.
 *
 * @param {string} pdfPath - Path to the PDF file
 * @param {(event: object) => void} sendEvent - SSE event callback
 * @param {string} projectId - For cost logging
 * @returns {Promise<object>} Design analysis JSON
 */
export async function analyzeSwipeDesign(pdfPath, sendEvent, projectId) {
  sendEvent({ type: 'progress', step: 'design_converting', message: 'Converting PDF pages to images...' });

  const pageImages = await pdfToImages(pdfPath, 5);

  if (pageImages.length === 0) {
    throw new Error('Failed to extract any pages from the swipe PDF.');
  }

  sendEvent({
    type: 'progress',
    step: 'design_analyzing',
    message: `Analyzing ${pageImages.length} page${pageImages.length > 1 ? 's' : ''} with Claude vision...`,
  });

  const systemPrompt = `You are a web design analyst specializing in landing page design. You analyze visual designs from PDF screenshots and produce detailed design specifications that can be used to recreate similar layouts in HTML/CSS.

You must respond with ONLY a valid JSON object — no markdown, no prose.`;

  const analysisPrompt = `Analyze these landing page design screenshots and produce a detailed design specification JSON.

Study the visual layout, typography, colors, spacing, section structure, image placements, and call-to-action elements.

RESPOND WITH A JSON OBJECT in this exact format:
{
  "layout": {
    "max_width": "e.g. 800px",
    "alignment": "center",
    "background_color": "#hex",
    "content_padding": "e.g. 20px 40px"
  },
  "typography": {
    "heading_font": "font name or generic family",
    "body_font": "font name or generic family",
    "heading_color": "#hex",
    "body_color": "#hex",
    "heading_sizes": {
      "h1": "e.g. 48px",
      "h2": "e.g. 36px",
      "h3": "e.g. 24px"
    },
    "body_size": "e.g. 18px",
    "line_height": "e.g. 1.6"
  },
  "colors": {
    "primary": "#hex (main accent / CTA color)",
    "secondary": "#hex",
    "background": "#hex",
    "text": "#hex",
    "accent": "#hex",
    "cta_background": "#hex",
    "cta_text": "#hex"
  },
  "sections": [
    {
      "id": "section_identifier (e.g. hero, problem, solution, benefits, proof, offer, guarantee, cta, ps)",
      "type": "hero | text | image_text | benefits_list | testimonial | cta | guarantee | faq",
      "background": "#hex or gradient",
      "padding": "e.g. 60px 0",
      "notes": "Brief description of this section's visual style"
    }
  ],
  "image_slots": [
    {
      "slot_id": "image_1",
      "location": "Which section this image appears in",
      "description": "What kind of image goes here (e.g. hero product shot, lifestyle photo, before/after)",
      "suggested_size": "e.g. 600x400",
      "aspect_ratio": "e.g. 3:2 or 16:9 or 1:1"
    }
  ],
  "cta_elements": [
    {
      "cta_id": "cta_1",
      "location": "Which section this CTA appears in",
      "style": "button | text_link | banner",
      "text_suggestion": "e.g. Order Now, Get Started, Buy Now",
      "background": "#hex",
      "text_color": "#hex",
      "border_radius": "e.g. 8px",
      "padding": "e.g. 16px 32px",
      "font_size": "e.g. 20px",
      "font_weight": "bold"
    }
  ],
  "spacing": {
    "section_gap": "e.g. 60px",
    "element_gap": "e.g. 24px",
    "paragraph_gap": "e.g. 16px"
  },
  "style_notes": "Overall style description: modern/classic/bold/minimal, any special effects like gradients, borders, dividers, etc."
}

Important:
- Identify ALL distinct image placement areas and create an image_slot for each
- Identify ALL call-to-action buttons/links and create a cta_element for each
- Use actual hex colors observed in the design
- The sections array should map to the logical flow of the landing page
- If you can identify specific Google Fonts, name them; otherwise use generic families`;

  const messages = [{ role: 'system', content: systemPrompt }];

  const response = await chatWithMultipleImages(
    messages,
    analysisPrompt,
    pageImages,
    'claude-sonnet-4-6',
    {
      max_tokens: 16384,
      operation: 'lp_design_analysis',
      projectId,
      response_format: { type: 'json_object' },
      timeout: 120000,
    }
  );

  // Parse the design analysis
  let designSpec;
  try {
    designSpec = JSON.parse(response);
  } catch {
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        designSpec = JSON.parse(jsonMatch[0]);
      } catch {
        throw new Error('Failed to parse design analysis as JSON.');
      }
    } else {
      throw new Error('Design analysis response contained no JSON.');
    }
  }

  sendEvent({
    type: 'progress',
    step: 'design_complete',
    message: `Design analysis complete: ${designSpec.sections?.length || 0} sections, ${designSpec.image_slots?.length || 0} image slots, ${designSpec.cta_elements?.length || 0} CTAs`,
  });

  return designSpec;
}

// ─── Foundational Docs helpers ──────────────────────────────────────────────

/**
 * Get the 4 foundational documents for a project.
 * Returns an object with { research, avatar, offer_brief, necessary_beliefs }.
 * Only returns approved docs (latest version of each type).
 */
async function getFoundationalDocs(projectId) {
  const docs = await getDocsByProject(projectId);

  // Group by doc_type, return only latest version of each
  const latest = {};
  for (const doc of docs) {
    if (!latest[doc.doc_type] || doc.version > latest[doc.doc_type].version) {
      latest[doc.doc_type] = doc;
    }
  }

  return {
    research: latest.research?.content || null,
    avatar: latest.avatar?.content || null,
    offer_brief: latest.offer_brief?.content || null,
    necessary_beliefs: latest.necessary_beliefs?.content || null,
  };
}

/**
 * Check that foundational docs exist and are approved.
 * Returns { ready: boolean, missing: string[] }
 */
export async function checkDocsReady(projectId) {
  const docs = await getDocsByProject(projectId);
  const latest = {};
  for (const doc of docs) {
    if (!latest[doc.doc_type] || doc.version > latest[doc.doc_type].version) {
      latest[doc.doc_type] = doc;
    }
  }

  const required = ['research', 'avatar', 'offer_brief', 'necessary_beliefs'];
  const missing = required.filter(type => !latest[type]?.content);
  const unapproved = required.filter(type => latest[type]?.content && !latest[type]?.approved);

  return {
    ready: missing.length === 0,
    missing,
    unapproved,
  };
}

// ─── Phase B: Multi-message copy generation ─────────────────────────────────

/**
 * Generate landing page copy using a multi-message Claude Sonnet conversation.
 *
 * @param {object} params
 * @param {string} params.projectId
 * @param {string} params.angle - The marketing angle/hook
 * @param {string} params.swipeText - Extracted text from the swipe PDF
 * @param {number} [params.wordCount=1200] - Target word count
 * @param {string} [params.additionalDirection] - Optional extra instructions
 * @param {(event: object) => void} sendEvent - SSE event callback
 * @returns {Promise<object>} Generated copy sections as parsed JSON
 */
export async function generateLandingPageCopy({
  projectId,
  angle,
  swipeText,
  wordCount = 1200,
  additionalDirection,
}, sendEvent) {
  sendEvent({ type: 'progress', step: 'loading_docs', message: 'Loading foundational documents...' });

  const docs = await getFoundationalDocs(projectId);
  const missingDocs = [];
  if (!docs.research) missingDocs.push('research');
  if (!docs.avatar) missingDocs.push('avatar');
  if (!docs.offer_brief) missingDocs.push('offer_brief');
  if (!docs.necessary_beliefs) missingDocs.push('necessary_beliefs');

  if (missingDocs.length > 0) {
    throw new Error(`Missing foundational documents: ${missingDocs.join(', ')}. Generate or upload these first.`);
  }

  sendEvent({ type: 'progress', step: 'generating', message: 'Generating landing page copy...' });

  // ── Message 1: System prompt + foundational docs context ──
  const systemPrompt = `You are an elite direct response copywriter specializing in high-converting landing pages for e-commerce and direct-to-consumer brands. You write copy that:
- Hooks readers emotionally within the first 2 sentences
- Builds belief through storytelling, social proof, and mechanism reveals
- Overcomes objections before they arise
- Drives urgency and action without being sleazy or over-hyped
- Uses short paragraphs, conversational tone, and vivid language
- Mirrors the target customer's own words and emotional language

You have been trained on the foundational research documents for this product. You understand the customer avatar, their beliefs, the offer positioning, and the research that backs it all up.

CRITICAL: You must respond with a valid JSON object containing an array of copy sections. Each section has a "type" and "content" field. Do not include any text outside the JSON.`;

  const docsMessage = `Here are the foundational research documents for this product:

=== CUSTOMER AVATAR ===
${docs.avatar}

=== OFFER BRIEF ===
${docs.offer_brief}

=== NECESSARY BELIEFS ===
${docs.necessary_beliefs}

=== DEEP RESEARCH ===
${docs.research}

Study these documents carefully. You will use them to write a landing page in the next message.`;

  // ── Message 2: Swipe reference + generation instructions ──
  const generateMessage = `Now write a landing page using the product knowledge from the documents above.

MARKETING ANGLE / HOOK:
${angle}

TARGET WORD COUNT: approximately ${wordCount} words

${swipeText ? `SWIPE FILE REFERENCE (use this as structural and tonal inspiration — do NOT copy it verbatim):
${swipeText.slice(0, 15000)}
${swipeText.length > 15000 ? '\n[... swipe text truncated for context length ...]' : ''}` : 'No swipe file provided — use your own best judgment for structure and flow.'}

${additionalDirection ? `ADDITIONAL DIRECTION FROM THE USER:
${additionalDirection}` : ''}

RESPOND WITH A JSON OBJECT in this exact format:
{
  "sections": [
    { "type": "headline", "content": "The main headline text" },
    { "type": "subheadline", "content": "Supporting subheadline" },
    { "type": "lead", "content": "The opening hook / lead section (2-4 paragraphs)" },
    { "type": "problem", "content": "Problem agitation section" },
    { "type": "solution", "content": "Solution / mechanism reveal" },
    { "type": "benefits", "content": "Benefits breakdown" },
    { "type": "proof", "content": "Social proof / testimonials / credibility" },
    { "type": "offer", "content": "The offer presentation" },
    { "type": "guarantee", "content": "Risk reversal / guarantee" },
    { "type": "cta", "content": "Final call to action" },
    { "type": "ps", "content": "P.S. section (optional urgency/scarcity)" }
  ]
}

Important:
- You may add additional sections if the copy flow requires it (e.g., "story", "objection_handling", "faq")
- Each section's "content" should be fully written copy, not outlines or bullet points
- Write at approximately ${wordCount} words total across all sections
- Use the customer's language from the avatar and research documents
- Mirror the emotional tone and structure of the swipe file reference if provided
- Every section must have a "type" (short lowercase identifier) and "content" (the actual copy)`;

  // Build the multi-message conversation
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: docsMessage },
    { role: 'assistant', content: 'I\'ve carefully studied all four foundational documents. I understand the customer avatar, their beliefs and objections, the offer positioning, and the supporting research. I\'m ready to write the landing page. Please provide the angle, swipe reference, and any additional direction.' },
    { role: 'user', content: generateMessage },
  ];

  sendEvent({ type: 'progress', step: 'calling_api', message: 'Claude is writing your landing page copy...' });

  const response = await chat(messages, 'claude-sonnet-4-6', {
    max_tokens: 16384,
    operation: 'lp_generation',
    projectId,
    response_format: { type: 'json_object' },
    timeout: 180000, // 3 minutes — landing pages are long
  });

  sendEvent({ type: 'progress', step: 'parsing', message: 'Parsing generated copy...' });

  // Parse the response
  let parsed;
  try {
    parsed = JSON.parse(response);
  } catch {
    // Try to extract JSON from the response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch {
        throw new Error('Failed to parse generated copy as JSON. The AI response was malformed.');
      }
    } else {
      throw new Error('Failed to parse generated copy. No JSON found in response.');
    }
  }

  if (!parsed.sections || !Array.isArray(parsed.sections)) {
    throw new Error('Generated copy is missing the "sections" array.');
  }

  // Validate sections
  const validSections = parsed.sections.filter(s => s.type && s.content);
  if (validSections.length === 0) {
    throw new Error('Generated copy has no valid sections.');
  }

  sendEvent({ type: 'progress', step: 'copy_complete', message: `Generated ${validSections.length} copy sections` });

  return { sections: validSections };
}

// ─── Phase 2C: Image generation via Gemini ──────────────────────────────────

/**
 * Generate images for each slot defined in the design analysis.
 *
 * @param {object} params
 * @param {Array} params.imageSlots - Image slot definitions from design analysis
 * @param {Array} params.copySections - Generated copy sections (for context)
 * @param {string} params.angle - The marketing angle
 * @param {string} params.projectId - For cost logging
 * @param {(event: object) => void} sendEvent - SSE event callback
 * @returns {Promise<Array>} Image slots with storageId populated
 */
export async function generateSlotImages({
  imageSlots,
  copySections,
  angle,
  projectId,
}, sendEvent) {
  if (!imageSlots || imageSlots.length === 0) {
    sendEvent({ type: 'progress', step: 'images_skipped', message: 'No image slots defined — skipping image generation.' });
    return [];
  }

  const totalSlots = imageSlots.length;
  sendEvent({
    type: 'progress',
    step: 'images_starting',
    message: `Generating ${totalSlots} image${totalSlots > 1 ? 's' : ''} via Gemini...`,
  });

  // Build brief context from copy sections for prompt enrichment
  const copyContext = copySections
    .slice(0, 5)
    .map(s => `${s.type}: ${s.content.slice(0, 200)}`)
    .join('\n');

  const results = [];

  for (let i = 0; i < imageSlots.length; i++) {
    const slot = imageSlots[i];
    const slotNum = i + 1;

    sendEvent({
      type: 'progress',
      step: 'image_generating',
      message: `Generating image ${slotNum}/${totalSlots}: ${slot.description || slot.slot_id}...`,
      imageProgress: { current: slotNum, total: totalSlots, slotId: slot.slot_id },
    });

    // Build a rich prompt for Gemini from the slot description + context
    const imagePrompt = `Create a professional, high-quality image for a landing page.

IMAGE PURPOSE: ${slot.description || 'Product/lifestyle image for landing page'}
SECTION: ${slot.location || 'Landing page section'}
MARKETING ANGLE: ${angle}

CONTEXT FROM THE LANDING PAGE COPY:
${copyContext}

IMPORTANT:
- Create a photorealistic, professional image suitable for a direct-to-consumer landing page
- No text, watermarks, or logos in the image
- The image should evoke trust, quality, and professionalism
- Match the mood and tone implied by the marketing angle
- High contrast, well-lit, commercial photography style`;

    // Map slot aspect ratio to Gemini format
    let aspectRatio = '16:9'; // default for landing page images
    if (slot.aspect_ratio) {
      // Normalize: "3:2" → "3:2", "16:9" → "16:9", "1:1" → "1:1"
      const normalized = slot.aspect_ratio.replace(/\s/g, '');
      if (['1:1', '3:2', '2:3', '16:9', '9:16', '4:3', '3:4'].includes(normalized)) {
        aspectRatio = normalized;
      }
    }

    try {
      const { imageBuffer, mimeType } = await generateImage(imagePrompt, aspectRatio);

      // Upload to Convex storage
      const storageId = await uploadBuffer(imageBuffer, mimeType);
      const storageUrl = await getStorageUrl(storageId);

      results.push({
        ...slot,
        storageId: storageId,
        original_storageId: storageId,
        storageUrl: storageUrl,
        generated: true,
      });

      sendEvent({
        type: 'progress',
        step: 'image_complete',
        message: `Image ${slotNum}/${totalSlots} generated successfully`,
        imageProgress: { current: slotNum, total: totalSlots, slotId: slot.slot_id, done: true },
      });
    } catch (err) {
      console.error(`[LPGen] Image generation failed for slot ${slot.slot_id}:`, err.message);

      // Non-fatal — continue with other slots, mark this one as failed
      results.push({
        ...slot,
        storageId: null,
        generated: false,
        error: err.message,
      });

      sendEvent({
        type: 'progress',
        step: 'image_failed',
        message: `Image ${slotNum}/${totalSlots} failed: ${err.message}`,
        imageProgress: { current: slotNum, total: totalSlots, slotId: slot.slot_id, error: err.message },
      });
    }
  }

  const successCount = results.filter(r => r.generated).length;
  sendEvent({
    type: 'progress',
    step: 'images_complete',
    message: `Image generation complete: ${successCount}/${totalSlots} images generated`,
  });

  return results;
}

// ─── Phase 2D: HTML template generation via Claude ──────────────────────────

/**
 * Generate a complete self-contained HTML page from the design analysis and placeholder lists.
 *
 * @param {object} params
 * @param {object} params.designAnalysis - Design spec from Phase 2A
 * @param {Array} params.copySections - Copy section definitions (type + content) for placeholders
 * @param {Array} params.imageSlots - Image slot definitions for placeholders
 * @param {Array} params.ctaElements - CTA element definitions for placeholders
 * @param {string} params.projectId - For cost logging
 * @param {(event: object) => void} sendEvent - SSE event callback
 * @returns {Promise<string>} Complete HTML string with placeholders
 */
export async function generateHtmlTemplate({
  designAnalysis,
  copySections,
  imageSlots,
  ctaElements,
  projectId,
}, sendEvent) {
  sendEvent({ type: 'progress', step: 'html_generating', message: 'Claude is generating the HTML template...' });

  // Build placeholder reference lists
  const sectionPlaceholders = copySections
    .map(s => `  {{${s.type}}} — ${s.type} section copy`)
    .join('\n');

  const imagePlaceholders = (imageSlots || [])
    .map((slot, i) => `  {{image_${i + 1}}} — ${slot.description || slot.location || 'Image'} (${slot.suggested_size || 'auto'})`)
    .join('\n');

  const ctaPlaceholders = (ctaElements || [])
    .map((cta, i) => `  {{cta_${i + 1}_url}} — URL for ${cta.location || 'CTA'}\n  {{cta_${i + 1}_text}} — Button text for ${cta.location || 'CTA'}`)
    .join('\n');

  const systemPrompt = `You are an expert HTML/CSS developer specializing in high-converting landing pages. You create clean, semantic, mobile-responsive HTML with embedded CSS. Your pages are self-contained — no external CSS frameworks, only Google Fonts as the external dependency.

You must respond with ONLY the complete HTML document — no markdown fences, no explanations. Start with <!DOCTYPE html> and end with </html>.`;

  const htmlPrompt = `Generate a complete, self-contained HTML landing page based on this design specification and placeholder system.

DESIGN SPECIFICATION:
${JSON.stringify(designAnalysis, null, 2)}

COPY SECTION PLACEHOLDERS (use these exact tokens in the HTML — they will be replaced with actual copy):
${sectionPlaceholders}

IMAGE PLACEHOLDERS (use these as src attributes — they will be replaced with actual image URLs):
${imagePlaceholders || '  (No image slots defined)'}

CTA PLACEHOLDERS (use these for href and button text — they will be replaced with actual values):
${ctaPlaceholders || '  (No CTA elements defined)'}

REQUIREMENTS:
1. Output a COMPLETE HTML document starting with <!DOCTYPE html>
2. All CSS must be in a <style> block in the <head> — no inline styles except where absolutely necessary
3. Use Google Fonts via <link> in <head> if the design spec names specific fonts
4. The page must be fully mobile-responsive (use media queries, max-width containers, flexible images)
5. Use the exact color palette, typography, and spacing from the design specification
6. Place copy placeholders like {{headline}}, {{lead}}, {{problem}}, etc. exactly where the corresponding copy section belongs
7. Place image placeholders like {{image_1}}, {{image_2}} as <img> src attributes
8. Place CTA placeholders like {{cta_1_url}} as <a> href and {{cta_1_text}} as button inner text
9. The layout should follow the section order from the design spec
10. Add subtle animations (fade-in on scroll) using CSS only — no JavaScript required
11. Ensure proper semantic HTML (h1, h2, p, section, etc.)
12. Images should have max-width: 100% and height: auto
13. CTA buttons should be prominently styled per the design spec
14. Add a viewport meta tag for mobile
15. Target a professional, premium look — clean spacing, readable typography

IMPORTANT: Use the EXACT placeholder token format shown above. The system will search for and replace these tokens.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: htmlPrompt },
  ];

  const response = await chat(messages, 'claude-sonnet-4-6', {
    max_tokens: 16384,
    operation: 'lp_html_generation',
    projectId,
    timeout: 180000,
  });

  // Clean the response — remove any markdown fences if Claude added them
  let html = response.trim();
  if (html.startsWith('```html')) {
    html = html.slice(7);
  } else if (html.startsWith('```')) {
    html = html.slice(3);
  }
  if (html.endsWith('```')) {
    html = html.slice(0, -3);
  }
  html = html.trim();

  // Validate it looks like HTML
  if (!html.includes('<!DOCTYPE') && !html.includes('<html')) {
    throw new Error('Generated HTML template is not valid HTML.');
  }

  sendEvent({ type: 'progress', step: 'html_complete', message: 'HTML template generated successfully' });

  return html;
}

// ─── Phase 2E: Placeholder replacement — assemble final HTML ────────────────

/**
 * Replace placeholders in the HTML template with actual copy, image URLs, and CTA values.
 *
 * @param {object} params
 * @param {string} params.htmlTemplate - Raw HTML with placeholders
 * @param {Array} params.copySections - Copy sections with { type, content }
 * @param {Array} params.imageSlots - Image slots with { slot_id, storageUrl, ... }
 * @param {Array} params.ctaElements - CTA elements with { cta_id, text_suggestion, ... }
 * @returns {string} Assembled HTML with placeholders replaced
 */
export function assembleLandingPage({
  htmlTemplate,
  copySections,
  imageSlots,
  ctaElements,
}) {
  let html = htmlTemplate;

  // Replace copy section placeholders: {{section_type}} → actual content
  // Wrap content in proper HTML (convert newlines to <p> tags)
  for (const section of copySections) {
    const placeholder = `{{${section.type}}}`;
    // Convert plain text to HTML paragraphs
    const htmlContent = section.content
      .split(/\n\n+/)
      .map(para => para.trim())
      .filter(para => para.length > 0)
      .map(para => {
        // If it looks like a heading (short, no period), keep as-is
        if (para.length < 100 && !para.includes('.')) {
          return para;
        }
        // Convert single newlines to <br> within paragraphs
        return `<p>${para.replace(/\n/g, '<br>')}</p>`;
      })
      .join('\n');

    html = html.replaceAll(placeholder, htmlContent);
  }

  // Replace image placeholders: {{image_N}} → actual storage URL or placeholder
  if (imageSlots && imageSlots.length > 0) {
    for (let i = 0; i < imageSlots.length; i++) {
      const placeholder = `{{image_${i + 1}}}`;
      const slot = imageSlots[i];
      const url = slot.storageUrl || `https://placehold.co/${slot.suggested_size || '800x400'}/e2e8f0/64748b?text=Image+${i + 1}`;
      html = html.replaceAll(placeholder, url);
    }
  }

  // Replace CTA placeholders: {{cta_N_url}} and {{cta_N_text}}
  if (ctaElements && ctaElements.length > 0) {
    for (let i = 0; i < ctaElements.length; i++) {
      const urlPlaceholder = `{{cta_${i + 1}_url}}`;
      const textPlaceholder = `{{cta_${i + 1}_text}}`;
      const cta = ctaElements[i];
      html = html.replaceAll(urlPlaceholder, '#order');
      html = html.replaceAll(textPlaceholder, cta.text_suggestion || 'Order Now');
    }
  }

  return html;
}

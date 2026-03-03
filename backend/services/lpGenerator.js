/**
 * LP (Landing Page) Generator Service — Phase 1 + Phase 2
 *
 * Phase A: Fetch swipe page via headless browser (lpSwipeFetcher.js)
 * Phase B: Generate landing page copy via Claude Sonnet multi-message conversation
 * Phase 2A: Design analysis — analyze screenshot via Claude vision
 * Phase 2C: Image generation — generate images for each slot via Gemini
 * Phase 2D: HTML generation — generate self-contained HTML page via Claude
 * Phase 2E: Placeholder replacement — assemble final HTML with copy, images, CTAs
 *
 * Uses the same Anthropic wrapper (services/anthropic.js) as the rest of the platform.
 */

import { chat, chatWithImage, chatWithMultipleImages } from './anthropic.js';
import { generateImage } from './gemini.js';
import { getDocsByProject, uploadBuffer, getStorageUrl, getLPTemplate, getProject, downloadToBuffer } from '../convexClient.js';

// ─── Narrative Frame Library ─────────────────────────────────────────────────

export const NARRATIVE_FRAMES = [
  {
    id: 'testimonial',
    name: 'Testimonial Journey',
    instruction: 'Write this as a first-person testimonial story. The narrator is a real customer describing their journey from struggling with the problem to discovering the product and experiencing results. Use vivid, emotional language. Include specific details like timeframes, before/after descriptions, and moments of doubt overcome by results.',
  },
  {
    id: 'mechanism',
    name: 'Mechanism Deep-Dive',
    instruction: 'Write this as an educational explanation of the unique mechanism behind the product. Lead with curiosity and a surprising scientific or clinical insight. Explain WHY traditional approaches fail, then reveal the specific mechanism that makes this product different. Use simple analogies to make complex concepts accessible.',
  },
  {
    id: 'problem_agitation',
    name: 'Problem Agitation',
    instruction: 'Lead with the customer\'s deepest pain points and frustrations. Agitate the problem by describing how it affects every area of their life — relationships, confidence, daily routines, future outlook. Make the reader feel deeply understood before presenting the solution. Use "you" language extensively.',
  },
  {
    id: 'myth_busting',
    name: 'Myth Busting',
    instruction: 'Challenge 3-5 common beliefs or myths about the problem/solution category. Start with a provocative statement that contradicts conventional wisdom. For each myth, explain why most people believe it, then reveal the truth with evidence. Position the product as the solution that aligns with the real truth.',
  },
  {
    id: 'listicle',
    name: 'Listicle',
    instruction: 'Structure the page as a numbered list of key reasons, benefits, or discoveries (e.g., "7 Reasons Why..." or "5 Things Nobody Tells You About..."). Each item should have a compelling sub-headline and 1-2 paragraphs of supporting copy. Build momentum so the most powerful reason comes last, leading directly into the offer.',
  },
];

// ─── Phase 2A: Screenshot-based Claude vision design analysis ────────────────

/**
 * Analyze swipe page design using Claude Sonnet vision API.
 * Takes a screenshot buffer (from lpSwipeFetcher) and sends it to Claude for analysis.
 *
 * @param {Buffer} screenshotBuffer - JPEG screenshot buffer
 * @param {(event: object) => void} sendEvent - SSE event callback
 * @param {string} projectId - For cost logging
 * @returns {Promise<object>} Design analysis JSON
 */
export async function analyzeSwipeDesign(screenshotBuffer, sendEvent, projectId) {
  if (!screenshotBuffer || screenshotBuffer.length === 0) {
    throw new Error('No screenshot available for design analysis.');
  }

  sendEvent({
    type: 'progress',
    step: 'design_analyzing',
    message: 'Analyzing swipe page design with Claude vision...',
  });

  // Detect if buffer is a PDF (starts with %PDF) or an image
  const isPdf = screenshotBuffer[0] === 0x25 && screenshotBuffer[1] === 0x50 &&
                screenshotBuffer[2] === 0x44 && screenshotBuffer[3] === 0x46;

  // Convert buffer to the format expected by chatWithMultipleImages
  const pageImages = [{
    base64: screenshotBuffer.toString('base64'),
    mimeType: isPdf ? 'application/pdf' : 'image/jpeg',
    pageNum: 1,
  }];

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
  autoContext,  // { narrativeFrame, foundationalDocs } — only in auto mode
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

CRITICAL: You must respond with a valid JSON object containing an array of copy sections. Each section has a "type" and "content" field. Do not include any text outside the JSON.

IMPORTANT: Generate content ONLY for the slots defined in the template. Do not suggest or create content for elements that don't have a corresponding slot in the template. If there is no banner slot in the template, do not generate banner copy. The template defines the page structure — your job is to fill its slots, not invent new ones.

IMPORTANT: For any callout, data box, stat highlight, or highlighted section that has SEPARATE heading and body slots — the heading slot contains ONLY the title or label. The body slot contains ONLY the supporting content. Do NOT start the body text with the heading text. They render as distinct elements on the page, so repeating the heading in the body will cause duplicate text.
Example — CORRECT: heading="USDA DATA", body="42.7% of organic produce samples tested positive..."
WRONG: heading="USDA DATA", body="USDA DATA: 42.7% of organic produce samples tested positive..."

TESTIMONIAL ATTRIBUTION: When writing testimonials, social proof quotes, or customer reviews, ALWAYS use a realistic first name + last initial (e.g., "Sarah M.", "David R.", "Jennifer K."). NEVER use generic labels like "Verified Buyer", "Verified Customer", "Happy Customer", or "Anonymous". Each testimonial must have a unique, realistic name.

TESTIMONIAL UNIQUENESS: Each testimonial quote must be unique. If the template has multiple testimonial slots (e.g., testimonial, section_3_body_2, proof), generate a DIFFERENT testimonial for each one — different person, different quote, different angle on why the product works. Never repeat the same quote verbatim anywhere on the page.

AUTHOR METADATA: If the template has an author_name slot, use a realistic female first and last name — this is a first-person editorial article and the author should sound like a real person, not an editorial desk or department. Example: 'Sarah Mitchell', 'Jennifer Roberts', 'Amanda Chen'. For author_title, use a credible editorial role like 'Health & Wellness Editor', 'Senior Health Correspondent', 'Contributing Health Editor'.

WARNING BOX: If the template has a warning_box_text slot, generate an editorial content advisory that sounds concerned and personal — not institutional. Example: 'The following article discusses findings about pesticide contamination that may change how you think about your family\\'s produce.' Do NOT use phrases like 'based on scientific research', 'expert analysis', or 'reader discretion advised'.`;

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
  const narrativeInstruction = autoContext?.narrativeFrame
    ? `\nNARRATIVE FRAME INSTRUCTION:\n${autoContext.narrativeFrame}\n\nYou MUST write the entire landing page using this narrative frame. The frame dictates the overall voice, structure, and storytelling approach. Every section should reflect this frame.\n`
    : '';

  const generateMessage = `Now write a landing page using the product knowledge from the documents above.

MARKETING ANGLE / HOOK:
${angle}

TARGET WORD COUNT: approximately ${wordCount} words
${narrativeInstruction}
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
- Every section must have a "type" (short lowercase identifier) and "content" (the actual copy)${autoContext?.templateSlots?.length > 0 ? `

TEMPLATE-SPECIFIC SECTIONS — The HTML template for this landing page uses these additional named content slots. You MUST include a section for EACH ONE in your response:
${autoContext.templateSlots.map(slot => `  - { "type": "${slot}", "content": "..." } — Generate appropriate content for the "${slot}" section`).join('\n')}

CRITICAL: The final HTML template has placeholder tags (e.g., {{${autoContext.templateSlots[0]}}}) that will be replaced with the content you provide here. If you skip any of these sections, the finished page will display raw {{placeholder}} tags to the reader. Include ALL of them.` : ''}`;

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

// ─── Opus Editorial Intelligence Layer ──────────────────────────────────────

/**
 * Run Opus 4.6 editorial pass on generated copy sections.
 * Acts as a senior direct response creative director reviewing the LP holistically.
 *
 * @param {object} params
 * @param {Array} params.copySections - Generated copy sections from Phase B
 * @param {object} params.designAnalysis - Design spec from Phase 2A
 * @param {string} params.angle - The marketing angle
 * @param {string} params.narrativeFrame - Narrative frame name
 * @param {object} params.foundationalDocs - { research, avatar, offer_brief, necessary_beliefs }
 * @param {string} params.pdpUrl - Product page URL
 * @param {string} params.projectId - For cost logging
 * @param {(event: object) => void} sendEvent - SSE event callback
 * @returns {Promise<object|null>} Editorial plan JSON or null on failure
 */
export async function runEditorialPass({
  copySections,
  designAnalysis,
  angle,
  narrativeFrame,
  foundationalDocs,
  pdpUrl,
  projectId,
}, sendEvent) {
  sendEvent({ type: 'progress', step: 'editorial_starting', message: 'Opus editorial review starting...' });

  const sectionsSummary = copySections
    .map(s => `## ${s.type}\n${s.content}`)
    .join('\n\n---\n\n');

  const docsContext = [
    foundationalDocs?.avatar ? `CUSTOMER AVATAR:\n${foundationalDocs.avatar.slice(0, 2000)}` : null,
    foundationalDocs?.offer_brief ? `OFFER BRIEF:\n${foundationalDocs.offer_brief.slice(0, 2000)}` : null,
    foundationalDocs?.necessary_beliefs ? `NECESSARY BELIEFS:\n${foundationalDocs.necessary_beliefs.slice(0, 1500)}` : null,
  ].filter(Boolean).join('\n\n');

  const sectionTypes = (designAnalysis?.sections || []).map(s => s.type || s.id).join(', ');
  const imageSlotDescs = (designAnalysis?.image_slots || []).map((s, i) => `image_${i + 1}: ${s.description}`).join('\n');

  const systemPrompt = `You are a senior direct response creative director with 20+ years of experience writing high-converting advertorial landing pages. You are reviewing a draft landing page to make strategic editorial decisions that will maximize conversion rate.

Your job is NOT to rewrite the copy — it's to make high-level strategic decisions about:
1. What the headline and subheadline should be (concise, punchy, curiosity-driven)
2. Whether to add a top banner text (urgency/scarcity) — ONLY if the template skeleton already has a banner element
3. How to reorder or restructure sections for maximum impact
4. Where to add callout boxes (testimonial snippets, stat highlights, trust badges)
5. Which paragraphs deserve visual emphasis (bold, highlight, pullquote treatment)
6. Whether any sections should be cut entirely
7. Updated image direction if the editorial plan changes the focus
8. Where CTAs should appear (after which sections)

You think in terms of: hook → story → mechanism → proof → offer → urgency → CTA.

TEMPLATE FIDELITY: Your editorial plan must work within the template structure. You can reorder sections, adjust emphasis, insert callout blocks at specified positions, and refine copy — but you CANNOT add entirely new structural elements that don't exist in the template skeleton. For example, do NOT add a sticky urgency banner if the template doesn't have one. Do NOT add floating CTAs, countdown timers, notification bars, or any other conversion elements unless they already exist in the template. The template is the blueprint — optimize within it, don't expand beyond it. Set "top_banner_text" to null if the template has no banner element.

DUPLICATE HEADING CHECK: Check all callout blocks and data boxes for duplicate heading text. If a callout's body paragraph begins with the same text as its heading label (e.g., heading="USDA DATA" and body starts with "USDA DATA:"), remove the duplicate from the body.

CRITICAL: Also scan the copy for any remaining {{placeholder}} template tags (e.g., {{author_name}}, {{publish_date}}, {{TRENDING_CATEGORY}}). If you find any, provide replacement text in the "placeholder_fills" field of your response.`;

  const userPrompt = `Review this landing page draft and provide your editorial plan.

MARKETING ANGLE: ${angle}
NARRATIVE FRAME: ${narrativeFrame || 'general'}
PDP URL: ${pdpUrl || 'not set'}
PAGE SECTIONS: ${sectionTypes}

${docsContext ? `FOUNDATIONAL DOCS:\n${docsContext}\n` : ''}
IMAGE SLOTS:
${imageSlotDescs || 'No image slots defined'}

---

CURRENT COPY SECTIONS:

${sectionsSummary}

---

Respond with a JSON object containing your editorial plan:

{
  "headline": "Your optimized headline (max 15 words, curiosity-driven)",
  "subheadline": "Supporting subheadline (max 25 words)",
  "top_banner_text": "Urgency/scarcity banner text or null if not needed",
  "sections_order": ["section_type_1", "section_type_2", ...],
  "sections_emphasis": {
    "section_type": "high" | "medium" | "low"
  },
  "callouts": [
    { "after_section": "section_type", "type": "stat" | "testimonial" | "trust", "content": "The callout text" }
  ],
  "paragraph_emphasis": [
    { "section": "section_type", "keyword_or_phrase": "phrase to emphasize", "treatment": "bold" | "highlight" | "pullquote" }
  ],
  "sections_to_cut": ["section_type_to_remove"],
  "image_direction_updates": [
    { "slot": "image_1", "updated_direction": "New direction based on editorial plan" }
  ],
  "cta_positions": ["after_hero", "after_benefits", "after_testimonials"],
  "placeholder_fills": { "placeholder_name": "actual text to replace the {{placeholder_name}} tag" },
  "decisions": ["plain language decision 1 — be specific about what you changed and why", "decision 2"],
  "editorial_notes": "Brief explanation of your strategic reasoning"
}

Along with your editorial plan, return a "decisions" array — a list of plain-language strings describing each significant editorial choice you made. Examples: "Moved USDA stat from paragraph 4 to opening callout for maximum impact", "Cut redundant vinegar anecdote", "Elevated social proof before mechanism reveal". Be specific — these appear in the editor audit trail.`;

  try {
    const response = await chat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      'claude-opus-4-6',
      {
        max_tokens: 16384,
        timeout: 180000,
        response_format: { type: 'json_object' },
        operation: 'lp_editorial_pass',
        projectId,
      }
    );

    // Parse the editorial plan
    let editorialPlan;
    try {
      editorialPlan = JSON.parse(response);
    } catch {
      // The anthropic wrapper auto-extracts JSON, so response might already be an object
      if (typeof response === 'object' && response !== null) {
        editorialPlan = response;
      } else {
        console.warn('[LPGen] Editorial pass returned non-JSON response, skipping');
        sendEvent({ type: 'progress', step: 'editorial_skipped', message: 'Editorial review returned invalid format — proceeding without it' });
        return null;
      }
    }

    // Validate minimum shape
    if (!editorialPlan.headline && !editorialPlan.sections_order) {
      console.warn('[LPGen] Editorial plan missing required fields, skipping');
      sendEvent({ type: 'progress', step: 'editorial_skipped', message: 'Editorial plan incomplete — proceeding without it' });
      return null;
    }

    sendEvent({
      type: 'progress',
      step: 'editorial_complete',
      message: `Editorial review complete: ${editorialPlan.callouts?.length || 0} callouts, ${editorialPlan.sections_to_cut?.length || 0} cuts`,
    });

    return editorialPlan;
  } catch (err) {
    console.warn('[LPGen] Editorial pass failed (non-fatal):', err.message);
    sendEvent({ type: 'progress', step: 'editorial_failed', message: `Editorial review failed — proceeding without it: ${err.message}` });
    return null;
  }
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
  autoContext,  // { narrativeFrame, productImageData, editorialPlan } — in auto mode
}, sendEvent) {
  if (!imageSlots || imageSlots.length === 0) {
    sendEvent({ type: 'progress', step: 'images_skipped', message: 'No image slots defined — skipping image generation.' });
    return [];
  }

  const totalSlots = imageSlots.length;
  const hasProductRef = !!autoContext?.productImageData;
  sendEvent({
    type: 'progress',
    step: 'images_starting',
    message: `Generating ${totalSlots} image${totalSlots > 1 ? 's' : ''} via Gemini${hasProductRef ? ' (with product reference)' : ''}...`,
  });

  // Build editorial image direction updates lookup
  const editorialImageUpdates = {};
  if (autoContext?.editorialPlan?.image_direction_updates) {
    for (const update of autoContext.editorialPlan.image_direction_updates) {
      if (update.slot && update.updated_direction) {
        editorialImageUpdates[update.slot] = update.updated_direction;
      }
    }
  }

  // Build brief context from copy sections for prompt enrichment
  const copyContext = copySections
    .slice(0, 5)
    .map(s => `${s.type}: ${s.content.slice(0, 200)}`)
    .join('\n');

  const results = [];

  for (let i = 0; i < imageSlots.length; i++) {
    const slot = imageSlots[i];
    const slotNum = i + 1;
    const slotId = slot.slot_id || `image_${slotNum}`;

    sendEvent({
      type: 'progress',
      step: 'image_generating',
      message: `Generating image ${slotNum}/${totalSlots}: ${slot.description || slotId}...`,
      imageProgress: { current: slotNum, total: totalSlots, slotId },
    });

    // Build a rich prompt for Gemini from the slot description + context
    const narrativeImageHint = autoContext?.narrativeFrame
      ? `\nNARRATIVE STYLE: The landing page uses a "${autoContext.narrativeFrame}" approach. Match the image mood to this storytelling style.`
      : '';

    // Apply editorial direction update if available
    const editorialDirection = editorialImageUpdates[slotId];
    const editorialHint = editorialDirection
      ? `\nEDITORIAL DIRECTION: ${editorialDirection}`
      : '';

    const imagePrompt = `Create a professional, high-quality image for a landing page.

IMAGE PURPOSE: ${slot.description || 'Product/lifestyle image for landing page'}
SECTION: ${slot.location || 'Landing page section'}
MARKETING ANGLE: ${angle}${narrativeImageHint}${editorialHint}

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

    // Determine if this slot should get the product reference image
    const slotDesc = (slot.description || slot.type || slot.slot_id || '').toLowerCase();
    const isProductSlot = slotDesc.includes('product') || slotDesc.includes('hero');
    const referenceImage = (isProductSlot && autoContext?.productImageData) ? autoContext.productImageData : null;

    try {
      const { imageBuffer, mimeType } = await generateImage(imagePrompt, aspectRatio, referenceImage, {
        projectId, operation: 'lp_image_generation',
      });

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
  autoContext,  // { skeletonHtml, editorialPlan } — in auto mode
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

  const hasSkeletonHtml = autoContext?.skeletonHtml;
  const editorialPlan = autoContext?.editorialPlan;

  const systemPrompt = hasSkeletonHtml
    ? `You are an expert HTML/CSS developer specializing in high-converting landing pages. You adapt existing HTML templates by ensuring all placeholder tokens are correctly placed and the layout accommodates the provided copy sections.

CRITICAL TEMPLATE FIDELITY RULE: You MUST strictly follow the template skeleton structure. The skeleton defines exactly which elements appear on the page, in what order, and with what layout. Your job is to populate the content slots and apply styling — NOT to add new structural elements. Do NOT invent or add any elements that are not present in the template skeleton, including but not limited to: urgency banners, sticky bars, notification bars, floating CTAs, countdown timers, or any other conversion elements unless they exist in the template. The template is the blueprint. If an element isn't in the template, it does not go on the page.

You must respond with ONLY the complete HTML document — no markdown fences, no explanations. Start with <!DOCTYPE html> and end with </html>.`
    : `You are an expert HTML/CSS developer specializing in high-converting landing pages. You create clean, semantic, mobile-responsive HTML with embedded CSS. Your pages are self-contained — no external CSS frameworks, only Google Fonts as the external dependency.

You must respond with ONLY the complete HTML document — no markdown fences, no explanations. Start with <!DOCTYPE html> and end with </html>.`;

  const placeholderRef = `
COPY SECTION PLACEHOLDERS (use these exact tokens in the HTML — they will be replaced with actual copy):
${sectionPlaceholders}

IMAGE PLACEHOLDERS (use these as src attributes — they will be replaced with actual image URLs):
${imagePlaceholders || '  (No image slots defined)'}

CTA PLACEHOLDERS (use these for href and button text — they will be replaced with actual values):
${ctaPlaceholders || '  (No CTA elements defined)'}

IMPORTANT: Use the EXACT placeholder token format shown above. The system will search for and replace these tokens.`;

  // Build editorial plan section if available
  let editorialInstructions = '';
  if (editorialPlan) {
    const parts = [];
    if (editorialPlan.headline) parts.push(`HEADLINE: Use "${editorialPlan.headline}" as the main H1 headline.`);
    if (editorialPlan.subheadline) parts.push(`SUBHEADLINE: Use "${editorialPlan.subheadline}" as the subheadline below the H1.`);
    if (editorialPlan.top_banner_text && hasSkeletonHtml && autoContext.skeletonHtml.includes('banner')) {
      parts.push(`TOP BANNER: The template already has a banner element — populate it with text: "${editorialPlan.top_banner_text}".`);
    }
    if (editorialPlan.sections_order?.length > 0) parts.push(`SECTION ORDER: Arrange sections in this order: ${editorialPlan.sections_order.join(' → ')}`);
    if (editorialPlan.callouts?.length > 0) {
      parts.push(`CALLOUT BOXES: Insert these callout boxes at the specified positions:
${editorialPlan.callouts.map(c => `  - After "${c.after_section}" section: [${c.type}] "${c.content}"`).join('\n')}
Style callouts as visually distinct boxes (border-left accent, background tint, or icon).`);
    }
    if (editorialPlan.paragraph_emphasis?.length > 0) {
      parts.push(`EMPHASIS: Apply visual emphasis to these elements:
${editorialPlan.paragraph_emphasis.map(p => `  - In "${p.section}": "${p.keyword_or_phrase}" → ${p.treatment}`).join('\n')}`);
    }
    if (editorialPlan.sections_to_cut?.length > 0) parts.push(`OMIT SECTIONS: Do NOT include these sections: ${editorialPlan.sections_to_cut.join(', ')}`);
    if (editorialPlan.cta_positions?.length > 0) parts.push(`CTA PLACEMENT: Place CTA buttons after these sections: ${editorialPlan.cta_positions.join(', ')}`);

    if (parts.length > 0) {
      editorialInstructions = `\n\nEDITORIAL PLAN (from senior creative director — follow these strategic decisions):\n${parts.join('\n')}`;
    }
  }

  const htmlPrompt = hasSkeletonHtml
    ? `Adapt this existing HTML template to work with the placeholder system below. Keep the existing layout, styling, colors, and structure. Ensure every copy section, image slot, and CTA has a corresponding placeholder token in the HTML. If the template already has placeholders, update them to match the list below.

EXISTING TEMPLATE HTML:
${autoContext.skeletonHtml}

DESIGN SPECIFICATION (for reference):
${JSON.stringify(designAnalysis, null, 2)}
${placeholderRef}${editorialInstructions}

REQUIREMENTS:
1. Output a COMPLETE HTML document starting with <!DOCTYPE html>
2. Preserve the existing CSS, layout, colors, fonts, and structure from the template
3. Ensure all copy section placeholders are placed in the correct sections
4. The page must remain mobile-responsive
5. Do NOT add any structural elements that are not in the template skeleton — no urgency banners, sticky bars, floating CTAs, countdown timers, notification bars, or any other elements the template doesn't already contain. The template defines the page structure; you populate it.
6. CONTRAST SAFETY: Any element with a dark or colored background (green, blue, dark gray, etc.) MUST have white (#FFFFFF) text. Never use dark text on a dark background. Check every colored section, callout, banner, and overlay for sufficient contrast.${editorialPlan ? '\n7. Follow editorial plan instructions for section ordering, emphasis, and callout placement — but do NOT add structural elements the template doesn\'t have, even if the editorial plan suggests them' : ''}`
    : `Generate a complete, self-contained HTML landing page based on this design specification and placeholder system.

DESIGN SPECIFICATION:
${JSON.stringify(designAnalysis, null, 2)}
${placeholderRef}${editorialInstructions}

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
16. CONTRAST SAFETY: Any element with a dark or colored background (green, blue, dark gray, etc.) MUST have white (#FFFFFF) text. Never use dark text on a dark background. Check every colored section, callout, banner, and overlay for sufficient contrast.${editorialPlan ? '\n17. Follow ALL editorial plan instructions above — they override default section ordering and layout decisions' : ''}`;

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

// ─── Template Placeholder Helpers ────────────────────────────────────────────

/**
 * Extract all {{placeholder}} names from skeleton HTML and categorize them.
 * Returns grouped lists for metadata, standard copy, template-specific copy, images, and CTAs.
 */
function extractTemplatePlaceholders(skeletonHtml) {
  const allMatches = [...skeletonHtml.matchAll(/\{\{([^}]+)\}\}/g)];
  const names = [...new Set(allMatches.map(m => m[1].trim()))];

  const imagePattern = /^image_\d+$/;
  const ctaPattern = /^cta_\d+_(url|text)$/;
  const METADATA_SLOTS = new Set([
    'publish_date', 'author_name', 'author_title',
    'TRENDING_CATEGORY', 'warning_box_text',
    'product_name', 'product_description',
  ]);
  const STANDARD_COPY_SLOTS = new Set([
    'headline', 'subheadline', 'lead', 'problem', 'solution',
    'benefits', 'proof', 'offer', 'guarantee', 'cta', 'ps',
    'story', 'objection_handling', 'faq', 'hero',
    'testimonials', 'credentials', 'mechanism',
  ]);

  const result = {
    metadata: [],
    standardCopy: [],
    templateCopy: [],  // Non-standard slots Claude must generate content for
    image: [],
    cta: [],
    all: names,
  };

  for (const name of names) {
    if (imagePattern.test(name)) {
      result.image.push(name);
    } else if (ctaPattern.test(name)) {
      result.cta.push(name);
    } else if (METADATA_SLOTS.has(name)) {
      result.metadata.push(name);
    } else if (STANDARD_COPY_SLOTS.has(name)) {
      result.standardCopy.push(name);
    } else {
      result.templateCopy.push(name);
    }
  }

  return result;
}

/**
 * Build metadata values to auto-fill template slots programmatically.
 * These are NOT generated by the LLM — they come from project/config data.
 */
function buildMetadataMap({ project, agentConfig, angle }) {
  const today = new Date();
  const formattedDate = today.toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });

  return {
    publish_date: formattedDate,
    author_name: agentConfig?.default_author_name || 'Sarah Mitchell',
    author_title: agentConfig?.default_author_title || 'Health & Wellness Editor',
    TRENDING_CATEGORY: project?.niche || 'Health & Wellness',
    warning_box_text: agentConfig?.default_warning_text || 'The following article discusses findings that may change how you think about the products you use every day.',
    product_name: project?.name || project?.brand_name || '',
    product_description: project?.product_description || '',
  };
}

/**
 * Replace metadata placeholders in assembled HTML.
 * Uses regex to match {{ key }}, {{key}}, {{ key}}, etc. (spaces inside braces).
 */
function applyMetadataReplacements(html, metadataMap) {
  let result = html;
  for (const [key, value] of Object.entries(metadataMap)) {
    if (value) {
      // Match {{key}}, {{ key }}, {{ key}}, {{\tkey\t}}, etc.
      const regex = new RegExp(`\\{\\{\\s*${escapeRegex(key)}\\s*\\}\\}`, 'gi');
      const before = result;
      result = result.replace(regex, value);
      if (before !== result) {
        console.log(`[LPGen] Replaced metadata placeholder: {{${key}}} → "${value.slice(0, 50)}${value.length > 50 ? '...' : ''}"`);
      }
    }
  }
  return result;
}

/** Escape special regex characters in a string */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Zero-tolerance validation: strip ANY remaining {{...}} placeholders.
 * Logs warnings for debugging but never lets them reach the user.
 */
function validateNoPlaceholders(html) {
  const remaining = [...html.matchAll(/\{\{([^}]+)\}\}/g)];
  const warnings = [];
  if (remaining.length > 0) {
    const names = [...new Set(remaining.map(m => m[1].trim()))];
    console.warn(`[LPGen] Stripping ${remaining.length} unfilled placeholder(s): ${names.join(', ')}`);
    warnings.push(...names);
    return { html: html.replace(/\{\{[^}]+\}\}/g, ''), warnings };
  }
  return { html, warnings };
}

/**
 * Fix duplicate heading text in callout blocks — conservative per-heading approach.
 *
 * Strategy:
 * 1. Collect all headings first (without modifying HTML)
 * 2. For each heading, find body elements that start with the same text
 * 3. Only strip the duplicate prefix from body — never touch the heading
 * 4. Require body to continue with actual content after prefix ([A-Z0-9] guard)
 *
 * Example fix:
 *   <h3>USDA DATA</h3><p>USDA DATA: 42.7% of samples...</p>
 *   → <h3>USDA DATA</h3><p>42.7% of samples...</p>
 */
function fixDuplicateCalloutHeadings(html) {
  let result = html;
  let fixCount = 0;

  // Phase 1: Collect all headings with their text (read-only scan)
  const headingRegex = /<(h[1-6]|strong|b|li|dt)[^>]*>([\s\S]*?)<\/\1>/gi;
  const headings = [];
  let match;
  while ((match = headingRegex.exec(html)) !== null) {
    // Strip inner HTML tags to get plain text
    const text = match[2].replace(/<[^>]*>/g, '').trim();
    if (text.length >= 2 && text.length <= 80) {
      headings.push({ text, tag: match[1] });
    }
  }

  // Phase 2: For each heading, find and fix body elements that duplicate the heading text
  for (const heading of headings) {
    const escapedText = escapeRegex(heading.text);
    // Match: closing heading tag → gap (up to 300 chars) → body opening tag → duplicate prefix → real content guard
    const bodyDupRegex = new RegExp(
      `(<\\/(?:${escapeRegex(heading.tag)}|h[1-6]|strong|b|li|dt)>)` +  // closing heading tag
      `([\\s\\S]{0,300}?)` +                                              // gap between heading and body
      `(<(?:p|div|span|dd)[^>]*>)` +                                      // body opening tag
      `(\\s*)${escapedText}\\s*[:—–\\-]?\\s*` +                           // duplicate prefix + separator
      `([A-Z0-9])`,                                                        // guard: body must continue with real content
      'gi'
    );

    result = result.replace(bodyDupRegex, (m, closeTag, gap, bodyOpen, ws, firstChar) => {
      fixCount++;
      console.log(`[LP-FIX] Fixed duplicate heading prefix: "${heading.text.slice(0, 40)}"`);
      return `${closeTag}${gap}${bodyOpen}${firstChar}`;
    });
  }

  if (fixCount > 0) {
    console.log(`[LP-FIX] fixDuplicateCalloutHeadings: fixed ${fixCount} duplicate(s)`);
  }
  return result;
}

/**
 * Fix generic testimonial attributions like "Verified Buyer", "Happy Customer", etc.
 * Replaces them with realistic first-name-last-initial attributions.
 */
function fixGenericTestimonialAttribution(html) {
  const genericPatterns = [
    /Verified\s+Buyer/gi,
    /Verified\s+Customer/gi,
    /Verified\s+Purchase/gi,
    /Happy\s+Customer/gi,
    /Satisfied\s+Customer/gi,
    /Real\s+Customer/gi,
    /Anonymous\s+Buyer/gi,
    /Anonymous\s+Customer/gi,
    /Customer\s+Review/gi,
  ];

  // Pool of realistic first-name + last-initial pairs
  const realisticNames = [
    'Sarah M.', 'Jennifer K.', 'Michael T.', 'David R.', 'Lisa P.',
    'Amanda C.', 'Robert J.', 'Jessica L.', 'Chris W.', 'Rachel B.',
    'Karen H.', 'James D.', 'Michelle S.', 'Brian F.', 'Angela N.',
    'Mark A.', 'Stephanie G.', 'Kevin E.', 'Laura V.', 'Daniel O.',
  ];

  let nameIndex = 0;
  let result = html;

  for (const pattern of genericPatterns) {
    result = result.replace(pattern, () => {
      const name = realisticNames[nameIndex % realisticNames.length];
      nameIndex++;
      console.log(`[LPGen] Replaced generic attribution with: "${name}"`);
      return name;
    });
  }

  return result;
}

/**
 * Deduplicate testimonial text that appears more than once on the page.
 * Uses text-content extraction (strips HTML tags) to find duplicate sentences,
 * then removes the second occurrence's containing element in the original HTML.
 * This catches duplicates regardless of whether they're quoted or unquoted.
 */
function deduplicateTestimonials(html) {
  // Strip HTML to get plain text for sentence extraction
  const plainText = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Split into sentences (period/exclamation/question followed by space or end)
  const sentences = plainText
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length >= 50);

  // Normalize for comparison: lowercase, strip all quote chars, collapse whitespace
  const normalize = (s) => s.toLowerCase().replace(/[""''"""'\u2018\u2019\u201C\u201D]/g, '').replace(/\s+/g, ' ').trim();

  // Count occurrences of each normalized sentence
  const sentenceCounts = new Map();
  for (const sentence of sentences) {
    const norm = normalize(sentence);
    if (norm.length < 40) continue;
    sentenceCounts.set(norm, (sentenceCounts.get(norm) || 0) + 1);
  }

  // Collect duplicates (appear 2+ times)
  const duplicates = [];
  for (const [norm, count] of sentenceCounts) {
    if (count > 1) duplicates.push(norm);
  }

  if (duplicates.length === 0) return html;

  let result = html;
  for (const dupNorm of duplicates) {
    // Find the original (non-normalized) sentence for regex matching
    const origSentence = sentences.find(s => normalize(s) === dupNorm);
    if (!origSentence) continue;

    const shortPreview = origSentence.slice(0, 60).replace(/\n/g, ' ');
    console.log(`[LP-FIX] Found duplicate testimonial text: "${shortPreview}..."`);

    // Escape for regex, use first 80 chars to keep regex manageable
    const escapedFragment = origSentence.slice(0, 80).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Try to find and remove the SECOND container holding this text
    // Priority: blockquote > div > p (most specific testimonial wrapper first)
    const containerTags = ['blockquote', 'div', 'p'];
    let removed = false;

    for (const tag of containerTags) {
      const containerRegex = new RegExp(
        `<${tag}[^>]*>[\\s\\S]*?${escapedFragment}[\\s\\S]*?<\\/${tag}>`,
        'gi'
      );

      const allMatches = [...result.matchAll(containerRegex)];
      if (allMatches.length >= 2) {
        // Remove the SECOND occurrence only — keep the first
        const secondMatch = allMatches[1];
        result = result.slice(0, secondMatch.index) + result.slice(secondMatch.index + secondMatch[0].length);
        console.log(`[LP-FIX] Removed duplicate in <${tag}> (${secondMatch[0].length} chars)`);
        removed = true;
        break;
      }
    }

    if (!removed) {
      console.log(`[LP-FIX] Could not find removable container for duplicate — skipping`);
    }
  }

  return result;
}

// ─── Contrast detection helpers ─────────────────────────────────────────────

/**
 * Perceived brightness using ITU-R BT.601 formula (0 = black, 255 = white).
 */
function perceivedBrightness(r, g, b) {
  return (r * 299 + g * 587 + b * 114) / 1000;
}

/**
 * Check if a color value represents a "dark" color (perceived brightness < 128).
 * Handles hex (#rgb, #rrggbb), rgb(), rgba(), and common named colors.
 */
function isDarkColor(colorStr) {
  if (!colorStr) return false;
  const c = colorStr.trim().toLowerCase();

  // Hex (#rgb, #rrggbb, #rrggbbaa)
  const hexMatch = c.match(/^#([0-9a-f]{3,8})$/);
  if (hexMatch) {
    let hex = hexMatch[1];
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    if (hex.length >= 6) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      return perceivedBrightness(r, g, b) < 128;
    }
  }

  // rgb(r, g, b) or rgba(r, g, b, a)
  const rgbMatch = c.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (rgbMatch) {
    return perceivedBrightness(parseInt(rgbMatch[1]), parseInt(rgbMatch[2]), parseInt(rgbMatch[3])) < 128;
  }

  // Known dark named colors
  const darkNames = new Set([
    'black', 'darkgreen', 'darkblue', 'darkred', 'darkgray', 'darkgrey',
    'darkslategray', 'darkslategrey', 'navy', 'maroon', 'olive', 'purple', 'teal', 'green',
    'indigo', 'midnightblue', 'darkslateblue', 'darkcyan', 'darkmagenta', 'darkolivegreen',
    'darkviolet', 'forestgreen', 'saddlebrown', 'sienna', 'dimgray', 'dimgrey', 'slategray',
    'slategrey', 'steelblue', 'brown', 'firebrick', 'seagreen', 'olivedrab',
  ]);
  return darkNames.has(c);
}

/**
 * Extract a color value from a CSS background shorthand.
 * e.g. "url(img.jpg) #2a6041" -> "#2a6041", "#2a6041" -> "#2a6041"
 */
function extractColorFromBackground(bgValue) {
  if (!bgValue) return null;

  // Direct hex color
  const hexMatch = bgValue.match(/#[0-9a-f]{3,8}\b/i);
  if (hexMatch) return hexMatch[0];

  // RGB/RGBA
  const rgbMatch = bgValue.match(/rgba?\([^)]+\)/i);
  if (rgbMatch) return rgbMatch[0];

  // Named color (first word if it looks like a color name)
  const firstWord = bgValue.trim().split(/\s+/)[0].toLowerCase();
  const notColors = new Set(['url', 'inherit', 'initial', 'unset', 'transparent', 'none', 'linear-gradient', 'radial-gradient', 'var']);
  if (/^[a-z]+$/.test(firstWord) && !notColors.has(firstWord)) {
    return firstWord;
  }

  return null;
}

/**
 * Parse <style> blocks in the HTML and find CSS selectors that set dark backgrounds.
 * Returns CSS override rules to force white text on those selectors.
 * Skips our own injected style blocks (data-safety, data-autofix).
 */
function extractDarkBackgroundOverrides(html) {
  const styleRegex = /<style(?![^>]*data-(?:safety|autofix))[^>]*>([\s\S]*?)<\/style>/gi;
  const overrides = [];
  let match;

  while ((match = styleRegex.exec(html)) !== null) {
    let css = match[1].replace(/\/\*[\s\S]*?\*\//g, ''); // strip comments

    // Flatten @media blocks — remove the @media wrapper but keep inner rules
    css = css.replace(/@media[^{]*\{/g, '');

    // Find all rule blocks: selector { properties }
    const ruleRegex = /([^{};]+?)\s*\{([^}]*)\}/g;
    let ruleMatch;

    while ((ruleMatch = ruleRegex.exec(css)) !== null) {
      const selector = ruleMatch[1].trim();
      const props = ruleMatch[2];

      // Skip @-rules, keyframes, empty selectors
      if (!selector || selector.startsWith('@') || /^(from|to|\d+%)/.test(selector)) continue;

      // Check for background or background-color property
      const bgPropMatch = props.match(/background(?:-color)?\s*:\s*([^;!]+)/i);
      if (!bgPropMatch) continue;

      const bgValue = bgPropMatch[1].trim();
      const color = extractColorFromBackground(bgValue);
      if (!color || !isDarkColor(color)) continue;

      // This selector sets a dark background — generate contrast overrides
      const sels = selector.split(',').map(s => s.trim()).filter(s => s && !s.startsWith('@'));
      for (const sel of sels) {
        overrides.push(`${sel} { color: #FFFFFF !important; }`);
        overrides.push(`${sel} * { color: #FFFFFF !important; }`);
        overrides.push(`${sel} a { color: #FFD700 !important; }`);
      }
    }
  }

  // Deduplicate
  return [...new Set(overrides)].join('\n  ');
}

/**
 * Proactive contrast safety net — inject CSS rules that ensure text is readable
 * on dark backgrounds. Three-layer approach:
 *   1. CSS attribute selectors for inline styles (both background-color: and background: shorthand)
 *   2. Parse <style> blocks to find class-based dark backgrounds and generate override rules
 *   3. Inline style pass to directly fix dark-on-dark style combos on individual elements
 * Idempotent: checks for data-safety="contrast" marker.
 */
export function injectContrastSafetyCSS(html) {
  // Don't inject if already present (idempotency)
  if (html.includes('data-safety="contrast"')) return html;

  // ── Layer 1: CSS attribute selectors for inline dark backgrounds ──
  // Match BOTH background-color: AND background: (shorthand)
  const darkHexPrefixes = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b'];
  const bgProps = ['background-color', 'background'];

  const darkSel = [];
  const darkChildSel = [];
  const darkLinkSel = [];

  for (const prop of bgProps) {
    for (const p of darkHexPrefixes) {
      darkSel.push(`[style*="${prop}: #${p}"]`);
      darkChildSel.push(`[style*="${prop}: #${p}"] *`);
      darkLinkSel.push(`[style*="${prop}: #${p}"] a`);
    }
    for (let i = 0; i < 10; i++) {
      darkSel.push(`[style*="${prop}: rgb(${i}"]`);
      darkChildSel.push(`[style*="${prop}: rgb(${i}"] *`);
      darkLinkSel.push(`[style*="${prop}: rgb(${i}"] a`);
    }
  }

  // Light background exclusions — restore to inherited color
  const lightSel = [];
  const lightChildSel = [];
  for (const prop of bgProps) {
    for (const p of ['#f', '#F', '#e', '#E', '#d', '#D']) {
      lightSel.push(`[style*="${prop}: ${p}"]`);
      lightChildSel.push(`[style*="${prop}: ${p}"] *`);
    }
    lightSel.push(`[style*="${prop}: white"]`, `[style*="${prop}: #fff"]`, `[style*="${prop}: rgb(255"]`);
    lightChildSel.push(`[style*="${prop}: white"] *`, `[style*="${prop}: #fff"] *`, `[style*="${prop}: rgb(255"] *`);
  }

  // ── Layer 2: Parse <style> blocks for class-based dark backgrounds ──
  const classOverrides = extractDarkBackgroundOverrides(html);
  const classOverrideBlock = classOverrides
    ? `\n  /* Class-based dark background overrides from page styles */\n  ${classOverrides}`
    : '';

  // ── Build the combined safety CSS ──
  const safetyCSS = `<style data-safety="contrast">
  /* Inline dark backgrounds — both background-color: and background: shorthand */
  ${darkSel.join(',\n  ')} { color: #FFFFFF !important; }
  ${darkChildSel.join(',\n  ')} { color: #FFFFFF !important; }
  ${darkLinkSel.join(',\n  ')} { color: #FFD700 !important; }
  /* Light background exclusions — restore to inherit */
  ${lightSel.join(',\n  ')} { color: inherit !important; }
  ${lightChildSel.join(',\n  ')} { color: inherit !important; }${classOverrideBlock}
</style>`;

  // Inject CSS into <head> or before <body>
  let result;
  if (html.includes('</head>')) {
    result = html.replace('</head>', `${safetyCSS}\n</head>`);
  } else if (html.includes('<body')) {
    result = html.replace('<body', `${safetyCSS}\n<body`);
  } else {
    result = safetyCSS + html;
  }

  // ── Layer 3: Inline style pass — directly fix dark-on-dark combos ──
  // Matches ANY element with a dark background in its style attribute and ensures
  // the text color is white. Handles both background: and background-color:,
  // and adds color: #FFFFFF even when no explicit color property exists.
  let inlineFixCount = 0;
  result = result.replace(
    /style="([^"]*)"/gi,
    (fullMatch, styleContent) => {
      // Check if element has a dark background (either shorthand or longhand)
      const bgMatch = styleContent.match(/background(?:-color)?\s*:\s*([^;!]+)/i);
      if (!bgMatch) return fullMatch;

      const bgValue = bgMatch[1].trim();
      const color = extractColorFromBackground(bgValue);
      if (!color || !isDarkColor(color)) return fullMatch;

      // This element has a dark background — ensure text color is white
      const props = styleContent.split(';').map(p => p.trim()).filter(p => p);
      let hasStandaloneColor = false;
      const fixedProps = props.map(prop => {
        // Match standalone color: (not background-color: or border-color:)
        if (/^color\s*:/i.test(prop)) {
          hasStandaloneColor = true;
          return 'color: #FFFFFF';
        }
        return prop;
      });

      if (!hasStandaloneColor) {
        fixedProps.push('color: #FFFFFF');
      }

      inlineFixCount++;
      return `style="${fixedProps.join('; ')}"`;
    }
  );
  if (inlineFixCount > 0) {
    console.log(`[LP-FIX] Fixed ${inlineFixCount} inline dark-background element(s) to white text`);
  }

  return result;
}

/**
 * Remove empty elements left behind after placeholder stripping.
 * Targets: <span></span>, <p></p>, <div></div>, <strong></strong>, etc.
 * Repeats until stable (nested empty elements may need multiple passes).
 */
function cleanupEmptyElements(html) {
  let result = html;
  let prev;
  do {
    prev = result.length;
    result = result.replace(/<(span|p|div|strong|em|b|i|h[1-6]|li|dt|dd|a)([^>]*)>\s*<\/\1>/gi, '');
  } while (result.length !== prev);

  const removed = html.length - result.length;
  if (removed > 0) {
    console.log(`[LP-FIX] Cleaned up empty elements: removed ${removed} characters of empty markup`);
  }
  return result;
}

/**
 * Consolidated post-processing pipeline for assembled LP HTML.
 * Runs after HTML assembly and before storing the final LP.
 *
 * Steps:
 * 1. Populate metadata (author, date, product name)
 * 2. Apply editorial placeholder fills (if any)
 * 3. Strip unfilled placeholders (zero-tolerance)
 * 3b. Clean up empty elements left by stripping
 * 4. Fix duplicate callout headings
 * 5. Fix generic testimonial attributions
 * 6. Inject proactive contrast safety CSS
 *
 * @param {string} html - Assembled HTML
 * @param {object} options
 * @param {object} [options.project] - Project data (for metadata)
 * @param {object} [options.agentConfig] - LP agent config (for author name/title)
 * @param {string} [options.angle] - Marketing angle
 * @param {object} [options.editorialPlan] - Opus editorial plan (for placeholder_fills)
 * @returns {{ html: string, warnings: string[] }} Processed HTML and any warnings
 */
export function postProcessLP(html, { project = null, agentConfig = null, angle = '', editorialPlan = null } = {}) {
  let processed = html;

  console.log(`[LP-FIX] postProcessLP() called. HTML length: ${html.length}, project: ${project ? project.name || project.externalId : 'NULL'}, agentConfig: ${agentConfig ? 'loaded' : 'NULL'}, angle: "${(angle || '').slice(0, 40)}"`);

  if (!project) {
    console.warn('[LP-FIX] WARNING: project is null — metadata placeholders will use fallback values');
  }
  if (!agentConfig) {
    console.warn('[LP-FIX] WARNING: agentConfig is null — author_name, author_title, warning_text will use hardcoded defaults');
  }

  // 1. Populate metadata placeholders (publish_date, author_name, etc.)
  const metadataMap = buildMetadataMap({ project, agentConfig, angle });
  console.log(`[LP-FIX] Metadata map: ${Object.entries(metadataMap).map(([k, v]) => `${k}="${(v || '').slice(0, 30)}"`).join(', ')}`);

  const preMetaCount = (processed.match(/\{\{[^}]+\}\}/g) || []).length;
  processed = applyMetadataReplacements(processed, metadataMap);
  const postMetaCount = (processed.match(/\{\{[^}]+\}\}/g) || []).length;
  console.log(`[LP-FIX] Metadata replacement: ${preMetaCount} placeholders before → ${postMetaCount} after (${preMetaCount - postMetaCount} replaced)`);

  // 2. Apply editorial placeholder fills if the Opus pass caught any remaining
  if (editorialPlan?.placeholder_fills && typeof editorialPlan.placeholder_fills === 'object') {
    const fills = Object.keys(editorialPlan.placeholder_fills);
    console.log(`[LP-FIX] Editorial placeholder fills: ${fills.join(', ')}`);
    for (const [key, value] of Object.entries(editorialPlan.placeholder_fills)) {
      if (value) {
        const regex = new RegExp(`\\{\\{\\s*${escapeRegex(key)}\\s*\\}\\}`, 'gi');
        processed = processed.replace(regex, value);
      }
    }
  }

  // 3. Strip unfilled placeholders (zero-tolerance)
  const validation = validateNoPlaceholders(processed);
  processed = validation.html;

  // 3b. Clean up empty elements left by stripped placeholders
  processed = cleanupEmptyElements(processed);

  const finalPlaceholderCount = (processed.match(/\{\{[^}]+\}\}/g) || []).length;
  console.log(`[LP-FIX] Final placeholder count after all passes: ${finalPlaceholderCount}`);

  // 4. Fix duplicate callout headings
  processed = fixDuplicateCalloutHeadings(processed);

  // 5. Replace generic testimonial attributions with realistic names
  processed = fixGenericTestimonialAttribution(processed);

  // 5b. Deduplicate testimonial quotes that appear more than once
  processed = deduplicateTestimonials(processed);

  // 6. Inject proactive contrast safety CSS
  processed = injectContrastSafetyCSS(processed);

  console.log(`[LP-FIX] postProcessLP() complete. Output HTML length: ${processed.length}`);
  return { html: processed, warnings: validation.warnings };
}

// ─── Auto Mode: Generate LP from template + angle ────────────────────────────

/**
 * Generate a landing page automatically using a pre-extracted template.
 * This is the auto mode entry point called by lpAutoGenerator and lpAgent generate-test.
 *
 * Pipeline:
 * 1. Load template (design_brief, slot_definitions, skeleton_html)
 * 2. Load product image for reference (if enabled)
 * 3. Generate copy via Claude Sonnet
 * 4. Run Opus editorial pass (if enabled) — strategic headline, section ordering, callouts
 * 5. Generate images via Gemini (with product reference + editorial direction)
 * 6. Generate HTML via Claude Sonnet (with editorial plan)
 * 7. Assemble final HTML
 *
 * @param {object} params
 * @param {string} params.projectId
 * @param {string} params.templateId - lp_templates externalId
 * @param {string} params.angle - The marketing angle/hook
 * @param {string} params.narrativeFrame - Narrative frame instruction text
 * @param {string} params.batchJobId - Associated batch job
 * @param {boolean} [params.editorialPassEnabled=true] - Whether to run Opus editorial review
 * @param {boolean} [params.useProductReferenceImages=true] - Whether to use product image as reference
 * @param {(event: object) => void} sendEvent - SSE/progress callback
 * @returns {Promise<object>} { copySections, imageSlots, htmlTemplate, assembledHtml, designAnalysis, editorialPlan, auditTrail }
 */
export async function generateAutoLP({
  projectId, templateId, angle, narrativeFrame, batchJobId,
  editorialPassEnabled = true,
  useProductReferenceImages = true,
  agentConfig = null,
}, sendEvent) {
  // Audit trail — collect entries at each generation phase
  const auditTrail = [];
  const audit = (step, action, detail, extra = {}) => {
    auditTrail.push({ timestamp: new Date().toISOString(), step, action, detail, ...extra });
  };

  audit('init', 'started', `Angle: "${(angle || '').slice(0, 60)}", template: ${templateId?.slice(0, 8) || 'none'}`);
  sendEvent({ type: 'progress', step: 'auto_loading', message: 'Loading template for auto-generation...' });

  // 1. Load the template
  const template = await getLPTemplate(templateId);
  if (!template || template.status !== 'ready') {
    throw new Error(`Template ${templateId} is not ready (status: ${template?.status || 'not found'})`);
  }

  // 2. Parse template data
  let designBrief, slotDefs;
  try {
    designBrief = JSON.parse(template.design_brief || '{}');
  } catch {
    designBrief = {};
  }
  try {
    slotDefs = JSON.parse(template.slot_definitions || '[]');
  } catch {
    slotDefs = [];
  }

  // Normalize template data into the shape expected by generateHtmlTemplate
  const designAnalysis = {
    layout: { max_width: '800px', alignment: 'center' },
    typography: {
      heading_font: designBrief.heading_font || designBrief.font_family || 'sans-serif',
      body_font: designBrief.font_family || 'sans-serif',
      heading_color: designBrief.primary_color || '#1a1a2e',
      body_color: designBrief.text_color || '#333333',
    },
    colors: {
      primary: designBrief.primary_color || '#0B1D3A',
      secondary: designBrief.secondary_color || '#C4975A',
      background: designBrief.background_color || '#ffffff',
      text: designBrief.text_color || '#333333',
      accent: designBrief.accent_color || '#2A9D8F',
    },
    sections: (designBrief.sections_order || ['hero', 'problem', 'solution', 'benefits', 'testimonials', 'cta']).map(id => ({
      id,
      type: id,
      notes: `${id} section from template`,
    })),
    image_slots: slotDefs.filter(s => s.type === 'image').map((s, i) => ({
      slot_id: `image_${i + 1}`,
      location: s.description || `Section with ${s.name}`,
      description: s.description || s.name,
      suggested_size: s.suggested_size || '800x600',
      aspect_ratio: '16:9',
    })),
    cta_elements: slotDefs.filter(s => s.name?.startsWith('cta')).map((s, i) => ({
      cta_id: `cta_${i + 1}`,
      location: s.description || 'CTA section',
      style: 'button',
      text_suggestion: 'Order Now',
    })),
    style_notes: designBrief.overall_style || 'Professional landing page',
  };

  // 2a. Extract and categorize template placeholders from skeleton HTML
  const placeholders = template.skeleton_html
    ? extractTemplatePlaceholders(template.skeleton_html)
    : { metadata: [], standardCopy: [], templateCopy: [], image: [], cta: [], all: [] };

  if (placeholders.templateCopy.length > 0) {
    console.log(`[LPGen] Template-specific copy slots found: ${placeholders.templateCopy.join(', ')}`);
  }
  if (placeholders.metadata.length > 0) {
    console.log(`[LPGen] Metadata slots to auto-fill: ${placeholders.metadata.join(', ')}`);
  }

  audit('template', 'loaded', `Template: ${template.name || templateId}, slots: ${slotDefs.length}, copy slots: ${placeholders.templateCopy.length}`);

  // 2b. Load project data (needed for metadata + product image)
  let project = null;
  let productImageData = null;
  try {
    project = await getProject(projectId);
    if (useProductReferenceImages && project?.product_image_storageId) {
      sendEvent({ type: 'progress', step: 'product_image_loading', message: 'Loading product reference image...' });
      const buffer = await downloadToBuffer(project.product_image_storageId);
      productImageData = { base64: buffer.toString('base64'), mimeType: 'image/jpeg' };
    }
  } catch (err) {
    console.warn('[LPGen] Failed to load project/product image (non-fatal):', err.message);
  }

  audit('project', project ? 'loaded' : 'warning',
    project ? `Project: ${project.name || projectId}, product image: ${!!productImageData}` : 'Project data is null — metadata defaults will be used');

  sendEvent({ type: 'progress', step: 'auto_copy', message: 'Generating angle-specific copy...' });

  // 3. Generate copy (Step 2) with autoContext — pass template-specific slots so Claude fills them
  const { sections: copySections } = await generateLandingPageCopy({
    projectId,
    angle,
    swipeText: '', // No swipe text in auto mode — template provides structure
    wordCount: 1200,
    autoContext: {
      narrativeFrame,
      templateSlots: placeholders.templateCopy,
    },
  }, sendEvent);

  audit('copy', 'generated', `${copySections.length} sections: ${copySections.map(s => s.type).join(', ')}`);

  // 3b. Run Opus editorial pass (if enabled)
  let editorialPlan = null;
  if (editorialPassEnabled) {
    const foundationalDocs = await getFoundationalDocs(projectId).catch(() => ({}));
    editorialPlan = await runEditorialPass({
      copySections,
      designAnalysis,
      angle,
      narrativeFrame,
      foundationalDocs,
      pdpUrl: null, // Will be set by publisher
      projectId,
    }, sendEvent);

    if (editorialPlan) {
      audit('editorial', 'completed',
        `Headline: "${(editorialPlan.headline || '').slice(0, 60)}", callouts: ${editorialPlan.callouts?.length || 0}, cuts: ${editorialPlan.sections_to_cut?.length || 0}`,
        { decisions: editorialPlan.decisions || [] });
    } else {
      audit('editorial', 'skipped', 'Editorial pass returned null or was not run');
    }
  } else {
    audit('editorial', 'disabled', 'Editorial pass disabled by config');
  }

  // 4. Generate images (Step 3) with product reference + editorial direction
  const imageSlots = await generateSlotImages({
    imageSlots: designAnalysis.image_slots,
    copySections,
    angle,
    projectId,
    autoContext: {
      narrativeFrame,
      productImageData,
      editorialPlan,
    },
  }, sendEvent);

  audit('images', 'generated', `${imageSlots.filter(s => s.generated).length}/${imageSlots.length} images generated`);

  // 5. Generate HTML (Step 4) with skeleton template + editorial plan
  const htmlTemplate = await generateHtmlTemplate({
    designAnalysis,
    copySections,
    imageSlots,
    ctaElements: designAnalysis.cta_elements,
    projectId,
    autoContext: {
      skeletonHtml: template.skeleton_html,
      editorialPlan,
    },
  }, sendEvent);

  audit('html', 'generated', `HTML template: ${htmlTemplate.length} chars`);

  // 6. Assemble final HTML
  const rawAssembledHtml = assembleLandingPage({
    htmlTemplate,
    copySections,
    imageSlots,
    ctaElements: designAnalysis.cta_elements,
  });

  // 7. Post-process: metadata → editorial fills → strip placeholders → fix duplicate headings
  const { html: assembledHtml, warnings } = postProcessLP(rawAssembledHtml, {
    project,
    agentConfig,
    angle,
    editorialPlan,
  });
  if (warnings.length > 0) {
    console.warn(`[LPGen] Post-processing stripped ${warnings.length} placeholder(s): ${warnings.join(', ')}`);
    audit('postprocess', 'warnings', `Stripped ${warnings.length} placeholder(s): ${warnings.join(', ')}`, { issues: warnings });
  } else {
    audit('postprocess', 'clean', 'No unfilled placeholders found');
  }

  audit('complete', 'finished', `Final HTML: ${assembledHtml.length} chars`);
  sendEvent({ type: 'progress', step: 'auto_complete', message: 'Auto-generated landing page complete' });

  return {
    copySections,
    imageSlots,
    htmlTemplate,
    assembledHtml,
    designAnalysis,
    editorialPlan,
    auditTrail,
  };
}

// ─── Visual QA Check ────────────────────────────────────────────────────────

/**
 * Render an LP's assembled HTML in headless Puppeteer, take a full-page screenshot,
 * then send it to Claude Opus 4.6 vision for visual quality assurance.
 *
 * Checks for:
 * - Unfilled placeholder text ({{...}} or Lorem ipsum)
 * - Broken/missing images (visible alt text, broken icons)
 * - Layout issues (overlapping elements, cut-off text, empty sections)
 * - Generic testimonial names ("Verified Buyer", etc.)
 * - CTA buttons that look broken or have placeholder URLs
 * - Visual inconsistencies (mismatched fonts, color issues)
 *
 * @param {string} assembledHtml - The full assembled HTML to check
 * @param {string} projectId - For cost logging
 * @returns {Promise<{ passed: boolean, issues: Array<{severity: string, description: string, location: string}>, summary: string, screenshotBuffer: Buffer }>}
 */
export async function runVisualQA(assembledHtml, projectId) {
  const puppeteer = (await import('puppeteer')).default;

  let browser;
  try {
    // 1. Render the HTML in headless Puppeteer
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

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // Load the HTML directly (no network needed)
    await page.setContent(assembledHtml, { waitUntil: 'networkidle0', timeout: 30000 });

    // Wait a beat for any CSS transitions/animations
    await new Promise(r => setTimeout(r, 1000));

    // Get actual page height for full-page screenshot
    const bodyHeight = await page.evaluate(() => document.body.scrollHeight);
    const screenshotHeight = Math.min(bodyHeight, 7900); // Claude API limit

    // Take full-page screenshot as JPEG
    const screenshotBuffer = await page.screenshot({
      type: 'jpeg',
      quality: 85,
      clip: { x: 0, y: 0, width: 1280, height: screenshotHeight },
    });

    await browser.close();
    browser = null;

    // 2. Send screenshot to Claude Opus for visual QA
    const systemPrompt = `You are a visual QA specialist for landing pages. You inspect rendered landing page screenshots to find issues that would make the page look unprofessional or broken to real visitors.

You must respond with ONLY a valid JSON object — no markdown, no prose.`;

    const qaPrompt = `Inspect this landing page screenshot carefully and identify any visual quality issues.

PRIORITY CHECK — TEXT LEGIBILITY / CONTRAST (type: "contrast_failure"):
Before checking anything else, scan EVERY section of the page from top to bottom and verify that ALL text is easily readable against its background. Specifically look for:
- Dark text (black, dark gray, dark green, navy) on dark backgrounds (green, dark blue, dark gray, brown)
- Light text on light backgrounds (white text on cream/beige)
- Text on colored sections (CTA areas, product highlights, banners, callout boxes) that blends into the background
- Button text that is hard to read against the button color
- Any section where you have to squint or look carefully to read the text
For EACH legibility issue, report what the background color looks like, what the text color looks like, the section location, and mark severity as "critical".

ALSO CHECK FOR THESE ISSUES:
1. **Placeholder text** (type: "placeholder_text"): Any visible {{placeholder}} tags, Lorem ipsum, "TODO", "[INSERT]", or clearly fake/template text
2. **Gray box / broken images** (type: "gray_box_image" or "broken_image"): Missing images showing alt text, broken icons, gray/colored placeholder boxes, or obvious AI artifacts
3. **Layout problems** (type: "layout_overlap" or "empty_section"): Overlapping text, cut-off content, completely empty sections, extremely wide/narrow columns
4. **Generic attribution** (type: "generic_attribution"): Testimonial quotes attributed to "Verified Buyer", "Happy Customer", "Anonymous", etc.
5. **CTA issues** (type: "cta_broken"): Buttons with placeholder text, broken styles, obviously fake URLs like "#" or "example.com"
6. **Typography problems** (type: "typography_mismatch"): Mismatched fonts, unreadable text sizes
7. **Content problems** (type: "duplicate_content" or "truncated_content"): Duplicate visible sections, obviously cut-off sentences

RESPOND WITH A JSON OBJECT:
{
  "passed": true/false,
  "auto_fixable": true/false,
  "issues": [
    {
      "type": "placeholder_text" | "gray_box_image" | "broken_image" | "contrast_failure" | "layout_overlap" | "empty_section" | "generic_attribution" | "cta_broken" | "typography_mismatch" | "duplicate_content" | "truncated_content",
      "severity": "critical" | "warning" | "minor",
      "category": "placeholder" | "image" | "layout" | "attribution" | "cta" | "typography" | "color" | "content",
      "description": "Clear description of the issue",
      "location": "Where on the page (e.g., 'hero section', 'third testimonial', 'footer area')",
      "fix_suggestion": "Specific instruction for fixing this issue",
      "css_selector_hint": "Approximate CSS selector if identifiable (e.g., '.testimonial:nth-child(3)', '.hero-section img')"
    }
  ],
  "summary": "One-sentence overall assessment",
  "score": 0-100
}

Rules:
- "passed" = true only if there are ZERO critical issues and at most 1 warning
- "auto_fixable" = true if ALL critical issues are programmatically fixable types (placeholder_text, generic_attribution, contrast_failure, gray_box_image, broken_image). Set false if critical issues require full regeneration (e.g., fundamentally broken layout, nonsensical content).
- "critical" = issues that make the page look clearly broken or unprofessional (placeholders, broken images, empty sections)
- "warning" = issues that reduce quality but don't look obviously broken (minor layout quirks, slightly mismatched fonts)
- "minor" = nitpick suggestions for improvement
- Be thorough but reasonable — don't flag normal design choices as issues
- If the page looks clean and professional with no obvious issues, return passed=true with an empty issues array`;

    const qaResponse = await chatWithImage(
      [{ role: 'system', content: systemPrompt }],
      qaPrompt,
      screenshotBuffer.toString('base64'),
      'image/jpeg',
      'claude-opus-4-6',
      {
        operation: 'lp_visual_qa',
        projectId,
        timeout: 120000,
      }
    );

    // Parse QA response
    let qaResult;
    try {
      qaResult = JSON.parse(qaResponse);
    } catch {
      const jsonMatch = qaResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        qaResult = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('Failed to parse QA response as JSON');
      }
    }

    return {
      passed: qaResult.passed ?? false,
      autoFixable: qaResult.auto_fixable ?? false,
      issues: qaResult.issues || [],
      summary: qaResult.summary || '',
      score: qaResult.score ?? 0,
      screenshotBuffer,
    };
  } catch (err) {
    if (browser) {
      try { await browser.close(); } catch {}
    }
    throw err;
  }
}

/**
 * Generate an LP with QA validation and auto-fix loop.
 *
 * Strategy:
 * - Generate → postProcess (already in generateAutoLP) → QA
 * - If FAIL + auto_fixable: autoFix → re-postProcess → re-QA (max 2 fix attempts)
 * - If still FAIL or not auto_fixable: full regenerate (max 2 total generations)
 * - If all attempts exhausted: return result: null
 *
 * @param {object} params - Same params as generateAutoLP
 * @param {(event: object) => void} sendEvent - Progress callback
 * @param {object} [options]
 * @param {boolean} [options.visualQAEnabled=true]
 * @returns {Promise<{ result: object|null, qaReport: object|null, fixLog: Array, generationAttempts: number, fixAttempts: number }>}
 */
export async function generateAndValidateLP(params, sendEvent, options = {}) {
  const { visualQAEnabled = true } = options;
  const MAX_GENERATIONS = 5;
  const MAX_FIX_ATTEMPTS = 2;

  let generationAttempts = 0;
  let totalFixAttempts = 0;
  let consecutiveFailures = 0;
  const fixLog = [];
  let lastQAReport = null;

  for (let gen = 0; gen < MAX_GENERATIONS; gen++) {
    generationAttempts++;

    if (gen > 0) {
      sendEvent({ type: 'progress', step: 'generation_reattempt', message: `Regenerating LP from scratch (attempt ${generationAttempts}/${MAX_GENERATIONS})...` });
    }

    // 1. Generate the LP
    let result;
    try {
      result = await generateAutoLP(params, sendEvent);
      consecutiveFailures = 0; // Reset on successful generation
    } catch (genErr) {
      console.error(`[LP Pipeline] Generation attempt ${generationAttempts} failed:`, genErr.message);
      consecutiveFailures++;
      // If 3 consecutive generation failures (not QA — actual crashes/timeouts), stop
      if (consecutiveFailures >= 3) {
        console.error(`[LP Pipeline] 3 consecutive generation failures — giving up.`);
        return { result: null, qaReport: null, fixLog, generationAttempts, fixAttempts: totalFixAttempts };
      }
      continue; // Try next generation
    }

    // 2. If QA disabled, return immediately
    if (!visualQAEnabled) {
      return { result, qaReport: null, fixLog, generationAttempts, fixAttempts: totalFixAttempts };
    }

    // 3. QA + Fix loop
    let currentHtml = result.assembledHtml;

    for (let fixAttempt = 0; fixAttempt <= MAX_FIX_ATTEMPTS; fixAttempt++) {
      // Run QA
      if (fixAttempt === 0) {
        sendEvent({ type: 'progress', step: 'qa_running', message: 'Running visual QA check...' });
      } else {
        sendEvent({ type: 'progress', step: 'qa_recheck', message: `Re-checking after fix (attempt ${fixAttempt}/${MAX_FIX_ATTEMPTS})...` });
      }

      let qaReport;
      try {
        qaReport = await runVisualQA(currentHtml, params.projectId);
        lastQAReport = qaReport;
      } catch (qaErr) {
        console.warn('[LP Pipeline] Visual QA error (non-fatal):', qaErr.message);
        // QA failed to run — return what we have
        return { result: { ...result, assembledHtml: currentHtml }, qaReport: null, fixLog, generationAttempts, fixAttempts: totalFixAttempts };
      }

      // Append QA result to audit trail
      if (result?.auditTrail) {
        result.auditTrail.push({
          timestamp: new Date().toISOString(),
          step: 'qa',
          action: qaReport.passed ? 'passed' : 'failed',
          detail: `Score: ${qaReport.score}/100, issues: ${qaReport.issues?.length || 0}${fixAttempt > 0 ? ` (after fix #${fixAttempt})` : ''}`,
          issues: qaReport.issues?.filter(i => i.severity === 'critical').map(i => `${i.severity}: ${i.description}`) || [],
        });
      }

      // Check if passed
      if (qaReport.passed && qaReport.score >= 80) {
        const passMsg = fixAttempt > 0
          ? `QA passed after ${fixAttempt} fix(es) (score: ${qaReport.score}/100)`
          : `QA passed (score: ${qaReport.score}/100)`;
        sendEvent({ type: 'progress', step: fixAttempt > 0 ? 'qa_passed_after_fix' : 'qa_complete', message: passMsg });
        console.log(`[LP Pipeline] QA PASSED (score: ${qaReport.score}) on gen ${generationAttempts}, fix ${fixAttempt}`);
        return { result: { ...result, assembledHtml: currentHtml }, qaReport, fixLog, generationAttempts, fixAttempts: totalFixAttempts };
      }

      // Out of fix attempts for this generation
      if (fixAttempt === MAX_FIX_ATTEMPTS) {
        console.warn(`[LP Pipeline] Gen ${generationAttempts} failed QA after ${MAX_FIX_ATTEMPTS} fix attempts. Score: ${qaReport.score}`);
        sendEvent({ type: 'progress', step: 'qa_failed_regen', message: `QA failed after ${MAX_FIX_ATTEMPTS} fixes (score: ${qaReport.score}/100). ${gen < MAX_GENERATIONS - 1 ? 'Regenerating...' : 'All attempts exhausted.'}` });
        break;
      }

      // Not auto-fixable — skip to next generation
      if (!qaReport.autoFixable) {
        console.warn(`[LP Pipeline] Gen ${generationAttempts} has non-auto-fixable issues. Score: ${qaReport.score}`);
        sendEvent({ type: 'progress', step: 'qa_failed_regen', message: `QA failed with non-fixable issues (score: ${qaReport.score}/100). ${gen < MAX_GENERATIONS - 1 ? 'Regenerating...' : 'All attempts exhausted.'}` });
        break;
      }

      // Auto-fix
      totalFixAttempts++;
      sendEvent({ type: 'progress', step: 'autofix_attempt', message: `Auto-fixing ${qaReport.issues.filter(i => i.severity === 'critical').length} issue(s) (attempt ${totalFixAttempts})...` });

      try {
        const { autoFixLP } = await import('./lpAutoFixer.js');
        const fixResult = await autoFixLP(currentHtml, qaReport, {
          project: params._project || null,
          agentConfig: params.agentConfig || null,
          angle: params.angle || '',
          editorialPlan: result.editorialPlan || null,
          imageSlots: result.imageSlots || [],
          copySections: result.copySections || [],
          projectId: params.projectId,
        });

        fixLog.push(...fixResult.fixes);
        currentHtml = fixResult.html;

        // Append auto-fix to audit trail
        if (result?.auditTrail) {
          result.auditTrail.push({
            timestamp: new Date().toISOString(),
            step: 'autofix',
            action: 'applied',
            detail: `Applied ${fixResult.fixes.length} fix(es): ${fixResult.fixes.map(f => f.type).join(', ')}`,
          });
        }
      } catch (fixErr) {
        console.error('[LP Pipeline] Auto-fix failed:', fixErr.message);
        // Continue to next QA check with unfixed HTML — it will fail and trigger regen
      }
    }
  }

  // All 5 attempts exhausted
  sendEvent({ type: 'progress', step: 'qa_all_failed', message: `All ${MAX_GENERATIONS} generation attempts failed QA. LP slot unfilled.` });
  console.error(`[LP Pipeline] LP generation failed after ${generationAttempts} generations, ${totalFixAttempts} fix attempts.`);
  return { result: null, qaReport: lastQAReport, fixLog, generationAttempts, fixAttempts: totalFixAttempts };
}

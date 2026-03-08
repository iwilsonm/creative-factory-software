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

import { chat, chatWithImage, chatWithMultipleImages, extractJSON } from './anthropic.js';
import { generateImage } from './gemini.js';
import crypto from 'crypto';
import { getDocsByProject, uploadBuffer, getStorageUrl, getLPTemplate, getProject, downloadToBuffer, getLPAgentConfig, upsertLPAgentConfig } from '../convexClient.js';
import { getNarrativeFrameHeadlineContract, validateLPContentAlignment } from './lpHeadlineValidation.js';

/**
 * Detect the actual MIME type of an image buffer by reading magic bytes.
 * Prevents mismatches where the declared type doesn't match the actual format.
 */
export function detectImageMimeType(buffer) {
  if (buffer && buffer.length > 4) {
    // PNG: 89 50 4E 47
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) {
      return 'image/png';
    }
    // JPEG: FF D8 FF
    if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
      return 'image/jpeg';
    }
    // WebP: 52 49 46 46 ... 57 45 42 50
    if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 && buffer.length > 11 && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) {
      return 'image/webp';
    }
    // GIF: 47 49 46
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
      return 'image/gif';
    }
  }
  return 'image/jpeg'; // fallback
}

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

function buildHeadlineConstraintInstruction(headlineConstraints = null) {
  if (!headlineConstraints) return '';
  const parts = [];
  if (headlineConstraints.contract) {
    parts.push(`HEADLINE CONTRACT:\n${headlineConstraints.contract}`);
  }
  if (Array.isArray(headlineConstraints.usedHeadlines) && headlineConstraints.usedHeadlines.length > 0) {
    parts.push(`HEADLINES ALREADY USED IN THIS 5-FRAME GAUNTLET (do not overlap these ideas):\n${headlineConstraints.usedHeadlines.map((entry) => `- [${entry.narrative_frame || 'frame'}] ${entry.headline_text || entry.headline}`).join('\n')}`);
  }
  if (Array.isArray(headlineConstraints.historyHeadlines) && headlineConstraints.historyHeadlines.length > 0) {
    parts.push(`RECENT SAME-ANGLE LP HEADLINES TO AVOID REUSING:\n${headlineConstraints.historyHeadlines.map((entry) => `- [${entry.narrative_frame || 'frame'}] ${entry.headline_text || entry.headline}`).join('\n')}`);
  }
  if (parts.length === 0) return '';
  return `\nHEADLINE DIFFERENTIATION RULES:\n${parts.join('\n\n')}\n`;
}

function buildCampaignMessageInstruction(messageBrief = null) {
  if (!messageBrief) return '';
  const parts = [];
  if (messageBrief.sourceMode === 'director_ads') {
    parts.push('SOURCE MESSAGE CONTRACT:\nThis LP is being generated from winning Creative Director ads. It must feel like the exact page someone should land on after clicking those ads. Stay on the same promise, same symptom/problem, and same buyer state as the ads.');
  } else {
    parts.push('SOURCE MESSAGE CONTRACT:\nThis LP must stay tightly aligned with the angle and angle brief below. Do not drift into adjacent generic wellness or sleep copy.');
  }
  if (messageBrief.angleSummary) {
    parts.push(`ANGLE / CORE MESSAGE:\n${messageBrief.angleSummary}`);
  }
  if (messageBrief.headlineExamples?.length) {
    parts.push(`WINNING AD HEADLINES / MESSAGE HOOKS:\n${messageBrief.headlineExamples.slice(0, 6).map((text, index) => `${index + 1}. ${text}`).join('\n')}`);
  }
  if (messageBrief.openingExamples?.length) {
    parts.push(`WINNING AD OPENINGS / PROMISES:\n${messageBrief.openingExamples.slice(0, 6).map((text, index) => `${index + 1}. ${text}`).join('\n')}`);
  }
  if (messageBrief.messageKeywords?.length) {
    parts.push(`MESSAGE KEYWORDS / THEMES TO STAY ON:\n${messageBrief.messageKeywords.slice(0, 12).join(', ')}`);
  }
  return `\n${parts.join('\n\n')}\n`;
}

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

  // Lighten any dark background colors extracted from the reference page.
  // Preserves hue/saturation — just raises lightness to 65% minimum.
  const lightenedSpec = lightenDesignColors(designSpec);

  return lightenedSpec;
}

// ─── Foundational Docs helpers ──────────────────────────────────────────────

/**
 * Get the 4 foundational documents for a project.
 * Returns an object with { research, avatar, offer_brief, necessary_beliefs }.
 * Only returns approved docs (latest version of each type).
 */
export async function getFoundationalDocs(projectId) {
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

// ─── Image Context Extraction ───────────────────────────────────────────────

/**
 * Extract avatar demographic details from the free-form avatar document.
 * Pure text parsing — no LLM call. Returns a concise description string
 * like "woman in her 60s, health-conscious, retired, grandmother".
 *
 * @param {string|null} avatarText - Raw avatar document content
 * @returns {string|null} Concise demographic description, or null
 */
function extractAvatarForImages(avatarText) {
  if (!avatarText || avatarText.length < 20) return null;

  const text = avatarText.slice(0, 3000); // Cap scanning length
  const parts = [];

  // 1. Gender detection — count gendered words
  const femaleWords = (text.match(/\b(women|woman|female|she|her|mom|mother|grandmother|grandma|wife|daughter|girl)\b/gi) || []).length;
  const maleWords = (text.match(/\b(men|man|male|he|his|dad|father|grandfather|grandpa|husband|son|boy)\b/gi) || []).length;
  let gender = null;
  if (femaleWords >= maleWords + 3) gender = 'woman';
  else if (maleWords >= femaleWords + 3) gender = 'man';
  else if (femaleWords > maleWords) gender = 'woman';
  else if (maleWords > femaleWords) gender = 'man';

  // 2. Age detection — multiple patterns
  let ageRange = null;

  // "aged 35-55", "ages 40-60", "age 25 to 45"
  const ageRangeMatch = text.match(/\bage[ds]?\s+(\d{2})\s*[-–to]+\s*(\d{2})\b/i);
  if (ageRangeMatch) {
    ageRange = `${ageRangeMatch[1]}-${ageRangeMatch[2]}`;
  }

  // "between 35 and 55"
  if (!ageRange) {
    const betweenMatch = text.match(/\bbetween\s+(\d{2})\s+and\s+(\d{2})\b/i);
    if (betweenMatch) ageRange = `${betweenMatch[1]}-${betweenMatch[2]}`;
  }

  // "in their 60s", "in her 50s"
  if (!ageRange) {
    const decadeMatch = text.match(/\bin\s+(?:their|her|his)\s+(?:late\s+)?(\d{2})s\b/i);
    if (decadeMatch) {
      const decade = parseInt(decadeMatch[0].includes('late') ? decadeMatch[1] : decadeMatch[1]);
      ageRange = decadeMatch[0].includes('late') ? `${decade + 5}-${decade + 9}` : `${decade}-${decade + 9}`;
    }
  }

  // "in their mid-40s"
  if (!ageRange) {
    const midMatch = text.match(/\bin\s+(?:their|her|his)\s+mid[-\s]?(\d{2})s\b/i);
    if (midMatch) {
      const decade = parseInt(midMatch[1]);
      ageRange = `${decade + 3}-${decade + 7}`;
    }
  }

  // "55-year-old", "67 year old"
  if (!ageRange) {
    const yearOldMatch = text.match(/(\d{2})[-\s]year[-\s]old/i);
    if (yearOldMatch) {
      const age = parseInt(yearOldMatch[1]);
      const decade = Math.floor(age / 10) * 10;
      ageRange = `${decade}-${decade + 9}`;
    }
  }

  // "women over 60", "adults above 55"
  if (!ageRange) {
    const overMatch = text.match(/\b(?:women|woman|men|man|adults?|people|individuals?)\s+(?:over|above)\s+(\d{2})\b/i);
    if (overMatch) {
      const base = parseInt(overMatch[1]);
      ageRange = `${base}-${base + 15}`;
    }
  }

  // "55+", "60+ years old"
  if (!ageRange) {
    const plusMatch = text.match(/(\d{2})\+\s*(?:years?\s*old|year-old|demographic|age)?/i);
    if (plusMatch) {
      const base = parseInt(plusMatch[1]);
      ageRange = `${base}-${base + 15}`;
    }
  }

  // "55 to 70 years old", "45 to 65 year old"
  if (!ageRange) {
    const toYearsMatch = text.match(/(\d{2})\s+to\s+(\d{2})\s+years?\s*old/i);
    if (toYearsMatch) ageRange = `${toYearsMatch[1]}-${toYearsMatch[2]}`;
  }

  // "women 55-70", "adults 45-65" (without "aged" prefix)
  if (!ageRange) {
    const demoRangeMatch = text.match(/\b(?:women|woman|men|man|adults?|people)\s+(\d{2})\s*[-–]\s*(\d{2})\b/i);
    if (demoRangeMatch) ageRange = `${demoRangeMatch[1]}-${demoRangeMatch[2]}`;
  }

  // "around 60 years old", "approximately 55"
  if (!ageRange) {
    const aroundMatch = text.match(/\b(?:around|approximately|roughly|about)\s+(\d{2})\s*(?:years?\s*old)?/i);
    if (aroundMatch) {
      const base = parseInt(aroundMatch[1]);
      ageRange = `${base - 5}-${base + 5}`;
    }
  }

  // "primarily 55-70", "typically 45-65"
  if (!ageRange) {
    const qualifiedMatch = text.match(/\b(?:primarily|typically|usually|generally|mostly)\s+(\d{2})\s*[-–to]+\s*(\d{2})\b/i);
    if (qualifiedMatch) ageRange = `${qualifiedMatch[1]}-${qualifiedMatch[2]}`;
  }

  // Build the demographic string
  if (gender && ageRange) {
    parts.push(`${gender} in the ${ageRange} age range`);
  } else if (gender) {
    parts.push(gender);
  } else if (ageRange) {
    parts.push(`person in the ${ageRange} age range`);
  }

  // 3. Lifestyle keywords
  const lifestylePatterns = [
    /\b(health[-\s]conscious)\b/i,
    /\b(busy\s+(?:professional|parent|mom|dad|mother|father))\b/i,
    /\b(retired|retirement)\b/i,
    /\b(grandmother|grandfather|grandparent)\b/i,
    /\b(active\s+lifestyle)\b/i,
    /\b(wellness[-\s]oriented)\b/i,
    /\b(eco[-\s]conscious|environmentally\s+aware)\b/i,
    /\b(budget[-\s]conscious)\b/i,
    /\b(working\s+(?:professional|parent|mom|mother))\b/i,
    /\b(stay[-\s]at[-\s]home\s+(?:mom|dad|parent))\b/i,
    /\b(fitness[-\s]oriented|fitness\s+enthusiast)\b/i,
    /\b(homeowner|homemaker)\b/i,
    /\b(suburban|urban|rural)\b/i,
    /\b(middle[-\s]class|affluent|budget[-\s]minded)\b/i,
  ];

  const lifestyleHits = [];
  for (const pattern of lifestylePatterns) {
    const match = text.match(pattern);
    if (match) lifestyleHits.push(match[1].toLowerCase());
  }

  if (lifestyleHits.length > 0) {
    parts.push(lifestyleHits.slice(0, 3).join(', '));
  }

  if (parts.length === 0) {
    // Fallback: return first meaningful sentence from avatar
    const firstSentence = avatarText.slice(0, 200).split(/[.!?\n]/).filter(s => s.trim().length > 20)[0];
    return firstSentence ? firstSentence.trim() : null;
  }

  return parts.join(', ');
}

/**
 * Extract product visual description from project data + offer brief.
 * Returns a concise string describing the product's physical appearance.
 *
 * @param {object|null} project - Project object with product_description, name
 * @param {string|null} offerBrief - Offer brief document content
 * @returns {string|null} Product description for image prompts
 */
function extractProductForImages(project, offerBrief) {
  const PRODUCT_NOUNS = /\b(bedsheet|bed\s*sheet|sheet|mattress\s*pad|mat|floor\s*mat|grounding\s*mat|supplement|capsule|pill|tablet|powder|serum|cream|lotion|spray|device|band|bracelet|drops|oil|patch|mask|cleaner|filter|purifier|bottle|tincture|gummy|gummies|blanket|pillow|topper|cover|wrap|towel)\b/i;

  // Primary: use project.product_description (user-provided, most reliable)
  if (project?.product_description && project.product_description.length > 10) {
    const desc = project.product_description;
    // Extract the sentence containing the core physical product noun
    const match = desc.match(PRODUCT_NOUNS);
    if (match) {
      const idx = match.index;
      // Find sentence boundaries around the product noun
      const start = Math.max(0, desc.lastIndexOf('.', idx - 1) + 1);
      const dotAfter = desc.indexOf('.', idx + 1);
      const end = dotAfter > -1 ? dotAfter + 1 : Math.min(desc.length, idx + 100);
      const snippet = desc.slice(start, end).trim();
      const prefix = project.brand_name ? `${project.brand_name} ` : '';
      return `${prefix}${snippet}`.slice(0, 200);
    }
    // Fallback: first sentence only (not the full 500-char blob)
    const firstSentence = desc.split(/[.!?\n]/).filter(s => s.trim().length > 10)[0];
    return firstSentence ? firstSentence.trim().slice(0, 200) : desc.slice(0, 150);
  }

  // Fallback: scan offer brief for product-describing sentences
  if (offerBrief) {
    const brief = offerBrief.slice(0, 2000);
    const sentences = brief.split(/[.!?\n]/).filter(s => s.trim().length > 20);
    for (const sentence of sentences) {
      if (PRODUCT_NOUNS.test(sentence)) {
        return sentence.trim().slice(0, 200);
      }
    }
  }

  // Last resort: use project name if it's descriptive enough
  if (project?.name && project.name.length > 5) {
    return project.name;
  }

  return null;
}

// ─── LLM-Powered Visual Context Extraction ──────────────────────────────────

/**
 * Extract structured product visual context from Offer Brief using Claude Sonnet.
 * Returns detailed product identity for image generation prompts.
 *
 * @param {string} offerBriefContent - Raw offer brief document text
 * @param {object|null} project - Project with product_description, name, brand_name
 * @returns {Promise<object|null>} { productName, productType, physicalDescription, usageContext, notThisProduct[] }
 */
async function extractProductVisualContext(offerBriefContent, project) {
  const productDesc = project?.product_description || '';
  const briefExcerpt = (offerBriefContent || '').slice(0, 4000);

  if (!briefExcerpt && !productDesc) return null;

  const messages = [
    {
      role: 'system',
      content: `You are a product analyst extracting visual details for image generation. Be precise and specific about the physical product. Focus on what the product LOOKS LIKE and how it's USED — not marketing claims.

CRITICAL: You must respond with ONLY a valid JSON object. No markdown fences, no text before or after.`,
    },
    {
      role: 'user',
      content: `From the documents below, extract visual product details for image generation.

${productDesc ? `PRODUCT DESCRIPTION (from seller):\n${productDesc.slice(0, 1000)}\n` : ''}
${briefExcerpt ? `OFFER BRIEF:\n${briefExcerpt}\n` : ''}

Extract:
1. productName — exact brand + product name (e.g., "The Grounding Bedsheet by GroundWell")
2. productType — the physical category, stated plainly (e.g., "fitted bed sheet", "dietary supplement capsules", "countertop kitchen device")
3. physicalDescription — what it looks like: color, shape, size, materials, distinguishing features. Be specific. (e.g., "White fitted sheet with thin silver conductive threads woven through the fabric. Includes a thin grounding cord that plugs into the round grounding port of a wall outlet.")
4. usageContext — where and how it's physically used, stated as a scene description (e.g., "On a bed, in a bedroom. The person sleeps on it like a regular fitted sheet.")
5. notThisProduct — array of 3-5 similar but WRONG products that an AI image generator might confuse it with (e.g., ["grounding mat", "floor pad", "standing mat", "yoga mat", "exercise mat"])

Return as JSON:
{
  "productName": "...",
  "productType": "...",
  "physicalDescription": "...",
  "usageContext": "...",
  "notThisProduct": ["...", "...", "..."]
}`,
    },
  ];

  try {
    const response = await chat(messages, 'claude-sonnet-4-6', {
      max_tokens: 1024,
      operation: 'lp_image_context_extraction',
      projectId: project?.externalId || project?.id || null,
      response_format: { type: 'json_object' },
      timeout: 30000,
    });

    const parsed = JSON.parse(response);
    if (!parsed.productName && !parsed.productType) {
      console.warn('[LPGen] Product visual extraction returned empty data');
      return null;
    }
    return parsed;
  } catch (err) {
    console.warn('[LPGen] Product visual extraction failed (non-fatal):', err.message);
    return null;
  }
}

/**
 * Extract structured avatar visual context from Avatar Sheet using Claude Sonnet.
 * Returns detailed demographic/lifestyle details for image generation prompts.
 *
 * @param {string} avatarContent - Raw avatar document text
 * @returns {Promise<object|null>} { gender, ageRange, lifestyle, emotionalState, settingCues, notThisPerson[] }
 */
async function extractAvatarVisualContext(avatarContent) {
  if (!avatarContent || avatarContent.length < 50) return null;

  const excerpt = avatarContent.slice(0, 4000);

  const messages = [
    {
      role: 'system',
      content: `You are a demographic analyst extracting visual details for image generation. Focus on what the target customer LOOKS LIKE, where they LIVE, and what their daily life FEELS LIKE — not marketing segments.

CRITICAL: You must respond with ONLY a valid JSON object. No markdown fences, no text before or after.`,
    },
    {
      role: 'user',
      content: `From this Customer Avatar document, extract visual details for image generation.

AVATAR DOCUMENT:
${excerpt}

Extract:
1. gender — "female", "male", or "mixed" (based on the primary avatar described)
2. ageRange — specific range like "55-70" or "40-55" (based on the document's demographic data)
3. lifestyle — 2-3 sentence description of their daily life, roles, activities (e.g., "Retired grandmother, health-conscious but dealing with chronic joint pain. Spends time at home, in the garden, with grandchildren.")
4. emotionalState — how they feel day-to-day and about trying new products (e.g., "Tired of failed solutions, skeptical but hopeful. Practical, not easily swayed by hype.")
5. settingCues — typical physical environments they'd be in (e.g., "Suburban home, bedroom, kitchen, garden")
6. notThisPerson — array of 3-5 demographics that should NOT appear in images based on who the avatar is NOT (e.g., ["men", "anyone under 45", "fitness models", "corporate executives", "teenagers"])

Return as JSON:
{
  "gender": "...",
  "ageRange": "...",
  "lifestyle": "...",
  "emotionalState": "...",
  "settingCues": "...",
  "notThisPerson": ["...", "...", "..."]
}`,
    },
  ];

  try {
    const response = await chat(messages, 'claude-sonnet-4-6', {
      max_tokens: 1024,
      operation: 'lp_image_context_extraction',
      timeout: 30000,
    });

    const parsed = JSON.parse(response);
    if (!parsed.gender && !parsed.ageRange) {
      console.warn('[LPGen] Avatar visual extraction returned empty data');
      return null;
    }
    return parsed;
  } catch (err) {
    console.warn('[LPGen] Avatar visual extraction failed (non-fatal):', err.message);
    return null;
  }
}

// ─── Image Context Caching Layer ─────────────────────────────────────────────

/**
 * Compute a content hash for cache invalidation.
 * Uses first 500 chars of avatar + offer_brief to detect document changes.
 */
function computeDocsHash(docs) {
  const input = (docs?.avatar || '').slice(0, 500) + '|' + (docs?.offer_brief || '').slice(0, 500);
  return crypto.createHash('md5').update(input).digest('hex');
}

/**
 * Get image generation context with LLM-powered extraction and caching.
 *
 * Flow:
 * 1. Check lp_agent_config cache for pre-extracted context
 * 2. If cache hit + hash matches → return cached data (instant)
 * 3. If cache miss/stale → extract via Claude Sonnet, cache, return
 * 4. If no foundational docs → fall back to regex-based extractors
 *
 * @param {string} projectId - Project externalId
 * @param {object} docs - { avatar, offer_brief, research, necessary_beliefs }
 * @param {object|null} project - Project object
 * @returns {Promise<object>} Image context with avatarContext, productContext, brandName, niche, productVisual, avatarVisual
 */
export async function getCachedImageContext(projectId, docs, project) {
  const brandName = project?.brand_name || project?.name || null;
  const niche = project?.niche || null;
  const hasDocs = !!(docs?.avatar || docs?.offer_brief);

  // If no foundational docs, fall back to regex-based extraction (legacy path)
  if (!hasDocs) {
    return {
      avatarContext: extractAvatarForImages(docs?.avatar || null),
      productContext: extractProductForImages(project, docs?.offer_brief || null),
      brandName,
      niche,
      productVisual: null,
      avatarVisual: null,
    };
  }

  const currentHash = computeDocsHash(docs);

  // Try to read cache from lp_agent_config
  let config = null;
  try {
    config = await getLPAgentConfig(projectId);
  } catch (err) {
    console.warn('[LPGen] Failed to load LP agent config for cache (non-fatal):', err.message);
  }

  // Check cache validity
  let cachedProduct = null;
  let cachedAvatar = null;
  let cacheHit = false;

  if (config) {
    try {
      if (config.cached_product_visual_context) {
        const parsed = JSON.parse(config.cached_product_visual_context);
        if (parsed.sourceHash === currentHash && parsed.data) {
          cachedProduct = parsed.data;
        }
      }
      if (config.cached_avatar_visual_context) {
        const parsed = JSON.parse(config.cached_avatar_visual_context);
        if (parsed.sourceHash === currentHash && parsed.data) {
          cachedAvatar = parsed.data;
        }
      }
      // Cache hit only if BOTH are present and fresh
      cacheHit = !!(cachedProduct && cachedAvatar);
    } catch (err) {
      console.warn('[LPGen] Failed to parse cached image context:', err.message);
    }
  }

  if (cacheHit) {
    console.log(`[LPGen] Using cached image context for project ${projectId.slice(0, 8)}`);
    return buildContextFromVisuals(cachedProduct, cachedAvatar, project, docs);
  }

  // Cache miss — extract via Claude Sonnet
  console.log(`[LPGen] Extracting image context via Claude Sonnet for project ${projectId.slice(0, 8)}...`);

  // Extract in parallel (both are independent Claude calls)
  const [productVisual, avatarVisual] = await Promise.all([
    docs.offer_brief ? extractProductVisualContext(docs.offer_brief, project) : Promise.resolve(null),
    docs.avatar ? extractAvatarVisualContext(docs.avatar) : Promise.resolve(null),
  ]);

  // Cache the results (fire-and-forget — don't block on cache write)
  const cachePayload = {};
  if (productVisual) {
    cachePayload.cached_product_visual_context = JSON.stringify({
      sourceHash: currentHash,
      extractedAt: new Date().toISOString(),
      data: productVisual,
    });
  }
  if (avatarVisual) {
    cachePayload.cached_avatar_visual_context = JSON.stringify({
      sourceHash: currentHash,
      extractedAt: new Date().toISOString(),
      data: avatarVisual,
    });
  }

  if (Object.keys(cachePayload).length > 0) {
    upsertLPAgentConfig(projectId, cachePayload).catch(err => {
      console.warn('[LPGen] Failed to cache image context (non-fatal):', err.message);
    });
    console.log(`[LPGen] Extracted and cached image context for project ${projectId.slice(0, 8)}: product=${!!productVisual}, avatar=${!!avatarVisual}`);
  }

  return buildContextFromVisuals(productVisual, avatarVisual, project, docs);
}

/**
 * Build the image context object from LLM-extracted visuals.
 * Creates backward-compatible avatarContext/productContext strings from the richer data.
 */
function buildContextFromVisuals(productVisual, avatarVisual, project, docs) {
  // Build concise string representations (backward-compatible with old format)
  let avatarContext = null;
  if (avatarVisual) {
    const parts = [];
    if (avatarVisual.gender === 'female') parts.push('woman');
    else if (avatarVisual.gender === 'male') parts.push('man');
    if (avatarVisual.ageRange) parts.push(`in the ${avatarVisual.ageRange} age range`);
    if (avatarVisual.lifestyle) {
      // Extract first few key descriptors
      const shortLifestyle = avatarVisual.lifestyle.split(/[.,]/).slice(0, 2).map(s => s.trim().toLowerCase()).filter(s => s.length > 3).join(', ');
      if (shortLifestyle) parts.push(shortLifestyle);
    }
    avatarContext = parts.join(', ') || null;
  }
  // Fall back to regex if LLM extraction didn't produce results
  if (!avatarContext) {
    avatarContext = extractAvatarForImages(docs?.avatar || null);
  }

  let productContext = null;
  if (productVisual) {
    productContext = `${productVisual.productName || ''} — ${productVisual.productType || ''}. ${productVisual.physicalDescription || ''}`.trim().slice(0, 300);
  }
  // Fall back to regex if LLM extraction didn't produce results
  if (!productContext) {
    productContext = extractProductForImages(project, docs?.offer_brief || null);
  }

  return {
    avatarContext,
    productContext,
    brandName: project?.brand_name || project?.name || null,
    niche: project?.niche || null,
    productVisual: productVisual || null,
    avatarVisual: avatarVisual || null,
  };
}

/**
 * Load project + foundational docs and extract image generation context.
 * Used in manual mode where these aren't pre-loaded.
 *
 * @param {string} projectId
 * @returns {object} Image context with avatarContext, productContext, brandName, niche, productVisual, avatarVisual
 */
export async function extractImageContext(projectId) {
  try {
    const [docs, project] = await Promise.all([
      getFoundationalDocs(projectId).catch(() => ({})),
      getProject(projectId).catch(() => null),
    ]);
    return getCachedImageContext(projectId, docs, project);
  } catch (err) {
    console.warn('[LPGen] extractImageContext failed (non-fatal):', err.message);
    return { avatarContext: null, productContext: null, brandName: null, niche: null, productVisual: null, avatarVisual: null };
  }
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
  angleBrief = null,  // Structured angle brief from conductor_angles (optional)
  swipeText,
  wordCount = 1200,
  additionalDirection,
  approvedAds = [],  // Approved batch ads for messaging alignment
  messageBrief = null,
  autoContext,  // { narrativeFrame, foundationalDocs } — only in auto mode
  headlineConstraints = null,
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

TESTIMONIAL UNIQUENESS: Each testimonial quote must appear ONLY ONCE on the entire page. If the template has multiple testimonial slots (e.g., testimonial, section_3_body_2, proof), generate a DIFFERENT testimonial for each one — different person, different quote, different angle on why the product works. NEVER include the same person's testimonial in both body text AND a separate testimonial/blockquote section. Each attributed name must appear exactly once across all sections. Never repeat the same quote or paraphrase of the same quote anywhere on the page.

PULLQUOTE / CALLOUT RULE — MANDATORY:
When you create a styled pullquote, highlight box, callout, stat box, or any visually emphasized text element, that text is REPLACING the equivalent body copy — not supplementing it. Do NOT include the same sentence or phrase in both a styled element AND the body narrative. If a key moment appears as a pullquote or highlight, the body text should continue from AFTER that moment, not repeat it.

Example of what NOT to do:
  [Highlight: "I woke up at 6:47 AM."]
  Body: "I woke up at 6:47 AM. I lay there for a moment..."

Correct:
  [Highlight: "I woke up at 6:47 AM."]
  Body: "I lay there for a moment, confused..."

The callout carries the moment. The body text picks up where the callout leaves off.

AUTHOR METADATA: Generate an appropriate author name and title for this article's byline. The name should:
- Match the target demographic from the Avatar Sheet (if the audience is women 60-75, the author should be a woman with a name that fits that generation; if the audience is men 30-50, use an appropriate male name)
- Feel like a real person, not a brand or company name
- Use first name + last initial format (e.g., "Carol H.", "Margaret S.", "Rachel T.")
- Include a brief, relatable title (e.g., "Retired teacher", "Health & Wellness Editor", "Mother of three")
- Be different from any testimonial names used in the article

Include in your JSON output two top-level fields alongside the "sections" array:
  "generated_author_name": "Carol H.",
  "generated_author_title": "Retired Teacher & Wellness Advocate"

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
  const headlineConstraintInstruction = buildHeadlineConstraintInstruction(headlineConstraints);
  const campaignMessageInstruction = buildCampaignMessageInstruction(messageBrief);

  // Build approved ad reference section (only when ads are available from a real batch)
  let adReferenceSection = '';
  if (approvedAds.length > 0) {
    const adSummaries = approvedAds.map((ad, i) => {
      const headline = ad.headline || 'No headline';
      const opening = ad.body_copy ? ad.body_copy.split(/[.!?]\s/)[0] + '.' : '';
      return `  ${i + 1}. HEADLINE: ${headline}${opening ? `\n     OPENING: ${opening}` : ''}`;
    }).join('\n');

    adReferenceSection = `
APPROVED AD CAMPAIGN REFERENCE:
The following are the approved ad headlines and opening lines from this campaign. These are the ads that have passed quality review and will actually run. Your landing page must feel like the exact click-through continuation of this campaign. Do not copy the ads word-for-word, but do keep the same problem, same promise, same buyer state, and same message direction.

If a reader clicked one of these ads, the landing page must feel like it was built to fulfill that ad's promise, not a generic adjacent angle.

${adSummaries}
`;
  }

  // Build enriched angle context from structured brief when available
  let angleSection = angle || 'General';
  if (angleBrief && (angleBrief.core_buyer || angleBrief.scene || angleBrief.tone)) {
    const parts = [angle || angleBrief.name || 'General'];
    if (angleBrief.core_buyer) parts.push(`Core Buyer: ${angleBrief.core_buyer}`);
    if (angleBrief.scene) parts.push(`Scene: ${angleBrief.scene}`);
    if (angleBrief.desired_belief_shift) parts.push(`Desired Belief Shift: ${angleBrief.desired_belief_shift}`);
    if (angleBrief.tone) parts.push(`Tone: ${angleBrief.tone}`);
    if (angleBrief.avoid_list) parts.push(`Avoid: ${angleBrief.avoid_list}`);
    angleSection = parts.join('\n');
  }

  const generateMessage = `Now write a landing page using the product knowledge from the documents above.

MARKETING ANGLE / HOOK:
${angleSection}

TARGET WORD COUNT: approximately ${wordCount} words
${narrativeInstruction}${headlineConstraintInstruction}${campaignMessageInstruction}${adReferenceSection}
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

  // Extract auto-generated author if present
  const autoGeneratedAuthor = {};
  if (parsed.generated_author_name) {
    autoGeneratedAuthor.name = parsed.generated_author_name;
    console.log(`[LPGen] Auto-generated author name: ${autoGeneratedAuthor.name}`);
  }
  if (parsed.generated_author_title) {
    autoGeneratedAuthor.title = parsed.generated_author_title;
    console.log(`[LPGen] Auto-generated author title: ${autoGeneratedAuthor.title}`);
  }

  // ── P1: Word count validation ──
  // Check that generated copy hits the target word count within tolerance:
  //   - Cannot be more than 10% below target
  //   - Cannot be more than 40% above target
  const totalWords = validSections.reduce((sum, s) => sum + (s.content || '').split(/\s+/).filter(Boolean).length, 0);
  const minWords = Math.round(wordCount * 0.9);
  const maxWords = Math.round(wordCount * 1.4);
  console.log(`[LPGen] Word count check: ${totalWords} words generated, target ${wordCount} (allowed range: ${minWords}–${maxWords})`);

  if (totalWords < minWords || totalWords > maxWords) {
    const direction = totalWords < minWords ? 'too short' : 'too long';
    console.warn(`[LPGen] Copy is ${direction} (${totalWords} words vs target ${wordCount}). Retrying once...`);
    sendEvent({ type: 'progress', step: 'word_count_retry', message: `Copy is ${direction} (${totalWords} words). Retrying with stronger word count guidance...` });

    const retryDirection = totalWords < minWords
      ? `Your previous attempt was only ${totalWords} words — far too short. You MUST write at least ${wordCount} words. Expand each section with more detail, storytelling, and supporting evidence.`
      : `Your previous attempt was ${totalWords} words — too long and unfocused. You MUST write approximately ${wordCount} words. Tighten each section, cut filler, and keep only the most compelling copy.`;

    const retryMessages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: docsMessage },
      { role: 'assistant', content: 'I\'ve carefully studied all four foundational documents. I understand the customer avatar, their beliefs and objections, the offer positioning, and the supporting research. I\'m ready to write the landing page. Please provide the angle, swipe reference, and any additional direction.' },
      { role: 'user', content: `${generateMessage}\n\nCRITICAL WORD COUNT CORRECTION: ${retryDirection}` },
    ];

    const retryResponse = await chat(retryMessages, 'claude-sonnet-4-6', {
      max_tokens: 16384,
      operation: 'lp_generation_retry',
      projectId,
      response_format: { type: 'json_object' },
      timeout: 180000,
    });

    let retryParsed;
    try {
      retryParsed = JSON.parse(retryResponse);
    } catch {
      const jsonMatch = retryResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try { retryParsed = JSON.parse(jsonMatch[0]); } catch { retryParsed = null; }
      }
    }

    if (retryParsed?.sections && Array.isArray(retryParsed.sections)) {
      const retrySections = retryParsed.sections.filter(s => s.type && s.content);
      const retryWords = retrySections.reduce((sum, s) => sum + (s.content || '').split(/\s+/).filter(Boolean).length, 0);
      console.log(`[LPGen] Retry word count: ${retryWords} words (target ${wordCount}, range ${minWords}–${maxWords})`);

      if (retryWords >= minWords && retryWords <= maxWords) {
        // Retry hit the target — use it
        sendEvent({ type: 'progress', step: 'word_count_fixed', message: `Retry successful: ${retryWords} words (target: ${wordCount})` });
        // Extract author from retry if present
        if (retryParsed.generated_author_name) autoGeneratedAuthor.name = retryParsed.generated_author_name;
        if (retryParsed.generated_author_title) autoGeneratedAuthor.title = retryParsed.generated_author_title;
        return { sections: retrySections, autoGeneratedAuthor: Object.keys(autoGeneratedAuthor).length > 0 ? autoGeneratedAuthor : null, wordCountWarning: null };
      } else if (Math.abs(retryWords - wordCount) < Math.abs(totalWords - wordCount)) {
        // Retry is closer to target even if not perfect — use it
        console.warn(`[LPGen] Retry closer to target (${retryWords} vs original ${totalWords}) but still outside range. Using retry.`);
        sendEvent({ type: 'progress', step: 'word_count_improved', message: `Retry improved: ${retryWords} words (still outside target but closer)` });
        if (retryParsed.generated_author_name) autoGeneratedAuthor.name = retryParsed.generated_author_name;
        if (retryParsed.generated_author_title) autoGeneratedAuthor.title = retryParsed.generated_author_title;
        return { sections: retrySections, autoGeneratedAuthor: Object.keys(autoGeneratedAuthor).length > 0 ? autoGeneratedAuthor : null, wordCountWarning: `Word count ${retryWords} outside target range ${minWords}–${maxWords} (target ${wordCount}) after retry` };
      }
    }
    // Retry failed or was worse — use original
    console.warn(`[LPGen] Retry didn't improve word count. Using original (${totalWords} words).`);
    sendEvent({ type: 'progress', step: 'word_count_warning', message: `Word count ${totalWords} outside target range (keeping original)` });
  }

  return { sections: validSections, autoGeneratedAuthor: Object.keys(autoGeneratedAuthor).length > 0 ? autoGeneratedAuthor : null, wordCountWarning: (totalWords < minWords || totalWords > maxWords) ? `Word count ${totalWords} outside target range ${minWords}–${maxWords} (target ${wordCount})` : null };
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
  approvedAds = [],
  messageBrief = null,
  pdpUrl,
  projectId,
  headlineConstraints = null,
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

NARRATIVE FRAME ALIGNMENT: The headline and subheadline MUST reflect the specific narrative frame being used. A testimonial frame should have a personal, first-person headline. A mechanism frame should lead with curiosity about the "how." A problem agitation frame should hook with the reader's pain. A myth-busting frame should challenge a common belief. A listicle frame should use a numbered format. The headline is the #1 signal that differentiates each narrative frame — never produce a generic headline that could work for any frame.

TEMPLATE FIDELITY: Your editorial plan must work within the template structure. You can reorder sections, adjust emphasis, insert callout blocks at specified positions, and refine copy — but you CANNOT add entirely new structural elements that don't exist in the template skeleton. For example, do NOT add a sticky urgency banner if the template doesn't have one. Do NOT add floating CTAs, countdown timers, notification bars, or any other conversion elements unless they already exist in the template. The template is the blueprint — optimize within it, don't expand beyond it. Set "top_banner_text" to null if the template has no banner element.

DUPLICATE HEADING CHECK: Check all callout blocks and data boxes for duplicate heading text. If a callout's body paragraph begins with the same text as its heading label (e.g., heading="USDA DATA" and body starts with "USDA DATA:"), remove the duplicate from the body.

CRITICAL: Also scan the copy for any remaining {{placeholder}} template tags (e.g., {{author_name}}, {{publish_date}}, {{TRENDING_CATEGORY}}). If you find any, provide replacement text in the "placeholder_fills" field of your response.`;

  // Build ad reference for editorial pass
  let editorialAdReference = '';
  if (approvedAds.length > 0) {
    const adHeadlines = approvedAds
      .filter(ad => ad.headline)
      .map((ad, i) => `  ${i + 1}. ${ad.headline}`)
      .join('\n');
    editorialAdReference = `
APPROVED AD HEADLINES FROM THIS CAMPAIGN:
A reader clicked on one of these ads and landed on this page. Your LP headline and editorial choices must deliver on the same promise and message direction that drew them in. Treat these as the campaign message contract, not loose inspiration.

${adHeadlines}
`;
  }

  const userPrompt = `Review this landing page draft and provide your editorial plan.

MARKETING ANGLE: ${angle}
NARRATIVE FRAME: ${narrativeFrame || 'general'}
IMPORTANT: The headline MUST be unique to this narrative frame. It should reflect the storytelling approach described above — a testimonial frame headline reads completely differently from a mechanism or listicle headline.
HEADLINE CONTRACT: ${headlineConstraints?.contract || getNarrativeFrameHeadlineContract(narrativeFrame)}
${buildHeadlineConstraintInstruction(headlineConstraints)}
${buildCampaignMessageInstruction(messageBrief)}
${editorialAdReference}PDP URL: ${pdpUrl || 'not set'}
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
  "headline": "Your optimized headline reflecting this frame's unique voice (max 15 words)",
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

  // ── P2: Retry editorial pass on failure (up to 2 attempts) ──
  const MAX_EDITORIAL_ATTEMPTS = 2;
  for (let attempt = 1; attempt <= MAX_EDITORIAL_ATTEMPTS; attempt++) {
    try {
      const response = await chat(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        'claude-sonnet-4-6',
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
          console.warn(`[LPGen] Editorial pass attempt ${attempt}/${MAX_EDITORIAL_ATTEMPTS} returned non-JSON response`);
          if (attempt < MAX_EDITORIAL_ATTEMPTS) {
            sendEvent({ type: 'progress', step: 'editorial_retrying', message: `Editorial review returned invalid format — retrying (attempt ${attempt + 1})...` });
            continue; // Retry
          }
          sendEvent({ type: 'progress', step: 'editorial_skipped', message: 'Editorial review returned invalid format after retry — proceeding without it' });
          return { plan: null, noEditorialPlan: true };
        }
      }

      // Validate minimum shape
      if (!editorialPlan.headline && !editorialPlan.sections_order) {
        console.warn(`[LPGen] Editorial plan attempt ${attempt}/${MAX_EDITORIAL_ATTEMPTS} missing required fields`);
        if (attempt < MAX_EDITORIAL_ATTEMPTS) {
          sendEvent({ type: 'progress', step: 'editorial_retrying', message: `Editorial plan incomplete — retrying (attempt ${attempt + 1})...` });
          continue; // Retry
        }
        sendEvent({ type: 'progress', step: 'editorial_skipped', message: 'Editorial plan incomplete after retry — proceeding without it' });
        return { plan: null, noEditorialPlan: true };
      }

      sendEvent({
        type: 'progress',
        step: 'editorial_complete',
        message: `Editorial review complete: ${editorialPlan.callouts?.length || 0} callouts, ${editorialPlan.sections_to_cut?.length || 0} cuts`,
      });

      return { plan: editorialPlan, noEditorialPlan: false };
    } catch (err) {
      console.warn(`[LPGen] Editorial pass attempt ${attempt}/${MAX_EDITORIAL_ATTEMPTS} failed:`, err.message);
      if (attempt < MAX_EDITORIAL_ATTEMPTS) {
        sendEvent({ type: 'progress', step: 'editorial_retrying', message: `Editorial review failed — retrying (attempt ${attempt + 1})...` });
        continue; // Retry
      }
      sendEvent({ type: 'progress', step: 'editorial_failed', message: `Editorial review failed after ${MAX_EDITORIAL_ATTEMPTS} attempts — proceeding without it: ${err.message}` });
      return { plan: null, noEditorialPlan: true };
    }
  }

  // Should not reach here, but safety fallback
  return { plan: null, noEditorialPlan: true };
}

export async function repairLPHeadline({
  projectId,
  angle,
  narrativeFrame,
  headline,
  subheadline,
  copySections,
  approvedAds = [],
  messageBrief = null,
  headlineConstraints = null,
}, sendEvent = () => {}) {
  sendEvent({ type: 'progress', step: 'headline_repair', message: 'Repairing landing page headline...' });

  const copySummary = (Array.isArray(copySections) ? copySections : [])
    .map((section) => `[${section.type}] ${section.content}`)
    .join('\n\n')
    .slice(0, 6000);

  const adReference = approvedAds.length > 0
    ? `APPROVED AD MESSAGE CONTRACT:\n${approvedAds.slice(0, 6).map((ad, index) => `${index + 1}. ${ad.headline}`).join('\n')}\n`
    : '';

  const response = await chat(
    [
      {
        role: 'system',
        content: 'You rewrite landing page headlines for direct-response advertorials. Return JSON only.',
      },
      {
        role: 'user',
        content: `Repair the headline and subheadline for this landing page.

ANGLE: ${angle}
NARRATIVE FRAME: ${narrativeFrame}
HEADLINE CONTRACT: ${headlineConstraints?.contract || getNarrativeFrameHeadlineContract(narrativeFrame)}
${buildHeadlineConstraintInstruction(headlineConstraints)}${buildCampaignMessageInstruction(messageBrief)}
CURRENT HEADLINE: ${headline || '(none)'}
CURRENT SUBHEADLINE: ${subheadline || '(none)'}
${adReference}
COPY SUMMARY:
${copySummary}

Return JSON:
{
  "headline": "replacement headline",
  "subheadline": "replacement subheadline",
  "reason": "brief explanation"
}

Rules:
- The new headline must sound like this narrative frame, not a generic advertorial.
- It must stay unmistakably aligned with the angle and the campaign message contract above.
- It must not overlap the already-used or recent-history headlines listed above.
- Keep it concise and specific.
- The subheadline should support the headline without repeating it word-for-word.`,
      },
    ],
    'claude-sonnet-4-6',
    {
      max_tokens: 1024,
      timeout: 45000,
      operation: 'lp_headline_repair',
      projectId,
      response_format: { type: 'json_object' },
    }
  );

  const parsed = extractJSON(response);
  if (!parsed?.headline) {
    throw new Error('Headline repair returned malformed JSON.');
  }

  return {
    headline: String(parsed.headline || '').trim(),
    subheadline: String(parsed.subheadline || '').trim(),
    reason: String(parsed.reason || '').trim(),
  };
}

export async function repairLPContentAlignment({
  projectId,
  angle,
  narrativeFrame,
  copySections,
  approvedAds = [],
  messageBrief = null,
  headlineConstraints = null,
}, sendEvent = () => {}) {
  sendEvent({ type: 'progress', step: 'content_alignment_repair', message: 'Repairing landing page copy alignment...' });

  const response = await chat(
    [
      {
        role: 'system',
        content: 'You repair direct-response landing page copy so it stays aligned with a required angle, narrative frame, and ad message. Return JSON only.',
      },
      {
        role: 'user',
        content: `Repair this landing page copy so it stays aligned with the exact source message.

ANGLE: ${angle}
NARRATIVE FRAME: ${narrativeFrame}
HEADLINE CONTRACT: ${headlineConstraints?.contract || getNarrativeFrameHeadlineContract(narrativeFrame)}
${buildHeadlineConstraintInstruction(headlineConstraints)}${buildCampaignMessageInstruction(messageBrief)}
APPROVED AD THEMES:
${approvedAds.slice(0, 6).map((ad, index) => `${index + 1}. HEADLINE: ${ad.headline || '(none)'}${ad.body_copy ? `\n   OPENING: ${String(ad.body_copy).split(/[.!?]\\s/)[0]}.` : ''}`).join('\n')}

CURRENT COPY SECTIONS:
${(Array.isArray(copySections) ? copySections : []).map((section) => `[${section.type}] ${section.content}`).join('\n\n').slice(0, 9000)}

Return JSON:
{
  "sections": [
    { "type": "headline", "content": "..." },
    { "type": "subheadline", "content": "..." },
    { "type": "lead", "content": "..." }
  ],
  "reason": "brief explanation"
}

Rules:
- Keep the page aligned with the exact angle and campaign message.
- Keep the narrative frame unmistakable throughout the lead/problem/solution flow.
- Do not drift into generic sleep or wellness advice.
- Preserve the current headline and subheadline unless they need a small supporting tweak to keep the copy coherent.
- Return the full updated sections array, not just changed sections.`,
      },
    ],
    'claude-sonnet-4-6',
    {
      max_tokens: 8192,
      timeout: 120000,
      operation: 'lp_content_alignment_repair',
      projectId,
      response_format: { type: 'json_object' },
    }
  );

  const parsed = extractJSON(response);
  if (!parsed?.sections || !Array.isArray(parsed.sections)) {
    throw new Error('Content alignment repair returned malformed JSON.');
  }

  const validSections = parsed.sections
    .filter((section) => section?.type && section?.content)
    .map((section) => ({
      type: String(section.type).trim(),
      content: String(section.content).trim(),
    }));

  if (validSections.length === 0) {
    throw new Error('Content alignment repair returned no valid sections.');
  }

  return {
    sections: validSections,
    reason: String(parsed.reason || '').trim(),
  };
}

// ─── Phase 2C: Image generation via Gemini ──────────────────────────────────

/**
 * Detect the narrative role of an image slot based on its description and position.
 * Used to tailor the image prompt to the slot's purpose in the article's story arc.
 */
function detectSlotRole(slot, slotIndex, totalSlots) {
  const desc = (slot.description || '').toLowerCase();
  const loc = (slot.location || '').toLowerCase();
  const combined = `${desc} ${loc}`;

  // Explicit matches based on design analysis descriptions
  if (combined.includes('hero') || (slotIndex === 0 && totalSlots >= 2)) return 'hero';
  if (combined.includes('product') && (combined.includes('shot') || combined.includes('image') || combined.includes('photo') || combined.includes('in use') || combined.includes('display'))) return 'product';
  if (combined.includes('before') && combined.includes('after')) return 'transformation';
  if (combined.includes('result') || combined.includes('transform') || combined.includes('success') || combined.includes('outcome')) return 'results';
  if (combined.includes('problem') || combined.includes('pain') || combined.includes('struggle') || combined.includes('frustrat')) return 'problem';
  if (combined.includes('lifestyle') || combined.includes('daily') || combined.includes('natural') || combined.includes('everyday')) return 'lifestyle';
  if (combined.includes('proof') || combined.includes('testimonial') || combined.includes('review') || combined.includes('customer')) return 'social_proof';
  if (combined.includes('benefit') || combined.includes('solution') || combined.includes('mechanism') || combined.includes('how it works')) return 'solution';
  if (combined.includes('product')) return 'product'; // Catch-all for any remaining "product" mentions

  // Position-based fallback for slots without descriptive text
  if (totalSlots >= 3) {
    if (slotIndex === totalSlots - 1) return 'lifestyle';
    if (slotIndex === 1) return 'problem';
  }

  return 'general';
}

/** Narrative direction for each slot role — guides the image's mood and content. */
const SLOT_ROLE_DIRECTIONS = {
  hero: 'Emotional hook — capture attention immediately. Show the aspirational outcome or the compelling moment that draws the reader in. This is the first image they see.',
  problem: 'Pain point visualization — show the frustration, struggle, or everyday difficulty the target customer faces BEFORE discovering the product. Evoke empathy and recognition.',
  product: 'Product in context — show the actual product being used or displayed in a natural, appealing home setting. The product should be clearly visible and identifiable.',
  solution: 'Mechanism or benefit reveal — show the product in action or visualize the key benefit that makes this product work differently from alternatives.',
  results: 'Transformation or success — show the positive outcome after using the product. Show relief, confidence, energy, or joy. Contrast with the problem state.',
  lifestyle: 'Natural lifestyle setting — show the target customer living their best life with the product integrated naturally. Aspirational but believable.',
  social_proof: 'Trust and credibility — show real-looking people who could be satisfied customers, in a setting that evokes community and shared positive experience.',
  transformation: 'Before and after — show a clear visual contrast between the problem state and the result state. Make the improvement obvious and compelling.',
  general: 'Professional lifestyle or product image that supports the article\'s marketing message and matches the target customer demographic.',
};

/**
 * Build a rich, context-aware image prompt for Gemini.
 * Assembles slot role direction + avatar + product + narrative context + constraints.
 *
 * @param {object} slot - Image slot definition
 * @param {string} angle - Marketing angle
 * @param {string} copyContext - Condensed copy sections for tone matching
 * @param {object|null} autoContext - { narrativeFrame, editorialPlan, imageContext }
 * @param {number} slotIndex - 0-based index
 * @param {number} totalSlots - Total number of image slots
 * @returns {string} Complete Gemini prompt
 */
function buildImagePrompt(slot, angle, copyContext, autoContext, slotIndex, totalSlots, angleBrief = null) {
  const imageContext = autoContext?.imageContext || {};
  const slotRole = detectSlotRole(slot, slotIndex, totalSlots);
  const roleDirection = SLOT_ROLE_DIRECTIONS[slotRole] || SLOT_ROLE_DIRECTIONS.general;

  // Pull LLM-extracted visuals if available (richer than regex-based strings)
  const pv = imageContext.productVisual; // { productName, productType, physicalDescription, usageContext, notThisProduct[] }
  const av = imageContext.avatarVisual;  // { gender, ageRange, lifestyle, emotionalState, settingCues, notThisPerson[] }

  // ── Build SUBJECT description (WHO + WHAT — the most important part) ──
  // This goes first so Gemini reads it before anything else
  let subjectDescription;

  if (slotRole === 'product' && (pv || imageContext.productContext)) {
    if (pv) {
      subjectDescription = `${pv.productName || pv.productType}: ${pv.physicalDescription || ''}. Photographed in a natural editorial style — close-up or medium shot showing the product clearly.`;
    } else {
      subjectDescription = `A ${imageContext.productContext}, photographed in a natural editorial style. Close-up or medium shot showing the product clearly.`;
    }
  } else if ((av || imageContext.avatarContext) && (pv || imageContext.productContext)) {
    // Person + product scene
    const personDesc = av
      ? `A ${av.gender === 'female' ? 'woman' : av.gender === 'male' ? 'man' : 'person'} in ${av.gender === 'female' ? 'her' : av.gender === 'male' ? 'his' : 'their'} ${av.ageRange || '50s-60s'}. ${av.lifestyle ? av.lifestyle.split('.')[0] + '.' : ''} ${av.emotionalState ? av.emotionalState.split('.')[0] + '.' : ''}`
      : `A ${imageContext.avatarContext}`;
    const productDesc = pv
      ? `${pv.productName || pv.productType} (${pv.productType || ''}) — ${pv.physicalDescription || ''}`
      : imageContext.productContext;
    subjectDescription = `${personDesc}\nUsing or near: ${productDesc}.\nNatural pose, authentic expression, real setting.`;
  } else if (av || imageContext.avatarContext) {
    const personDesc = av
      ? `A ${av.gender === 'female' ? 'woman' : av.gender === 'male' ? 'man' : 'person'} in ${av.gender === 'female' ? 'her' : av.gender === 'male' ? 'his' : 'their'} ${av.ageRange || '50s-60s'}. ${av.lifestyle ? av.lifestyle.split('.')[0] + '.' : ''}`
      : `A ${imageContext.avatarContext}`;
    subjectDescription = `${personDesc}\nNatural pose, authentic setting, genuine expression.`;
  } else {
    subjectDescription = slot.description || 'Editorial lifestyle photograph for a health/wellness article';
  }

  // ── Build SCENE context (secondary — where and why) ──
  const settingHint = av?.settingCues ? ` Setting: ${av.settingCues}.` : '';
  const usageHint = pv?.usageContext ? ` Usage: ${pv.usageContext}` : '';
  // Enrich scene with structured brief context when available
  let angleHint = `Marketing angle: ${angle}.`;
  if (angleBrief && (angleBrief.scene || angleBrief.tone)) {
    const parts = [`Marketing angle: ${angle}.`];
    if (angleBrief.scene) parts.push(`Scene context: ${angleBrief.scene}.`);
    if (angleBrief.tone) parts.push(`Tone: ${angleBrief.tone}.`);
    angleHint = parts.join(' ');
  }
  const sceneDescription = `${slot.description || 'Lifestyle scene'}. ${angleHint}${settingHint}${usageHint}`;

  // ── P4: Narrative frame–specific image style hints ──
  const NARRATIVE_IMAGE_STYLES = {
    testimonial: 'TESTIMONIAL FRAME — Intimate, personal, warm feel. Show real moments of a person sharing their story. Candid, documentary-style composition. Emotion-forward: relief, gratitude, genuine joy. Like a photo from a personal blog post.',
    mechanism: 'MECHANISM FRAME — Clean, scientific, explanatory feel. Show the product or process clearly. Well-lit, almost clinical composition but still warm. Focus on the "how it works" — ingredient close-ups, product in use, cause-and-effect visuals.',
    problem_agitation: 'PROBLEM AGITATION FRAME — Show the struggle, frustration, discomfort of the before-state. Slightly desaturated or moody lighting. The person should look tired, overwhelmed, or struggling. Evoke empathy — the viewer should recognize their own pain.',
    myth_busting: 'MYTH BUSTING FRAME — Surprising, eye-opening, counter-intuitive feel. Show unexpected juxtapositions or reveals. Bright, attention-grabbing. The image should make the viewer stop and think "I didn\'t know that."',
    listicle: 'LISTICLE FRAME — Organized, editorial, magazine-style. Clean backgrounds, good separation of elements. Each image should feel like it belongs in a curated list article. Professional, crisp, well-composed.',
  };

  // Match narrative frame to style hint
  let narrativeHint = '';
  if (autoContext?.narrativeFrame) {
    const frameKey = Object.keys(NARRATIVE_IMAGE_STYLES).find(key =>
      autoContext.narrativeFrame.toLowerCase().includes(key)
    );
    if (frameKey) {
      narrativeHint = `\n${NARRATIVE_IMAGE_STYLES[frameKey]}`;
    } else {
      narrativeHint = `\nNARRATIVE STYLE: "${autoContext.narrativeFrame}" storytelling approach. Match the image mood to this narrative.`;
    }
  }

  // Editorial direction per-slot override
  const editorialImageUpdates = {};
  if (autoContext?.editorialPlan?.image_direction_updates) {
    for (const update of autoContext.editorialPlan.image_direction_updates) {
      if (update.slot && update.updated_direction) {
        editorialImageUpdates[update.slot] = update.updated_direction;
      }
    }
  }
  const slotId = slot.slot_id || `image_${slotIndex + 1}`;
  const editorialDirection = editorialImageUpdates[slotId];
  const editorialHint = editorialDirection
    ? `\nEDITORIAL DIRECTION: ${editorialDirection}`
    : '';

  // ── Constraints (negative prompting — works best at end for Gemini) ──
  let constraints = `STRICT REQUIREMENTS:
- Photorealistic editorial photography — like a real photo in a magazine feature article
- ABSOLUTELY NO TEXT, WORDS, LETTERS, NUMBERS, WATERMARKS, OR LOGOS anywhere in the image — not on screens, not on products, not on clothing, not on signs, not on labels, nowhere
- No UI elements, buttons, banners, overlays, or graphic design elements
- No phones, tablets, laptop screens, or any device displaying text or graphics
- Warm, natural lighting. Shallow depth of field where appropriate
- Clean composition, intentional framing, professional color grading
- If people are shown, they must look natural and authentic — real expressions, real settings, NOT posed stock photography`;

  // Rich demographic constraints from LLM extraction
  if (av) {
    const genderWord = av.gender === 'female' ? 'woman' : av.gender === 'male' ? 'man' : 'person';
    constraints += `\n- The person MUST be: a ${genderWord}, age ${av.ageRange || '50-70'}`;
    if (av.notThisPerson && av.notThisPerson.length > 0) {
      constraints += `\n- Do NOT show: ${av.notThisPerson.join(', ')}`;
    }
  } else if (imageContext.avatarContext) {
    constraints += `\n- People in the image MUST match the target customer demographic: ${imageContext.avatarContext}`;
  }

  // Rich product constraints from LLM extraction — with "THIS IS NOT" block
  if (pv) {
    constraints += `\n- The product MUST be: ${pv.productType || ''} — ${pv.physicalDescription || ''}`;
    if (pv.notThisProduct && pv.notThisProduct.length > 0) {
      constraints += `\n- THIS IS NOT: ${pv.notThisProduct.join(', ')}. If the product is a ${pv.productType || 'product'}, show a ${pv.productType || 'product'} — NOT a ${pv.notThisProduct[0]}`;
    }
  } else if (imageContext.productContext) {
    constraints += `\n- Any product shown MUST be: ${imageContext.productContext} — correct form factor, NOT a different product`;
  }

  return `Generate a photorealistic editorial photograph.

SUBJECT: ${subjectDescription}

SCENE: ${sceneDescription}
IMAGE ROLE: ${slotRole.toUpperCase()} — ${roleDirection}${narrativeHint}${editorialHint}

CONTEXT FROM THE ARTICLE:
${copyContext}

${constraints}`;
}

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
  angleBrief = null,  // Structured angle brief (optional)
  projectId,
  autoContext,  // { narrativeFrame, productImageData, editorialPlan, imageContext } — in auto mode
}, sendEvent) {
  if (!imageSlots || imageSlots.length === 0) {
    sendEvent({ type: 'progress', step: 'images_skipped', message: 'No image slots defined — skipping image generation.' });
    return [];
  }

  const totalSlots = imageSlots.length;
  const hasProductRef = !!autoContext?.productImageData;
  const hasImageContext = !!(autoContext?.imageContext?.avatarContext || autoContext?.imageContext?.productContext);
  sendEvent({
    type: 'progress',
    step: 'images_starting',
    message: `Generating ${totalSlots} image${totalSlots > 1 ? 's' : ''} via Gemini${hasProductRef ? ' (with product reference)' : ''}${hasImageContext ? ' (with article context)' : ''}...`,
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
    const slotId = slot.slot_id || `image_${slotNum}`;

    sendEvent({
      type: 'progress',
      step: 'image_generating',
      message: `Generating image ${slotNum}/${totalSlots}: ${slot.description || slotId}...`,
      imageProgress: { current: slotNum, total: totalSlots, slotId },
    });

    // Build a rich, context-aware prompt for Gemini
    const imagePrompt = buildImagePrompt(slot, angle, copyContext, autoContext, i, totalSlots, angleBrief);

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
6. BACKGROUND COLOR RULE — MANDATORY: Every section or container background color MUST have an HSL lightness of 60% or above. Text should be dark/black. Allowed: pastels, light tints, cream, soft washes of any color (sage green, mint, pale blue, light gold). NOT allowed: dark green, dark blue, dark teal, dark gray, forest green, navy, charcoal, or any deeply saturated color as a background. Use the reference design's color palette but shift any dark background colors to their light tint equivalents. CTA button backgrounds can be darker (the button text should be white), but section/container backgrounds must be light.${editorialPlan ? '\n7. Follow editorial plan instructions for section ordering, emphasis, and callout placement — but do NOT add structural elements the template doesn\'t have, even if the editorial plan suggests them' : ''}`
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
16. BACKGROUND COLOR RULE — MANDATORY: Every section or container background color MUST have an HSL lightness of 60% or above. Text should be dark/black. Allowed: pastels, light tints, cream, soft washes of any color (sage green, mint, pale blue, light gold). NOT allowed: dark green, dark blue, dark teal, dark gray, forest green, navy, charcoal, or any deeply saturated color as a background. Use the reference design's color palette but shift any dark background colors to their light tint equivalents. CTA button backgrounds can be darker (the button text should be white), but section/container backgrounds must be light.${editorialPlan ? '\n17. Follow ALL editorial plan instructions above — they override default section ordering and layout decisions' : ''}`;

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
    'top_bar_text',
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
function buildMetadataMap({ project, agentConfig, angle, autoGeneratedAuthor }) {
  const today = new Date();
  const formattedDate = today.toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });

  return {
    publish_date: formattedDate,
    author_name: autoGeneratedAuthor?.name || agentConfig?.default_author_name || 'Sarah Mitchell',
    author_title: autoGeneratedAuthor?.title || agentConfig?.default_author_title || 'Health & Wellness Editor',
    TRENDING_CATEGORY: project?.niche || 'Health & Wellness',
    warning_box_text: agentConfig?.default_warning_text || 'The following article discusses findings that may change how you think about the products you use every day.',
    product_name: project?.name || project?.brand_name || '',
    product_description: project?.product_description || '',
    top_bar_text: project?.niche
      ? `${project.niche.toUpperCase()} | SPECIAL REPORT`
      : 'HEALTH & WELLNESS | SPECIAL REPORT',
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
// ── P7: Demographic-aware testimonial name pools ──
const TESTIMONIAL_NAME_POOLS = {
  // Women 40-70 (health/wellness products targeting older women)
  female_older: [
    'Carol H.', 'Margaret S.', 'Patricia W.', 'Barbara K.', 'Linda M.',
    'Susan R.', 'Dorothy B.', 'Janet L.', 'Diane P.', 'Kathleen A.',
    'Sharon T.', 'Donna G.', 'Nancy F.', 'Brenda C.', 'Carolyn J.',
    'Deborah N.', 'Judy E.', 'Sandra V.', 'Marilyn D.', 'Beverly O.',
  ],
  // Women 25-45 (beauty, lifestyle, fitness)
  female_younger: [
    'Ashley M.', 'Brittany K.', 'Emily S.', 'Megan R.', 'Hannah L.',
    'Taylor W.', 'Alexis P.', 'Samantha B.', 'Chelsea T.', 'Nicole G.',
    'Amber F.', 'Lauren C.', 'Kayla J.', 'Natalie A.', 'Jenna H.',
    'Madison D.', 'Rachel E.', 'Olivia N.', 'Sophia V.', 'Isabella O.',
  ],
  // Men 40-70
  male_older: [
    'Robert M.', 'William K.', 'Richard S.', 'Thomas R.', 'Charles L.',
    'Kenneth W.', 'Gary P.', 'Steven B.', 'Edward T.', 'Ronald G.',
    'Donald F.', 'Larry C.', 'Raymond J.', 'Jerry A.', 'Dennis H.',
    'Walter D.', 'Frank E.', 'Roger N.', 'Gerald V.', 'Arthur O.',
  ],
  // Men 25-45
  male_younger: [
    'Jason M.', 'Ryan K.', 'Tyler S.', 'Brandon R.', 'Justin L.',
    'Andrew W.', 'Derek P.', 'Marcus B.', 'Cody T.', 'Kyle G.',
    'Travis F.', 'Sean C.', 'Jake J.', 'Nathan A.', 'Adam H.',
    'Eric D.', 'Aaron E.', 'Brett N.', 'Dylan V.', 'Connor O.',
  ],
  // Default/mixed (fallback)
  default: [
    'Sarah M.', 'Jennifer K.', 'Michael T.', 'David R.', 'Lisa P.',
    'Amanda C.', 'Robert J.', 'Jessica L.', 'Chris W.', 'Rachel B.',
    'Karen H.', 'James D.', 'Michelle S.', 'Brian F.', 'Angela N.',
    'Mark A.', 'Stephanie G.', 'Kevin E.', 'Laura V.', 'Daniel O.',
  ],
};

/**
 * Select the best testimonial name pool based on avatar demographics.
 * @param {string|null} avatarText - Raw avatar document text
 * @returns {string[]} Array of name strings
 */
function selectTestimonialNamePool(avatarText) {
  if (!avatarText) return TESTIMONIAL_NAME_POOLS.default;

  const lower = avatarText.toLowerCase();

  // Detect gender
  const isFemale = /\b(women|woman|female|her |she |mother|mom|wife)\b/.test(lower);
  const isMale = /\b(men|man|male|his |he |father|dad|husband)\b/.test(lower);

  // Detect age range
  const ageMatch = lower.match(/\b(\d{2})\s*[-–to]\s*(\d{2})\b/);
  let isOlder = false;
  if (ageMatch) {
    const midAge = (parseInt(ageMatch[1]) + parseInt(ageMatch[2])) / 2;
    isOlder = midAge >= 40;
  } else {
    // Fallback: look for age-related keywords
    isOlder = /\b(senior|retired|mature|older|50s|60s|70s|middle.?age|boomer)\b/.test(lower);
  }

  if (isFemale && isOlder) return TESTIMONIAL_NAME_POOLS.female_older;
  if (isFemale) return TESTIMONIAL_NAME_POOLS.female_younger;
  if (isMale && isOlder) return TESTIMONIAL_NAME_POOLS.male_older;
  if (isMale) return TESTIMONIAL_NAME_POOLS.male_younger;

  return TESTIMONIAL_NAME_POOLS.default;
}

function fixGenericTestimonialAttribution(html, avatarText = null) {
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

  // P7: Select name pool based on avatar demographics
  const namePool = selectTestimonialNamePool(avatarText);
  // Shuffle to avoid always starting with the same name
  const shuffled = [...namePool].sort(() => Math.random() - 0.5);

  let nameIndex = 0;
  let result = html;

  for (const pattern of genericPatterns) {
    result = result.replace(pattern, () => {
      const name = shuffled[nameIndex % shuffled.length];
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

  // Pass 2: Attribution-name deduplication
  result = deduplicateByAttribution(result);

  return result;
}

/**
 * Pass 2 of testimonial dedup: match by attribution name.
 * Catches cases where the same person is quoted in body text AND a blockquote
 * with different wording. Keeps the styled version (blockquote), removes body text.
 *
 * Attribution patterns detected:
 * - "— Name L." or "– Name L." or "- Name L."
 * - <cite>Name</cite> or <footer>Name</footer>
 * - Closing quote followed by name
 */
function deduplicateByAttribution(html) {
  // Find all containers with attribution names
  const containers = [];

  // Pattern 1: Blockquotes with attribution
  const blockquoteRegex = /<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi;
  let match;
  while ((match = blockquoteRegex.exec(html)) !== null) {
    const names = extractAttributionNames(match[0]);
    if (names.length > 0) {
      containers.push({
        type: 'blockquote',
        isStyled: true,
        fullMatch: match[0],
        index: match.index,
        names,
      });
    }
  }

  // Pattern 2: Divs and paragraphs with attribution
  const bodyRegex = /<(div|p|section)[^>]*>([\s\S]*?)<\/\1>/gi;
  while ((match = bodyRegex.exec(html)) !== null) {
    // Skip if this is inside a blockquote (already captured above)
    if (match[0].includes('<blockquote')) continue;
    const names = extractAttributionNames(match[0]);
    if (names.length > 0) {
      containers.push({
        type: match[1],
        isStyled: false,
        fullMatch: match[0],
        index: match.index,
        names,
      });
    }
  }

  // Build Map<normalizedName, occurrences[]>
  const nameMap = new Map();
  for (const container of containers) {
    for (const name of container.names) {
      const norm = name.toLowerCase().replace(/\./g, '').trim();
      if (!nameMap.has(norm)) nameMap.set(norm, []);
      nameMap.get(norm).push(container);
    }
  }

  // Find duplicate names and collect removals
  const removals = [];
  for (const [normName, occurrences] of nameMap) {
    if (occurrences.length < 2) continue;

    console.log(`[LP-FIX] Attribution name "${normName}" appears ${occurrences.length} time(s)`);

    // Keep styled version (blockquote), remove body text version
    // If both are styled or both unstyled, keep the first
    const sorted = [...occurrences].sort((a, b) => {
      if (a.isStyled && !b.isStyled) return -1;
      if (!a.isStyled && b.isStyled) return 1;
      return a.index - b.index; // Keep earlier one
    });

    // Mark all except the first for removal
    for (let i = 1; i < sorted.length; i++) {
      if (!removals.includes(sorted[i])) {
        removals.push(sorted[i]);
      }
    }
  }

  if (removals.length === 0) return html;

  // Apply removals in reverse index order to preserve indices
  let result = html;
  const sortedRemovals = removals.sort((a, b) => b.index - a.index);
  for (const removal of sortedRemovals) {
    const before = result.slice(0, removal.index);
    const after = result.slice(removal.index + removal.fullMatch.length);
    result = before + after;
    console.log(`[LP-FIX] Removed duplicate attribution for "${removal.names[0]}" from <${removal.type}> (${removal.fullMatch.length} chars)`);
  }

  return result;
}

/**
 * Extract attribution names from a text block.
 * Matches patterns like:
 * - "— Sarah M." / "– David R." / "- Jennifer K."
 * - <cite>Name</cite> / <footer>Name</footer>
 * - Text ending with "...quote" Name L.
 *
 * @param {string} text - HTML text to search
 * @returns {string[]} Array of extracted names
 */
function extractAttributionNames(text) {
  const names = new Set();

  // Pattern 1: Em/en dash + name (most common testimonial attribution)
  // Matches: — Sarah M., – David R., - Jennifer K., — Amanda Chen
  const dashPattern = /[—–\-]\s*([A-Z][a-z]{1,15}(?:\s+[A-Z]\.?)?(?:\s+[A-Z][a-z]{1,15})?)/g;
  let match;
  while ((match = dashPattern.exec(text)) !== null) {
    const name = match[1].trim();
    // Filter out common false positives
    if (!isLikelyName(name)) continue;
    names.add(name);
  }

  // Pattern 2: <cite> or <footer> content
  const citePattern = /<(?:cite|footer)[^>]*>\s*[—–\-]?\s*([A-Z][a-z]{1,15}(?:\s+[A-Z]\.?)?(?:\s+[A-Z][a-z]{1,15})?)/gi;
  while ((match = citePattern.exec(text)) !== null) {
    const name = match[1].trim();
    if (isLikelyName(name)) names.add(name);
  }

  return [...names];
}

/**
 * Check if a string looks like a person's name (not a common word).
 */
function isLikelyName(str) {
  if (!str || str.length < 3) return false;
  const lower = str.toLowerCase();
  // Common false positives from dash patterns in articles
  const nonNames = new Set([
    'the', 'this', 'that', 'these', 'those', 'here', 'there', 'when', 'where',
    'what', 'which', 'while', 'with', 'from', 'your', 'our', 'their', 'more',
    'most', 'some', 'many', 'much', 'every', 'each', 'both', 'other', 'another',
    'but', 'and', 'for', 'not', 'all', 'can', 'had', 'has', 'have', 'her', 'his',
    'how', 'its', 'may', 'new', 'now', 'old', 'one', 'our', 'out', 'own', 'say',
    'she', 'too', 'use', 'way', 'who', 'why', 'also', 'just', 'like', 'than',
    'then', 'them', 'they', 'very', 'been', 'being', 'into', 'over', 'even',
    'after', 'about', 'right', 'still', 'study', 'research', 'according',
    'editor', 'health', 'wellness', 'senior', 'contributing', 'verified', 'buyer',
  ]);
  const firstWord = lower.split(/\s+/)[0];
  return !nonNames.has(firstWord);
}

// ─── Pullquote / Callout Deduplication ──────────────────────────────────────

/**
 * Remove body text that duplicates styled pullquotes, callouts, highlights,
 * stat boxes, and other visually-emphasized elements.
 *
 * Unlike testimonial dedup (which finds the same sentence anywhere on the page),
 * this function works locally: for each styled element, it checks whether the
 * surrounding body paragraphs repeat the same text, and removes the body version
 * (keeping the styled version).
 *
 * @param {string} html - Full LP HTML
 * @returns {string} HTML with body-text duplicates of styled elements removed
 */
function deduplicatePullquotes(html) {
  if (!html) return html;

  // Step 1: Find all styled elements (pullquotes, callouts, highlights, asides, etc.)
  const styledRegex = /<(blockquote|aside|div|p|section)(\s+[^>]*class="[^"]*(?:highlight|callout|pullquote|quote|featured|emphasis|stat[-_]callout|data[-_]box)[^"]*"[^>]*)>([\s\S]*?)<\/\1>/gi;

  const styledElements = [];
  let match;
  while ((match = styledRegex.exec(html)) !== null) {
    // Skip elements that are part of testimonial dedup (have attribution names)
    const names = extractAttributionNames(match[0]);
    if (names.length > 0) continue;

    styledElements.push({
      fullMatch: match[0],
      tag: match[1],
      innerHtml: match[3],
      index: match.index,
      endIndex: match.index + match[0].length,
    });
  }

  // Also find <blockquote> elements without a class (plain pullquotes)
  // but skip ones already captured above or ones with attribution names
  const blockquoteRegex = /<blockquote(?:\s[^>]*)?>(?![\s\S]*?class="[^"]*(?:highlight|callout|pullquote|quote|featured|emphasis|stat[-_]callout|data[-_]box))([\s\S]*?)<\/blockquote>/gi;
  while ((match = blockquoteRegex.exec(html)) !== null) {
    const names = extractAttributionNames(match[0]);
    if (names.length > 0) continue;
    // Check if already captured
    const alreadyCaptured = styledElements.some(e => e.index === match.index);
    if (alreadyCaptured) continue;

    styledElements.push({
      fullMatch: match[0],
      tag: 'blockquote',
      innerHtml: match[1],
      index: match.index,
      endIndex: match.index + match[0].length,
    });
  }

  if (styledElements.length === 0) return html;

  console.log(`[LP-FIX] Pullquote dedup: found ${styledElements.length} styled element(s) to check`);

  // Collect all removals (body text segments to remove)
  const removals = []; // { index, length, reason }

  for (const styled of styledElements) {
    // Step 2: Extract plain text from the styled element
    const styledText = styled.innerHtml
      .replace(/<[^>]+>/g, ' ')    // Strip HTML tags
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();

    if (styledText.length < 30) continue; // Too short to match meaningfully

    // Step 3: Split into sentences (on .!? boundaries)
    const sentences = styledText
      .split(/(?<=[.!?])\s+/)
      .map(s => s.trim())
      .filter(s => s.length >= 40); // Only match sentences >= 40 chars

    if (sentences.length === 0) {
      // If no individual sentence is >= 40 chars, try the full text if >= 40 chars
      if (styledText.length >= 40) {
        sentences.push(styledText);
      } else {
        continue;
      }
    }

    // Step 4: Search surrounding body text within a 2000-char window
    const windowStart = Math.max(0, styled.index - 2000);
    const windowEnd = Math.min(html.length, styled.endIndex + 2000);
    const beforeWindow = html.slice(windowStart, styled.index);
    const afterWindow = html.slice(styled.endIndex, windowEnd);

    for (const sentence of sentences) {
      // Normalize the sentence for comparison
      const normalizedSentence = sentence.toLowerCase().replace(/[""'']/g, "'").replace(/\s+/g, ' ');

      // Search for matching body text in surrounding <p> and <div> elements
      const bodyContainerRegex = /<(p|div)(\s[^>]*)?>[\s\S]*?<\/\1>/gi;

      // Check both before and after windows
      for (const window of [
        { text: beforeWindow, offset: windowStart },
        { text: afterWindow, offset: styled.endIndex },
      ]) {
        let bodyMatch;
        bodyContainerRegex.lastIndex = 0;

        while ((bodyMatch = bodyContainerRegex.exec(window.text)) !== null) {
          const bodyTag = bodyMatch[1];
          const bodyFullMatch = bodyMatch[0];
          const bodyAbsIndex = window.offset + bodyMatch.index;

          // Skip if this body container IS the styled element itself
          if (bodyAbsIndex >= styled.index && bodyAbsIndex < styled.endIndex) continue;

          // Skip if this body element has a styled class (it's another callout, not body text)
          if (/class="[^"]*(?:highlight|callout|pullquote|quote|featured|emphasis|stat[-_]callout|data[-_]box)/i.test(bodyFullMatch)) continue;

          // Extract plain text from the body container
          const bodyText = bodyFullMatch
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/\s+/g, ' ')
            .trim();

          const normalizedBody = bodyText.toLowerCase().replace(/[""'']/g, "'").replace(/\s+/g, ' ');

          if (normalizedBody.includes(normalizedSentence)) {
            // Match found — check if the container is ENTIRELY the duplicated text
            // or if it has additional content
            const bodyWithoutDuplicate = normalizedBody.replace(normalizedSentence, '').trim();
            // Strip residual punctuation/whitespace
            const residual = bodyWithoutDuplicate.replace(/^[\s.,;:!?—–-]+|[\s.,;:!?—–-]+$/g, '').trim();

            if (residual.length < 20) {
              // Container is essentially the duplicate — remove entire container
              // Check this removal doesn't overlap with existing removals
              const overlaps = removals.some(r =>
                (bodyAbsIndex >= r.index && bodyAbsIndex < r.index + r.length) ||
                (r.index >= bodyAbsIndex && r.index < bodyAbsIndex + bodyFullMatch.length)
              );
              if (!overlaps) {
                removals.push({
                  index: bodyAbsIndex,
                  length: bodyFullMatch.length,
                  reason: `Entire <${bodyTag}> duplicates styled element (${sentence.slice(0, 50)}...)`,
                });
              }
            } else {
              // Container has additional content — remove only the matching sentence
              // Find the sentence in the original (non-normalized) body HTML
              // Use a case-insensitive search on the raw text within the container
              const sentenceEscaped = sentence.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
              const sentenceInBodyRegex = new RegExp(sentenceEscaped.replace(/\s+/g, '\\s+'), 'i');
              const sentenceMatch = bodyFullMatch.match(sentenceInBodyRegex);

              if (sentenceMatch) {
                const sentenceStart = bodyAbsIndex + bodyFullMatch.indexOf(sentenceMatch[0]);
                const overlaps = removals.some(r =>
                  (sentenceStart >= r.index && sentenceStart < r.index + r.length) ||
                  (r.index >= sentenceStart && r.index < sentenceStart + sentenceMatch[0].length)
                );
                if (!overlaps) {
                  removals.push({
                    index: sentenceStart,
                    length: sentenceMatch[0].length,
                    reason: `Sentence within <${bodyTag}> duplicates styled element (${sentence.slice(0, 50)}...)`,
                  });
                }
              }
            }
          }
        }
      }
    }
  }

  if (removals.length === 0) {
    console.log(`[LP-FIX] Pullquote dedup: no duplicates found`);
    return html;
  }

  // Apply removals in reverse index order to preserve positions
  const sortedRemovals = removals.sort((a, b) => b.index - a.index);
  let result = html;
  for (const removal of sortedRemovals) {
    const before = result.slice(0, removal.index);
    const after = result.slice(removal.index + removal.length);
    result = before + after;
    console.log(`[LP-FIX] Pullquote dedup: ${removal.reason}`);
  }

  // Clean up any empty containers left behind
  result = result.replace(/<(p|div)(\s[^>]*)?>\s*<\/\1>/gi, '');

  console.log(`[LP-FIX] Pullquote dedup: removed ${removals.length} duplicate(s)`);
  return result;
}

// ─── Contrast detection helpers ─────────────────────────────────────────────

/**
 * Perceived brightness using ITU-R BT.601 formula (0 = black, 255 = white).
 */
// ─── HSL Color Utilities — Background Lightness Enforcement ─────────────────

/**
 * Parse any CSS color string (hex, rgb, rgba, named) to [r, g, b].
 * Returns null if unparseable.
 */
function parseColorToRGB(colorStr) {
  if (!colorStr) return null;
  const c = colorStr.trim().toLowerCase();

  // Hex (#rgb, #rrggbb, #rrggbbaa)
  const hexMatch = c.match(/^#([0-9a-f]{3,8})$/);
  if (hexMatch) {
    let hex = hexMatch[1];
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    if (hex.length >= 6) {
      return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
    }
  }

  // rgb(r, g, b) or rgba(r, g, b, a)
  const rgbMatch = c.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (rgbMatch) {
    return [parseInt(rgbMatch[1]), parseInt(rgbMatch[2]), parseInt(rgbMatch[3])];
  }

  // Named colors (common ones that appear in LP backgrounds)
  const namedColors = {
    white: [255, 255, 255], black: [0, 0, 0], red: [255, 0, 0], green: [0, 128, 0],
    blue: [0, 0, 255], navy: [0, 0, 128], teal: [0, 128, 128], maroon: [128, 0, 0],
    olive: [128, 128, 0], purple: [128, 0, 128], darkgreen: [0, 100, 0],
    darkblue: [0, 0, 139], forestgreen: [34, 139, 34], darkslategray: [47, 79, 79],
    dimgray: [105, 105, 105], gray: [128, 128, 128], darkgray: [169, 169, 169],
    lightgray: [211, 211, 211], whitesmoke: [245, 245, 245], ivory: [255, 255, 240],
    beige: [245, 245, 220], linen: [250, 240, 230], floralwhite: [255, 250, 240],
    seashell: [255, 245, 238], cornsilk: [255, 248, 220], mintcream: [245, 255, 250],
    honeydew: [240, 255, 240], aliceblue: [240, 248, 255], lavender: [230, 230, 250],
    mistyrose: [255, 228, 225], antiquewhite: [250, 235, 215], oldlace: [253, 245, 230],
    ghostwhite: [248, 248, 255], snow: [255, 250, 250], azure: [240, 255, 255],
    midnightblue: [25, 25, 112], indigo: [75, 0, 130], steelblue: [70, 130, 180],
    slategray: [112, 128, 144], saddlebrown: [139, 69, 19], sienna: [160, 82, 45],
    darkcyan: [0, 139, 139], darkmagenta: [139, 0, 139], darkolivegreen: [85, 107, 47],
    darkviolet: [148, 0, 211], firebrick: [178, 34, 34], seagreen: [46, 139, 87],
    olivedrab: [107, 142, 35], brown: [165, 42, 42], crimson: [220, 20, 60],
    tomato: [255, 99, 71], coral: [255, 127, 80], salmon: [250, 128, 114],
    gold: [255, 215, 0], khaki: [240, 230, 140], plum: [221, 160, 221],
    peru: [205, 133, 63], wheat: [245, 222, 179], tan: [210, 180, 140],
  };
  if (namedColors[c]) return namedColors[c];

  return null;
}

/**
 * Convert RGB to HSL.
 * @returns {{ h: number, s: number, l: number }} h: 0-360, s: 0-100, l: 0-100
 */
function rgbToHSL(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }
  }

  return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}

/**
 * Convert HSL to hex color.
 * @param {number} h - Hue 0-360
 * @param {number} s - Saturation 0-100
 * @param {number} l - Lightness 0-100
 * @returns {string} Hex color like "#aabbcc"
 */
function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }

  const toHex = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Ensure a color has minimum HSL lightness.
 * If lightness < minLightness, raise it while preserving hue and saturation.
 *
 * @param {string} colorStr - Hex, rgb(), or named CSS color
 * @param {number} [minLightness=60] - Minimum lightness percentage
 * @returns {string} Original color or lightened hex color
 */
export function ensureMinLightness(colorStr, minLightness = 60) {
  if (!colorStr) return colorStr;

  // Don't touch transparent, gradients, urls, or CSS functions
  const lower = colorStr.trim().toLowerCase();
  if (lower === 'transparent' || lower === 'none' || lower === 'inherit' ||
      lower === 'initial' || lower === 'unset' || lower.includes('gradient') ||
      lower.includes('url(') || lower.includes('var(')) {
    return colorStr;
  }

  const rgb = parseColorToRGB(colorStr);
  if (!rgb) return colorStr;

  const hsl = rgbToHSL(rgb[0], rgb[1], rgb[2]);
  if (hsl.l < minLightness) {
    const newHex = hslToHex(hsl.h, hsl.s, minLightness + 5); // +5 breathing room
    return newHex;
  }

  return colorStr;
}

/**
 * Process a design analysis object and lighten any dark background colors.
 * Preserves hue and saturation — just raises lightness to 65%.
 * Does NOT modify CTA backgrounds, text colors, or primary/accent colors that aren't backgrounds.
 */
export function lightenDesignColors(designAnalysis) {
  if (!designAnalysis) return designAnalysis;
  const result = JSON.parse(JSON.stringify(designAnalysis)); // deep clone

  // Lighten main background color
  if (result.colors?.background) {
    result.colors.background = ensureMinLightness(result.colors.background);
  }
  // Lighten layout background
  if (result.layout?.background_color) {
    result.layout.background_color = ensureMinLightness(result.layout.background_color);
  }

  // Lighten section backgrounds (but NOT CTA button backgrounds)
  if (result.sections) {
    for (const section of result.sections) {
      if (section.background) {
        section.background = ensureMinLightness(section.background);
      }
    }
  }

  // DO NOT lighten: colors.primary, colors.cta_background, colors.accent, cta_elements
  // These may be dark intentionally (buttons with white text, accent borders, etc.)

  return result;
}

/**
 * Lighten dark background colors in assembled HTML.
 * Scans both inline styles and <style> blocks for background colors with HSL lightness < 60%.
 * Only modifies BACKGROUNDS — text, buttons, borders, and decorative elements are left alone.
 *
 * @param {string} html - Assembled HTML
 * @returns {{ html: string, fixCount: number }}
 */
export function enforceBackgroundLightness(html) {
  let result = html;
  let fixCount = 0;

  // ── Pass 1: Fix inline background styles ──
  result = result.replace(
    /style="([^"]*)"/gi,
    (fullMatch, styleContent) => {
      const bgMatch = styleContent.match(/background(?:-color)?\s*:\s*([^;!]+)/i);
      if (!bgMatch) return fullMatch;

      const bgValue = bgMatch[1].trim();
      const color = extractColorFromBackground(bgValue);
      if (!color) return fullMatch;

      const rgb = parseColorToRGB(color);
      if (!rgb) return fullMatch;

      const hsl = rgbToHSL(rgb[0], rgb[1], rgb[2]);
      if (hsl.l >= 60) return fullMatch; // Already light enough

      // Check: is this likely a text-bearing container?
      // We lighten ALL inline-style backgrounds — buttons will still have their bg set via CSS class
      const newColor = hslToHex(hsl.h, hsl.s, 65);
      const newStyle = styleContent.replace(
        /background(?:-color)?\s*:\s*[^;!]+/i,
        bgMatch[0].replace(color, newColor)
      );

      fixCount++;
      return `style="${newStyle}"`;
    }
  );

  // ── Pass 2: Fix <style> block background rules ──
  // Skip our own injected styles (data-safety, data-autofix, data-lightness)
  // Skip button/CTA selectors — their dark backgrounds are intentional (white text on colored buttons)
  const buttonSelectorPattern = /btn|button|cta|\.buy|\.order|\.add-to-cart|\.checkout/i;

  result = result.replace(
    /<style(?![^>]*data-(?:safety|autofix|lightness))[^>]*>([\s\S]*?)<\/style>/gi,
    (fullStyleTag, cssContent) => {
      let newCSS = cssContent;
      let localFixes = 0;

      // Process rule by rule to check selectors
      newCSS = newCSS.replace(
        /([^{}]*?)\{([^}]*)\}/g,
        (ruleBlock, selector, properties) => {
          const sel = selector.trim();
          // Skip @rules, keyframes, button/CTA selectors
          if (!sel || sel.startsWith('@') || /^(from|to|\d+%)/.test(sel)) return ruleBlock;
          if (buttonSelectorPattern.test(sel)) return ruleBlock;

          // Find and lighten background-color or background in properties
          const newProps = properties.replace(
            /(background(?:-color)?)\s*:\s*([^;!}]+)/gi,
            (bgRule, prop, value) => {
              const trimVal = value.trim();
              const color = extractColorFromBackground(trimVal);
              if (!color) return bgRule;

              const rgb = parseColorToRGB(color);
              if (!rgb) return bgRule;

              const hsl = rgbToHSL(rgb[0], rgb[1], rgb[2]);
              if (hsl.l >= 60) return bgRule; // Already light enough

              const newColor = hslToHex(hsl.h, hsl.s, 65);
              localFixes++;
              return bgRule.replace(color, newColor);
            }
          );

          return `${selector}{${newProps}}`;
        }
      );

      if (localFixes > 0) fixCount += localFixes;
      return fullStyleTag.replace(cssContent, newCSS);
    }
  );

  if (fixCount > 0) {
    console.log(`[LP-FIX] enforceBackgroundLightness: lightened ${fixCount} dark background(s) to HSL L≥65%`);
  }

  return { html: result, fixCount };
}

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

// ─── Programmatic WCAG Contrast Audit ──────────────────────────────────────

/**
 * Run a programmatic WCAG 2.0 contrast audit on a rendered page.
 * Uses Puppeteer computed styles + WCAG luminance math — zero LLM cost.
 *
 * Walks every text node via TreeWalker, gets computed color + effective
 * background color (walking parentElement chain), computes contrast ratio.
 * Thresholds: 4.5:1 normal text, 3:1 large text (≥18pt or ≥14pt bold).
 *
 * All computation runs inside a single page.evaluate() to avoid round-trips.
 *
 * @param {import('puppeteer').Page} page - Puppeteer page with content loaded
 * @returns {Promise<{ passed: boolean, failures: Array }>}
 */
async function runContrastAudit(page) {
  const result = await page.evaluate(() => {
    // ── sRGB linearization ──
    function sRGBtoLinear(c) {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    }

    // ── Relative luminance (WCAG 2.0) ──
    function relativeLuminance(r, g, b) {
      return 0.2126 * sRGBtoLinear(r) + 0.7152 * sRGBtoLinear(g) + 0.0722 * sRGBtoLinear(b);
    }

    // ── Contrast ratio ──
    function contrastRatio(l1, l2) {
      const lighter = Math.max(l1, l2);
      const darker = Math.min(l1, l2);
      return (lighter + 0.05) / (darker + 0.05);
    }

    // ── Parse CSS color string to [r, g, b, a] ──
    function parseColor(str) {
      if (!str) return null;
      const m = str.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/);
      if (m) return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3]), m[4] !== undefined ? parseFloat(m[4]) : 1];
      return null;
    }

    // ── Check if color is transparent ──
    function isTransparent(rgba) {
      return !rgba || rgba[3] === 0;
    }

    // ── Walk parent chain for first non-transparent background ──
    function getEffectiveBgColor(el) {
      let current = el;
      while (current && current !== document.documentElement) {
        const style = window.getComputedStyle(current);
        const bg = parseColor(style.backgroundColor);
        if (bg && !isTransparent(bg)) return bg;
        current = current.parentElement;
      }
      return [255, 255, 255, 1]; // default: white
    }

    // ── Build a CSS selector for an element ──
    function buildSelector(el) {
      if (el.id) return `#${el.id}`;
      let sel = el.tagName.toLowerCase();
      if (el.className && typeof el.className === 'string') {
        const classes = el.className.trim().split(/\s+/).slice(0, 2).join('.');
        if (classes) sel += '.' + classes;
      }
      // Add nth-of-type for disambiguation
      const parent = el.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
        if (siblings.length > 1) {
          const idx = siblings.indexOf(el) + 1;
          sel += `:nth-of-type(${idx})`;
        }
      }
      return sel;
    }

    // ── Walk all text nodes ──
    const failures = [];
    const seenSelectors = new Set(); // Dedupe by parent selector
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);

    let textNode;
    while ((textNode = walker.nextNode())) {
      const text = textNode.textContent.trim();
      if (!text || text.length < 2) continue;

      const el = textNode.parentElement;
      if (!el) continue;

      // Skip invisible elements
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
      // Skip zero-size elements
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;

      // Get colors
      const textColor = parseColor(style.color);
      if (!textColor) continue;
      const bgColor = getEffectiveBgColor(el);

      // Compute contrast ratio
      const textLum = relativeLuminance(textColor[0], textColor[1], textColor[2]);
      const bgLum = relativeLuminance(bgColor[0], bgColor[1], bgColor[2]);
      const ratio = contrastRatio(textLum, bgLum);

      // Determine if large text (≥18pt or ≥14pt bold)
      const fontSize = parseFloat(style.fontSize); // in px
      const fontWeight = parseInt(style.fontWeight) || (style.fontWeight === 'bold' ? 700 : 400);
      const fontSizePt = fontSize * 0.75; // px to pt (approximate)
      const isLargeText = fontSizePt >= 18 || (fontSizePt >= 14 && fontWeight >= 700);

      const requiredRatio = isLargeText ? 3.0 : 4.5;

      if (ratio < requiredRatio) {
        const selector = buildSelector(el);
        // Dedupe: skip if we already have a failure for this selector's parent container
        const parentSel = el.parentElement ? buildSelector(el.parentElement) : selector;
        if (seenSelectors.has(parentSel)) continue;
        seenSelectors.add(parentSel);

        failures.push({
          selector,
          textColor: `rgb(${textColor[0]}, ${textColor[1]}, ${textColor[2]})`,
          backgroundColor: `rgb(${bgColor[0]}, ${bgColor[1]}, ${bgColor[2]})`,
          contrastRatio: Math.round(ratio * 100) / 100,
          textSnippet: text.slice(0, 80),
          isLargeText,
          requiredRatio,
          fontSize: Math.round(fontSize),
          fontWeight,
        });
      }
    }

    return { passed: failures.length === 0, failures };
  });

  if (result.failures.length > 0) {
    console.log(`[Contrast Audit] FAILED: ${result.failures.length} element(s) below WCAG threshold`);
    for (const f of result.failures.slice(0, 5)) {
      console.log(`  → ${f.selector}: ratio ${f.contrastRatio}:1 (need ${f.requiredRatio}:1) | text: ${f.textColor} on ${f.backgroundColor} | "${f.textSnippet.slice(0, 40)}..."`);
    }
  } else {
    console.log('[Contrast Audit] PASSED: All text meets WCAG contrast requirements');
  }

  return result;
}

// ─── Programmatic Image Load Check ─────────────────────────────────────────

/**
 * Check all <img> elements for load failures and gray rectangle fills.
 * Uses naturalWidth/naturalHeight check + canvas pixel sampling.
 *
 * @param {import('puppeteer').Page} page - Puppeteer page with content loaded
 * @returns {Promise<{ passed: boolean, failures: Array }>}
 */
async function runImageLoadCheck(page) {
  const result = await page.evaluate(() => {
    const failures = [];
    const imgs = document.querySelectorAll('img');

    for (const img of imgs) {
      // Skip hidden/zero-size images
      const rect = img.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const style = window.getComputedStyle(img);
      if (style.display === 'none' || style.visibility === 'hidden') continue;

      const src = img.src || img.getAttribute('src') || '';

      // Build selector
      let selector = 'img';
      if (img.id) selector = `#${img.id}`;
      else if (img.className && typeof img.className === 'string') {
        const cls = img.className.trim().split(/\s+/).slice(0, 2).join('.');
        if (cls) selector = `img.${cls}`;
      }

      // Check 1: Failed to load
      if (!img.complete || img.naturalWidth === 0) {
        failures.push({
          src: src.slice(0, 200),
          selector,
          position: `${Math.round(rect.top)}px from top`,
          reason: 'failed_to_load',
          description: 'Image failed to load (naturalWidth=0)',
        });
        continue;
      }

      // Check 2: Gray rectangle detection via canvas sampling (for loaded images ≥50px)
      if (img.naturalWidth >= 50 && img.naturalHeight >= 50 && rect.width >= 50) {
        try {
          const canvas = document.createElement('canvas');
          canvas.width = 3;
          canvas.height = 3;
          const ctx = canvas.getContext('2d');
          // Sample 3×3 grid across the image
          const sw = img.naturalWidth;
          const sh = img.naturalHeight;
          ctx.drawImage(img, 0, 0, sw, sh, 0, 0, 3, 3);
          const data = ctx.getImageData(0, 0, 3, 3).data;

          // Check if all 9 pixels are uniform gray (low saturation, gray value 100-220)
          let allGray = true;
          let minVal = 255, maxVal = 0;
          for (let i = 0; i < 9; i++) {
            const r = data[i * 4];
            const g = data[i * 4 + 1];
            const b = data[i * 4 + 2];
            // Check saturation: max channel diff < 25
            const channelDiff = Math.max(r, g, b) - Math.min(r, g, b);
            const avg = (r + g + b) / 3;
            if (channelDiff > 25 || avg < 100 || avg > 220) {
              allGray = false;
              break;
            }
            minVal = Math.min(minVal, avg);
            maxVal = Math.max(maxVal, avg);
          }

          // Also check that pixel values are uniform (range < 20)
          if (allGray && (maxVal - minVal) < 20) {
            failures.push({
              src: src.slice(0, 200),
              selector,
              position: `${Math.round(rect.top)}px from top`,
              reason: 'gray_rectangle',
              description: `Image appears to be a uniform gray rectangle (avg gray value: ${Math.round((minVal + maxVal) / 2)})`,
            });
          }
        } catch {
          // Canvas operations can fail due to CORS — skip silently
        }
      }
    }

    return { passed: failures.length === 0, failures };
  });

  if (result.failures.length > 0) {
    console.log(`[Image Load Check] FAILED: ${result.failures.length} image(s) with issues`);
    for (const f of result.failures) {
      console.log(`  → ${f.selector}: ${f.reason} | ${f.description} | at ${f.position}`);
    }
  } else {
    console.log('[Image Load Check] PASSED: All images loaded successfully');
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
export function postProcessLP(html, { project = null, agentConfig = null, angle = '', editorialPlan = null, autoGeneratedAuthor = null, avatarText = null } = {}) {
  let processed = html;

  // ── P5: Track all post-processing actions with severity levels ──
  const criticalWarnings = [];   // Issues that indicate quality problems
  const infoWarnings = [];       // Normal fixes that are expected

  console.log(`[LP-FIX] postProcessLP() called. HTML length: ${html.length}, project: ${project ? project.name || project.externalId : 'NULL'}, agentConfig: ${agentConfig ? 'loaded' : 'NULL'}, angle: "${(angle || '').slice(0, 40)}", autoAuthor: ${autoGeneratedAuthor ? autoGeneratedAuthor.name : 'none'}`);

  if (!project) {
    console.warn('[LP-FIX] WARNING: project is null — metadata placeholders will use fallback values');
  }
  if (!agentConfig) {
    console.warn('[LP-FIX] WARNING: agentConfig is null — author_name, author_title, warning_text will use hardcoded defaults');
  }

  // 1. Populate metadata placeholders (publish_date, author_name, etc.)
  const metadataMap = buildMetadataMap({ project, agentConfig, angle, autoGeneratedAuthor });
  console.log(`[LP-FIX] Metadata map: ${Object.entries(metadataMap).map(([k, v]) => `${k}="${(v || '').slice(0, 30)}"`).join(', ')}`);

  const preMetaCount = (processed.match(/\{\{[^}]+\}\}/g) || []).length;
  processed = applyMetadataReplacements(processed, metadataMap);
  const postMetaCount = (processed.match(/\{\{[^}]+\}\}/g) || []).length;
  const metaReplaced = preMetaCount - postMetaCount;
  console.log(`[LP-FIX] Metadata replacement: ${preMetaCount} placeholders before → ${postMetaCount} after (${metaReplaced} replaced)`);
  if (metaReplaced > 0) infoWarnings.push(`Replaced ${metaReplaced} metadata placeholder(s)`);

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
    if (fills.length > 0) infoWarnings.push(`Applied ${fills.length} editorial placeholder fill(s)`);
  }

  // 3. Strip unfilled placeholders (zero-tolerance)
  const validation = validateNoPlaceholders(processed);
  processed = validation.html;

  // 3b. Clean up empty elements left by stripped placeholders
  processed = cleanupEmptyElements(processed);

  const finalPlaceholderCount = (processed.match(/\{\{[^}]+\}\}/g) || []).length;
  console.log(`[LP-FIX] Final placeholder count after all passes: ${finalPlaceholderCount}`);

  // Stripped placeholders = critical warning (content was missing)
  if (validation.warnings.length > 0) {
    criticalWarnings.push(`Stripped ${validation.warnings.length} unfilled placeholder(s): ${validation.warnings.join(', ')}`);
  }

  // 4. Fix duplicate callout headings
  const preCalloutLen = processed.length;
  processed = fixDuplicateCalloutHeadings(processed);
  if (processed.length !== preCalloutLen) {
    infoWarnings.push('Fixed duplicate callout heading(s)');
  }

  // 5. Replace generic testimonial attributions with realistic names (P7: demographic-aware)
  const preTestimonialHtml = processed;
  processed = fixGenericTestimonialAttribution(processed, avatarText);
  if (processed !== preTestimonialHtml) {
    criticalWarnings.push('Replaced generic testimonial attributions (e.g., "Verified Buyer") with realistic names');
  }

  // 5b. Deduplicate testimonial quotes that appear more than once
  const preDedup = processed.length;
  processed = deduplicateTestimonials(processed);
  if (processed.length !== preDedup) {
    criticalWarnings.push('Removed duplicate testimonial quote(s)');
  }

  // 5c. Deduplicate pullquotes — remove body text that repeats styled callouts
  const prePullquote = processed.length;
  processed = deduplicatePullquotes(processed);
  if (prePullquote !== processed.length) {
    infoWarnings.push('Deduplicated pullquote content');
  }

  // 6. Enforce background lightness floor — lighten any dark backgrounds to HSL L≥65%
  const lightnessResult = enforceBackgroundLightness(processed);
  processed = lightnessResult.html;
  if (lightnessResult.html !== processed || (lightnessResult.count && lightnessResult.count > 0)) {
    infoWarnings.push('Enforced background lightness floor');
  }

  // 7. Inject proactive contrast safety CSS (still needed for edge cases)
  processed = injectContrastSafetyCSS(processed);

  console.log(`[LP-FIX] postProcessLP() complete. Output HTML length: ${processed.length}, critical: ${criticalWarnings.length}, info: ${infoWarnings.length}`);
  return {
    html: processed,
    warnings: validation.warnings,
    criticalWarnings,
    infoWarnings,
    hasCriticalIssues: criticalWarnings.length > 0,
  };
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
  projectId, templateId, angle, angleBrief = null, narrativeFrame, batchJobId,
  editorialPassEnabled = true,
  useProductReferenceImages = true,
  agentConfig = null,
  approvedAds = [],  // Approved batch ads for messaging alignment
  messageBrief = null,
  autoContext: parentAutoContext = null,  // Gauntlet: { cachedHtmlTemplate, preGeneratedImages }
  headlineConstraints = null,
}, sendEvent) {
  // Audit trail — collect entries at each generation phase
  // ── P8: Track per-phase timing in audit trail ──
  const auditTrail = [];
  const phaseTiming = {};
  const pipelineStart = Date.now();
  const audit = (step, action, detail, extra = {}) => {
    auditTrail.push({ timestamp: new Date().toISOString(), step, action, detail, ...extra });
  };
  const startPhase = (phase) => { phaseTiming[phase] = { start: Date.now() }; };
  const endPhase = (phase) => {
    if (phaseTiming[phase]) {
      phaseTiming[phase].end = Date.now();
      phaseTiming[phase].durationMs = phaseTiming[phase].end - phaseTiming[phase].start;
      phaseTiming[phase].durationSec = (phaseTiming[phase].durationMs / 1000).toFixed(1);
    }
  };

  audit('init', 'started', `Angle: "${(angle || '').slice(0, 60)}", template: ${templateId?.slice(0, 8) || 'none'}, approved ads: ${approvedAds.length}`);
  sendEvent({ type: 'progress', step: 'auto_loading', message: 'Loading template for auto-generation...' });

  // 1. Load the template
  startPhase('template_load');
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

  // Lighten any dark background colors from the template's design brief
  const lightenedDesignAnalysis = lightenDesignColors(designAnalysis);
  Object.assign(designAnalysis, lightenedDesignAnalysis);

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
      productImageData = { base64: buffer.toString('base64'), mimeType: detectImageMimeType(buffer) };
    }
  } catch (err) {
    console.warn('[LPGen] Failed to load project/product image (non-fatal):', err.message);
  }

  audit('project', project ? 'loaded' : 'warning',
    project ? `Project: ${project.name || projectId}, product image: ${!!productImageData}` : 'Project data is null — metadata defaults will be used');
  endPhase('template_load');

  sendEvent({ type: 'progress', step: 'auto_copy', message: 'Generating angle-specific copy...' });
  startPhase('copy_generation');

  // 3. Generate copy (Step 2) with autoContext — pass template-specific slots so Claude fills them
  // Determine word count: frame-specific override > global default > 1200
  let effectiveWordCount = 1200;
  if (agentConfig) {
    const frameWordCounts = agentConfig.frame_word_counts ? (() => { try { return JSON.parse(agentConfig.frame_word_counts); } catch { return {}; } })() : {};
    const frameId = Object.keys(frameWordCounts).find(fid => narrativeFrame?.toLowerCase().includes(fid));
    effectiveWordCount = (frameId && frameWordCounts[frameId]) || agentConfig.default_word_count || 1200;
  }

  const { sections: copySections, autoGeneratedAuthor, wordCountWarning } = await generateLandingPageCopy({
    projectId,
    angle,
    angleBrief,
    swipeText: '', // No swipe text in auto mode — template provides structure
    wordCount: effectiveWordCount,
    approvedAds,
    messageBrief,
    autoContext: {
      narrativeFrame,
      templateSlots: placeholders.templateCopy,
    },
    headlineConstraints,
  }, sendEvent);

  const totalWords = copySections.reduce((sum, s) => sum + (s.content || '').split(/\s+/).filter(Boolean).length, 0);
  audit('copy', 'generated', `${copySections.length} sections, ${totalWords} words (target ${effectiveWordCount}): ${copySections.map(s => s.type).join(', ')}${autoGeneratedAuthor ? `, author: ${autoGeneratedAuthor.name}` : ''}${wordCountWarning ? ` ⚠️ ${wordCountWarning}` : ''}`);

  // ── P3: Validate copy section completeness against template ──
  if (placeholders.templateCopy.length > 0) {
    const generatedTypes = new Set(copySections.map(s => s.type));
    const missingSlots = placeholders.templateCopy.filter(slot => !generatedTypes.has(slot));
    const coverage = ((placeholders.templateCopy.length - missingSlots.length) / placeholders.templateCopy.length * 100).toFixed(0);

    if (missingSlots.length > 0) {
      console.warn(`[LPGen] Copy section completeness: ${coverage}% — missing: ${missingSlots.join(', ')}`);
      audit('copy_completeness', 'warning', `${coverage}% coverage — missing slots: ${missingSlots.join(', ')}`, { missingSlots });

      // If more than 25% missing, retry once with explicit instructions about the missing sections
      if (missingSlots.length / placeholders.templateCopy.length > 0.25) {
        console.warn(`[LPGen] More than 25% of template slots missing (${missingSlots.length}/${placeholders.templateCopy.length}). Retrying copy generation...`);
        sendEvent({ type: 'progress', step: 'copy_completeness_retry', message: `${missingSlots.length} template sections missing — retrying with explicit slot list...` });

        try {
          const retryResult = await generateLandingPageCopy({
            projectId,
            angle,
            angleBrief,
            swipeText: '',
            wordCount: effectiveWordCount,
            approvedAds,
            messageBrief,
            additionalDirection: `CRITICAL: Your previous attempt was missing these required template sections: ${missingSlots.join(', ')}. You MUST include a section for EACH of these in your response. The template has placeholder tags for these sections — if you skip them, the finished page will have empty holes.`,
            autoContext: {
              narrativeFrame,
              templateSlots: placeholders.templateCopy,
            },
          }, sendEvent);

          const retryTypes = new Set(retryResult.sections.map(s => s.type));
          const retryMissing = placeholders.templateCopy.filter(slot => !retryTypes.has(slot));

          if (retryMissing.length < missingSlots.length) {
            // Retry filled more slots — use it
            console.log(`[LPGen] Copy completeness retry improved: ${retryMissing.length} missing (was ${missingSlots.length})`);
            audit('copy_completeness', 'retried', `Retry improved coverage: ${retryMissing.length} missing (was ${missingSlots.length})`);
            // Replace copySections with retry result — need to reassign since const
            copySections.length = 0;
            copySections.push(...retryResult.sections);
            if (retryResult.autoGeneratedAuthor) {
              Object.assign(autoGeneratedAuthor || {}, retryResult.autoGeneratedAuthor);
            }
          } else {
            console.log(`[LPGen] Copy completeness retry didn't improve. Keeping original.`);
            audit('copy_completeness', 'retry_no_improvement', 'Retry didn\'t fill more slots — keeping original');
          }
        } catch (err) {
          console.warn(`[LPGen] Copy completeness retry failed (non-fatal):`, err.message);
          audit('copy_completeness', 'retry_failed', err.message);
        }
      }
    } else {
      console.log(`[LPGen] Copy section completeness: 100% — all ${placeholders.templateCopy.length} template slots filled`);
      audit('copy_completeness', 'complete', `100% — all ${placeholders.templateCopy.length} template slots filled`);
    }
  }

  endPhase('copy_generation');

  // 3b. Run Opus editorial pass (if enabled)
  startPhase('editorial_pass');
  // Load foundational docs (needed for editorial pass AND image context)
  let foundationalDocs = null;
  try {
    foundationalDocs = await getFoundationalDocs(projectId);
  } catch (err) {
    console.warn('[LPGen] Failed to load foundational docs (non-fatal):', err.message);
    foundationalDocs = {};
  }

  let editorialPlan = null;
  if (editorialPassEnabled) {
    const editorialResult = await runEditorialPass({
      copySections,
      designAnalysis,
      angle,
      narrativeFrame,
      foundationalDocs,
      approvedAds,
      messageBrief,
      pdpUrl: null, // Will be set by publisher
      projectId,
      headlineConstraints,
    }, sendEvent);

    editorialPlan = editorialResult.plan;
    if (editorialPlan) {
      audit('editorial', 'completed',
        `Headline: "${(editorialPlan.headline || '').slice(0, 60)}", callouts: ${editorialPlan.callouts?.length || 0}, cuts: ${editorialPlan.sections_to_cut?.length || 0}`,
        { decisions: editorialPlan.decisions || [] });
    } else {
      audit('editorial', editorialResult.noEditorialPlan ? 'failed' : 'skipped',
        editorialResult.noEditorialPlan ? 'Editorial pass failed after retries — no editorial plan applied' : 'Editorial pass returned null or was not run');
    }
  } else {
    audit('editorial', 'disabled', 'Editorial pass disabled by config');
  }

  endPhase('editorial_pass');

  // Deterministic content-alignment gate — keep LP copy on the exact angle/ad message.
  startPhase('content_alignment');
  const currentHeadline = editorialPlan?.headline || copySections.find((section) => section.type === 'headline')?.content || '';
  const currentSubheadline = editorialPlan?.subheadline || copySections.find((section) => section.type === 'subheadline')?.content || '';
  let contentAlignment = validateLPContentAlignment({
    copySections,
    narrativeFrame,
    angle,
    headline: currentHeadline,
    subheadline: currentSubheadline,
    messageBrief,
  });

  if (!contentAlignment.passed) {
    audit('content_alignment', 'repairing', contentAlignment.reason);
    sendEvent({ type: 'progress', step: 'content_alignment', message: 'Repairing LP copy so it stays on the angle/message...' });

    try {
      const repairedContent = await repairLPContentAlignment({
        projectId,
        angle,
        narrativeFrame,
        copySections,
        approvedAds,
        messageBrief,
        headlineConstraints,
      }, sendEvent);

      copySections.length = 0;
      copySections.push(...repairedContent.sections);

      if (editorialPassEnabled) {
        const repairedEditorial = await runEditorialPass({
          copySections,
          designAnalysis,
          angle,
          narrativeFrame,
          foundationalDocs,
          approvedAds,
          messageBrief,
          pdpUrl: null,
          projectId,
          headlineConstraints,
        }, sendEvent);
        if (repairedEditorial.plan) {
          editorialPlan = repairedEditorial.plan;
        }
      }

      contentAlignment = validateLPContentAlignment({
        copySections,
        narrativeFrame,
        angle,
        headline: editorialPlan?.headline || copySections.find((section) => section.type === 'headline')?.content || '',
        subheadline: editorialPlan?.subheadline || copySections.find((section) => section.type === 'subheadline')?.content || '',
        messageBrief,
      });
      audit(
        'content_alignment',
        contentAlignment.passed ? 'repaired' : 'repair_failed',
        contentAlignment.passed ? repairedContent.reason || 'Copy realigned to source message.' : contentAlignment.reason
      );
    } catch (err) {
      console.warn('[LPGen] Content alignment repair failed (non-fatal):', err.message);
      audit('content_alignment', 'repair_error', err.message);
    }
  } else {
    audit('content_alignment', 'passed', contentAlignment.reason);
  }

  endPhase('content_alignment');

  // ── P6: Copy quality gate — catch bad copy before expensive image/HTML generation ──
  startPhase('quality_gate');
  try {
    const copyForReview = copySections.map(s => `[${s.type}] ${s.content}`).join('\n\n');
    const headline = editorialPlan?.headline || copySections.find(s => s.type === 'headline')?.content || '';
    const qualityCheckPrompt = `You are a direct response copywriting quality reviewer. Rate this landing page copy on a 1-5 scale.

MARKETING ANGLE: ${angle}
NARRATIVE FRAME: ${narrativeFrame || 'general'}
HEADLINE: ${headline}

COPY:
${copyForReview.slice(0, 8000)}

Rate on these criteria:
1. ANGLE ALIGNMENT — Does the copy convincingly support the marketing angle? (not generic filler)
2. FRAME COMPLIANCE — Does it follow the narrative frame's storytelling approach?
3. SPECIFICITY — Does it use specific product details, stats, and evidence? (not vague platitudes)
4. PERSUASIVENESS — Would this copy compel a reader to take action?

Respond with JSON: { "score": 1-5, "weaknesses": ["brief weakness 1", "weakness 2"] }
Score guide: 1=terrible/generic, 2=weak/misaligned, 3=adequate, 4=good, 5=excellent`;

    sendEvent({ type: 'progress', step: 'quality_gate', message: 'Running copy quality check...' });
    const qualityResponse = await chat(
      [{ role: 'user', content: qualityCheckPrompt }],
      'claude-sonnet-4-6',
      { max_tokens: 1024, timeout: 30000, operation: 'lp_quality_gate', projectId, response_format: { type: 'json_object' } }
    );

    let qualityResult;
    try {
      qualityResult = typeof qualityResponse === 'object' ? qualityResponse : JSON.parse(qualityResponse);
    } catch {
      qualityResult = null;
    }

    if (qualityResult?.score) {
      console.log(`[LPGen] Copy quality gate: score ${qualityResult.score}/5${qualityResult.weaknesses?.length ? `, weaknesses: ${qualityResult.weaknesses.join('; ')}` : ''}`);
      audit('quality_gate', qualityResult.score <= 2 ? 'low_quality' : 'passed',
        `Score: ${qualityResult.score}/5${qualityResult.weaknesses?.length ? ` — ${qualityResult.weaknesses.join('; ')}` : ''}`);

      if (qualityResult.score <= 2) {
        // Copy is weak — retry once with feedback
        console.warn(`[LPGen] Copy quality score ${qualityResult.score}/5 — retrying with feedback...`);
        sendEvent({ type: 'progress', step: 'quality_gate_retry', message: `Copy scored ${qualityResult.score}/5 — regenerating with quality feedback...` });

        try {
          const weaknessText = qualityResult.weaknesses?.join('. ') || 'Copy is too generic and doesn\'t align with the angle.';
          const retryResult = await generateLandingPageCopy({
            projectId,
            angle,
            angleBrief,
            swipeText: '',
            wordCount: effectiveWordCount,
            approvedAds,
            messageBrief,
            additionalDirection: `QUALITY FEEDBACK FROM REVIEW: ${weaknessText}. Address these weaknesses. Make the copy more specific, persuasive, and tightly aligned with the marketing angle "${angle}".`,
            autoContext: {
              narrativeFrame,
              templateSlots: placeholders.templateCopy,
            },
            headlineConstraints,
          }, sendEvent);

          // Use the retry if it has valid sections
          if (retryResult.sections.length > 0) {
            copySections.length = 0;
            copySections.push(...retryResult.sections);
            if (retryResult.autoGeneratedAuthor) {
              Object.assign(autoGeneratedAuthor || {}, retryResult.autoGeneratedAuthor);
            }
            audit('quality_gate', 'retried', `Regenerated copy after low quality score (${qualityResult.score}/5)`);

            // Re-run editorial pass on improved copy
            if (editorialPassEnabled) {
              const retryEditorial = await runEditorialPass({
                copySections, designAnalysis, angle, narrativeFrame, foundationalDocs, approvedAds, messageBrief, pdpUrl: null, projectId, headlineConstraints,
              }, sendEvent);
              if (retryEditorial.plan) {
                editorialPlan = retryEditorial.plan;
                audit('editorial', 'retried', `Re-ran editorial after quality gate retry. Headline: "${(editorialPlan.headline || '').slice(0, 60)}"`);
              }
            }
          }
        } catch (err) {
          console.warn(`[LPGen] Copy quality retry failed (non-fatal):`, err.message);
          audit('quality_gate', 'retry_failed', err.message);
        }
      }
    }
  } catch (err) {
    console.warn(`[LPGen] Copy quality gate check failed (non-fatal):`, err.message);
    // Quality gate is non-blocking — if it fails, continue with existing copy
  }

  endPhase('quality_gate');

  // 3c. Build image context from foundational docs + project data (LLM-extracted + cached)
  startPhase('image_generation');
  const imageContext = await getCachedImageContext(projectId, foundationalDocs, project);
  if (imageContext.avatarContext || imageContext.productContext) {
    console.log(`[LPGen] Image context: avatar="${imageContext.avatarContext || 'none'}", product="${(imageContext.productContext || 'none').slice(0, 80)}", llm=${!!imageContext.productVisual}`);
  }

  // 4. Generate images (Step 3) — skip if pre-generated (Gauntlet mode)
  let imageSlots;
  if (parentAutoContext?.preGeneratedImages) {
    imageSlots = parentAutoContext.preGeneratedImages;
    sendEvent({ type: 'progress', step: 'images_cached', message: 'Using pre-scored images' });
    audit('images', 'cached', `${imageSlots.filter(s => s.generated).length} pre-scored images`);
  } else {
    imageSlots = await generateSlotImages({
      imageSlots: designAnalysis.image_slots,
      copySections,
      angle,
      angleBrief,
      projectId,
      autoContext: {
        narrativeFrame,
        productImageData,
        editorialPlan,
        imageContext,
      },
    }, sendEvent);
    audit('images', 'generated', `${imageSlots.filter(s => s.generated).length}/${imageSlots.length} images generated`);
  }

  endPhase('image_generation');

  // 5. Generate HTML (Step 4) — skip if cached (Gauntlet mode)
  startPhase('html_generation');
  let htmlTemplate;
  if (parentAutoContext?.cachedHtmlTemplate) {
    htmlTemplate = parentAutoContext.cachedHtmlTemplate;
    sendEvent({ type: 'progress', step: 'html_cached', message: 'Using cached HTML template' });
    audit('html', 'cached', `Cached template: ${htmlTemplate.length} chars`);
  } else {
    htmlTemplate = await generateHtmlTemplate({
      designAnalysis,
      copySections,
      imageSlots,
      ctaElements: designAnalysis.cta_elements,
      projectId,
      autoContext: {
        skeletonHtml: enforceBackgroundLightness(template.skeleton_html || '').html,
        editorialPlan,
      },
    }, sendEvent);
    audit('html', 'generated', `HTML template: ${htmlTemplate.length} chars`);
  }

  audit('html', 'generated', `HTML template: ${htmlTemplate.length} chars`);

  endPhase('html_generation');

  // 6. Assemble final HTML
  startPhase('assembly_postprocess');
  const rawAssembledHtml = assembleLandingPage({
    htmlTemplate,
    copySections,
    imageSlots,
    ctaElements: designAnalysis.cta_elements,
  });

  // 7. Post-process: metadata → editorial fills → strip placeholders → fix duplicate headings
  const { html: assembledHtml, warnings, criticalWarnings, infoWarnings, hasCriticalIssues } = postProcessLP(rawAssembledHtml, {
    project,
    agentConfig,
    angle,
    editorialPlan,
    autoGeneratedAuthor,
    avatarText: foundationalDocs?.avatar || null,
  });
  if (hasCriticalIssues) {
    console.warn(`[LPGen] Post-processing found ${criticalWarnings.length} critical issue(s): ${criticalWarnings.join('; ')}`);
    audit('postprocess', 'critical_warnings', `${criticalWarnings.length} critical issue(s): ${criticalWarnings.join('; ')}`, { criticalWarnings, infoWarnings });
  } else if (warnings.length > 0 || infoWarnings.length > 0) {
    audit('postprocess', 'info', `${infoWarnings.length} fix(es) applied: ${infoWarnings.join('; ')}`, { infoWarnings });
  } else {
    audit('postprocess', 'clean', 'No issues found');
  }

  endPhase('assembly_postprocess');

  // ── P8: Log phase timing summary ──
  const totalDurationSec = ((Date.now() - pipelineStart) / 1000).toFixed(1);
  const timingSummary = Object.entries(phaseTiming)
    .filter(([, v]) => v.durationSec)
    .map(([phase, v]) => `${phase}: ${v.durationSec}s`)
    .join(', ');
  console.log(`[LPGen] Phase timing: ${timingSummary} | Total: ${totalDurationSec}s`);
  audit('complete', 'finished', `Final HTML: ${assembledHtml.length} chars | Total: ${totalDurationSec}s`, { phaseTiming, totalDurationSec });
  sendEvent({ type: 'progress', step: 'auto_complete', message: 'Auto-generated landing page complete' });

  return {
    copySections,
    imageSlots,
    htmlTemplate,
    assembledHtml,
    designAnalysis,
    editorialPlan,
    auditTrail,
    phaseTiming,
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

    // 1b. Run programmatic contrast audit (WCAG 2.0 math — zero LLM cost)
    let contrastAudit = { passed: true, failures: [] };
    try {
      contrastAudit = await runContrastAudit(page);
    } catch (err) {
      console.warn('[Visual QA] Contrast audit failed (non-fatal):', err.message);
    }

    // 1c. Run programmatic image load check (naturalWidth + gray rectangle detection)
    let imageLoadCheck = { passed: true, failures: [] };
    try {
      imageLoadCheck = await runImageLoadCheck(page);
    } catch (err) {
      console.warn('[Visual QA] Image load check failed (non-fatal):', err.message);
    }

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

NOTE: Text contrast/legibility is checked programmatically — you do NOT need to flag contrast issues. Only flag contrast if text is completely invisible (same color as background).

CHECK FOR THESE ISSUES:
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

    // 3. Merge programmatic results into vision QA
    const mergedIssues = [...(qaResult.issues || [])];

    // Add programmatic contrast failures (these are authoritative — not from vision)
    for (const f of contrastAudit.failures) {
      mergedIssues.push({
        type: 'contrast_failure',
        programmatic: true,
        severity: 'critical',
        category: 'color',
        description: `WCAG contrast failure: ratio ${f.contrastRatio}:1 (need ${f.requiredRatio}:1) — "${f.textSnippet.slice(0, 50)}"`,
        location: f.selector,
        css_selector_hint: f.selector,
        backgroundColor: f.backgroundColor,
        textColor: f.textColor,
        contrastRatio: f.contrastRatio,
        requiredRatio: f.requiredRatio,
        fix_suggestion: `Fix text color contrast on ${f.selector}`,
      });
    }

    // Add programmatic image failures (skip if vision already caught same position)
    const visionImageIssuePositions = (qaResult.issues || [])
      .filter(i => i.type === 'gray_box_image' || i.type === 'broken_image')
      .map(i => (i.location || '').toLowerCase());

    for (const f of imageLoadCheck.failures) {
      const posKey = f.position.toLowerCase();
      const alreadyCaught = visionImageIssuePositions.some(v => v.includes(posKey.split('px')[0]));
      if (!alreadyCaught) {
        mergedIssues.push({
          type: f.reason === 'gray_rectangle' ? 'gray_box_image' : 'broken_image',
          programmatic: true,
          severity: 'critical',
          category: 'image',
          description: f.description,
          location: f.position,
          css_selector_hint: f.selector,
          fix_suggestion: `Regenerate image at ${f.selector}`,
        });
      }
    }

    // Remove vision-reported contrast issues — programmatic audit is authoritative
    const finalIssues = mergedIssues.filter(i => {
      if (i.type === 'contrast_failure' && !i.programmatic) return false;
      return true;
    });

    // Recalculate passed + score based on merged issues
    const criticalCount = finalIssues.filter(i => i.severity === 'critical').length;
    const warningCount = finalIssues.filter(i => i.severity === 'warning').length;
    const passed = criticalCount === 0 && warningCount <= 1;
    // Score: start at 100, -15 per critical, -5 per warning, -1 per minor
    const score = Math.max(0, 100
      - criticalCount * 15
      - warningCount * 5
      - finalIssues.filter(i => i.severity === 'minor').length
    );

    const autoFixable = criticalCount === 0 || finalIssues
      .filter(i => i.severity === 'critical')
      .every(i => ['placeholder_text', 'generic_attribution', 'contrast_failure', 'gray_box_image', 'broken_image'].includes(i.type));

    console.log(`[Visual QA] Merged: ${contrastAudit.failures.length} contrast + ${imageLoadCheck.failures.length} image programmatic issues + ${(qaResult.issues || []).length} vision issues → ${finalIssues.length} total (${criticalCount} critical)`);

    return {
      passed,
      autoFixable,
      issues: finalIssues,
      summary: qaResult.summary || '',
      score,
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

// ─── Gauntlet: Image Pre-Scoring ────────────────────────────────────────────

/**
 * Score a single image against avatar/product expectations using Sonnet vision.
 * Returns { passed, issues[], reasoning }.
 */
export async function preScoreImage(imageBase64, mimeType, avatarContext, productContext, productVisual, avatarVisual) {
  const prompt = `You are a strict image quality gatekeeper for advertising landing pages. Score this image.

PRODUCT CONTEXT: ${productContext || 'Unknown product'}
AVATAR CONTEXT: ${avatarContext || 'Unknown audience'}
${productVisual ? `PRODUCT DETAILS: ${productVisual.productName} — ${productVisual.physicalDescription || 'no description'}` : ''}
${avatarVisual ? `PERSON SHOULD BE: ${avatarVisual.gender || 'any'}, age ${avatarVisual.ageRange || 'unknown'}, ${avatarVisual.lifestyle || 'unknown lifestyle'}` : ''}
${productVisual?.notThisProduct?.length ? `THIS IS NOT: ${productVisual.notThisProduct.join(', ')}` : ''}
${avatarVisual?.notThisPerson?.length ? `Do NOT show: ${avatarVisual.notThisPerson.join(', ')}` : ''}

CHECK FOR:
1. **Sensibility** — Does this image make sense for an ad landing page? No surreal/absurd compositions.
2. **Correct product** — If a product is shown, does it match the product context? A bedsheet must look like a bedsheet, not a yoga mat.
3. **Correct demographic** — Does the person (if shown) match the target avatar's age, gender, and lifestyle?
4. **Realism** — Does the image look photorealistic? No obvious AI artifacts, distorted faces, or extra fingers.
5. **No AI text** — The image must NOT contain any visible text, watermarks, or generated text.

RESPOND WITH JSON ONLY:
{
  "passed": true/false,
  "issues": ["issue 1", "issue 2"],
  "reasoning": "Brief explanation"
}

Pass ONLY if ALL 5 checks pass. Be strict — a single failed check means passed=false.`;

  try {
    const response = await chatWithImage(
      [{ role: 'system', content: 'You are an image quality scorer. Respond with JSON only.' }],
      prompt,
      imageBase64,
      mimeType || 'image/png',
      'claude-sonnet-4-6',
      {
        operation: 'lp_image_prescore',
        timeout: 30000,
      }
    );

    const parsed = extractJSON(response);
    if (parsed && typeof parsed.passed === 'boolean') {
      return parsed;
    }
    // extractJSON returned null or result has no passed field — treat as failed
    return { passed: false, issues: ['Failed to parse scoring response'], reasoning: (response || '').slice(0, 200) };
  } catch (err) {
    console.error('[Gauntlet] Image pre-score error:', err.message);
    return { passed: false, issues: [`Scoring error: ${err.message}`], reasoning: 'Scoring failed' };
  }
}

/**
 * Pre-score all images in a slot array. For failed images, regenerate and re-score
 * up to maxRetries times per slot.
 */
export async function preScoreAndRetryImages(imageSlots, angle, autoContext, projectId, sendEvent, maxRetries = 5) {
  const imageContext = autoContext?.imageContext || {};
  const updatedSlots = [...imageSlots];
  let totalAttempts = 0;

  for (let i = 0; i < updatedSlots.length; i++) {
    const slot = updatedSlots[i];
    if (!slot.generated || !slot.storageId) continue; // Skip failed/empty slots

    let attempts = 0;
    let currentSlot = slot;

    while (attempts < maxRetries) {
      attempts++;
      totalAttempts++;

      sendEvent({
        type: 'progress',
        step: 'image_prescoring',
        message: `Pre-scoring image ${i + 1}/${updatedSlots.length}${attempts > 1 ? ` (retry ${attempts - 1})` : ''}...`,
      });

      // Download the image to score it
      let imageBuffer;
      try {
        imageBuffer = await downloadToBuffer(currentSlot.storageId);
      } catch (err) {
        console.warn(`[Gauntlet] Failed to download image for scoring: ${err.message}`);
        break; // Can't score, keep the image as-is
      }

      const scoreResult = await preScoreImage(
        imageBuffer.toString('base64'),
        'image/png',
        imageContext.avatarContext,
        imageContext.productContext,
        imageContext.productVisual,
        imageContext.avatarVisual,
      );

      if (scoreResult.passed) {
        console.log(`[Gauntlet] Image ${i + 1} passed pre-score on attempt ${attempts}`);
        sendEvent({
          type: 'progress',
          step: 'image_prescore_passed',
          message: `Image ${i + 1} passed pre-score${attempts > 1 ? ` after ${attempts} attempts` : ''}`,
        });
        break;
      }

      console.warn(`[Gauntlet] Image ${i + 1} failed pre-score (attempt ${attempts}): ${scoreResult.issues?.join(', ')}`);

      // If we have retries left, regenerate
      if (attempts < maxRetries) {
        sendEvent({
          type: 'progress',
          step: 'image_prescore_retry',
          message: `Image ${i + 1} failed: ${scoreResult.issues?.[0] || 'quality issue'}. Regenerating...`,
        });

        try {
          const imagePrompt = buildImagePrompt(slot, angle, '', autoContext, i, updatedSlots.length);
          const slotDesc = (slot.description || slot.type || slot.slot_id || '').toLowerCase();
          const isProductSlot = slotDesc.includes('product') || slotDesc.includes('hero');
          const referenceImage = (isProductSlot && autoContext?.productImageData) ? autoContext.productImageData : null;

          const { imageBuffer: newBuffer, mimeType: newMimeType } = await generateImage(imagePrompt, slot.aspect_ratio || '16:9', referenceImage, {
            projectId, operation: 'lp_image_prescore_retry',
          });

          const storageId = await uploadBuffer(newBuffer, newMimeType);
          const storageUrl = await getStorageUrl(storageId);

          currentSlot = {
            ...slot,
            storageId,
            storageUrl,
            generated: true,
          };
          updatedSlots[i] = currentSlot;
        } catch (regenErr) {
          console.error(`[Gauntlet] Image regeneration failed:`, regenErr.message);
          break; // Keep what we have
        }
      } else {
        sendEvent({
          type: 'progress',
          step: 'image_prescore_exhausted',
          message: `Image ${i + 1} failed all ${maxRetries} pre-score attempts. Keeping last version.`,
        });
      }
    }
  }

  return { imageSlots: updatedSlots, totalAttempts };
}

// ─── Gauntlet: Full-Page LP Scoring ─────────────────────────────────────────

/**
 * Render an LP's assembled HTML, take a full-page screenshot, and score it
 * using Sonnet vision on a 0-10 scale.
 *
 * Scoring dimensions:
 * - Image sensibility (0-4): Do images make sense, match product/avatar?
 * - Visual coherence (0-3): Layout, typography, color consistency
 * - CTA effectiveness (0-2): Are CTAs visible, compelling, properly styled?
 * - Copy quality (0-1): Is copy readable, no placeholders, proper formatting?
 *
 * @returns {{ score, image_sensibility, visual_coherence, cta_effectiveness, copy_quality, fatal_flaws[], reasoning, screenshotBuffer }}
 */
export async function scoreGauntletLP(assembledHtml, projectId, imageContext, { angle, narrativeFrame, productImageData } = {}) {
  const puppeteer = (await import('puppeteer')).default;

  let browser;
  try {
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
    await page.setContent(assembledHtml, { waitUntil: 'networkidle0', timeout: 30000 });
    await new Promise(r => setTimeout(r, 1000));

    const bodyHeight = await page.evaluate(() => document.body.scrollHeight);
    const screenshotHeight = Math.min(bodyHeight, 7900);

    const screenshotBuffer = await page.screenshot({
      type: 'jpeg',
      quality: 85,
      clip: { x: 0, y: 0, width: 1280, height: screenshotHeight },
    });

    await browser.close();
    browser = null;

    // Score via Sonnet vision
    const productDesc = imageContext?.productContext || 'Unknown product';
    const avatarDesc = imageContext?.avatarContext || 'Unknown audience';

    const scorePrompt = `You are a landing page quality scorer. Score this landing page screenshot on a 0-11 scale.

PRODUCT: ${productDesc}
TARGET AUDIENCE: ${avatarDesc}
MARKETING ANGLE: ${angle || 'General'}
NARRATIVE FRAME: ${narrativeFrame || 'General'}
${productImageData ? 'PRODUCT REFERENCE: The second image is a photo of the actual product. Use it as ground truth when scoring Image Sensibility — images on the landing page should visually match this product.' : ''}

SCORING DIMENSIONS (score each independently):

1. **Image Sensibility (0-4 points)**:
   - 0: Images are absurd, wrong product, or clearly AI-broken
   - 1: Images exist but don't match the product or audience
   - 2: Images are acceptable but generic
   - 3: Images match the product and audience well
   - 4: Images are compelling, on-brand, and perfectly matched

2. **Visual Coherence (0-3 points)**:
   - 0: Layout is broken, elements overlap, completely unprofessional
   - 1: Layout works but has noticeable issues (spacing, alignment)
   - 2: Clean, professional layout with minor issues
   - 3: Polished, visually cohesive design

3. **CTA Effectiveness (0-2 points)**:
   - 0: CTAs are missing, broken, or invisible
   - 1: At least one CTA is present and functional but small or hard to find
   - 2: CTAs are clearly visible, well-styled, and appear at multiple points on the page

4. **Copy Quality (0-2 points)**:
   - 0: Placeholders visible, garbled text, or truncated content
   - 1: Copy is clean and readable but generic or lacks persuasive power
   - 2: Copy is compelling — headline hooks attention, body builds desire, tone matches audience

Also identify any **FATAL FLAWS** — issues so bad the LP cannot be used:
- "wrong_product_image": An image shows the wrong product entirely (e.g., yoga mat instead of bedsheet)
- "ai_text_in_image": Visible AI-generated text baked into an image
- "broken_layout": Page is fundamentally broken (massive overlap, invisible content)
- "placeholder_visible": {{placeholder}} text is visible to the user

For image-related fatal flaws, include the approximate position: "hero", "middle", "bottom", or "product".

RESPOND WITH JSON ONLY:
{
  "score": <0-11 total>,
  "image_sensibility": <0-4>,
  "visual_coherence": <0-3>,
  "cta_effectiveness": <0-2>,
  "copy_quality": <0-2>,
  "fatal_flaws": [
    { "type": "wrong_product_image", "image_position": "hero", "description": "..." }
  ],
  "reasoning": "Brief overall assessment"
}`;

    const images = [{ base64: screenshotBuffer.toString('base64'), mimeType: detectImageMimeType(screenshotBuffer) }];
    if (productImageData?.base64) {
      images.push({ base64: productImageData.base64, mimeType: productImageData.mimeType || 'image/jpeg' });
    }

    const response = await chatWithMultipleImages(
      [{ role: 'system', content: 'You are a landing page quality scorer. Respond with JSON only.' }],
      scorePrompt,
      images,
      'claude-sonnet-4-6',
      {
        operation: 'lp_gauntlet_score',
        projectId,
        timeout: 60000,
      }
    );

    let scoreResult = extractJSON(response);
    if (!scoreResult || typeof scoreResult.score !== 'number') {
      scoreResult = { score: 0, fatal_flaws: [{ type: 'parse_error', description: 'Failed to parse scoring response' }], reasoning: (response || '').slice(0, 200) };
    }

    return { ...scoreResult, screenshotBuffer };
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    throw err;
  }
}

/**
 * Regenerate images flagged with fatal_flaws by the Gauntlet scorer.
 * Swaps URLs in the assembled HTML and re-runs postProcessLP.
 */
export async function regenerateFailedImages(assembledHtml, fatalFlaws, imageSlots, autoContext, projectId, sendEvent) {
  const imageFlaws = (fatalFlaws || []).filter(f =>
    f.type === 'wrong_product_image' || f.type === 'ai_text_in_image'
  );

  if (imageFlaws.length === 0) return { html: assembledHtml, regeneratedCount: 0 };

  let html = assembledHtml;
  let regeneratedCount = 0;

  for (const flaw of imageFlaws) {
    // Map position to slot index
    const position = (flaw.image_position || '').toLowerCase();
    let targetSlotIndex = -1;

    if (position === 'hero' || position === 'top') {
      targetSlotIndex = 0;
    } else if (position === 'product') {
      // Find the product slot
      targetSlotIndex = imageSlots.findIndex(s =>
        (s.description || s.slot_id || '').toLowerCase().includes('product')
      );
    } else if (position === 'middle') {
      targetSlotIndex = Math.floor(imageSlots.length / 2);
    } else if (position === 'bottom') {
      targetSlotIndex = imageSlots.length - 1;
    }

    if (targetSlotIndex < 0 || targetSlotIndex >= imageSlots.length) {
      targetSlotIndex = 0; // Default to first image
    }

    const targetSlot = imageSlots[targetSlotIndex];
    if (!targetSlot?.storageUrl) continue;

    sendEvent({
      type: 'progress',
      step: 'gauntlet_image_regen',
      message: `Regenerating ${position || 'flagged'} image (${flaw.type})...`,
    });

    try {
      const imagePrompt = buildImagePrompt(targetSlot, autoContext?.angle || '', '', autoContext, targetSlotIndex, imageSlots.length);
      const slotDesc = (targetSlot.description || targetSlot.type || targetSlot.slot_id || '').toLowerCase();
      const isProductSlot = slotDesc.includes('product') || slotDesc.includes('hero');
      const referenceImage = (isProductSlot && autoContext?.productImageData) ? autoContext.productImageData : null;

      const { imageBuffer, mimeType } = await generateImage(imagePrompt, targetSlot.aspect_ratio || '16:9', referenceImage, {
        projectId, operation: 'lp_gauntlet_image_regen',
      });

      const storageId = await uploadBuffer(imageBuffer, mimeType);
      const newUrl = await getStorageUrl(storageId);

      // Swap URL in HTML
      if (targetSlot.storageUrl) {
        html = html.split(targetSlot.storageUrl).join(newUrl);
        targetSlot.storageId = storageId;
        targetSlot.storageUrl = newUrl;
        regeneratedCount++;
      }
    } catch (err) {
      console.error(`[Gauntlet] Failed to regenerate image at ${position}:`, err.message);
    }
  }

  // Re-run post-processing on the updated HTML
  if (regeneratedCount > 0) {
    const { html: processed } = postProcessLP(html);
    html = processed;
  }

  return { html, regeneratedCount };
}

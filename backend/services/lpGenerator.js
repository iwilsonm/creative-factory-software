/**
 * LP (Landing Page) Generator Service — Phase 1
 *
 * Phase A: Extract text from uploaded swipe PDF using existing PDF extraction logic
 * Phase B: Generate landing page copy via Claude Sonnet multi-message conversation
 *
 * Uses the same Anthropic wrapper (services/anthropic.js) as the rest of the platform.
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pdf = require('pdf-parse');

import { chat } from './anthropic.js';
import { getDocsByProject } from '../convexClient.js';

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

// ─── Phase B: Multi-message copy generation ─────────────────────────────────

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

/**
 * Generate landing page copy using a multi-message Claude Sonnet conversation.
 *
 * Conversation flow:
 *   Message 1 (system): Role assignment — direct response copywriter persona
 *   Message 1 (user): All 4 foundational docs + project context
 *   Message 2 (user): Swipe PDF text + angle + word count + additional direction
 *   → Claude generates structured copy sections
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

  sendEvent({ type: 'progress', step: 'complete', message: `Generated ${validSections.length} copy sections` });

  return { sections: validSections };
}

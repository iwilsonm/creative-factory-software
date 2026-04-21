/**
 * LP Image Strategy — three sequential GPT-5.4 calls that produce 10–14
 * Nano Banana 2 image-prompt concepts for a finished listicle.
 *
 * Pipeline (per PEF plan 2026-04-21):
 *   Call A: Strategist context — primes GPT-5.4 with target demo + problem and
 *           feeds the foundational docs (truncated for context-window safety).
 *   Call B: LP analysis — sends the just-generated listicle text and asks for
 *           emotional analysis. Substitutes plain text for Ian's "[ATTACH PDF
 *           OF LANDING PAGE]" placeholder; no PDF round-trip needed.
 *   Call C: Concepts + Nano Banana prompts — JSON-mode response with concepts
 *           in Ian's exact 10-part prompt format.
 *
 * Model selection: resolves from `modelOverride` → settings.openai_lp_image_strategy_model
 *                  → default 'gpt-5.4'. The OpenAI wrapper auto-falls-back to
 *                  gpt-5.2 on `model_not_found`.
 *
 * JSON parse retry: on Call C parse failure, retries ONCE with a stricter
 * "JSON only" system message. Hard-fails after the second failure (no silent
 * degradation).
 *
 * Token budget: foundational docs are truncated to ~6000 chars per doc (24k
 * total) before injection — same conservative ceiling docGenerator.js uses.
 */

import { chat } from './openai.js';
import { extractJSON } from './anthropic.js';
import { getSetting } from '../convexClient.js';

// Ian's verbatim prompts — DO NOT MODIFY (PEF plan 2026-04-21).
// Substitution tokens (in square brackets) get replaced at call time.

const PROMPT_A_STRATEGIST_CONTEXT = `You are my expert creative strategist and text to image prompt engineer and it is your role to come up with unique image concepts for my e-commerce brand that helps [INSERT TARGET DEMO] [INSERT PROBLEM YOU'RE SOLVING] and then to write highly effective text to image prompts to bring those various image to life. These images specifically will be placed on our landing pages and will need to match with our core audeinces painpoints, struggles, and belefis. I want you to please begin by analyzing the documents below so that you have a good understanding of my offer, the product, and the market I'm selling to, then let me know your thoughts.

[INSERT ALL FOUNDATIONAL DOCS]`;

const PROMPT_B_LP_ANALYSIS = `Great work! Now that you have completed that step, I want you to please use the deep emotional research that you analyzed in the research documents above and now analyze the landing page i have already craeted for my brand... - plz lmk if you are able to read through the pdf

[ATTACH PDF OF LANDING PAGE]`;

const PROMPT_C_CONCEPTS = `Awesome. Great work. Now that you have completed that step, I want you to please use the deep emotional research that you analyzed in the research documents above to create powerful and emotionally resonant image concepts and include the text-to-image prompt that I can use in Nano Banana 2 to actually bring that concept to life. Some of the various concepts could include (but are not limited to) before and afters, nightmare scenario illustrations, comparisons, big benefit statements, offer heavy statics, media and press releases, reasons why, features and benefits, us versus them, testimonial/review, humor/fun, etc.

plz just include the prompts here - i dont need a full html site, just the prompts

plz follow this prompting structure -

Prompt Format (REQUIRED):
[Subject / Action]
+ [Art Style / Medium]
+ [Lighting / Atmosphere]
+ [Camera / Angle]
+ [Composition & Layout Details]
+ [Brand Color Instructions]
+ [Product Representation Instructions]
+ [Specific Text Requirement: "Exact text" in "Font style"]
+ [Clarity & Legibility Constraints]
--ar [Aspect Ratio]

Return your response as JSON in this exact shape:
{
  "concepts": [
    { "concept_label": "before/after", "nano_banana_prompt": "...", "aspect_ratio": "16:9", "suggested_slot_role": "hero" }
  ]
}`;

// JSON-retry stricter system message used if Call C's first response isn't parseable JSON.
const STRICT_JSON_RETRY_INSTRUCTION = 'Respond with ONLY valid JSON matching the schema { "concepts": [{ "concept_label", "nano_banana_prompt", "aspect_ratio", "suggested_slot_role" }] }. No commentary, no markdown fences.';

const FALLBACK_TARGET_DEMO = 'our core customer';
const FALLBACK_PROBLEM = 'with their key health and lifestyle goals';
const MIN_CONCEPTS = 5;
const MAX_DOC_CHARS = 6000;     // per doc; total ≤ ~24k chars (~6k tokens)
const MAX_LISTICLE_CHARS = 24000; // ~6k tokens, conservative

/**
 * Truncate a single doc to MAX_DOC_CHARS, preserving start + end with a marker.
 */
function truncateDoc(label, body) {
  const text = String(body || '').trim();
  if (!text) return '';
  if (text.length <= MAX_DOC_CHARS) {
    return `=== ${label.toUpperCase()} ===\n${text}`;
  }
  const headChars = Math.floor(MAX_DOC_CHARS * 0.7);
  const tailChars = MAX_DOC_CHARS - headChars - 60;
  const head = text.slice(0, headChars);
  const tail = text.slice(text.length - tailChars);
  return `=== ${label.toUpperCase()} (truncated for context window) ===\n${head}\n\n[... ${text.length - headChars - tailChars} chars omitted ...]\n\n${tail}`;
}

/**
 * Build the foundational-docs payload for Prompt A.
 * Accepts the same shape `getDocsByProject` returns (research, avatar, offer_brief, necessary_beliefs).
 */
function buildFoundationalDocsPayload(foundationalDocs = {}) {
  const sections = [];
  if (foundationalDocs.research) sections.push(truncateDoc('Research', foundationalDocs.research));
  if (foundationalDocs.avatar) sections.push(truncateDoc('Avatar', foundationalDocs.avatar));
  if (foundationalDocs.offer_brief) sections.push(truncateDoc('Offer Brief', foundationalDocs.offer_brief));
  if (foundationalDocs.necessary_beliefs) sections.push(truncateDoc('Necessary Beliefs', foundationalDocs.necessary_beliefs));
  return sections.filter(Boolean).join('\n\n');
}

/**
 * Truncate the assembled listicle text to MAX_LISTICLE_CHARS, preserving
 * structure if possible (keep all numbered items by sampling from middle).
 */
function truncateListicle(text) {
  const trimmed = String(text || '').trim();
  if (trimmed.length <= MAX_LISTICLE_CHARS) return trimmed;
  const headChars = Math.floor(MAX_LISTICLE_CHARS * 0.6);
  const tailChars = MAX_LISTICLE_CHARS - headChars - 60;
  return `${trimmed.slice(0, headChars)}\n\n[... ${trimmed.length - headChars - tailChars} chars omitted ...]\n\n${trimmed.slice(trimmed.length - tailChars)}`;
}

/**
 * Generate image concepts via three sequential GPT-5.4 calls.
 *
 * @param {object} params
 * @param {string} params.projectId
 * @param {string} params.lpCopyText - The combined listicle text (Turn 3 + Turn 4)
 * @param {object} params.foundationalDocs - { research, avatar, offer_brief, necessary_beliefs }
 * @param {string} [params.targetDemo] - Optional override; defaults to "our core customer"
 * @param {string} [params.problem] - Optional override; defaults to a generic problem statement
 * @param {string|null} [params.modelOverride] - Optional model override (else reads setting / defaults to 'gpt-5.4')
 * @param {(event: object) => void} sendEvent - SSE event callback
 * @returns {Promise<{ concepts: Array, model: string, conversationLog: Array }>}
 */
export async function generateImageConcepts({
  projectId,
  lpCopyText,
  foundationalDocs = {},
  targetDemo,
  problem,
  modelOverride = null,
}, sendEvent = () => {}) {
  // Resolve model
  let model = modelOverride;
  if (!model) {
    try {
      const setting = await getSetting('openai_lp_image_strategy_model');
      model = (typeof setting === 'string' && setting.trim()) ? setting.trim() : 'gpt-5.4';
    } catch {
      model = 'gpt-5.4';
    }
  }

  // SSE warning piping — the OpenAI wrapper emits a `model_fallback` warning
  // via onWarning if gpt-5.4 returns model_not_found. Forward it to the SSE stream.
  const onWarning = (warning) => {
    try { sendEvent(warning); } catch { /* swallow */ }
  };

  const docsPayload = buildFoundationalDocsPayload(foundationalDocs);
  const listicleText = truncateListicle(lpCopyText);
  const resolvedDemo = String(targetDemo || '').trim() || FALLBACK_TARGET_DEMO;
  const resolvedProblem = String(problem || '').trim() || FALLBACK_PROBLEM;

  // ── Call A: Strategist context ────────────────────────────────────────
  const promptA = PROMPT_A_STRATEGIST_CONTEXT
    .replace('[INSERT TARGET DEMO]', resolvedDemo)
    .replace("[INSERT PROBLEM YOU'RE SOLVING]", resolvedProblem)
    .replace('[INSERT ALL FOUNDATIONAL DOCS]', docsPayload || '(no foundational documents available)');

  sendEvent({ type: 'progress', step: 'image_strategy_a', message: 'GPT-5.4 is studying foundational docs for image strategy...' });
  const conversation = [{ role: 'user', content: promptA }];
  // Pass an array CLONE on each chat call so test mocks (and any caller) get
  // a stable snapshot of the conversation at call time, not a live reference.
  const responseA = await chat([...conversation], model, {
    operation: 'lp_image_strategy_context',
    projectId,
    onWarning,
  });
  conversation.push({ role: 'assistant', content: responseA });

  // ── Call B: LP analysis ──────────────────────────────────────────────
  const promptB = PROMPT_B_LP_ANALYSIS.replace('[ATTACH PDF OF LANDING PAGE]', listicleText || '(no LP text provided)');
  sendEvent({ type: 'progress', step: 'image_strategy_b', message: 'GPT-5.4 is analyzing the listicle copy...' });
  conversation.push({ role: 'user', content: promptB });
  const responseB = await chat([...conversation], model, {
    operation: 'lp_image_strategy_analysis',
    projectId,
    onWarning,
  });
  conversation.push({ role: 'assistant', content: responseB });

  // ── Call C: Concepts + Nano Banana prompts ───────────────────────────
  sendEvent({ type: 'progress', step: 'image_strategy_c', message: 'GPT-5.4 is generating image concepts + Nano Banana 2 prompts...' });
  conversation.push({ role: 'user', content: PROMPT_C_CONCEPTS });

  const callCWithFormat = (extraSystem) => {
    const messagesWithSystem = extraSystem
      ? [{ role: 'system', content: extraSystem }, ...conversation]
      : [...conversation];
    return chat(messagesWithSystem, model, {
      operation: 'lp_image_strategy_concepts',
      projectId,
      onWarning,
      response_format: { type: 'json_object' },
      // Lower temperature for JSON output
      temperature: 0.3,
    });
  };

  let responseC = await callCWithFormat();
  let parsed = extractJSON(responseC);
  let concepts = Array.isArray(parsed?.concepts) ? parsed.concepts : null;

  // JSON-retry pass — fire ONCE with a stricter system message if parse failed.
  if (!concepts) {
    sendEvent({
      type: 'warning',
      step: 'image_strategy_c_retry',
      message: 'GPT-5.4 returned non-JSON concepts; retrying with stricter instruction...',
    });
    responseC = await callCWithFormat(STRICT_JSON_RETRY_INSTRUCTION);
    parsed = extractJSON(responseC);
    concepts = Array.isArray(parsed?.concepts) ? parsed.concepts : null;
  }

  if (!concepts) {
    throw new Error('Image-strategy Call C failed to return parseable JSON concepts after retry. Aborting LP generation.');
  }

  // Validate + normalize concept entries.
  const validConcepts = concepts
    .filter((c) => c && typeof c === 'object' && c.nano_banana_prompt && String(c.nano_banana_prompt).trim().length > 20)
    .map((c, idx) => ({
      concept_label: String(c.concept_label || `concept_${idx + 1}`).trim(),
      nano_banana_prompt: String(c.nano_banana_prompt).trim(),
      aspect_ratio: String(c.aspect_ratio || '16:9').trim(),
      suggested_slot_role: String(c.suggested_slot_role || 'general').trim(),
    }));

  if (validConcepts.length < MIN_CONCEPTS) {
    throw new Error(`Image-strategy Call C returned only ${validConcepts.length} valid concept(s); minimum ${MIN_CONCEPTS} required.`);
  }

  sendEvent({
    type: 'progress',
    step: 'image_strategy_complete',
    message: `Generated ${validConcepts.length} image concepts via ${model}.`,
    count: validConcepts.length,
  });

  return {
    concepts: validConcepts,
    model,
    conversationLog: conversation,
  };
}

// Exported helpers for unit testing.
export const __test__ = {
  buildFoundationalDocsPayload,
  truncateDoc,
  truncateListicle,
  PROMPT_A_STRATEGIST_CONTEXT,
  PROMPT_B_LP_ANALYSIS,
  PROMPT_C_CONCEPTS,
};

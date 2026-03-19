import { chat as anthropicChat } from './anthropic.js';
import { getDocsByProject, updateSalesPage } from '../convexClient.js';
import {
  FOUNDATION_ANALYSIS_PROMPT,
  buildTurn2Prompt,
  buildTurn3Prompt,
  EDITORIAL_PASS_PROMPT,
} from './spSectionPrompts.js';

/**
 * Parse JSON from Claude's response text.
 * Handles cases where Claude wraps JSON in explanatory text.
 */
function parseJSONResponse(text) {
  try {
    return JSON.parse(text);
  } catch (_e) {
    // Fall back: extract the first top-level { ... } block
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      try {
        return JSON.parse(text.substring(firstBrace, lastBrace + 1));
      } catch (_e2) {
        // fall through
      }
    }
    throw new Error(`Failed to parse JSON from LLM response. Raw text starts with: "${text.substring(0, 120)}..."`);
  }
}

/**
 * Generate a full sales page via 3-turn Claude conversation + Opus editorial pass.
 *
 * @param {object} params
 * @param {string} params.projectId - Project external ID
 * @param {object} params.productBrief - Product brief data
 * @param {string} params.pageId - Sales page external ID to update
 * @param {function} sendEvent - SSE event emitter
 */
export async function generateSalesPage({ projectId, productBrief, pageId }, sendEvent) {
  let currentStep = 'init';

  try {
    // ── 1. Load foundational docs ──────────────────────────────────────
    currentStep = 'load_docs';
    const docs = await getDocsByProject(projectId);
    let hasDocs = false;
    let foundationalContent = '';

    if (docs && docs.length > 0) {
      hasDocs = true;
      const research = docs.find((d) => d.doc_type === 'research');
      const avatar = docs.find((d) => d.doc_type === 'avatar');
      const offerBrief = docs.find((d) => d.doc_type === 'offer_brief');
      const beliefs = docs.find((d) => d.doc_type === 'beliefs');

      foundationalContent = [
        research && `## Research\n${research.content}`,
        avatar && `## Customer Avatar\n${avatar.content}`,
        offerBrief && `## Offer Brief\n${offerBrief.content}`,
        beliefs && `## Beliefs Document\n${beliefs.content}`,
      ]
        .filter(Boolean)
        .join('\n\n');
    } else {
      sendEvent({
        type: 'warning',
        message: 'No foundational docs found — generating from product brief only. Copy quality may be reduced.',
      });
    }

    // ── 2. Turn 1 — Foundation Analysis (Sonnet) ──────────────────────
    currentStep = 'sp_foundation_analysis';
    sendEvent({ type: 'progress', step: 'foundation_analysis', message: 'Analyzing product & audience...' });

    const turn1UserMessage = hasDocs
      ? `Here are the foundational docs for this product:\n\n${foundationalContent}\n\nProduct Brief:\n${JSON.stringify(productBrief, null, 2)}`
      : `No foundational docs available. Generate the best possible sales page using only this product brief:\n\n${JSON.stringify(productBrief, null, 2)}`;

    const turn1Response = await anthropicChat(
      [
        { role: 'system', content: FOUNDATION_ANALYSIS_PROMPT },
        { role: 'user', content: turn1UserMessage },
      ],
      'claude-sonnet-4-6',
      { operation: 'sp_foundation_analysis', projectId }
    );

    const preWriteAnalysis = parseJSONResponse(turn1Response);

    // ── 3. Turn 2 — Sections 1-7 (Sonnet) ─────────────────────────────
    currentStep = 'sp_sections_1_7';
    sendEvent({ type: 'progress', step: 'sections_1_7', message: 'Writing hero, education & trust sections...' });

    const turn2UserMessage = buildTurn2Prompt(preWriteAnalysis, productBrief);

    let turn2Response;
    {
      const keepalive = setInterval(() => sendEvent({ type: 'keepalive' }), 25000);
      try {
        turn2Response = await anthropicChat(
          [
            { role: 'system', content: FOUNDATION_ANALYSIS_PROMPT },
            { role: 'user', content: turn1UserMessage },
            { role: 'assistant', content: turn1Response },
            { role: 'user', content: turn2UserMessage },
          ],
          'claude-sonnet-4-6',
          { operation: 'sp_sections_1_7', projectId, max_tokens: 8000, timeout: 180000 }
        );
      } finally {
        clearInterval(keepalive);
      }
    }

    const firstHalfSections = parseJSONResponse(turn2Response);
    // Save partial — sections 1-7 preserved if turn 3 or editorial fails
    updateSalesPage(pageId, { section_data: JSON.stringify(firstHalfSections), status: 'partial' }).catch(() => {});

    // ── 4. Turn 3 — Sections 8-13 (Sonnet) ────────────────────────────
    currentStep = 'sp_sections_8_13';
    sendEvent({ type: 'progress', step: 'sections_8_13', message: 'Writing benefits, proof & FAQ sections...' });

    const turn3UserMessage = buildTurn3Prompt(preWriteAnalysis, productBrief, firstHalfSections);

    let turn3Response;
    {
      const keepalive = setInterval(() => sendEvent({ type: 'keepalive' }), 25000);
      try {
        turn3Response = await anthropicChat(
          [
            { role: 'system', content: FOUNDATION_ANALYSIS_PROMPT },
            { role: 'user', content: turn1UserMessage },
            { role: 'assistant', content: turn1Response },
            { role: 'user', content: turn2UserMessage },
            { role: 'assistant', content: turn2Response },
            { role: 'user', content: turn3UserMessage },
          ],
          'claude-sonnet-4-6',
          { operation: 'sp_sections_8_13', projectId, max_tokens: 8000, timeout: 180000 }
        );
      } finally {
        clearInterval(keepalive);
      }
    }

    const secondHalfSections = parseJSONResponse(turn3Response);

    // ── 5. Merge sections ──────────────────────────────────────────────
    const sectionData = { ...firstHalfSections, ...secondHalfSections };
    // Save partial — all 13 sections preserved if editorial pass fails
    updateSalesPage(pageId, { section_data: JSON.stringify(sectionData), status: 'partial' }).catch(() => {});

    // ── 6. Editorial Pass (Opus) ───────────────────────────────────────
    currentStep = 'sp_editorial_pass';
    sendEvent({ type: 'progress', step: 'editorial_pass', message: 'Opus editorial review...' });

    const editorialUserMessage = `Here is the full section data for editorial review:\n\n${JSON.stringify(sectionData, null, 2)}\n\nProduct Brief:\n${JSON.stringify(productBrief, null, 2)}`;

    let editorialResponse;
    {
      const keepalive = setInterval(() => sendEvent({ type: 'keepalive' }), 25000);
      try {
        editorialResponse = await anthropicChat(
          [
            { role: 'system', content: EDITORIAL_PASS_PROMPT },
            { role: 'user', content: editorialUserMessage },
          ],
          'claude-opus-4-6',
          { operation: 'sp_editorial_pass', projectId, max_tokens: 12000, timeout: 270000 }
        );
      } finally {
        clearInterval(keepalive);
      }
    }

    const editorialResult = parseJSONResponse(editorialResponse);
    const finalSectionData = editorialResult.section_data || sectionData;
    const rawNotes = editorialResult.editorial_notes || '';
    const editorialNotes = typeof rawNotes === 'string' ? rawNotes : JSON.stringify(rawNotes, null, 2);

    // ── 7. Save to Convex ──────────────────────────────────────────────
    await updateSalesPage(pageId, {
      section_data: JSON.stringify(finalSectionData),
      editorial_notes: editorialNotes,
      status: 'completed',
      generation_model: 'claude-sonnet-4-6 + claude-opus-4-6',
    });

    // ── 8. Send complete event ─────────────────────────────────────────
    sendEvent({ type: 'complete', pageId, sectionCount: Object.keys(finalSectionData).length });
  } catch (err) {
    const message = `[${currentStep}] ${err.message}`;
    try {
      await updateSalesPage(pageId, { status: 'failed', error_message: message });
    } catch (_saveErr) {
      // Best-effort save; don't mask the original error
    }
    sendEvent({ type: 'error', message, error: message });
  }
}

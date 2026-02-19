/**
 * headlineGenerator.js — Direct response headline generation service
 *
 * Takes mined emotional quotes + 3 reference documents and generates
 * exactly 20 direct response headlines using Claude Sonnet 4.5.
 */

import { getAnthropicClient } from './quoteMiner.js';
import { getSetting } from '../convexClient.js';
import { withRetry } from './retry.js';

// ── Build the headline generation prompt ─────────────────────────────────────
function buildHeadlinePrompt(quotes, config, refDocs) {
  const { target_demographic, problem } = config;

  const quotesText = quotes
    .map((q, i) => `${i + 1}. "${q.quote}"`)
    .join('\n');

  let refSection = '';

  if (refDocs.engine) {
    refSection += `\n=== Reference Document 1: THE DIRECT RESPONSE HEADLINE ENGINE ===\n${refDocs.engine}\n`;
  }
  if (refDocs.greatest) {
    refSection += `\n=== Reference Document 2: 100 Greatest Headlines Ever Used ===\n${refDocs.greatest}\n`;
  }
  if (refDocs.swipe) {
    refSection += `\n=== Reference Document 3: 349 Great Headlines / Halbert Swipe File ===\n${refDocs.swipe}\n`;
  }

  return `${refSection}

=== Emotional Quotes from ${target_demographic} about ${problem} ===
${quotesText}

Using the reference documents above as your framework, create exactly 20 direct response headlines based on the emotional quotes.

Rules:
- Every headline must open a loop the reader can't ignore
- Prefer pain amplification, then mechanism-framing, then hope-teasing
- Use specificity (numbers, timeframes, body parts, emotions)
- Mirror the exact language from the quotes
- Avoid vague/generic phrasing
- Write headlines that could work as Facebook ad hooks, VSL openers, or email subject lines

Output: Return ONLY a valid JSON array of exactly 20 headline strings. No explanations, no numbering, no markdown code fences — just the raw JSON array.`;
}

// ── Main headline generation function ────────────────────────────────────────
export async function generateHeadlines(quotes, config, onProgress) {
  const startTime = Date.now();

  onProgress({ type: 'headline_start', message: 'Loading reference documents...' });

  // Load all 3 reference docs in parallel
  const [engine, greatest, swipe] = await Promise.all([
    getSetting('headline_ref_engine'),
    getSetting('headline_ref_greatest'),
    getSetting('headline_ref_swipe'),
  ]);

  const refDocs = { engine, greatest, swipe };
  const loadedCount = [engine, greatest, swipe].filter(Boolean).length;

  if (loadedCount === 0) {
    throw new Error('No headline reference documents found. Please upload at least one in Settings → Headline Generator Reference Docs.');
  }

  const docNames = [];
  if (engine) docNames.push('Headline Engine');
  if (greatest) docNames.push('100 Greatest Headlines');
  if (swipe) docNames.push('349 Headlines Swipe File');

  onProgress({
    type: 'headline_refs_loaded',
    message: `Loaded ${loadedCount}/3 reference docs (${docNames.join(', ')}). Generating headlines with Claude Sonnet 4.5...`,
  });

  // Build prompt
  const prompt = buildHeadlinePrompt(quotes, config, refDocs);

  // Call Claude Sonnet 4.5
  const client = await getAnthropicClient();

  const response = await withRetry(
    () => client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: 'You are an expert direct response copywriter. You generate powerful, scroll-stopping headlines that leverage emotional pain points and proven headline formulas. Always return output as a valid JSON array of strings.',
      messages: [
        { role: 'user', content: prompt }
      ],
    }),
    { label: '[Headline generation]' }
  );

  // Extract text from Claude's response
  let rawText = '';
  for (const block of response.content) {
    if (block.type === 'text') {
      rawText += block.text;
    }
  }

  // Parse headlines from response
  let headlines = [];
  try {
    // Try direct JSON parse first
    headlines = JSON.parse(rawText);
  } catch {
    // Try to extract JSON array from the response
    const match = rawText.match(/\[[\s\S]*\]/);
    if (match) {
      headlines = JSON.parse(match[0]);
    } else {
      // Fallback: split by newlines and clean up numbered lines
      headlines = rawText
        .split('\n')
        .map(line => line.replace(/^\d+[\.\)]\s*/, '').replace(/^["']|["']$/g, '').trim())
        .filter(line => line.length > 10);
    }
  }

  // Ensure all entries are strings
  headlines = headlines.filter(h => typeof h === 'string' && h.trim().length > 0);

  const durationMs = Date.now() - startTime;

  onProgress({
    type: 'headline_complete',
    message: `Generated ${headlines.length} headlines in ${Math.round(durationMs / 1000)}s.`,
    headlines,
    durationMs,
  });

  return { headlines, durationMs };
}

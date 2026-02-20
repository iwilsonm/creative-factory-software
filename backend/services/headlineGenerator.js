/**
 * headlineGenerator.js — Direct response headline generation service
 *
 * Two modes:
 * 1. generateHeadlines() — Legacy: 20 flat headlines from all quotes (for existing runs)
 * 2. generateHeadlinesPerQuote() — New: 3-5 headlines per individual quote (for quote bank)
 *
 * Both use Claude Sonnet 4.6 + 3 reference documents from settings.
 */

import { getAnthropicClient } from './quoteMiner.js';
import { getSetting } from '../convexClient.js';
import { withRetry } from './retry.js';

// ── Load reference documents (shared) ────────────────────────────────────────
async function loadRefDocs(onProgress) {
  onProgress({ type: 'headline_start', message: 'Loading reference documents...' });

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
    message: `Loaded ${loadedCount}/3 reference docs (${docNames.join(', ')}).`,
  });

  return refDocs;
}

// ── Build reference section (shared) ─────────────────────────────────────────
function buildRefSection(refDocs) {
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
  return refSection;
}

// ── Legacy: Build flat headline prompt ───────────────────────────────────────
function buildHeadlinePrompt(quotes, config, refDocs) {
  const { target_demographic, problem } = config;

  const quotesText = quotes
    .map((q, i) => `${i + 1}. "${q.quote}"`)
    .join('\n');

  return `${buildRefSection(refDocs)}

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

// ── New: Build per-quote headline prompt ─────────────────────────────────────
function buildPerQuotePrompt(quotes, config, refDocs) {
  const { target_demographic, problem } = config;

  const quotesText = quotes
    .map((q, i) => `[Q${i}] "${q.quote}" (emotion: ${q.emotion || 'unknown'})`)
    .join('\n');

  return `${buildRefSection(refDocs)}

=== Emotional Quotes from ${target_demographic} about ${problem} ===
${quotesText}

Using the reference documents above as your framework, generate 3-5 direct response headline variations for EACH quote listed above. Each headline should be specifically inspired by and connected to its source quote.

Rules:
- Every headline must open a loop the reader can't ignore
- Prefer pain amplification, then mechanism-framing, then hope-teasing
- Use specificity (numbers, timeframes, body parts, emotions)
- Mirror the exact language from each specific quote
- Use a DIFFERENT headline technique/structure for each variation within the same quote
- Label each headline with the technique name derived from the reference documents (e.g., "Curiosity Gap", "Problem-Agitate", "How-To", "Before-After", "Pain Amplification", "Mechanism Reveal", "Social Proof Hook", "Specificity Lead", "Direct Command", "Question Hook", "Fear of Missing Out", "Testimonial Frame", "Secret Reveal", "Contrarian Hook", "Story Open", etc.)
- Write headlines that could work as Facebook ad hooks, VSL openers, or email subject lines

Output: Return ONLY a valid JSON array of objects, no markdown code fences:
[
  { "quote_index": 0, "headlines": [{ "text": "The actual headline", "technique": "Curiosity Gap" }, { "text": "Another headline", "technique": "Pain Amplification" }] },
  { "quote_index": 1, "headlines": [{ "text": "Headline text", "technique": "Question Hook" }] },
  ...
]`;
}

// ── Legacy: Flat headline generation (for existing runs) ─────────────────────
export async function generateHeadlines(quotes, config, onProgress) {
  const startTime = Date.now();

  const refDocs = await loadRefDocs(onProgress);

  onProgress({
    type: 'headline_generating',
    message: `Generating 20 headlines with Claude Sonnet 4.6...`,
  });

  const prompt = buildHeadlinePrompt(quotes, config, refDocs);
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

  let rawText = '';
  for (const block of response.content) {
    if (block.type === 'text') rawText += block.text;
  }

  let headlines = [];
  try {
    headlines = JSON.parse(rawText);
  } catch {
    const match = rawText.match(/\[[\s\S]*\]/);
    if (match) {
      headlines = JSON.parse(match[0]);
    } else {
      headlines = rawText
        .split('\n')
        .map(line => line.replace(/^\d+[\.\)]\s*/, '').replace(/^["']|["']$/g, '').trim())
        .filter(line => line.length > 10);
    }
  }

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

// ── New: Per-quote headline generation (for quote bank) ──────────────────────
export async function generateHeadlinesPerQuote(quotes, config, onProgress) {
  const startTime = Date.now();

  const refDocs = await loadRefDocs(onProgress);

  const client = await getAnthropicClient();

  // Batch quotes into groups of 10 to manage token limits
  const BATCH_SIZE = 10;
  const allResults = []; // { quote_index, headlines }[]

  for (let batchStart = 0; batchStart < quotes.length; batchStart += BATCH_SIZE) {
    const batch = quotes.slice(batchStart, batchStart + BATCH_SIZE);
    const batchNum = Math.floor(batchStart / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(quotes.length / BATCH_SIZE);

    onProgress({
      type: 'headline_generating',
      message: `Generating headlines for quotes ${batchStart + 1}-${batchStart + batch.length} (batch ${batchNum}/${totalBatches})...`,
    });

    const prompt = buildPerQuotePrompt(batch, config, refDocs);

    const response = await withRetry(
      () => client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 16000,
        system: 'You are an expert direct response copywriter. For each quote provided, generate 3-5 powerful, scroll-stopping headline variations. Each headline must include a "text" field and a "technique" field naming the headline technique used. Always return output as a valid JSON array of objects.',
        messages: [
          { role: 'user', content: prompt }
        ],
      }),
      { label: `[Per-quote headlines batch ${batchNum}]` }
    );

    let rawText = '';
    for (const block of response.content) {
      if (block.type === 'text') rawText += block.text;
    }

    // Parse response
    let batchResults = [];
    try {
      batchResults = JSON.parse(rawText);
    } catch {
      const match = rawText.match(/\[[\s\S]*\]/);
      if (match) {
        batchResults = JSON.parse(match[0]);
      }
    }

    if (!Array.isArray(batchResults)) batchResults = [];

    // Map batch-local indices back to global indices
    for (const result of batchResults) {
      if (result && typeof result.quote_index === 'number' && Array.isArray(result.headlines)) {
        allResults.push({
          quote_index: batchStart + result.quote_index,
          headlines: result.headlines
            .map(h => {
              if (typeof h === 'string') return { text: h, technique: 'unknown' };
              if (h && typeof h.text === 'string') return { text: h.text, technique: h.technique || 'unknown' };
              return null;
            })
            .filter(h => h !== null && h.text.trim().length > 0),
        });
      }
    }

    onProgress({
      type: 'headline_batch_complete',
      message: `Batch ${batchNum}/${totalBatches} complete — ${batchResults.length} quotes processed.`,
      batchNum,
      totalBatches,
    });
  }

  const durationMs = Date.now() - startTime;
  const totalHeadlines = allResults.reduce((sum, r) => sum + r.headlines.length, 0);

  onProgress({
    type: 'headline_complete',
    message: `Generated ${totalHeadlines} headlines across ${allResults.length} quotes in ${Math.round(durationMs / 1000)}s.`,
    results: allResults,
    durationMs,
  });

  return { results: allResults, durationMs };
}

// ── Generate MORE headlines for a single quote (excluding already-used techniques) ─
export async function generateMoreHeadlinesForQuote(quote, config, existingTechniques, onProgress) {
  const startTime = Date.now();

  const refDocs = await loadRefDocs(onProgress);
  const client = await getAnthropicClient();

  const { target_demographic, problem } = config;

  const excludeStr = existingTechniques.length > 0
    ? `\n\nTechniques ALREADY USED for this quote (DO NOT repeat any of these): ${existingTechniques.join(', ')}`
    : '';

  const prompt = `${buildRefSection(refDocs)}

=== Emotional Quote from ${target_demographic} about ${problem} ===
"${quote.quote}" (emotion: ${quote.emotion || 'unknown'})
${excludeStr}

Generate 3-5 NEW direct response headline variations for this quote using DIFFERENT techniques than any listed above.

Rules:
- Every headline must open a loop the reader can't ignore
- Prefer pain amplification, then mechanism-framing, then hope-teasing
- Use specificity (numbers, timeframes, body parts, emotions)
- Mirror the exact language from the quote
- Use a DIFFERENT headline technique for each variation
- Label each headline with the technique name (e.g., "Curiosity Gap", "Problem-Agitate", "How-To", "Before-After", "Pain Amplification", "Mechanism Reveal", "Social Proof Hook", "Specificity Lead", "Direct Command", "Question Hook", "Fear of Missing Out", "Testimonial Frame", "Secret Reveal", "Contrarian Hook", "Story Open", etc.)
- Write headlines that could work as Facebook ad hooks, VSL openers, or email subject lines

Output: Return ONLY a valid JSON array, no markdown code fences:
[
  { "text": "The headline text", "technique": "Technique Name" },
  ...
]`;

  onProgress({
    type: 'headline_generating',
    message: 'Generating additional headlines...',
  });

  const response = await withRetry(
    () => client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: 'You are an expert direct response copywriter. Generate powerful, scroll-stopping headlines using varied techniques. Each headline must include a "text" field and a "technique" field. Always return output as a valid JSON array of objects.',
      messages: [{ role: 'user', content: prompt }],
    }),
    { label: '[Generate more headlines]' }
  );

  let rawText = '';
  for (const block of response.content) {
    if (block.type === 'text') rawText += block.text;
  }

  let headlines = [];
  try {
    headlines = JSON.parse(rawText);
  } catch {
    const match = rawText.match(/\[[\s\S]*\]/);
    if (match) headlines = JSON.parse(match[0]);
  }

  // Normalize and filter
  headlines = (Array.isArray(headlines) ? headlines : [])
    .map(h => {
      if (typeof h === 'string') return { text: h, technique: 'unknown' };
      if (h && typeof h.text === 'string') return { text: h.text, technique: h.technique || 'unknown' };
      return null;
    })
    .filter(h => h !== null && h.text.trim().length > 0);

  const durationMs = Date.now() - startTime;

  onProgress({
    type: 'headline_complete',
    message: `Generated ${headlines.length} additional headlines in ${Math.round(durationMs / 1000)}s.`,
    headlines,
    durationMs,
  });

  return { headlines, durationMs };
}

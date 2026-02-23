/**
 * quoteDedup.js — Cross-reference new quotes against quote bank using GPT-4.1-mini
 *
 * After each mining run completes, this service:
 * 1. Fetches existing bank quotes for the project
 * 2. Uses GPT-4.1-mini to identify duplicates
 * 3. Bulk-inserts only genuinely new quotes into the bank
 */

import { v4 as uuidv4 } from 'uuid';
import { chat } from './openai.js';
import { getQuoteBankByProject } from '../convexClient.js';
import { convexClient, api } from '../convexClient.js';

/**
 * Deduplicate new quotes against existing bank and insert unique ones.
 * @param {string} projectId
 * @param {string} runId - The mining run that produced these quotes
 * @param {Array} newQuotes - Array of quote objects from the mining run
 * @param {string} [problem] - The problem/angle from the mining run (denormalized)
 * @returns {{ added: number, duplicates: number, total: number }}
 */
export async function deduplicateAndAddToBank(projectId, runId, newQuotes, problem) {
  if (!newQuotes || newQuotes.length === 0) {
    return { added: 0, duplicates: 0, total: 0 };
  }

  // Fetch existing bank quotes
  const existingQuotes = await getQuoteBankByProject(projectId);

  // If bank is empty, all quotes are new — bulk insert
  if (existingQuotes.length === 0) {
    const quoteDocs = newQuotes.map(q => ({
      externalId: uuidv4(),
      project_id: projectId,
      quote: q.quote,
      source: q.source || undefined,
      source_url: q.source_url || undefined,
      emotion: q.emotion || undefined,
      emotional_intensity: q.emotional_intensity || undefined,
      context: q.context || undefined,
      run_id: runId,
      ...(problem ? { problem } : {}),
      created_at: new Date().toISOString(),
    }));

    await convexClient.mutation(api.quote_bank.bulkCreate, {
      quotes: JSON.stringify(quoteDocs),
    });

    return { added: quoteDocs.length, duplicates: 0, total: newQuotes.length };
  }

  // Use GPT-4.1-mini to identify duplicates
  const uniqueIndices = await findUniqueQuotes(existingQuotes, newQuotes);

  if (uniqueIndices.length === 0) {
    return { added: 0, duplicates: newQuotes.length, total: newQuotes.length };
  }

  // Build docs for unique quotes only
  const quoteDocs = uniqueIndices.map(idx => ({
    externalId: uuidv4(),
    project_id: projectId,
    quote: newQuotes[idx].quote,
    source: newQuotes[idx].source || undefined,
    source_url: newQuotes[idx].source_url || undefined,
    emotion: newQuotes[idx].emotion || undefined,
    emotional_intensity: newQuotes[idx].emotional_intensity || undefined,
    context: newQuotes[idx].context || undefined,
    run_id: runId,
    ...(problem ? { problem } : {}),
    created_at: new Date().toISOString(),
  }));

  await convexClient.mutation(api.quote_bank.bulkCreate, {
    quotes: JSON.stringify(quoteDocs),
  });

  return {
    added: quoteDocs.length,
    duplicates: newQuotes.length - quoteDocs.length,
    total: newQuotes.length,
  };
}

/**
 * Use GPT-4.1-mini to find which new quotes are genuinely unique.
 * For large banks, batches existing quotes into groups of 50.
 */
async function findUniqueQuotes(existingQuotes, newQuotes) {
  // Build existing quotes text (just the quote text for comparison)
  const existingTexts = existingQuotes.map((q, i) => `[E${i}] "${q.quote}"`);
  const newTexts = newQuotes.map((q, i) => `[N${i}] "${q.quote}"`);

  // For large banks, batch to avoid token limits
  const BATCH_SIZE = 60;
  let allDuplicateIndices = new Set();

  for (let batchStart = 0; batchStart < existingTexts.length; batchStart += BATCH_SIZE) {
    const batchExisting = existingTexts.slice(batchStart, batchStart + BATCH_SIZE);

    const prompt = `You are a deduplication assistant. Compare the NEW quotes against the EXISTING quotes below. Two quotes are "duplicates" if they express the same core idea in very similar wording (minor differences in punctuation, spelling, or a few words are still duplicates). Completely different quotes that happen to share a topic are NOT duplicates.

EXISTING QUOTES:
${batchExisting.join('\n')}

NEW QUOTES:
${newTexts.join('\n')}

Return a JSON object: { "duplicate_new_indices": [list of N-indices that are duplicates of existing quotes] }

If all new quotes are unique, return: { "duplicate_new_indices": [] }
Return ONLY valid JSON, no explanation.`;

    const result = await chat(
      [{ role: 'user', content: prompt }],
      'gpt-4.1-mini',
      { response_format: { type: 'json_object' }, operation: 'quote_deduplication' }
    );

    try {
      const parsed = JSON.parse(result);
      const dupIndices = parsed.duplicate_new_indices || [];
      for (const idx of dupIndices) {
        if (typeof idx === 'number' && idx >= 0 && idx < newQuotes.length) {
          allDuplicateIndices.add(idx);
        }
      }
    } catch (err) {
      console.warn('[QuoteDedup] Failed to parse GPT response, treating all as unique:', err.message);
    }
  }

  // Return indices of quotes that are NOT duplicates
  const uniqueIndices = [];
  for (let i = 0; i < newQuotes.length; i++) {
    if (!allDuplicateIndices.has(i)) {
      uniqueIndices.push(i);
    }
  }

  return uniqueIndices;
}

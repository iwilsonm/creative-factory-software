/**
 * Quote bank service — orchestrates quote mining runs, headline generation,
 * and bank import operations.
 *
 * Extracted from routes/quoteMining.js to keep route handlers thin.
 */

import { v4 as uuidv4 } from 'uuid';
import { getQuoteMiningRun, getQuoteMiningRunsByProject, getQuoteBankByProject, getQuoteBankQuote, updateQuoteBankQuote, backfillQuoteBankProblems } from '../convexClient.js';
import { convexClient, api } from '../convexClient.js';
import { runQuoteMining } from './quoteMiner.js';
import { generateHeadlines, generateHeadlinesPerQuote, generateMoreHeadlinesForQuote } from './headlineGenerator.js';
import { deduplicateAndAddToBank } from './quoteDedup.js';

/**
 * Execute a quote mining run: create the run record, call the mining service,
 * save results, and auto-import to bank.
 *
 * @param {string} projectId
 * @param {object} params - { target_demographic, problem, root_cause, keywords, subreddits, forums, facebook_groups, num_quotes }
 * @param {(event: object) => void} sendEvent - SSE event emitter
 */
export async function executeMiningRun(projectId, params, sendEvent) {
  const { target_demographic, problem, root_cause, keywords, subreddits, forums, facebook_groups, num_quotes } = params;

  // Create the run record
  const runId = uuidv4();
  await convexClient.mutation(api.quote_mining_runs.create, {
    externalId: runId,
    project_id: projectId,
    status: 'running',
    target_demographic,
    problem,
    root_cause: root_cause || undefined,
    keywords: JSON.stringify(keywords),
    subreddits: subreddits?.length ? JSON.stringify(subreddits) : undefined,
    forums: forums?.length ? JSON.stringify(forums) : undefined,
    facebook_groups: facebook_groups?.length ? JSON.stringify(facebook_groups) : undefined,
    num_quotes: num_quotes || 20,
    created_at: new Date().toISOString(),
  });

  sendEvent({ type: 'run_created', runId });

  const config = {
    target_demographic,
    problem,
    root_cause: root_cause || null,
    keywords: JSON.stringify(keywords),
    subreddits: subreddits?.length ? JSON.stringify(subreddits) : null,
    forums: forums?.length ? JSON.stringify(forums) : null,
    facebook_groups: facebook_groups?.length ? JSON.stringify(facebook_groups) : null,
    num_quotes: num_quotes || 20,
  };

  try {
    const result = await runQuoteMining(config, sendEvent);

    // Save results to Convex
    await convexClient.mutation(api.quote_mining_runs.update, {
      externalId: runId,
      status: 'completed',
      quotes: JSON.stringify(result.quotes),
      perplexity_raw: result.perplexityRaw || '',
      claude_raw: result.claudeRaw || '',
      sources_used: JSON.stringify(result.sourcesUsed),
      quote_count: result.quotes.length,
      duration_ms: result.durationMs,
      completed_at: new Date().toISOString(),
    });

    sendEvent({ type: 'saved', runId, quoteCount: result.quotes.length });

    // Auto-add unique quotes to the quote bank (non-fatal)
    try {
      sendEvent({ type: 'bank_dedup_start', message: 'Cross-referencing with quote bank...' });
      const bankResult = await deduplicateAndAddToBank(projectId, runId, result.quotes, problem);
      sendEvent({
        type: 'bank_updated',
        message: `Added ${bankResult.added} new quotes to bank (${bankResult.duplicates} duplicates skipped).`,
        added: bankResult.added,
        duplicates: bankResult.duplicates,
      });
    } catch (bankErr) {
      console.warn('[QuoteMining] Bank dedup failed:', bankErr.message);
      sendEvent({ type: 'bank_error', message: `Bank update failed: ${bankErr.message}` });
    }
  } catch (err) {
    console.error('[QuoteMining] Run failed:', err);

    // Save error status
    try {
      await convexClient.mutation(api.quote_mining_runs.update, {
        externalId: runId,
        status: 'failed',
        error_message: err.message,
        completed_at: new Date().toISOString(),
      });
    } catch { /* ignore save error */ }

    throw err;
  }
}

/**
 * Generate headlines for a mining run's quotes and save them.
 */
export async function generateRunHeadlines(runId, projectId, sendEvent) {
  const run = await getQuoteMiningRun(runId);
  if (!run || run.project_id !== projectId) {
    throw Object.assign(new Error('Quote mining run not found'), { status: 404 });
  }
  if (!run.quotes) {
    throw Object.assign(new Error('This run has no quotes. Mine quotes first.'), { status: 400 });
  }

  const quotes = typeof run.quotes === 'string' ? JSON.parse(run.quotes) : run.quotes;
  if (!Array.isArray(quotes) || quotes.length === 0) {
    throw Object.assign(new Error('No quotes found in this run.'), { status: 400 });
  }

  const result = await generateHeadlines(quotes, {
    target_demographic: run.target_demographic,
    problem: run.problem,
  }, sendEvent);

  // Save headlines to the run record
  await convexClient.mutation(api.quote_mining_runs.update, {
    externalId: runId,
    headlines: JSON.stringify(result.headlines),
    headlines_generated_at: new Date().toISOString(),
  });

  sendEvent({ type: 'headlines_saved', headlineCount: result.headlines.length });
}

/**
 * Generate headlines for bank quotes and save to each quote record.
 */
export async function generateBankHeadlines(projectId, quoteIds, context, sendEvent) {
  let bankQuotes = await getQuoteBankByProject(projectId);
  if (quoteIds && Array.isArray(quoteIds) && quoteIds.length > 0) {
    bankQuotes = bankQuotes.filter(q => quoteIds.includes(q.id));
  } else {
    // Default: only generate for quotes without headlines
    const withoutHeadlines = bankQuotes.filter(q => !q.headlines);
    if (withoutHeadlines.length > 0) {
      bankQuotes = withoutHeadlines;
    }
    // If all have headlines, regenerate all (user clicked "Regenerate All")
  }

  if (bankQuotes.length === 0) {
    throw Object.assign(new Error('No quotes in bank to generate headlines for.'), { status: 400 });
  }

  const result = await generateHeadlinesPerQuote(bankQuotes, {
    target_demographic: context.target_demographic,
    problem: context.problem,
  }, sendEvent);

  // Save headlines to each bank quote record
  let savedCount = 0;
  for (const item of result.results) {
    if (item.quote_index >= 0 && item.quote_index < bankQuotes.length && item.headlines.length > 0) {
      try {
        await updateQuoteBankQuote(bankQuotes[item.quote_index].id, {
          headlines: JSON.stringify(item.headlines),
          headlines_generated_at: new Date().toISOString(),
        });
        savedCount++;
      } catch (saveErr) {
        console.warn(`[BankHeadlines] Failed to save headlines for quote ${bankQuotes[item.quote_index].id}:`, saveErr.message);
      }
    }
  }

  sendEvent({
    type: 'headlines_saved',
    message: `Saved headlines for ${savedCount} quotes.`,
    savedCount,
    results: result.results,
  });
}

/**
 * Generate additional headlines for a single quote, merging with existing ones.
 */
export async function generateMoreForQuote(quoteId, projectId, context, sendEvent) {
  const quote = await getQuoteBankQuote(quoteId);
  if (!quote || quote.project_id !== projectId) {
    throw Object.assign(new Error('Quote not found in bank'), { status: 404 });
  }

  // Parse existing headlines and extract used techniques
  let existingHeadlines = [];
  if (quote.headlines) {
    try {
      const parsed = JSON.parse(quote.headlines);
      existingHeadlines = (Array.isArray(parsed) ? parsed : []).map(h => {
        if (typeof h === 'string') return { text: h, technique: 'unknown' };
        return { text: h.text || h, technique: h.technique || 'unknown' };
      });
    } catch { /* ignore */ }
  }
  const usedTechniques = existingHeadlines
    .map(h => h.technique)
    .filter(t => t && t !== 'unknown');

  const result = await generateMoreHeadlinesForQuote(quote, {
    target_demographic: context.target_demographic,
    problem: context.problem,
  }, usedTechniques, sendEvent);

  // Merge: append new headlines to existing ones
  const merged = [...existingHeadlines, ...result.headlines];
  await updateQuoteBankQuote(quoteId, {
    headlines: JSON.stringify(merged),
    headlines_generated_at: new Date().toISOString(),
  });

  sendEvent({
    type: 'headlines_saved',
    message: `Added ${result.headlines.length} new headlines (${merged.length} total).`,
    newCount: result.headlines.length,
    totalCount: merged.length,
  });
}

/**
 * Import all completed runs' quotes into the quote bank.
 */
export async function importAllRunsToBank(projectId) {
  const runs = await getQuoteMiningRunsByProject(projectId);
  const completedRuns = runs.filter(r => r.status === 'completed' && r.quotes);

  if (completedRuns.length === 0) {
    throw Object.assign(new Error('No completed runs with quotes to import.'), { status: 400 });
  }

  let totalAdded = 0;
  let totalDuplicates = 0;
  const results = [];

  for (const run of completedRuns) {
    try {
      const quotes = typeof run.quotes === 'string' ? JSON.parse(run.quotes) : run.quotes;
      if (!Array.isArray(quotes) || quotes.length === 0) continue;

      const bankResult = await deduplicateAndAddToBank(projectId, run.id, quotes, run.problem);
      totalAdded += bankResult.added;
      totalDuplicates += bankResult.duplicates;
      results.push({ runId: run.id, added: bankResult.added, duplicates: bankResult.duplicates });
    } catch (runErr) {
      console.warn(`[QuoteMining] Failed to import run ${run.id}:`, runErr.message);
      results.push({ runId: run.id, error: runErr.message });
    }
  }

  return {
    runs_processed: results.length,
    total_added: totalAdded,
    total_duplicates: totalDuplicates,
    details: results,
  };
}

/**
 * Backfill the `problem` field on bank quotes that are missing it,
 * using the problem from their source mining run.
 */
export async function backfillProblems(projectId) {
  const bankQuotes = await getQuoteBankByProject(projectId);
  const missingProblem = bankQuotes.filter(q => !q.problem);

  if (missingProblem.length === 0) {
    return { updated: 0, message: 'All quotes already have problem labels.' };
  }

  // Build run_id → problem map
  const runs = await getQuoteMiningRunsByProject(projectId);
  const runProblemMap = {};
  for (const run of runs) {
    if (run.problem) runProblemMap[run.id] = run.problem;
  }

  const updates = [];
  for (const q of missingProblem) {
    const problem = runProblemMap[q.run_id];
    if (problem) {
      updates.push({ externalId: q.id, problem });
    }
  }

  if (updates.length === 0) {
    return { updated: 0, message: 'No matching runs found for quotes.' };
  }

  // Batch in groups of 50
  let totalPatched = 0;
  for (let i = 0; i < updates.length; i += 50) {
    const batch = updates.slice(i, i + 50);
    const result = await backfillQuoteBankProblems(batch);
    totalPatched += result.patched || 0;
  }

  return { updated: totalPatched };
}

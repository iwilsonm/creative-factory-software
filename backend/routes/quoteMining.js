import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth } from '../auth.js';
import { getProject, getQuoteMiningRunsByProject, getQuoteMiningRun, getQuoteBankByProject, getQuoteBankQuote, updateQuoteBankQuote, deleteQuoteBankQuote, getAdsWithSourceQuote, backfillQuoteBankProblems } from '../convexClient.js';
import { convexClient, api } from '../convexClient.js';
import { runQuoteMining, generateSuggestions } from '../services/quoteMiner.js';
import { generateHeadlines, generateHeadlinesPerQuote } from '../services/headlineGenerator.js';
import { deduplicateAndAddToBank } from '../services/quoteDedup.js';
import { generateBodyCopy } from '../services/bodyCopyGenerator.js';

const router = Router();
router.use(requireAuth);

// ── List past runs for a project ──────────────────────────────────────────────
router.get('/:projectId/quote-mining', async (req, res) => {
  try {
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const runs = await getQuoteMiningRunsByProject(req.params.projectId);
    // Sort newest first
    runs.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json({ runs });
  } catch (err) {
    console.error('Failed to list quote mining runs:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Get single run with full results ──────────────────────────────────────────
router.get('/:projectId/quote-mining/:runId', async (req, res) => {
  try {
    const run = await getQuoteMiningRun(req.params.runId);
    if (!run || run.project_id !== req.params.projectId) {
      return res.status(404).json({ error: 'Quote mining run not found' });
    }
    res.json(run);
  } catch (err) {
    console.error('Failed to get quote mining run:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Auto-suggest keywords, subreddits, forums, facebook groups ───────────────
router.post('/:projectId/quote-mining/suggestions', async (req, res) => {
  try {
    const { target_demographic, problem } = req.body;
    if (!target_demographic || !problem) {
      return res.status(400).json({ error: 'target_demographic and problem are required' });
    }
    const suggestions = await generateSuggestions(target_demographic, problem);
    res.json(suggestions);
  } catch (err) {
    console.error('Failed to generate suggestions:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Start a new mining run (SSE stream) ───────────────────────────────────────
router.post('/:projectId/quote-mining', async (req, res) => {
  try {
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { target_demographic, problem, root_cause, keywords, subreddits, forums, facebook_groups, num_quotes } = req.body;

    if (!target_demographic || !problem || !keywords || !Array.isArray(keywords) || keywords.length === 0) {
      return res.status(400).json({ error: 'target_demographic, problem, and keywords (array) are required' });
    }

    // Create the run record
    const runId = uuidv4();
    await convexClient.mutation(api.quote_mining_runs.create, {
      externalId: runId,
      project_id: req.params.projectId,
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

    // Disable timeout (mining can take 2-3 minutes)
    req.setTimeout(0);
    res.setTimeout(0);

    // Set up SSE
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    const keepalive = setInterval(() => {
      if (!closed) res.write(': keepalive\n\n');
    }, 30000);

    const sendEvent = (event) => {
      if (!closed) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    let closed = false;
    req.on('close', () => {
      closed = true;
      clearInterval(keepalive);
    });

    // Send the run ID immediately so frontend can track it
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

    runQuoteMining(config, (event) => {
      sendEvent(event);
    }).then(async (result) => {
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
        const bankResult = await deduplicateAndAddToBank(
          req.params.projectId, runId, result.quotes, problem
        );
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

      clearInterval(keepalive);
      if (!closed) {
        res.write('data: [DONE]\n\n');
        res.end();
      }
    }).catch(async (err) => {
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

      clearInterval(keepalive);
      if (!closed) {
        sendEvent({ type: 'error', message: err.message });
        res.write('data: [DONE]\n\n');
        res.end();
      }
    });
  } catch (err) {
    console.error('Failed to start quote mining:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

// ── Delete a run ──────────────────────────────────────────────────────────────
router.delete('/:projectId/quote-mining/:runId', async (req, res) => {
  try {
    const run = await getQuoteMiningRun(req.params.runId);
    if (!run || run.project_id !== req.params.projectId) {
      return res.status(404).json({ error: 'Quote mining run not found' });
    }
    await convexClient.mutation(api.quote_mining_runs.remove, { externalId: req.params.runId });
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to delete quote mining run:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Import quotes from a past run into the quote bank ─────────────────────────
router.post('/:projectId/quote-mining/:runId/add-to-bank', async (req, res) => {
  try {
    const run = await getQuoteMiningRun(req.params.runId);
    if (!run || run.project_id !== req.params.projectId) {
      return res.status(404).json({ error: 'Quote mining run not found' });
    }

    if (!run.quotes) {
      return res.status(400).json({ error: 'This run has no quotes.' });
    }

    const quotes = typeof run.quotes === 'string' ? JSON.parse(run.quotes) : run.quotes;
    if (!Array.isArray(quotes) || quotes.length === 0) {
      return res.status(400).json({ error: 'No quotes found in this run.' });
    }

    const bankResult = await deduplicateAndAddToBank(
      req.params.projectId, req.params.runId, quotes, run.problem
    );

    res.json({
      success: true,
      added: bankResult.added,
      duplicates: bankResult.duplicates,
      total: bankResult.total,
    });
  } catch (err) {
    console.error('Failed to add run quotes to bank:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Bulk import all past runs into the quote bank ─────────────────────────────
router.post('/:projectId/quote-mining/import-all', async (req, res) => {
  try {
    const runs = await getQuoteMiningRunsByProject(req.params.projectId);
    const completedRuns = runs.filter(r => r.status === 'completed' && r.quotes);

    if (completedRuns.length === 0) {
      return res.status(400).json({ error: 'No completed runs with quotes to import.' });
    }

    let totalAdded = 0;
    let totalDuplicates = 0;
    const results = [];

    for (const run of completedRuns) {
      try {
        const quotes = typeof run.quotes === 'string' ? JSON.parse(run.quotes) : run.quotes;
        if (!Array.isArray(quotes) || quotes.length === 0) continue;

        const bankResult = await deduplicateAndAddToBank(
          req.params.projectId, run.id, quotes, run.problem
        );
        totalAdded += bankResult.added;
        totalDuplicates += bankResult.duplicates;
        results.push({ runId: run.id, added: bankResult.added, duplicates: bankResult.duplicates });
      } catch (runErr) {
        console.warn(`[QuoteMining] Failed to import run ${run.id}:`, runErr.message);
        results.push({ runId: run.id, error: runErr.message });
      }
    }

    res.json({
      success: true,
      runs_processed: results.length,
      total_added: totalAdded,
      total_duplicates: totalDuplicates,
      details: results,
    });
  } catch (err) {
    console.error('Failed to bulk import runs to bank:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Generate headlines from a run's quotes — Legacy (SSE stream) ─────────────
router.post('/:projectId/quote-mining/:runId/headlines', async (req, res) => {
  try {
    const run = await getQuoteMiningRun(req.params.runId);
    if (!run || run.project_id !== req.params.projectId) {
      return res.status(404).json({ error: 'Quote mining run not found' });
    }

    if (!run.quotes) {
      return res.status(400).json({ error: 'This run has no quotes. Mine quotes first.' });
    }

    const quotes = typeof run.quotes === 'string' ? JSON.parse(run.quotes) : run.quotes;
    if (!Array.isArray(quotes) || quotes.length === 0) {
      return res.status(400).json({ error: 'No quotes found in this run.' });
    }

    // Disable timeout (headline generation can take 30-60s)
    req.setTimeout(0);
    res.setTimeout(0);

    // Set up SSE
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    const keepalive = setInterval(() => {
      if (!closed) res.write(': keepalive\n\n');
    }, 30000);

    const sendEvent = (event) => {
      if (!closed) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    let closed = false;
    req.on('close', () => {
      closed = true;
      clearInterval(keepalive);
    });

    generateHeadlines(quotes, {
      target_demographic: run.target_demographic,
      problem: run.problem,
    }, (event) => {
      sendEvent(event);
    }).then(async (result) => {
      // Save headlines to the run record
      await convexClient.mutation(api.quote_mining_runs.update, {
        externalId: req.params.runId,
        headlines: JSON.stringify(result.headlines),
        headlines_generated_at: new Date().toISOString(),
      });

      clearInterval(keepalive);
      if (!closed) {
        sendEvent({ type: 'headlines_saved', headlineCount: result.headlines.length });
        res.write('data: [DONE]\n\n');
        res.end();
      }
    }).catch(async (err) => {
      console.error('[Headlines] Generation failed:', err);

      clearInterval(keepalive);
      if (!closed) {
        sendEvent({ type: 'error', message: err.message });
        res.write('data: [DONE]\n\n');
        res.end();
      }
    });
  } catch (err) {
    console.error('Failed to start headline generation:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

// ════════════════════════════════════════════════════════════════════════════════
// QUOTE BANK ENDPOINTS
// ════════════════════════════════════════════════════════════════════════════════

// ── List all bank quotes for a project ───────────────────────────────────────
router.get('/:projectId/quote-bank', async (req, res) => {
  try {
    const quotes = await getQuoteBankByProject(req.params.projectId);
    // Sort newest first
    quotes.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    res.json({ quotes });
  } catch (err) {
    console.error('Failed to list quote bank:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Toggle favorite ──────────────────────────────────────────────────────────
router.patch('/:projectId/quote-bank/:quoteId/favorite', async (req, res) => {
  try {
    const quote = await getQuoteBankQuote(req.params.quoteId);
    if (!quote || quote.project_id !== req.params.projectId) {
      return res.status(404).json({ error: 'Quote not found in bank' });
    }
    await updateQuoteBankQuote(req.params.quoteId, {
      is_favorite: !quote.is_favorite,
    });
    res.json({ success: true, is_favorite: !quote.is_favorite });
  } catch (err) {
    console.error('Failed to toggle favorite:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Delete a bank quote ──────────────────────────────────────────────────────
router.delete('/:projectId/quote-bank/:quoteId', async (req, res) => {
  try {
    const quote = await getQuoteBankQuote(req.params.quoteId);
    if (!quote || quote.project_id !== req.params.projectId) {
      return res.status(404).json({ error: 'Quote not found in bank' });
    }
    await deleteQuoteBankQuote(req.params.quoteId);
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to delete bank quote:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Generate headlines for bank quotes (SSE stream) ──────────────────────────
router.post('/:projectId/quote-bank/headlines', async (req, res) => {
  try {
    const { quote_ids, target_demographic, problem } = req.body;
    if (!target_demographic || !problem) {
      return res.status(400).json({ error: 'target_demographic and problem are required' });
    }

    // Load bank quotes
    let bankQuotes = await getQuoteBankByProject(req.params.projectId);
    if (quote_ids && Array.isArray(quote_ids) && quote_ids.length > 0) {
      bankQuotes = bankQuotes.filter(q => quote_ids.includes(q.id));
    } else {
      // Default: only generate for quotes that don't have headlines yet
      const withoutHeadlines = bankQuotes.filter(q => !q.headlines);
      if (withoutHeadlines.length > 0) {
        bankQuotes = withoutHeadlines;
      }
      // If all have headlines, regenerate all (user clicked "Regenerate All")
    }

    if (bankQuotes.length === 0) {
      return res.status(400).json({ error: 'No quotes in bank to generate headlines for.' });
    }

    // Disable timeout
    req.setTimeout(0);
    res.setTimeout(0);

    // Set up SSE
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    const keepalive = setInterval(() => {
      if (!closed) res.write(': keepalive\n\n');
    }, 30000);

    const sendEvent = (event) => {
      if (!closed) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    let closed = false;
    req.on('close', () => {
      closed = true;
      clearInterval(keepalive);
    });

    generateHeadlinesPerQuote(bankQuotes, {
      target_demographic,
      problem,
    }, (event) => {
      sendEvent(event);
    }).then(async (result) => {
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

      clearInterval(keepalive);
      if (!closed) {
        sendEvent({
          type: 'headlines_saved',
          message: `Saved headlines for ${savedCount} quotes.`,
          savedCount,
          results: result.results,
        });
        res.write('data: [DONE]\n\n');
        res.end();
      }
    }).catch(async (err) => {
      console.error('[BankHeadlines] Generation failed:', err);

      clearInterval(keepalive);
      if (!closed) {
        sendEvent({ type: 'error', message: err.message });
        res.write('data: [DONE]\n\n');
        res.end();
      }
    });
  } catch (err) {
    console.error('Failed to start bank headline generation:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

// ── Generate body copy for a headline + quote ────────────────────────────────
router.post('/:projectId/quote-bank/:quoteId/body-copy', async (req, res) => {
  try {
    const { headline, target_demographic, problem } = req.body;
    if (!headline) {
      return res.status(400).json({ error: 'headline is required' });
    }

    const quote = await getQuoteBankQuote(req.params.quoteId);
    if (!quote || quote.project_id !== req.params.projectId) {
      return res.status(404).json({ error: 'Quote not found in bank' });
    }

    const bodyCopy = await generateBodyCopy(headline, quote, target_demographic || '', problem || '');
    res.json({ body_copy: bodyCopy });
  } catch (err) {
    console.error('Failed to generate body copy:', err);
    res.status(500).json({ error: err.message });
  }
});

// Quote Bank usage — which headlines have been turned into ads
router.get('/:projectId/quote-bank/usage', async (req, res) => {
  try {
    const ads = await getAdsWithSourceQuote(req.params.projectId);
    // Build a map: quoteId → [headline1, headline2, ...]
    const usedHeadlines = {};
    for (const ad of ads) {
      if (ad.source_quote_id && ad.headline) {
        if (!usedHeadlines[ad.source_quote_id]) {
          usedHeadlines[ad.source_quote_id] = [];
        }
        if (!usedHeadlines[ad.source_quote_id].includes(ad.headline)) {
          usedHeadlines[ad.source_quote_id].push(ad.headline);
        }
      }
    }
    res.json({ usedHeadlines, totalAds: ads.length });
  } catch (err) {
    console.error('Failed to get quote bank usage:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Backfill problem field on existing bank quotes ────────────────────────────
router.post('/:projectId/quote-bank/backfill-problems', async (req, res) => {
  try {
    const bankQuotes = await getQuoteBankByProject(req.params.projectId);
    const missingProblem = bankQuotes.filter(q => !q.problem);

    if (missingProblem.length === 0) {
      return res.json({ success: true, updated: 0, message: 'All quotes already have problem labels.' });
    }

    // Load all runs to build run_id → problem map
    const runs = await getQuoteMiningRunsByProject(req.params.projectId);
    const runProblemMap = {};
    for (const run of runs) {
      if (run.problem) runProblemMap[run.id] = run.problem;
    }

    // Build updates
    const updates = [];
    for (const q of missingProblem) {
      const problem = runProblemMap[q.run_id];
      if (problem) {
        updates.push({ externalId: q.id, problem });
      }
    }

    if (updates.length === 0) {
      return res.json({ success: true, updated: 0, message: 'No matching runs found for quotes.' });
    }

    // Batch in groups of 50 (Convex mutation limits)
    let totalPatched = 0;
    for (let i = 0; i < updates.length; i += 50) {
      const batch = updates.slice(i, i + 50);
      const result = await backfillQuoteBankProblems(batch);
      totalPatched += result.patched || 0;
    }

    res.json({ success: true, updated: totalPatched });
  } catch (err) {
    console.error('Failed to backfill problems:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Update tags on a quote bank entry ─────────────────────────────────────────
router.patch('/:projectId/quote-bank/:quoteId/tags', async (req, res) => {
  try {
    const { tags } = req.body;
    if (!Array.isArray(tags)) {
      return res.status(400).json({ error: 'tags must be an array of strings' });
    }
    await updateQuoteBankQuote(req.params.quoteId, { tags });
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to update quote tags:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Update a quote bank entry (emotion, problem, quote text, headlines) ───────
router.patch('/:projectId/quote-bank/:quoteId', async (req, res) => {
  try {
    const quote = await getQuoteBankQuote(req.params.quoteId);
    if (!quote || quote.project_id !== req.params.projectId) {
      return res.status(404).json({ error: 'Quote not found in bank' });
    }
    const allowedFields = ['emotion', 'problem', 'quote', 'tags', 'headlines', 'headlines_generated_at'];
    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }
    await updateQuoteBankQuote(req.params.quoteId, updates);
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to update bank quote:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Bulk update multiple quote bank entries ───────────────────────────────────
router.post('/:projectId/quote-bank/bulk-update', async (req, res) => {
  try {
    const { quoteIds, updates } = req.body;
    if (!Array.isArray(quoteIds) || quoteIds.length === 0) {
      return res.status(400).json({ error: 'quoteIds must be a non-empty array' });
    }
    const allowedFields = ['emotion', 'problem', 'tags'];
    const validUpdates = {};
    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        validUpdates[field] = updates[field];
      }
    }
    if (Object.keys(validUpdates).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    // Build bulk update payload
    const bulkItems = quoteIds.map(id => ({
      externalId: id,
      ...validUpdates,
    }));

    // Batch in groups of 50
    let totalPatched = 0;
    for (let i = 0; i < bulkItems.length; i += 50) {
      const batch = bulkItems.slice(i, i + 50);
      const result = await convexClient.mutation(api.quote_bank.bulkUpdate, {
        updates: JSON.stringify(batch),
      });
      totalPatched += result.patched || 0;
    }

    res.json({ success: true, updated: totalPatched });
  } catch (err) {
    console.error('Failed to bulk update quotes:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;

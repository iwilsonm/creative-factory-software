import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { getProject, getQuoteMiningRunsByProject, getQuoteMiningRun, getQuoteBankByProject, getQuoteBankQuote, updateQuoteBankQuote, deleteQuoteBankQuote, getAdsWithSourceQuote } from '../convexClient.js';
import { convexClient, api } from '../convexClient.js';
import { generateSuggestions } from '../services/quoteMiner.js';
import { deduplicateAndAddToBank } from '../services/quoteDedup.js';
import { generateBodyCopy } from '../services/bodyCopyGenerator.js';
import { executeMiningRun, generateRunHeadlines, generateBankHeadlines, generateMoreForQuote, importAllRunsToBank, backfillProblems } from '../services/quoteBankService.js';
import { streamService } from '../utils/sseHelper.js';

const router = Router();
router.use(requireAuth);

// ── List past runs for a project ──────────────────────────────────────────────
router.get('/:projectId/quote-mining', async (req, res) => {
  try {
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const runs = await getQuoteMiningRunsByProject(req.params.projectId);
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
  const project = await getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const { target_demographic, problem, root_cause, keywords, subreddits, forums, facebook_groups, num_quotes } = req.body;

  if (!target_demographic || !problem || !keywords || !Array.isArray(keywords) || keywords.length === 0) {
    return res.status(400).json({ error: 'target_demographic, problem, and keywords (array) are required' });
  }

  streamService(req, res, (sendEvent) =>
    executeMiningRun(req.params.projectId, {
      target_demographic, problem, root_cause, keywords, subreddits, forums, facebook_groups, num_quotes,
    }, sendEvent)
  );
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
    const result = await importAllRunsToBank(req.params.projectId);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Failed to bulk import runs to bank:', err);
    const status = err.status || 500;
    res.status(status).json({ error: err.message });
  }
});

// ── Generate headlines from a run's quotes — Legacy (SSE stream) ─────────────
router.post('/:projectId/quote-mining/:runId/headlines', async (req, res) => {
  streamService(req, res, (sendEvent) =>
    generateRunHeadlines(req.params.runId, req.params.projectId, sendEvent)
  );
});

// ════════════════════════════════════════════════════════════════════════════════
// QUOTE BANK ENDPOINTS
// ════════════════════════════════════════════════════════════════════════════════

// ── List all bank quotes for a project ───────────────────────────────────────
router.get('/:projectId/quote-bank', async (req, res) => {
  try {
    const quotes = await getQuoteBankByProject(req.params.projectId);
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
  const { quote_ids, target_demographic, problem } = req.body;
  if (!target_demographic || !problem) {
    return res.status(400).json({ error: 'target_demographic and problem are required' });
  }

  streamService(req, res, (sendEvent) =>
    generateBankHeadlines(req.params.projectId, quote_ids, { target_demographic, problem }, sendEvent)
  );
});

// ── Generate MORE headlines for a specific quote (SSE stream) ─────────────────
router.post('/:projectId/quote-bank/:quoteId/generate-more-headlines', async (req, res) => {
  const { target_demographic, problem } = req.body;
  if (!target_demographic || !problem) {
    return res.status(400).json({ error: 'target_demographic and problem are required' });
  }

  streamService(req, res, (sendEvent) =>
    generateMoreForQuote(req.params.quoteId, req.params.projectId, { target_demographic, problem }, sendEvent)
  );
});

// ── Generate body copy for a headline + quote ────────────────────────────────
router.post('/:projectId/quote-bank/:quoteId/body-copy', async (req, res) => {
  try {
    const { headline, target_demographic, problem, style } = req.body;
    if (!headline) {
      return res.status(400).json({ error: 'headline is required' });
    }

    const quote = await getQuoteBankQuote(req.params.quoteId);
    if (!quote || quote.project_id !== req.params.projectId) {
      return res.status(404).json({ error: 'Quote not found in bank' });
    }

    const bodyCopy = await generateBodyCopy(headline, quote, target_demographic || '', problem || '', style || 'short');
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
    const result = await backfillProblems(req.params.projectId);
    res.json({ success: true, ...result });
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

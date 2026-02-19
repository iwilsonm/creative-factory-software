import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth } from '../auth.js';
import { getProject, getQuoteMiningRunsByProject, getQuoteMiningRun } from '../convexClient.js';
import { convexClient, api } from '../convexClient.js';
import { runQuoteMining, generateSuggestions } from '../services/quoteMiner.js';
import { generateHeadlines } from '../services/headlineGenerator.js';

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

      clearInterval(keepalive);
      if (!closed) {
        sendEvent({ type: 'saved', runId, quoteCount: result.quotes.length });
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

// ── Generate headlines from a run's quotes (SSE stream) ─────────────────────
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

export default router;

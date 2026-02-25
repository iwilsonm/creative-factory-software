import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { getProject, getProjectStats, getSetting, getAgentCosts } from '../convexClient.js';
import { getCostSummary, getCostHistoryData, syncOpenAICosts, getRecurringBatchCostEstimate } from '../services/costTracker.js';

const router = Router();
router.use(requireAuth);

/**
 * GET /costs — System-wide cost summaries (today, week, month)
 */
router.get('/costs', async (req, res) => {
  try {
    const summary = await getCostSummary(null);
    res.json(summary);
  } catch (err) {
    console.error('[Costs API] Summary error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /costs/history — Daily cost history for charts
 */
router.get('/costs/history', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const projectId = req.query.project_id || null;
    const history = await getCostHistoryData(days, projectId);
    res.json({ history, days });
  } catch (err) {
    console.error('[Costs API] History error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /costs/recurring — Estimated daily cost from scheduled batches
 */
router.get('/costs/recurring', async (req, res) => {
  try {
    const estimate = await getRecurringBatchCostEstimate();
    res.json(estimate);
  } catch (err) {
    console.error('[Costs API] Recurring estimate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /projects/:id/costs — Project-scoped cost summaries
 */
router.get('/projects/:id/costs', async (req, res) => {
  const project = await getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  try {
    const summary = await getCostSummary(req.params.id);
    const stats = await getProjectStats(req.params.id);

    // Calculate cost per ad
    const totalGeminiMonth = (summary.month.byService.gemini || 0);
    const adCount = stats.adCount || 0;
    const costPerAd = adCount > 0 ? totalGeminiMonth / adCount : 0;

    res.json({
      ...summary,
      costPerAd: Math.round(costPerAd * 1000000) / 1000000,
      adCount
    });
  } catch (err) {
    console.error('[Costs API] Project costs error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /costs/rates — Current per-image Gemini rates + last updated timestamp
 */
router.get('/costs/rates', async (req, res) => {
  try {
    const [rate2k, updatedAt] = await Promise.all([
      getSetting('gemini_rate_2k'),
      getSetting('gemini_rates_updated_at'),
    ]);
    const manualRate = rate2k ? parseFloat(rate2k) : null;
    const batchRate = manualRate ? manualRate * 0.5 : null;
    res.json({
      manualRate,
      batchRate,
      updatedAt: updatedAt || null,
    });
  } catch (err) {
    console.error('[Costs API] Rates error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /costs/sync — Manual trigger for OpenAI cost sync
 */
router.post('/costs/sync', async (req, res) => {
  try {
    const result = await syncOpenAICosts();
    res.json(result);
  } catch (err) {
    console.error('[Costs API] Sync error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /costs/agents — Agent-grouped cost breakdown (Director, Filter, Fixer, Pipeline, Other)
 */
router.get('/costs/agents', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];
    const data = await getAgentCosts(startDate, endDate);
    res.json(data);
  } catch (err) {
    console.error('[Costs API] Agent costs error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;

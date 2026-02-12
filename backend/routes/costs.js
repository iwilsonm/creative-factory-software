import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { getProject, getProjectStats } from '../db.js';
import { getCostSummary, getCostHistoryData, syncOpenAICosts, getRecurringBatchCostEstimate } from '../services/costTracker.js';

const router = Router();
router.use(requireAuth);

/**
 * GET /costs — System-wide cost summaries (today, week, month)
 */
router.get('/costs', (req, res) => {
  try {
    const summary = getCostSummary(null);
    res.json(summary);
  } catch (err) {
    console.error('[Costs API] Summary error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /costs/history — Daily cost history for charts
 * Query params: ?days=30&project_id=xxx
 */
router.get('/costs/history', (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const projectId = req.query.project_id || null;
    const history = getCostHistoryData(days, projectId);
    res.json({ history, days });
  } catch (err) {
    console.error('[Costs API] History error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /costs/recurring — Estimated daily cost from scheduled batches
 */
router.get('/costs/recurring', (req, res) => {
  try {
    const estimate = getRecurringBatchCostEstimate();
    res.json(estimate);
  } catch (err) {
    console.error('[Costs API] Recurring estimate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /projects/:id/costs — Project-scoped cost summaries
 */
router.get('/projects/:id/costs', (req, res) => {
  const project = getProject(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  try {
    const summary = getCostSummary(req.params.id);
    const stats = getProjectStats(req.params.id);

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

export default router;

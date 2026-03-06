import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { getProject, getProjectStats, getSetting, getAgentCosts } from '../convexClient.js';
import { getCostSummary, getCostHistoryData, syncOpenAICosts, getRecurringBatchCostEstimate } from '../services/costTracker.js';

const router = Router();
router.use(requireAuth);

const ROUTE_CACHE = new Map();
const COST_CACHE_TTLS = {
  summary: 20 * 1000,
  history: 5 * 60 * 1000,
  recurring: 60 * 1000,
  rates: 10 * 60 * 1000,
};

async function getCachedCostPayload(key, ttlMs, loader) {
  const cached = ROUTE_CACHE.get(key);
  const now = Date.now();

  if (cached?.data && cached.expiresAt > now) {
    return cached.data;
  }

  if (cached?.promise) {
    return cached.promise;
  }

  const promise = loader()
    .then((data) => {
      ROUTE_CACHE.set(key, {
        data,
        expiresAt: Date.now() + ttlMs,
      });
      return data;
    })
    .catch((err) => {
      if (cached?.data) {
        ROUTE_CACHE.set(key, {
          data: cached.data,
          expiresAt: Date.now() + Math.min(ttlMs, 5000),
        });
        return cached.data;
      }
      ROUTE_CACHE.delete(key);
      throw err;
    });

  ROUTE_CACHE.set(key, {
    data: cached?.data || null,
    expiresAt: cached?.expiresAt || 0,
    promise,
  });

  return promise;
}

function invalidateCostCache(...prefixes) {
  for (const key of ROUTE_CACHE.keys()) {
    if (prefixes.some(prefix => key.startsWith(prefix))) {
      ROUTE_CACHE.delete(key);
    }
  }
}

/**
 * GET /costs — System-wide cost summaries (today, week, month)
 */
router.get('/costs', async (req, res) => {
  try {
    const summary = await getCachedCostPayload('summary:all', COST_CACHE_TTLS.summary, () => getCostSummary(null));
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
    const historyKey = `history:${projectId || 'all'}:${days}`;
    const history = await getCachedCostPayload(historyKey, COST_CACHE_TTLS.history, () => getCostHistoryData(days, projectId));
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
    const estimate = await getCachedCostPayload('recurring:all', COST_CACHE_TTLS.recurring, () => getRecurringBatchCostEstimate());
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
    const summary = await getCachedCostPayload(`summary:${req.params.id}`, COST_CACHE_TTLS.summary, () => getCostSummary(req.params.id));
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
    const { rate2k, updatedAt } = await getCachedCostPayload('rates:gemini', COST_CACHE_TTLS.rates, async () => {
      const [geminiRate2k, geminiUpdatedAt] = await Promise.all([
        getSetting('gemini_rate_2k'),
        getSetting('gemini_rates_updated_at'),
      ]);
      return {
        rate2k: geminiRate2k,
        updatedAt: geminiUpdatedAt,
      };
    });
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
    invalidateCostCache('summary:', 'history:');
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

import { v4 as uuidv4 } from 'uuid';
import { getSetting, setSetting, logCost, getCostAggregates, getDailyCostHistory, deleteCostsBySource, getAllScheduledBatchesForCost } from '../convexClient.js';
import { withRetry } from './retry.js';

/**
 * Log a Gemini image generation cost (fire-and-forget).
 * Reads the current rate from settings, applies batch discount if applicable,
 * and inserts into api_costs. The rate is locked at generation time.
 *
 * @param {string} projectId
 * @param {number} imageCount - Number of images generated
 * @param {string} resolution - '1K', '2K', or '4K'
 * @param {boolean} isBatch - Whether this is a batch generation (50% discount)
 */
export async function logGeminiCost(projectId, imageCount = 1, resolution = '2K', isBatch = false) {
  try {
    const rateKey = `gemini_rate_${resolution.toLowerCase()}`;
    const rateStr = await getSetting(rateKey);
    const baseRate = rateStr ? parseFloat(rateStr) : 0;

    if (baseRate <= 0) {
      // No rate configured — skip logging
      return null;
    }

    const rate = isBatch ? baseRate * 0.5 : baseRate;
    const cost = imageCount * rate;

    const record = {
      id: uuidv4(),
      project_id: projectId,
      service: 'gemini',
      operation: isBatch ? 'image_generation_batch' : 'image_generation',
      cost_usd: Math.round(cost * 1000000) / 1000000, // 6 decimal precision
      rate_used: rate,
      image_count: imageCount,
      resolution,
      source: 'calculated',
      period_date: new Date().toISOString().split('T')[0]
    };

    await logCost(record);
    return record;

  } catch (err) {
    console.error('[CostTracker] Failed to log Gemini cost:', err.message);
    return null;
  }
}

/**
 * Sync OpenAI costs from the Costs API.
 * Requires openai_admin_key to be configured.
 *
 * @returns {{ synced: boolean, recordCount?: number, reason?: string }}
 */
export async function syncOpenAICosts() {
  const adminKey = await getSetting('openai_admin_key');
  if (!adminKey) {
    return { synced: false, reason: 'OpenAI Admin API key not configured.' };
  }

  try {
    // Fetch last 30 days of cost data
    const endTime = Math.floor(Date.now() / 1000);
    const startTime = endTime - (30 * 24 * 60 * 60);

    const url = `https://api.openai.com/v1/organization/costs?start_time=${startTime}&end_time=${endTime}&bucket_width=1d&group_by=line_item&limit=180`;

    const response = await withRetry(async () => {
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${adminKey}` }
      });
      if (res.status === 429 || res.status >= 500) {
        const err = new Error(`OpenAI API ${res.status}`);
        err.status = res.status;
        err.headers = Object.fromEntries(res.headers.entries());
        throw err;
      }
      return res;
    }, { label: '[CostTracker syncOpenAI]', maxRetries: 2 });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      return { synced: false, reason: `OpenAI API returned ${response.status}: ${errText.slice(0, 200)}` };
    }

    const data = await response.json();
    const buckets = data.data || [];

    // Delete existing billing_api records in this window
    const startDate = new Date(startTime * 1000).toISOString().split('T')[0];
    await deleteCostsBySource('billing_api', startDate);

    let recordCount = 0;

    for (const bucket of buckets) {
      const periodDate = bucket.start_time
        ? new Date(bucket.start_time * 1000).toISOString().split('T')[0]
        : new Date().toISOString().split('T')[0];

      const results = bucket.results || [];

      for (const result of results) {
        const lineItem = result.line_item || result.object || '';
        const amount = result.amount?.value || 0;

        if (amount <= 0) continue;

        // Map line items to operation types
        let operation = 'other';
        const lowerItem = lineItem.toLowerCase();
        if (lowerItem.includes('gpt-5') || lowerItem.includes('gpt-4')) {
          operation = lowerItem.includes('image') ? 'ad_creative_director' : 'foundational_docs';
        } else if (lowerItem.includes('o3') || lowerItem.includes('deep-research')) {
          operation = 'foundational_docs';
        }

        await logCost({
          id: uuidv4(),
          project_id: null, // OpenAI costs are org-wide, not project-scoped by default
          service: 'openai',
          operation,
          cost_usd: amount,
          rate_used: null,
          image_count: null,
          resolution: null,
          source: 'billing_api',
          period_date: periodDate
        });

        recordCount++;
      }
    }

    console.log(`[CostTracker] OpenAI sync complete: ${recordCount} cost records.`);
    return { synced: true, recordCount };

  } catch (err) {
    console.error('[CostTracker] OpenAI sync failed:', err.message);
    return { synced: false, reason: err.message };
  }
}

/**
 * Refresh Gemini pricing rates by fetching Google's pricing page.
 * Falls back gracefully if parsing fails.
 *
 * @returns {{ refreshed: boolean, rates?: object, reason?: string }}
 */
export async function refreshGeminiRates() {
  try {
    const response = await withRetry(async () => {
      const res = await fetch('https://ai.google.dev/gemini-api/docs/pricing');
      if (res.status >= 500) {
        const err = new Error(`Google pricing page ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return res;
    }, { label: '[CostTracker refreshRates]', maxRetries: 2 });

    if (!response.ok) {
      return { refreshed: false, reason: `Google pricing page returned ${response.status}` };
    }

    const html = await response.text();

    // Parse the pricing page for Imagen / image generation rates
    // Look for dollar amounts near "image" and resolution keywords
    const rates = parseGeminiImageRates(html);

    if (rates) {
      if (rates.rate_1k) await setSetting('gemini_rate_1k', String(rates.rate_1k));
      if (rates.rate_2k) await setSetting('gemini_rate_2k', String(rates.rate_2k));
      if (rates.rate_4k) await setSetting('gemini_rate_4k', String(rates.rate_4k));
      await setSetting('gemini_rates_updated_at', new Date().toISOString());

      console.log(`[CostTracker] Gemini rates updated: 1K=$${rates.rate_1k}, 2K=$${rates.rate_2k}, 4K=$${rates.rate_4k}`);
      return { refreshed: true, rates };
    }

    return { refreshed: false, reason: 'Could not parse pricing data from the page. Existing rates preserved.' };

  } catch (err) {
    console.error('[CostTracker] Gemini rate refresh failed:', err.message);
    return { refreshed: false, reason: err.message };
  }
}

/**
 * Parse Gemini image generation rates from Google's pricing page HTML.
 * This is inherently fragile — the page structure changes.
 * Returns null if parsing fails.
 */
function parseGeminiImageRates(html) {
  try {
    // Look for pricing patterns near "image" and resolution indicators
    // Common pattern: "$X.XX per image" or token-based pricing
    // Try multiple parsing strategies

    // Strategy 1: Look for table rows with resolution and dollar amounts
    const pricePattern = /\$(\d+\.?\d*)/g;
    const prices = [];
    let match;
    while ((match = pricePattern.exec(html)) !== null) {
      prices.push(parseFloat(match[1]));
    }

    // Strategy 2: Look for specific Imagen or image generation sections
    const imagenSection = html.match(/[Ii]magen[^]*?(\$[\d.]+)[^]*?(\$[\d.]+)[^]*?(\$[\d.]+)/);
    if (imagenSection) {
      return {
        rate_1k: parseFloat(imagenSection[1].replace('$', '')),
        rate_2k: parseFloat(imagenSection[2].replace('$', '')),
        rate_4k: parseFloat(imagenSection[3].replace('$', ''))
      };
    }

    // If we can't parse reliably, return null to preserve existing rates
    return null;

  } catch {
    return null;
  }
}

/**
 * Get cost summary for all three time periods (today, week, month).
 *
 * @param {string|null} projectId - If null, returns system-wide costs
 * @returns {{ today: object, week: object, month: object }}
 */
export async function getCostSummary(projectId = null) {
  const today = new Date().toISOString().split('T')[0];

  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const weekStr = weekAgo.toISOString().split('T')[0];

  const monthAgo = new Date();
  monthAgo.setDate(monthAgo.getDate() - 30);
  const monthStr = monthAgo.toISOString().split('T')[0];

  const [todayData, weekData, monthData] = await Promise.all([
    getCostAggregates(today, today, projectId),
    getCostAggregates(weekStr, today, projectId),
    getCostAggregates(monthStr, today, projectId),
  ]);

  return {
    today: todayData,
    week: weekData,
    month: monthData
  };
}

/**
 * Get daily cost history for charts.
 *
 * @param {number} days
 * @param {string|null} projectId
 * @returns {Array<{ date, openai, gemini, total }>}
 */
export async function getCostHistoryData(days = 30, projectId = null) {
  return await getDailyCostHistory(days, projectId);
}

/**
 * Estimate daily recurring batch cost from all scheduled batches.
 * For each scheduled batch:
 *   1. Parse cron to determine runs-per-day
 *   2. Multiply: runs_per_day * batch_size * gemini_rate * 0.5 (batch discount)
 *
 * @returns {{ estimatedDailyCost: number, scheduledBatchCount: number, breakdown: Array }}
 */
export async function getRecurringBatchCostEstimate() {
  const batches = await getAllScheduledBatchesForCost();
  const rate2k = parseFloat((await getSetting('gemini_rate_2k')) || '0');

  let totalDailyCost = 0;
  const breakdown = [];

  for (const batch of batches) {
    const runsPerDay = estimateRunsPerDay(batch.schedule_cron);
    const costPerRun = batch.batch_size * rate2k * 0.5; // 50% batch discount
    const dailyCost = runsPerDay * costPerRun;
    totalDailyCost += dailyCost;

    breakdown.push({
      project_id: batch.project_id,
      batch_size: batch.batch_size,
      cron: batch.schedule_cron,
      runs_per_day: runsPerDay,
      cost_per_run: Math.round(costPerRun * 1000000) / 1000000,
      daily_cost: Math.round(dailyCost * 1000000) / 1000000
    });
  }

  return {
    estimatedDailyCost: Math.round(totalDailyCost * 1000000) / 1000000,
    scheduledBatchCount: batches.length,
    breakdown
  };
}

// Estimate how many times per day a cron expression fires.
// Simplified parser covering common presets (e.g. every N hours, specific hours, weekday filters).
function estimateRunsPerDay(cronExpr) {
  if (!cronExpr) return 0;
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length < 5) return 0;

  const [minute, hour, , , dayOfWeek] = parts;

  // Check if it only runs on specific days of week
  let daysPerWeek = 7;
  if (dayOfWeek !== '*') {
    if (dayOfWeek.includes('-')) {
      const [start, end] = dayOfWeek.split('-').map(Number);
      daysPerWeek = end - start + 1;
    } else if (dayOfWeek.includes(',')) {
      daysPerWeek = dayOfWeek.split(',').length;
    } else {
      daysPerWeek = 1;
    }
  }
  const dayFraction = daysPerWeek / 7;

  // Calculate runs per day based on hour field
  let runsPerDay = 1;
  if (hour === '*') {
    runsPerDay = 24;
  } else if (hour.startsWith('*/')) {
    const interval = parseInt(hour.slice(2));
    runsPerDay = interval > 0 ? Math.floor(24 / interval) : 24;
  } else if (hour.includes(',')) {
    runsPerDay = hour.split(',').length;
  }
  // else: specific hour = 1 run per day

  // Check minute for sub-hour frequency
  if (minute.startsWith('*/')) {
    const interval = parseInt(minute.slice(2));
    runsPerDay = runsPerDay * (interval > 0 ? Math.floor(60 / interval) : 60);
  }

  return runsPerDay * dayFraction;
}

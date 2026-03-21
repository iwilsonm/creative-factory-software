import { v4 as uuidv4 } from 'uuid';
import { getSetting, setSetting, logCost, getCostAggregates, getDailyCostHistory, deleteCostsBySource, getAllScheduledBatchesForCost, getAllProjects, getAllConductorConfigs, getAllLPAgentConfigs, getCompletedDirectorBatchStats } from '../convexClient.js';
import { withRetry } from './retry.js';

// ── Anthropic Claude pricing (per million tokens) ──────────────────────────────
// Source: https://docs.anthropic.com/en/docs/about-claude/pricing
const ANTHROPIC_RATES = {
  'claude-opus-4-6':   { input: 5.00, output: 25.00 },    // $5/M in, $25/M out (same as Opus 4.5)
  'claude-sonnet-4-6': { input: 3.00, output: 15.00 },    // $3/M in, $15/M out
  'claude-haiku-3-5':  { input: 0.80, output: 4.00 },     // $0.80/M in, $4/M out
};

// ── OpenAI GPT pricing (per million tokens) ─────────────────────────────────
// Source: https://platform.openai.com/docs/pricing
// Note: per-call calculated logging complements the hourly billing API sync.
// Calculated records use source='calculated', billing API uses source='billing_api'.
const OPENAI_RATES = {
  'gpt-5.2':            { input: 2.00, output: 8.00 },
  'gpt-4.1':            { input: 2.00, output: 8.00 },
  'gpt-4.1-mini':       { input: 0.40, output: 1.60 },
  'gpt-4o-mini':        { input: 0.15, output: 0.60 },
  'o3-deep-research':   { input: 0, output: 0 },      // billed via billing API only
};

// ── Perplexity pricing (per million tokens) ────────────────────────────────────
// Source: https://docs.perplexity.ai/docs/pricing
const PERPLEXITY_RATES = {
  'sonar-pro':  { input: 3.00, output: 15.00 },  // $3/M in, $15/M out
  'sonar':      { input: 1.00, output: 1.00 },    // $1/M in, $1/M out
};

/**
 * Log an Anthropic Claude API cost (fire-and-forget).
 * Uses token counts from the API response to calculate exact cost.
 *
 * @param {object} params
 * @param {string} params.model - e.g. 'claude-sonnet-4-6'
 * @param {string} params.operation - e.g. 'copy_correction', 'brief_extraction'
 * @param {number} params.inputTokens - input tokens used
 * @param {number} params.outputTokens - output tokens used
 * @param {string|null} [params.projectId] - project ID if applicable
 */
export async function logAnthropicCost({ model, operation, inputTokens, outputTokens, projectId = null }) {
  try {
    const rates = ANTHROPIC_RATES[model] || ANTHROPIC_RATES['claude-sonnet-4-6'];
    const inputCost = (inputTokens / 1_000_000) * rates.input;
    const outputCost = (outputTokens / 1_000_000) * rates.output;
    const totalCost = inputCost + outputCost;

    if (totalCost <= 0) return null;

    const record = {
      id: uuidv4(),
      project_id: projectId,
      service: 'anthropic',
      operation,
      cost_usd: Math.round(totalCost * 1000000) / 1000000,
      rate_used: null,
      image_count: null,
      resolution: null,
      source: 'calculated',
      period_date: new Date().toISOString().split('T')[0]
    };

    await logCost(record);
    return record;
  } catch (err) {
    console.error('[CostTracker] Failed to log Anthropic cost:', err.message);
    return null;
  }
}

/**
 * Log an OpenAI GPT API cost (fire-and-forget).
 * Uses token counts from the API response to calculate exact cost.
 * Complements the hourly billing API sync with per-operation granularity.
 *
 * @param {object} params
 * @param {string} params.model - e.g. 'gpt-5.2', 'gpt-4.1-mini'
 * @param {string} params.operation - e.g. 'ad_creative_director', 'foundational_docs'
 * @param {number} params.inputTokens - input/prompt tokens used
 * @param {number} params.outputTokens - output/completion tokens used
 * @param {string|null} [params.projectId] - project ID if applicable
 */
export async function logOpenAICost({ model, operation, inputTokens, outputTokens, projectId = null }) {
  try {
    const rates = OPENAI_RATES[model] || OPENAI_RATES['gpt-4.1'];
    const inputCost = (inputTokens / 1_000_000) * rates.input;
    const outputCost = (outputTokens / 1_000_000) * rates.output;
    const totalCost = inputCost + outputCost;

    if (totalCost <= 0) return null;

    const record = {
      id: uuidv4(),
      project_id: projectId,
      service: 'openai',
      operation,
      cost_usd: Math.round(totalCost * 1000000) / 1000000,
      rate_used: null,
      image_count: null,
      resolution: null,
      source: 'calculated',
      period_date: new Date().toISOString().split('T')[0]
    };

    await logCost(record);
    return record;
  } catch (err) {
    console.error('[CostTracker] Failed to log OpenAI cost:', err.message);
    return null;
  }
}

/**
 * Log a Perplexity API cost (fire-and-forget).
 *
 * @param {object} params
 * @param {string} params.model - e.g. 'sonar-pro'
 * @param {string} params.operation - e.g. 'quote_mining'
 * @param {number} params.inputTokens - input tokens used
 * @param {number} params.outputTokens - output tokens used
 * @param {string|null} [params.projectId] - project ID if applicable
 */
export async function logPerplexityCost({ model, operation, inputTokens, outputTokens, projectId = null }) {
  try {
    const rates = PERPLEXITY_RATES[model] || PERPLEXITY_RATES['sonar-pro'];
    const inputCost = (inputTokens / 1_000_000) * rates.input;
    const outputCost = (outputTokens / 1_000_000) * rates.output;
    const totalCost = inputCost + outputCost;

    if (totalCost <= 0) return null;

    const record = {
      id: uuidv4(),
      project_id: projectId,
      service: 'perplexity',
      operation,
      cost_usd: Math.round(totalCost * 1000000) / 1000000,
      rate_used: null,
      image_count: null,
      resolution: null,
      source: 'calculated',
      period_date: new Date().toISOString().split('T')[0]
    };

    await logCost(record);
    return record;
  } catch (err) {
    console.error('[CostTracker] Failed to log Perplexity cost:', err.message);
    return null;
  }
}

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
export async function logGeminiCost(projectId, imageCount = 1, resolution = '2K', isBatch = false, operationOverride = null) {
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
      operation: operationOverride || (isBatch ? 'image_generation_batch' : 'image_generation'),
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

        // Map line items to model-specific billing operations
        let operation = 'openai_billing';
        const lowerItem = lineItem.toLowerCase();
        if (lowerItem.includes('gpt-5')) operation = 'openai_billing_gpt5';
        else if (lowerItem.includes('gpt-4.1-mini') || lowerItem.includes('gpt-4o-mini')) operation = 'openai_billing_gpt4_mini';
        else if (lowerItem.includes('gpt-4')) operation = 'openai_billing_gpt4';
        else if (lowerItem.includes('o3') || lowerItem.includes('deep-research')) operation = 'openai_billing_research';

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

// Known-good fallback rates (Gemini 3 Pro Image Preview, Feb 2026).
// These are used when the auto-scraper can't reliably parse Google's pricing page,
// and as sanity bounds to reject obviously wrong scraped values.
const KNOWN_RATES = { rate_1k: 0.134, rate_2k: 0.134, rate_4k: 0.24 };
// Rates should be between $0.001 and $2.00 per image. Anything outside this
// range is almost certainly a parsing error.
const RATE_MIN = 0.001;
const RATE_MAX = 2.0;

/**
 * Refresh Gemini pricing rates by fetching Google's pricing page.
 * Falls back gracefully if parsing fails. Includes sanity checks to
 * prevent absurd rates (like $18/image) from being saved.
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

    // Parse the pricing page for image generation rates
    const rates = parseGeminiImageRates(html);

    if (rates) {
      // Sanity check: reject rates that are obviously wrong
      const allValid = [rates.rate_1k, rates.rate_2k, rates.rate_4k].every(
        r => r >= RATE_MIN && r <= RATE_MAX
      );

      if (!allValid) {
        console.warn(`[CostTracker] Parsed rates failed sanity check (1K=$${rates.rate_1k}, 2K=$${rates.rate_2k}, 4K=$${rates.rate_4k}). Using known-good defaults.`);
        // Fall through to use known defaults below
      } else {
        if (rates.rate_1k) await setSetting('gemini_rate_1k', String(rates.rate_1k));
        if (rates.rate_2k) await setSetting('gemini_rate_2k', String(rates.rate_2k));
        if (rates.rate_4k) await setSetting('gemini_rate_4k', String(rates.rate_4k));
        await setSetting('gemini_rates_updated_at', new Date().toISOString());

        console.log(`[CostTracker] Gemini rates updated: 1K=$${rates.rate_1k}, 2K=$${rates.rate_2k}, 4K=$${rates.rate_4k}`);
        return { refreshed: true, rates };
      }
    }

    // Parsing failed or sanity check failed — ensure known-good defaults are set
    // Check if current rates are sane; if not, reset them
    const current2k = parseFloat((await getSetting('gemini_rate_2k')) || '0');
    if (current2k < RATE_MIN || current2k > RATE_MAX) {
      console.warn(`[CostTracker] Current 2K rate ($${current2k}) is out of bounds. Resetting to known defaults.`);
      await setSetting('gemini_rate_1k', String(KNOWN_RATES.rate_1k));
      await setSetting('gemini_rate_2k', String(KNOWN_RATES.rate_2k));
      await setSetting('gemini_rate_4k', String(KNOWN_RATES.rate_4k));
      await setSetting('gemini_rates_updated_at', new Date().toISOString());
      return { refreshed: true, rates: KNOWN_RATES, source: 'defaults' };
    }

    return { refreshed: false, reason: 'Could not parse pricing data from the page. Existing rates preserved.' };

  } catch (err) {
    console.error('[CostTracker] Gemini rate refresh failed:', err.message);
    return { refreshed: false, reason: err.message };
  }
}

/**
 * Parse Gemini image generation rates from Google's pricing page HTML.
 * Looks specifically for Gemini 3 Pro Image pricing. Returns null if
 * parsing fails — the caller handles fallback to known-good defaults.
 */
export function parseGeminiImageRates(html) {
  try {
    // Strategy: Look for "Gemini 3 Pro Image" or similar section, then find
    // nearby dollar amounts that look like per-image rates (typically $0.01–$1.00)
    // Match dollar amounts that have a decimal and are less than $10
    const sectionPatterns = [
      /[Gg]emini.{0,5}3.{0,5}[Pp]ro.{0,10}[Ii]mage/,
      /[Ii]magen.{0,5}[34]/,
      /[Ii]mage.{0,10}[Gg]eneration/
    ];

    for (const sectionPattern of sectionPatterns) {
      const sectionMatch = html.match(sectionPattern);
      if (!sectionMatch) continue;

      // Extract a chunk of HTML after the section header (pricing is usually nearby)
      const startIdx = sectionMatch.index;
      const chunk = html.slice(startIdx, startIdx + 3000);

      // Find all dollar amounts in this chunk
      const priceMatches = [...chunk.matchAll(/\$(\d+\.\d{2,6})/g)];
      const prices = priceMatches
        .map(m => parseFloat(m[1]))
        .filter(p => p >= RATE_MIN && p <= RATE_MAX);

      // We need at least 2 distinct prices (standard vs batch, or resolution tiers)
      if (prices.length >= 2) {
        // Deduplicate and sort
        const unique = [...new Set(prices)].sort((a, b) => a - b);
        if (unique.length >= 2) {
          // Typical pattern: lower price = 1K/2K, higher price = 4K
          return {
            rate_1k: unique[0],
            rate_2k: unique[0], // 1K and 2K are same price for Gemini 3 Pro
            rate_4k: unique[unique.length - 1]
          };
        }
      }
    }

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

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthStr = monthStart.toISOString().split('T')[0];

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
 * Estimate daily recurring automation cost using per-ad averages from
 * actual spending, scaled by current Director config. Responds immediately
 * to config changes (e.g. changing daily_flex_target from 4 to 2).
 *
 * Per-project, per-ad batch pipeline costs come from real data.
 * Filter and Director costs are daily averages (don't scale with batch count).
 */
export async function getRecurringBatchCostEstimate() {
  const today = new Date().toISOString().split('T')[0];
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const startDate = sevenDaysAgo.toISOString().split('T')[0];
  const dayCount = Math.max(1, Math.round((Date.now() - sevenDaysAgo.getTime()) / (24 * 60 * 60 * 1000)));

  // Fetch everything in parallel
  const [conductorConfigs, lpConfigs, projects, batchStats, systemAggregate] = await Promise.all([
    getAllConductorConfigs().catch(() => []),
    getAllLPAgentConfigs().catch(() => []),
    getAllProjects(),
    getCompletedDirectorBatchStats(startDate).catch(() => []),
    getCostAggregates(startDate, today)
  ]);

  const enabledDirectorProjects = conductorConfigs.filter(c => c.enabled);
  const lpConfigMap = {};
  for (const lc of lpConfigs) { if (lc.enabled) lpConfigMap[lc.project_id] = true; }
  const projectMap = {};
  for (const p of projects) { projectMap[p.id] = { name: p.name, brand_name: p.brand_name }; }

  // Per-project: count completed ads and batches from batch stats
  const projectBatchData = {};
  for (const b of batchStats) {
    if (!projectBatchData[b.project_id]) projectBatchData[b.project_id] = { ads: 0, batches: 0 };
    projectBatchData[b.project_id].ads += b.batch_size || 18;
    projectBatchData[b.project_id].batches += 1;
  }

  // Fetch per-project cost aggregates for Director-enabled projects
  const projectCostPromises = enabledDirectorProjects.map(dc =>
    getCostAggregates(startDate, today, dc.project_id).catch(() => ({ byOperation: {} }))
  );
  const projectCosts = await Promise.all(projectCostPromises);

  // Classify operations into categories for a single project's cost data
  function classifyCosts(byOp) {
    let batch = 0, lp = 0;
    for (const [op, data] of Object.entries(byOp || {})) {
      const cost = data.cost || 0;
      if (cost <= 0) continue;
      if (op.startsWith('batch_') || op === 'image_generation_batch' || op === 'prompt_guideline_review') {
        batch += cost;
      } else if (op.startsWith('lp_')) {
        lp += cost;
      }
    }
    return { batch, lp };
  }

  // System-wide Filter and Director costs (daily averages, don't scale with batch count)
  let filterTotal = 0, directorTotal = 0;
  const sysOps = systemAggregate.byOperation || {};
  for (const [op, data] of Object.entries(sysOps)) {
    const cost = data.cost || 0;
    if (cost <= 0) continue;
    if (op.startsWith('filter_') || op === 'conductor_learning_analysis') filterTotal += cost;
    else if (op.startsWith('conductor_')) directorTotal += cost;
  }

  // Build breakdown: one row per Director project + system rows
  const breakdown = [];
  let totalDailyCost = 0;

  for (let i = 0; i < enabledDirectorProjects.length; i++) {
    const dc = enabledDirectorProjects[i];
    const proj = projectMap[dc.project_id];
    const projName = proj?.brand_name || proj?.name || 'Unknown';
    const flexTarget = dc.daily_flex_target || 4;
    const adsPerBatch = dc.ads_per_batch || 18;
    const hasLP = !!lpConfigMap[dc.project_id];

    const costs = classifyCosts(projectCosts[i].byOperation);
    const pbd = projectBatchData[dc.project_id];

    if (!pbd || pbd.ads === 0) {
      // No completed batches yet — show collecting state
      breakdown.push({
        category: 'project',
        label: projName,
        description: `${flexTarget}/day × ${adsPerBatch} ads${hasLP ? ' + LP' : ''} — collecting data`,
        period_total: 0,
        daily_avg: 0,
        per_ad: 0,
        per_batch_lp: 0,
        collecting: true
      });
      continue;
    }

    // Per-ad batch pipeline cost
    const perAd = costs.batch / pbd.ads;
    const dailyBatchCost = perAd * adsPerBatch * flexTarget;

    // Per-batch LP cost (only if LP Agent enabled)
    let dailyLPCost = 0;
    let perBatchLP = 0;
    if (hasLP && pbd.batches > 0 && costs.lp > 0) {
      perBatchLP = costs.lp / pbd.batches;
      dailyLPCost = perBatchLP * flexTarget;
    }

    const dailyCost = dailyBatchCost + dailyLPCost;
    totalDailyCost += dailyCost;

    breakdown.push({
      category: 'project',
      label: projName,
      description: `${flexTarget}/day × ${adsPerBatch} ads${hasLP ? ' + LP' : ''}`,
      period_total: Math.round((costs.batch + costs.lp) * 100) / 100,
      daily_avg: Math.round(dailyCost * 100) / 100,
      per_ad: Math.round(perAd * 10000) / 10000,
      per_batch_lp: Math.round(perBatchLP * 100) / 100,
      batches_completed: pbd.batches,
      ads_completed: pbd.ads,
      collecting: false
    });
  }

  // Filter (daily average, not per-batch)
  const filterDaily = filterTotal / dayCount;
  if (filterDaily > 0.001) {
    totalDailyCost += filterDaily;
    breakdown.push({
      category: 'filter',
      label: 'Creative Filter',
      description: 'Ad scoring + flex ad grouping',
      period_total: Math.round(filterTotal * 100) / 100,
      daily_avg: Math.round(filterDaily * 100) / 100,
      collecting: false
    });
  }

  // Director planning (daily average)
  const directorDaily = directorTotal / dayCount;
  if (directorDaily > 0.001) {
    totalDailyCost += directorDaily;
    breakdown.push({
      category: 'director',
      label: 'Director',
      description: 'Batch planning',
      period_total: Math.round(directorTotal * 100) / 100,
      daily_avg: Math.round(directorDaily * 100) / 100,
      collecting: false
    });
  }

  // Fill in percentages
  for (const row of breakdown) {
    row.pct = totalDailyCost > 0 ? Math.round(((row.daily_avg || 0) / totalDailyCost) * 100) : 0;
  }

  return {
    estimatedDailyCost: Math.round(totalDailyCost * 100) / 100,
    daysCovered: dayCount,
    directorProjectCount: enabledDirectorProjects.length,
    lpProjectCount: Object.keys(lpConfigMap).length,
    totalCompletedBatches: batchStats.length,
    totalCompletedAds: batchStats.reduce((sum, b) => sum + (b.batch_size || 18), 0),
    breakdown
  };
}

// Estimate how many times per day a cron expression fires.
// Simplified parser covering common presets (e.g. every N hours, specific hours, weekday filters).
export function estimateRunsPerDay(cronExpr) {
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

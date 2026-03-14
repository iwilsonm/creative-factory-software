/**
 * Triple Whale API Service
 *
 * Fetches blended e-commerce metrics from the Triple Whale Summary Page API.
 * Used by the CMO Agent for performance context alongside Meta ad-level data.
 */

import { withRetry } from './retry.js';

const TW_API_BASE = 'https://api.triplewhale.com/api/v2';

/**
 * Fetch blended metrics from Triple Whale Summary Page API.
 *
 * @param {string} apiKey - Triple Whale API key
 * @param {string} shopDomain - Shopify store domain (e.g. "mystore.myshopify.com")
 * @param {{ start: string, end: string }[]} periods - Array of date ranges (YYYY-MM-DD)
 * @returns {Promise<object[]>} Array of metric summaries per period
 */
export async function fetchBlendedMetrics(apiKey, shopDomain, periods) {
  const results = [];

  for (const period of periods) {
    const body = {
      shopDomain,
      start: period.start,
      end: period.end,
    };

    const data = await withRetry(
      async () => {
        const res = await fetch(`${TW_API_BASE}/summary-page/get-data`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30000),
        });

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          const err = new Error(`Triple Whale API error: ${res.status} — ${text.slice(0, 200)}`);
          err.status = res.status;
          throw err;
        }

        return res.json();
      },
      { label: '[TripleWhale]', maxRetries: 3, baseDelayMs: 2000 }
    );

    results.push({
      period: `${period.start} → ${period.end}`,
      ...extractMetrics(data),
    });
  }

  return results;
}

/**
 * Extract key metrics from Triple Whale summary response.
 */
function extractMetrics(data) {
  // Triple Whale summary page returns nested metrics
  // This extracts the most useful fields for the CMO
  const summary = data?.summary || data || {};

  return {
    revenue: summary.totalRevenue ?? summary.revenue ?? null,
    orders: summary.totalOrders ?? summary.orders ?? null,
    spend: summary.totalSpend ?? summary.adSpend ?? null,
    roas: summary.blendedRoas ?? summary.roas ?? null,
    cpa: summary.blendedCpa ?? summary.cpa ?? null,
    aov: summary.averageOrderValue ?? summary.aov ?? null,
    net_profit: summary.netProfit ?? null,
    new_customers: summary.newCustomers ?? null,
    returning_customers: summary.returningCustomers ?? null,
    conversion_rate: summary.conversionRate ?? null,
    raw: summary,
  };
}

/**
 * Build standard 3-window period set for CMO analysis.
 *
 * @returns {{ label: string, start: string, end: string }[]}
 */
export function buildStandardPeriods() {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  // Last 7 days
  const d7ago = new Date(now);
  d7ago.setDate(d7ago.getDate() - 7);
  const last7Start = d7ago.toISOString().slice(0, 10);

  // Previous 7 days (8-14 days ago)
  const d14ago = new Date(now);
  d14ago.setDate(d14ago.getDate() - 14);
  const prev7Start = d14ago.toISOString().slice(0, 10);

  // Last 30 days
  const d30ago = new Date(now);
  d30ago.setDate(d30ago.getDate() - 30);
  const last30Start = d30ago.toISOString().slice(0, 10);

  return [
    { label: 'last_7d', start: last7Start, end: today },
    { label: 'prev_7d', start: prev7Start, end: last7Start },
    { label: 'last_30d', start: last30Start, end: today },
  ];
}

/**
 * Test Triple Whale connection.
 *
 * @param {string} apiKey
 * @param {string} shopDomain
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
export async function testConnection(apiKey, shopDomain) {
  try {
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const twoDaysAgo = new Date(now);
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);

    const results = await fetchBlendedMetrics(apiKey, shopDomain, [
      { start: twoDaysAgo.toISOString().slice(0, 10), end: yesterday.toISOString().slice(0, 10) },
    ]);

    return { success: true, sample: results[0] };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * GA4 Data API Service
 *
 * Fetches landing page metrics from Google Analytics 4 for LP diagnostic
 * cross-referencing with Meta ad destination URLs.
 *
 * Uses @google-analytics/data package (BetaAnalyticsDataClient).
 */

import { withRetry } from './retry.js';

// Lazy-load GA4 client to avoid hard crash if package isn't installed
let BetaAnalyticsDataClient = null;

async function getClientClass() {
  if (!BetaAnalyticsDataClient) {
    try {
      const mod = await import('@google-analytics/data');
      BetaAnalyticsDataClient = mod.BetaAnalyticsDataClient;
    } catch {
      throw new Error(
        'GA4 Data API package not installed. Run: npm install @google-analytics/data'
      );
    }
  }
  return BetaAnalyticsDataClient;
}

/**
 * Create an authenticated GA4 client from JSON service account credentials.
 *
 * @param {string} credentialsJson - JSON string of service account credentials
 * @returns {object} GA4 BetaAnalyticsDataClient instance
 */
async function createClient(credentialsJson) {
  const ClientClass = await getClientClass();
  const credentials = JSON.parse(credentialsJson);
  return new ClientClass({ credentials });
}

/**
 * Fetch landing page metrics from GA4.
 *
 * @param {string} credentialsJson - GA4 service account JSON credentials
 * @param {string} propertyId - GA4 property ID (e.g. "123456789")
 * @param {object} options
 * @param {string} options.startDate - YYYY-MM-DD
 * @param {string} options.endDate - YYYY-MM-DD
 * @param {number} [options.limit=100] - Max rows to return
 * @returns {Promise<object[]>} Array of landing page metric objects
 */
export async function fetchLandingPageMetrics(credentialsJson, propertyId, options = {}) {
  const { startDate, endDate, limit = 100 } = options;
  const client = await createClient(credentialsJson);

  const response = await withRetry(
    () =>
      client.runReport({
        property: `properties/${propertyId}`,
        dateRanges: [{ startDate: startDate || '30daysAgo', endDate: endDate || 'today' }],
        dimensions: [{ name: 'landingPagePlusQueryString' }],
        metrics: [
          { name: 'sessions' },
          { name: 'bounceRate' },
          { name: 'averageSessionDuration' },
          { name: 'conversions' },
          { name: 'addToCarts' },
          { name: 'ecommercePurchases' },
          { name: 'purchaseRevenue' },
        ],
        limit,
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
      }),
    { label: '[GA4]', maxRetries: 3, baseDelayMs: 2000 }
  );

  const [report] = response;
  if (!report?.rows) return [];

  return report.rows.map((row) => {
    const path = row.dimensionValues?.[0]?.value || '';
    const metrics = row.metricValues || [];

    return {
      landing_page: path,
      sessions: parseFloat(metrics[0]?.value || '0'),
      bounce_rate: parseFloat(metrics[1]?.value || '0'),
      avg_session_duration: parseFloat(metrics[2]?.value || '0'),
      conversions: parseFloat(metrics[3]?.value || '0'),
      add_to_carts: parseFloat(metrics[4]?.value || '0'),
      purchases: parseFloat(metrics[5]?.value || '0'),
      revenue: parseFloat(metrics[6]?.value || '0'),
    };
  });
}

/**
 * Cross-reference Meta ad destination URLs with GA4 landing page data.
 * Normalizes URLs to path-only for matching.
 *
 * @param {object[]} metaAds - Meta ads with destinationUrl
 * @param {object[]} ga4Pages - GA4 landing page metrics
 * @returns {object[]} Enriched LP diagnostic results
 */
export function crossReferenceWithMeta(metaAds, ga4Pages) {
  // Build lookup from normalized path → GA4 data
  const ga4Map = new Map();
  for (const page of ga4Pages) {
    const normalizedPath = normalizePath(page.landing_page);
    ga4Map.set(normalizedPath, page);
  }

  // Collect unique destination URLs across all ads
  const urlToAngles = new Map(); // path → Set of angle names
  for (const ad of metaAds) {
    if (!ad.destinationUrl) continue;
    const path = normalizePath(ad.destinationUrl);
    if (!urlToAngles.has(path)) urlToAngles.set(path, new Set());
    if (ad.angleName) urlToAngles.get(path).add(ad.angleName);
  }

  const diagnostics = [];
  for (const [path, angles] of urlToAngles) {
    const ga4 = ga4Map.get(path);
    if (!ga4) {
      diagnostics.push({
        landing_page: path,
        angles: [...angles],
        ga4_found: false,
        diagnosis: 'no_ga4_data',
        diagnosis_label: 'No GA4 Data',
      });
      continue;
    }

    const cvr = ga4.sessions > 0 ? (ga4.purchases / ga4.sessions) * 100 : 0;
    const atcRate = ga4.sessions > 0 ? (ga4.add_to_carts / ga4.sessions) * 100 : 0;

    const diagnosis = diagnoseLandingPage({
      bounceRate: ga4.bounce_rate * 100, // GA4 returns as decimal
      cvr,
      atcRate,
      avgSessionDuration: ga4.avg_session_duration,
      sessions: ga4.sessions,
    });

    diagnostics.push({
      landing_page: path,
      angles: [...angles],
      ga4_found: true,
      sessions: ga4.sessions,
      bounce_rate: ga4.bounce_rate,
      cvr,
      atc_rate: atcRate,
      avg_session_duration: ga4.avg_session_duration,
      purchases: ga4.purchases,
      revenue: ga4.revenue,
      ...diagnosis,
    });
  }

  return diagnostics;
}

/**
 * Diagnose LP problems based on metrics.
 */
function diagnoseLandingPage({ bounceRate, cvr, atcRate, avgSessionDuration, sessions }) {
  // Very short sessions — page may be broken
  if (avgSessionDuration < 30 && sessions > 10) {
    return { diagnosis: 'page_broken', diagnosis_label: 'Page Broken', severity: 'critical' };
  }

  // High bounce + low CVR — hook or message mismatch
  if (bounceRate > 55 && cvr < 1) {
    return { diagnosis: 'hook_problem', diagnosis_label: 'Hook / Message Mismatch', severity: 'warning' };
  }

  // Low bounce + low ATC — LP not convincing
  if (bounceRate <= 55 && atcRate < 3) {
    return { diagnosis: 'lp_not_convincing', diagnosis_label: 'LP Not Convincing', severity: 'warning' };
  }

  // High ATC but low CVR — checkout problem
  if (atcRate > 5 && cvr < 1) {
    return { diagnosis: 'checkout_problem', diagnosis_label: 'Checkout Problem', severity: 'info' };
  }

  // Good metrics — LP is fine
  if (cvr >= 1 && bounceRate < 55) {
    return { diagnosis: 'healthy', diagnosis_label: 'Healthy', severity: 'info' };
  }

  return { diagnosis: 'needs_review', diagnosis_label: 'Needs Review', severity: 'info' };
}

/**
 * Normalize a URL or path to a clean path for matching.
 */
function normalizePath(urlOrPath) {
  try {
    const url = new URL(urlOrPath, 'https://placeholder.com');
    return url.pathname.replace(/\/+$/, '') || '/';
  } catch {
    return (urlOrPath || '/').replace(/\/+$/, '') || '/';
  }
}

/**
 * Test GA4 connection.
 *
 * @param {string} credentialsJson
 * @param {string} propertyId
 * @returns {Promise<{ success: boolean, error?: string, sample?: object }>}
 */
export async function testConnection(credentialsJson, propertyId) {
  try {
    const results = await fetchLandingPageMetrics(credentialsJson, propertyId, {
      startDate: '7daysAgo',
      endDate: 'today',
      limit: 5,
    });
    return { success: true, pages_found: results.length, sample: results[0] || null };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

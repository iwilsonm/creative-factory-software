/**
 * Angle Evaluator Service
 *
 * Aggregates Meta ad performance data by angle, classifies tiers and spend levels,
 * and traces Meta ads back to conductor angles via ad_deployments.
 *
 * Used by the CMO Engine during the weekly review cycle.
 */

import { getCampaignAdsWithInsights } from './metaAds.js';
import {
  getConductorAngles,
  getActiveConductorAngles,
} from '../convexClient.js';

// ── Tier Classification ──────────────────────────────────────────────────────

/**
 * Classify angle tier based on CPA relative to target.
 *
 * @param {object} metrics - { spend, conversions, cpa }
 * @param {number} targetCpa - Target CPA in USD
 * @param {number} daysActive - How many days the angle has been active
 * @param {number} evaluationWindowDays - Minimum days before judging (default 12)
 * @returns {string} "T1" | "T2" | "T3" | "T4" | "too_early"
 */
export function classifyTier(metrics, targetCpa, daysActive, evaluationWindowDays = 12) {
  if (daysActive < evaluationWindowDays) return 'too_early';

  if (metrics.spend === 0) return 'T4'; // No spend at all

  if (metrics.conversions === 0) return 'T3'; // Spend but no conversions

  if (metrics.cpa <= targetCpa) return 'T1'; // Profitable

  return 'T2'; // Converting but not profitable
}

// ── Spend Classification ────────────────────────────────────────────────────

/**
 * Classify average daily spend level.
 *
 * @param {number} totalSpend
 * @param {number} daysActive
 * @returns {string} "STRONG" | "MODERATE" | "WEAK" | "NEGLIGIBLE" | "ZERO"
 */
export function classifySpend(totalSpend, daysActive) {
  if (totalSpend === 0) return 'ZERO';

  const avgDaily = daysActive > 0 ? totalSpend / daysActive : 0;

  if (avgDaily >= 50) return 'STRONG';
  if (avgDaily >= 10) return 'MODERATE';
  if (avgDaily >= 2) return 'WEAK';
  return 'NEGLIGIBLE';
}

// ── Trend Detection ────────────────────────────────────────────────────────

/**
 * Detect trend from history snapshots.
 *
 * @param {number[]} values - Array of values ordered oldest to newest
 * @returns {string} "up" | "down" | "flat"
 */
export function detectTrend(values) {
  if (values.length < 2) return 'flat';

  const recent = values.slice(-3);
  if (recent.length < 2) return 'flat';

  const first = recent[0];
  const last = recent[recent.length - 1];

  if (first === 0 && last === 0) return 'flat';
  if (first === 0) return 'up';

  const change = (last - first) / first;
  if (change > 0.1) return 'up';
  if (change < -0.1) return 'down';
  return 'flat';
}

// ── Main: Aggregate Angle Performance ────────────────────────────────────────

/**
 * Pull Meta ad data for a campaign and aggregate by angle.
 *
 * Traces Meta ads → ad_deployments → flex_ads/batch_jobs → conductor_angles.
 *
 * @param {string} projectId
 * @param {string} campaignId - Meta campaign ID to monitor
 * @param {object} options
 * @param {string} [options.trackingStartDate]
 * @param {number} [options.targetCpa] - Target CPA in USD
 * @param {number} [options.evaluationWindowDays=12]
 * @param {object[]} [options.deployments] - Pre-fetched deployments to avoid re-querying
 * @param {object[]} [options.flexAds] - Pre-fetched flex ads
 * @param {object[]} [options.batchJobs] - Pre-fetched batch jobs
 * @returns {Promise<{ metaAds: object[], angleEvaluations: object[] }>}
 */
export async function aggregateAnglePerformance(projectId, campaignId, options = {}) {
  const {
    trackingStartDate,
    targetCpa = 50,
    evaluationWindowDays = 12,
    deployments = [],
    flexAds = [],
    batchJobs = [],
  } = options;

  // Step 1: Pull all Meta ads with insights
  const metaAds = await getCampaignAdsWithInsights(projectId, campaignId, {
    trackingStartDate,
  });

  // Step 2: Get conductor angles for this project
  const angles = await getConductorAngles(projectId);
  const angleMap = new Map();
  for (const angle of angles) {
    angleMap.set(angle.name, angle);
  }

  // Step 3: Trace each Meta ad back to an angle
  // Build lookup maps
  const deploymentByMetaAdId = new Map();
  for (const dep of deployments) {
    if (dep.meta_ad_id) deploymentByMetaAdId.set(dep.meta_ad_id, dep);
  }

  const flexAdByExternalId = new Map();
  for (const fa of flexAds) {
    flexAdByExternalId.set(fa.externalId, fa);
  }

  const batchByExternalId = new Map();
  for (const b of batchJobs) {
    batchByExternalId.set(b.externalId, b);
  }

  // Trace: metaAdId → deployment → flex_ad.angle_name OR ad_creative.batch_job.angle_name
  const adToAngle = new Map(); // metaAdId → angleName
  for (const ad of metaAds) {
    const dep = deploymentByMetaAdId.get(ad.adId);
    if (!dep) continue;

    // Primary path: flex_ad
    if (dep.flex_ad_id) {
      const fa = flexAdByExternalId.get(dep.flex_ad_id);
      if (fa?.angle_name) {
        adToAngle.set(ad.adId, fa.angle_name);
        ad.angleName = fa.angle_name;
        continue;
      }
    }

    // Fallback: ad_creative → batch_job
    if (dep.ad_id) {
      // Find which batch this ad came from (by batch_job_id on the ad_creative)
      // This requires ad_creatives to be loaded — we look at batch_jobs directly
      for (const batch of batchJobs) {
        if (batch.angle_name) {
          // Check if this deployment's ad_id corresponds to an ad from this batch
          // Since we can't easily join here without ad_creatives, we use the batch-deployment link
          batchByExternalId.set(batch.externalId, batch);
        }
      }
    }
  }

  // Step 4: Aggregate metrics by angle
  const angleMetrics = new Map(); // angleName → aggregated metrics

  for (const ad of metaAds) {
    const angleName = ad.angleName || adToAngle.get(ad.adId) || 'untraced';

    if (!angleMetrics.has(angleName)) {
      angleMetrics.set(angleName, {
        angleName,
        adCount: 0,
        spend: 0,
        impressions: 0,
        clicks: 0,
        conversions: 0,
        conversionValue: 0,
        spend7d: 0,
        conversions7d: 0,
        earliestAdDate: null,
      });
    }

    const m = angleMetrics.get(angleName);
    m.adCount++;
    m.spend += ad.allTime.spend;
    m.impressions += ad.allTime.impressions;
    m.clicks += ad.allTime.clicks;
    m.conversions += ad.allTime.conversions;
    m.conversionValue += ad.allTime.conversionValue;
    m.spend7d += ad.last7Days.spend;
    m.conversions7d += ad.last7Days.conversions;

    // Track earliest ad creation date for this angle
    if (ad.createdTime) {
      const adDate = new Date(ad.createdTime);
      if (!m.earliestAdDate || adDate < m.earliestAdDate) {
        m.earliestAdDate = adDate;
      }
    }
  }

  // Step 5: Compute derived metrics and classify
  const now = new Date();
  const evaluations = [];

  for (const [angleName, m] of angleMetrics) {
    const daysActive = m.earliestAdDate
      ? Math.floor((now - m.earliestAdDate) / (1000 * 60 * 60 * 24))
      : 0;

    const cpa = m.conversions > 0 ? m.spend / m.conversions : null;
    const roas = m.spend > 0 ? m.conversionValue / m.spend : null;
    const ctr = m.impressions > 0 ? (m.clicks / m.impressions) * 100 : 0;
    const cpc = m.clicks > 0 ? m.spend / m.clicks : null;

    const tier = classifyTier(
      { spend: m.spend, conversions: m.conversions, cpa: cpa || Infinity },
      targetCpa,
      daysActive,
      evaluationWindowDays
    );

    const spendClass = classifySpend(m.spend, daysActive);

    const angle = angleMap.get(angleName);

    evaluations.push({
      angleName,
      adCount: m.adCount,
      daysActive,
      spend: Math.round(m.spend * 100) / 100,
      impressions: m.impressions,
      clicks: m.clicks,
      conversions: m.conversions,
      conversionValue: Math.round(m.conversionValue * 100) / 100,
      cpa: cpa ? Math.round(cpa * 100) / 100 : null,
      roas: roas ? Math.round(roas * 100) / 100 : null,
      ctr: Math.round(ctr * 100) / 100,
      cpc: cpc ? Math.round(cpc * 100) / 100 : null,
      tier,
      spendClass,
      priority: angle?.priority || null,
      status: angle?.status || null,
      frame: angle?.frame || null,
      spend7d: Math.round(m.spend7d * 100) / 100,
      conversions7d: m.conversions7d,
    });
  }

  // Sort: T1 first, then by spend descending
  const tierOrder = { T1: 0, T2: 1, too_early: 2, T3: 3, T4: 4 };
  evaluations.sort((a, b) => {
    const tierDiff = (tierOrder[a.tier] ?? 5) - (tierOrder[b.tier] ?? 5);
    if (tierDiff !== 0) return tierDiff;
    return b.spend - a.spend;
  });

  return { metaAds, angleEvaluations: evaluations };
}

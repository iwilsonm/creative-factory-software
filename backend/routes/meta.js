import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { getSetting, setSetting, updateDeployment, getMetaPerformanceByDeployment, getMetaPerformanceByMetaAdId, deleteMetaPerformanceByDeployment, getAllDeployments } from '../convexClient.js';
import * as metaAds from '../services/metaAds.js';

const router = Router();
router.use(requireAuth);

// Helper to build the OAuth redirect URI from the request
function getRedirectUri(req) {
  const proto = req.protocol;
  const host = req.get('host');
  return `${proto}://${host}/api/meta/callback`;
}

// ── OAuth Flow ──────────────────────────────────────────────────────────────

/**
 * GET /api/meta/auth-url
 * Returns the Meta OAuth URL for the frontend to redirect to.
 */
router.get('/meta/auth-url', async (req, res) => {
  try {
    const redirectUri = getRedirectUri(req);
    const url = await metaAds.getOAuthUrl(redirectUri);
    res.json({ url });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /api/meta/callback
 * OAuth callback — exchanges code for token, redirects to Settings.
 */
router.get('/meta/callback', async (req, res) => {
  try {
    const { code, state, error: oauthError } = req.query;

    if (oauthError) {
      return res.redirect('/settings?meta=error&message=' + encodeURIComponent(oauthError));
    }

    // Verify CSRF state
    const savedState = await getSetting('meta_oauth_state');
    if (state && savedState && state !== savedState) {
      return res.redirect('/settings?meta=error&message=Invalid+state+parameter');
    }

    const redirectUri = getRedirectUri(req);
    await metaAds.handleOAuthCallback(code, redirectUri);

    res.redirect('/settings?meta=connected');
  } catch (err) {
    console.error('[Meta] OAuth callback error:', err);
    res.redirect('/settings?meta=error&message=' + encodeURIComponent(err.message));
  }
});

/**
 * POST /api/meta/disconnect
 * Clears all Meta settings.
 */
router.post('/meta/disconnect', async (req, res) => {
  try {
    await metaAds.disconnectMeta();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/meta/status
 * Returns connection status.
 */
router.get('/meta/status', async (req, res) => {
  try {
    const status = await metaAds.isMetaConnected();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Ad Account Selection ────────────────────────────────────────────────────

/**
 * GET /api/meta/ad-accounts
 * Lists ad accounts for the connected user.
 */
router.get('/meta/ad-accounts', async (req, res) => {
  try {
    const accounts = await metaAds.getAdAccounts();
    res.json({ accounts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/meta/ad-account
 * Saves the selected ad account ID.
 */
router.post('/meta/ad-account', async (req, res) => {
  try {
    const { adAccountId } = req.body;
    if (!adAccountId) return res.status(400).json({ error: 'adAccountId required' });
    await setSetting('meta_ad_account_id', adAccountId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Campaign Browser ────────────────────────────────────────────────────────

/**
 * GET /api/meta/campaigns
 * Lists campaigns for the selected ad account.
 */
router.get('/meta/campaigns', async (req, res) => {
  try {
    const campaigns = await metaAds.getCampaigns();
    res.json({ campaigns });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/meta/campaigns/:campaignId/adsets
 * Lists ad sets within a campaign.
 */
router.get('/meta/campaigns/:campaignId/adsets', async (req, res) => {
  try {
    const adsets = await metaAds.getAdSets(req.params.campaignId);
    res.json({ adsets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/meta/adsets/:adsetId/ads
 * Lists ads within an ad set.
 */
router.get('/meta/adsets/:adsetId/ads', async (req, res) => {
  try {
    const ads = await metaAds.getAds(req.params.adsetId);
    res.json({ ads });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Linking ─────────────────────────────────────────────────────────────────

/**
 * POST /api/meta/link
 * Links a deployment to a Meta Ad.
 */
router.post('/meta/link', async (req, res) => {
  try {
    const { deploymentId, metaAdId, metaCampaignId, metaAdsetId } = req.body;
    if (!deploymentId || !metaAdId) return res.status(400).json({ error: 'deploymentId and metaAdId required' });

    // Update deployment with Meta IDs
    await updateDeployment(deploymentId, {
      meta_ad_id: metaAdId,
      meta_campaign_id: metaCampaignId || undefined,
      meta_adset_id: metaAdsetId || undefined,
    });

    // Fetch initial metrics
    let metrics = null;
    try {
      const dailyMetrics = await metaAds.getAdInsights(metaAdId, 30);
      // Upsert all daily rows
      const { v4: uuidv4 } = await import('uuid');
      for (const day of dailyMetrics) {
        await (await import('../convexClient.js')).upsertMetaPerformance({
          externalId: uuidv4(),
          deployment_id: deploymentId,
          meta_ad_id: metaAdId,
          date: day.date,
          impressions: day.impressions,
          clicks: day.clicks,
          spend: day.spend,
          reach: day.reach,
          ctr: day.ctr,
          cpc: day.cpc,
          cpm: day.cpm,
          conversions: day.conversions,
          conversion_value: day.conversionValue,
          frequency: day.frequency,
        });
      }
      // Return totals
      if (dailyMetrics.length > 0) {
        metrics = {
          impressions: dailyMetrics.reduce((s, d) => s + d.impressions, 0),
          clicks: dailyMetrics.reduce((s, d) => s + d.clicks, 0),
          spend: dailyMetrics.reduce((s, d) => s + d.spend, 0),
        };
      }
    } catch (err) {
      console.warn('[Meta] Initial insights fetch failed:', err.message);
    }

    res.json({ success: true, metrics });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/meta/unlink
 * Unlinks a deployment from Meta.
 */
router.post('/meta/unlink', async (req, res) => {
  try {
    const { deploymentId } = req.body;
    if (!deploymentId) return res.status(400).json({ error: 'deploymentId required' });

    await updateDeployment(deploymentId, {
      meta_ad_id: '',
      meta_campaign_id: '',
      meta_adset_id: '',
    });

    await deleteMetaPerformanceByDeployment(deploymentId);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Performance Data ────────────────────────────────────────────────────────

/**
 * GET /api/meta/performance/:deploymentId
 * Returns cached metrics for a deployment.
 */
router.get('/meta/performance/:deploymentId', async (req, res) => {
  try {
    const rows = await getMetaPerformanceByDeployment(req.params.deploymentId);

    // Aggregate totals
    const totals = {
      impressions: 0, clicks: 0, spend: 0, reach: 0,
      conversions: 0, conversionValue: 0,
    };
    for (const r of rows) {
      totals.impressions += r.impressions;
      totals.clicks += r.clicks;
      totals.spend += r.spend;
      totals.reach += r.reach;
      totals.conversions += r.conversions;
      totals.conversionValue += r.conversion_value;
    }
    totals.ctr = totals.impressions > 0 ? (totals.clicks / totals.impressions * 100) : 0;
    totals.cpc = totals.clicks > 0 ? (totals.spend / totals.clicks) : 0;
    totals.cpm = totals.impressions > 0 ? (totals.spend / totals.impressions * 1000) : 0;
    totals.roas = totals.spend > 0 ? (totals.conversionValue / totals.spend) : 0;

    res.json({ totals, daily: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/meta/performance/summary?projectId=XXX
 * Aggregated metrics for all linked deployments in a project.
 */
router.get('/meta/performance/summary', async (req, res) => {
  try {
    const { projectId } = req.query;
    const allDeps = await getAllDeployments();
    const linkedDeps = allDeps.filter(d => d.meta_ad_id && (!projectId || d.project_id === projectId));

    if (linkedDeps.length === 0) {
      return res.json({ totalSpend: 0, totalImpressions: 0, totalClicks: 0, avgCTR: 0, avgCPC: 0, ads: [] });
    }

    // Deduplicate by meta_ad_id for aggregate
    const seenMetaAds = new Set();
    const adSummaries = [];

    for (const dep of linkedDeps) {
      if (seenMetaAds.has(dep.meta_ad_id)) continue;
      seenMetaAds.add(dep.meta_ad_id);

      const rows = await getMetaPerformanceByMetaAdId(dep.meta_ad_id);
      const totals = { impressions: 0, clicks: 0, spend: 0, conversions: 0, conversionValue: 0 };
      for (const r of rows) {
        totals.impressions += r.impressions;
        totals.clicks += r.clicks;
        totals.spend += r.spend;
        totals.conversions += r.conversions;
        totals.conversionValue += r.conversion_value;
      }

      adSummaries.push({
        metaAdId: dep.meta_ad_id,
        deploymentId: dep.externalId,
        adName: dep.ad_name || dep.externalId.slice(0, 8),
        ...totals,
        ctr: totals.impressions > 0 ? (totals.clicks / totals.impressions * 100) : 0,
        cpc: totals.clicks > 0 ? (totals.spend / totals.clicks) : 0,
        cpm: totals.impressions > 0 ? (totals.spend / totals.impressions * 1000) : 0,
        roas: totals.spend > 0 ? (totals.conversionValue / totals.spend) : 0,
      });
    }

    const totalSpend = adSummaries.reduce((s, a) => s + a.spend, 0);
    const totalImpressions = adSummaries.reduce((s, a) => s + a.impressions, 0);
    const totalClicks = adSummaries.reduce((s, a) => s + a.clicks, 0);

    res.json({
      totalSpend,
      totalImpressions,
      totalClicks,
      avgCTR: totalImpressions > 0 ? (totalClicks / totalImpressions * 100) : 0,
      avgCPC: totalClicks > 0 ? (totalSpend / totalClicks) : 0,
      ads: adSummaries,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/meta/sync
 * Manual sync trigger.
 */
router.post('/meta/sync', async (req, res) => {
  try {
    const result = await metaAds.syncMetaPerformance();
    res.json(result || { synced: 0, failed: 0, total: 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

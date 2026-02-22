import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { getSetting, setSetting, updateProject, updateDeployment, getMetaPerformanceByDeployment, getMetaPerformanceByMetaAdId, deleteMetaPerformanceByDeployment, getAllDeployments } from '../convexClient.js';
import * as metaAds from '../services/metaAds.js';

const router = Router();
router.use(requireAuth);

// Helper to build the OAuth redirect URI from the request
function getRedirectUri(req) {
  const proto = req.protocol;
  const host = req.get('host');
  return `${proto}://${host}/api/meta/callback`;
}

// ══════════════════════════════════════════════════════════════════════════════
// OAuth Callback — GLOBAL (Meta always redirects here, projectId is in state)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/meta/callback
 * OAuth callback — exchanges code for token, redirects to project page.
 */
router.get('/meta/callback', async (req, res) => {
  try {
    const { code, state, error: oauthError } = req.query;

    // Decode projectId from state
    let projectId = null;
    if (state) {
      try {
        const stateObj = JSON.parse(Buffer.from(state, 'base64url').toString());
        projectId = stateObj.projectId;
      } catch {
        // Legacy state format or corrupted — fallback
      }
    }

    const redirectBase = projectId ? `/projects/${projectId}` : '/settings';

    if (oauthError) {
      return res.redirect(`${redirectBase}?meta=error&message=${encodeURIComponent(oauthError)}`);
    }

    // Verify CSRF state
    const savedState = await getSetting('meta_oauth_state');
    if (state && savedState && state !== savedState) {
      return res.redirect(`${redirectBase}?meta=error&message=Invalid+state+parameter`);
    }

    if (!projectId) {
      return res.redirect('/settings?meta=error&message=Missing+project+context');
    }

    const redirectUri = getRedirectUri(req);
    await metaAds.handleOAuthCallback(code, redirectUri, projectId);

    res.redirect(`${redirectBase}?meta=connected`);
  } catch (err) {
    console.error('[Meta] OAuth callback error:', err);
    res.redirect('/settings?meta=error&message=' + encodeURIComponent(err.message));
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// Project-scoped Meta routes: /api/projects/:projectId/meta/*
// ══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/projects/:projectId/meta/auth-url
 * Returns the Meta OAuth URL for the frontend to redirect to.
 */
router.get('/projects/:projectId/meta/auth-url', async (req, res) => {
  try {
    const { projectId } = req.params;
    const redirectUri = getRedirectUri(req);
    const url = await metaAds.getOAuthUrl(projectId, redirectUri);
    res.json({ url });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /api/projects/:projectId/meta/disconnect
 * Clears Meta fields on this project.
 */
router.post('/projects/:projectId/meta/disconnect', async (req, res) => {
  try {
    await metaAds.disconnectMeta(req.params.projectId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/projects/:projectId/meta/status
 * Returns connection status for this project.
 */
router.get('/projects/:projectId/meta/status', async (req, res) => {
  try {
    const status = await metaAds.isMetaConnected(req.params.projectId);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Ad Account Selection ────────────────────────────────────────────────────

/**
 * GET /api/projects/:projectId/meta/ad-accounts
 * Lists ad accounts for this project's connected Meta user.
 */
router.get('/projects/:projectId/meta/ad-accounts', async (req, res) => {
  try {
    const accounts = await metaAds.getAdAccounts(req.params.projectId);
    res.json({ accounts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/projects/:projectId/meta/ad-account
 * Saves the selected ad account ID on the project.
 */
router.post('/projects/:projectId/meta/ad-account', async (req, res) => {
  try {
    const { adAccountId } = req.body;
    if (!adAccountId) return res.status(400).json({ error: 'adAccountId required' });
    await updateProject(req.params.projectId, { meta_ad_account_id: adAccountId });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Campaign Browser ────────────────────────────────────────────────────────

router.get('/projects/:projectId/meta/campaigns', async (req, res) => {
  try {
    const campaigns = await metaAds.getCampaigns(req.params.projectId);
    res.json({ campaigns });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/projects/:projectId/meta/campaigns/:campaignId/adsets', async (req, res) => {
  try {
    const adsets = await metaAds.getAdSets(req.params.projectId, req.params.campaignId);
    res.json({ adsets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/projects/:projectId/meta/adsets/:adsetId/ads', async (req, res) => {
  try {
    const ads = await metaAds.getAds(req.params.projectId, req.params.adsetId);
    res.json({ ads });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Linking ─────────────────────────────────────────────────────────────────

router.post('/projects/:projectId/meta/link', async (req, res) => {
  try {
    const { projectId } = req.params;
    const { deploymentId, metaAdId, metaCampaignId, metaAdsetId } = req.body;
    if (!deploymentId || !metaAdId) return res.status(400).json({ error: 'deploymentId and metaAdId required' });

    await updateDeployment(deploymentId, {
      meta_ad_id: metaAdId,
      meta_campaign_id: metaCampaignId || undefined,
      meta_adset_id: metaAdsetId || undefined,
    });

    // Fetch initial metrics
    let metrics = null;
    try {
      const { v4: uuidv4 } = await import('uuid');
      const dailyMetrics = await metaAds.getAdInsights(projectId, metaAdId, 30);
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

router.post('/projects/:projectId/meta/unlink', async (req, res) => {
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

router.get('/projects/:projectId/meta/performance/:deploymentId', async (req, res) => {
  try {
    const rows = await getMetaPerformanceByDeployment(req.params.deploymentId);

    const totals = { impressions: 0, clicks: 0, spend: 0, reach: 0, conversions: 0, conversionValue: 0 };
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

router.get('/projects/:projectId/meta/performance/summary', async (req, res) => {
  try {
    const { projectId } = req.params;
    const allDeps = await getAllDeployments();
    const linkedDeps = allDeps.filter(d => d.meta_ad_id && d.project_id === projectId);

    if (linkedDeps.length === 0) {
      return res.json({ totalSpend: 0, totalImpressions: 0, totalClicks: 0, avgCTR: 0, avgCPC: 0, ads: [] });
    }

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

// ══════════════════════════════════════════════════════════════════════════════
// Top Performers — used by Dacia Creative Filter (Agent #2) as scoring context
// ══════════════════════════════════════════════════════════════════════════════

router.get('/projects/:projectId/meta/top-performers', async (req, res) => {
  try {
    const { projectId } = req.params;
    const allDeps = await getAllDeployments();
    const linkedDeps = allDeps.filter(d => d.meta_ad_id && d.project_id === projectId);

    if (linkedDeps.length === 0) {
      return res.json([]);
    }

    const seenMetaAds = new Set();
    const adSummaries = [];

    for (const dep of linkedDeps) {
      if (seenMetaAds.has(dep.meta_ad_id)) continue;
      seenMetaAds.add(dep.meta_ad_id);

      const rows = await getMetaPerformanceByMetaAdId(dep.meta_ad_id);
      if (!rows.length) continue;

      const totals = { impressions: 0, clicks: 0, spend: 0, conversions: 0, conversionValue: 0 };
      for (const r of rows) {
        totals.impressions += r.impressions;
        totals.clicks += r.clicks;
        totals.spend += r.spend;
        totals.conversions += r.conversions;
        totals.conversionValue += r.conversion_value;
      }

      adSummaries.push({
        deployment_id: dep.externalId,
        headline: dep.ad_headlines ? (JSON.parse(dep.ad_headlines)?.[0] || dep.ad_name || '') : (dep.ad_name || ''),
        primary_text: dep.primary_texts ? (JSON.parse(dep.primary_texts)?.[0] || '') : '',
        ...totals,
        cpc: totals.clicks > 0 ? +(totals.spend / totals.clicks).toFixed(2) : 0,
        roas: totals.spend > 0 ? +(totals.conversionValue / totals.spend).toFixed(2) : 0,
      });
    }

    // Sort by ROAS descending, then by CPC ascending (best performers first)
    adSummaries.sort((a, b) => {
      if (b.roas !== a.roas) return b.roas - a.roas;
      return a.cpc - b.cpc;
    });

    // Return top 10
    res.json(adSummaries.slice(0, 10));
  } catch (err) {
    console.error('[Meta] Top performers error:', err.message);
    res.json([]); // Graceful fallback — don't block filter
  }
});

router.post('/projects/:projectId/meta/sync', async (req, res) => {
  try {
    const result = await metaAds.syncMetaPerformance(req.params.projectId);
    res.json(result || { synced: 0, failed: 0, total: 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

/**
 * metaAds.js — Meta Marketing API wrapper (per-project)
 *
 * Each project has its own Meta OAuth token and ad account.
 * Each project also has its own App ID + App Secret (developer credentials).
 * All Meta data lives on the project record — nothing is global.
 */

import fetch from 'node-fetch';
import { v4 as uuidv4 } from 'uuid';
import { getSetting, setSetting, getProject, updateProject, getAllDeployments, upsertMetaPerformance } from '../convexClient.js';
import { withRetry } from './retry.js';

const META_GRAPH_URL = 'https://graph.facebook.com/v21.0';

// ── Token Management ────────────────────────────────────────────────────────

/**
 * Get a valid access token for a project, auto-refreshing if near expiry.
 * @param {string} projectId
 * @returns {Promise<string>} The Meta access token
 */
export async function getAccessToken(projectId) {
  const project = await getProject(projectId);
  if (!project) throw new Error('Project not found');

  const token = project.meta_access_token;
  if (!token) throw new Error('Meta not connected for this project. Connect in the project Overview tab.');

  const expiresAt = project.meta_token_expires_at;
  if (expiresAt) {
    const daysUntilExpiry = (new Date(expiresAt) - Date.now()) / (1000 * 60 * 60 * 24);
    if (daysUntilExpiry < 7) {
      try {
        await refreshLongLivedToken(projectId, token);
      } catch (err) {
        console.warn(`[Meta] Token refresh failed for project ${projectId.slice(0, 8)}:`, err.message);
      }
    }
    if (daysUntilExpiry < 0) {
      throw new Error('Meta access token expired. Please reconnect in the project Overview tab.');
    }
  }

  return token;
}

/**
 * Exchange current token for a fresh long-lived token (~60 days).
 * @param {string} projectId
 * @param {string} currentToken - The current (possibly short-lived) access token
 * @returns {Promise<void>}
 */
async function refreshLongLivedToken(projectId, currentToken) {
  const project = await getProject(projectId);
  const appId = project?.meta_app_id;
  const appSecret = project?.meta_app_secret;
  if (!appId || !appSecret) throw new Error('Meta App ID/Secret not configured for this project. Enter them in the project Overview tab.');

  const url = `${META_GRAPH_URL}/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${currentToken}`;
  const res = await fetch(url);
  const data = await res.json();

  if (data.error) throw new Error(data.error.message);

  const expiresAt = new Date(Date.now() + (data.expires_in || 5184000) * 1000).toISOString();
  await updateProject(projectId, {
    meta_access_token: data.access_token,
    meta_token_expires_at: expiresAt,
  });
  console.log(`[Meta] Token refreshed for project ${projectId.slice(0, 8)}, new expiry:`, expiresAt);
}

/**
 * Refresh token if needed (called by scheduler for each project).
 * @param {string} projectId
 * @returns {Promise<void>}
 */
export async function refreshMetaTokenIfNeeded(projectId) {
  const project = await getProject(projectId);
  if (!project || !project.meta_access_token) return;

  const expiresAt = project.meta_token_expires_at;
  if (!expiresAt) return;

  const daysUntilExpiry = (new Date(expiresAt) - Date.now()) / (1000 * 60 * 60 * 24);
  if (daysUntilExpiry < 14) {
    await refreshLongLivedToken(projectId, project.meta_access_token);
  }
}

/**
 * Check if Meta is connected for a project.
 * @param {string} projectId
 * @returns {Promise<{ connected: boolean, appConfigured: boolean, userName?: string, adAccountId?: string, tokenExpiresAt?: string, lastSyncAt?: string }>}
 */
export async function isMetaConnected(projectId) {
  const project = await getProject(projectId);
  if (!project || !project.meta_access_token) {
    // Check if this project has app credentials configured
    return { connected: false, appConfigured: !!(project?.meta_app_id) };
  }

  return {
    connected: true,
    appConfigured: true,
    userName: project.meta_user_name || null,
    adAccountId: project.meta_ad_account_id || null,
    tokenExpiresAt: project.meta_token_expires_at || null,
    lastSyncAt: project.meta_last_sync_at || null,
  };
}

// ── Graph API Helper ────────────────────────────────────────────────────────

async function graphGet(path, token) {
  const url = path.startsWith('http') ? path : `${META_GRAPH_URL}${path}`;
  const separator = url.includes('?') ? '&' : '?';
  const fullUrl = `${url}${separator}access_token=${token}`;

  return withRetry(async () => {
    const res = await fetch(fullUrl);
    const data = await res.json();

    if (data.error) {
      const err = new Error(data.error.message || 'Meta API error');
      err.code = data.error.code;
      err.status = res.status;
      if (data.error.code === 4 || data.error.code === 17 || res.status === 429) {
        err.retryable = true;
      }
      if (data.error.code === 190) {
        err.tokenExpired = true;
      }
      throw err;
    }

    return data;
  }, { maxRetries: 3, label: 'Meta Graph API' });
}

// ── Account Discovery ───────────────────────────────────────────────────────

/**
 * List available Meta ad accounts for a project.
 * @param {string} projectId
 * @returns {Promise<Array<{ id: string, name: string, accountId: string, status: number }>>}
 */
export async function getAdAccounts(projectId) {
  const token = await getAccessToken(projectId);
  const data = await graphGet('/me/adaccounts?fields=name,account_id,account_status&limit=100', token);
  return (data.data || []).map(a => ({
    id: a.id,
    name: a.name,
    accountId: a.account_id,
    status: a.account_status,
  }));
}

// ── Campaign Browser ────────────────────────────────────────────────────────

/**
 * List campaigns in the project's selected ad account.
 * @param {string} projectId
 * @returns {Promise<Array<{ id: string, name: string, status: string, objective: string }>>}
 */
export async function getCampaigns(projectId) {
  const token = await getAccessToken(projectId);
  const project = await getProject(projectId);
  const adAccountId = project?.meta_ad_account_id;
  if (!adAccountId) throw new Error('No ad account selected for this project.');

  const data = await graphGet(
    `/${adAccountId}/campaigns?fields=name,status,objective,created_time&limit=100&filtering=[{"field":"effective_status","operator":"IN","value":["ACTIVE","PAUSED"]}]`,
    token
  );
  return (data.data || []).map(c => ({
    id: c.id,
    name: c.name,
    status: c.status,
    objective: c.objective,
  }));
}

/**
 * List ad sets in a campaign.
 * @param {string} projectId
 * @param {string} campaignId - Meta campaign ID
 * @returns {Promise<Array<{ id: string, name: string, status: string, dailyBudget: string|null }>>}
 */
export async function getAdSets(projectId, campaignId) {
  const token = await getAccessToken(projectId);
  const data = await graphGet(
    `/${campaignId}/adsets?fields=name,status,daily_budget,lifetime_budget&limit=100&filtering=[{"field":"effective_status","operator":"IN","value":["ACTIVE","PAUSED"]}]`,
    token
  );
  return (data.data || []).map(a => ({
    id: a.id,
    name: a.name,
    status: a.status,
    dailyBudget: a.daily_budget ? (parseInt(a.daily_budget) / 100).toFixed(2) : null,
  }));
}

/**
 * List ads in an ad set.
 * @param {string} projectId
 * @param {string} adSetId - Meta ad set ID
 * @returns {Promise<Array<{ id: string, name: string, status: string, thumbnailUrl: string|null, createdTime: string }>>}
 */
export async function getAds(projectId, adSetId) {
  const token = await getAccessToken(projectId);
  const data = await graphGet(
    `/${adSetId}/ads?fields=name,status,creative{thumbnail_url,title,body},created_time&limit=100`,
    token
  );
  return (data.data || []).map(a => ({
    id: a.id,
    name: a.name,
    status: a.status,
    thumbnailUrl: a.creative?.thumbnail_url || null,
    createdTime: a.created_time,
  }));
}

// ── Insights ────────────────────────────────────────────────────────────────

/**
 * Get daily performance metrics for a specific Meta ad.
 * @param {string} projectId
 * @param {string} adId - Meta ad ID
 * @param {number} [sinceDays=30] - Number of days to look back
 * @returns {Promise<Array<{ date: string, impressions: number, clicks: number, spend: number, reach: number, ctr: number, cpc: number, cpm: number, frequency: number, conversions: number, conversionValue: number }>>}
 */
export async function getAdInsights(projectId, adId, sinceDays = 30) {
  const token = await getAccessToken(projectId);
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const until = new Date().toISOString().split('T')[0];

  const data = await graphGet(
    `/${adId}/insights?fields=impressions,clicks,spend,ctr,cpc,cpm,reach,frequency,actions,action_values&time_range={"since":"${since}","until":"${until}"}&time_increment=1&limit=100`,
    token
  );

  return (data.data || []).map(parseInsightsRow);
}

function parseInsightsRow(row) {
  let conversions = 0;
  if (row.actions) {
    const purchase = row.actions.find(a => a.action_type === 'purchase' || a.action_type === 'offsite_conversion.fb_pixel_purchase');
    if (purchase) conversions = parseInt(purchase.value) || 0;
  }

  let conversionValue = 0;
  if (row.action_values) {
    const purchaseVal = row.action_values.find(a => a.action_type === 'purchase' || a.action_type === 'offsite_conversion.fb_pixel_purchase');
    if (purchaseVal) conversionValue = parseFloat(purchaseVal.value) || 0;
  }

  return {
    date: row.date_start,
    impressions: parseInt(row.impressions) || 0,
    clicks: parseInt(row.clicks) || 0,
    spend: parseFloat(row.spend) || 0,
    reach: parseInt(row.reach) || 0,
    ctr: parseFloat(row.ctr) || 0,
    cpc: parseFloat(row.cpc) || 0,
    cpm: parseFloat(row.cpm) || 0,
    frequency: parseFloat(row.frequency) || 0,
    conversions,
    conversionValue,
  };
}

// ── Campaign-Level Ad Fetching (CMO Agent) ──────────────────────────────────

/**
 * Get all ads from a campaign with destination URLs and performance insights.
 * Used by the CMO Agent to evaluate angle performance.
 *
 * @param {string} projectId
 * @param {string} campaignId - Meta campaign ID
 * @param {object} [options]
 * @param {string} [options.trackingStartDate] - YYYY-MM-DD, defaults to 90 days ago
 * @returns {Promise<Array<{ adId, adName, createdTime, destinationUrl, status, allTime: {...}, last7Days: {...} }>>}
 */
export async function getCampaignAdsWithInsights(projectId, campaignId, options = {}) {
  const token = await getAccessToken(projectId);

  // Step 1: Fetch all ads in the campaign (via ad sets)
  const adSetsData = await graphGet(
    `/${campaignId}/adsets?fields=id&limit=100`,
    token
  );
  const adSetIds = (adSetsData.data || []).map(a => a.id);

  const allAds = [];
  for (const adSetId of adSetIds) {
    const adsData = await graphGet(
      `/${adSetId}/ads?fields=id,name,status,created_time,adcreatives{object_story_spec,effective_object_story_id,link_url}&limit=200`,
      token
    );
    for (const ad of (adsData.data || [])) {
      // Extract destination URL from creative
      let destinationUrl = null;
      const creative = ad.adcreatives?.data?.[0];
      if (creative) {
        destinationUrl = creative.link_url
          || creative.object_story_spec?.link_data?.link
          || creative.object_story_spec?.link_data?.call_to_action?.value?.link
          || null;
      }

      allAds.push({
        adId: ad.id,
        adName: ad.name,
        status: ad.status,
        createdTime: ad.created_time,
        destinationUrl,
        adSetId,
      });
    }
  }

  // Step 2: Fetch insights for each ad (all-time + last 7 days)
  const trackingStart = options.trackingStartDate
    || new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);
  const d7ago = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const results = [];
  for (const ad of allAds) {
    try {
      // All-time insights
      const allTimeData = await graphGet(
        `/${ad.adId}/insights?fields=impressions,clicks,spend,ctr,cpc,cpm,reach,frequency,actions,action_values&time_range={"since":"${trackingStart}","until":"${today}"}&limit=1`,
        token
      );
      const allTime = (allTimeData.data || []).length > 0
        ? parseInsightsRow(allTimeData.data[0])
        : { impressions: 0, clicks: 0, spend: 0, ctr: 0, cpc: 0, cpm: 0, reach: 0, frequency: 0, conversions: 0, conversionValue: 0 };

      // Last 7 days insights
      const last7Data = await graphGet(
        `/${ad.adId}/insights?fields=impressions,clicks,spend,ctr,cpc,cpm,reach,frequency,actions,action_values&time_range={"since":"${d7ago}","until":"${today}"}&limit=1`,
        token
      );
      const last7Days = (last7Data.data || []).length > 0
        ? parseInsightsRow(last7Data.data[0])
        : { impressions: 0, clicks: 0, spend: 0, ctr: 0, cpc: 0, cpm: 0, reach: 0, frequency: 0, conversions: 0, conversionValue: 0 };

      results.push({
        ...ad,
        allTime,
        last7Days,
      });
    } catch (err) {
      // Log but don't fail the whole batch
      console.error(`[Meta CMO] Failed to get insights for ad ${ad.adId}:`, err.message);
      results.push({
        ...ad,
        allTime: { impressions: 0, clicks: 0, spend: 0, ctr: 0, cpc: 0, cpm: 0, reach: 0, frequency: 0, conversions: 0, conversionValue: 0 },
        last7Days: { impressions: 0, clicks: 0, spend: 0, ctr: 0, cpc: 0, cpm: 0, reach: 0, frequency: 0, conversions: 0, conversionValue: 0 },
      });
    }
  }

  return results;
}

// ── Sync ────────────────────────────────────────────────────────────────────

/**
 * Sync performance data for all linked deployments in a project.
 * @param {string} projectId
 * @returns {Promise<{ synced: number, failed: number, total: number }>}
 */
export async function syncMetaPerformance(projectId) {
  const status = await isMetaConnected(projectId);
  if (!status.connected || !status.adAccountId) return { synced: 0, failed: 0, total: 0 };

  // Get all deployments for this project that have a meta_ad_id
  const allDeps = await getAllDeployments();
  const linkedDeps = allDeps.filter(d => d.meta_ad_id && d.project_id === projectId);

  if (linkedDeps.length === 0) return { synced: 0, failed: 0, total: 0 };

  // Deduplicate by meta_ad_id
  const metaAdMap = new Map();
  for (const dep of linkedDeps) {
    if (!metaAdMap.has(dep.meta_ad_id)) {
      metaAdMap.set(dep.meta_ad_id, dep);
    }
  }

  let synced = 0;
  let failed = 0;

  for (const [metaAdId, dep] of metaAdMap) {
    try {
      const dailyMetrics = await getAdInsights(projectId, metaAdId, 7);

      for (const day of dailyMetrics) {
        await upsertMetaPerformance({
          externalId: uuidv4(),
          deployment_id: dep.externalId,
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

      synced++;
    } catch (err) {
      console.error(`[Meta Sync] Failed for ad ${metaAdId} (project ${projectId.slice(0, 8)}):`, err.message);
      failed++;
    }
  }

  await updateProject(projectId, { meta_last_sync_at: new Date().toISOString() });
  console.log(`[Meta Sync] Project ${projectId.slice(0, 8)}: ${synced} synced, ${failed} failed out of ${metaAdMap.size} unique Meta Ads`);

  return { synced, failed, total: metaAdMap.size };
}

// ── OAuth Helpers ───────────────────────────────────────────────────────────

/**
 * Build the OAuth authorization URL.
 * Encodes projectId in the state parameter so the callback knows which project to save to.
 * @param {string} projectId
 * @param {string} redirectUri - The OAuth redirect URL
 * @returns {Promise<string>} The full Facebook OAuth authorization URL
 */
export async function getOAuthUrl(projectId, redirectUri) {
  const project = await getProject(projectId);
  const appId = project?.meta_app_id;
  if (!appId) throw new Error('Meta App ID not configured for this project. Enter it in the project Overview tab.');

  // Include projectId in state for the callback to extract
  // Use per-project key to avoid race conditions with concurrent OAuth flows
  const stateObj = { csrf: uuidv4(), projectId };
  const state = Buffer.from(JSON.stringify(stateObj)).toString('base64url');
  await setSetting(`meta_oauth_state_${projectId}`, state);

  return `https://www.facebook.com/v21.0/dialog/oauth?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=ads_read&state=${state}`;
}

/**
 * Exchange authorization code for tokens and store them on the project.
 * @param {string} code - The OAuth authorization code from Facebook
 * @param {string} redirectUri - Must match the redirect URI used in getOAuthUrl
 * @param {string} projectId
 * @returns {Promise<{ userName: string, expiresAt: string }>}
 */
export async function handleOAuthCallback(code, redirectUri, projectId, stateParam) {
  // Validate CSRF state parameter
  const storedState = await getSetting(`meta_oauth_state_${projectId}`);
  if (!storedState || storedState !== stateParam) {
    throw new Error('OAuth state mismatch — possible CSRF attack. Please try connecting again.');
  }
  // Clear the state after validation (one-time use)
  await setSetting(`meta_oauth_state_${projectId}`, '');

  const project = await getProject(projectId);
  const appId = project?.meta_app_id;
  const appSecret = project?.meta_app_secret;
  if (!appId || !appSecret) throw new Error('Meta App ID/Secret not configured for this project');

  // Exchange code for short-lived token
  const tokenUrl = `${META_GRAPH_URL}/oauth/access_token?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&client_secret=${appSecret}&code=${code}`;
  const tokenRes = await fetch(tokenUrl);
  const tokenData = await tokenRes.json();

  if (tokenData.error) throw new Error(tokenData.error.message);

  // Exchange short-lived for long-lived token
  const longUrl = `${META_GRAPH_URL}/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${tokenData.access_token}`;
  const longRes = await fetch(longUrl);
  const longData = await longRes.json();

  if (longData.error) throw new Error(longData.error.message);

  const accessToken = longData.access_token;
  const expiresIn = longData.expires_in || 5184000;
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

  // Fetch user info
  const meRes = await fetch(`${META_GRAPH_URL}/me?fields=name,id&access_token=${accessToken}`);
  const meData = await meRes.json();

  // Store on the project record
  await updateProject(projectId, {
    meta_access_token: accessToken,
    meta_token_expires_at: expiresAt,
    meta_user_name: meData.name || 'Meta User',
    meta_user_id: meData.id || '',
  });

  return { userName: meData.name, expiresAt };
}

/**
 * Disconnect Meta for a project by clearing its Meta fields.
 * @param {string} projectId
 * @returns {Promise<void>}
 */
export async function disconnectMeta(projectId) {
  await updateProject(projectId, {
    meta_access_token: '',
    meta_token_expires_at: '',
    meta_ad_account_id: '',
    meta_user_name: '',
    meta_user_id: '',
    meta_last_sync_at: '',
  });
}

/**
 * metaAds.js — Meta Marketing API wrapper
 *
 * Handles OAuth token management, campaign/ad set/ad browsing,
 * insights fetching, and automated performance sync.
 * Uses raw fetch against the Graph API (no SDK needed).
 */

import fetch from 'node-fetch';
import { v4 as uuidv4 } from 'uuid';
import { getSetting, setSetting, getAllDeployments, upsertMetaPerformance } from '../convexClient.js';
import { withRetry } from './retry.js';

const META_GRAPH_URL = 'https://graph.facebook.com/v21.0';

// ── Token Management ────────────────────────────────────────────────────────

/**
 * Get a valid access token, auto-refreshing if near expiry.
 */
export async function getAccessToken() {
  const token = await getSetting('meta_access_token');
  if (!token) throw new Error('Meta not connected. Connect your account in Settings.');

  const expiresAt = await getSetting('meta_token_expires_at');
  if (expiresAt) {
    const daysUntilExpiry = (new Date(expiresAt) - Date.now()) / (1000 * 60 * 60 * 24);
    if (daysUntilExpiry < 7) {
      try {
        await refreshLongLivedToken(token);
      } catch (err) {
        console.warn('[Meta] Token refresh failed:', err.message);
        // Continue with current token if refresh fails
      }
    }
    if (daysUntilExpiry < 0) {
      throw new Error('Meta access token expired. Please reconnect in Settings.');
    }
  }

  return token;
}

/**
 * Exchange current token for a fresh long-lived token (~60 days).
 */
async function refreshLongLivedToken(currentToken) {
  const appId = await getSetting('meta_app_id');
  const appSecret = await getSetting('meta_app_secret');
  if (!appId || !appSecret) throw new Error('Meta App ID/Secret not configured');

  const url = `${META_GRAPH_URL}/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${appSecret}&fb_exchange_token=${currentToken}`;
  const res = await fetch(url);
  const data = await res.json();

  if (data.error) throw new Error(data.error.message);

  await setSetting('meta_access_token', data.access_token);
  // Long-lived tokens expire in ~60 days
  const expiresAt = new Date(Date.now() + (data.expires_in || 5184000) * 1000).toISOString();
  await setSetting('meta_token_expires_at', expiresAt);
  console.log('[Meta] Token refreshed, new expiry:', expiresAt);
}

/**
 * Refresh token if needed (called by scheduler).
 */
export async function refreshMetaTokenIfNeeded() {
  const token = await getSetting('meta_access_token');
  if (!token) return; // Not connected

  const expiresAt = await getSetting('meta_token_expires_at');
  if (!expiresAt) return;

  const daysUntilExpiry = (new Date(expiresAt) - Date.now()) / (1000 * 60 * 60 * 24);
  if (daysUntilExpiry < 14) {
    await refreshLongLivedToken(token);
  }
}

/**
 * Check if Meta is connected.
 */
export async function isMetaConnected() {
  const token = await getSetting('meta_access_token');
  if (!token) return { connected: false };

  const userName = await getSetting('meta_user_name');
  const adAccountId = await getSetting('meta_ad_account_id');
  const expiresAt = await getSetting('meta_token_expires_at');
  const lastSyncAt = await getSetting('meta_last_sync_at');

  return {
    connected: true,
    userName: userName || null,
    adAccountId: adAccountId || null,
    expiresAt: expiresAt || null,
    lastSyncAt: lastSyncAt || null,
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
      // Rate limit codes
      if (data.error.code === 4 || data.error.code === 17 || res.status === 429) {
        err.retryable = true;
      }
      // Expired token
      if (data.error.code === 190) {
        err.tokenExpired = true;
      }
      throw err;
    }

    return data;
  }, { maxRetries: 3, label: 'Meta Graph API' });
}

// ── Account Discovery ───────────────────────────────────────────────────────

export async function getAdAccounts() {
  const token = await getAccessToken();
  const data = await graphGet('/me/adaccounts?fields=name,account_id,account_status&limit=100', token);
  return (data.data || []).map(a => ({
    id: a.id,
    name: a.name,
    accountId: a.account_id,
    status: a.account_status,
  }));
}

// ── Campaign Browser ────────────────────────────────────────────────────────

export async function getCampaigns() {
  const token = await getAccessToken();
  const adAccountId = await getSetting('meta_ad_account_id');
  if (!adAccountId) throw new Error('No ad account selected. Select one in Settings.');

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

export async function getAdSets(campaignId) {
  const token = await getAccessToken();
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

export async function getAds(adSetId) {
  const token = await getAccessToken();
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
 * Fetch daily insights for a single Meta Ad.
 * Returns array of daily metric objects.
 */
export async function getAdInsights(adId, sinceDays = 30) {
  const token = await getAccessToken();
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const until = new Date().toISOString().split('T')[0];

  const data = await graphGet(
    `/${adId}/insights?fields=impressions,clicks,spend,ctr,cpc,cpm,reach,frequency,actions,action_values&time_range={"since":"${since}","until":"${until}"}&time_increment=1&limit=100`,
    token
  );

  return (data.data || []).map(parseInsightsRow);
}

/**
 * Parse a single Insights API row into normalized metrics.
 */
function parseInsightsRow(row) {
  // Extract purchase conversions from actions array
  let conversions = 0;
  if (row.actions) {
    const purchase = row.actions.find(a => a.action_type === 'purchase' || a.action_type === 'offsite_conversion.fb_pixel_purchase');
    if (purchase) conversions = parseInt(purchase.value) || 0;
  }

  // Extract conversion value from action_values array
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

// ── Sync ────────────────────────────────────────────────────────────────────

/**
 * Sync performance data for all linked deployments.
 * Called by the scheduler every 30 minutes.
 */
export async function syncMetaPerformance() {
  const status = await isMetaConnected();
  if (!status.connected || !status.adAccountId) return;

  // Get all deployments that have a meta_ad_id
  const allDeps = await getAllDeployments();
  const linkedDeps = allDeps.filter(d => d.meta_ad_id);

  if (linkedDeps.length === 0) return;

  // Deduplicate by meta_ad_id (multiple deployments may share a Flex Ad)
  const metaAdMap = new Map(); // meta_ad_id -> first deployment
  for (const dep of linkedDeps) {
    if (!metaAdMap.has(dep.meta_ad_id)) {
      metaAdMap.set(dep.meta_ad_id, dep);
    }
  }

  let synced = 0;
  let failed = 0;

  for (const [metaAdId, dep] of metaAdMap) {
    try {
      const dailyMetrics = await getAdInsights(metaAdId, 7);

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
      console.error(`[Meta Sync] Failed for ad ${metaAdId}:`, err.message);
      failed++;
    }
  }

  await setSetting('meta_last_sync_at', new Date().toISOString());
  console.log(`[Meta Sync] Completed: ${synced} synced, ${failed} failed out of ${metaAdMap.size} unique Meta Ads`);

  return { synced, failed, total: metaAdMap.size };
}

// ── OAuth Helpers ───────────────────────────────────────────────────────────

/**
 * Build the OAuth authorization URL.
 */
export async function getOAuthUrl(redirectUri) {
  const appId = await getSetting('meta_app_id');
  if (!appId) throw new Error('Meta App ID not configured. Enter it in Settings first.');

  const state = uuidv4(); // CSRF protection
  await setSetting('meta_oauth_state', state);

  return `https://www.facebook.com/v21.0/dialog/oauth?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=ads_read&state=${state}`;
}

/**
 * Exchange authorization code for tokens and store them.
 */
export async function handleOAuthCallback(code, redirectUri) {
  const appId = await getSetting('meta_app_id');
  const appSecret = await getSetting('meta_app_secret');
  if (!appId || !appSecret) throw new Error('Meta App ID/Secret not configured');

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
  const expiresIn = longData.expires_in || 5184000; // ~60 days
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

  // Fetch user info
  const meRes = await fetch(`${META_GRAPH_URL}/me?fields=name,id&access_token=${accessToken}`);
  const meData = await meRes.json();

  // Store everything
  await setSetting('meta_access_token', accessToken);
  await setSetting('meta_token_expires_at', expiresAt);
  await setSetting('meta_user_name', meData.name || 'Meta User');
  await setSetting('meta_user_id', meData.id || '');

  return { userName: meData.name, expiresAt };
}

/**
 * Disconnect Meta by clearing all stored settings.
 */
export async function disconnectMeta() {
  const keys = ['meta_access_token', 'meta_token_expires_at', 'meta_ad_account_id',
    'meta_user_name', 'meta_user_id', 'meta_last_sync_at', 'meta_oauth_state'];
  for (const key of keys) {
    try { await setSetting(key, ''); } catch (e) { /* ignore */ }
  }
}

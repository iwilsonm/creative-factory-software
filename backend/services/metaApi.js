// Phase 2A — Meta Marketing API direct wrapper.
//
// Powers the read-only foundation. Token exchange, user info, ad accounts,
// campaigns/ad sets/ads/insights. Phase 2B layers write operations on top
// of this (createCampaign, createAdSet, createAd, activate, pause).
//
// All calls go through `withRetry` for 5xx + 429. 4xx errors propagate
// (caller decides how to handle e.g. token expiry).

import fetch from 'node-fetch';
import { withRetry } from './retry.js';

const GRAPH_BASE = 'https://graph.facebook.com/v25.0';
const OAUTH_AUTHORIZE = 'https://www.facebook.com/v25.0/dialog/oauth';
const OAUTH_TOKEN = `${GRAPH_BASE}/oauth/access_token`;

// Phase 2A — only the scopes needed for direct Marketing API reads + writes
// for ads/ad sets/campaigns. `catalog_management` was originally requested
// (Meta MCP server lists it as required) but it requires Advanced Access App
// Review, which most apps haven't gone through — and Phase 2A doesn't manage
// catalogs anyway. Add catalog_management back here if Phase 2C/3+ needs it
// AND the app has been approved for it.
export const META_OAUTH_SCOPES = [
  'ads_management',
  'ads_read',
  'business_management',
];

// ────────────────────────────────────────────────
// OAuth helpers
// ────────────────────────────────────────────────

/**
 * Build the Facebook OAuth dialog URL the user is redirected to.
 * Caller is responsible for state token + PKCE generation.
 */
export function buildAuthorizeUrl({ clientId, redirectUri, state, codeChallenge, scopes = META_OAUTH_SCOPES }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    response_type: 'code',
    scope: scopes.join(','),
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${OAUTH_AUTHORIZE}?${params.toString()}`;
}

/**
 * Exchange an authorization code (from the OAuth callback) + PKCE verifier for
 * a short-lived access token.
 */
export async function exchangeCodeForToken({ clientId, clientSecret, code, codeVerifier, redirectUri }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    code,
    code_verifier: codeVerifier,
  });
  // Meta accepts client_secret either in the body or as Basic auth.
  // PKCE flow with token_endpoint_auth_methods_supported: ["none"] means secret
  // is optional, but Meta still validates the App if provided. Include it for
  // tighter binding.
  if (clientSecret) params.set('client_secret', clientSecret);
  const url = `${OAUTH_TOKEN}?${params.toString()}`;
  const resp = await withRetry(() => fetch(url, { method: 'GET' }), { label: '[metaApi.exchangeCode]' });
  const body = await resp.json();
  if (!resp.ok || body.error) {
    throw new Error(`Token exchange failed: ${body.error?.message || JSON.stringify(body)}`);
  }
  return {
    access_token: body.access_token,
    token_type: body.token_type || 'bearer',
    expires_in: body.expires_in || null, // seconds (short-lived ~1-2h)
  };
}

/**
 * Exchange a short-lived token for a long-lived (~60-day) one.
 * Required: app credentials (long-lived exchange uses confidential client flow).
 */
export async function exchangeShortLivedForLongLived({ clientId, clientSecret, shortLivedToken }) {
  const params = new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: clientId,
    client_secret: clientSecret,
    fb_exchange_token: shortLivedToken,
  });
  const url = `${OAUTH_TOKEN}?${params.toString()}`;
  const resp = await withRetry(() => fetch(url, { method: 'GET' }), { label: '[metaApi.exchangeLongLived]' });
  const body = await resp.json();
  if (!resp.ok || body.error) {
    throw new Error(`Long-lived exchange failed: ${body.error?.message || JSON.stringify(body)}`);
  }
  return {
    access_token: body.access_token,
    token_type: body.token_type || 'bearer',
    expires_in: body.expires_in || (60 * 24 * 3600), // ~60 days default
  };
}

/**
 * Refresh a long-lived token by exchanging it for a new one. Meta extends the
 * 60-day window when the user has been "active" — i.e., the token is still
 * within its window. Tokens that have already expired cannot be refreshed.
 */
export async function refreshLongLivedToken({ clientId, clientSecret, currentToken }) {
  // Identical mechanism to short→long exchange; Meta returns a fresh token.
  return await exchangeShortLivedForLongLived({ clientId, clientSecret, shortLivedToken: currentToken });
}

// ────────────────────────────────────────────────
// Read calls — used by Phase 2A foundation
// ────────────────────────────────────────────────

async function graphGet(token, path, params = {}) {
  const qs = new URLSearchParams({ access_token: token, ...params }).toString();
  const url = `${GRAPH_BASE}${path}?${qs}`;
  const resp = await withRetry(() => fetch(url, { method: 'GET' }), { label: `[metaApi GET ${path}]` });
  const body = await resp.json();
  if (!resp.ok || body.error) {
    const err = body.error || { message: `HTTP ${resp.status}` };
    const e = new Error(`Meta API error: ${err.message}`);
    e.code = err.code;       // e.g., 190 = OAuth exception
    e.subcode = err.error_subcode;
    e.status = resp.status;
    throw e;
  }
  return body;
}

/**
 * Connected user identity. Used after OAuth callback to display "Connected as ___".
 */
export async function getMe(token) {
  return await graphGet(token, '/me', { fields: 'id,name' });
}

/**
 * List ad accounts the connected user has access to.
 * Returns: [{ id: "act_123", name, account_status, business: { id, name } }]
 */
export async function getAdAccounts(token) {
  const body = await graphGet(token, '/me/adaccounts', {
    fields: 'id,name,account_status,business{id,name}',
    limit: 100,
  });
  return body.data || [];
}

/**
 * List campaigns under an ad account.
 */
export async function getCampaigns(token, accountId) {
  const body = await graphGet(token, `/${accountId}/campaigns`, {
    fields: 'id,name,objective,status,effective_status,buying_type,daily_budget,lifetime_budget,start_time,stop_time,created_time,updated_time',
    limit: 100,
  });
  return body.data || [];
}

/**
 * List ad sets, optionally filtered by campaign.
 */
export async function getAdSets(token, accountId, campaignId = null) {
  const path = campaignId ? `/${campaignId}/adsets` : `/${accountId}/adsets`;
  const body = await graphGet(token, path, {
    fields: 'id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget,bid_strategy,bid_amount,billing_event,optimization_goal,start_time,end_time,targeting',
    limit: 100,
  });
  return body.data || [];
}

/**
 * List ads under an ad set.
 */
export async function getAds(token, adSetId) {
  const body = await graphGet(token, `/${adSetId}/ads`, {
    fields: 'id,name,adset_id,campaign_id,status,effective_status,creative{id,name,thumbnail_url,object_story_spec},created_time',
    limit: 100,
  });
  return body.data || [];
}

/**
 * Pull insights (performance metrics) for a campaign / ad set / ad.
 * Default fields cover the core direct-response metrics + a few useful breakdowns.
 */
export async function getInsights(token, objectId, { datePreset = 'last_7d', fields = null } = {}) {
  const f = fields || [
    'impressions', 'clicks', 'spend', 'reach', 'frequency',
    'ctr', 'cpm', 'cpc',
    'actions', 'action_values', 'cost_per_action_type',
    'purchase_roas',
  ].join(',');
  const body = await graphGet(token, `/${objectId}/insights`, {
    fields: f,
    date_preset: datePreset,
  });
  return body.data || [];
}

// ────────────────────────────────────────────────
// Token-error helpers
// ────────────────────────────────────────────────

/**
 * Detect Meta's "OAuth token invalid / expired" condition.
 * Code 190 with various subcodes covers token expiry, app uninstall, password
 * change. Caller should clear stored token + prompt reconnect.
 */
export function isTokenInvalidError(err) {
  return err?.code === 190;
}

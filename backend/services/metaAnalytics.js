// Phase 5 — Analytics tab batch fetchers.
//
// Each function fetches the entity list AND a single batch insights call (one
// /insights request returning metrics for ALL entities at that level), then
// joins them by ID. Faster than per-entity insights for accounts with many
// entities.
//
// Marketing API supports two ways to scope a date window:
//   - Preset:  ?date_preset=last_7d
//   - Custom:  ?time_range={"since":"YYYY-MM-DD","until":"YYYY-MM-DD"}
// We accept both.

import fetch from 'node-fetch';
import { withRetry } from './retry.js';

const GRAPH_BASE = 'https://graph.facebook.com/v25.0';

function buildDateParams({ datePreset, dateFrom, dateTo }) {
  if (dateFrom && dateTo) {
    return { time_range: JSON.stringify({ since: dateFrom, until: dateTo }) };
  }
  if (datePreset === 'lifetime') return { date_preset: 'maximum' };
  if (datePreset === 'custom') return { date_preset: 'last_7d' };
  return { date_preset: datePreset || 'last_7d' };
}

async function graphGet(token, path, params = {}) {
  const qs = new URLSearchParams({ access_token: token, ...params }).toString();
  const url = `${GRAPH_BASE}${path}?${qs}`;
  const resp = await withRetry(() => fetch(url, { method: 'GET' }), { label: `[metaAnalytics GET ${path}]` });
  const body = await resp.json();
  if (!resp.ok || body.error) {
    const err = body.error || { message: `HTTP ${resp.status}` };
    const e = new Error(`Meta API error: ${err.message}`);
    e.code = err.code;
    e.status = resp.status;
    throw e;
  }
  return body;
}

// Pagination-aware fetcher. Meta Marketing API returns up to ~25 results
// per page by default; we set limit=200 and follow .paging.next until done
// or until we hit a safety cap.
async function graphGetAll(token, path, params = {}, { maxPages = 25 } = {}) {
  let url = `${GRAPH_BASE}${path}?${new URLSearchParams({ access_token: token, limit: 200, ...params }).toString()}`;
  const out = [];
  for (let i = 0; i < maxPages; i++) {
    const resp = await withRetry(() => fetch(url, { method: 'GET' }), { label: `[metaAnalytics page ${i}]` });
    const body = await resp.json();
    if (!resp.ok || body.error) {
      const err = body.error || { message: `HTTP ${resp.status}` };
      const e = new Error(`Meta API error: ${err.message}`);
      e.code = err.code;
      e.status = resp.status;
      throw e;
    }
    if (Array.isArray(body.data)) out.push(...body.data);
    if (!body.paging?.next) break;
    url = body.paging.next;
  }
  return out;
}

const INSIGHTS_FIELDS = [
  'impressions', 'clicks', 'spend', 'reach', 'frequency',
  'ctr', 'cpm', 'cpc', 'cpp',
  'social_spend',
  'inline_link_clicks', 'inline_link_click_ctr',
  'outbound_clicks', 'outbound_clicks_ctr',
  'unique_clicks', 'unique_ctr',
  'unique_inline_link_clicks', 'unique_inline_link_click_ctr',
  'unique_link_clicks_ctr',
  'unique_outbound_clicks', 'unique_outbound_clicks_ctr',
  'website_ctr',
  'video_play_actions', 'video_15_sec_watched_actions',
  'video_30_sec_watched_actions', 'video_p25_watched_actions',
  'video_p50_watched_actions', 'video_p75_watched_actions',
  'video_p95_watched_actions', 'video_p100_watched_actions',
  'video_avg_time_watched_actions', 'video_thruplay_watched_actions',
  'actions', 'action_values', 'cost_per_action_type',
  'purchase_roas', 'website_purchase_roas', 'mobile_app_purchase_roas',
].join(',');

/**
 * Fetch insights for all entities at a level in one batch call.
 * Returns a Map keyed by the relevant ID field.
 */
async function fetchInsightsByLevel(token, accountId, level, dateParams) {
  // level: "campaign" | "adset" | "ad"
  const idField = level + '_id'; // campaign_id, adset_id, ad_id
  const params = {
    level,
    fields: `${idField},${INSIGHTS_FIELDS}`,
    ...dateParams,
  };
  const rows = await graphGetAll(token, `/${accountId}/insights`, params);
  const byId = new Map();
  for (const row of rows) {
    const id = row[idField];
    if (id) byId.set(id, row);
  }
  return byId;
}

function actionValue(rows, actionTypes) {
  if (!Array.isArray(rows)) return 0;
  const wanted = new Set(actionTypes);
  for (const row of rows) {
    if (wanted.has(row?.action_type)) {
      const n = Number(row.value || 0);
      return Number.isFinite(n) ? n : 0;
    }
  }
  return 0;
}

function firstActionValue(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const n = Number(rows[0]?.value || 0);
  return Number.isFinite(n) ? n : 0;
}

function mergeInsights(entity, insightsRow) {
  if (!insightsRow) return entity;
  const purchaseActionTypes = [
    'purchase',
    'omni_purchase',
    'offsite_conversion.fb_pixel_purchase',
    'onsite_conversion.purchase',
  ];
  const videoActionTypes = ['video_view'];
  // Pull the standard metrics into top-level fields the frontend expects.
  return {
    ...entity,
    impressions: Number(insightsRow.impressions || 0),
    clicks: Number(insightsRow.clicks || 0),
    spend: Number(insightsRow.spend || 0),
    reach: Number(insightsRow.reach || 0),
    frequency: Number(insightsRow.frequency || 0),
    ctr: Number(insightsRow.ctr || 0),
    cpm: Number(insightsRow.cpm || 0),
    cpc: Number(insightsRow.cpc || 0),
    cpp: Number(insightsRow.cpp || 0),
    social_spend: Number(insightsRow.social_spend || 0),
    inline_link_clicks: Number(insightsRow.inline_link_clicks || 0),
    inline_link_click_ctr: Number(insightsRow.inline_link_click_ctr || 0),
    outbound_clicks: firstActionValue(insightsRow.outbound_clicks),
    outbound_clicks_ctr: firstActionValue(insightsRow.outbound_clicks_ctr),
    unique_clicks: Number(insightsRow.unique_clicks || 0),
    unique_ctr: Number(insightsRow.unique_ctr || 0),
    unique_inline_link_clicks: Number(insightsRow.unique_inline_link_clicks || 0),
    unique_inline_link_click_ctr: Number(insightsRow.unique_inline_link_click_ctr || 0),
    unique_link_clicks_ctr: Number(insightsRow.unique_link_clicks_ctr || 0),
    unique_outbound_clicks: firstActionValue(insightsRow.unique_outbound_clicks),
    unique_outbound_clicks_ctr: firstActionValue(insightsRow.unique_outbound_clicks_ctr),
    website_ctr: firstActionValue(insightsRow.website_ctr),
    video_plays: actionValue(insightsRow.video_play_actions, videoActionTypes),
    video_15_sec_views: actionValue(insightsRow.video_15_sec_watched_actions, videoActionTypes),
    video_30_sec_views: actionValue(insightsRow.video_30_sec_watched_actions, videoActionTypes),
    video_p25_views: actionValue(insightsRow.video_p25_watched_actions, videoActionTypes),
    video_p50_views: actionValue(insightsRow.video_p50_watched_actions, videoActionTypes),
    video_p75_views: actionValue(insightsRow.video_p75_watched_actions, videoActionTypes),
    video_p95_views: actionValue(insightsRow.video_p95_watched_actions, videoActionTypes),
    video_p100_views: actionValue(insightsRow.video_p100_watched_actions, videoActionTypes),
    video_avg_time_watched: actionValue(insightsRow.video_avg_time_watched_actions, videoActionTypes),
    video_thruplays: actionValue(insightsRow.video_thruplay_watched_actions, videoActionTypes),
    purchase_count: actionValue(insightsRow.actions, purchaseActionTypes),
    purchase_value: actionValue(insightsRow.action_values, purchaseActionTypes),
    cost_per_purchase: actionValue(insightsRow.cost_per_action_type, purchaseActionTypes),
    actions: insightsRow.actions || [],
    action_values: insightsRow.action_values || [],
    cost_per_action_type: insightsRow.cost_per_action_type || [],
    purchase_roas: insightsRow.purchase_roas || [],
    website_purchase_roas: insightsRow.website_purchase_roas || [],
    mobile_app_purchase_roas: insightsRow.mobile_app_purchase_roas || [],
  };
}

export async function getCampaignsWithInsights(token, accountId, opts = {}) {
  const dateParams = buildDateParams(opts);
  const [campaigns, insights] = await Promise.all([
    graphGetAll(token, `/${accountId}/campaigns`, {
      fields: 'id,name,objective,status,effective_status,buying_type,daily_budget,lifetime_budget,start_time,stop_time,created_time,updated_time',
    }),
    fetchInsightsByLevel(token, accountId, 'campaign', dateParams),
  ]);
  return campaigns.map((c) => mergeInsights(c, insights.get(c.id)));
}

export async function getAdSetsWithInsights(token, accountId, opts = {}) {
  const dateParams = buildDateParams(opts);
  const path = opts.campaignId ? `/${opts.campaignId}/adsets` : `/${accountId}/adsets`;
  const [adsets, insights, campaigns] = await Promise.all([
    graphGetAll(token, path, {
      fields: 'id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget,budget_remaining,bid_strategy,bid_amount,billing_event,optimization_goal,start_time,end_time,created_time,updated_time',
    }),
    fetchInsightsByLevel(token, accountId, 'adset', dateParams),
    graphGetAll(token, `/${accountId}/campaigns`, {
      fields: 'id,name,objective,status,effective_status,buying_type',
    }),
  ]);
  const campaignById = new Map(campaigns.map((c) => [c.id, c]));
  return adsets.map((a) => {
    const campaign = campaignById.get(a.campaign_id);
    return mergeInsights({
      ...a,
      campaign_name: campaign?.name || '',
      campaign_objective: campaign?.objective || '',
      campaign_status: campaign?.effective_status || campaign?.status || '',
    }, insights.get(a.id));
  });
}

export async function getAdsWithInsights(token, accountId, opts = {}) {
  const dateParams = buildDateParams(opts);
  const path = opts.adsetId ? `/${opts.adsetId}/ads` : `/${accountId}/ads`;
  const [ads, insights, adsets, campaigns] = await Promise.all([
    graphGetAll(token, path, {
      fields: 'id,name,adset_id,campaign_id,status,effective_status,creative{id,name,thumbnail_url,object_story_spec},created_time,updated_time',
    }),
    fetchInsightsByLevel(token, accountId, 'ad', dateParams),
    graphGetAll(token, `/${accountId}/adsets`, {
      fields: 'id,name,campaign_id,status,effective_status,optimization_goal,billing_event,bid_strategy',
    }),
    graphGetAll(token, `/${accountId}/campaigns`, {
      fields: 'id,name,objective,status,effective_status,buying_type',
    }),
  ]);
  const adSetById = new Map(adsets.map((a) => [a.id, a]));
  const campaignById = new Map(campaigns.map((c) => [c.id, c]));
  return ads.map((a) => {
    const adSet = adSetById.get(a.adset_id);
    const campaign = campaignById.get(a.campaign_id || adSet?.campaign_id);
    return mergeInsights({
      ...a,
      adset_name: adSet?.name || '',
      adset_status: adSet?.effective_status || adSet?.status || '',
      campaign_id: a.campaign_id || adSet?.campaign_id || '',
      campaign_name: campaign?.name || '',
      campaign_objective: campaign?.objective || '',
      campaign_status: campaign?.effective_status || campaign?.status || '',
      creative_id: a.creative?.id || '',
      creative_name: a.creative?.name || '',
      thumbnail_url: a.creative?.thumbnail_url || '',
    }, insights.get(a.id));
  });
}

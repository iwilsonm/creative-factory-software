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
  'actions', 'action_values', 'cost_per_action_type',
  'purchase_roas',
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

function mergeInsights(entity, insightsRow) {
  if (!insightsRow) return entity;
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
    actions: insightsRow.actions || [],
    action_values: insightsRow.action_values || [],
    cost_per_action_type: insightsRow.cost_per_action_type || [],
    purchase_roas: insightsRow.purchase_roas || [],
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
  const [adsets, insights] = await Promise.all([
    graphGetAll(token, path, {
      fields: 'id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget,bid_strategy,bid_amount,billing_event,optimization_goal,start_time,end_time,created_time,updated_time',
    }),
    fetchInsightsByLevel(token, accountId, 'adset', dateParams),
  ]);
  return adsets.map((a) => mergeInsights(a, insights.get(a.id)));
}

export async function getAdsWithInsights(token, accountId, opts = {}) {
  const dateParams = buildDateParams(opts);
  const path = opts.adsetId ? `/${opts.adsetId}/ads` : `/${accountId}/ads`;
  const [ads, insights] = await Promise.all([
    graphGetAll(token, path, {
      fields: 'id,name,adset_id,campaign_id,status,effective_status,creative{id,name,thumbnail_url,object_story_spec},created_time,updated_time',
    }),
    fetchInsightsByLevel(token, accountId, 'ad', dateParams),
  ]);
  return ads.map((a) => mergeInsights(a, insights.get(a.id)));
}

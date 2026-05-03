// Phase 5 — Analytics tab. Notion-style table over Meta-side Campaigns / Ad Sets / Ads
// for a project's connected ad account. Supports drilldowns, custom date ranges,
// configurable columns, reusable filters, tagging, and saved views.

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { api } from '../api';
import { useToast } from './Toast';
import TagPicker from './analytics/TagPicker';
import TagManageDialog from './analytics/TagManageDialog';
import SavedViewPicker from './analytics/SavedViewPicker';
import SaveViewDialog from './analytics/SaveViewDialog';
import InfoTooltip from './InfoTooltip';

const LEVELS = [
  { id: 'campaigns', label: 'Campaigns', entity: 'campaign' },
  { id: 'adsets', label: 'Ad Sets', entity: 'ad_set' },
  { id: 'ads', label: 'Ads', entity: 'ad' },
];

const DATE_PRESETS = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'last_3d', label: 'Last 3d' },
  { id: 'last_7d', label: 'Last 7d' },
  { id: 'last_14d', label: 'Last 14d' },
  { id: 'last_30d', label: 'Last 30d' },
  { id: 'last_90d', label: 'Last 90d' },
  { id: 'this_month', label: 'This month' },
  { id: 'last_month', label: 'Last month' },
  { id: 'lifetime', label: 'Lifetime' },
  { id: 'custom', label: 'Custom' },
];

export const ROW_CAP = 1000;
export const NUMBER_FMT = new Intl.NumberFormat('en-US');
export const DOLLAR_FMT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
export const PERCENT_FMT = new Intl.NumberFormat('en-US', { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const DEFAULT_COLUMNS_BY_LEVEL = {
  campaigns: ['name', 'status', 'objective', 'impressions', 'clicks', 'spend', 'ctr', 'cpm', 'cpc', 'roas', 'tags', 'notes'],
  adsets: ['name', 'campaign_name', 'status', 'optimization_goal', 'impressions', 'clicks', 'spend', 'ctr', 'cpm', 'cpc', 'roas', 'tags', 'notes'],
  ads: ['name', 'thumbnail_url', 'adset_name', 'campaign_name', 'status', 'impressions', 'clicks', 'spend', 'ctr', 'cpc', 'roas', 'tags', 'notes'],
  observation: ['name', 'angle_name', 'status', 'spend', 'roas', 'days_observed', 'tags', 'notes', 'posted_at'],
};

export function numberValue(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

export function firstRoasValue(row, field = 'purchase_roas') {
  const arr = row[field];
  if (!Array.isArray(arr) || arr.length === 0) return 0;
  const purchase = arr.find((r) => r?.action_type === 'purchase') || arr[0];
  return numberValue(purchase?.value);
}

function moneyMinor(value) {
  const n = numberValue(value);
  return n > 0 ? DOLLAR_FMT.format(n / 100) : '—';
}

export function isoDate(value) {
  if (!value) return '—';
  return String(value).slice(0, 10);
}

function actionSummary(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return '—';
  return rows
    .slice(0, 3)
    .map((r) => `${r.action_type || 'action'}: ${r.value ?? 0}`)
    .join(', ');
}

const LEVEL_ALL = ['campaigns', 'adsets', 'ads', 'observation'];
const LEVEL_ADSET_AD = ['adsets', 'ads', 'observation'];

export const COLUMN_DEFS = {
  name: { label: 'Name', type: 'string', levels: LEVEL_ALL, width: 'min-w-[240px]', accessor: (r) => r.name || '' },
  id: { label: 'Meta ID', type: 'string', levels: LEVEL_ALL, width: 'w-40', accessor: (r) => r.id || '' },
  status: { label: 'Status', type: 'string', levels: LEVEL_ALL, width: 'w-28', accessor: (r) => r.effective_status || r.status || '' },
  angle_name: { label: 'Angle', type: 'string', levels: LEVEL_ADSET_AD, width: 'min-w-[180px]', accessor: (r) => r.angle_name || '' },
  notes: { label: 'Notes', type: 'string', levels: LEVEL_ALL, width: 'min-w-[220px]', accessor: (r) => r.note_text || r.note || '' },
  effective_status: { label: 'Effective Status', type: 'string', levels: LEVEL_ALL, width: 'w-36', accessor: (r) => r.effective_status || '' },
  configured_status: { label: 'Configured Status', type: 'string', levels: LEVEL_ALL, width: 'w-36', accessor: (r) => r.status || '' },
  campaign_id: { label: 'Campaign ID', type: 'string', levels: LEVEL_ADSET_AD, width: 'w-40', accessor: (r) => r.campaign_id || '' },
  campaign_name: { label: 'Campaign Name', type: 'string', levels: LEVEL_ADSET_AD, width: 'min-w-[200px]', accessor: (r) => r.campaign_name || '' },
  campaign_objective: { label: 'Campaign Objective', type: 'string', levels: LEVEL_ADSET_AD, width: 'w-44', accessor: (r) => r.campaign_objective || '' },
  campaign_status: { label: 'Campaign Status', type: 'string', levels: LEVEL_ADSET_AD, width: 'w-36', accessor: (r) => r.campaign_status || '' },
  adset_id: { label: 'Ad Set ID', type: 'string', levels: ['ads'], width: 'w-40', accessor: (r) => r.adset_id || '' },
  adset_name: { label: 'Ad Set Name', type: 'string', levels: ['ads'], width: 'min-w-[200px]', accessor: (r) => r.adset_name || '' },
  adset_status: { label: 'Ad Set Status', type: 'string', levels: ['ads'], width: 'w-32', accessor: (r) => r.adset_status || '' },

  objective: { label: 'Objective', type: 'string', levels: ['campaigns'], width: 'w-40', accessor: (r) => r.objective || '' },
  buying_type: { label: 'Buying Type', type: 'string', levels: ['campaigns'], width: 'w-32', accessor: (r) => r.buying_type || '' },
  daily_budget: { label: 'Daily Budget', type: 'number', levels: ['campaigns', 'adsets'], width: 'w-28', accessor: (r) => numberValue(r.daily_budget), format: moneyMinor, align: 'right' },
  lifetime_budget: { label: 'Lifetime Budget', type: 'number', levels: ['campaigns', 'adsets'], width: 'w-32', accessor: (r) => numberValue(r.lifetime_budget), format: moneyMinor, align: 'right' },
  budget_remaining: { label: 'Budget Remaining', type: 'number', levels: ['campaigns', 'adsets'], width: 'w-36', accessor: (r) => numberValue(r.budget_remaining), format: moneyMinor, align: 'right' },
  bid_strategy: { label: 'Bid Strategy', type: 'string', levels: ['campaigns', 'adsets'], width: 'w-44', accessor: (r) => r.bid_strategy || '' },
  bid_amount: { label: 'Bid Amount', type: 'number', levels: ['adsets'], width: 'w-28', accessor: (r) => numberValue(r.bid_amount), format: moneyMinor, align: 'right' },
  billing_event: { label: 'Billing Event', type: 'string', levels: ['adsets'], width: 'w-36', accessor: (r) => r.billing_event || '' },
  optimization_goal: { label: 'Optimization Goal', type: 'string', levels: ['adsets'], width: 'w-44', accessor: (r) => r.optimization_goal || '' },
  start_time: { label: 'Start', type: 'date', levels: ['campaigns', 'adsets'], width: 'w-28', accessor: (r) => r.start_time || '', format: isoDate },
  stop_time: { label: 'Stop', type: 'date', levels: ['campaigns'], width: 'w-28', accessor: (r) => r.stop_time || '', format: isoDate },
  end_time: { label: 'End', type: 'date', levels: ['adsets'], width: 'w-28', accessor: (r) => r.end_time || '', format: isoDate },
  created_time: { label: 'Created', type: 'date', levels: LEVEL_ALL, width: 'w-28', accessor: (r) => r.created_time || '', format: isoDate },
  updated_time: { label: 'Updated', type: 'date', levels: LEVEL_ALL, width: 'w-28', accessor: (r) => r.updated_time || '', format: isoDate },
  posted_at: { label: 'Posted', type: 'date', levels: ['observation'], width: 'w-28', accessor: (r) => r.posted_at || '', format: isoDate },
  days_observed: { label: 'Days Observed', type: 'number', levels: ['observation'], width: 'w-28', accessor: (r) => numberValue(r.days_observed), format: NUMBER_FMT.format, align: 'right' },
  child_count: { label: 'Ads', type: 'number', levels: ['observation'], width: 'w-20', accessor: (r) => numberValue(r.child_count), format: NUMBER_FMT.format, align: 'right' },

  creative_id: { label: 'Creative ID', type: 'string', levels: ['ads'], width: 'w-40', accessor: (r) => r.creative_id || r.creative?.id || '' },
  creative_name: { label: 'Creative Name', type: 'string', levels: ['ads'], width: 'min-w-[180px]', accessor: (r) => r.creative_name || r.creative?.name || '' },
  thumbnail_url: {
    label: 'Thumb',
    type: 'string',
    levels: ['ads'],
    width: 'w-20',
    accessor: (r) => r.thumbnail_url || r.creative?.thumbnail_url || '',
    render: (value) => value ? <img src={value} alt="" className="w-10 h-10 rounded-lg object-cover bg-gray-100" loading="lazy" /> : '—',
  },

  impressions: { label: 'Impr.', type: 'number', levels: LEVEL_ALL, width: 'w-24', accessor: (r) => numberValue(r.impressions), format: NUMBER_FMT.format, align: 'right' },
  reach: { label: 'Reach', type: 'number', levels: LEVEL_ALL, width: 'w-24', accessor: (r) => numberValue(r.reach), format: NUMBER_FMT.format, align: 'right' },
  frequency: { label: 'Freq.', type: 'number', levels: LEVEL_ALL, width: 'w-20', accessor: (r) => numberValue(r.frequency), format: (v) => v.toFixed(2), align: 'right' },
  clicks: { label: 'Clicks', type: 'number', levels: LEVEL_ALL, width: 'w-20', accessor: (r) => numberValue(r.clicks), format: NUMBER_FMT.format, align: 'right' },
  unique_clicks: { label: 'Unique Clicks', type: 'number', levels: LEVEL_ALL, width: 'w-28', accessor: (r) => numberValue(r.unique_clicks), format: NUMBER_FMT.format, align: 'right' },
  inline_link_clicks: { label: 'Link Clicks', type: 'number', levels: LEVEL_ALL, width: 'w-28', accessor: (r) => numberValue(r.inline_link_clicks), format: NUMBER_FMT.format, align: 'right' },
  unique_inline_link_clicks: { label: 'Unique Link Clicks', type: 'number', levels: LEVEL_ALL, width: 'w-36', accessor: (r) => numberValue(r.unique_inline_link_clicks), format: NUMBER_FMT.format, align: 'right' },
  outbound_clicks: { label: 'Outbound Clicks', type: 'number', levels: LEVEL_ALL, width: 'w-32', accessor: (r) => numberValue(r.outbound_clicks), format: NUMBER_FMT.format, align: 'right' },
  unique_outbound_clicks: { label: 'Unique Outbound', type: 'number', levels: LEVEL_ALL, width: 'w-36', accessor: (r) => numberValue(r.unique_outbound_clicks), format: NUMBER_FMT.format, align: 'right' },
  spend: { label: 'Spend', type: 'number', levels: LEVEL_ALL, width: 'w-24', accessor: (r) => numberValue(r.spend), format: DOLLAR_FMT.format, align: 'right' },
  social_spend: { label: 'Social Spend', type: 'number', levels: LEVEL_ALL, width: 'w-28', accessor: (r) => numberValue(r.social_spend), format: DOLLAR_FMT.format, align: 'right' },
  ctr: { label: 'CTR', type: 'number', levels: LEVEL_ALL, width: 'w-20', accessor: (r) => numberValue(r.ctr) / 100, format: PERCENT_FMT.format, align: 'right' },
  unique_ctr: { label: 'Unique CTR', type: 'number', levels: LEVEL_ALL, width: 'w-28', accessor: (r) => numberValue(r.unique_ctr) / 100, format: PERCENT_FMT.format, align: 'right' },
  inline_link_click_ctr: { label: 'Link CTR', type: 'number', levels: LEVEL_ALL, width: 'w-24', accessor: (r) => numberValue(r.inline_link_click_ctr) / 100, format: PERCENT_FMT.format, align: 'right' },
  outbound_clicks_ctr: { label: 'Outbound CTR', type: 'number', levels: LEVEL_ALL, width: 'w-32', accessor: (r) => numberValue(r.outbound_clicks_ctr) / 100, format: PERCENT_FMT.format, align: 'right' },
  website_ctr: { label: 'Website CTR', type: 'number', levels: LEVEL_ALL, width: 'w-28', accessor: (r) => numberValue(r.website_ctr) / 100, format: PERCENT_FMT.format, align: 'right' },
  cpm: { label: 'CPM', type: 'number', levels: LEVEL_ALL, width: 'w-20', accessor: (r) => numberValue(r.cpm), format: DOLLAR_FMT.format, align: 'right' },
  cpc: { label: 'CPC', type: 'number', levels: LEVEL_ALL, width: 'w-20', accessor: (r) => numberValue(r.cpc), format: DOLLAR_FMT.format, align: 'right' },
  cpp: { label: 'CPP', type: 'number', levels: LEVEL_ALL, width: 'w-20', accessor: (r) => numberValue(r.cpp), format: DOLLAR_FMT.format, align: 'right' },
  roas: { label: 'ROAS', type: 'number', levels: LEVEL_ALL, width: 'w-20', accessor: (r) => firstRoasValue(r), format: (v) => v.toFixed(2), align: 'right' },
  website_purchase_roas: { label: 'Website ROAS', type: 'number', levels: LEVEL_ALL, width: 'w-28', accessor: (r) => firstRoasValue(r, 'website_purchase_roas'), format: (v) => v.toFixed(2), align: 'right' },
  mobile_app_purchase_roas: { label: 'App ROAS', type: 'number', levels: LEVEL_ALL, width: 'w-24', accessor: (r) => firstRoasValue(r, 'mobile_app_purchase_roas'), format: (v) => v.toFixed(2), align: 'right' },
  purchase_count: { label: 'Purchases', type: 'number', levels: LEVEL_ALL, width: 'w-24', accessor: (r) => numberValue(r.purchase_count), format: NUMBER_FMT.format, align: 'right' },
  purchase_value: { label: 'Purchase Value', type: 'number', levels: LEVEL_ALL, width: 'w-32', accessor: (r) => numberValue(r.purchase_value), format: DOLLAR_FMT.format, align: 'right' },
  cost_per_purchase: { label: 'Cost / Purchase', type: 'number', levels: LEVEL_ALL, width: 'w-32', accessor: (r) => numberValue(r.cost_per_purchase), format: DOLLAR_FMT.format, align: 'right' },
  actions: { label: 'Actions', type: 'string', levels: LEVEL_ALL, width: 'min-w-[220px]', accessor: (r) => actionSummary(r.actions) },
  action_values: { label: 'Action Values', type: 'string', levels: LEVEL_ALL, width: 'min-w-[220px]', accessor: (r) => actionSummary(r.action_values) },
  cost_per_action_type: { label: 'Cost / Action', type: 'string', levels: LEVEL_ALL, width: 'min-w-[220px]', accessor: (r) => actionSummary(r.cost_per_action_type) },
  video_plays: { label: 'Video Plays', type: 'number', levels: LEVEL_ALL, width: 'w-28', accessor: (r) => numberValue(r.video_plays), format: NUMBER_FMT.format, align: 'right' },
  video_15_sec_views: { label: '15s Views', type: 'number', levels: LEVEL_ALL, width: 'w-24', accessor: (r) => numberValue(r.video_15_sec_views), format: NUMBER_FMT.format, align: 'right' },
  video_30_sec_views: { label: '30s Views', type: 'number', levels: LEVEL_ALL, width: 'w-24', accessor: (r) => numberValue(r.video_30_sec_views), format: NUMBER_FMT.format, align: 'right' },
  video_p25_views: { label: 'Video 25%', type: 'number', levels: LEVEL_ALL, width: 'w-24', accessor: (r) => numberValue(r.video_p25_views), format: NUMBER_FMT.format, align: 'right' },
  video_p50_views: { label: 'Video 50%', type: 'number', levels: LEVEL_ALL, width: 'w-24', accessor: (r) => numberValue(r.video_p50_views), format: NUMBER_FMT.format, align: 'right' },
  video_p75_views: { label: 'Video 75%', type: 'number', levels: LEVEL_ALL, width: 'w-24', accessor: (r) => numberValue(r.video_p75_views), format: NUMBER_FMT.format, align: 'right' },
  video_p100_views: { label: 'Video 100%', type: 'number', levels: LEVEL_ALL, width: 'w-28', accessor: (r) => numberValue(r.video_p100_views), format: NUMBER_FMT.format, align: 'right' },
  video_thruplays: { label: 'ThruPlays', type: 'number', levels: LEVEL_ALL, width: 'w-24', accessor: (r) => numberValue(r.video_thruplays), format: NUMBER_FMT.format, align: 'right' },
  video_avg_time_watched: { label: 'Avg Watch Time', type: 'number', levels: LEVEL_ALL, width: 'w-32', accessor: (r) => numberValue(r.video_avg_time_watched), format: (v) => `${Math.round(v)}s`, align: 'right' },
};

const STATUS_PILL = {
  ACTIVE: 'bg-teal/10 text-teal',
  PAUSED: 'bg-gold/10 text-gold',
  DELETED: 'bg-gray-100 text-textlight',
  ARCHIVED: 'bg-gray-100 text-textlight',
};

const FILTER_OPERATORS = {
  string: [
    { id: 'contains', label: 'contains' },
    { id: 'equals', label: 'equals' },
    { id: 'not_equals', label: 'does not equal' },
    { id: 'empty', label: 'is empty' },
    { id: 'not_empty', label: 'is not empty' },
  ],
  number: [
    { id: 'equals', label: '=' },
    { id: 'gt', label: '>' },
    { id: 'lt', label: '<' },
    { id: 'between', label: 'between' },
    { id: 'empty', label: 'is empty' },
    { id: 'not_empty', label: 'is not empty' },
  ],
  date: [
    { id: 'equals', label: 'on' },
    { id: 'gt', label: 'after' },
    { id: 'lt', label: 'before' },
    { id: 'between', label: 'between' },
    { id: 'empty', label: 'is empty' },
    { id: 'not_empty', label: 'is not empty' },
  ],
  tags: [
    { id: 'has_tag', label: 'has tag' },
    { id: 'not_has_tag', label: 'does not have tag' },
    { id: 'empty', label: 'is empty' },
    { id: 'not_empty', label: 'is not empty' },
  ],
};

function statusBadge(s) {
  const cls = STATUS_PILL[s?.toUpperCase()] || 'bg-gray-100 text-textmid';
  return <span className={`badge ${cls}`}>{s || '—'}</span>;
}

function columnAvailable(field, level) {
  if (field === 'tags') return true;
  const def = COLUMN_DEFS[field];
  return !!def && (!def.levels || def.levels.includes(level));
}

export function filterableColumns(level) {
  return [
    ...Object.entries(COLUMN_DEFS)
      .filter(([, def]) => !def.levels || def.levels.includes(level))
      .map(([id, def]) => ({ id, label: def.label, type: def.type || 'string' })),
    { id: 'tags', label: 'Tags', type: 'tags' },
  ];
}

function emptyScope() {
  return { campaignId: null, campaignName: null, adsetId: null, adsetName: null };
}

export function newFilter(level) {
  const field = level === 'ads' ? 'adset_name' : level === 'adsets' ? 'campaign_name' : 'name';
  return { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, field, op: 'contains', value: '', valueTo: '' };
}

function normalizeFilters(raw) {
  if (Array.isArray(raw)) return raw.map((f) => ({ ...newFilter('campaigns'), ...f }));
  const migrated = [];
  if (raw?.name) migrated.push({ ...newFilter('campaigns'), field: 'name', op: 'contains', value: raw.name });
  if (raw?.status && raw.status !== 'all') migrated.push({ ...newFilter('campaigns'), field: 'status', op: 'equals', value: raw.status });
  if (Array.isArray(raw?.tags)) {
    raw.tags.forEach((tagId) => migrated.push({ ...newFilter('campaigns'), field: 'tags', op: 'has_tag', value: tagId }));
  }
  return migrated;
}

function isBlank(value) {
  return value == null || value === '' || (Array.isArray(value) && value.length === 0);
}

export function matchesFilter(row, filter, tagsByEntity) {
  if (!filter?.field) return true;
  if (filter.field === 'tags') {
    const ids = tagsByEntity.get(row.id) || [];
    if (filter.op === 'empty') return ids.length === 0;
    if (filter.op === 'not_empty') return ids.length > 0;
    if (!filter.value) return true;
    if (filter.op === 'not_has_tag') return !ids.includes(filter.value);
    return ids.includes(filter.value);
  }

  const def = COLUMN_DEFS[filter.field];
  const raw = def ? def.accessor(row) : row[filter.field];
  if (filter.op === 'empty') return isBlank(raw);
  if (filter.op === 'not_empty') return !isBlank(raw);
  if (filter.value == null || filter.value === '') return true;

  if (def?.type === 'number') {
    const actual = numberValue(raw);
    const target = numberValue(filter.value);
    if (filter.op === 'gt') return actual > target;
    if (filter.op === 'lt') return actual < target;
    if (filter.op === 'between') {
      const hi = numberValue(filter.valueTo);
      return actual >= target && actual <= hi;
    }
    if (filter.op === 'not_equals') return actual !== target;
    return actual === target;
  }

  const actual = String(raw || '').toLowerCase();
  const target = String(filter.value || '').toLowerCase();
  if (filter.op === 'gt') return actual > target;
  if (filter.op === 'lt') return actual < target;
  if (filter.op === 'between') {
    const hi = String(filter.valueTo || '').toLowerCase();
    return actual >= target && actual <= hi;
  }
  if (filter.op === 'equals') return actual === target;
  if (filter.op === 'not_equals') return actual !== target;
  return actual.includes(target);
}

export default function AnalyticsTab({ projectId }) {
  const toast = useToast();
  const [level, setLevel] = useState('campaigns');
  const [datePreset, setDatePreset] = useState('last_7d');
  const [customRange, setCustomRange] = useState({ from: '', to: '' });
  const [scope, setScope] = useState(emptyScope);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [tokenExpired, setTokenExpired] = useState(false);

  const [tags, setTags] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [notes, setNotes] = useState([]);
  const [views, setViews] = useState([]);
  const [activeViewId, setActiveViewId] = useState(null);

  const [filters, setFilters] = useState([]);
  const [sort, setSort] = useState({ field: 'spend', dir: 'desc' });
  const [columns, setColumns] = useState(DEFAULT_COLUMNS_BY_LEVEL.campaigns);
  const [showColumnPicker, setShowColumnPicker] = useState(false);

  const [tagPickerForRow, setTagPickerForRow] = useState(null);
  const [selectedIds, setSelectedIds] = useState([]);
  const [bulkTagId, setBulkTagId] = useState('');
  const [showManageTags, setShowManageTags] = useState(false);
  const [showSaveView, setShowSaveView] = useState(false);
  const requestSeqRef = useRef(0);

  const entityType = useMemo(() => LEVELS.find((l) => l.id === level)?.entity, [level]);
  const availableColumns = useMemo(() => filterableColumns(level), [level]);
  const queryKey = useMemo(() => JSON.stringify({
    projectId,
    level,
    datePreset,
    dateFrom: customRange.from || '',
    dateTo: customRange.to || '',
    campaignId: scope.campaignId || '',
    adsetId: scope.adsetId || '',
  }), [projectId, level, datePreset, customRange.from, customRange.to, scope.campaignId, scope.adsetId]);

  const loadData = useCallback(async ({ clearRows = false } = {}) => {
    const requestSeq = requestSeqRef.current + 1;
    requestSeqRef.current = requestSeq;
    const isCurrentRequest = () => requestSeqRef.current === requestSeq;
    setLoading(true);
    setError(null);
    setTokenExpired(false);
    if (clearRows) setRows([]);
    try {
      const opts = {};
      if (datePreset === 'custom') {
        if (!customRange.from || !customRange.to) {
          if (isCurrentRequest()) {
            setRows([]);
            setError('Choose a start and end date for the custom range.');
          }
          return;
        }
        if (customRange.from > customRange.to) {
          if (isCurrentRequest()) {
            setRows([]);
            setError('Custom range start must be before or equal to the end date.');
          }
          return;
        }
        opts.dateFrom = customRange.from;
        opts.dateTo = customRange.to;
      } else {
        opts.datePreset = datePreset;
      }
      if (level === 'adsets' && scope.campaignId) opts.campaignId = scope.campaignId;
      if (level === 'ads' && scope.adsetId) opts.adsetId = scope.adsetId;

      let payload;
      if (level === 'campaigns') payload = await api.getAnalyticsCampaigns(projectId, opts);
      else if (level === 'adsets') payload = await api.getAnalyticsAdSets(projectId, opts);
      else payload = await api.getAnalyticsAds(projectId, opts);
      if (!isCurrentRequest()) return;
      setRows(payload.campaigns || payload.adsets || payload.ads || []);
    } catch (err) {
      if (!isCurrentRequest()) return;
      if (/token/i.test(err.message) && /expired|reconnect/i.test(err.message)) {
        setTokenExpired(true);
      }
      setError(err.message);
    } finally {
      if (isCurrentRequest()) setLoading(false);
    }
  }, [projectId, level, datePreset, customRange.from, customRange.to, scope.campaignId, scope.adsetId, queryKey]);

  const loadTags = useCallback(async () => {
    try {
      const { tags: list } = await api.getTags(projectId);
      setTags(list || []);
    } catch { /* ignore */ }
  }, [projectId]);

  const loadAssignments = useCallback(async () => {
    try {
      const { assignments: list } = await api.getTagAssignments(projectId, entityType);
      setAssignments(list || []);
    } catch { /* ignore */ }
  }, [projectId, entityType]);

  const loadNotes = useCallback(async () => {
    try {
      const { notes: list } = await api.getEntityNotes(projectId, entityType);
      setNotes(list || []);
    } catch { /* ignore */ }
  }, [projectId, entityType]);

  const loadViews = useCallback(async () => {
    try {
      const { views: list } = await api.getSavedViews(projectId);
      setViews(list || []);
    } catch { /* ignore */ }
  }, [projectId]);

  useEffect(() => { loadData({ clearRows: true }); }, [loadData]);
  useEffect(() => { loadTags(); loadViews(); }, [loadTags, loadViews]);
  useEffect(() => { loadAssignments(); }, [loadAssignments]);
  useEffect(() => { loadNotes(); }, [loadNotes]);
  useEffect(() => {
    setSelectedIds([]);
    setBulkTagId('');
  }, [queryKey, entityType, filters]);

  useEffect(() => {
    setColumns((prev) => {
      const valid = prev.filter((col) => columnAvailable(col, level));
      return valid.length > 0 ? valid : DEFAULT_COLUMNS_BY_LEVEL[level];
    });
    setSort((prev) => columnAvailable(prev.field, level) ? prev : { field: 'spend', dir: 'desc' });
  }, [level]);

  const tagsByEntity = useMemo(() => {
    const map = new Map();
    for (const a of assignments) {
      const arr = map.get(a.entity_id) || [];
      arr.push(a.tag_id);
      map.set(a.entity_id, arr);
    }
    return map;
  }, [assignments]);

  const notesByEntity = useMemo(() => {
    const map = new Map();
    for (const note of notes) {
      map.set(String(note.entity_id), note);
    }
    return map;
  }, [notes]);

  const rowsWithNotes = useMemo(() => (
    rows.map((row) => {
      const note = notesByEntity.get(String(row.id));
      return { ...row, note_text: note?.note || '' };
    })
  ), [rows, notesByEntity]);

  const filteredSortedRows = useMemo(() => {
    let out = rowsWithNotes;
    if (filters.length > 0) {
      out = out.filter((row) => filters.every((filter) => matchesFilter(row, filter, tagsByEntity)));
    }
    const def = COLUMN_DEFS[sort.field];
    if (def) {
      const dirMul = sort.dir === 'asc' ? 1 : -1;
      out = [...out].sort((a, b) => {
        const av = def.accessor(a);
        const bv = def.accessor(b);
        if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dirMul;
        return String(av).localeCompare(String(bv)) * dirMul;
      });
    }
    return out;
  }, [rowsWithNotes, filters, sort, tagsByEntity]);

  const cappedRows = filteredSortedRows.slice(0, ROW_CAP);
  const hitCap = filteredSortedRows.length > ROW_CAP;
  const visibleIds = useMemo(() => cappedRows.map((row) => String(row.id)), [cappedRows]);
  const visibleSelectedIds = selectedIds.filter((id) => visibleIds.includes(id));
  const allVisibleSelected = visibleIds.length > 0 && visibleSelectedIds.length === visibleIds.length;

  const toggleSort = (field) => {
    setSort((prev) => prev.field === field
      ? { field, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      : { field, dir: 'desc' });
  };

  const handleLevelChange = (nextLevel) => {
    setLevel(nextLevel);
    if (nextLevel === 'campaigns') setScope(emptyScope());
    if (nextLevel === 'adsets') setScope((prev) => ({ ...prev, adsetId: null, adsetName: null }));
  };

  const drillIntoRow = (row) => {
    if (level === 'campaigns') {
      setScope({ campaignId: String(row.id), campaignName: row.name || String(row.id), adsetId: null, adsetName: null });
      setLevel('adsets');
    } else if (level === 'adsets') {
      setScope((prev) => ({
        campaignId: row.campaign_id || prev.campaignId,
        campaignName: row.campaign_name || prev.campaignName,
        adsetId: String(row.id),
        adsetName: row.name || String(row.id),
      }));
      setLevel('ads');
    }
  };

  const handleApplyTag = async (row, tag) => {
    try {
      await api.applyTag(projectId, {
        tag_id: tag.externalId,
        entity_type: entityType,
        entity_id: String(row.id),
        entity_id_kind: 'meta',
      });
      await loadAssignments();
    } catch (err) { toast.error(err.message); }
  };

  const handleRemoveTag = async (row, tag) => {
    try {
      await api.removeTagAssignment(projectId, {
        tag_id: tag.externalId,
        entity_id: String(row.id),
        entity_type: entityType,
      });
      await loadAssignments();
    } catch (err) { toast.error(err.message); }
  };

  const handleCreateAndApplyTag = async (row, { name, color }) => {
    try {
      const { externalId } = await api.createTag(projectId, { name, color });
      await loadTags();
      await api.applyTag(projectId, {
        tag_id: externalId,
        entity_type: entityType,
        entity_id: String(row.id),
        entity_id_kind: 'meta',
      });
      await loadAssignments();
    } catch (err) { toast.error(err.message); }
  };

  const handleUpdateNote = async (row, note) => {
    try {
      await api.updateEntityNote(projectId, {
        entity_type: entityType,
        entity_id: String(row.id),
        entity_id_kind: 'meta',
        note,
      });
      await loadNotes();
    } catch (err) { toast.error(err.message); }
  };

  const handleBulkApplyTag = async () => {
    if (!bulkTagId || selectedIds.length === 0) return;
    try {
      await api.applyTagsBulk(projectId, {
        tag_id: bulkTagId,
        entity_type: entityType,
        entity_ids: selectedIds,
        entity_id_kind: 'meta',
      });
      await loadAssignments();
      toast.success(`Tagged ${selectedIds.length} ${entityType.replace('_', ' ')}${selectedIds.length === 1 ? '' : 's'}`);
    } catch (err) { toast.error(err.message); }
  };

  const handleBulkRemoveTag = async () => {
    if (!bulkTagId || selectedIds.length === 0) return;
    try {
      await api.removeTagAssignmentsBulk(projectId, {
        tag_id: bulkTagId,
        entity_type: entityType,
        entity_ids: selectedIds,
      });
      await loadAssignments();
      toast.success(`Removed tag from ${selectedIds.length} row${selectedIds.length === 1 ? '' : 's'}`);
    } catch (err) { toast.error(err.message); }
  };

  const handleBulkAppendNote = async (note) => {
    if (!String(note || '').trim() || selectedIds.length === 0) return;
    try {
      await api.appendEntityNotesBulk(projectId, {
        entity_type: entityType,
        entity_ids: selectedIds,
        entity_id_kind: 'meta',
        note,
      });
      await loadNotes();
      toast.success(`Appended note to ${selectedIds.length} row${selectedIds.length === 1 ? '' : 's'}`);
    } catch (err) { toast.error(err.message); }
  };

  const handleCreateTagOnly = async ({ name, color }) => {
    await api.createTag(projectId, { name, color });
    await loadTags();
  };

  const handleUpdateTag = async (tagId, { name, color }) => {
    await api.updateTag(projectId, tagId, { name, color });
    await loadTags();
  };

  const handleDeleteTag = async (tagId) => {
    try {
      await api.deleteTag(projectId, tagId);
      await loadTags();
      await loadAssignments();
      toast.success('Tag deleted');
    } catch (err) {
      const message = err.message || '';
      if (/tag not found|already removed/i.test(message)) {
        await loadTags();
        await loadAssignments();
        toast.success('Tag was already removed');
        return;
      }
      toast.error(message || 'Failed to delete tag');
    }
  };

  const handleSaveView = async ({ name, scope: viewScope }) => {
    const config = {
      version: 2,
      datePreset,
      customRange,
      scope,
      filters,
      sort,
      columns,
    };
    const { externalId } = await api.createSavedView(projectId, { name, scope: viewScope, level, config });
    await loadViews();
    setActiveViewId(externalId);
    toast.success(`Saved "${name}"`);
  };

  const handleSelectView = (view) => {
    if (!view) {
      setActiveViewId(null);
      setDatePreset('last_7d');
      setCustomRange({ from: '', to: '' });
      setScope(emptyScope());
      setFilters([]);
      setSort({ field: 'spend', dir: 'desc' });
      setColumns(DEFAULT_COLUMNS_BY_LEVEL[level]);
      return;
    }
    setActiveViewId(view.externalId);
    if (view.level && view.level !== level) setLevel(view.level);
    let cfg = view.config;
    try { cfg = typeof cfg === 'string' ? JSON.parse(cfg) : cfg; } catch { cfg = {}; }
    if (cfg.datePreset) setDatePreset(cfg.datePreset);
    if (cfg.customRange) setCustomRange({ from: cfg.customRange.from || '', to: cfg.customRange.to || '' });
    if (cfg.scope) setScope({ ...emptyScope(), ...cfg.scope });
    if (cfg.filters) setFilters(normalizeFilters(cfg.filters));
    if (cfg.sort) setSort(cfg.sort);
    if (Array.isArray(cfg.columns) && cfg.columns.length > 0) setColumns(cfg.columns);
  };

  const handleDeleteView = async (view) => {
    try {
      await api.deleteSavedView(projectId, view.externalId);
      await loadViews();
      if (activeViewId === view.externalId) setActiveViewId(null);
      toast.success('View deleted');
    } catch (err) { toast.error(err.message); }
  };

  const clearScope = () => {
    setScope(emptyScope());
    setLevel('campaigns');
  };

  const toggleRowSelection = (id) => {
    const key = String(id);
    setSelectedIds((prev) => prev.includes(key)
      ? prev.filter((item) => item !== key)
      : [...prev, key]);
  };

  const toggleSelectAllVisible = () => {
    setSelectedIds((prev) => {
      if (allVisibleSelected) {
        return prev.filter((id) => !visibleIds.includes(id));
      }
      return [...new Set([...prev, ...visibleIds])];
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="page-tabs">
          {LEVELS.map((l) => (
            <button key={l.id} onClick={() => handleLevelChange(l.id)} className={level === l.id ? 'active' : ''}>
              {l.label}
            </button>
          ))}
        </div>

        <select
          value={datePreset}
          onChange={(e) => setDatePreset(e.target.value)}
          title="Choose the Meta reporting window. Use Custom for an exact start and end date."
          className="text-[12px] px-2 py-1.5 border border-gray-200 rounded-lg bg-white focus:outline-none focus:border-navy"
        >
          {DATE_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>
        {datePreset === 'custom' && (
          <div className="flex items-center gap-1.5">
            <input
              type="date"
              value={customRange.from}
              onChange={(e) => setCustomRange((prev) => ({ ...prev, from: e.target.value }))}
              className="text-[12px] px-2 py-1.5 border border-gray-200 rounded-lg bg-white focus:outline-none focus:border-navy"
            />
            <span className="text-[11px] text-textlight">to</span>
            <input
              type="date"
              value={customRange.to}
              onChange={(e) => setCustomRange((prev) => ({ ...prev, to: e.target.value }))}
              className="text-[12px] px-2 py-1.5 border border-gray-200 rounded-lg bg-white focus:outline-none focus:border-navy"
            />
          </div>
        )}

        <div className="flex-1" />

        <SavedViewPicker
          views={views}
          activeViewId={activeViewId}
          onSelect={handleSelectView}
          onSaveNew={() => setShowSaveView(true)}
          onDelete={handleDeleteView}
        />

        <span className="inline-flex items-center gap-1">
          <button onClick={() => setShowManageTags(true)} className="btn-secondary text-[12px] px-3 py-1.5">
            Manage tags
          </button>
          <InfoTooltip text="Create, rename, recolor, or delete project tags. Tags are shared across Analytics and Observation." position="bottom" />
        </span>

        <button onClick={loadData} disabled={loading} className="btn-secondary text-[12px] px-3 py-1.5">
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      {(scope.campaignId || scope.adsetId) && (
        <div className="flex flex-wrap items-center gap-2 text-[12px]">
          <button onClick={clearScope} className="text-textmid hover:text-textdark">Campaigns</button>
          {scope.campaignId && (
            <>
              <span className="text-textlight">/</span>
              <button
                onClick={() => { setLevel('adsets'); setScope((prev) => ({ ...prev, adsetId: null, adsetName: null })); }}
                className="text-textmid hover:text-textdark"
              >
                {scope.campaignName || scope.campaignId}
              </button>
            </>
          )}
          {scope.adsetId && (
            <>
              <span className="text-textlight">/</span>
              <span className="font-medium text-textdark">{scope.adsetName || scope.adsetId}</span>
            </>
          )}
          <button onClick={clearScope} className="text-[11px] text-textlight hover:text-textdark ml-1">Clear scope</button>
        </div>
      )}

      <div className="flex flex-wrap items-start gap-2">
        <span className="inline-flex items-center gap-1">
          <button onClick={() => setFilters((prev) => [...prev, newFilter(level)])} className="btn-secondary text-[12px] px-3 py-1.5">
            + Filter
          </button>
          <InfoTooltip text="Filter the rows currently loaded for this level. Filters stay with your current Campaign, Ad Set, or Ads view." position="bottom" />
        </span>
        <div className="relative inline-flex items-center gap-1">
          <button onClick={() => setShowColumnPicker((v) => !v)} className="btn-secondary text-[12px] px-3 py-1.5">
            Columns ({columns.length})
          </button>
          <InfoTooltip text="Choose which Meta fields and local workflow fields appear in this table. Use saved views when you want to reuse a layout." position="bottom" />
          {showColumnPicker && (
            <ColumnPicker
              columns={columns}
              availableColumns={availableColumns}
              onChange={setColumns}
              onReset={() => setColumns(DEFAULT_COLUMNS_BY_LEVEL[level])}
              onClose={() => setShowColumnPicker(false)}
            />
          )}
        </div>
        {filters.length > 0 && (
          <button onClick={() => setFilters([])} className="text-[11px] text-textlight hover:text-textdark py-1.5">
            Clear filters
          </button>
        )}
        <span className="text-[11px] text-textlight ml-auto py-1.5">
          {filteredSortedRows.length} {entityType.replace('_', ' ')}{filteredSortedRows.length === 1 ? '' : 's'}
          {hitCap && ` (showing first ${ROW_CAP})`}
        </span>
      </div>

      {filters.length > 0 && (
        <div className="flex flex-col gap-2">
          {filters.map((filter) => (
            <FilterRow
              key={filter.id}
              filter={filter}
              level={level}
              tags={tags}
              onChange={(next) => setFilters((prev) => prev.map((f) => f.id === filter.id ? next : f))}
              onRemove={() => setFilters((prev) => prev.filter((f) => f.id !== filter.id))}
            />
          ))}
        </div>
      )}

      {tokenExpired && (
        <div className="card p-4 border border-amber-200 bg-amber-50/40 text-[12px] text-textdark">
          Meta token expired. Reconnect from <strong>Project Settings - Meta</strong>.
        </div>
      )}
      {error && !tokenExpired && (
        <div className="card p-4 border border-red-200 bg-red-50/40 text-[12px] text-red-600">
          {error}
        </div>
      )}

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead className="bg-gray-50/60 border-b border-gray-100">
              <tr>
                <th className="px-3 py-2 w-10">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleSelectAllVisible}
                    className="rounded border-navy/30 text-navy focus:ring-navy/20"
                    aria-label="Select all visible rows"
                  />
                </th>
                {columns.map((col) => {
                  if (col === 'tags') {
                    return <th key={col} className="px-3 py-2 text-left font-medium text-textmid w-48">Tags</th>;
                  }
                  const def = COLUMN_DEFS[col];
                  if (!def) return null;
                  const isSorted = sort.field === col;
                  return (
                    <th
                      key={col}
                      onClick={() => toggleSort(col)}
                      className={`px-3 py-2 ${def.align === 'right' ? 'text-right' : 'text-left'} font-medium text-textmid cursor-pointer hover:text-textdark select-none ${def.width}`}
                    >
                      <span className="inline-flex items-center gap-1">
                        {def.label}
                        {isSorted && <span className="text-[8px]">{sort.dir === 'asc' ? '▲' : '▼'}</span>}
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 && (
                <tr><td colSpan={columns.length + 1} className="px-3 py-12 text-center text-textlight">Loading...</td></tr>
              )}
              {!loading && cappedRows.length === 0 && (
                <tr><td colSpan={columns.length + 1} className="px-3 py-12 text-center text-textlight">No rows match.</td></tr>
              )}
              {cappedRows.map((row) => {
                const appliedIds = tagsByEntity.get(row.id) || [];
                const selected = selectedIds.includes(String(row.id));
                return (
                  <tr key={row.id} className={`border-b border-gray-50 hover:bg-gray-50/50 ${selected ? 'bg-gold/5' : ''}`}>
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={selected}
                        onChange={() => toggleRowSelection(row.id)}
                        onClick={(e) => e.stopPropagation()}
                        className="rounded border-navy/30 text-navy focus:ring-navy/20"
                        aria-label={`Select ${row.name || row.id}`}
                      />
                    </td>
                    {columns.map((col) => {
                      if (col === 'tags') {
                        return (
                          <td key={col} className="px-3 py-2">
                            <RowTagCell
                              row={row}
                              allTags={tags}
                              appliedIds={appliedIds}
                              onApply={(tag) => handleApplyTag(row, tag)}
                              onRemove={(tag) => handleRemoveTag(row, tag)}
                              onCreate={(t) => handleCreateAndApplyTag(row, t)}
                              isOpen={tagPickerForRow === row.id}
                              setOpen={(open) => setTagPickerForRow(open ? row.id : null)}
                            />
                          </td>
                        );
                      }
                      if (col === 'notes') {
                        return (
                          <td key={col} className="px-3 py-2">
                            <NotesCell note={row.note_text || ''} onSave={(note) => handleUpdateNote(row, note)} />
                          </td>
                        );
                      }
                      if (col === 'name') {
                        const canDrill = level === 'campaigns' || level === 'adsets';
                        return (
                          <td key={col} className="px-3 py-2 text-textdark">
                            <div className="flex items-center gap-2 min-w-0">
                              <button
                                onClick={() => canDrill && drillIntoRow(row)}
                                disabled={!canDrill}
                                className={`truncate text-left ${canDrill ? 'text-navy hover:text-gold font-medium' : ''}`}
                                title={row.name}
                              >
                                {row.name || '—'}
                              </button>
                              {row.cf_source && (
                                <span title="Created via Creative Factory" className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-gold/10 text-gold flex-shrink-0">CF</span>
                              )}
                            </div>
                          </td>
                        );
                      }
                      if (col === 'status') {
                        return <td key={col} className="px-3 py-2">{statusBadge(row.effective_status || row.status)}</td>;
                      }
                      const def = COLUMN_DEFS[col];
                      if (!def) return null;
                      const v = def.accessor(row);
                      const display = def.render ? def.render(v, row) : def.format ? def.format(v) : (v || '—');
                      return (
                        <td key={col} className={`px-3 py-2 ${def.align === 'right' ? 'text-right' : 'text-left'} text-textdark tabular-nums`}>
                          {display}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="px-3 py-2 border-t border-gray-100 text-[10px] text-textlight">
          Data may lag Meta Ads Manager by up to 24h.
        </div>
      </div>

      <BulkActionBar
        selectedCount={selectedIds.length}
        tags={tags}
        selectedTagId={bulkTagId}
        onTagChange={setBulkTagId}
        onApplyTag={handleBulkApplyTag}
        onRemoveTag={handleBulkRemoveTag}
        onAppendNote={handleBulkAppendNote}
        onClear={() => setSelectedIds([])}
      />

      <TagManageDialog
        open={showManageTags}
        tags={tags}
        onClose={() => setShowManageTags(false)}
        onCreate={handleCreateTagOnly}
        onUpdate={handleUpdateTag}
        onDelete={handleDeleteTag}
      />

      <SaveViewDialog
        open={showSaveView}
        onClose={() => setShowSaveView(false)}
        onSave={handleSaveView}
      />
    </div>
  );
}

export function ColumnPicker({ columns, availableColumns, onChange, onReset, onClose }) {
  const [query, setQuery] = useState('');
  const filtered = availableColumns.filter((col) => col.label.toLowerCase().includes(query.toLowerCase()) || col.id.toLowerCase().includes(query.toLowerCase()));
  return (
    <div className="absolute z-40 top-full left-0 mt-2 w-72 bg-white border border-gray-200 rounded-xl shadow-card p-3">
      <div className="flex items-center gap-2 mb-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search columns..."
          className="text-[12px] px-2 py-1.5 border border-gray-200 rounded-lg flex-1 focus:outline-none focus:border-navy"
        />
        <button onClick={onClose} className="text-[14px] text-textlight hover:text-textdark px-1">×</button>
      </div>
      <div className="max-h-72 overflow-auto space-y-1">
        {filtered.map((col) => {
          const checked = columns.includes(col.id);
          return (
            <label key={col.id} className="flex items-center gap-2 text-[12px] px-2 py-1.5 rounded-lg hover:bg-gray-50 cursor-pointer">
              <input
                type="checkbox"
                checked={checked}
                onChange={() => onChange(checked ? columns.filter((c) => c !== col.id) : [...columns, col.id])}
                className="rounded border-navy/30 text-navy focus:ring-navy/20"
              />
              <span className="flex-1 text-textdark">{col.label}</span>
              <span className="text-[10px] text-textlight">{col.type}</span>
            </label>
          );
        })}
      </div>
      <div className="flex items-center justify-between pt-2 mt-2 border-t border-gray-100">
        <button onClick={onReset} className="text-[11px] text-textlight hover:text-textdark">Reset defaults</button>
        <span className="text-[10px] text-textlight">{columns.length} selected</span>
      </div>
    </div>
  );
}

export function FilterRow({ filter, level, tags, onChange, onRemove }) {
  const fields = filterableColumns(level);
  const selected = fields.find((f) => f.id === filter.field) || fields[0];
  const type = selected?.type || 'string';
  const ops = FILTER_OPERATORS[type] || FILTER_OPERATORS.string;
  const op = ops.some((o) => o.id === filter.op) ? filter.op : ops[0].id;

  useEffect(() => {
    if (op !== filter.op) onChange({ ...filter, op });
  }, [filter, op, onChange]);

  return (
    <div className="flex flex-wrap items-center gap-2 bg-white border border-gray-100 rounded-xl px-3 py-2">
      <select
        value={filter.field}
        onChange={(e) => {
          const nextField = e.target.value;
          const nextType = fields.find((f) => f.id === nextField)?.type || 'string';
          onChange({ ...filter, field: nextField, op: FILTER_OPERATORS[nextType][0].id, value: '', valueTo: '' });
        }}
        className="text-[12px] px-2 py-1.5 border border-gray-200 rounded-lg bg-white focus:outline-none focus:border-navy"
      >
        {fields.map((field) => <option key={field.id} value={field.id}>{field.label}</option>)}
      </select>
      <select
        value={op}
        onChange={(e) => onChange({ ...filter, op: e.target.value })}
        className="text-[12px] px-2 py-1.5 border border-gray-200 rounded-lg bg-white focus:outline-none focus:border-navy"
      >
        {ops.map((operator) => <option key={operator.id} value={operator.id}>{operator.label}</option>)}
      </select>
      {!['empty', 'not_empty'].includes(op) && type === 'tags' && (
        <select
          value={filter.value || ''}
          onChange={(e) => onChange({ ...filter, value: e.target.value })}
          className="text-[12px] px-2 py-1.5 border border-gray-200 rounded-lg bg-white focus:outline-none focus:border-navy"
        >
          <option value="">Choose tag...</option>
          {tags.map((tag) => <option key={tag.externalId} value={tag.externalId}>{tag.name}</option>)}
        </select>
      )}
      {!['empty', 'not_empty'].includes(op) && type !== 'tags' && (
        <input
          type={type === 'number' ? 'number' : type === 'date' ? 'date' : 'text'}
          value={filter.value || ''}
          onChange={(e) => onChange({ ...filter, value: e.target.value })}
          className="text-[12px] px-2 py-1.5 border border-gray-200 rounded-lg w-44 focus:outline-none focus:border-navy"
          placeholder="Value"
        />
      )}
      {op === 'between' && type !== 'tags' && (
        <input
          type={type === 'number' ? 'number' : type === 'date' ? 'date' : 'text'}
          value={filter.valueTo || ''}
          onChange={(e) => onChange({ ...filter, valueTo: e.target.value })}
          className="text-[12px] px-2 py-1.5 border border-gray-200 rounded-lg w-44 focus:outline-none focus:border-navy"
          placeholder="And"
        />
      )}
      <button onClick={onRemove} className="text-[13px] text-textlight hover:text-red-500 px-1 ml-auto">×</button>
    </div>
  );
}

export function RowTagCell({ row, allTags, appliedIds, onApply, onRemove, onCreate, isOpen, setOpen }) {
  const anchorRef = useRef(null);
  const applied = (allTags || []).filter((t) => appliedIds.includes(t.externalId));

  return (
    <div className="flex items-center flex-wrap gap-1 min-h-[24px]">
      {applied.map((t) => (
        <span
          key={t.externalId}
          className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full border"
          style={{
            background: `${t.color}15`,
            borderColor: `${t.color}40`,
            color: t.color,
          }}
        >
          {t.name}
          <button
            onClick={() => onRemove(t)}
            className="hover:text-textdark"
            title="Remove tag"
          >
            ×
          </button>
        </span>
      ))}
      <div className="relative inline-block">
        <button
          ref={anchorRef}
          onClick={() => setOpen(!isOpen)}
          className="text-[10px] text-textlight hover:text-textdark px-1.5 py-0.5 border border-dashed border-gray-300 rounded-full"
        >
          + Tag
        </button>
        {isOpen && (
          <TagPicker
            allTags={allTags}
            appliedTagIds={appliedIds}
            anchorRef={anchorRef}
            onApply={onApply}
            onRemove={onRemove}
            onCreate={onCreate}
            onClose={() => setOpen(false)}
          />
        )}
      </div>
    </div>
  );
}

export function NotesCell({ note, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note || '');

  useEffect(() => {
    if (!editing) setDraft(note || '');
  }, [note, editing]);

  if (editing) {
    return (
      <div className="space-y-1 min-w-[220px]">
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={3}
          className="w-full text-[12px] px-2 py-1.5 border border-gray-200 rounded-lg focus:outline-none focus:border-navy resize-y"
          placeholder="Add a note..."
        />
        <div className="flex items-center gap-2">
          <button
            onClick={async () => { await onSave(draft); setEditing(false); }}
            className="btn-primary text-[10px] px-2 py-1"
          >
            Save
          </button>
          <button
            onClick={() => { setDraft(note || ''); setEditing(false); }}
            className="text-[10px] text-textlight hover:text-textdark"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <button
      onClick={() => setEditing(true)}
      className="text-left text-[12px] text-textmid hover:text-textdark max-w-[260px]"
      title={note || 'Add note'}
    >
      {note ? (
        <span className="block max-h-10 overflow-hidden whitespace-pre-wrap">{note}</span>
      ) : (
        <span className="text-textlight">+ Note</span>
      )}
    </button>
  );
}

export function BulkActionBar({
  selectedCount,
  tags,
  selectedTagId,
  onTagChange,
  onApplyTag,
  onRemoveTag,
  onAppendNote,
  onClear,
}) {
  if (selectedCount <= 0) return null;
  return (
    <div className="fixed left-1/2 bottom-4 z-50 w-[min(760px,calc(100vw-24px))] -translate-x-1/2 rounded-xl border border-gray-200 bg-white shadow-card px-3 py-2 flex flex-wrap items-center gap-2">
      <span className="text-[12px] font-medium text-textdark mr-1">{selectedCount} selected</span>
      <select
        value={selectedTagId}
        onChange={(e) => onTagChange(e.target.value)}
        className="text-[12px] px-2 py-1.5 border border-gray-200 rounded-lg bg-white focus:outline-none focus:border-navy min-w-[160px]"
      >
        <option value="">Choose tag...</option>
        {(tags || []).map((tag) => <option key={tag.externalId} value={tag.externalId}>{tag.name}</option>)}
      </select>
      <button disabled={!selectedTagId} onClick={onApplyTag} className="btn-secondary text-[11px] px-3 py-1.5 disabled:opacity-50">
        Apply tag
      </button>
      <button disabled={!selectedTagId} onClick={onRemoveTag} className="btn-secondary text-[11px] px-3 py-1.5 disabled:opacity-50">
        Remove tag
      </button>
      <button
        onClick={() => {
          const note = prompt('Append note to selected rows');
          if (note !== null) onAppendNote(note);
        }}
        className="btn-secondary text-[11px] px-3 py-1.5"
      >
        Append note
      </button>
      <button onClick={onClear} className="text-[11px] text-textlight hover:text-textdark ml-auto px-2">
        Clear
      </button>
    </div>
  );
}

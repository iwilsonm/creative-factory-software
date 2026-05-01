// Phase 5 — Analytics tab. Notion-style table over Meta-side Campaigns / Ad Sets / Ads
// for a project's connected ad account. Supports sortable columns, client-side filtering,
// per-row tagging, and saved views (private + project-shared).

import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { api } from '../api';
import { useToast } from './Toast';
import TagPicker from './analytics/TagPicker';
import TagManageDialog from './analytics/TagManageDialog';
import SavedViewPicker from './analytics/SavedViewPicker';
import SaveViewDialog from './analytics/SaveViewDialog';

const LEVELS = [
  { id: 'campaigns', label: 'Campaigns', entity: 'campaign' },
  { id: 'adsets',    label: 'Ad Sets',   entity: 'ad_set' },
  { id: 'ads',       label: 'Ads',       entity: 'ad' },
];

const DATE_PRESETS = [
  { id: 'today',      label: 'Today' },
  { id: 'yesterday',  label: 'Yesterday' },
  { id: 'last_3d',    label: 'Last 3d' },
  { id: 'last_7d',    label: 'Last 7d' },
  { id: 'last_14d',   label: 'Last 14d' },
  { id: 'last_30d',   label: 'Last 30d' },
  { id: 'last_90d',   label: 'Last 90d' },
  { id: 'this_month', label: 'This month' },
  { id: 'last_month', label: 'Last month' },
  { id: 'lifetime',   label: 'Lifetime' },
];

const DEFAULT_COLUMNS = ['name', 'status', 'impressions', 'clicks', 'spend', 'ctr', 'cpm', 'cpc', 'roas', 'tags'];
const ROW_CAP = 1000;

const NUMBER_FMT = new Intl.NumberFormat('en-US');
const DOLLAR_FMT = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const PERCENT_FMT = new Intl.NumberFormat('en-US', { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2 });

function getRoas(row) {
  const arr = row.purchase_roas;
  if (!Array.isArray(arr) || arr.length === 0) return 0;
  const v = parseFloat(arr[0]?.value || 0);
  return isFinite(v) ? v : 0;
}

const COLUMN_DEFS = {
  name:        { label: 'Name',        width: 'w-64', accessor: r => r.name || '—' },
  status:      { label: 'Status',      width: 'w-28', accessor: r => r.effective_status || r.status || '—' },
  impressions: { label: 'Impr.',       width: 'w-24', accessor: r => Number(r.impressions || 0), format: NUMBER_FMT.format, align: 'right' },
  clicks:      { label: 'Clicks',      width: 'w-20', accessor: r => Number(r.clicks || 0),      format: NUMBER_FMT.format, align: 'right' },
  spend:       { label: 'Spend',       width: 'w-24', accessor: r => Number(r.spend || 0),       format: DOLLAR_FMT.format, align: 'right' },
  reach:       { label: 'Reach',       width: 'w-24', accessor: r => Number(r.reach || 0),       format: NUMBER_FMT.format, align: 'right' },
  frequency:   { label: 'Freq.',       width: 'w-20', accessor: r => Number(r.frequency || 0),   format: v => v.toFixed(2), align: 'right' },
  ctr:         { label: 'CTR',         width: 'w-20', accessor: r => Number(r.ctr || 0) / 100,   format: PERCENT_FMT.format, align: 'right' },
  cpm:         { label: 'CPM',         width: 'w-20', accessor: r => Number(r.cpm || 0),         format: DOLLAR_FMT.format, align: 'right' },
  cpc:         { label: 'CPC',         width: 'w-20', accessor: r => Number(r.cpc || 0),         format: DOLLAR_FMT.format, align: 'right' },
  cpp:         { label: 'CPP',         width: 'w-20', accessor: r => Number(r.cpp || 0),         format: DOLLAR_FMT.format, align: 'right' },
  roas:        { label: 'ROAS',        width: 'w-20', accessor: r => getRoas(r),                 format: v => v.toFixed(2), align: 'right' },
};

const STATUS_PILL = {
  ACTIVE:   'bg-teal/10 text-teal',
  PAUSED:   'bg-gold/10 text-gold',
  DELETED:  'bg-gray-100 text-textlight',
  ARCHIVED: 'bg-gray-100 text-textlight',
};

function statusBadge(s) {
  const cls = STATUS_PILL[s?.toUpperCase()] || 'bg-gray-100 text-textmid';
  return <span className={`badge ${cls}`}>{s || '—'}</span>;
}

export default function AnalyticsTab({ projectId }) {
  const toast = useToast();
  const [level, setLevel] = useState('campaigns');
  const [datePreset, setDatePreset] = useState('last_7d');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [tokenExpired, setTokenExpired] = useState(false);

  const [tags, setTags] = useState([]);
  const [assignments, setAssignments] = useState([]);
  const [views, setViews] = useState([]);
  const [activeViewId, setActiveViewId] = useState(null);

  const [filterText, setFilterText] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [tagFilter, setTagFilter] = useState([]);
  const [sort, setSort] = useState({ field: 'spend', dir: 'desc' });
  const [columns, setColumns] = useState(DEFAULT_COLUMNS);

  const [tagPickerForRow, setTagPickerForRow] = useState(null);
  const [showManageTags, setShowManageTags] = useState(false);
  const [showSaveView, setShowSaveView] = useState(false);

  const entityType = useMemo(() => LEVELS.find(l => l.id === level)?.entity, [level]);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    setTokenExpired(false);
    try {
      const opts = { datePreset };
      let payload;
      if (level === 'campaigns') payload = await api.getAnalyticsCampaigns(projectId, opts);
      else if (level === 'adsets') payload = await api.getAnalyticsAdSets(projectId, opts);
      else payload = await api.getAnalyticsAds(projectId, opts);
      setRows(payload.campaigns || payload.adsets || payload.ads || []);
    } catch (err) {
      if (/token/i.test(err.message) && /expired|reconnect/i.test(err.message)) {
        setTokenExpired(true);
      }
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [projectId, level, datePreset]);

  const loadTags = useCallback(async () => {
    try {
      const { tags: list } = await api.getTags(projectId);
      setTags(list || []);
    } catch { /* fall through */ }
  }, [projectId]);

  const loadAssignments = useCallback(async () => {
    try {
      const { assignments: list } = await api.getTagAssignments(projectId, entityType);
      setAssignments(list || []);
    } catch { /* fall through */ }
  }, [projectId, entityType]);

  const loadViews = useCallback(async () => {
    try {
      const { views: list } = await api.getSavedViews(projectId);
      setViews(list || []);
    } catch { /* fall through */ }
  }, [projectId]);

  useEffect(() => { loadData(); }, [loadData]);
  useEffect(() => { loadTags(); loadViews(); }, [loadTags, loadViews]);
  useEffect(() => { loadAssignments(); }, [loadAssignments]);

  const tagsByEntity = useMemo(() => {
    const map = new Map();
    for (const a of assignments) {
      const arr = map.get(a.entity_id) || [];
      arr.push(a.tag_id);
      map.set(a.entity_id, arr);
    }
    return map;
  }, [assignments]);

  const filteredSortedRows = useMemo(() => {
    let out = rows;
    if (filterText) {
      const q = filterText.toLowerCase();
      out = out.filter(r => (r.name || '').toLowerCase().includes(q));
    }
    if (statusFilter !== 'all') {
      out = out.filter(r => (r.effective_status || r.status || '').toUpperCase() === statusFilter);
    }
    if (tagFilter.length > 0) {
      out = out.filter(r => {
        const ids = tagsByEntity.get(r.id) || [];
        return tagFilter.every(tid => ids.includes(tid));
      });
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
  }, [rows, filterText, statusFilter, tagFilter, sort, tagsByEntity]);

  const cappedRows = filteredSortedRows.slice(0, ROW_CAP);
  const hitCap = filteredSortedRows.length > ROW_CAP;

  const toggleSort = (field) => {
    setSort(prev => prev.field === field
      ? { field, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      : { field, dir: 'desc' });
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

  const handleCreateTagOnly = async ({ name, color }) => {
    await api.createTag(projectId, { name, color });
    await loadTags();
  };

  const handleUpdateTag = async (tagId, { name, color }) => {
    await api.updateTag(projectId, tagId, { name, color });
    await loadTags();
  };

  const handleDeleteTag = async (tagId) => {
    await api.deleteTag(projectId, tagId);
    await loadTags();
    await loadAssignments();
  };

  const handleSaveView = async ({ name, scope }) => {
    const config = {
      datePreset,
      filters: { name: filterText, status: statusFilter, tags: tagFilter },
      sort,
      columns,
    };
    const { externalId } = await api.createSavedView(projectId, { name, scope, level, config });
    await loadViews();
    setActiveViewId(externalId);
    toast.success(`Saved "${name}"`);
  };

  const handleSelectView = (view) => {
    if (!view) {
      setActiveViewId(null);
      setFilterText('');
      setStatusFilter('all');
      setTagFilter([]);
      setSort({ field: 'spend', dir: 'desc' });
      setColumns(DEFAULT_COLUMNS);
      return;
    }
    setActiveViewId(view.externalId);
    if (view.level && view.level !== level) setLevel(view.level);
    let cfg = view.config;
    try { cfg = typeof cfg === 'string' ? JSON.parse(cfg) : cfg; } catch { cfg = {}; }
    if (cfg.datePreset) setDatePreset(cfg.datePreset);
    if (cfg.filters) {
      setFilterText(cfg.filters.name || '');
      setStatusFilter(cfg.filters.status || 'all');
      setTagFilter(cfg.filters.tags || []);
    }
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

  return (
    <div className="space-y-4">
      {/* Header — level + date + view picker + actions */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="page-tabs">
          {LEVELS.map(l => (
            <button key={l.id} onClick={() => setLevel(l.id)} className={level === l.id ? 'active' : ''}>
              {l.label}
            </button>
          ))}
        </div>

        <select
          value={datePreset}
          onChange={(e) => setDatePreset(e.target.value)}
          className="text-[12px] px-2 py-1.5 border border-gray-200 rounded-lg bg-white focus:outline-none focus:border-navy"
        >
          {DATE_PRESETS.map(p => (
            <option key={p.id} value={p.id}>{p.label}</option>
          ))}
        </select>

        <div className="flex-1" />

        <SavedViewPicker
          views={views}
          activeViewId={activeViewId}
          onSelect={handleSelectView}
          onSaveNew={() => setShowSaveView(true)}
          onDelete={handleDeleteView}
        />

        <button onClick={() => setShowManageTags(true)} className="btn-secondary text-[12px] px-3 py-1.5">
          Manage tags
        </button>

        <button onClick={loadData} disabled={loading} className="btn-secondary text-[12px] px-3 py-1.5">
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          placeholder="Filter by name…"
          className="text-[12px] px-2 py-1.5 border border-gray-200 rounded-lg w-56 focus:outline-none focus:border-navy"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="text-[12px] px-2 py-1.5 border border-gray-200 rounded-lg bg-white focus:outline-none focus:border-navy"
        >
          <option value="all">All statuses</option>
          <option value="ACTIVE">Active</option>
          <option value="PAUSED">Paused</option>
          <option value="ARCHIVED">Archived</option>
          <option value="DELETED">Deleted</option>
        </select>

        <div className="flex flex-wrap gap-1.5">
          {tags.map(tag => {
            const on = tagFilter.includes(tag.externalId);
            return (
              <button
                key={tag.externalId}
                onClick={() => setTagFilter(prev => on ? prev.filter(id => id !== tag.externalId) : [...prev, tag.externalId])}
                className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-full border transition-colors"
                style={{
                  background: on ? `${tag.color}20` : 'white',
                  borderColor: on ? tag.color : '#e5e7eb',
                  color: on ? tag.color : '#4A5568',
                }}
              >
                <span className="w-2 h-2 rounded-full" style={{ background: tag.color }} />
                {tag.name}
              </button>
            );
          })}
        </div>

        {(filterText || statusFilter !== 'all' || tagFilter.length > 0) && (
          <button
            onClick={() => { setFilterText(''); setStatusFilter('all'); setTagFilter([]); }}
            className="text-[11px] text-textlight hover:text-textdark"
          >
            Clear filters
          </button>
        )}

        <span className="text-[11px] text-textlight ml-auto">
          {filteredSortedRows.length} {entityType.replace('_', ' ')}{filteredSortedRows.length === 1 ? '' : 's'}
          {hitCap && ` (showing first ${ROW_CAP})`}
        </span>
      </div>

      {tokenExpired && (
        <div className="card p-4 border border-amber-200 bg-amber-50/40 text-[12px] text-textdark">
          Meta token expired. Reconnect from <strong>Project Settings → Meta</strong>.
        </div>
      )}
      {error && !tokenExpired && (
        <div className="card p-4 border border-red-200 bg-red-50/40 text-[12px] text-red-600">
          {error}
        </div>
      )}

      {/* Data table */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead className="bg-gray-50/60 border-b border-gray-100">
              <tr>
                {columns.map(col => {
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
                        {isSorted && (
                          <span className="text-[8px]">{sort.dir === 'asc' ? '▲' : '▼'}</span>
                        )}
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 && (
                <tr><td colSpan={columns.length} className="px-3 py-12 text-center text-textlight">Loading…</td></tr>
              )}
              {!loading && cappedRows.length === 0 && (
                <tr><td colSpan={columns.length} className="px-3 py-12 text-center text-textlight">No rows match.</td></tr>
              )}
              {cappedRows.map(row => {
                const appliedIds = tagsByEntity.get(row.id) || [];
                return (
                  <tr key={row.id} className="border-b border-gray-50 hover:bg-gray-50/50">
                    {columns.map(col => {
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
                      if (col === 'name') {
                        return (
                          <td key={col} className="px-3 py-2 text-textdark">
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="truncate" title={row.name}>{row.name || '—'}</span>
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
                      const display = def.format ? def.format(v) : v;
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

function RowTagCell({ row, allTags, appliedIds, onApply, onRemove, onCreate, isOpen, setOpen }) {
  const anchorRef = useRef(null);
  const applied = (allTags || []).filter(t => appliedIds.includes(t.externalId));

  return (
    <div className="flex items-center flex-wrap gap-1 min-h-[24px]">
      {applied.map(t => (
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

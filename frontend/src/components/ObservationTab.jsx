// Phase 3 — Observation work surface. Uses the shared Analytics-style table
// controls for columns, filters, tags, notes, selection, and ad drilldown.

import { Fragment, useState, useEffect, useCallback, useMemo } from 'react';
import { api } from '../api';
import { useToast } from './Toast';
import ObservationPill from './observation/ObservationPill';
import AdSetTimeline from './observation/AdSetTimeline';
import TagManageDialog from './analytics/TagManageDialog';
import {
  BulkActionBar,
  COLUMN_DEFS,
  ColumnPicker,
  DEFAULT_COLUMNS_BY_LEVEL,
  DOLLAR_FMT,
  FilterRow,
  NotesCell,
  RowTagCell,
  filterableColumns,
  matchesFilter,
  newFilter,
  numberValue,
} from './AnalyticsTab';

const STATUS_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'observing', label: 'Observing' },
  { id: 'passed', label: 'Passed' },
  { id: 'failed', label: 'Failed' },
  { id: 'insufficient', label: 'Insufficient' },
];

function entityKey(type, id) {
  return `${type}:${id}`;
}

function noteMap(notes) {
  const map = new Map();
  for (const note of notes || []) map.set(String(note.entity_id), note);
  return map;
}

function formatCell(col, row) {
  const def = COLUMN_DEFS[col];
  if (!def) return '—';
  const value = def.accessor(row);
  if (def.render) return def.render(value, row);
  if (def.format) return def.format(value, row);
  return value || '—';
}

export default function ObservationTab({ projectId }) {
  const toast = useToast();
  const [adSets, setAdSets] = useState([]);
  const [archived, setArchived] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeAdSetId, setActiveAdSetId] = useState(null);
  const [previewAd, setPreviewAd] = useState(null);
  const [statusFilter, setStatusFilter] = useState('all');
  const [filters, setFilters] = useState([]);
  const [sort, setSort] = useState({ field: 'spend', dir: 'desc' });
  const [columns, setColumns] = useState(DEFAULT_COLUMNS_BY_LEVEL.observation);
  const [showColumnPicker, setShowColumnPicker] = useState(false);
  const [expandedIds, setExpandedIds] = useState([]);

  const [tags, setTags] = useState([]);
  const [adSetAssignments, setAdSetAssignments] = useState([]);
  const [adAssignments, setAdAssignments] = useState([]);
  const [adSetNotes, setAdSetNotes] = useState([]);
  const [adNotes, setAdNotes] = useState([]);
  const [tagPickerForRow, setTagPickerForRow] = useState(null);
  const [showManageTags, setShowManageTags] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState([]);
  const [bulkTagId, setBulkTagId] = useState('');

  const availableColumns = useMemo(() => filterableColumns('observation'), []);
  const adSetNotesById = useMemo(() => noteMap(adSetNotes), [adSetNotes]);
  const adNotesById = useMemo(() => noteMap(adNotes), [adNotes]);

  const tagsByAdSet = useMemo(() => {
    const map = new Map();
    for (const assignment of adSetAssignments) {
      const arr = map.get(assignment.entity_id) || [];
      arr.push(assignment.tag_id);
      map.set(assignment.entity_id, arr);
    }
    return map;
  }, [adSetAssignments]);

  const tagsByAd = useMemo(() => {
    const map = new Map();
    for (const assignment of adAssignments) {
      const arr = map.get(assignment.entity_id) || [];
      arr.push(assignment.tag_id);
      map.set(assignment.entity_id, arr);
    }
    return map;
  }, [adAssignments]);

  const loadTagsAndNotes = useCallback(async () => {
    try {
      const [tagRes, adSetTagRes, adTagRes, adSetNoteRes, adNoteRes] = await Promise.all([
        api.getTags(projectId),
        api.getTagAssignments(projectId, 'ad_set'),
        api.getTagAssignments(projectId, 'ad'),
        api.getEntityNotes(projectId, 'ad_set'),
        api.getEntityNotes(projectId, 'ad'),
      ]);
      setTags(tagRes.tags || []);
      setAdSetAssignments(adSetTagRes.assignments || []);
      setAdAssignments(adTagRes.assignments || []);
      setAdSetNotes(adSetNoteRes.notes || []);
      setAdNotes(adNoteRes.notes || []);
    } catch (err) {
      toast.error(err.message);
    }
  }, [projectId]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const adRes = await api.getObservationAdSets(projectId);
      setAdSets(adRes.ad_sets || []);

      try {
        const archRes = await api.getArchivedAngles(projectId);
        setArchived(archRes.angles || []);
      } catch (err) {
        setArchived([]);
        toast.error(`Archived angles could not load: ${err.message}`);
      }
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); loadTagsAndNotes(); }, [load, loadTagsAndNotes]);
  useEffect(() => {
    const visible = new Set(adSets.map((a) => a.externalId));
    setExpandedIds((prev) => prev.filter((id) => visible.has(id)));
  }, [adSets]);
  useEffect(() => {
    setSelectedKeys([]);
    setBulkTagId('');
  }, [projectId, statusFilter, filters]);

  const rows = useMemo(() => (
    adSets.map((adSet) => ({
      ...adSet,
      id: adSet.externalId,
      status: adSet.lifecycle_status || '',
      effective_status: adSet.lifecycle_status || '',
      note_text: adSetNotesById.get(adSet.externalId)?.note || '',
    }))
  ), [adSets, adSetNotesById]);

  const filteredRows = useMemo(() => {
    let out = rows;
    if (statusFilter === 'observing') out = out.filter((a) => a.lifecycle_status === 'observing');
    if (statusFilter === 'passed') out = out.filter((a) => a.lifecycle_status === 'passed');
    if (statusFilter === 'failed') out = out.filter((a) => ['failed', 'failed_external'].includes(a.lifecycle_status));
    if (statusFilter === 'insufficient') out = out.filter((a) => a.lifecycle_status === 'insufficient_data');
    if (filters.length > 0) {
      out = out.filter((row) => filters.every((filter) => matchesFilter(row, filter, tagsByAdSet)));
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
  }, [rows, statusFilter, filters, tagsByAdSet, sort]);

  const counts = {
    all: adSets.length,
    observing: adSets.filter((a) => a.lifecycle_status === 'observing').length,
    passed: adSets.filter((a) => a.lifecycle_status === 'passed').length,
    failed: adSets.filter((a) => ['failed', 'failed_external'].includes(a.lifecycle_status)).length,
    insufficient: adSets.filter((a) => a.lifecycle_status === 'insufficient_data').length,
  };

  const visibleKeys = filteredRows.map((row) => entityKey('ad_set', row.externalId));
  const visibleSelected = selectedKeys.filter((key) => visibleKeys.includes(key));
  const allVisibleSelected = visibleKeys.length > 0 && visibleSelected.length === visibleKeys.length;

  const toggleSort = (field) => {
    setSort((prev) => prev.field === field
      ? { field, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      : { field, dir: 'desc' });
  };

  const toggleSelection = (type, id) => {
    const key = entityKey(type, id);
    setSelectedKeys((prev) => prev.includes(key)
      ? prev.filter((item) => item !== key)
      : [...prev, key]);
  };

  const toggleSelectAllVisible = () => {
    setSelectedKeys((prev) => {
      if (allVisibleSelected) return prev.filter((key) => !visibleKeys.includes(key));
      return [...new Set([...prev, ...visibleKeys])];
    });
  };

  const selectedByType = useMemo(() => {
    const grouped = { ad_set: [], ad: [] };
    for (const key of selectedKeys) {
      const [type, ...rest] = key.split(':');
      const id = rest.join(':');
      if (grouped[type]) grouped[type].push(id);
    }
    return grouped;
  }, [selectedKeys]);

  const refreshAssignments = async () => {
    const [adSetTagRes, adTagRes] = await Promise.all([
      api.getTagAssignments(projectId, 'ad_set'),
      api.getTagAssignments(projectId, 'ad'),
    ]);
    setAdSetAssignments(adSetTagRes.assignments || []);
    setAdAssignments(adTagRes.assignments || []);
  };

  const refreshNotes = async () => {
    const [adSetNoteRes, adNoteRes] = await Promise.all([
      api.getEntityNotes(projectId, 'ad_set'),
      api.getEntityNotes(projectId, 'ad'),
    ]);
    setAdSetNotes(adSetNoteRes.notes || []);
    setAdNotes(adNoteRes.notes || []);
  };

  const applyTagToEntity = async (type, id, tag) => {
    try {
      await api.applyTag(projectId, {
        tag_id: tag.externalId,
        entity_type: type,
        entity_id: String(id),
        entity_id_kind: 'cf',
      });
      await refreshAssignments();
    } catch (err) { toast.error(err.message); }
  };

  const removeTagFromEntity = async (type, id, tag) => {
    try {
      await api.removeTagAssignment(projectId, {
        tag_id: tag.externalId,
        entity_type: type,
        entity_id: String(id),
      });
      await refreshAssignments();
    } catch (err) { toast.error(err.message); }
  };

  const createAndApplyTag = async (type, id, { name, color }) => {
    try {
      const { externalId } = await api.createTag(projectId, { name, color });
      await loadTagsAndNotes();
      await api.applyTag(projectId, {
        tag_id: externalId,
        entity_type: type,
        entity_id: String(id),
        entity_id_kind: 'cf',
      });
      await refreshAssignments();
    } catch (err) { toast.error(err.message); }
  };

  const updateNote = async (type, id, note) => {
    try {
      await api.updateEntityNote(projectId, {
        entity_type: type,
        entity_id: String(id),
        entity_id_kind: 'cf',
        note,
      });
      await refreshNotes();
      if (type === 'ad') await load();
    } catch (err) { toast.error(err.message); }
  };

  const runBulkByType = async (fn) => {
    const types = ['ad_set', 'ad'];
    for (const type of types) {
      const ids = selectedByType[type];
      if (ids.length > 0) await fn(type, ids);
    }
  };

  const handleBulkApplyTag = async () => {
    if (!bulkTagId || selectedKeys.length === 0) return;
    try {
      await runBulkByType((type, ids) => api.applyTagsBulk(projectId, {
        tag_id: bulkTagId,
        entity_type: type,
        entity_ids: ids,
        entity_id_kind: 'cf',
      }));
      await refreshAssignments();
      toast.success(`Tagged ${selectedKeys.length} row${selectedKeys.length === 1 ? '' : 's'}`);
    } catch (err) { toast.error(err.message); }
  };

  const handleBulkRemoveTag = async () => {
    if (!bulkTagId || selectedKeys.length === 0) return;
    try {
      await runBulkByType((type, ids) => api.removeTagAssignmentsBulk(projectId, {
        tag_id: bulkTagId,
        entity_type: type,
        entity_ids: ids,
      }));
      await refreshAssignments();
      toast.success(`Removed tag from ${selectedKeys.length} row${selectedKeys.length === 1 ? '' : 's'}`);
    } catch (err) { toast.error(err.message); }
  };

  const handleBulkAppendNote = async (note) => {
    if (!String(note || '').trim() || selectedKeys.length === 0) return;
    try {
      await runBulkByType((type, ids) => api.appendEntityNotesBulk(projectId, {
        entity_type: type,
        entity_ids: ids,
        entity_id_kind: 'cf',
        note,
      }));
      await refreshNotes();
      await load();
      toast.success(`Appended note to ${selectedKeys.length} row${selectedKeys.length === 1 ? '' : 's'}`);
    } catch (err) { toast.error(err.message); }
  };

  const renderRowTagCell = (type, row, tagIds) => (
    <RowTagCell
      row={row}
      allTags={tags}
      appliedIds={tagIds}
      onApply={(tag) => applyTagToEntity(type, row.externalId, tag)}
      onRemove={(tag) => removeTagFromEntity(type, row.externalId, tag)}
      onCreate={(tag) => createAndApplyTag(type, row.externalId, tag)}
      isOpen={tagPickerForRow === entityKey(type, row.externalId)}
      setOpen={(open) => setTagPickerForRow(open ? entityKey(type, row.externalId) : null)}
    />
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="page-tabs">
          {STATUS_FILTERS.map((filter) => (
            <button
              key={filter.id}
              onClick={() => setStatusFilter(filter.id)}
              className={statusFilter === filter.id ? 'active' : ''}
            >
              {filter.label} ({counts[filter.id]})
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <button onClick={() => setShowManageTags(true)} className="btn-secondary text-[12px] px-3 py-1.5">
          Manage tags
        </button>
        <button onClick={load} disabled={loading} className="btn-secondary text-[12px] px-3 py-1.5">
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      <div className="flex flex-wrap items-start gap-2">
        <button onClick={() => setFilters((prev) => [...prev, newFilter('observation')])} className="btn-secondary text-[12px] px-3 py-1.5">
          + Filter
        </button>
        <div className="relative">
          <button onClick={() => setShowColumnPicker((v) => !v)} className="btn-secondary text-[12px] px-3 py-1.5">
            Columns ({columns.length})
          </button>
          {showColumnPicker && (
            <ColumnPicker
              columns={columns}
              availableColumns={availableColumns}
              onChange={setColumns}
              onReset={() => setColumns(DEFAULT_COLUMNS_BY_LEVEL.observation)}
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
          {filteredRows.length} ad set{filteredRows.length === 1 ? '' : 's'}
        </span>
      </div>

      {filters.length > 0 && (
        <div className="flex flex-col gap-2">
          {filters.map((filter) => (
            <FilterRow
              key={filter.id}
              filter={filter}
              level="observation"
              tags={tags}
              onChange={(next) => setFilters((prev) => prev.map((f) => f.id === filter.id ? next : f))}
              onRemove={() => setFilters((prev) => prev.filter((f) => f.id !== filter.id))}
            />
          ))}
        </div>
      )}

      <div className="card overflow-visible">
        <div className="overflow-x-auto overflow-y-visible">
          <table className="w-full text-[12px]">
            <thead className="bg-gray-50/60 border-b border-gray-100">
              <tr>
                <th className="px-3 py-2 w-10">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleSelectAllVisible}
                    className="rounded border-navy/30 text-navy focus:ring-navy/20"
                    aria-label="Select all visible observation ad sets"
                  />
                </th>
                {columns.map((col) => {
                  if (col === 'tags') return <th key={col} className="px-3 py-2 text-left font-medium text-textmid w-48">Tags</th>;
                  if (col === 'notes') return <th key={col} className="px-3 py-2 text-left font-medium text-textmid min-w-[220px]">Notes</th>;
                  const def = COLUMN_DEFS[col];
                  if (!def) return null;
                  const sorted = sort.field === col;
                  return (
                    <th
                      key={col}
                      onClick={() => toggleSort(col)}
                      className={`px-3 py-2 ${def.align === 'right' ? 'text-right' : 'text-left'} font-medium text-textmid cursor-pointer hover:text-textdark select-none ${def.width}`}
                    >
                      <span className="inline-flex items-center gap-1">
                        {def.label}
                        {sorted && <span className="text-[8px]">{sort.dir === 'asc' ? '▲' : '▼'}</span>}
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {loading && filteredRows.length === 0 && (
                <tr><td colSpan={columns.length + 1} className="px-3 py-12 text-center text-textlight">Loading...</td></tr>
              )}
              {!loading && filteredRows.length === 0 && (
                <tr><td colSpan={columns.length + 1} className="px-3 py-12 text-center text-textlight">No ad sets in this view.</td></tr>
              )}
              {filteredRows.map((adSet) => {
                const selected = selectedKeys.includes(entityKey('ad_set', adSet.externalId));
                const expanded = expandedIds.includes(adSet.externalId);
                const appliedIds = tagsByAdSet.get(adSet.externalId) || [];
                return (
                  <Fragment key={adSet.externalId}>
                    <tr className={`border-b border-gray-50 hover:bg-gray-50/50 ${selected ? 'bg-gold/5' : ''}`}>
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => toggleSelection('ad_set', adSet.externalId)}
                          className="rounded border-navy/30 text-navy focus:ring-navy/20"
                          aria-label={`Select ${adSet.name}`}
                        />
                      </td>
                      {columns.map((col) => {
                        if (col === 'tags') return <td key={col} className="px-3 py-2">{renderRowTagCell('ad_set', adSet, appliedIds)}</td>;
                        if (col === 'notes') {
                          return (
                            <td key={col} className="px-3 py-2">
                              <NotesCell note={adSet.note_text || ''} onSave={(note) => updateNote('ad_set', adSet.externalId, note)} />
                            </td>
                          );
                        }
                        if (col === 'name') {
                          return (
                            <td key={col} className="px-3 py-2 text-textdark min-w-[260px]">
                              <div className="flex items-center gap-2 min-w-0">
                                <button
                                  onClick={() => setExpandedIds((prev) => expanded ? prev.filter((id) => id !== adSet.externalId) : [...prev, adSet.externalId])}
                                  className="w-6 h-6 rounded-full border border-gray-200 text-textmid hover:text-textdark hover:border-gray-300 flex items-center justify-center flex-shrink-0"
                                  aria-expanded={expanded}
                                  title={expanded ? 'Collapse ads' : 'Expand ads'}
                                >
                                  {expanded ? '⌄' : '›'}
                                </button>
                                <button
                                  onClick={() => setActiveAdSetId(adSet.externalId)}
                                  className="truncate text-left text-navy hover:text-gold font-medium"
                                  title={adSet.name}
                                >
                                  {adSet.name || '—'}
                                </button>
                                {adSet.is_demo && (
                                  <span className="px-1.5 py-0.5 rounded bg-gray-100 text-[9px] font-medium text-textmid flex-shrink-0">
                                    Demo
                                  </span>
                                )}
                                <span className="text-[10px] text-textlight flex-shrink-0">
                                  {numberValue(adSet.child_count)} ads
                                </span>
                              </div>
                            </td>
                          );
                        }
                        if (col === 'status') return <td key={col} className="px-3 py-2"><ObservationPill adSet={adSet} /></td>;
                        return (
                          <td key={col} className={`px-3 py-2 ${COLUMN_DEFS[col]?.align === 'right' ? 'text-right' : 'text-left'} text-textdark tabular-nums`}>
                            {formatCell(col, adSet)}
                          </td>
                        );
                      })}
                    </tr>
                    {expanded && (
                      <tr className="bg-gray-50/40 border-b border-gray-100">
                        <td colSpan={columns.length + 1} className="px-6 py-3">
                          <ChildAdsTable
                            adSet={adSet}
                            tags={tags}
                            tagsByAd={tagsByAd}
                            adNotesById={adNotesById}
                            selectedKeys={selectedKeys}
                            onSelect={(child) => toggleSelection('ad', child.externalId)}
                            onPreview={setPreviewAd}
                            renderTagCell={renderRowTagCell}
                            onUpdateNote={updateNote}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {archived.length > 0 && (
        <div className="card p-5">
          <h3 className="text-[13px] font-semibold text-textdark mb-3">Archived angles ({archived.length})</h3>
          <div className="space-y-2">
            {archived.map((angle) => (
              <ArchivedAngleRow
                key={angle.externalId}
                angle={angle}
                onUnarchive={async () => {
                  try {
                    await api.unarchiveAngle(projectId, angle.externalId);
                    toast.success(`Un-archived "${angle.name}"`);
                    load();
                  } catch (err) { toast.error(err.message); }
                }}
              />
            ))}
          </div>
        </div>
      )}

      <BulkActionBar
        selectedCount={selectedKeys.length}
        tags={tags}
        selectedTagId={bulkTagId}
        onTagChange={setBulkTagId}
        onApplyTag={handleBulkApplyTag}
        onRemoveTag={handleBulkRemoveTag}
        onAppendNote={handleBulkAppendNote}
        onClear={() => setSelectedKeys([])}
      />

      <TagManageDialog
        open={showManageTags}
        tags={tags}
        onClose={() => setShowManageTags(false)}
        onCreate={async ({ name, color }) => { await api.createTag(projectId, { name, color }); await loadTagsAndNotes(); }}
        onUpdate={async (tagId, data) => { await api.updateTag(projectId, tagId, data); await loadTagsAndNotes(); }}
        onDelete={async (tagId) => {
          try {
            await api.deleteTag(projectId, tagId);
            await loadTagsAndNotes();
            toast.success('Tag deleted');
          } catch (err) {
            toast.error(err.message || 'Failed to delete tag');
            throw err;
          }
        }}
      />

      <AdSetTimeline
        projectId={projectId}
        adSetId={activeAdSetId}
        open={!!activeAdSetId}
        onClose={() => setActiveAdSetId(null)}
        onChanged={load}
      />

      <AdPreviewModal ad={previewAd} onClose={() => setPreviewAd(null)} />
    </div>
  );
}

function ChildAdsTable({
  adSet,
  tags,
  tagsByAd,
  adNotesById,
  selectedKeys,
  onSelect,
  onPreview,
  renderTagCell,
  onUpdateNote,
}) {
  const children = adSet.children || [];
  if (children.length === 0) {
    return <div className="text-[11px] text-textlight">No child ads are attached to this ad set.</div>;
  }
  return (
    <div className="rounded-xl border border-gray-100 bg-white overflow-hidden">
      <table className="w-full text-[11px]">
        <thead className="bg-gray-50 border-b border-gray-100">
          <tr>
            <th className="px-3 py-2 w-10" />
            <th className="px-3 py-2 text-left font-medium text-textmid">Ad</th>
            <th className="px-3 py-2 text-left font-medium text-textmid">Angle</th>
            <th className="px-3 py-2 text-left font-medium text-textmid">URL</th>
            <th className="px-3 py-2 text-left font-medium text-textmid w-48">Tags</th>
            <th className="px-3 py-2 text-left font-medium text-textmid min-w-[220px]">Notes</th>
          </tr>
        </thead>
        <tbody>
          {children.map((child) => {
            const selected = selectedKeys.includes(entityKey('ad', child.externalId));
            const note = adNotesById.get(child.externalId)?.note || child.notes || '';
            const tagIds = tagsByAd.get(child.externalId) || [];
            return (
              <tr key={child.externalId} className={`border-b border-gray-50 hover:bg-gray-50/50 ${selected ? 'bg-gold/5' : ''}`}>
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    checked={selected}
                    onChange={() => onSelect(child)}
                    className="rounded border-navy/30 text-navy focus:ring-navy/20"
                    aria-label={`Select ${child.name}`}
                  />
                </td>
                <td className="px-3 py-2">
                  <button onClick={() => onPreview(child)} className="flex items-center gap-2 text-left min-w-0">
                    {child.thumbnail_url ? (
                      <img src={child.thumbnail_url} alt="" className="w-10 h-10 rounded-lg object-cover bg-gray-100 flex-shrink-0" loading="lazy" />
                    ) : (
                      <span className="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center text-textlight flex-shrink-0">—</span>
                    )}
                    <span className="min-w-0">
                      <span className="block text-textdark font-medium truncate max-w-[220px]">{child.name || 'Untitled ad'}</span>
                      <span className="block text-textlight truncate max-w-[260px]">{child.body_copy || child.headline || 'No copy'}</span>
                    </span>
                  </button>
                </td>
                <td className="px-3 py-2 text-textmid">{child.angle_name || '—'}</td>
                <td className="px-3 py-2 text-textmid truncate max-w-[220px]">{child.destination_url || '—'}</td>
                <td className="px-3 py-2">{renderTagCell('ad', child, tagIds, tags)}</td>
                <td className="px-3 py-2">
                  <NotesCell note={note} onSave={(next) => onUpdateNote('ad', child.externalId, next)} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function AdPreviewModal({ ad, onClose }) {
  if (!ad) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="bg-white w-full max-w-4xl max-h-[88vh] rounded-xl shadow-card overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b border-gray-100 flex items-center justify-between">
          <div className="min-w-0">
            <h3 className="text-[14px] font-semibold text-textdark truncate">{ad.name || 'Ad'}</h3>
            <p className="text-[11px] text-textlight truncate">{ad.angle_name || ad.ad_id || ''}</p>
          </div>
          <button onClick={onClose} className="text-textmid hover:text-textdark text-[18px] leading-none ml-3">×</button>
        </div>
        <div className="p-5 overflow-y-auto grid grid-cols-1 md:grid-cols-[minmax(280px,420px)_1fr] gap-5">
          {ad.image_url ? (
            <img src={ad.image_url} alt="" className="w-full max-h-[68vh] object-contain rounded-xl bg-gray-100" />
          ) : (
            <div className="w-full aspect-square rounded-xl bg-gray-100 flex items-center justify-center text-textlight">No image</div>
          )}
          <div className="space-y-4 text-[12px]">
            <InfoBlock label="Headline" value={ad.headline} />
            <InfoBlock label="Body" value={ad.body_copy} />
            <InfoBlock label="Destination URL" value={ad.destination_url} />
            <InfoBlock label="CTA" value={ad.cta_button} />
            <InfoBlock label="Deployment" value={ad.externalId} />
            <InfoBlock label="Creative" value={ad.ad_id} />
          </div>
        </div>
      </div>
    </div>
  );
}

function InfoBlock({ label, value }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-textlight font-semibold mb-1">{label}</div>
      <div className="text-textdark whitespace-pre-wrap break-words">{value || '—'}</div>
    </div>
  );
}

function ArchivedAngleRow({ angle, onUnarchive }) {
  return (
    <div className="flex items-center gap-3 p-3 border border-gray-100 rounded-xl">
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-textdark">{angle.name}</div>
        <div className="text-[11px] text-textlight truncate">{angle.performance_note || 'Archived.'}</div>
      </div>
      <button onClick={onUnarchive} className="btn-secondary text-[11px] px-3 py-1">
        Un-archive
      </button>
    </div>
  );
}

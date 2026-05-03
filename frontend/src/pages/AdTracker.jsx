import { useState, useEffect, useRef, useCallback } from 'react';
import JSZip from 'jszip';
import { api } from '../api';
import { useToast } from '../components/Toast';
import { useAsyncData } from '../hooks/useAsyncData';
import CampaignsView from '../components/CampaignsView';
import ReadyToPostView from '../components/ReadyToPostView';
import PostedView from '../components/PostedView';
import PipelineSubNav from '../components/pipeline/PipelineSubNav';

const STATUS_ORDER = ['selected', 'ready_to_post', 'posted'];
const STATUS_META = {
  selected:      { label: 'Queue',          color: 'bg-black/5 text-textmid',      dot: 'bg-textlight' },
  ready_to_post: { label: 'Ready to Post', color: 'bg-navy/10 text-navy',         dot: 'bg-navy' },
  posted:        { label: 'Posted',        color: 'bg-teal/10 text-teal',         dot: 'bg-teal' },
};


/** Display name for a deployment — combines angle + headline, never returns "Untitled" */
function displayName(dep) {
  if (dep.ad_name) return dep.ad_name;
  const parts = [dep.ad?.angle, dep.ad?.headline].filter(Boolean);
  return parts.length > 0 ? parts.join(' — ') : `Ad ${(dep.id || '').slice(0, 6)}`;
}

const VALID_VIEWS = ['campaigns', 'status', 'ready_to_post'];

export default function AdTracker({ projectId, userRole, searchParams, setSearchParams }) {
  const isPoster = userRole === 'poster';
  const { data: deployments, setData: setDeployments, loading, error: deploymentsError, refetch: loadDeployments } = useAsyncData(
    () => api.getProjectDeployments(projectId).then(d => d.deployments || []),
    [projectId]
  );
  // Persist activeView in URL search params so it survives page refresh
  const viewFromUrl = searchParams?.get('view');
  const defaultView = isPoster ? 'ready_to_post' : 'campaigns';
  const [activeView, setActiveViewState] = useState(
    viewFromUrl && VALID_VIEWS.includes(viewFromUrl) ? viewFromUrl : defaultView
  ); // 'campaigns' | 'status' | 'ready_to_post'
  const setActiveView = useCallback((v) => {
    setActiveViewState(v);
    if (setSearchParams) {
      setSearchParams(prev => {
        const next = new URLSearchParams(prev);
        next.set('view', v);
        return next;
      }, { replace: true });
    }
  }, [setSearchParams]);
  // Deep-link to a specific flex ad from Agent Monitor run history
  const flexAdId = searchParams?.get('flexAdId');
  useEffect(() => {
    if (flexAdId) setActiveView('ready_to_post');
  }, [flexAdId]);

  const [statusFilter, setStatusFilter] = useState('posted');
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkEditOpen, setBulkEditOpen] = useState(false);
  const [bulkFields, setBulkFields] = useState({ campaign_name: '', ad_set_name: '', ad_name: '', status: '', planned_date: '', landing_page_url: '' });
  const [editingCell, setEditingCell] = useState(null); // { id, field }
  const [editValue, setEditValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [notesPopover, setNotesPopover] = useState(null); // { id, notes }
  const [statusDropdown, setStatusDropdown] = useState(null); // deployment id or null
  const [previewDepId, setPreviewDepId] = useState(null); // deployment id or null
  const [tagPopover, setTagPopover] = useState(null); // { depId, adId, projectId, tags } or null
  const [tagInput, setTagInput] = useState('');
  const [isBulkDownloading, setIsBulkDownloading] = useState(false);
  const editRef = useRef(null);
  const notesRef = useRef(null);
  const statusDropdownRef = useRef(null);
  const tagPopoverRef = useRef(null);
  const { addToast } = useToast();

  // Focus input when editing cell changes
  useEffect(() => {
    if (editingCell && editRef.current) {
      editRef.current.focus();
      if (editRef.current.type === 'text' || editRef.current.type === 'url') {
        editRef.current.select();
      }
    }
  }, [editingCell]);

  // Close notes popover on outside click
  useEffect(() => {
    function handleClickOutside(e) {
      if (notesRef.current && !notesRef.current.contains(e.target)) {
        setNotesPopover(null);
      }
    }
    if (notesPopover) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [notesPopover]);

  // Close status dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e) {
      if (statusDropdownRef.current && !statusDropdownRef.current.contains(e.target)) {
        setStatusDropdown(null);
      }
    }
    if (statusDropdown) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [statusDropdown]);

  // Close tag popover on outside click
  useEffect(() => {
    function handleClickOutside(e) {
      if (tagPopoverRef.current && !tagPopoverRef.current.contains(e.target)) {
        setTagPopover(null);
        setTagInput('');
      }
    }
    if (tagPopover) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [tagPopover]);


  // ─── Filtering & Sorting ──────────────────────────────────────────────────
  // Campaigns = any deployment with local_campaign_id set
  const campaignsDeps = deployments.filter(d => !!d.local_campaign_id);

  const filtered = statusFilter === 'all'
    ? deployments
    : deployments.filter(d => d.status === statusFilter);

  const sorted = [...filtered].sort((a, b) => {
    const statusDiff = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
    if (statusDiff !== 0) return statusDiff;
    return new Date(b.created_at) - new Date(a.created_at);
  });

  const statusCounts = {};
  for (const d of deployments) {
    statusCounts[d.status] = (statusCounts[d.status] || 0) + 1;
  }

  // Smart count for ready_to_post: flex children count as 1 ad (the flex parent), not N
  const readyToPostCardCount = (() => {
    const readyDeps = deployments.filter(d => d.status === 'ready_to_post');
    const flexIds = new Set();
    let standalone = 0;
    for (const d of readyDeps) {
      if (d.flex_ad_id) flexIds.add(d.flex_ad_id);
      else standalone++;
    }
    return standalone + flexIds.size;
  })();

  // ─── Actions ──────────────────────────────────────────────────────────────
  const handleStatusChange = async (id, newStatus) => {
    setStatusDropdown(null);
    try {
      await api.updateDeploymentStatus(id, newStatus);
      setDeployments(prev => prev.map(d =>
        d.id === id ? { ...d, status: newStatus, posted_date: newStatus === 'posted' ? new Date().toISOString() : d.posted_date } : d
      ));
      addToast(`Moved to ${STATUS_META[newStatus].label}`, 'success');
    } catch (err) {
      addToast('Failed to update status', 'error');
    }
  };

  // Fix #14: Single delete now has confirmation
  const [deleteConfirmId, setDeleteConfirmId] = useState(null);
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false);

  const handleDelete = async (id) => {
    try {
      await api.deleteDeployment(id);
      setDeployments(prev => prev.filter(d => d.id !== id));
      setDeleteConfirmId(null);
      addToast('Deployment removed', 'success', 8000, {
        label: 'Undo',
        onClick: async () => {
          try {
            await api.restoreDeployment(id);
            loadDeployments();
            addToast('Deployment restored', 'success');
          } catch { addToast('Failed to restore', 'error'); }
        },
      });
    } catch (err) {
      addToast('Failed to delete', 'error');
    }
  };

  // ─── Inline Edit ──────────────────────────────────────────────────────────
  const startEdit = (id, field, currentValue) => {
    setEditingCell({ id, field });
    setEditValue(currentValue || '');
  };

  const cancelEdit = () => {
    setEditingCell(null);
    setEditValue('');
  };

  const saveEdit = useCallback(async () => {
    if (!editingCell) return;
    const { id, field } = editingCell;
    setSaving(true);
    try {
      const fields = {};
      if (field === 'planned_date' && editValue) {
        fields[field] = new Date(editValue).toISOString();
      } else {
        fields[field] = editValue || undefined;
      }
      await api.updateDeployment(id, fields);
      setDeployments(prev => prev.map(d =>
        d.id === id ? { ...d, ...fields } : d
      ));
    } catch (err) {
      addToast('Failed to save', 'error');
    } finally {
      setSaving(false);
      setEditingCell(null);
      setEditValue('');
    }
  }, [editingCell, editValue]);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveEdit();
    } else if (e.key === 'Escape') {
      cancelEdit();
    }
  };

  // ─── Notes popover ────────────────────────────────────────────────────────
  const openNotes = (dep) => {
    setNotesPopover({ id: dep.id, notes: dep.notes || '' });
  };

  const saveNotes = async () => {
    if (!notesPopover) return;
    try {
      await api.updateDeployment(notesPopover.id, { notes: notesPopover.notes || undefined });
      setDeployments(prev => prev.map(d =>
        d.id === notesPopover.id ? { ...d, notes: notesPopover.notes } : d
      ));
      setNotesPopover(null);
    } catch (err) {
      addToast('Failed to save notes', 'error');
    }
  };

  // ─── Bulk actions ─────────────────────────────────────────────────────────
  const toggleSelect = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === sorted.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(sorted.map(d => d.id)));
    }
  };

  const handleBulkStatus = async (newStatus) => {
    const ids = [...selectedIds];
    try {
      await Promise.all(ids.map(id => api.updateDeploymentStatus(id, newStatus)));
      setDeployments(prev => prev.map(d =>
        ids.includes(d.id) ? { ...d, status: newStatus } : d
      ));
      setSelectedIds(new Set());
      addToast(`${ids.length} moved to ${STATUS_META[newStatus].label}`, 'success');
    } catch (err) {
      addToast('Failed to update some deployments', 'error');
    }
  };

  const handleBulkDelete = async () => {
    const ids = [...selectedIds];
    try {
      await Promise.all(ids.map(id => api.deleteDeployment(id)));
      setDeployments(prev => prev.filter(d => !ids.includes(d.id)));
      setSelectedIds(new Set());
      setBulkEditOpen(false);
      addToast(`${ids.length} removed`, 'success', 8000, {
        label: 'Undo',
        onClick: async () => {
          try {
            await Promise.all(ids.map(id => api.restoreDeployment(id)));
            loadDeployments();
            addToast(`Restored ${ids.length} deployment${ids.length !== 1 ? 's' : ''}`, 'success');
          } catch { addToast('Failed to restore', 'error'); }
        },
      });
    } catch (err) {
      addToast('Failed to delete some deployments', 'error');
    }
  };

  const handleBulkEdit = async () => {
    const ids = [...selectedIds];
    const fields = {};
    if (bulkFields.campaign_name) fields.campaign_name = bulkFields.campaign_name;
    if (bulkFields.ad_set_name) fields.ad_set_name = bulkFields.ad_set_name;
    if (bulkFields.ad_name) fields.ad_name = bulkFields.ad_name;
    if (bulkFields.landing_page_url) fields.landing_page_url = bulkFields.landing_page_url;
    if (bulkFields.planned_date) fields.planned_date = new Date(bulkFields.planned_date).toISOString();
    const newStatus = bulkFields.status || null;

    if (Object.keys(fields).length === 0 && !newStatus) {
      addToast('Enter at least one field to apply', 'error');
      return;
    }
    try {
      const promises = [];
      // Status uses a separate endpoint
      if (newStatus) {
        promises.push(...ids.map(id => api.updateDeploymentStatus(id, newStatus)));
      }
      // Other fields use updateDeployment
      if (Object.keys(fields).length > 0) {
        promises.push(...ids.map(id => api.updateDeployment(id, fields)));
      }
      await Promise.all(promises);
      setDeployments(prev => prev.map(d => {
        if (!ids.includes(d.id)) return d;
        const updates = { ...fields };
        if (newStatus) {
          updates.status = newStatus;
          if (newStatus === 'posted') updates.posted_date = new Date().toISOString();
        }
        return { ...d, ...updates };
      }));
      setSelectedIds(new Set());
      setBulkEditOpen(false);
      setBulkFields({ campaign_name: '', ad_set_name: '', ad_name: '', status: '', planned_date: '', landing_page_url: '' });
      addToast(`${ids.length} ad${ids.length !== 1 ? 's' : ''} updated`, 'success');
    } catch (err) {
      addToast('Failed to update some deployments', 'error');
    }
  };

  // ─── Tag management ─────────────────────────────────────────────────────
  const QUICK_TAGS = ['Winner', 'Test', 'Control', 'V2', 'Review'];

  const openTagPopover = (dep) => {
    setTagPopover({
      depId: dep.id,
      adId: dep.ad_id,
      projectId: dep.project_id,
      tags: dep.ad?.tags || [],
    });
    setTagInput('');
  };

  const handleAddTag = async (tag) => {
    const trimmed = tag.trim();
    if (!trimmed || !tagPopover) return;
    if (tagPopover.tags.includes(trimmed)) return;

    const oldTags = tagPopover.tags;
    const newTags = [...oldTags, trimmed];
    // Optimistic update
    setTagPopover(prev => prev ? { ...prev, tags: newTags } : null);
    setDeployments(prev => prev.map(d =>
      d.id === tagPopover.depId ? { ...d, ad: { ...d.ad, tags: newTags } } : d
    ));

    try {
      await api.updateAdTags(tagPopover.projectId, tagPopover.adId, newTags);
    } catch (err) {
      console.error('Failed to add tag:', err);
      // Rollback optimistic update
      setTagPopover(prev => prev ? { ...prev, tags: oldTags } : null);
      setDeployments(prev => prev.map(d =>
        d.id === tagPopover.depId ? { ...d, ad: { ...d.ad, tags: oldTags } } : d
      ));
      addToast('Failed to add tag', 'error');
    }
  };

  const handleRemoveTag = async (tag) => {
    if (!tagPopover) return;
    const oldTags = tagPopover.tags;
    const newTags = oldTags.filter(t => t !== tag);
    // Optimistic update
    setTagPopover(prev => prev ? { ...prev, tags: newTags } : null);
    setDeployments(prev => prev.map(d =>
      d.id === tagPopover.depId ? { ...d, ad: { ...d.ad, tags: newTags } } : d
    ));

    try {
      await api.updateAdTags(tagPopover.projectId, tagPopover.adId, newTags);
    } catch (err) {
      console.error('Failed to remove tag:', err);
      // Rollback optimistic update
      setTagPopover(prev => prev ? { ...prev, tags: oldTags } : null);
      setDeployments(prev => prev.map(d =>
        d.id === tagPopover.depId ? { ...d, ad: { ...d.ad, tags: oldTags } } : d
      ));
      addToast('Failed to remove tag', 'error');
    }
  };

  // ─── Image preview navigation ────────────────────────────────────────────
  const previewableList = sorted.filter(d => d.imageUrl);
  const previewIndex = previewDepId ? previewableList.findIndex(d => d.id === previewDepId) : -1;
  const previewDep = previewIndex >= 0 ? previewableList[previewIndex] : null;
  const canGoPrev = previewIndex > 0;
  const canGoNext = previewIndex >= 0 && previewIndex < previewableList.length - 1;

  const goPreviewPrev = useCallback(() => {
    if (canGoPrev) setPreviewDepId(previewableList[previewIndex - 1].id);
  }, [canGoPrev, previewableList, previewIndex]);

  const goPreviewNext = useCallback(() => {
    if (canGoNext) setPreviewDepId(previewableList[previewIndex + 1].id);
  }, [canGoNext, previewableList, previewIndex]);

  // Keyboard navigation for preview modal
  useEffect(() => {
    if (!previewDepId) return;
    const handleKey = (e) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); goPreviewPrev(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); goPreviewNext(); }
      else if (e.key === 'Escape') { e.preventDefault(); setPreviewDepId(null); }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [previewDepId, goPreviewPrev, goPreviewNext]);

  // ─── Download ────────────────────────────────────────────────────────────
  const handleDownload = async (dep) => {
    if (!dep.imageUrl) return;
    try {
      const response = await fetch(dep.imageUrl);
      const blob = await response.blob();
      const ext = blob.type === 'image/jpeg' ? '.jpg' : '.png';
      const name = displayName(dep).replace(/[^a-z0-9]/gi, '-').slice(0, 40);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${name}${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      addToast('Failed to download image', 'error');
    }
  };

  const handleBulkDownload = async () => {
    const selected = sorted.filter(d => selectedIds.has(d.id) && d.imageUrl);
    if (selected.length === 0) {
      addToast('No images to download', 'error');
      return;
    }
    setIsBulkDownloading(true);
    try {
      const results = await Promise.allSettled(
        selected.map(async (dep) => {
          const res = await fetch(dep.imageUrl);
          const blob = await res.blob();
          const ext = blob.type === 'image/jpeg' ? '.jpg' : '.png';
          return { dep, blob, ext };
        })
      );
      const fulfilled = results.filter(r => r.status === 'fulfilled').map(r => r.value);
      if (fulfilled.length === 0) {
        addToast('Failed to download any images', 'error');
        return;
      }
      const zip = new JSZip();
      const usedNames = new Set();
      for (const { dep, blob, ext } of fulfilled) {
        let baseName = displayName(dep).replace(/[^a-z0-9]/gi, '-').slice(0, 40);
        let fileName = `${baseName}${ext}`;
        let counter = 1;
        while (usedNames.has(fileName)) {
          fileName = `${baseName}-${counter}${ext}`;
          counter++;
        }
        usedNames.add(fileName);
        zip.file(fileName, blob);
      }
      const content = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(content);
      const a = document.createElement('a');
      a.href = url;
      a.download = `tracker_ads_${fulfilled.length}_images.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setSelectedIds(new Set());
      setBulkEditOpen(false);
      addToast(`Downloaded ${fulfilled.length} image${fulfilled.length !== 1 ? 's' : ''} as ZIP`, 'success');
    } catch (err) {
      addToast('Failed to create ZIP', 'error');
    } finally {
      setIsBulkDownloading(false);
    }
  };

  // ─── Editable cell renderer ───────────────────────────────────────────────
  const EditableCell = ({ dep, field, value, placeholder, type = 'text', className = '', datalistId, datalistOptions }) => {
    const isEditing = editingCell?.id === dep.id && editingCell?.field === field;

    if (isEditing) {
      return (
        <>
          <input
            ref={editRef}
            type={type}
            list={datalistId || undefined}
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={saveEdit}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            className={`w-full bg-white border border-gold rounded px-1.5 py-0.5 text-[12px] text-textdark outline-none ring-1 ring-gold/30 ${className}`}
          />
          {datalistId && datalistOptions?.length > 0 && (
            <datalist id={datalistId}>
              {datalistOptions.map((opt, i) => (
                <option key={i} value={opt.value}>{opt.label}</option>
              ))}
            </datalist>
          )}
        </>
      );
    }

    const display = type === 'datetime-local' && value
      ? new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
      : value;

    const editableValue = type === 'datetime-local' && value
      ? value.slice(0, 16)
      : (value || '');

    return (
      <span
        onClick={(e) => { e.stopPropagation(); startEdit(dep.id, field, editableValue); }}
        className={`cursor-pointer rounded px-1.5 py-0.5 -mx-1.5 -my-0.5 hover:bg-navy/5 transition-colors truncate block ${
          display ? 'text-textdark' : 'text-textlight/60'
        } ${className}`}
        title={display || placeholder}
      >
        {display || placeholder}
      </span>
    );
  };

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div>
      {/* Pipeline sub-nav */}
      <PipelineSubNav
        activeView={activeView}
        onViewChange={(v) => { setActiveView(v); setSelectedIds(new Set()); if (v === 'status') setStatusFilter('posted'); }}
        counts={{ planner: campaignsDeps.length, ready: readyToPostCardCount, posted: statusCounts['posted'] || 0 }}
        isPoster={isPoster}
      />

      {/* Loading state — only show skeleton on initial load (no cached data yet) */}
      {loading && deployments.length === 0 && !deploymentsError && (
        <div className="space-y-4">
          {[0, 1, 2].map(i => (
            <div key={i} className="ed-card p-6 animate-pulse">
              <div className="h-3 w-32 bg-ed-line rounded mb-4" />
              <div className="flex gap-3">
                {[0, 1, 2].map(j => (
                  <div key={j} className="w-24 h-16 bg-ed-bg rounded-lg" />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Error state for deployment loading */}
      {deploymentsError && !loading && (
        <div className="ed-card p-8 text-center mb-4">
          <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-ed-rust/10 flex items-center justify-center">
            <svg className="w-6 h-6 text-ed-rust" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
          </div>
          <p className="text-[14px] font-medium text-ed-ink">Failed to load ads</p>
          <p className="text-[12px] text-ed-ink2 mt-1">There was an error loading your ads. Please try refreshing.</p>
          <button onClick={loadDeployments} className="mt-4 px-4 py-2 rounded-lg bg-ed-accent text-white text-[12px] font-medium hover:bg-ed-accent/90 transition-colors">
            Retry
          </button>
        </div>
      )}

      {/* ═══════════ Planner View (was Campaigns) ═══════════ */}
      {activeView === 'campaigns' && !(loading && deployments.length === 0) && (
        <CampaignsView
          projectId={projectId}
          deployments={deployments}
          setDeployments={setDeployments}
          addToast={addToast}
          loadDeployments={loadDeployments}
        />
      )}

      {/* ═══════════ Ready to Post View ═══════════ */}
      {activeView === 'ready_to_post' && !(loading && deployments.length === 0) && (
        <ReadyToPostView
          projectId={projectId}
          deployments={deployments}
          setDeployments={setDeployments}
          addToast={addToast}
          loadDeployments={loadDeployments}
          onSwitchToPlanner={() => { setActiveView('campaigns'); setSelectedIds(new Set()); }}
          isPoster={isPoster}
          highlightFlexAdId={flexAdId}
          onHighlightDone={() => {
            if (setSearchParams) {
              setSearchParams(prev => {
                const next = new URLSearchParams(prev);
                next.delete('flexAdId');
                return next;
              }, { replace: true });
            }
          }}
        />
      )}

      {/* ═══════════ Posted View (flex-aware cards) ═══════════ */}
      {activeView === 'status' && statusFilter === 'posted' && !(loading && deployments.length === 0) && (
        <PostedView
          projectId={projectId}
          deployments={deployments}
          setDeployments={setDeployments}
          addToast={addToast}
          loadDeployments={loadDeployments}
          isPoster={isPoster}
        />
      )}

      {/* ═══════════ Status Table View (non-posted statuses) ═══════════ */}
      {activeView === 'status' && statusFilter !== 'posted' && <>

      {/* Bulk action bar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 mb-4 p-3 bg-navy/5 rounded-xl border border-navy/10 fade-in">
          <span className="text-[12px] font-medium text-navy">
            {selectedIds.size} selected
          </span>
          <div className="flex items-center gap-2 ml-auto">
            {STATUS_ORDER.slice(1).map(status => (
              <button
                key={status}
                onClick={() => handleBulkStatus(status)}
                className="text-[11px] px-2.5 py-1 rounded-lg bg-white border border-gray-200 text-textmid hover:bg-gray-50 transition-colors"
              >
                {STATUS_META[status].label}
              </button>
            ))}
            <button
              onClick={handleBulkDownload}
              disabled={isBulkDownloading}
              className="text-[11px] px-2.5 py-1 rounded-lg bg-white border border-black/10 text-navy hover:bg-navy/5 transition-colors disabled:opacity-50 inline-flex items-center gap-1"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              {isBulkDownloading ? 'Zipping...' : 'Download'}
            </button>
            <button
              onClick={() => setBulkEditOpen(!bulkEditOpen)}
              className={`text-[11px] px-2.5 py-1 rounded-lg border transition-colors ${
                bulkEditOpen
                  ? 'bg-navy border-navy text-white'
                  : 'bg-white border-black/10 text-textmid hover:bg-offwhite'
              }`}
            >
              Edit Fields
            </button>
            <button
              onClick={handleBulkDelete}
              className="text-[11px] px-2.5 py-1 rounded-lg bg-red-50 border border-red-200 text-red-600 hover:bg-red-100 transition-colors"
            >
              Delete
            </button>
            <button
              onClick={() => { setSelectedIds(new Set()); setBulkEditOpen(false); setBulkFields({ campaign_name: '', ad_set_name: '', ad_name: '', status: '', planned_date: '', landing_page_url: '' }); }}
              className="text-[11px] px-2.5 py-1 rounded-lg text-textlight hover:text-textmid transition-colors"
            >
              Clear
            </button>
          </div>
        </div>
      )}

      {/* Bulk edit panel */}
      {bulkEditOpen && selectedIds.size > 0 && (
        <div className="mb-4 p-4 bg-navy/5 rounded-xl border border-navy/10 fade-in">
          <p className="text-[11px] font-medium text-navy mb-3">
            Apply to {selectedIds.size} selected ad{selectedIds.size !== 1 ? 's' : ''}
          </p>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-3">
            <div>
              <label className="block text-[10px] font-medium text-textlight uppercase tracking-wider mb-1">
                Ad Name
              </label>
              <input
                type="text"
                value={bulkFields.ad_name}
                onChange={(e) => setBulkFields(prev => ({ ...prev, ad_name: e.target.value }))}
                placeholder="e.g. Flash Sale — V3"
                className="input-apple text-[12px] w-full"
              />
            </div>
            <div>
              <label className="block text-[10px] font-medium text-textlight uppercase tracking-wider mb-1">
                Status
              </label>
              <select
                value={bulkFields.status}
                onChange={(e) => setBulkFields(prev => ({ ...prev, status: e.target.value }))}
                className="input-apple text-[12px] w-full"
              >
                <option value="">— Keep current —</option>
                {STATUS_ORDER.map(s => (
                  <option key={s} value={s}>{STATUS_META[s].label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-medium text-textlight uppercase tracking-wider mb-1">
                Start Date
              </label>
              <input
                type="datetime-local"
                value={bulkFields.planned_date}
                onChange={(e) => setBulkFields(prev => ({ ...prev, planned_date: e.target.value }))}
                className="input-apple text-[12px] w-full"
              />
            </div>
            <div>
              <label className="block text-[10px] font-medium text-textlight uppercase tracking-wider mb-1">
                Campaign
              </label>
              <input
                type="text"
                value={bulkFields.campaign_name}
                onChange={(e) => setBulkFields(prev => ({ ...prev, campaign_name: e.target.value }))}
                placeholder="e.g. Spring 2025 DTC"
                className="input-apple text-[12px] w-full"
              />
            </div>
            <div>
              <label className="block text-[10px] font-medium text-textlight uppercase tracking-wider mb-1">
                Ad Set
              </label>
              <input
                type="text"
                value={bulkFields.ad_set_name}
                onChange={(e) => setBulkFields(prev => ({ ...prev, ad_set_name: e.target.value }))}
                placeholder="e.g. LAL - Purchasers"
                className="input-apple text-[12px] w-full"
              />
            </div>
            <div>
              <label className="block text-[10px] font-medium text-textlight uppercase tracking-wider mb-1">
                Website URL
              </label>
              <input
                type="url"
                value={bulkFields.landing_page_url}
                onChange={(e) => setBulkFields(prev => ({ ...prev, landing_page_url: e.target.value }))}
                placeholder="e.g. https://..."
                className="input-apple text-[12px] w-full"
              />
            </div>
          </div>
          <button
            onClick={handleBulkEdit}
            className="btn-primary text-[11px] px-4 py-2"
          >
            Apply Changes
          </button>
        </div>
      )}

      {/* Loading state */}
      {loading && (
        <div className="card overflow-hidden">
          <div className="bg-gray-50 border-b border-gray-100 px-3 py-2.5">
            <div className="h-2.5 w-full bg-gray-200 rounded animate-pulse" />
          </div>
          {[0, 1, 2, 3].map(i => (
            <div key={i} className="flex items-center gap-3 px-3 py-3 border-b border-gray-100 last:border-0 animate-pulse">
              <div className="w-4 h-4 bg-gray-200 rounded" />
              <div className="w-8 h-8 bg-gray-200 rounded-md" />
              <div className="h-3 w-28 bg-gray-200 rounded" />
              <div className="h-3 w-16 bg-gray-100 rounded-full" />
              <div className="h-3 w-20 bg-gray-100 rounded flex-1" />
            </div>
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && deployments.length === 0 && (
        <div className="ed-card p-12 text-center">
          <div className="w-[54px] h-[54px] rounded-full border border-dashed border-ed-ink3 flex items-center justify-center mx-auto mb-4">
            <svg className="w-7 h-7 text-ed-ink3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.59 14.37a6 6 0 01-5.84 7.38v-4.8m5.84-2.58a14.98 14.98 0 006.16-12.12A14.98 14.98 0 009.631 8.41m5.96 5.96a14.926 14.926 0 01-5.841 2.58m-.119-8.54a6 6 0 00-7.381 5.84h4.8m2.58-5.84a14.927 14.927 0 00-2.58 5.84m2.699 2.7c-.103.021-.207.041-.311.06a15.09 15.09 0 01-2.448-2.448 14.9 14.9 0 01.06-.312m-2.24 2.39a4.493 4.493 0 00-1.757 4.306 4.493 4.493 0 004.306-1.758M16.5 9a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0z" />
            </svg>
          </div>
          <h3 className="font-serif text-[17px] text-ed-ink2 mb-2">No ads in pipeline yet</h3>
          <p className="text-[12.5px] text-ed-ink3 max-w-[320px] mx-auto leading-[1.55]">
            Select ads in the Ad Studio and click "Send to Ad Pipeline" to start tracking them here.
          </p>
        </div>
      )}

      {/* Filtered empty state */}
      {!loading && deployments.length > 0 && sorted.length === 0 && (
        <div className="card p-8 text-center">
          <p className="text-[13px] text-textlight">
            No deployments with status "{statusFilter === 'all' ? 'Any' : STATUS_META[statusFilter]?.label || statusFilter}".
          </p>
        </div>
      )}

      {/* Database table */}
      {!loading && sorted.length > 0 && (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left min-w-[420px] md:min-w-[800px]">
              <thead>
                <tr className="bg-offwhite border-b border-black/5">
                  <th className="px-3 py-2.5 w-10">
                    <button
                      onClick={toggleSelectAll}
                      className={`tap-compact w-[16px] h-[16px] rounded flex items-center justify-center transition-colors ${
                        selectedIds.size === sorted.length && sorted.length > 0
                          ? 'bg-navy'
                          : 'border-[1.5px] border-textlight/60 hover:border-navy/40'
                      }`}
                    >
                      {selectedIds.size === sorted.length && sorted.length > 0 && (
                        <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </button>
                  </th>
                  <th className="px-2 py-2.5 w-16 hidden sm:table-cell" />
                  <th className="px-3 py-2.5 text-[10px] uppercase tracking-wider font-medium text-textlight">
                    Ad Name
                  </th>
                  <th className="px-3 py-2.5 text-[10px] uppercase tracking-wider font-medium text-textlight w-24">
                    Status
                  </th>
                  <th className="px-3 py-2.5 text-[10px] uppercase tracking-wider font-medium text-textlight hidden md:table-cell">
                    Campaign
                  </th>
                  <th className="px-3 py-2.5 text-[10px] uppercase tracking-wider font-medium text-textlight hidden md:table-cell">
                    Ad Set
                  </th>
                  <th className="px-3 py-2.5 text-[10px] uppercase tracking-wider font-medium text-textlight hidden lg:table-cell w-40">
                    Start Date
                  </th>
                  <th className="px-3 py-2.5 text-[10px] uppercase tracking-wider font-medium text-textlight hidden lg:table-cell">
                    Website URL
                  </th>
                  <th className="px-3 py-2.5 text-[10px] uppercase tracking-wider font-medium text-textlight hidden md:table-cell w-24">
                    Created
                  </th>
                  <th className="px-3 py-2.5 w-28" />
                </tr>
              </thead>
              <tbody>
                {sorted.map(dep => {
                  const meta = STATUS_META[dep.status] || STATUS_META.selected;
                  const isSelected = selectedIds.has(dep.id);
                  const name = displayName(dep);

                  return (
                    <tr
                      key={dep.id}
                      className={`border-b border-gray-100 last:border-0 transition-colors ${
                        isSelected ? 'bg-navy/5' : 'hover:bg-offwhite'
                      }`}
                    >
                      {/* Checkbox */}
                      <td className="px-3 py-2.5">
                        <button
                          onClick={() => toggleSelect(dep.id)}
                          className={`w-[16px] h-[16px] rounded flex items-center justify-center transition-colors ${
                            isSelected
                              ? 'bg-navy'
                              : 'border-[1.5px] border-textlight/60 hover:border-navy/40'
                          }`}
                        >
                          {isSelected && (
                            <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                            </svg>
                          )}
                        </button>
                      </td>

                      {/* Thumbnail — hidden on narrow mobile to save width */}
                      <td className="px-2 py-2.5 hidden sm:table-cell">
                        {dep.imageUrl ? (
                          <img
                            src={dep.imageUrl}
                            alt=""
                            className="w-12 h-12 rounded-md object-cover cursor-pointer hover:ring-2 hover:ring-navy/30 transition-all"
                            onClick={(e) => { e.stopPropagation(); setPreviewDepId(dep.id); }}
                          />
                        ) : (
                          <div className="w-12 h-12 rounded-md bg-gray-100 flex items-center justify-center">
                            <svg className="w-4 h-4 text-textlight/60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5" />
                            </svg>
                          </div>
                        )}
                      </td>

                      {/* Ad Name + Tags */}
                      <td className="px-3 py-2.5 max-w-[240px] relative">
                        <div className="flex items-center gap-1.5">
                          <EditableCell
                            dep={dep}
                            field="ad_name"
                            value={name}
                            placeholder="Add name..."
                            className="text-[12px] font-medium"
                          />
                          {/* Notes indicator */}
                          <button
                            onClick={(e) => { e.stopPropagation(); openNotes(dep); }}
                            className={`flex-shrink-0 p-0.5 rounded transition-colors ${
                              dep.notes ? 'text-gold hover:text-gold/80' : 'text-textlight/40 hover:text-textlight'
                            }`}
                            title={dep.notes ? 'View notes' : 'Add notes'}
                          >
                            <svg className="w-3.5 h-3.5" fill={dep.notes ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
                            </svg>
                          </button>
                        </div>

                        {/* Tags inline */}
                        <div className="flex items-center gap-1 mt-1 flex-wrap">
                          {(dep.ad?.tags || []).slice(0, 3).map(tag => (
                            <span key={tag} className="text-[9px] px-1.5 py-0.5 bg-navy/10 text-navy rounded-full">{tag}</span>
                          ))}
                          {(dep.ad?.tags || []).length > 3 && (
                            <span className="text-[9px] text-textlight">+{dep.ad.tags.length - 3}</span>
                          )}
                          <button
                            onClick={(e) => { e.stopPropagation(); openTagPopover(dep); }}
                            className="text-[9px] px-1.5 py-0.5 rounded-full text-textlight/60 hover:text-navy hover:bg-navy/5 transition-colors"
                            title="Manage tags"
                          >
                            + tag
                          </button>
                        </div>

                        {/* Tag popover */}
                        {tagPopover?.depId === dep.id && (
                          <div
                            ref={tagPopoverRef}
                            className="absolute z-50 mt-1 left-0 w-72 bg-white rounded-xl shadow-card border border-gray-200 p-3 fade-in"
                          >
                            <label className="block text-[10px] font-medium text-textlight uppercase tracking-wider mb-1.5">
                              Tags
                            </label>
                            {/* Existing tags */}
                            <div className="flex flex-wrap gap-1 mb-2">
                              {(tagPopover.tags || []).map(tag => (
                                <span key={tag} className="inline-flex items-center gap-0.5 text-[10px] px-2 py-0.5 bg-navy/10 text-navy rounded-full">
                                  {tag}
                                  <button onClick={() => handleRemoveTag(tag)} className="text-navy/60 hover:text-navy ml-0.5">
                                    <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" /></svg>
                                  </button>
                                </span>
                              ))}
                              {(tagPopover.tags || []).length === 0 && (
                                <span className="text-[10px] text-textlight/60">No tags yet</span>
                              )}
                            </div>
                            {/* Add tag input */}
                            <form onSubmit={(e) => { e.preventDefault(); handleAddTag(tagInput); setTagInput(''); }} className="flex gap-1.5 mb-2">
                              <input
                                type="text"
                                value={tagInput}
                                onChange={(e) => setTagInput(e.target.value)}
                                placeholder="Add a tag..."
                                className="input-apple text-[11px] flex-1 py-1"
                                autoFocus
                              />
                              <button type="submit" disabled={!tagInput.trim()} className="btn-primary text-[10px] px-2.5 py-1 disabled:opacity-50">
                                Add
                              </button>
                            </form>
                            {/* Quick tags */}
                            <div className="flex flex-wrap gap-1">
                              {QUICK_TAGS.filter(t => !(tagPopover.tags || []).includes(t)).map(tag => (
                                <button
                                  key={tag}
                                  onClick={() => handleAddTag(tag)}
                                  className="text-[9px] px-2 py-0.5 rounded-full border border-dashed border-gray-200 text-textlight hover:border-navy/30 hover:text-navy transition-colors"
                                >
                                  {tag}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Notes popover */}
                        {notesPopover?.id === dep.id && (
                          <div
                            ref={notesRef}
                            className="absolute z-50 mt-1 left-0 w-72 bg-white rounded-xl shadow-card border border-gray-200 p-3 fade-in"
                          >
                            <label className="block text-[10px] font-medium text-textlight uppercase tracking-wider mb-1.5">
                              Notes
                            </label>
                            <textarea
                              value={notesPopover.notes}
                              onChange={(e) => setNotesPopover(prev => ({ ...prev, notes: e.target.value }))}
                              placeholder="Add notes about this ad..."
                              rows={3}
                              className="input-apple text-[12px] w-full resize-none mb-2"
                              autoFocus
                            />
                            <div className="flex items-center gap-2 justify-end">
                              <button
                                onClick={() => setNotesPopover(null)}
                                className="text-[11px] px-2.5 py-1 rounded-lg text-textlight hover:text-textmid"
                              >
                                Cancel
                              </button>
                              <button
                                onClick={saveNotes}
                                className="btn-primary text-[11px] px-3 py-1"
                              >
                                Save
                              </button>
                            </div>
                          </div>
                        )}
                      </td>

                      {/* Status — clickable dropdown */}
                      <td className="px-3 py-2.5 relative">
                        <button
                          onClick={(e) => { e.stopPropagation(); setStatusDropdown(statusDropdown === dep.id ? null : dep.id); }}
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium whitespace-nowrap cursor-pointer hover:opacity-80 transition-opacity ${meta.color}`}
                        >
                          <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />
                          {meta.label}
                          <svg className={`w-2.5 h-2.5 ml-0.5 transition-transform ${statusDropdown === dep.id ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                          </svg>
                        </button>
                        {statusDropdown === dep.id && (
                          <div
                            ref={statusDropdownRef}
                            className="absolute z-50 mt-1 left-0 w-36 bg-white rounded-xl shadow-card border border-gray-200 py-1 fade-in"
                          >
                            {STATUS_ORDER.map(s => {
                              const sMeta = STATUS_META[s];
                              const isCurrent = dep.status === s;
                              return (
                                <button
                                  key={s}
                                  onClick={(e) => { e.stopPropagation(); if (!isCurrent) handleStatusChange(dep.id, s); }}
                                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-[11px] transition-colors ${
                                    isCurrent ? 'bg-gray-50 font-semibold text-textdark' : 'text-textmid hover:bg-gray-50'
                                  }`}
                                >
                                  <span className={`w-2 h-2 rounded-full ${sMeta.dot}`} />
                                  {sMeta.label}
                                  {isCurrent && (
                                    <svg className="w-3 h-3 ml-auto text-navy" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                                    </svg>
                                  )}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </td>

                      {/* Campaign */}
                      <td className="px-3 py-2.5 hidden md:table-cell max-w-[140px]">
                        <EditableCell
                          dep={dep}
                          field="campaign_name"
                          value={dep.campaign_name}
                          placeholder="Add campaign..."
                        />
                      </td>

                      {/* Ad Set */}
                      <td className="px-3 py-2.5 hidden md:table-cell max-w-[140px]">
                        <EditableCell
                          dep={dep}
                          field="ad_set_name"
                          value={dep.ad_set_name}
                          placeholder="Add ad set..."
                        />
                      </td>

                      {/* Start Date */}
                      <td className="px-3 py-2.5 hidden lg:table-cell">
                        <EditableCell
                          dep={dep}
                          field="planned_date"
                          value={dep.planned_date}
                          placeholder="Set date..."
                          type="datetime-local"
                        />
                      </td>

                      {/* Website URL */}
                      <td className="px-3 py-2.5 hidden lg:table-cell max-w-[160px]">
                        <EditableCell
                          dep={dep}
                          field="landing_page_url"
                          value={dep.landing_page_url}
                          placeholder="Add URL..."
                          type="url"
                        />
                      </td>

                      {/* Created */}
                      <td className="px-3 py-2.5 hidden md:table-cell text-[11px] text-textlight whitespace-nowrap">
                        {dep.created_at
                          ? new Date(dep.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
                          : '—'}
                      </td>

                      {/* Actions */}
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-1 justify-end">
                          {/* Send Back to Ready to Post — only for posted ads, hidden for Poster role */}
                          {dep.status === 'posted' && !isPoster && (
                            <button
                              onClick={() => handleStatusChange(dep.id, 'ready_to_post')}
                              className="text-[9px] px-2 py-1 rounded-lg text-gold border border-gold/30 hover:bg-gold/10 transition-colors whitespace-nowrap"
                              title="Send back to Ready to Post"
                            >
                              ← Ready to Post
                            </button>
                          )}
                          {dep.imageUrl && (
                            <button
                              onClick={() => handleDownload(dep)}
                              className="text-textlight/60 hover:text-navy hover:bg-navy/5 transition-all p-1 rounded-md"
                              title="Download image"
                            >
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                              </svg>
                            </button>
                          )}
                          {deleteConfirmId === dep.id ? (
                            <div className="flex items-center gap-1">
                              <button
                                onClick={() => handleDelete(dep.id)}
                                className="text-[10px] px-1.5 py-0.5 rounded bg-red-500 text-white hover:bg-red-600 transition-colors"
                              >
                                Confirm
                              </button>
                              <button
                                onClick={() => setDeleteConfirmId(null)}
                                className="text-[10px] px-1.5 py-0.5 rounded text-textmid hover:bg-gray-100 transition-colors"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => setDeleteConfirmId(dep.id)}
                              className="text-textlight/60 hover:text-red-500 hover:bg-red-50 transition-all p-1 rounded-md"
                              title="Remove"
                            >
                              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                              </svg>
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      </>}


      {/* Image preview modal */}
      {previewDep && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-6 fade-in"
          onClick={() => setPreviewDepId(null)}
        >
          {/* Left arrow */}
          {canGoPrev && (
            <button
              onClick={(e) => { e.stopPropagation(); goPreviewPrev(); }}
              className="absolute left-4 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-ed-surface shadow-card flex items-center justify-center text-ed-ink3 hover:text-ed-ink hover:bg-white transition-all z-20"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
          )}
          {/* Right arrow */}
          {canGoNext && (
            <button
              onClick={(e) => { e.stopPropagation(); goPreviewNext(); }}
              className="absolute right-4 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-ed-surface shadow-card flex items-center justify-center text-ed-ink3 hover:text-ed-ink hover:bg-white transition-all z-20"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          )}
          <div className="relative max-w-3xl w-full" onClick={(e) => e.stopPropagation()}>
            {/* Close + Download buttons */}
            <div className="absolute -top-3 -right-3 flex items-center gap-2 z-10">
              <button
                onClick={() => handleDownload(previewDep)}
                className="w-8 h-8 rounded-full bg-ed-surface shadow-card flex items-center justify-center text-ed-ink3 hover:text-ed-accent transition-colors"
                title="Download image"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
              </button>
              <button
                onClick={() => setPreviewDepId(null)}
                className="w-8 h-8 rounded-full bg-ed-surface shadow-card flex items-center justify-center text-ed-ink3 hover:text-ed-ink transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <img
              src={previewDep.imageUrl}
              alt={displayName(previewDep)}
              className="max-w-full max-h-[85vh] object-contain rounded-2xl shadow-card-hover mx-auto"
            />
            <div className="flex items-center justify-center gap-3 mt-3">
              <p className="text-white/70 text-[12px]">{displayName(previewDep)}</p>
              <span className="text-white/30 text-[11px]">
                {previewIndex + 1} / {previewableList.length}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

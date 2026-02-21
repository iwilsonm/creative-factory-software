import { useState, useEffect, useRef, useCallback } from 'react';
import JSZip from 'jszip';
import { api } from '../api';
import { useToast } from '../components/Toast';
import { useAsyncData } from '../hooks/useAsyncData';

const STATUS_ORDER = ['selected', 'scheduled', 'posted', 'analyzing'];
const STATUS_META = {
  selected:  { label: 'Unposted',  color: 'bg-black/5 text-textmid',      dot: 'bg-textlight' },
  scheduled: { label: 'Scheduled', color: 'bg-navy/10 text-navy',         dot: 'bg-navy' },
  posted:    { label: 'Posted',    color: 'bg-teal/10 text-teal',         dot: 'bg-teal' },
  analyzing: { label: 'Analyzing', color: 'bg-gold/10 text-gold',         dot: 'bg-gold' },
};


/** Display name for a deployment — combines angle + headline, never returns "Untitled" */
function displayName(dep) {
  if (dep.ad_name) return dep.ad_name;
  const parts = [dep.ad?.angle, dep.ad?.headline].filter(Boolean);
  return parts.length > 0 ? parts.join(' — ') : `Ad ${(dep.id || '').slice(0, 6)}`;
}

export default function AdTracker({ projectId }) {
  const { data: deployments, setData: setDeployments, loading, refetch: loadDeployments } = useAsyncData(
    () => api.getProjectDeployments(projectId).then(d => d.deployments || []),
    [projectId]
  );
  const [statusFilter, setStatusFilter] = useState('selected');
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
  // Meta linking state
  const [metaConnected, setMetaConnected] = useState(false);
  const [linkingDepId, setLinkingDepId] = useState(null); // deployment id for campaign browser
  const [campaignBrowser, setCampaignBrowser] = useState({ step: 'campaigns', campaigns: [], adsets: [], ads: [], loading: false, selectedCampaign: null, selectedAdset: null });
  const [perfSummary, setPerfSummary] = useState(null); // { totalSpend, totalImpressions, totalClicks, avgCTR, avgCPC, ads: [] }
  const [perfLoading, setPerfLoading] = useState(false);
  const [metaSyncing, setMetaSyncing] = useState(false);
  const [publishedLPs, setPublishedLPs] = useState([]);
  const editRef = useRef(null);
  const notesRef = useRef(null);
  const statusDropdownRef = useRef(null);
  const tagPopoverRef = useRef(null);
  const { addToast } = useToast();

  useEffect(() => {
    checkMetaConnection();
    // Fetch published landing pages for URL suggestions
    api.getLandingPages(projectId).then(data => {
      const published = (data.pages || []).filter(p => p.status === 'published' && p.published_url);
      setPublishedLPs(published);
    }).catch(() => {});
  }, [projectId]);

  // One-time migration: backfill headlines on existing ads, then rename deployments
  useEffect(() => {
    const backfillKey = 'headline_backfill_v1';
    const renameKey = 'deployment_rename_v2';
    const needsBackfill = !localStorage.getItem(backfillKey);
    const needsRename = !localStorage.getItem(renameKey);
    if (needsBackfill) {
      api.backfillHeadlines().then(() => {
        localStorage.setItem(backfillKey, Date.now().toString());
        // After backfill, always run rename to pick up new headlines
        return api.renameAllDeployments();
      }).then(() => {
        localStorage.setItem(renameKey, Date.now().toString());
        loadDeployments();
      }).catch(() => {});
    } else if (needsRename) {
      api.renameAllDeployments().then(() => {
        localStorage.setItem(renameKey, Date.now().toString());
        loadDeployments();
      }).catch(() => {});
    }
  }, []);

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


  // ─── Meta connection & performance ──────────────────────────────────────────
  const checkMetaConnection = async () => {
    try {
      const status = await api.getMetaStatus(projectId);
      setMetaConnected(status.connected && !!status.adAccountId);
      if (status.connected && status.adAccountId) {
        loadPerformanceSummary();
      }
    } catch {
      setMetaConnected(false);
    }
  };

  const loadPerformanceSummary = async () => {
    setPerfLoading(true);
    try {
      const data = await api.getMetaPerformanceSummary(projectId);
      setPerfSummary(data);
    } catch {
      setPerfSummary(null);
    } finally {
      setPerfLoading(false);
    }
  };

  const handleMetaSync = async () => {
    setMetaSyncing(true);
    try {
      await api.syncMetaPerformance(projectId);
      addToast('Meta performance synced', 'success');
      await loadPerformanceSummary();
    } catch (err) {
      addToast('Sync failed: ' + err.message, 'error');
    } finally {
      setMetaSyncing(false);
    }
  };

  // ─── Campaign Browser ────────────────────────────────────────────────────
  const openCampaignBrowser = async (depId) => {
    setLinkingDepId(depId);
    setCampaignBrowser({ step: 'campaigns', campaigns: [], adsets: [], ads: [], loading: true, selectedCampaign: null, selectedAdset: null });
    try {
      const { campaigns } = await api.getMetaCampaigns(projectId);
      setCampaignBrowser(prev => ({ ...prev, campaigns: campaigns || [], loading: false }));
    } catch (err) {
      addToast('Failed to load campaigns: ' + err.message, 'error');
      setCampaignBrowser(prev => ({ ...prev, loading: false }));
    }
  };

  const selectCampaign = async (campaign) => {
    setCampaignBrowser(prev => ({ ...prev, step: 'adsets', selectedCampaign: campaign, adsets: [], ads: [], loading: true }));
    try {
      const { adsets } = await api.getMetaAdSets(projectId, campaign.id);
      setCampaignBrowser(prev => ({ ...prev, adsets: adsets || [], loading: false }));
    } catch (err) {
      addToast('Failed to load ad sets: ' + err.message, 'error');
      setCampaignBrowser(prev => ({ ...prev, loading: false }));
    }
  };

  const selectAdset = async (adset) => {
    setCampaignBrowser(prev => ({ ...prev, step: 'ads', selectedAdset: adset, ads: [], loading: true }));
    try {
      const { ads } = await api.getMetaAds(projectId, adset.id);
      setCampaignBrowser(prev => ({ ...prev, ads: ads || [], loading: false }));
    } catch (err) {
      addToast('Failed to load ads: ' + err.message, 'error');
      setCampaignBrowser(prev => ({ ...prev, loading: false }));
    }
  };

  const selectMetaAd = async (metaAd) => {
    if (!linkingDepId) return;
    try {
      const result = await api.linkMetaAd(
        projectId,
        linkingDepId,
        metaAd.id,
        campaignBrowser.selectedCampaign?.id,
        campaignBrowser.selectedAdset?.id
      );
      setDeployments(prev => prev.map(d =>
        d.id === linkingDepId ? { ...d, meta_ad_id: metaAd.id, meta_campaign_id: campaignBrowser.selectedCampaign?.id, meta_adset_id: campaignBrowser.selectedAdset?.id } : d
      ));
      setLinkingDepId(null);
      addToast('Linked to Meta Ad', 'success');
      loadPerformanceSummary();
    } catch (err) {
      addToast('Failed to link: ' + err.message, 'error');
    }
  };

  const handleUnlink = async (depId) => {
    try {
      await api.unlinkMetaAd(projectId, depId);
      setDeployments(prev => prev.map(d =>
        d.id === depId ? { ...d, meta_ad_id: null, meta_campaign_id: null, meta_adset_id: null } : d
      ));
      addToast('Unlinked from Meta', 'success');
      loadPerformanceSummary();
    } catch (err) {
      addToast('Failed to unlink: ' + err.message, 'error');
    }
  };

  // ─── Filtering & Sorting ──────────────────────────────────────────────────
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

  const handleDelete = async (id) => {
    try {
      await api.deleteDeployment(id);
      setDeployments(prev => prev.filter(d => d.id !== id));
      addToast('Deployment removed', 'success');
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
      addToast(`${ids.length} removed`, 'success');
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

    const newTags = [...tagPopover.tags, trimmed];
    // Optimistic update
    setTagPopover(prev => prev ? { ...prev, tags: newTags } : null);
    setDeployments(prev => prev.map(d =>
      d.id === tagPopover.depId ? { ...d, ad: { ...d.ad, tags: newTags } } : d
    ));

    try {
      await api.updateAdTags(tagPopover.projectId, tagPopover.adId, newTags);
    } catch (err) {
      console.error('Failed to add tag:', err);
      addToast('Failed to add tag', 'error');
    }
  };

  const handleRemoveTag = async (tag) => {
    if (!tagPopover) return;
    const newTags = tagPopover.tags.filter(t => t !== tag);
    // Optimistic update
    setTagPopover(prev => prev ? { ...prev, tags: newTags } : null);
    setDeployments(prev => prev.map(d =>
      d.id === tagPopover.depId ? { ...d, ad: { ...d.ad, tags: newTags } } : d
    ));

    try {
      await api.updateAdTags(tagPopover.projectId, tagPopover.adId, newTags);
    } catch (err) {
      console.error('Failed to remove tag:', err);
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
      {/* Status filter pills */}
      <div className="flex items-center gap-2 mb-5 flex-wrap">
        {STATUS_ORDER.map(status => {
          const meta = STATUS_META[status];
          const count = statusCounts[status] || 0;
          return (
            <button
              key={status}
              onClick={() => setStatusFilter(status)}
              className={`px-3 py-1.5 rounded-full text-[12px] font-medium transition-colors ${
                statusFilter === status
                  ? 'bg-gray-900 text-white'
                  : `${meta.color} hover:opacity-80`
              }`}
            >
              {meta.label} ({count})
            </button>
          );
        })}
        <button
          onClick={() => setStatusFilter('all')}
          className={`px-3 py-1.5 rounded-full text-[12px] font-medium transition-colors ${
            statusFilter === 'all'
              ? 'bg-gray-900 text-white'
              : 'bg-black/5 text-textmid hover:bg-black/10'
          }`}
        >
          All ({deployments.length})
        </button>
      </div>

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
                Planned Date
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
                Campaign Name
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
                Ad Set Name
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
                Landing Page
              </label>
              <input
                type="url"
                list="lp-urls-bulk"
                value={bulkFields.landing_page_url}
                onChange={(e) => setBulkFields(prev => ({ ...prev, landing_page_url: e.target.value }))}
                placeholder={publishedLPs.length > 0 ? 'Select a landing page or enter URL...' : 'e.g. https://...'}
                className="input-apple text-[12px] w-full"
              />
              {publishedLPs.length > 0 && (
                <datalist id="lp-urls-bulk">
                  {publishedLPs.map(lp => (
                    <option key={lp.externalId} value={lp.published_url}>
                      {lp.name}
                    </option>
                  ))}
                </datalist>
              )}
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
        <div className="card p-12 text-center">
          <div className="w-14 h-14 rounded-2xl bg-gray-100 flex items-center justify-center mx-auto mb-4">
            <svg className="w-7 h-7 text-textlight/60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.59 14.37a6 6 0 01-5.84 7.38v-4.8m5.84-2.58a14.98 14.98 0 006.16-12.12A14.98 14.98 0 009.631 8.41m5.96 5.96a14.926 14.926 0 01-5.841 2.58m-.119-8.54a6 6 0 00-7.381 5.84h4.8m2.58-5.84a14.927 14.927 0 00-2.58 5.84m2.699 2.7c-.103.021-.207.041-.311.06a15.09 15.09 0 01-2.448-2.448 14.9 14.9 0 01.06-.312m-2.24 2.39a4.493 4.493 0 00-1.757 4.306 4.493 4.493 0 004.306-1.758M16.5 9a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0z" />
            </svg>
          </div>
          <h3 className="text-[15px] font-semibold text-textdark mb-1">No deployments yet</h3>
          <p className="text-[13px] text-textlight max-w-sm mx-auto">
            Select ads in the Ad Studio and click "Deploy" to start tracking them here.
          </p>
        </div>
      )}

      {/* Filtered empty state */}
      {!loading && deployments.length > 0 && sorted.length === 0 && (
        <div className="card p-8 text-center">
          <p className="text-[13px] text-textlight">
            No deployments with status "{STATUS_META[statusFilter]?.label}".
          </p>
        </div>
      )}

      {/* Database table */}
      {!loading && sorted.length > 0 && (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left min-w-[800px]">
              <thead>
                <tr className="bg-offwhite border-b border-black/5">
                  <th className="px-3 py-2.5 w-10">
                    <button
                      onClick={toggleSelectAll}
                      className={`w-[16px] h-[16px] rounded flex items-center justify-center transition-colors ${
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
                  <th className="px-2 py-2.5 w-16" />
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
                    Planned Date
                  </th>
                  <th className="px-3 py-2.5 text-[10px] uppercase tracking-wider font-medium text-textlight hidden lg:table-cell">
                    Landing Page
                  </th>
                  <th className="px-3 py-2.5 text-[10px] uppercase tracking-wider font-medium text-textlight hidden md:table-cell w-24">
                    Created
                  </th>
                  <th className="px-3 py-2.5 w-12" />
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

                      {/* Thumbnail */}
                      <td className="px-2 py-2.5">
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

                      {/* Planned Date */}
                      <td className="px-3 py-2.5 hidden lg:table-cell">
                        <EditableCell
                          dep={dep}
                          field="planned_date"
                          value={dep.planned_date}
                          placeholder="Set date..."
                          type="datetime-local"
                        />
                      </td>

                      {/* Landing Page */}
                      <td className="px-3 py-2.5 hidden lg:table-cell max-w-[160px]">
                        <EditableCell
                          dep={dep}
                          field="landing_page_url"
                          value={dep.landing_page_url}
                          placeholder={publishedLPs.length > 0 ? 'Select LP or enter URL...' : 'Add URL...'}
                          type="url"
                          datalistId={`lp-urls-${dep.id}`}
                          datalistOptions={publishedLPs.map(lp => ({ value: lp.published_url, label: lp.name }))}
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
                          {/* Meta link/unlink button */}
                          {metaConnected && (
                            dep.meta_ad_id ? (
                              <button
                                onClick={() => handleUnlink(dep.id)}
                                className="text-navy hover:text-navy-light hover:bg-navy/5 transition-all p-1 rounded-md"
                                title="Linked to Meta — click to unlink"
                              >
                                <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                                  <path d="M10.59 13.41c.41.39.41 1.03 0 1.42-.39.39-1.03.39-1.42 0a5.003 5.003 0 010-7.07l3.54-3.54a5.003 5.003 0 017.07 0 5.003 5.003 0 010 7.07l-1.49 1.49c.01-.82-.12-1.64-.4-2.42l.47-.48a3.004 3.004 0 000-4.24 3.004 3.004 0 00-4.24 0l-3.53 3.53a3.004 3.004 0 000 4.24zm2.82-4.24c.39-.39 1.03-.39 1.42 0a5.003 5.003 0 010 7.07l-3.54 3.54a5.003 5.003 0 01-7.07 0 5.003 5.003 0 010-7.07l1.49-1.49c-.01.82.12 1.64.4 2.42l-.47.48a3.004 3.004 0 000 4.24 3.004 3.004 0 004.24 0l3.53-3.53a3.004 3.004 0 000-4.24.973.973 0 010-1.42z" />
                                </svg>
                              </button>
                            ) : (
                              <button
                                onClick={() => openCampaignBrowser(dep.id)}
                                className="text-textlight/60 hover:text-navy hover:bg-navy/5 transition-all p-1 rounded-md"
                                title="Link to Meta Ad"
                              >
                                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m9.86-4.553a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" />
                                </svg>
                              </button>
                            )
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
                          <button
                            onClick={() => handleDelete(dep.id)}
                            className="text-textlight/60 hover:text-red-500 hover:bg-red-50 transition-all p-1 rounded-md"
                            title="Remove"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                            </svg>
                          </button>
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

      {/* Performance section */}
      <div className="mt-8">
        {!metaConnected ? (
          /* Not connected — prompt to connect */
          <div className="card p-8 text-center">
            <div className="flex items-center justify-center gap-3 mb-2">
              <svg className="w-5 h-5 text-gold/40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
              </svg>
              <h3 className="text-[13px] font-semibold text-textdark">Performance Tracking</h3>
            </div>
            <p className="text-[12px] text-textlight max-w-md mx-auto mb-3">
              Connect your Meta account in the Overview tab to pull live ad performance data for this project.
            </p>
          </div>
        ) : perfLoading ? (
          /* Loading */
          <div className="card p-6">
            <div className="flex items-center gap-2 mb-4">
              <div className="h-4 w-40 bg-gray-200 rounded animate-pulse" />
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
              {[0, 1, 2, 3].map(i => (
                <div key={i} className="bg-gray-50 rounded-xl p-4 animate-pulse">
                  <div className="h-3 w-20 bg-gray-200 rounded mb-2" />
                  <div className="h-6 w-16 bg-gray-200 rounded" />
                </div>
              ))}
            </div>
          </div>
        ) : perfSummary && (perfSummary.totalSpend > 0 || perfSummary.ads?.length > 0) ? (
          /* Performance Dashboard */
          <div className="card p-6">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <svg className="w-4 h-4 text-gold" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
                </svg>
                <h3 className="text-[14px] font-semibold text-textdark">Meta Performance</h3>
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-gold/10 text-gold font-medium">
                  {perfSummary.ads?.length || 0} linked ad{(perfSummary.ads?.length || 0) !== 1 ? 's' : ''}
                </span>
              </div>
              <button
                onClick={handleMetaSync}
                disabled={metaSyncing}
                className="btn-secondary text-[11px] inline-flex items-center gap-1.5 px-3 py-1.5"
              >
                {metaSyncing ? (
                  <>
                    <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4 31.4" strokeLinecap="round" />
                    </svg>
                    Syncing...
                  </>
                ) : (
                  <>
                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182" />
                    </svg>
                    Sync Now
                  </>
                )}
              </button>
            </div>

            {/* Summary metric cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
              <div className="bg-teal/5 rounded-xl p-4 border border-teal/15">
                <p className="text-[10px] uppercase tracking-wider font-medium text-teal mb-1">Total Spend</p>
                <p className="text-[20px] font-bold text-textdark">${perfSummary.totalSpend?.toFixed(2) || '0.00'}</p>
              </div>
              <div className="bg-navy/5 rounded-xl p-4 border border-navy/10">
                <p className="text-[10px] uppercase tracking-wider font-medium text-navy mb-1">Impressions</p>
                <p className="text-[20px] font-bold text-textdark">{(perfSummary.totalImpressions || 0).toLocaleString()}</p>
              </div>
              <div className="bg-gold/5 rounded-xl p-4 border border-gold/15">
                <p className="text-[10px] uppercase tracking-wider font-medium text-gold mb-1">Avg CTR</p>
                <p className="text-[20px] font-bold text-textdark">{(perfSummary.avgCTR || 0).toFixed(2)}%</p>
              </div>
              <div className="bg-cream rounded-xl p-4 border border-gold/10">
                <p className="text-[10px] uppercase tracking-wider font-medium text-gold mb-1">Avg CPC</p>
                <p className="text-[20px] font-bold text-textdark">${(perfSummary.avgCPC || 0).toFixed(2)}</p>
              </div>
            </div>

            {/* Per-ad performance table */}
            {perfSummary.ads?.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-gray-100">
                      <th className="px-3 py-2 text-[10px] uppercase tracking-wider font-medium text-textlight">Ad</th>
                      <th className="px-3 py-2 text-[10px] uppercase tracking-wider font-medium text-textlight text-right">Spend</th>
                      <th className="px-3 py-2 text-[10px] uppercase tracking-wider font-medium text-textlight text-right">Impressions</th>
                      <th className="px-3 py-2 text-[10px] uppercase tracking-wider font-medium text-textlight text-right">Clicks</th>
                      <th className="px-3 py-2 text-[10px] uppercase tracking-wider font-medium text-textlight text-right">CTR</th>
                      <th className="px-3 py-2 text-[10px] uppercase tracking-wider font-medium text-textlight text-right">CPC</th>
                      <th className="px-3 py-2 text-[10px] uppercase tracking-wider font-medium text-textlight text-right">CPM</th>
                      <th className="px-3 py-2 text-[10px] uppercase tracking-wider font-medium text-textlight text-right">ROAS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {perfSummary.ads.map((ad, idx) => {
                      // Count how many deployments share this Meta Ad ID
                      const sharedCount = deployments.filter(d => d.meta_ad_id === ad.metaAdId).length;
                      return (
                        <tr key={ad.metaAdId || idx} className="border-b border-gray-50 last:border-0 hover:bg-gray-50/50">
                          <td className="px-3 py-2.5">
                            <span className="text-[12px] font-medium text-textdark">{ad.adName || ad.metaAdId?.slice(0, 8)}</span>
                            {sharedCount > 1 && (
                              <span className="ml-1.5 text-[9px] px-1.5 py-0.5 rounded-full bg-navy/10 text-navy font-medium">
                                Shared ({sharedCount})
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2.5 text-[12px] text-textdark text-right font-medium">${ad.spend?.toFixed(2)}</td>
                          <td className="px-3 py-2.5 text-[12px] text-textmid text-right">{(ad.impressions || 0).toLocaleString()}</td>
                          <td className="px-3 py-2.5 text-[12px] text-textmid text-right">{(ad.clicks || 0).toLocaleString()}</td>
                          <td className="px-3 py-2.5 text-[12px] text-textmid text-right">{ad.ctr?.toFixed(2)}%</td>
                          <td className="px-3 py-2.5 text-[12px] text-textmid text-right">${ad.cpc?.toFixed(2)}</td>
                          <td className="px-3 py-2.5 text-[12px] text-textmid text-right">${ad.cpm?.toFixed(2)}</td>
                          <td className="px-3 py-2.5 text-[12px] text-textmid text-right font-medium">
                            {ad.roas > 0 ? `${ad.roas.toFixed(2)}x` : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ) : metaConnected ? (
          /* Connected but no linked ads */
          <div className="card p-8 text-center">
            <div className="flex items-center justify-center gap-3 mb-2">
              <svg className="w-5 h-5 text-gold/40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m9.86-4.553a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" />
              </svg>
              <h3 className="text-[13px] font-semibold text-textdark">Performance Tracking</h3>
            </div>
            <p className="text-[12px] text-textlight max-w-md mx-auto">
              Meta is connected! Click the link icon
              <svg className="w-3.5 h-3.5 inline mx-1 text-textlight" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m9.86-4.553a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" />
              </svg>
              on any deployment to link it to a Meta Ad and start tracking performance.
            </p>
          </div>
        ) : null}
      </div>

      {/* Campaign Browser Modal */}
      {linkingDepId && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-6 fade-in"
          onClick={() => setLinkingDepId(null)}
        >
          <div
            className="bg-white rounded-2xl shadow-card-hover w-full max-w-lg max-h-[70vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header with breadcrumbs */}
            <div className="px-5 py-4 border-b border-gray-100">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-[15px] font-semibold text-textdark">Link to Meta Ad</h3>
                <button
                  onClick={() => setLinkingDepId(null)}
                  className="text-textlight/60 hover:text-textmid transition-colors"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              {/* Breadcrumbs */}
              <div className="flex items-center gap-1 text-[11px]">
                <button
                  onClick={() => setCampaignBrowser(prev => ({ ...prev, step: 'campaigns', selectedCampaign: null, selectedAdset: null, adsets: [], ads: [] }))}
                  className={`px-2 py-0.5 rounded-md transition-colors ${campaignBrowser.step === 'campaigns' ? 'bg-navy/10 text-navy font-medium' : 'text-textlight hover:text-textmid'}`}
                >
                  Campaigns
                </button>
                {campaignBrowser.selectedCampaign && (
                  <>
                    <svg className="w-3 h-3 text-textlight/60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                    <button
                      onClick={() => setCampaignBrowser(prev => ({ ...prev, step: 'adsets', selectedAdset: null, ads: [] }))}
                      className={`px-2 py-0.5 rounded-md transition-colors truncate max-w-[120px] ${campaignBrowser.step === 'adsets' ? 'bg-navy/10 text-navy font-medium' : 'text-textlight hover:text-textmid'}`}
                      title={campaignBrowser.selectedCampaign.name}
                    >
                      {campaignBrowser.selectedCampaign.name}
                    </button>
                  </>
                )}
                {campaignBrowser.selectedAdset && (
                  <>
                    <svg className="w-3 h-3 text-textlight/60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                    <span className="px-2 py-0.5 rounded-md bg-navy/10 text-navy font-medium truncate max-w-[120px]" title={campaignBrowser.selectedAdset.name}>
                      {campaignBrowser.selectedAdset.name}
                    </span>
                  </>
                )}
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-5 py-3">
              {campaignBrowser.loading ? (
                <div className="space-y-2 py-4">
                  {[0, 1, 2, 3].map(i => (
                    <div key={i} className="h-10 bg-gray-100 rounded-lg animate-pulse" />
                  ))}
                </div>
              ) : campaignBrowser.step === 'campaigns' ? (
                campaignBrowser.campaigns.length === 0 ? (
                  <p className="text-[12px] text-textlight py-8 text-center">No campaigns found in this ad account.</p>
                ) : (
                  <div className="space-y-1.5">
                    {campaignBrowser.campaigns.map(c => (
                      <button
                        key={c.id}
                        onClick={() => selectCampaign(c)}
                        className="w-full text-left px-3 py-2.5 rounded-lg border border-gray-200 hover:border-navy/30 hover:bg-navy/5 transition-colors flex items-center justify-between group"
                      >
                        <div>
                          <span className="text-[12px] font-medium text-textdark">{c.name}</span>
                          {c.status && (
                            <span className={`ml-2 text-[9px] px-1.5 py-0.5 rounded-full font-medium ${
                              c.status === 'ACTIVE' ? 'bg-teal/10 text-teal' : 'bg-gray-100 text-textmid'
                            }`}>{c.status}</span>
                          )}
                        </div>
                        <svg className="w-4 h-4 text-textlight/60 group-hover:text-navy" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                      </button>
                    ))}
                  </div>
                )
              ) : campaignBrowser.step === 'adsets' ? (
                campaignBrowser.adsets.length === 0 ? (
                  <p className="text-[12px] text-textlight py-8 text-center">No ad sets found in this campaign.</p>
                ) : (
                  <div className="space-y-1.5">
                    {campaignBrowser.adsets.map(as => (
                      <button
                        key={as.id}
                        onClick={() => selectAdset(as)}
                        className="w-full text-left px-3 py-2.5 rounded-lg border border-gray-200 hover:border-navy/30 hover:bg-navy/5 transition-colors flex items-center justify-between group"
                      >
                        <div>
                          <span className="text-[12px] font-medium text-textdark">{as.name}</span>
                          {as.status && (
                            <span className={`ml-2 text-[9px] px-1.5 py-0.5 rounded-full font-medium ${
                              as.status === 'ACTIVE' ? 'bg-teal/10 text-teal' : 'bg-gray-100 text-textmid'
                            }`}>{as.status}</span>
                          )}
                        </div>
                        <svg className="w-4 h-4 text-textlight/60 group-hover:text-navy" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                      </button>
                    ))}
                  </div>
                )
              ) : campaignBrowser.step === 'ads' ? (
                campaignBrowser.ads.length === 0 ? (
                  <p className="text-[12px] text-textlight py-8 text-center">No ads found in this ad set.</p>
                ) : (
                  <div className="space-y-1.5">
                    {campaignBrowser.ads.map(ad => (
                      <button
                        key={ad.id}
                        onClick={() => selectMetaAd(ad)}
                        className="w-full text-left px-3 py-2.5 rounded-lg border border-gray-200 hover:border-teal/30 hover:bg-teal/5 transition-colors flex items-center justify-between group"
                      >
                        <div>
                          <span className="text-[12px] font-medium text-textdark">{ad.name}</span>
                          {ad.status && (
                            <span className={`ml-2 text-[9px] px-1.5 py-0.5 rounded-full font-medium ${
                              ad.status === 'ACTIVE' ? 'bg-teal/10 text-teal' : 'bg-gray-100 text-textmid'
                            }`}>{ad.status}</span>
                          )}
                          <span className="block text-[10px] text-textlight mt-0.5">ID: {ad.id}</span>
                        </div>
                        <span className="text-[10px] text-teal font-medium opacity-0 group-hover:opacity-100 transition-opacity">
                          Select
                        </span>
                      </button>
                    ))}
                  </div>
                )
              ) : null}
            </div>
          </div>
        </div>
      )}

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
              className="absolute left-4 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-white/90 shadow-card flex items-center justify-center text-textmid hover:text-textdark hover:bg-white transition-all z-20"
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
              className="absolute right-4 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-white/90 shadow-card flex items-center justify-center text-textmid hover:text-textdark hover:bg-white transition-all z-20"
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
                className="w-8 h-8 rounded-full bg-white shadow-card flex items-center justify-center text-textlight hover:text-navy transition-colors"
                title="Download image"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
              </button>
              <button
                onClick={() => setPreviewDepId(null)}
                className="w-8 h-8 rounded-full bg-white shadow-card flex items-center justify-center text-textlight hover:text-textmid transition-colors"
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

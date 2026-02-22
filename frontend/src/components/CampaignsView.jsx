import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../api';

const CTA_OPTIONS = [
  'SHOP_NOW', 'LEARN_MORE', 'SIGN_UP', 'BOOK_NOW', 'CONTACT_US',
  'DOWNLOAD', 'GET_QUOTE', 'SUBSCRIBE', 'ORDER_NOW', 'WATCH_MORE',
  'LISTEN_NOW', 'APPLY_NOW', 'GET_OFFER', 'NO_BUTTON',
];

/**
 * CampaignsView — Organises deployments into campaigns and ad sets.
 *
 * Layout:
 *   Top:    "Unplanned" holding area (deployments with local_campaign_id === 'unplanned')
 *   Bottom: Campaigns list with nested ad sets (each ad set is a drop zone)
 *
 * Features:
 *   - Drag & drop from Unplanned → ad sets
 *   - Duplicate ads within ad sets
 *   - Combine multiple ads into Flex ads
 *   - Detail sidebar with AI-generated primary text + headlines, destination URL, CTA
 *
 * Props:
 *   projectId, deployments, setDeployments, addToast, loadDeployments
 */
export default function CampaignsView({ projectId, deployments, setDeployments, addToast, loadDeployments }) {
  const [campaigns, setCampaigns] = useState([]);
  const [adSets, setAdSets] = useState([]);
  const [flexAds, setFlexAds] = useState([]);
  const [loading, setLoading] = useState(true);

  // Inline editing
  const [editingCampaign, setEditingCampaign] = useState(null);
  const [editingAdSet, setEditingAdSet] = useState(null);
  const [newCampaignName, setNewCampaignName] = useState('');
  const [creatingCampaign, setCreatingCampaign] = useState(false);
  const [addingAdSetFor, setAddingAdSetFor] = useState(null);
  const [newAdSetName, setNewAdSetName] = useState('');

  // Drag state — dragIds uses a ref to avoid re-renders that kill the drag
  const dragIdsRef = useRef(null);
  const [dragVisual, setDragVisual] = useState(null);  // only for visual feedback (opacity)
  const [dropTarget, setDropTarget] = useState(null);

  // Selection for unplanned
  const [selectedUnplanned, setSelectedUnplanned] = useState(new Set());

  // Selection within ad sets (for combining into flex)
  const [selectedInAdSet, setSelectedInAdSet] = useState({});

  // Collapsed campaigns
  const [collapsed, setCollapsed] = useState(new Set());

  // Assign dropdown (Unplanned → Ad Set picker)
  const [assignDropdown, setAssignDropdown] = useState(false);

  // Delete confirmation modal
  const [deleteConfirm, setDeleteConfirm] = useState({ open: false, ids: [], source: 'unplanned' });

  // Image preview lightbox (for flex ad thumbnails)
  const [previewImage, setPreviewImage] = useState(null);

  // Detail sidebar
  const [sidebarData, setSidebarData] = useState(null);
  const [sidebarForm, setSidebarForm] = useState({
    ad_name: '', destination_url: '', cta_button: 'LEARN_MORE', primary_texts: [], ad_headlines: [], planned_date: '',
  });
  const [generatingPrimaryText, setGeneratingPrimaryText] = useState(false);
  const [generatingHeadlines, setGeneratingHeadlines] = useState(false);
  const [sidebarSaving, setSidebarSaving] = useState(false);
  const [primaryTextOpen, setPrimaryTextOpen] = useState(false);
  const [headlinesOpen, setHeadlinesOpen] = useState(false);
  const [expandedFlexChild, setExpandedFlexChild] = useState(null);

  const campaignInputRef = useRef(null);
  const adSetInputRef = useRef(null);
  const assignDropdownRef = useRef(null);

  useEffect(() => {
    loadCampaignData();
  }, [projectId]);

  const loadCampaignData = async () => {
    setLoading(true);
    try {
      const [campData, flexData] = await Promise.all([
        api.getCampaigns(projectId),
        api.getFlexAds(projectId),
      ]);
      setCampaigns(campData.campaigns || []);
      setAdSets(campData.adSets || []);
      setFlexAds(flexData.flexAds || []);
    } catch { /* ignore */ }
    setLoading(false);
  };

  // ─── Derived data ───────────────────────────────────────────────────────
  const unplannedDeps = deployments.filter(d => d.local_campaign_id === 'unplanned');
  const getAdSetDeps = (adsetId) => deployments.filter(d => d.local_adset_id === adsetId);
  const getCampaignAdSets = (campaignId) =>
    adSets.filter(a => a.campaign_id === campaignId).sort((a, b) => a.sort_order - b.sort_order);
  const sortedCampaigns = [...campaigns].sort((a, b) => a.sort_order - b.sort_order);
  const getAdSetFlexAds = (adsetId) => flexAds.filter(f => f.ad_set_id === adsetId);

  // ─── Campaign CRUD ──────────────────────────────────────────────────────
  const handleCreateCampaign = async () => {
    if (!newCampaignName.trim()) return;
    try {
      await api.createCampaign(projectId, newCampaignName.trim());
      setNewCampaignName('');
      setCreatingCampaign(false);
      await loadCampaignData();
      addToast('Campaign created', 'success');
    } catch {
      addToast('Failed to create campaign', 'error');
    }
  };

  const handleRenameCampaign = async (id, name) => {
    if (!name.trim()) { setEditingCampaign(null); return; }
    try {
      await api.updateCampaign(id, { name: name.trim() });
      setCampaigns(prev => prev.map(c => c.id === id ? { ...c, name: name.trim() } : c));
      setEditingCampaign(null);
    } catch {
      addToast('Failed to rename campaign', 'error');
    }
  };

  const handleDeleteCampaign = async (id) => {
    try {
      await api.deleteCampaign(id);
      await loadCampaignData();
      await loadDeployments();
      addToast('Campaign deleted', 'success');
    } catch {
      addToast('Failed to delete campaign', 'error');
    }
  };

  // ─── Ad Set CRUD ────────────────────────────────────────────────────────
  const handleCreateAdSet = async (campaignId) => {
    if (!newAdSetName.trim()) return;
    try {
      await api.createAdSet(campaignId, newAdSetName.trim(), projectId);
      setNewAdSetName('');
      setAddingAdSetFor(null);
      await loadCampaignData();
      addToast('Ad set created', 'success');
    } catch {
      addToast('Failed to create ad set', 'error');
    }
  };

  const handleRenameAdSet = async (id, name) => {
    if (!name.trim()) { setEditingAdSet(null); return; }
    try {
      await api.updateAdSet(id, { name: name.trim() });
      setAdSets(prev => prev.map(a => a.id === id ? { ...a, name: name.trim() } : a));
      setEditingAdSet(null);
    } catch {
      addToast('Failed to rename ad set', 'error');
    }
  };

  const handleDeleteAdSet = async (id) => {
    try {
      await api.deleteAdSet(id);
      await loadCampaignData();
      await loadDeployments();
      addToast('Ad set deleted', 'success');
    } catch {
      addToast('Failed to delete ad set', 'error');
    }
  };

  // ─── Drag & Drop ───────────────────────────────────────────────────────
  const handleDragStart = (e, depId, fromAdSet = false) => {
    let ids;
    if (fromAdSet) {
      const dep = deployments.find(d => d.id === depId);
      const asId = dep?.local_adset_id;
      const sel = selectedInAdSet[asId];
      ids = sel?.has(depId) && sel.size > 0 ? [...sel] : [depId];
    } else {
      ids = selectedUnplanned.has(depId) && selectedUnplanned.size > 0
        ? [...selectedUnplanned]
        : [depId];
    }
    // Store in ref (no re-render) so the drag isn't killed
    dragIdsRef.current = ids;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', JSON.stringify({ deploymentIds: ids }));
    // Schedule visual update for next frame (after drag is established)
    requestAnimationFrame(() => setDragVisual(ids));
  };

  const handleDragEnd = () => {
    dragIdsRef.current = null;
    setDragVisual(null);
    setDropTarget(null);
  };

  const handleDragOver = (e, adsetId) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropTarget(adsetId);
  };

  const handleDragLeave = (e) => {
    if (!e.currentTarget.contains(e.relatedTarget)) {
      setDropTarget(null);
    }
  };

  const handleDrop = async (e, campaignId, adsetId) => {
    e.preventDefault();
    setDropTarget(null);
    let ids;
    try {
      const data = JSON.parse(e.dataTransfer.getData('text/plain'));
      ids = data.deploymentIds;
    } catch { return; }
    if (!ids?.length) return;

    setDeployments(prev => prev.map(d =>
      ids.includes(d.id) ? { ...d, local_campaign_id: campaignId, local_adset_id: adsetId, flex_ad_id: null } : d
    ));
    setSelectedUnplanned(new Set());
    setSelectedInAdSet(prev => {
      const next = { ...prev };
      Object.keys(next).forEach(k => { next[k] = new Set([...next[k]].filter(id => !ids.includes(id))); });
      return next;
    });
    dragIdsRef.current = null;
    setDragVisual(null);

    try {
      await api.assignToAdSet(ids, campaignId, adsetId);
    } catch {
      addToast('Failed to assign ads', 'error');
      loadDeployments();
    }
  };

  const handleUnassign = async (depIds) => {
    setDeployments(prev => prev.map(d =>
      depIds.includes(d.id) ? { ...d, local_campaign_id: 'unplanned', local_adset_id: undefined, flex_ad_id: null } : d
    ));
    try {
      await api.unassignFromAdSet(depIds);
    } catch {
      addToast('Failed to unassign', 'error');
      loadDeployments();
    }
  };

  const handleDropOnUnplanned = async (e) => {
    e.preventDefault();
    setDropTarget(null);
    let ids;
    try {
      const data = JSON.parse(e.dataTransfer.getData('text/plain'));
      ids = data.deploymentIds;
    } catch { return; }
    if (!ids?.length) return;

    setDeployments(prev => prev.map(d =>
      ids.includes(d.id) ? { ...d, local_campaign_id: 'unplanned', local_adset_id: undefined, flex_ad_id: null } : d
    ));
    dragIdsRef.current = null;
    setDragVisual(null);

    try {
      await api.unassignFromAdSet(ids);
    } catch {
      addToast('Failed to move to unplanned', 'error');
      loadDeployments();
    }
  };

  // ─── Duplicate ──────────────────────────────────────────────────────────
  const handleDuplicate = async (depId) => {
    try {
      await api.duplicateDeployment(depId);
      await loadDeployments();
      addToast('Ad duplicated', 'success');
    } catch {
      addToast('Failed to duplicate', 'error');
    }
  };

  // ─── Flex Ad operations ─────────────────────────────────────────────────
  const handleCombineIntoFlex = async (adSetId) => {
    const selected = [...(selectedInAdSet[adSetId] || [])];
    if (selected.length < 2) return;
    const name = `Flex Ad (${selected.length} images)`;
    try {
      await api.createFlexAd(projectId, adSetId, name, selected);
      setSelectedInAdSet(prev => ({ ...prev, [adSetId]: new Set() }));
      await Promise.all([loadCampaignData(), loadDeployments()]);
      addToast('Flex ad created', 'success');
    } catch {
      addToast('Failed to create flex ad', 'error');
    }
  };

  const handleDeleteFlexAd = async (flexAdId) => {
    try {
      await api.deleteFlexAd(flexAdId);
      await Promise.all([loadCampaignData(), loadDeployments()]);
      addToast('Flex ad ungrouped', 'success');
    } catch {
      addToast('Failed to delete flex ad', 'error');
    }
  };

  // ─── Sidebar ────────────────────────────────────────────────────────────
  const openSidebar = (data) => {
    setSidebarData(data);
    setPrimaryTextOpen(false);
    setHeadlinesOpen(false);
    setExpandedFlexChild(null);
    if (data.type === 'single') {
      const dep = data.deployment;
      setSidebarForm({
        ad_name: dep.ad_name || dep.ad?.headline || dep.ad?.angle || '',
        destination_url: dep.destination_url || dep.landing_page_url || '',
        cta_button: dep.cta_button || 'LEARN_MORE',
        primary_texts: dep.primary_texts ? JSON.parse(dep.primary_texts) : [],
        ad_headlines: dep.ad_headlines ? JSON.parse(dep.ad_headlines) : [],
        planned_date: dep.planned_date || '',
      });
    } else {
      const flex = data.flexAd;
      setSidebarForm({
        ad_name: flex.name || '',
        destination_url: flex.destination_url || '',
        cta_button: flex.cta_button || 'LEARN_MORE',
        primary_texts: flex.primary_texts ? JSON.parse(flex.primary_texts) : [],
        ad_headlines: flex.headlines ? JSON.parse(flex.headlines) : [],
        planned_date: flex.planned_date || '',
      });
    }
  };

  const closeSidebar = () => setSidebarData(null);

  // Close sidebar on Escape, close assign dropdown on Escape/outside click
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        if (previewImage) { setPreviewImage(null); return; }
        if (deleteConfirm.open) { setDeleteConfirm({ open: false, ids: [], source: 'unplanned' }); return; }
        if (sidebarData) closeSidebar();
        if (assignDropdown) setAssignDropdown(false);
      }
    };
    const handleClickOutside = (e) => {
      if (assignDropdown && assignDropdownRef.current && !assignDropdownRef.current.contains(e.target)) {
        setAssignDropdown(false);
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [sidebarData, assignDropdown, deleteConfirm.open, previewImage]);

  const handleGeneratePrimaryText = async () => {
    setGeneratingPrimaryText(true);
    try {
      const depId = sidebarData.type === 'single'
        ? sidebarData.deployment.id
        : sidebarData.deps[0]?.id;
      const flexAdId = sidebarData.type === 'flex' ? sidebarData.flexAd.id : undefined;
      const result = await api.generatePrimaryText(depId, flexAdId);
      setSidebarForm(prev => ({ ...prev, primary_texts: result.primary_texts || [] }));
      addToast('Primary text generated', 'success');
    } catch {
      addToast('Failed to generate primary text', 'error');
    }
    setGeneratingPrimaryText(false);
  };

  const handleGenerateHeadlines = async () => {
    setGeneratingHeadlines(true);
    try {
      const depId = sidebarData.type === 'single'
        ? sidebarData.deployment.id
        : sidebarData.deps[0]?.id;
      const flexAdId = sidebarData.type === 'flex' ? sidebarData.flexAd.id : undefined;
      const result = await api.generateAdHeadlines(depId, sidebarForm.primary_texts, flexAdId);
      setSidebarForm(prev => ({ ...prev, ad_headlines: result.headlines || [] }));
      addToast('Headlines generated', 'success');
    } catch {
      addToast('Failed to generate headlines', 'error');
    }
    setGeneratingHeadlines(false);
  };

  const handleSaveSidebar = async () => {
    setSidebarSaving(true);
    try {
      if (sidebarData.type === 'single') {
        await api.updateDeployment(sidebarData.deployment.id, {
          ad_name: sidebarForm.ad_name,
          primary_texts: JSON.stringify(sidebarForm.primary_texts),
          ad_headlines: JSON.stringify(sidebarForm.ad_headlines),
          destination_url: sidebarForm.destination_url,
          cta_button: sidebarForm.cta_button,
          planned_date: sidebarForm.planned_date || null,
        });
      } else {
        await api.updateFlexAd(sidebarData.flexAd.id, {
          name: sidebarForm.ad_name,
          primary_texts: JSON.stringify(sidebarForm.primary_texts),
          headlines: JSON.stringify(sidebarForm.ad_headlines),
          destination_url: sidebarForm.destination_url,
          cta_button: sidebarForm.cta_button,
          planned_date: sidebarForm.planned_date || null,
        });
      }
      await loadDeployments();
      addToast('Saved', 'success');
    } catch {
      addToast('Failed to save', 'error');
    }
    setSidebarSaving(false);
  };

  // Focus inputs when they appear
  useEffect(() => {
    if (creatingCampaign && campaignInputRef.current) campaignInputRef.current.focus();
  }, [creatingCampaign]);
  useEffect(() => {
    if (addingAdSetFor && adSetInputRef.current) adSetInputRef.current.focus();
  }, [addingAdSetFor]);

  // ─── Toggle ad set selection ────────────────────────────────────────────
  const toggleAdSetSelect = (adsetId, depId) => {
    setSelectedInAdSet(prev => {
      const current = new Set(prev[adsetId] || []);
      if (current.has(depId)) current.delete(depId); else current.add(depId);
      return { ...prev, [adsetId]: current };
    });
  };

  // ─── Select All helpers ────────────────────────────────────────────────
  const toggleSelectAllUnplanned = () => {
    if (selectedUnplanned.size === unplannedDeps.length && unplannedDeps.length > 0) {
      setSelectedUnplanned(new Set());
    } else {
      setSelectedUnplanned(new Set(unplannedDeps.map(d => d.id)));
    }
  };

  const toggleSelectAllInAdSet = (adsetId, standaloneDeps, adSetFlexList = []) => {
    const allIds = [...standaloneDeps.map(d => d.id), ...adSetFlexList.map(f => f.id)];
    setSelectedInAdSet(prev => {
      const current = new Set(prev[adsetId] || []);
      if (current.size === allIds.length && allIds.length > 0) {
        return { ...prev, [adsetId]: new Set() };
      }
      return { ...prev, [adsetId]: new Set(allIds) };
    });
  };

  // ─── Bulk delete with confirmation ─────────────────────────────────────
  const handleConfirmDelete = async () => {
    const ids = deleteConfirm.ids;
    try {
      await Promise.all(ids.map(id => api.deleteDeployment(id)));
      setDeployments(prev => prev.filter(d => !ids.includes(d.id)));
      // Clear relevant selection
      if (deleteConfirm.source === 'unplanned') {
        setSelectedUnplanned(new Set());
      } else {
        setSelectedInAdSet(prev => {
          const next = { ...prev };
          Object.keys(next).forEach(k => {
            next[k] = new Set([...next[k]].filter(id => !ids.includes(id)));
          });
          return next;
        });
      }
      addToast(`${ids.length} removed from tracker`, 'success');
    } catch {
      addToast('Failed to delete some deployments', 'error');
    }
    setDeleteConfirm({ open: false, ids: [], source: 'unplanned' });
  };

  // ─── Assign selected unplanned to a specific ad set ──────────────────
  const handleAssignSelectedToAdSet = async (campaignId, adsetId) => {
    const ids = [...selectedUnplanned];
    if (!ids.length) return;
    setAssignDropdown(false);

    // Optimistic
    setDeployments(prev => prev.map(d =>
      ids.includes(d.id) ? { ...d, local_campaign_id: campaignId, local_adset_id: adsetId } : d
    ));
    setSelectedUnplanned(new Set());

    try {
      await api.assignToAdSet(ids, campaignId, adsetId);
      addToast(`Assigned ${ids.length} ad${ids.length > 1 ? 's' : ''} to ad set`, 'success');
    } catch {
      addToast('Failed to assign ads', 'error');
      loadDeployments();
    }
  };

  // ─── renderDepCard (render function, NOT a component — avoids unmount on re-render) ──
  const renderDepCard = (dep, { isDraggable = false, inAdSet = false, adsetId = null } = {}) => {
    const name = dep.ad?.headline || dep.ad?.angle || dep.ad_name || `Ad ${(dep.id || '').slice(0, 6)}`;
    const thumbUrl = dep.imageUrl;
    const isDragging = dragVisual?.includes(dep.id);
    const isSelectedUnplanned = selectedUnplanned.has(dep.id);
    const isSelectedInAdSet = inAdSet && selectedInAdSet[adsetId]?.has(dep.id);
    const isSelected = inAdSet ? isSelectedInAdSet : isSelectedUnplanned;

    return (
      <div
        key={dep.id}
        draggable={isDraggable}
        onDragStart={isDraggable ? (e) => handleDragStart(e, dep.id, inAdSet) : undefined}
        onDragEnd={isDraggable ? handleDragEnd : undefined}
        onClick={inAdSet ? () => openSidebar({ type: 'single', deployment: dep, ad: dep.ad }) : undefined}
        className={`relative group flex items-center gap-2.5 p-2 rounded-xl border transition-all select-none ${
          isDraggable && !inAdSet ? 'cursor-grab active:cursor-grabbing' : ''
        } ${
          inAdSet ? 'cursor-pointer' : ''
        } ${
          isDragging ? 'opacity-40 border-navy/30 bg-navy/5' :
          isSelected ? 'border-navy/40 bg-navy/5' :
          'border-gray-200 bg-white hover:border-navy/20 hover:shadow-sm'
        }`}
      >
        {/* Checkbox */}
        <button
          onMouseDown={(e) => e.stopPropagation()}
          onDragStart={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation();
            if (inAdSet) {
              toggleAdSetSelect(adsetId, dep.id);
            } else {
              setSelectedUnplanned(prev => {
                const next = new Set(prev);
                if (next.has(dep.id)) next.delete(dep.id); else next.add(dep.id);
                return next;
              });
            }
          }}
          className={`w-[14px] h-[14px] rounded flex-shrink-0 flex items-center justify-center transition-colors ${
            isSelected ? 'bg-navy' : 'border-[1.5px] border-textlight/60 hover:border-navy/40'
          }`}
        >
          {isSelected && (
            <svg className="w-2 h-2 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
            </svg>
          )}
        </button>

        {thumbUrl ? (
          <img
            src={thumbUrl}
            alt=""
            draggable="false"
            className="w-10 h-10 object-cover rounded-lg bg-gray-100 flex-shrink-0"
            loading="lazy"
          />
        ) : (
          <div className="w-10 h-10 rounded-lg bg-gray-100 flex-shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-medium text-textdark truncate" title={name}>{name}</div>
          {dep.ad?.body_copy && (
            <div className="text-[10px] text-textlight truncate mt-0.5">{dep.ad.body_copy}</div>
          )}
        </div>

        {/* Action buttons on hover */}
        <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 flex-shrink-0 transition-opacity">
          {inAdSet && (
            <span className="text-[10px] text-navy font-medium mr-1">Edit</span>
          )}
          {inAdSet && (
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onDragStart={(e) => e.preventDefault()}
              onClick={(e) => { e.stopPropagation(); handleDuplicate(dep.id); }}
              className="p-1 rounded-lg hover:bg-navy/10 text-textlight hover:text-navy transition-colors"
              title="Duplicate"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </button>
          )}
          {inAdSet && (
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onDragStart={(e) => e.preventDefault()}
              onClick={(e) => { e.stopPropagation(); handleUnassign([dep.id]); }}
              className="p-1 rounded-lg hover:bg-red-50 text-textlight hover:text-red-500 transition-colors"
              title="Move back to Unplanned"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>
    );
  };

  // ─── renderFlexAdCard (render function, NOT a component) ──────────────
  const renderFlexAdCard = (flexAd, { adsetId = null } = {}) => {
    const childIds = JSON.parse(flexAd.child_deployment_ids || '[]');
    const childDeps = childIds.map(id => deployments.find(d => d.id === id)).filter(Boolean);
    const isSelected = adsetId && selectedInAdSet[adsetId]?.has(flexAd.id);

    return (
      <div
        key={flexAd.id}
        onClick={() => openSidebar({ type: 'flex', flexAd, deps: childDeps })}
        className={`relative group flex items-center gap-2.5 p-2 rounded-xl border transition-all cursor-pointer ${
          isSelected ? 'border-navy/40 bg-navy/10' : 'border-navy/20 bg-navy/5 hover:border-navy/30 hover:shadow-sm'
        }`}
      >
        {/* Checkbox */}
        {adsetId && (
          <button
            onClick={(e) => { e.stopPropagation(); toggleAdSetSelect(adsetId, flexAd.id); }}
            className={`w-[14px] h-[14px] rounded flex-shrink-0 flex items-center justify-center transition-colors ${
              isSelected ? 'bg-navy' : 'border-[1.5px] border-textlight/60 hover:border-navy/40'
            }`}
          >
            {isSelected && (
              <svg className="w-2 h-2 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
              </svg>
            )}
          </button>
        )}
        <span className="text-[9px] font-bold text-white bg-navy px-1.5 py-0.5 rounded tracking-wide flex-shrink-0">FLEX</span>
        <div className="flex items-center gap-1 flex-shrink-0">
          {childDeps.slice(0, 4).map(d => (
            d.imageUrl ? (
              <img key={d.id} src={d.imageUrl} alt="" className="w-11 h-11 object-cover rounded-lg bg-gray-100" loading="lazy" />
            ) : (
              <div key={d.id} className="w-11 h-11 rounded-lg bg-gray-200" />
            )
          ))}
          {childDeps.length > 4 && (
            <div className="w-11 h-11 rounded-lg bg-gray-200 flex items-center justify-center text-[10px] text-textlight">
              +{childDeps.length - 4}
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-medium text-textdark truncate">{flexAd.name}</div>
          <div className="text-[10px] text-textlight">{childDeps.length} image{childDeps.length !== 1 ? 's' : ''}</div>
        </div>

        {/* Hover actions */}
        <div className="opacity-0 group-hover:opacity-100 flex items-center gap-1 flex-shrink-0 transition-opacity">
          <button
            onClick={(e) => { e.stopPropagation(); handleDeleteFlexAd(flexAd.id); }}
            className="p-1 rounded-lg hover:bg-red-50 text-textlight hover:text-red-500 transition-colors"
            title="Ungroup Flex Ad"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </div>
      </div>
    );
  };

  // ─── Detail Sidebar ─────────────────────────────────────────────────────
  const renderSidebar = () => {
    if (!sidebarData) return null;
    const isFlex = sidebarData.type === 'flex';
    const dep = sidebarData.deployment;
    const flexAd = sidebarData.flexAd;
    const childDeps = sidebarData.deps || [];

    return (
      <>
        {/* Backdrop */}
        <div className="fixed inset-0 bg-black/20 z-40" onClick={closeSidebar} />

        {/* Panel */}
        <div className="fixed right-0 top-0 h-full w-[420px] bg-white shadow-xl z-50 overflow-y-auto animate-slide-in-right scrollbar-thin">
          {/* Header */}
          <div className="sticky top-0 bg-white/95 backdrop-blur border-b border-gray-100 px-5 py-4 flex items-center justify-between z-10">
            <div className="flex items-center gap-2">
              {isFlex && <span className="text-[9px] font-bold text-white bg-navy px-1.5 py-0.5 rounded tracking-wide">FLEX</span>}
              <h3 className="text-[14px] font-semibold text-textdark">
                {isFlex ? 'Flex Ad Details' : 'Ad Details'}
              </h3>
            </div>
            <button onClick={closeSidebar} className="p-1.5 rounded-lg hover:bg-gray-100 text-textlight transition-colors">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="p-5 space-y-5">
            {/* Image section */}
            {isFlex ? (
              <div className="space-y-2">
                <label className="text-[10px] font-medium text-textlight uppercase tracking-wider">
                  {childDeps.length} Ad{childDeps.length !== 1 ? 's' : ''} in Flex
                </label>
                {childDeps.map(d => {
                  const adName = d.ad?.headline || d.ad?.angle || d.ad_name || `Ad ${(d.id || '').slice(0, 6)}`;
                  const isExpanded = expandedFlexChild === d.id;
                  return (
                    <div
                      key={d.id}
                      className="rounded-xl border border-gray-200 overflow-hidden transition-all"
                    >
                      <button
                        onClick={() => setExpandedFlexChild(isExpanded ? null : d.id)}
                        className="w-full flex items-center gap-3 p-2.5 hover:bg-offwhite transition-colors"
                      >
                        {d.imageUrl ? (
                          <img src={d.imageUrl} alt="" className="w-12 h-12 object-cover rounded-lg bg-gray-100 flex-shrink-0" />
                        ) : (
                          <div className="w-12 h-12 rounded-lg bg-gray-200 flex-shrink-0" />
                        )}
                        <div className="min-w-0 flex-1 text-left">
                          <div className="text-[12px] font-medium text-textdark truncate">{adName}</div>
                          {d.ad?.body_copy && (
                            <div className="text-[10px] text-textlight truncate mt-0.5">{d.ad.body_copy}</div>
                          )}
                        </div>
                        <svg className={`w-4 h-4 text-textlight flex-shrink-0 transition-transform ${isExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        </svg>
                      </button>
                      {isExpanded && d.imageUrl && (
                        <div className="px-2.5 pb-2.5">
                          <img src={d.imageUrl} alt="" className="w-full rounded-lg bg-gray-100" />
                          {d.ad?.angle && (
                            <div className="mt-2">
                              <span className="text-[9px] font-medium text-textlight uppercase tracking-wider">Angle</span>
                              <p className="text-[11px] text-textdark mt-0.5">{d.ad.angle}</p>
                            </div>
                          )}
                          {d.ad?.headline && (
                            <div className="mt-1.5">
                              <span className="text-[9px] font-medium text-textlight uppercase tracking-wider">Headline</span>
                              <p className="text-[11px] text-textdark mt-0.5">{d.ad.headline}</p>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              dep?.imageUrl && (
                <img src={dep.imageUrl} alt="" className="w-full rounded-xl bg-gray-100" />
              )
            )}

            {/* ─── Ad Name ─── */}
            <div>
              <label className="text-[11px] font-semibold text-textdark uppercase tracking-wider">Ad Name</label>
              <input
                type="text"
                value={sidebarForm.ad_name}
                onChange={(e) => setSidebarForm(prev => ({ ...prev, ad_name: e.target.value }))}
                className="input-apple text-[12px] w-full mt-1.5"
                placeholder="Enter ad name..."
              />
            </div>

            {/* Ad info (single ad only) */}
            {!isFlex && dep?.ad && (
              <div className="space-y-2.5 bg-offwhite rounded-xl p-4">
                {dep.ad.angle && (
                  <div>
                    <label className="text-[10px] font-medium text-textlight uppercase tracking-wider">Angle</label>
                    <p className="text-[12px] text-textdark mt-0.5">{dep.ad.angle}</p>
                  </div>
                )}
                {dep.ad.headline && (
                  <div>
                    <label className="text-[10px] font-medium text-textlight uppercase tracking-wider">Headline</label>
                    <p className="text-[12px] text-textdark mt-0.5">{dep.ad.headline}</p>
                  </div>
                )}
                {dep.ad.body_copy && (
                  <div>
                    <label className="text-[10px] font-medium text-textlight uppercase tracking-wider">Body Copy</label>
                    <p className="text-[12px] text-textdark mt-0.5 whitespace-pre-wrap">{dep.ad.body_copy}</p>
                  </div>
                )}
              </div>
            )}

            {/* ─── Primary Text (collapsible) ─── */}
            <div className="rounded-xl border border-gray-200 overflow-hidden">
              <button
                onClick={() => setPrimaryTextOpen(!primaryTextOpen)}
                className="w-full flex items-center justify-between px-4 py-3 bg-offwhite hover:bg-gray-100 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <svg className={`w-3.5 h-3.5 text-textmid transition-transform ${primaryTextOpen ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                  <span className="text-[11px] font-semibold text-textdark uppercase tracking-wider">Primary Text</span>
                  <span className="text-[10px] text-textlight bg-black/5 px-1.5 py-0.5 rounded-full">
                    {sidebarForm.primary_texts.filter(t => t.trim()).length}/5
                  </span>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); handleGeneratePrimaryText(); }}
                  disabled={generatingPrimaryText}
                  className="text-[10px] px-2.5 py-1 rounded-lg bg-navy text-white hover:bg-navy-light transition-colors disabled:opacity-50 inline-flex items-center gap-1"
                >
                  {generatingPrimaryText ? (
                    <>
                      <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      Generating...
                    </>
                  ) : (
                    <>
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                      </svg>
                      Generate
                    </>
                  )}
                </button>
              </button>
              {primaryTextOpen && (
                <div className="p-4 space-y-3">
                  {Array.from({ length: Math.max(sidebarForm.primary_texts.length, 0) }, (_, i) => i).map(i => (
                    <div key={i}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[10px] text-textlight font-medium">Variation {i + 1}</span>
                        <button
                          onClick={() => setSidebarForm(prev => ({
                            ...prev,
                            primary_texts: prev.primary_texts.filter((_, idx) => idx !== i),
                          }))}
                          className="text-[10px] text-textlight hover:text-red-500 transition-colors"
                        >
                          Remove
                        </button>
                      </div>
                      <textarea
                        value={sidebarForm.primary_texts[i] || ''}
                        onChange={(e) => {
                          const updated = [...sidebarForm.primary_texts];
                          updated[i] = e.target.value;
                          setSidebarForm(prev => ({ ...prev, primary_texts: updated }));
                        }}
                        className="input-apple text-[12px] w-full"
                        rows={4}
                        placeholder={`Primary text variation ${i + 1}...`}
                      />
                    </div>
                  ))}
                  {sidebarForm.primary_texts.length < 5 && (
                    <button
                      onClick={() => setSidebarForm(prev => ({ ...prev, primary_texts: [...prev.primary_texts, ''] }))}
                      className="w-full py-2 rounded-lg border border-dashed border-gray-300 text-[11px] text-textmid hover:border-navy/30 hover:text-navy hover:bg-navy/5 transition-colors inline-flex items-center justify-center gap-1"
                    >
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                      </svg>
                      Add Variation
                    </button>
                  )}
                  {sidebarForm.primary_texts.length === 0 && (
                    <p className="text-[11px] text-textlight italic text-center py-2">No primary text yet. Click Generate or Add Variation.</p>
                  )}
                </div>
              )}
            </div>

            {/* ─── Headlines (collapsible) ─── */}
            <div className="rounded-xl border border-gray-200 overflow-hidden">
              <button
                onClick={() => setHeadlinesOpen(!headlinesOpen)}
                className="w-full flex items-center justify-between px-4 py-3 bg-offwhite hover:bg-gray-100 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <svg className={`w-3.5 h-3.5 text-textmid transition-transform ${headlinesOpen ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                  <span className="text-[11px] font-semibold text-textdark uppercase tracking-wider">Headlines</span>
                  <span className="text-[10px] text-textlight bg-black/5 px-1.5 py-0.5 rounded-full">
                    {sidebarForm.ad_headlines.filter(h => h.trim()).length}/5
                  </span>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); handleGenerateHeadlines(); }}
                  disabled={generatingHeadlines || sidebarForm.primary_texts.filter(t => t.trim()).length === 0}
                  className="text-[10px] px-2.5 py-1 rounded-lg bg-navy text-white hover:bg-navy-light transition-colors disabled:opacity-50 inline-flex items-center gap-1"
                  title={sidebarForm.primary_texts.filter(t => t.trim()).length === 0 ? 'Generate primary text first' : ''}
                >
                  {generatingHeadlines ? (
                    <>
                      <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      Generating...
                    </>
                  ) : (
                    <>
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                      </svg>
                      Generate
                    </>
                  )}
                </button>
              </button>
              {headlinesOpen && (
                <div className="p-4 space-y-2">
                  {sidebarForm.ad_headlines.map((h, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <span className="text-[10px] text-textlight font-medium w-4 flex-shrink-0">{i + 1}.</span>
                      <input
                        type="text"
                        value={h}
                        onChange={(e) => {
                          const updated = [...sidebarForm.ad_headlines];
                          updated[i] = e.target.value;
                          setSidebarForm(prev => ({ ...prev, ad_headlines: updated }));
                        }}
                        className="input-apple text-[12px] flex-1"
                        placeholder={`Headline ${i + 1}...`}
                      />
                      <button
                        onClick={() => setSidebarForm(prev => ({
                          ...prev,
                          ad_headlines: prev.ad_headlines.filter((_, idx) => idx !== i),
                        }))}
                        className="text-textlight hover:text-red-500 transition-colors flex-shrink-0"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  ))}
                  {sidebarForm.ad_headlines.length < 5 && (
                    <button
                      onClick={() => setSidebarForm(prev => ({ ...prev, ad_headlines: [...prev.ad_headlines, ''] }))}
                      className="w-full py-2 rounded-lg border border-dashed border-gray-300 text-[11px] text-textmid hover:border-navy/30 hover:text-navy hover:bg-navy/5 transition-colors inline-flex items-center justify-center gap-1"
                    >
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                      </svg>
                      Add Headline
                    </button>
                  )}
                  {sidebarForm.ad_headlines.length === 0 && (
                    <p className="text-[11px] text-textlight italic text-center py-2">
                      {sidebarForm.primary_texts.filter(t => t.trim()).length === 0
                        ? 'Generate primary text first, then generate headlines.'
                        : 'No headlines yet. Click Generate or Add Headline.'}
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* ─── Destination URL ─── */}
            <div>
              <label className="text-[11px] font-semibold text-textdark uppercase tracking-wider">Destination URL</label>
              <input
                type="url"
                value={sidebarForm.destination_url}
                onChange={(e) => setSidebarForm(prev => ({ ...prev, destination_url: e.target.value }))}
                className="input-apple text-[12px] w-full mt-1.5"
                placeholder="https://..."
              />
            </div>

            {/* ─── CTA Button ─── */}
            <div>
              <label className="text-[11px] font-semibold text-textdark uppercase tracking-wider">CTA Button</label>
              <select
                value={sidebarForm.cta_button}
                onChange={(e) => setSidebarForm(prev => ({ ...prev, cta_button: e.target.value }))}
                className="input-apple text-[12px] w-full mt-1.5"
              >
                {CTA_OPTIONS.map(cta => (
                  <option key={cta} value={cta}>{cta.replace(/_/g, ' ')}</option>
                ))}
              </select>
            </div>

            {/* ─── Scheduled Post Date & Time ─── */}
            <div>
              <label className="text-[11px] font-semibold text-textdark uppercase tracking-wider">Scheduled Post Date & Time</label>
              <input
                type="datetime-local"
                value={sidebarForm.planned_date}
                onChange={(e) => setSidebarForm(prev => ({ ...prev, planned_date: e.target.value }))}
                className="input-apple text-[12px] w-full mt-1.5"
              />
            </div>

            {/* ─── Save ─── */}
            <button
              onClick={handleSaveSidebar}
              disabled={sidebarSaving}
              className="btn-primary w-full text-[12px] py-2.5 disabled:opacity-50"
            >
              {sidebarSaving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </div>
      </>
    );
  };

  // ─── Render ─────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="space-y-4">
        {[0, 1, 2].map(i => (
          <div key={i} className="card p-6 animate-pulse">
            <div className="h-3 w-32 bg-gray-200 rounded mb-4" />
            <div className="flex gap-3">
              {[0, 1, 2].map(j => (
                <div key={j} className="w-24 h-16 bg-gray-100 rounded-lg" />
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* ═══════════ Unplanned Section ═══════════ */}
      <div
        className={`card p-5 transition-all ${
          dropTarget === 'unplanned' ? 'ring-2 ring-gold bg-gold/5' : ''
        }`}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDropTarget('unplanned'); }}
        onDragLeave={handleDragLeave}
        onDrop={handleDropOnUnplanned}
      >
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            {unplannedDeps.length > 0 && (
              <button
                onClick={toggleSelectAllUnplanned}
                className={`w-[14px] h-[14px] rounded flex-shrink-0 flex items-center justify-center transition-colors ${
                  selectedUnplanned.size === unplannedDeps.length && unplannedDeps.length > 0
                    ? 'bg-navy'
                    : selectedUnplanned.size > 0
                      ? 'bg-navy/50'
                      : 'border-[1.5px] border-textlight/60 hover:border-navy/40'
                }`}
              >
                {selectedUnplanned.size > 0 && (
                  <svg className="w-2 h-2 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d={
                      selectedUnplanned.size === unplannedDeps.length ? "M5 13l4 4L19 7" : "M5 12h14"
                    } />
                  </svg>
                )}
              </button>
            )}
            <h3 className="text-[13px] font-semibold text-textdark">Unplanned</h3>
            <span className="text-[11px] text-textlight bg-black/5 px-2 py-0.5 rounded-full">
              {unplannedDeps.length}
            </span>
          </div>
          {selectedUnplanned.size > 0 && (
            <div className="flex items-center gap-2 text-[11px]">
              <span className="text-navy font-medium">{selectedUnplanned.size} selected</span>

              {/* Assign to Ad Set dropdown */}
              <div className="relative" ref={assignDropdownRef}>
                <button
                  onClick={() => setAssignDropdown(!assignDropdown)}
                  className="px-2.5 py-1 rounded-lg bg-navy text-white hover:bg-navy-light transition-colors inline-flex items-center gap-1"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                  Add to Ad Set
                  <svg className={`w-3 h-3 transition-transform ${assignDropdown ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {assignDropdown && (
                  <div className="absolute right-0 top-full mt-1 w-64 bg-white rounded-xl shadow-lg border border-gray-200 z-50 max-h-[300px] overflow-y-auto">
                    {sortedCampaigns.length === 0 ? (
                      <div className="p-3 text-[11px] text-textlight text-center">
                        Create a campaign first
                      </div>
                    ) : (
                      sortedCampaigns.map(campaign => {
                        const campaignAS = getCampaignAdSets(campaign.id);
                        return (
                          <div key={campaign.id}>
                            <div className="px-3 py-2 text-[10px] font-semibold text-textlight uppercase tracking-wider bg-offwhite border-b border-gray-100">
                              {campaign.name}
                            </div>
                            {campaignAS.length === 0 ? (
                              <div className="px-3 py-2 text-[10px] text-textlight italic">
                                No ad sets — create one first
                              </div>
                            ) : (
                              campaignAS.map(adSet => (
                                <button
                                  key={adSet.id}
                                  onClick={() => handleAssignSelectedToAdSet(campaign.id, adSet.id)}
                                  className="w-full text-left px-4 py-2 text-[11px] text-textdark hover:bg-navy/5 transition-colors"
                                >
                                  {adSet.name}
                                  <span className="text-textlight ml-1">({getAdSetDeps(adSet.id).length} ads)</span>
                                </button>
                              ))
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                )}
              </div>

              <button
                onClick={() => setDeleteConfirm({ open: true, ids: [...selectedUnplanned], source: 'unplanned' })}
                className="px-2.5 py-1 rounded-lg bg-red-50 border border-red-200 text-red-600 hover:bg-red-100 transition-colors"
              >
                Delete
              </button>
              <button
                onClick={() => setSelectedUnplanned(new Set())}
                className="text-textlight hover:text-textmid"
              >
                Clear
              </button>
            </div>
          )}
        </div>

        {unplannedDeps.length === 0 ? (
          <div className="py-6 text-center">
            <p className="text-[12px] text-textlight">
              No unplanned ads. Move ads here from the Unposted tab.
            </p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {unplannedDeps.map(dep => renderDepCard(dep, { isDraggable: true }))}
          </div>
        )}
      </div>

      {/* ═══════════ Campaigns Section ═══════════ */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-[14px] font-semibold text-textdark">Campaigns</h3>
          {!creatingCampaign && (
            <button
              onClick={() => setCreatingCampaign(true)}
              className="text-[11px] px-3 py-1.5 rounded-lg bg-navy text-white hover:bg-navy-light transition-colors inline-flex items-center gap-1"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              New Campaign
            </button>
          )}
        </div>

        {/* Create campaign form */}
        {creatingCampaign && (
          <div className="card p-4 mb-4 fade-in">
            <div className="flex items-center gap-2">
              <input
                ref={campaignInputRef}
                type="text"
                value={newCampaignName}
                onChange={(e) => setNewCampaignName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleCreateCampaign(); if (e.key === 'Escape') { setCreatingCampaign(false); setNewCampaignName(''); } }}
                placeholder="Campaign name..."
                className="input-apple text-[13px] flex-1"
              />
              <button onClick={handleCreateCampaign} className="btn-primary text-[11px] px-3 py-2">
                Create
              </button>
              <button onClick={() => { setCreatingCampaign(false); setNewCampaignName(''); }} className="text-[11px] px-2 py-2 text-textlight hover:text-textmid">
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Campaign list */}
        {sortedCampaigns.length === 0 && !creatingCampaign && (
          <div className="card p-8 text-center">
            <div className="w-12 h-12 rounded-2xl bg-navy/5 flex items-center justify-center mx-auto mb-3">
              <svg className="w-6 h-6 text-textlight" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
              </svg>
            </div>
            <p className="text-[13px] text-textlight">No campaigns yet. Create one to start organizing your ads.</p>
          </div>
        )}

        <div className="space-y-4">
          {sortedCampaigns.map(campaign => {
            const campaignAdSets = getCampaignAdSets(campaign.id);
            const isCollapsed = collapsed.has(campaign.id);
            const totalAds = campaignAdSets.reduce((sum, as) => sum + getAdSetDeps(as.id).length, 0);

            return (
              <div key={campaign.id} className="card overflow-hidden">
                {/* Campaign header */}
                <div className="flex items-center gap-3 px-5 py-3.5 bg-offwhite border-b border-black/5">
                  <button
                    onClick={() => setCollapsed(prev => {
                      const next = new Set(prev);
                      if (next.has(campaign.id)) next.delete(campaign.id); else next.add(campaign.id);
                      return next;
                    })}
                    className="text-textlight hover:text-textdark transition-colors"
                  >
                    <svg className={`w-4 h-4 transition-transform ${isCollapsed ? '' : 'rotate-90'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </button>

                  {editingCampaign?.id === campaign.id ? (
                    <input
                      autoFocus
                      type="text"
                      value={editingCampaign.name}
                      onChange={(e) => setEditingCampaign({ ...editingCampaign, name: e.target.value })}
                      onBlur={() => handleRenameCampaign(campaign.id, editingCampaign.name)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleRenameCampaign(campaign.id, editingCampaign.name); if (e.key === 'Escape') setEditingCampaign(null); }}
                      className="input-apple text-[13px] font-semibold py-1 px-2 -ml-2 flex-1"
                    />
                  ) : (
                    <h4
                      className="text-[13px] font-semibold text-textdark flex-1 cursor-pointer hover:text-navy transition-colors"
                      onClick={() => setEditingCampaign({ id: campaign.id, name: campaign.name })}
                      title="Click to rename"
                    >
                      {campaign.name}
                    </h4>
                  )}

                  <span className="text-[10px] text-textlight bg-black/5 px-2 py-0.5 rounded-full">
                    {campaignAdSets.length} ad set{campaignAdSets.length !== 1 ? 's' : ''} · {totalAds} ad{totalAds !== 1 ? 's' : ''}
                  </span>

                  <button
                    onClick={() => { setAddingAdSetFor(campaign.id); setNewAdSetName(''); }}
                    className="text-[10px] px-2 py-1 rounded-lg bg-white border border-gray-200 text-textmid hover:bg-gray-50 transition-colors"
                  >
                    + Ad Set
                  </button>

                  <button
                    onClick={() => handleDeleteCampaign(campaign.id)}
                    className="p-1 rounded-lg hover:bg-red-50 text-textlight hover:text-red-500 transition-colors"
                    title="Delete campaign"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                </div>

                {/* Campaign body */}
                {!isCollapsed && (
                  <div className="p-4 space-y-3">
                    {/* Add ad set form */}
                    {addingAdSetFor === campaign.id && (
                      <div className="flex items-center gap-2 mb-2 fade-in">
                        <input
                          ref={adSetInputRef}
                          type="text"
                          value={newAdSetName}
                          onChange={(e) => setNewAdSetName(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') handleCreateAdSet(campaign.id); if (e.key === 'Escape') { setAddingAdSetFor(null); setNewAdSetName(''); } }}
                          placeholder="Ad set name..."
                          className="input-apple text-[12px] flex-1"
                        />
                        <button onClick={() => handleCreateAdSet(campaign.id)} className="btn-primary text-[10px] px-3 py-1.5">
                          Add
                        </button>
                        <button onClick={() => { setAddingAdSetFor(null); setNewAdSetName(''); }} className="text-[10px] text-textlight hover:text-textmid px-1">
                          Cancel
                        </button>
                      </div>
                    )}

                    {/* Ad sets */}
                    {campaignAdSets.length === 0 && addingAdSetFor !== campaign.id && (
                      <p className="text-[11px] text-textlight py-3 text-center">
                        No ad sets yet. Click "+ Ad Set" to create one.
                      </p>
                    )}

                    {campaignAdSets.map(adSet => {
                      const deps = getAdSetDeps(adSet.id);
                      const adSetFlexList = getAdSetFlexAds(adSet.id);
                      const flexChildIds = new Set(adSetFlexList.flatMap(f => JSON.parse(f.child_deployment_ids || '[]')));
                      const standaloneDeps = deps.filter(d => !flexChildIds.has(d.id));
                      const isDropHover = dropTarget === adSet.id;
                      const selCount = selectedInAdSet[adSet.id]?.size || 0;

                      return (
                        <div
                          key={adSet.id}
                          onDragOver={(e) => handleDragOver(e, adSet.id)}
                          onDragLeave={handleDragLeave}
                          onDrop={(e) => handleDrop(e, campaign.id, adSet.id)}
                          className={`rounded-xl border-2 border-dashed transition-all ${
                            isDropHover
                              ? 'border-gold bg-gold/5 shadow-sm'
                              : 'border-gray-200 bg-white'
                          }`}
                        >
                          {/* Ad set header */}
                          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-gray-100">
                            {/* Select All checkbox */}
                            {(standaloneDeps.length > 0 || adSetFlexList.length > 0) && (
                              <button
                                onClick={() => toggleSelectAllInAdSet(adSet.id, standaloneDeps, adSetFlexList)}
                                className={`w-[14px] h-[14px] rounded flex-shrink-0 flex items-center justify-center transition-colors ${
                                  selCount === (standaloneDeps.length + adSetFlexList.length) && (standaloneDeps.length + adSetFlexList.length) > 0
                                    ? 'bg-navy'
                                    : selCount > 0
                                      ? 'bg-navy/50'
                                      : 'border-[1.5px] border-textlight/60 hover:border-navy/40'
                                }`}
                              >
                                {selCount > 0 && (
                                  <svg className="w-2 h-2 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d={
                                      selCount === (standaloneDeps.length + adSetFlexList.length) ? "M5 13l4 4L19 7" : "M5 12h14"
                                    } />
                                  </svg>
                                )}
                              </button>
                            )}

                            {editingAdSet?.id === adSet.id ? (
                              <input
                                autoFocus
                                type="text"
                                value={editingAdSet.name}
                                onChange={(e) => setEditingAdSet({ ...editingAdSet, name: e.target.value })}
                                onBlur={() => handleRenameAdSet(adSet.id, editingAdSet.name)}
                                onKeyDown={(e) => { if (e.key === 'Enter') handleRenameAdSet(adSet.id, editingAdSet.name); if (e.key === 'Escape') setEditingAdSet(null); }}
                                className="input-apple text-[12px] font-medium py-0.5 px-1.5 -ml-1.5 flex-1"
                              />
                            ) : (
                              <span
                                className="text-[12px] font-medium text-textdark flex-1 cursor-pointer hover:text-navy transition-colors"
                                onClick={() => setEditingAdSet({ id: adSet.id, name: adSet.name })}
                                title="Click to rename"
                              >
                                {adSet.name}
                              </span>
                            )}

                            {/* Bulk actions when ads selected */}
                            {selCount >= 1 && (
                              <div className="flex items-center gap-1.5">
                                <span className="text-[10px] text-navy font-medium">{selCount} selected</span>
                                {selCount >= 2 && (
                                  <button
                                    onClick={() => handleCombineIntoFlex(adSet.id)}
                                    className="text-[10px] px-2 py-1 rounded-lg bg-navy text-white hover:bg-navy-light transition-colors inline-flex items-center gap-1"
                                  >
                                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2z" />
                                    </svg>
                                    Flex
                                  </button>
                                )}
                                <button
                                  onClick={() => {
                                    const depId = [...(selectedInAdSet[adSet.id] || [])][0];
                                    const dep = deployments.find(d => d.id === depId);
                                    if (dep) openSidebar({ type: 'single', deployment: dep, ad: dep.ad });
                                  }}
                                  className="text-[10px] px-2 py-1 rounded-lg bg-white border border-gray-200 text-textmid hover:bg-gray-50 transition-colors"
                                >
                                  Edit
                                </button>
                                <button
                                  onClick={() => handleUnassign([...(selectedInAdSet[adSet.id] || [])])}
                                  className="text-[10px] px-2 py-1 rounded-lg bg-white border border-gray-200 text-textmid hover:bg-gray-50 transition-colors"
                                >
                                  Unplan
                                </button>
                                <button
                                  onClick={() => setDeleteConfirm({ open: true, ids: [...(selectedInAdSet[adSet.id] || [])], source: 'adset' })}
                                  className="text-[10px] px-2 py-1 rounded-lg bg-red-50 border border-red-200 text-red-600 hover:bg-red-100 transition-colors"
                                >
                                  Delete
                                </button>
                              </div>
                            )}

                            <span className="text-[10px] text-textlight">{deps.length} ad{deps.length !== 1 ? 's' : ''}</span>
                            <button
                              onClick={() => handleDeleteAdSet(adSet.id)}
                              className="p-1 rounded hover:bg-red-50 text-textlight hover:text-red-500 transition-colors"
                              title="Delete ad set"
                            >
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                            </button>
                          </div>

                          {/* Ad set body — drop zone */}
                          <div className="p-3 min-h-[60px]">
                            {deps.length === 0 && adSetFlexList.length === 0 ? (
                              <div className={`py-4 text-center rounded-lg transition-colors ${
                                isDropHover ? 'bg-gold/10' : ''
                              }`}>
                                <p className="text-[11px] text-textlight">
                                  {isDropHover ? 'Drop ads here' : 'Drag ads from Unplanned to assign'}
                                </p>
                              </div>
                            ) : (
                              <div className="space-y-1.5">
                                {/* Flex ads */}
                                {adSetFlexList.map(flexAd => renderFlexAdCard(flexAd, { adsetId: adSet.id }))}
                                {/* Standalone (non-flex) deployments */}
                                {standaloneDeps.map(dep => renderDepCard(dep, { isDraggable: true, inAdSet: true, adsetId: adSet.id }))}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ═══════════ Detail Sidebar ═══════════ */}
      {renderSidebar()}

      {/* ═══════════ Delete Confirmation Modal ═══════════ */}
      {deleteConfirm.open && (
        <>
          <div className="fixed inset-0 bg-black/30 z-50" onClick={() => setDeleteConfirm({ open: false, ids: [], source: 'unplanned' })} />
          <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
            <div className="bg-white rounded-2xl shadow-xl p-6 max-w-sm w-full mx-4 pointer-events-auto">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 rounded-xl bg-red-50 flex items-center justify-center flex-shrink-0">
                  <svg className="w-5 h-5 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                  </svg>
                </div>
                <h3 className="text-[15px] font-semibold text-textdark">
                  Delete {deleteConfirm.ids.length} ad{deleteConfirm.ids.length !== 1 ? 's' : ''} from tracker?
                </h3>
              </div>
              <p className="text-[12px] text-textmid mb-5 ml-[52px]">
                This will remove the selected ads from the Performance Tracker. The original ad creatives will remain in Ad Studio.
              </p>
              <div className="flex items-center justify-end gap-2">
                <button
                  onClick={() => setDeleteConfirm({ open: false, ids: [], source: 'unplanned' })}
                  className="text-[12px] px-4 py-2 rounded-xl bg-white border border-gray-200 text-textmid hover:bg-gray-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleConfirmDelete}
                  className="text-[12px] px-4 py-2 rounded-xl bg-red-500 text-white hover:bg-red-600 transition-colors"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* ═══════════ Image Preview Lightbox ═══════════ */}
      {previewImage && (
        <>
          <div className="fixed inset-0 bg-black/70 z-50" onClick={() => setPreviewImage(null)} />
          <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
            <div className="relative pointer-events-auto">
              <img
                src={previewImage}
                alt=""
                className="max-h-[85vh] max-w-[90vw] rounded-xl shadow-2xl object-contain"
              />
              <button
                onClick={() => setPreviewImage(null)}
                className="absolute top-3 right-3 p-1.5 rounded-xl bg-black/50 text-white hover:bg-black/70 transition-colors"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

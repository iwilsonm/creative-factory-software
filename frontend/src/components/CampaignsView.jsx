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

  // Campaign/Ad Set delete confirmation
  const [entityDeleteConfirm, setEntityDeleteConfirm] = useState(null); // { type: 'campaign'|'adset', id, name }

  // Flex ad action confirmation: { id: flexAdId, action: 'ungroup'|'unplan'|'remove' } or null
  const [flexActionConfirm, setFlexActionConfirm] = useState(null);

  // Image preview lightbox (for flex ad thumbnails)
  const [previewImage, setPreviewImage] = useState(null);

  // Detail sidebar
  const [sidebarData, setSidebarData] = useState(null);
  const [sidebarForm, setSidebarForm] = useState({
    ad_name: '', destination_urls: [''], cta_button: 'LEARN_MORE', primary_texts: [], ad_headlines: [], planned_date: '',
  });
  const [duplicateConfirm, setDuplicateConfirm] = useState(null); // { urls: string[] } when pending
  const [generatingPrimaryText, setGeneratingPrimaryText] = useState(false);
  const [generatingHeadlines, setGeneratingHeadlines] = useState(false);
  const [primaryTextDirection, setPrimaryTextDirection] = useState('');
  const [primaryTextThread, setPrimaryTextThread] = useState([]); // conversation history for iterative refinement
  const [primaryTextDirectionHistory, setPrimaryTextDirectionHistory] = useState([]); // past creative directions
  const [headlineDirection, setHeadlineDirection] = useState('');
  const [headlineThread, setHeadlineThread] = useState([]); // conversation history for headline refinement
  const [headlineDirectionHistory, setHeadlineDirectionHistory] = useState([]); // past headline directions
  const [sidebarSaving, setSidebarSaving] = useState(false);
  const [primaryTextOpen, setPrimaryTextOpen] = useState(false);
  const [headlinesOpen, setHeadlinesOpen] = useState(false);
  const [expandedFlexChild, setExpandedFlexChild] = useState(null);

  const sidebarInitialFormRef = useRef(null);
  const autosaveTimerRef = useRef(null);
  const lastAutosavedRef = useRef(null); // JSON string of last autosaved { primary_texts, ad_headlines }
  const campaignInputRef = useRef(null);
  const adSetInputRef = useRef(null);
  const assignDropdownRef = useRef(null);

  useEffect(() => {
    loadCampaignData();
  }, [projectId]);

  // ─── Autosave primary texts & headlines every 10 seconds ──────────────
  useEffect(() => {
    if (!sidebarData) {
      lastAutosavedRef.current = null;
      return;
    }
    autosaveTimerRef.current = setInterval(async () => {
      const snapshot = JSON.stringify({
        primary_texts: sidebarForm.primary_texts,
        ad_headlines: sidebarForm.ad_headlines,
      });
      // Skip if nothing changed since last autosave
      if (snapshot === lastAutosavedRef.current) return;
      // Skip if both are empty (nothing to save)
      if (sidebarForm.primary_texts.filter(t => t.trim()).length === 0 &&
          sidebarForm.ad_headlines.filter(h => h.trim()).length === 0) return;
      lastAutosavedRef.current = snapshot;
      try {
        if (sidebarData.type === 'single') {
          await api.updateDeployment(sidebarData.deployment.id, {
            primary_texts: JSON.stringify(sidebarForm.primary_texts),
            ad_headlines: JSON.stringify(sidebarForm.ad_headlines),
          });
        } else {
          await api.updateFlexAd(sidebarData.flexAd.id, {
            primary_texts: JSON.stringify(sidebarForm.primary_texts),
            headlines: JSON.stringify(sidebarForm.ad_headlines),
          });
        }
      } catch { /* Silent — don't interrupt user with errors */ }
    }, 10000);
    return () => clearInterval(autosaveTimerRef.current);
  }, [sidebarData, sidebarForm.primary_texts, sidebarForm.ad_headlines]);

  const loadCampaignData = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [campData, flexData] = await Promise.all([
        api.getCampaigns(projectId),
        api.getFlexAds(projectId),
      ]);
      setCampaigns(campData.campaigns || []);
      setAdSets(campData.adSets || []);
      setFlexAds(flexData.flexAds || []);
    } catch { /* ignore */ }
    if (!silent) setLoading(false);
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
      await loadCampaignData(true);
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
      await loadCampaignData(true);
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
      await loadCampaignData(true);
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
      await loadCampaignData(true);
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
      ids.includes(d.id) ? { ...d, local_campaign_id: campaignId, local_adset_id: adsetId, flex_ad_id: '' } : d
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
      // Backend uses allSettled + retry, so this only fires on total failure
      addToast('Failed to assign ads — retrying...', 'error');
      try { await api.assignToAdSet(ids, campaignId, adsetId); } catch { loadDeployments(); }
    }
  };

  const handleUnassign = async (ids) => {
    // Separate flex ad IDs from standalone deployment IDs
    const flexAdIds = ids.filter(id => flexAds.some(f => f.id === id));
    const standaloneDepIds = ids.filter(id => deployments.some(d => d.id === id));

    // For flex ads: collect their child deployment IDs, then delete the flex ad
    const flexChildDepIds = [];
    for (const flexId of flexAdIds) {
      const flex = flexAds.find(f => f.id === flexId);
      if (flex) {
        try { const childIds = JSON.parse(flex.child_deployment_ids || '[]'); flexChildDepIds.push(...childIds); } catch { /* ignore */ }
      }
    }

    // All deployment IDs to unassign: standalone + flex children
    const allDepIds = [...new Set([...standaloneDepIds, ...flexChildDepIds])];

    // Optimistic update for deployments
    if (allDepIds.length > 0) {
      setDeployments(prev => prev.map(d =>
        allDepIds.includes(d.id) ? { ...d, local_campaign_id: 'unplanned', local_adset_id: '', flex_ad_id: '' } : d
      ));
    }
    // Optimistic update for flex ads (remove dissolved ones)
    if (flexAdIds.length > 0) {
      setFlexAds(prev => prev.filter(f => !flexAdIds.includes(f.id)));
    }

    try {
      // Delete flex ads first (dissolves the grouping)
      await Promise.all(flexAdIds.map(id => api.deleteFlexAd(id)));
      // Then unassign all deployment IDs
      if (allDepIds.length > 0) {
        await api.unassignFromAdSet(allDepIds);
      }
      // Only refresh campaign data — deployment state is already correct from optimistic update
      await loadCampaignData(true);
      addToast(`Moved ${allDepIds.length} ad${allDepIds.length !== 1 ? 's' : ''} to unplanned`, 'success');
    } catch {
      addToast('Failed to unassign', 'error');
      // Revert on error: reload everything
      await Promise.all([loadCampaignData(true), loadDeployments()]);
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
      ids.includes(d.id) ? { ...d, local_campaign_id: 'unplanned', local_adset_id: '', flex_ad_id: '' } : d
    ));
    dragIdsRef.current = null;
    setDragVisual(null);

    try {
      await api.unassignFromAdSet(ids);
    } catch {
      addToast('Failed to move to unplanned — retrying...', 'error');
      try { await api.unassignFromAdSet(ids); } catch { loadDeployments(); }
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

    // Separate selected IDs into standalone deployment IDs and flex ad IDs
    const standaloneDepIds = selected.filter(id => deployments.some(d => d.id === id));
    const selectedFlexIds = selected.filter(id => flexAds.some(f => f.id === id));

    // Resolve flex ad IDs to their child deployment IDs
    const resolvedChildIds = [];
    for (const fid of selectedFlexIds) {
      const flex = flexAds.find(f => f.id === fid);
      if (flex) {
        try { resolvedChildIds.push(...JSON.parse(flex.child_deployment_ids || '[]')); } catch { /* ignore */ }
      }
    }

    // All deployment IDs for the new flex: standalone + children from old flex ads
    const allDepIds = [...new Set([...standaloneDepIds, ...resolvedChildIds])];
    if (allDepIds.length < 2) {
      addToast('Need at least 2 ads to create a Flex', 'info');
      return;
    }

    const name = `Flex Ad (${allDepIds.length} images)`;
    try {
      // Delete old flex ads first (dissolve them)
      if (selectedFlexIds.length > 0) {
        await Promise.all(selectedFlexIds.map(id => api.deleteFlexAd(id)));
      }
      await api.createFlexAd(projectId, adSetId, name, allDepIds);
      setSelectedInAdSet(prev => ({ ...prev, [adSetId]: new Set() }));
      // Refresh both — flex ads are created server-side, need to fetch new IDs
      await Promise.all([loadCampaignData(true), loadDeployments()]);
      addToast('Flex ad created', 'success');
    } catch {
      addToast('Failed to create flex ad', 'error');
      await Promise.all([loadCampaignData(true), loadDeployments()]);
    }
  };

  const handleFlexAction = async (flexAdId, action) => {
    const flex = flexAds.find(f => f.id === flexAdId);
    let childIds = [];
    if (flex) {
      try { childIds = JSON.parse(flex.child_deployment_ids || '[]'); } catch { /* ignore */ }
    }
    setFlexActionConfirm(null);

    if (action === 'ungroup') {
      // Only affect children that actually belong to this flex ad
      const ownedChildIds = childIds.filter(id => {
        const dep = deployments.find(d => d.id === id);
        return dep && dep.flex_ad_id === flexAdId;
      });
      // Optimistic: remove flex ad, clear flex_ad_id on owned children (children stay in ad set)
      setFlexAds(prev => prev.filter(f => f.id !== flexAdId));
      if (ownedChildIds.length > 0) {
        setDeployments(prev => prev.map(d =>
          ownedChildIds.includes(d.id) ? { ...d, flex_ad_id: '' } : d
        ));
      }
      try {
        await api.deleteFlexAd(flexAdId);
        await loadCampaignData(true);
        addToast('Flex ad ungrouped', 'success');
      } catch {
        addToast('Failed to ungroup flex ad', 'error');
        await Promise.all([loadCampaignData(true), loadDeployments()]);
      }
    } else if (action === 'unplan') {
      // Only affect children that actually belong to this flex ad
      const ownedChildIds = childIds.filter(id => {
        const dep = deployments.find(d => d.id === id);
        return dep && dep.flex_ad_id === flexAdId;
      });
      // Optimistic: remove flex ad, move owned children to unplanned
      setFlexAds(prev => prev.filter(f => f.id !== flexAdId));
      if (ownedChildIds.length > 0) {
        setDeployments(prev => prev.map(d =>
          ownedChildIds.includes(d.id) ? { ...d, local_campaign_id: 'unplanned', local_adset_id: '', flex_ad_id: '' } : d
        ));
      }
      try {
        await api.deleteFlexAd(flexAdId);
        if (ownedChildIds.length > 0) {
          await api.unassignFromAdSet(ownedChildIds);
        }
        await loadCampaignData(true);
        addToast(`Moved ${ownedChildIds.length} ad${ownedChildIds.length !== 1 ? 's' : ''} to unplanned`, 'success');
      } catch {
        addToast('Failed to move to unplanned', 'error');
        await Promise.all([loadCampaignData(true), loadDeployments()]);
      }
    } else if (action === 'remove') {
      // Only delete child deployments that actually belong to this flex ad
      const ownedChildIds = childIds.filter(id => {
        const dep = deployments.find(d => d.id === id);
        return dep && dep.flex_ad_id === flexAdId;
      });
      // Optimistic: remove flex ad + delete owned child deployments
      setFlexAds(prev => prev.filter(f => f.id !== flexAdId));
      if (ownedChildIds.length > 0) {
        setDeployments(prev => prev.filter(d => !ownedChildIds.includes(d.id)));
      }
      try {
        await api.deleteFlexAd(flexAdId);
        await Promise.all(ownedChildIds.map(id => api.deleteDeployment(id)));
        await loadCampaignData(true);
        addToast(`Removed ${ownedChildIds.length} ad${ownedChildIds.length !== 1 ? 's' : ''} from planner`, 'success', 8000, {
          label: 'Undo',
          onClick: async () => {
            try {
              await api.restoreFlexAd(flexAdId);
              await Promise.all(ownedChildIds.map(id => api.restoreDeployment(id)));
              await Promise.all([loadCampaignData(true), loadDeployments()]);
              addToast('Restored flex ad', 'success');
            } catch { addToast('Failed to restore', 'error'); }
          },
        });
      } catch {
        addToast('Failed to remove from planner', 'error');
        await Promise.all([loadCampaignData(true), loadDeployments()]);
      }
    }
  };

  // ─── Sidebar ────────────────────────────────────────────────────────────
  const openSidebar = (data) => {
    setSidebarData(data);
    setPrimaryTextOpen(false);
    setHeadlinesOpen(false);
    setExpandedFlexChild(null);
    setPrimaryTextThread([]); // Fresh conversation for each sidebar open
    setPrimaryTextDirection('');
    setPrimaryTextDirectionHistory([]);
    setHeadlineDirection('');
    setHeadlineThread([]);
    setHeadlineDirectionHistory([]);
    let form;
    if (data.type === 'single') {
      const dep = data.deployment;
      const url = dep.destination_url || dep.landing_page_url || '';
      form = {
        ad_name: dep.ad_name || dep.ad?.headline || dep.ad?.angle || '',
        destination_urls: url ? [url] : [''],
        cta_button: dep.cta_button || 'LEARN_MORE',
        primary_texts: (() => { try { return dep.primary_texts ? JSON.parse(dep.primary_texts) : []; } catch { return []; } })(),
        ad_headlines: (() => { try { return dep.ad_headlines ? JSON.parse(dep.ad_headlines) : []; } catch { return []; } })(),
        planned_date: dep.planned_date || '',
      };
    } else {
      const flex = data.flexAd;
      const url = flex.destination_url || '';
      form = {
        ad_name: flex.name || '',
        destination_urls: url ? [url] : [''],
        cta_button: flex.cta_button || 'LEARN_MORE',
        primary_texts: (() => { try { return flex.primary_texts ? JSON.parse(flex.primary_texts) : []; } catch { return []; } })(),
        ad_headlines: (() => { try { return flex.headlines ? JSON.parse(flex.headlines) : []; } catch { return []; } })(),
        planned_date: flex.planned_date || '',
      };
    }
    setSidebarForm(form);
    sidebarInitialFormRef.current = JSON.stringify(form);
    // Seed autosave ref so existing data doesn't trigger an immediate save
    lastAutosavedRef.current = JSON.stringify({
      primary_texts: form.primary_texts,
      ad_headlines: form.ad_headlines,
    });
  };

  const closeSidebar = () => {
    // Check for unsaved changes
    if (sidebarInitialFormRef.current && JSON.stringify(sidebarForm) !== sidebarInitialFormRef.current) {
      if (!window.confirm('You have unsaved changes. Discard them?')) return;
    }
    setSidebarData(null);
    setDuplicateConfirm(null);
    sidebarInitialFormRef.current = null;
  };

  // Lock body scroll when sidebar or lightbox is open
  useEffect(() => {
    if (sidebarData || previewImage) {
      document.body.style.overflow = 'hidden';
      return () => { document.body.style.overflow = ''; };
    }
  }, [sidebarData, previewImage]);

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
    setPrimaryTextOpen(true); // Auto-expand so user can see results
    try {
      const depId = sidebarData.type === 'single'
        ? sidebarData.deployment.id
        : sidebarData.deps[0]?.id;
      const flexAdId = sidebarData.type === 'flex' ? sidebarData.flexAd.id : undefined;
      const direction = primaryTextDirection.trim() || undefined;
      const result = await api.generatePrimaryText(depId, flexAdId, direction, primaryTextThread);
      setSidebarForm(prev => ({ ...prev, primary_texts: result.primary_texts || [] }));
      setPrimaryTextThread(result.messages || []);
      // Save direction to history before clearing
      if (direction) {
        setPrimaryTextDirectionHistory(prev => [...prev, direction]);
      }
      setPrimaryTextDirection(''); // Clear direction — it's been "sent"
      const round = Math.floor(((result.messages || []).length) / 2);
      if (round <= 1) {
        addToast('Primary text generated — type more direction below to refine', 'success');
      } else {
        addToast(`Round ${round} complete — keep refining or save`, 'success');
      }
    } catch {
      addToast('Failed to generate primary text', 'error');
    }
    setGeneratingPrimaryText(false);
  };

  const handleGenerateHeadlines = async () => {
    setGeneratingHeadlines(true);
    setHeadlinesOpen(true); // Auto-expand so user can see results
    try {
      const depId = sidebarData.type === 'single'
        ? sidebarData.deployment.id
        : sidebarData.deps[0]?.id;
      const flexAdId = sidebarData.type === 'flex' ? sidebarData.flexAd.id : undefined;
      const direction = headlineDirection.trim() || undefined;
      const result = await api.generateAdHeadlines(depId, sidebarForm.primary_texts, flexAdId, direction, headlineThread);
      setSidebarForm(prev => ({ ...prev, ad_headlines: result.headlines || [] }));
      setHeadlineThread(result.messages || []);
      // Save direction to history before clearing
      if (direction) {
        setHeadlineDirectionHistory(prev => [...prev, direction]);
      }
      setHeadlineDirection('');
      const round = Math.floor(((result.messages || []).length) / 2);
      if (round <= 1) {
        addToast('Headlines generated — type direction below to refine', 'success');
      } else {
        addToast(`Headline round ${round} complete — keep refining or save`, 'success');
      }
    } catch {
      addToast('Failed to generate headlines', 'error');
    }
    setGeneratingHeadlines(false);
  };

  const handleSaveSidebar = async () => {
    // Check for multiple URLs — show confirmation dialog
    const urls = sidebarForm.destination_urls.filter(u => u.trim());
    if (urls.length > 1 && !duplicateConfirm) {
      setDuplicateConfirm({ urls });
      return;
    }
    setDuplicateConfirm(null);
    setSidebarSaving(true);

    try {
      const primaryUrl = urls[0] || '';
      const extraUrls = urls.slice(1);

      if (sidebarData.type === 'single') {
        // Save the first URL to the existing deployment
        await api.updateDeployment(sidebarData.deployment.id, {
          ad_name: sidebarForm.ad_name,
          primary_texts: JSON.stringify(sidebarForm.primary_texts),
          ad_headlines: JSON.stringify(sidebarForm.ad_headlines),
          destination_url: primaryUrl,
          cta_button: sidebarForm.cta_button,
          planned_date: sidebarForm.planned_date || null,
        });

        // Duplicate for each additional URL
        for (const url of extraUrls) {
          await api.duplicateDeployment(sidebarData.deployment.id, {
            ad_name: sidebarForm.ad_name,
            destination_url: url,
            cta_button: sidebarForm.cta_button,
            primary_texts: JSON.stringify(sidebarForm.primary_texts),
            ad_headlines: JSON.stringify(sidebarForm.ad_headlines),
            planned_date: sidebarForm.planned_date || null,
          });
        }
      } else {
        // Flex ad — save first URL to existing flex ad
        await api.updateFlexAd(sidebarData.flexAd.id, {
          name: sidebarForm.ad_name,
          primary_texts: JSON.stringify(sidebarForm.primary_texts),
          headlines: JSON.stringify(sidebarForm.ad_headlines),
          destination_url: primaryUrl,
          cta_button: sidebarForm.cta_button,
          planned_date: sidebarForm.planned_date || null,
        });

        // For each extra URL: duplicate all child deployments, then create a new flex ad
        const childDeps = sidebarData.deps || [];
        for (const url of extraUrls) {
          const newChildIds = [];
          for (const child of childDeps) {
            const result = await api.duplicateDeployment(child.id, {
              ad_name: child.ad_name || sidebarForm.ad_name,
              destination_url: url,
              cta_button: sidebarForm.cta_button,
              primary_texts: JSON.stringify(sidebarForm.primary_texts),
              ad_headlines: JSON.stringify(sidebarForm.ad_headlines),
              planned_date: sidebarForm.planned_date || null,
            });
            if (result?.id) newChildIds.push(result.id);
          }
          // Create a new flex ad grouping the duplicated deployments
          if (newChildIds.length > 0) {
            const flexAd = sidebarData.flexAd;
            await api.createFlexAd(
              flexAd.project_id,
              flexAd.ad_set_id,
              (sidebarForm.ad_name || flexAd.name || 'Flex Ad') + ` (${url.replace(/^https?:\/\//, '').slice(0, 30)})`,
              newChildIds,
            );
          }
        }
      }

      await Promise.all([loadDeployments(), loadCampaignData(true)]);
      if (extraUrls.length > 0) {
        addToast(`Saved + created ${extraUrls.length} duplicate${extraUrls.length > 1 ? 's' : ''} with different URL${extraUrls.length > 1 ? 's' : ''}`, 'success');
      } else {
        addToast('Saved', 'success');
      }

      // Reset URLs back to just the primary after save
      setSidebarForm(prev => ({ ...prev, destination_urls: [primaryUrl || ''] }));
      sidebarInitialFormRef.current = JSON.stringify({ ...sidebarForm, destination_urls: [primaryUrl || ''] });
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
      addToast(`${ids.length} removed from tracker`, 'success', 8000, {
        label: 'Undo',
        onClick: async () => {
          try {
            await Promise.all(ids.map(id => api.restoreDeployment(id)));
            await loadDeployments();
            addToast(`Restored ${ids.length} deployment${ids.length !== 1 ? 's' : ''}`, 'success');
          } catch { addToast('Failed to restore', 'error'); }
        },
      });
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

    // Optimistic — also clear flex_ad_id for consistency
    setDeployments(prev => prev.map(d =>
      ids.includes(d.id) ? { ...d, local_campaign_id: campaignId, local_adset_id: adsetId, flex_ad_id: '' } : d
    ));
    setSelectedUnplanned(new Set());

    try {
      await api.assignToAdSet(ids, campaignId, adsetId);
      addToast(`Assigned ${ids.length} ad${ids.length > 1 ? 's' : ''} to ad set`, 'success');
    } catch {
      // Backend uses allSettled + retry, so this only fires if the entire request fails
      addToast('Failed to assign ads — retrying...', 'error');
      // Don't revert optimistic state — retry in background
      try { await api.assignToAdSet(ids, campaignId, adsetId); } catch { loadDeployments(); }
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
    let childIds = [];
    try { childIds = JSON.parse(flexAd.child_deployment_ids || '[]'); } catch { /* ignore */ }
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

        {/* Hover actions / Confirmation */}
        {flexActionConfirm?.id === flexAd.id ? (
          <div className="flex items-center gap-1 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
            <span className="text-[10px] text-textmid">
              {flexActionConfirm.action === 'ungroup' ? 'Ungroup?' : flexActionConfirm.action === 'unplan' ? 'Move to unplanned?' : 'Remove from planner?'}
            </span>
            <button
              onClick={() => handleFlexAction(flexAd.id, flexActionConfirm.action)}
              className={`text-[10px] px-1.5 py-0.5 rounded text-white transition-colors ${
                flexActionConfirm.action === 'remove' ? 'bg-red-500 hover:bg-red-600' : 'bg-navy hover:bg-navy-light'
              }`}
            >
              Confirm
            </button>
            <button
              onClick={() => setFlexActionConfirm(null)}
              className="text-[10px] px-1.5 py-0.5 rounded text-textmid hover:bg-gray-100 transition-colors"
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="opacity-0 group-hover:opacity-100 flex items-center gap-1 flex-shrink-0 transition-opacity">
            {/* Ungroup */}
            <button
              onClick={(e) => { e.stopPropagation(); setFlexActionConfirm({ id: flexAd.id, action: 'ungroup' }); }}
              className="p-1 rounded-lg hover:bg-navy/10 text-textlight hover:text-navy transition-colors"
              title="Ungroup"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
              </svg>
            </button>
            {/* Move to unplanned */}
            <button
              onClick={(e) => { e.stopPropagation(); setFlexActionConfirm({ id: flexAd.id, action: 'unplan' }); }}
              className="p-1 rounded-lg hover:bg-gold/10 text-textlight hover:text-gold transition-colors"
              title="Move to unplanned"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
              </svg>
            </button>
            {/* Remove from planner */}
            <button
              onClick={(e) => { e.stopPropagation(); setFlexActionConfirm({ id: flexAd.id, action: 'remove' }); }}
              className="p-1 rounded-lg hover:bg-red-50 text-textlight hover:text-red-500 transition-colors"
              title="Remove from planner"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </button>
          </div>
        )}
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
        <div className="fixed right-0 top-0 h-full w-[420px] bg-white shadow-xl z-50 overflow-y-auto overscroll-contain animate-slide-in-right scrollbar-thin">
          {/* Header */}
          <div className="sticky top-0 bg-white border-b border-gray-100 px-5 py-4 flex items-center justify-between z-10">
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
                      className="rounded-xl border border-gray-200 overflow-hidden"
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
              <div
                onClick={() => setPrimaryTextOpen(!primaryTextOpen)}
                className="w-full flex items-center justify-between px-4 py-3 bg-offwhite hover:bg-gray-100 transition-colors cursor-pointer select-none"
              >
                <div className="flex items-center gap-2">
                  <svg className={`w-3.5 h-3.5 text-textmid transition-transform ${primaryTextOpen ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                  <span className="text-[11px] font-semibold text-textdark uppercase tracking-wider">Primary Text</span>
                  {primaryTextThread.length > 2 && (
                    <span className="text-[9px] text-gold font-medium bg-gold/10 px-1.5 py-0.5 rounded-full">
                      Round {Math.floor(primaryTextThread.length / 2)}
                    </span>
                  )}
                  <span className="text-[10px] text-textlight bg-black/5 px-1.5 py-0.5 rounded-full">
                    {sidebarForm.primary_texts.filter(t => t.trim()).length}/5
                  </span>
                </div>
              </div>
              {primaryTextOpen && (
                <div className="p-4 space-y-3">
                  {/* Creative direction input + Generate button */}
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-[10px] font-medium text-textlight uppercase tracking-wider">
                        Creative Direction <span className="normal-case font-normal">(optional)</span>
                      </label>
                      {primaryTextThread.length > 0 && !generatingPrimaryText && (
                        <button
                          onClick={() => { setPrimaryTextThread([]); setPrimaryTextDirection(''); setPrimaryTextDirectionHistory([]); }}
                          className="text-[9px] text-textlight hover:text-navy underline transition-colors"
                        >
                          Start over
                        </button>
                      )}
                    </div>
                    <textarea
                      value={primaryTextDirection}
                      onChange={(e) => setPrimaryTextDirection(e.target.value)}
                      className="input-apple text-[12px] w-full"
                      rows={2}
                      placeholder={primaryTextThread.length > 0
                        ? 'e.g. "Make them shorter and punchier" or "Focus more on the skeptic angle"'
                        : 'e.g. "Hook about how I thought grounding was a scam, then explain why it often is — click to learn why. Keep it short."'}
                    />
                    <p className="text-[9px] text-textlight mt-1">
                      {primaryTextThread.length > 0
                        ? 'Each prompt builds on the last — tell Claude what to adjust and it\'ll refine the variations.'
                        : 'Optional — leave blank to auto-generate, or describe the tone, hook, angle, or structure you want.'}
                    </p>
                    {/https?:\/\/[^\s"'<>]+/i.test(primaryTextDirection) && (
                      <p className="text-[9px] text-teal mt-1 flex items-center gap-1">
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101" />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.172 13.828a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.102 1.101" />
                        </svg>
                        Link detected — page content will be fetched and included as context.
                      </p>
                    )}
                    {/* Direction history */}
                    {primaryTextDirectionHistory.length > 0 && (
                      <div className="mt-2 space-y-1">
                        <p className="text-[9px] text-textlight font-medium uppercase tracking-wider">Previous directions</p>
                        {primaryTextDirectionHistory.map((d, i) => (
                          <div key={i} className="flex items-start gap-1.5 text-[10px] text-textmid bg-navy/5 rounded-lg px-2.5 py-1.5">
                            <span className="text-textlight font-medium flex-shrink-0">{i + 1}.</span>
                            <span className="break-words">{d}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {/* Generate / Refine button */}
                    <button
                      onClick={handleGeneratePrimaryText}
                      disabled={generatingPrimaryText}
                      className="mt-2 w-full py-2 rounded-lg bg-navy text-white hover:bg-navy-light transition-colors disabled:opacity-50 inline-flex items-center justify-center gap-1.5 text-[11px] font-medium"
                    >
                      {generatingPrimaryText ? (
                        <>
                          <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                          </svg>
                          {primaryTextThread.length > 0 ? 'Refining...' : 'Generating...'}
                        </>
                      ) : (
                        <>
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                          </svg>
                          {primaryTextThread.length > 0 ? 'Refine' : 'Generate'}
                        </>
                      )}
                    </button>
                  </div>

                  {/* Divider */}
                  {sidebarForm.primary_texts.length > 0 && <div className="border-t border-gray-100" />}

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
                  {sidebarForm.primary_texts.length === 0 && !generatingPrimaryText && (
                    <p className="text-[11px] text-textlight italic text-center py-2">No primary text yet. Click Generate above or Add Variation.</p>
                  )}
                </div>
              )}
            </div>

            {/* ─── Headlines (collapsible) ─── */}
            <div className="rounded-xl border border-gray-200 overflow-hidden">
              <div
                onClick={() => setHeadlinesOpen(!headlinesOpen)}
                className="w-full flex items-center justify-between px-4 py-3 bg-offwhite hover:bg-gray-100 transition-colors cursor-pointer select-none"
              >
                <div className="flex items-center gap-2">
                  <svg className={`w-3.5 h-3.5 text-textmid transition-transform ${headlinesOpen ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>
                  <span className="text-[11px] font-semibold text-textdark uppercase tracking-wider">Headlines</span>
                  {headlineThread.length > 2 && (
                    <span className="text-[9px] text-gold font-medium bg-gold/10 px-1.5 py-0.5 rounded-full">
                      Round {Math.floor(headlineThread.length / 2)}
                    </span>
                  )}
                  <span className="text-[10px] text-textlight bg-black/5 px-1.5 py-0.5 rounded-full">
                    {sidebarForm.ad_headlines.filter(h => h.trim()).length}/5
                  </span>
                </div>
              </div>
              {headlinesOpen && (
                <div className="p-4 space-y-3">
                  {/* Creative direction input + Generate button */}
                  <div>
                    <div className="flex items-center justify-between mb-1">
                      <label className="text-[10px] font-medium text-textlight uppercase tracking-wider">
                        Creative Direction <span className="normal-case font-normal">(optional)</span>
                      </label>
                      {headlineThread.length > 0 && !generatingHeadlines && (
                        <button
                          onClick={() => { setHeadlineThread([]); setHeadlineDirection(''); setHeadlineDirectionHistory([]); }}
                          className="text-[9px] text-textlight hover:text-navy underline transition-colors"
                        >
                          Start over
                        </button>
                      )}
                    </div>
                    <textarea
                      value={headlineDirection}
                      onChange={(e) => setHeadlineDirection(e.target.value)}
                      className="input-apple text-[12px] w-full"
                      rows={2}
                      placeholder={headlineThread.length > 0
                        ? 'e.g. "Make them more urgent" or "Include a question format"'
                        : 'e.g. "Curiosity-driven, short, punchy" or "Use numbers and stats"'}
                    />
                    <p className="text-[9px] text-textlight mt-1">
                      {headlineThread.length > 0
                        ? 'Each prompt builds on the last — tell Claude what to adjust and it\'ll refine the headlines.'
                        : sidebarForm.primary_texts.filter(t => t.trim()).length === 0
                          ? 'Generate primary text first. Headlines are based on the primary text variations.'
                          : 'Optional — leave blank to auto-generate, or describe the style and angle you want.'}
                    </p>
                    {/* Direction history */}
                    {headlineDirectionHistory.length > 0 && (
                      <div className="mt-2 space-y-1">
                        <p className="text-[9px] text-textlight font-medium uppercase tracking-wider">Previous directions</p>
                        {headlineDirectionHistory.map((d, i) => (
                          <div key={i} className="flex items-start gap-1.5 text-[10px] text-textmid bg-navy/5 rounded-lg px-2.5 py-1.5">
                            <span className="text-textlight font-medium flex-shrink-0">{i + 1}.</span>
                            <span className="break-words">{d}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    {/* Generate / Refine button */}
                    <button
                      onClick={handleGenerateHeadlines}
                      disabled={generatingHeadlines || sidebarForm.primary_texts.filter(t => t.trim()).length === 0}
                      className="mt-2 w-full py-2 rounded-lg bg-navy text-white hover:bg-navy-light transition-colors disabled:opacity-50 inline-flex items-center justify-center gap-1.5 text-[11px] font-medium"
                      title={sidebarForm.primary_texts.filter(t => t.trim()).length === 0 ? 'Generate primary text first' : ''}
                    >
                      {generatingHeadlines ? (
                        <>
                          <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                          </svg>
                          {headlineThread.length > 0 ? 'Refining...' : 'Generating...'}
                        </>
                      ) : (
                        <>
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                          </svg>
                          {headlineThread.length > 0 ? 'Refine' : 'Generate'}
                        </>
                      )}
                    </button>
                  </div>

                  {/* Divider */}
                  {sidebarForm.ad_headlines.length > 0 && <div className="border-t border-gray-100" />}

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
                  {sidebarForm.ad_headlines.length === 0 && !generatingHeadlines && (
                    <p className="text-[11px] text-textlight italic text-center py-2">
                      {sidebarForm.primary_texts.filter(t => t.trim()).length === 0
                        ? 'Generate primary text first, then generate headlines.'
                        : 'No headlines yet. Click Generate above or Add Headline.'}
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* ─── Destination URL(s) ─── */}
            <div>
              <label className="text-[11px] font-semibold text-textdark uppercase tracking-wider">
                Destination URL{sidebarForm.destination_urls.length > 1 ? 's' : ''}
              </label>
              <div className="space-y-2 mt-1.5">
                {sidebarForm.destination_urls.map((url, i) => (
                  <div key={i} className="flex items-center gap-1.5">
                    <input
                      type="url"
                      value={url}
                      onChange={(e) => {
                        const updated = [...sidebarForm.destination_urls];
                        updated[i] = e.target.value;
                        setSidebarForm(prev => ({ ...prev, destination_urls: updated }));
                      }}
                      className="input-apple text-[12px] flex-1"
                      placeholder="https://..."
                    />
                    {sidebarForm.destination_urls.length > 1 && (
                      <button
                        onClick={() => setSidebarForm(prev => ({
                          ...prev,
                          destination_urls: prev.destination_urls.filter((_, idx) => idx !== i),
                        }))}
                        className="p-1 rounded-lg text-textlight hover:text-red-500 hover:bg-red-50 transition-colors flex-shrink-0"
                        title="Remove URL"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <button
                onClick={() => setSidebarForm(prev => ({ ...prev, destination_urls: [...prev.destination_urls, ''] }))}
                className="mt-2 w-full py-1.5 rounded-lg border border-dashed border-gray-300 text-[10px] text-textmid hover:border-navy/30 hover:text-navy hover:bg-navy/5 transition-colors inline-flex items-center justify-center gap-1"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                Add Another URL
              </button>
              {sidebarForm.destination_urls.length > 1 && (
                <p className="text-[9px] text-gold mt-1.5 flex items-center gap-1">
                  <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  Saving will duplicate this {isFlex ? 'flex ad' : 'ad'} for each extra URL ({sidebarForm.destination_urls.length - 1} duplicate{sidebarForm.destination_urls.length > 2 ? 's' : ''}).
                </p>
              )}
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

            {/* ─── Schedule Ad ─── */}
            <div>
              <label className="text-[11px] font-semibold text-textdark uppercase tracking-wider">Schedule Ad</label>
              <select
                value={sidebarForm.planned_date ? 'scheduled' : 'immediately'}
                onChange={(e) => {
                  if (e.target.value === 'immediately') {
                    setSidebarForm(prev => ({ ...prev, planned_date: '' }));
                  } else {
                    // Default to tomorrow at 9:00 AM local time
                    const tomorrow = new Date();
                    tomorrow.setDate(tomorrow.getDate() + 1);
                    tomorrow.setHours(9, 0, 0, 0);
                    const local = new Date(tomorrow.getTime() - tomorrow.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
                    setSidebarForm(prev => ({ ...prev, planned_date: prev.planned_date || local }));
                  }
                }}
                className="input-apple text-[12px] w-full mt-1.5"
              >
                <option value="immediately">Immediately</option>
                <option value="scheduled">Specific Date & Time</option>
              </select>
              {sidebarForm.planned_date && (
                <input
                  type="datetime-local"
                  value={sidebarForm.planned_date}
                  onChange={(e) => setSidebarForm(prev => ({ ...prev, planned_date: e.target.value }))}
                  className="input-apple text-[12px] w-full mt-2"
                />
              )}
            </div>

            {/* ─── Save ─── */}
            <button
              onClick={handleSaveSidebar}
              disabled={sidebarSaving}
              className="btn-primary w-full text-[12px] py-2.5 disabled:opacity-50"
            >
              {sidebarSaving ? 'Saving...' : 'Save Changes'}
            </button>

            {/* ─── Duplicate Confirmation Dialog (multi-URL) ─── */}
            {duplicateConfirm && (
              <div className="mt-4 p-4 rounded-xl border-2 border-gold/30 bg-gold/5 space-y-3 fade-in">
                <div className="flex items-start gap-2.5">
                  <div className="w-8 h-8 rounded-lg bg-gold/10 flex items-center justify-center flex-shrink-0">
                    <svg className="w-4 h-4 text-gold" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-[12px] font-semibold text-textdark">
                      Duplicate {isFlex ? 'flex ad' : 'ad'} for {duplicateConfirm.urls.length} URLs?
                    </p>
                    <p className="text-[11px] text-textmid mt-1">
                      {isFlex
                        ? `This will save the current flex ad with the first URL, then duplicate all ${sidebarData?.deps?.length || 0} child ads for each extra URL — creating ${duplicateConfirm.urls.length - 1} new flex ad${duplicateConfirm.urls.length > 2 ? 's' : ''} in the same ad set:`
                        : `This will save the current ad with the first URL, then create ${duplicateConfirm.urls.length - 1} duplicate${duplicateConfirm.urls.length > 2 ? 's' : ''} in the same ad set — each with a different destination URL:`
                      }
                    </p>
                    <ul className="mt-2 space-y-1">
                      {duplicateConfirm.urls.map((url, i) => (
                        <li key={i} className="text-[10px] text-textmid flex items-start gap-1.5">
                          <span className="text-gold font-semibold mt-px">{i === 0 ? 'Original:' : `Copy ${i}:`}</span>
                          <span className="truncate">{url}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleSaveSidebar}
                    disabled={sidebarSaving}
                    className="flex-1 text-[11px] py-2 rounded-xl bg-navy text-white hover:bg-navy-light transition-colors disabled:opacity-50"
                  >
                    {sidebarSaving ? 'Saving...' : `Yes, Save & Create ${duplicateConfirm.urls.length - 1} Duplicate${duplicateConfirm.urls.length > 2 ? 's' : ''}`}
                  </button>
                  <button
                    onClick={() => setDuplicateConfirm(null)}
                    className="text-[11px] px-3 py-2 rounded-xl bg-white border border-gray-200 text-textmid hover:bg-gray-50 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
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

                  {entityDeleteConfirm?.type === 'campaign' && entityDeleteConfirm.id === campaign.id ? (
                    <div className="flex items-center gap-1">
                      <span className="text-[10px] text-textmid">Delete?</span>
                      <button
                        onClick={() => { handleDeleteCampaign(campaign.id); setEntityDeleteConfirm(null); }}
                        className="text-[10px] px-1.5 py-0.5 rounded bg-red-500 text-white hover:bg-red-600 transition-colors"
                      >
                        Confirm
                      </button>
                      <button
                        onClick={() => setEntityDeleteConfirm(null)}
                        className="text-[10px] px-1.5 py-0.5 rounded text-textmid hover:bg-gray-100 transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setEntityDeleteConfirm({ type: 'campaign', id: campaign.id, name: campaign.name })}
                      className="p-1 rounded-lg hover:bg-red-50 text-textlight hover:text-red-500 transition-colors"
                      title="Delete campaign"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  )}
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
                                    const firstId = [...(selectedInAdSet[adSet.id] || [])][0];
                                    // Check if it's a flex ad or a deployment
                                    const flex = flexAds.find(f => f.id === firstId);
                                    if (flex) {
                                      let childIds = [];
                                      try { childIds = JSON.parse(flex.child_deployment_ids || '[]'); } catch { /* ignore */ }
                                      const childDeps = childIds.map(id => deployments.find(d => d.id === id)).filter(Boolean);
                                      openSidebar({ type: 'flex', flexAd: flex, deps: childDeps });
                                    } else {
                                      const dep = deployments.find(d => d.id === firstId);
                                      if (dep) openSidebar({ type: 'single', deployment: dep, ad: dep.ad });
                                    }
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
                                  onClick={async () => {
                                    const ids = [...(selectedInAdSet[adSet.id] || [])];
                                    // Resolve flex ad IDs to their child deployment IDs
                                    const standaloneDepIds = ids.filter(id => deployments.some(d => d.id === id));
                                    const flexAdIds = ids.filter(id => flexAds.some(f => f.id === id));
                                    const flexChildDepIds = [];
                                    for (const fid of flexAdIds) {
                                      const flex = flexAds.find(f => f.id === fid);
                                      if (flex) {
                                        try { flexChildDepIds.push(...JSON.parse(flex.child_deployment_ids || '[]')); } catch { /* ignore */ }
                                      }
                                    }
                                    const allDepIds = [...new Set([...standaloneDepIds, ...flexChildDepIds])];
                                    if (allDepIds.length === 0) { addToast('Select ads to mark as ready', 'info'); return; }
                                    try {
                                      await Promise.all(allDepIds.map(id => api.updateDeploymentStatus(id, 'ready_to_post')));
                                      setDeployments(prev => prev.map(d => allDepIds.includes(d.id) ? { ...d, status: 'ready_to_post' } : d));
                                      setSelectedInAdSet(prev => ({ ...prev, [adSet.id]: new Set() }));
                                      addToast(`${allDepIds.length} ad${allDepIds.length !== 1 ? 's' : ''} ready to post`, 'success');
                                    } catch {
                                      addToast('Failed to update status', 'error');
                                    }
                                  }}
                                  className="text-[10px] px-2 py-1 rounded-lg bg-teal/10 border border-teal/30 text-teal font-medium hover:bg-teal/20 transition-colors inline-flex items-center gap-1"
                                >
                                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                  </svg>
                                  Ready to Post
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
                            {entityDeleteConfirm?.type === 'adset' && entityDeleteConfirm.id === adSet.id ? (
                              <div className="flex items-center gap-1">
                                <span className="text-[10px] text-textmid">Delete?</span>
                                <button
                                  onClick={() => { handleDeleteAdSet(adSet.id); setEntityDeleteConfirm(null); }}
                                  className="text-[10px] px-1.5 py-0.5 rounded bg-red-500 text-white hover:bg-red-600 transition-colors"
                                >
                                  Confirm
                                </button>
                                <button
                                  onClick={() => setEntityDeleteConfirm(null)}
                                  className="text-[10px] px-1.5 py-0.5 rounded text-textmid hover:bg-gray-100 transition-colors"
                                >
                                  Cancel
                                </button>
                              </div>
                            ) : (
                              <button
                                onClick={() => setEntityDeleteConfirm({ type: 'adset', id: adSet.id, name: adSet.name })}
                                className="p-1 rounded hover:bg-red-50 text-textlight hover:text-red-500 transition-colors"
                                title="Delete ad set"
                              >
                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                </svg>
                              </button>
                            )}
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

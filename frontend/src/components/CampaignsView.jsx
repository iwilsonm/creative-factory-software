import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../api';

const CTA_OPTIONS = [
  'SHOP_NOW', 'LEARN_MORE', 'SIGN_UP', 'BOOK_NOW', 'CONTACT_US',
  'DOWNLOAD', 'GET_QUOTE', 'SUBSCRIBE', 'ORDER_NOW', 'WATCH_MORE',
  'LISTEN_NOW', 'APPLY_NOW', 'GET_OFFER', 'NO_BUTTON',
];

/**
 * CampaignsView — Flat staging area for planning ad deployments.
 *
 * Layout:
 *   Left:   "Queue" holding area (deployments with local_campaign_id === 'unplanned')
 *   Right:  Flat staging area (drag ads here, combine into flex, fill details)
 *
 * Features:
 *   - Drag & drop from Queue → Staging area
 *   - Combine multiple ads into Flex ads
 *   - Detail sidebar with campaign/ad set assignment, AI-generated primary text + headlines, destination URL, CTA
 *   - Campaign assignment via dropdown (select existing or create new) + ad set name text input
 *
 * Props:
 *   projectId, deployments, setDeployments, addToast, loadDeployments
 */
export default function CampaignsView({ projectId, deployments, setDeployments, addToast, loadDeployments }) {
  const [campaigns, setCampaigns] = useState([]);
  const [adSets, setAdSets] = useState([]);
  const [flexAds, setFlexAds] = useState([]);
  const [loading, setLoading] = useState(true);

  // Drag state — dragIds uses a ref to avoid re-renders that kill the drag
  const dragIdsRef = useRef(null);
  const [dragVisual, setDragVisual] = useState(null);  // only for visual feedback (opacity)
  const [dropTarget, setDropTarget] = useState(null);

  // Selection for unplanned
  const [selectedUnplanned, setSelectedUnplanned] = useState(new Set());

  // Selection within staging area (for combining into flex, bulk actions)
  const [selectedInStaging, setSelectedInStaging] = useState(new Set());

  // Delete confirmation modal
  const [deleteConfirm, setDeleteConfirm] = useState({ open: false, ids: [], source: 'unplanned' });

  // Flex ad action confirmation: { id: flexAdId, action: 'ungroup'|'unplan'|'remove' } or null
  const [flexActionConfirm, setFlexActionConfirm] = useState(null);
  const [combiningFlex, setCombiningFlex] = useState(false);

  // Image preview lightbox (for flex ad thumbnails)
  const [previewImage, setPreviewImage] = useState(null);

  // Detail sidebar
  const [sidebarData, setSidebarData] = useState(null);
  const [sidebarForm, setSidebarForm] = useState({
    ad_name: '', destination_urls: [''], display_link: '', cta_button: 'LEARN_MORE', primary_texts: [], ad_headlines: [], planned_date: '', facebook_page: '',
    campaign_id: '', new_campaign_name: '', ad_set_name: '', duplicate_adset_name: '', notes: '',
  });
  const [duplicateConfirm, setDuplicateConfirm] = useState(null); // { urls: string[] } when pending
  const [generatingPrimaryText, setGeneratingPrimaryText] = useState(false);
  const [generatingHeadlines, setGeneratingHeadlines] = useState(false);
  const [primaryTextDirection, setPrimaryTextDirection] = useState('');
  const [primaryTextThread, setPrimaryTextThread] = useState([]); // conversation history for iterative refinement
  const [primaryTextDirectionHistory, setPrimaryTextDirectionHistory] = useState([]); // past creative directions
  const [primaryTextRoundHistory, setPrimaryTextRoundHistory] = useState([]); // stack of { texts, thread, directionHistory } for undo
  const [headlineDirection, setHeadlineDirection] = useState('');
  const [headlineThread, setHeadlineThread] = useState([]); // conversation history for headline refinement
  const [headlineDirectionHistory, setHeadlineDirectionHistory] = useState([]); // past headline directions
  const [headlineRoundHistory, setHeadlineRoundHistory] = useState([]); // stack of { headlines, thread, directionHistory } for undo
  const [sidebarSaving, setSidebarSaving] = useState(false);
  const [primaryTextOpen, setPrimaryTextOpen] = useState(false);
  const [headlinesOpen, setHeadlinesOpen] = useState(false);
  const [expandedFlexChild, setExpandedFlexChild] = useState(null);

  // ─── Undo system ───────────────────────────────────────────────────────
  const [undoState, setUndoState] = useState(null);
  // Shape: { label, deploymentsSnapshot, flexAdsSnapshot, serverUndo, timestamp }

  // ─── Sticky field defaults — persist across sidebar opens ──────────────
  const stickyFieldsRef = useRef({
    destination_url: '',
    display_link: '',
    facebook_page: '',
    campaign_id: '',
    ad_set_name: '',
    duplicate_adset_name: '',
  });

  // Queue for auto-generating copy after flex ad creation
  const autoGenFlexRef = useRef(null); // { allDepIds: string[] } when pending

  const sidebarInitialFormRef = useRef(null);
  const autosaveTimerRef = useRef(null);
  const lastAutosavedRef = useRef(null); // JSON string of last autosaved { primary_texts, ad_headlines }

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

  // ─── Auto-generate copy after flex ad creation ──────────────────────────
  useEffect(() => {
    if (combiningFlex || !autoGenFlexRef.current) return;
    const { allDepIds } = autoGenFlexRef.current;
    autoGenFlexRef.current = null;

    // Find the newly created flex ad by matching its child deployment IDs
    const newFlex = flexAds.find(f => {
      try {
        const cIds = JSON.parse(f.child_deployment_ids || '[]');
        return cIds.length === allDepIds.length && allDepIds.every(id => cIds.includes(id));
      } catch { return false; }
    });
    if (!newFlex) return;

    // Get child deployments for the sidebar
    let childIds = [];
    try { childIds = JSON.parse(newFlex.child_deployment_ids || '[]'); } catch { /* ignore */ }
    const childDeps = childIds.map(id => deployments.find(d => d.id === id)).filter(Boolean);

    // Open sidebar for the new flex ad
    openSidebar({ type: 'flex', flexAd: newFlex, deps: childDeps });

    // Auto-generate primary texts, then headlines
    const autoGenerate = async () => {
      const depId = childDeps[0]?.id;
      if (!depId) return;
      try {
        setGeneratingPrimaryText(true);
        setPrimaryTextOpen(true);
        const ptResult = await api.generatePrimaryText(depId, newFlex.id);
        setSidebarForm(prev => ({ ...prev, primary_texts: ptResult.primary_texts || [] }));
        setPrimaryTextThread(ptResult.messages || []);

        // Now generate headlines from the primary texts
        setGeneratingHeadlines(true);
        setHeadlinesOpen(true);
        const hlResult = await api.generateAdHeadlines(depId, ptResult.primary_texts || [], newFlex.id);
        setSidebarForm(prev => ({ ...prev, ad_headlines: hlResult.headlines || [] }));
        setHeadlineThread(hlResult.messages || []);

        addToast('Primary texts & headlines auto-generated — refine or save', 'success');
      } catch {
        addToast('Auto-generation failed — generate manually from the sidebar', 'error');
      }
      setGeneratingPrimaryText(false);
      setGeneratingHeadlines(false);
    };
    // Kick off auto-generation (don't await — runs in background while sidebar is open)
    autoGenerate();
  }, [combiningFlex, flexAds, deployments]);

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

  // ─── Undo helpers ────────────────────────────────────────────────────────
  const snapshotForUndo = useCallback((label, serverUndoFn) => {
    setUndoState({
      label,
      deploymentsSnapshot: [...deployments],
      flexAdsSnapshot: [...flexAds],
      serverUndo: serverUndoFn,
      timestamp: Date.now(),
    });
  }, [deployments, flexAds]);

  const handleUndo = useCallback(async () => {
    if (!undoState) return;
    if (Date.now() - undoState.timestamp > 60000) {
      addToast('Undo expired', 'warning');
      setUndoState(null);
      return;
    }
    // Optimistic restore
    setDeployments(undoState.deploymentsSnapshot);
    setFlexAds(undoState.flexAdsSnapshot);
    // Close sidebar if open (data is now stale)
    setSidebarData(null);
    sidebarInitialFormRef.current = null;
    // Clear undo state immediately (prevent double-fire)
    const serverUndo = undoState.serverUndo;
    setUndoState(null);
    // Server-side reversal
    try {
      await serverUndo();
      addToast('Undone', 'success');
    } catch (err) {
      console.error('Undo server error:', err);
      addToast('Undo failed — refreshing...', 'error');
      await Promise.all([loadCampaignData(true), loadDeployments()]);
    }
  }, [undoState, addToast, loadDeployments, setDeployments]);

  // Auto-expire undo after 60 seconds
  useEffect(() => {
    if (!undoState) return;
    const timer = setTimeout(() => setUndoState(null), 60000);
    return () => clearTimeout(timer);
  }, [undoState]);

  // Cmd+Z / Ctrl+Z keyboard shortcut
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
        const tag = document.activeElement?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        if (undoState) {
          e.preventDefault();
          handleUndo();
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [undoState, handleUndo]);

  // ─── Derived data ───────────────────────────────────────────────────────
  const unplannedDeps = deployments.filter(d => d.local_campaign_id === 'unplanned' && d.status !== 'ready_to_post' && d.status !== 'posted');

  // Planned deps = everything that's been dragged to staging (not unplanned, not ready/posted)
  const plannedDeps = deployments.filter(d =>
    d.local_campaign_id !== 'unplanned' && d.status !== 'ready_to_post' && d.status !== 'posted'
  );

  // Flex ads with at least one visible (non-ready/posted) child
  const stagingFlexAds = flexAds.filter(f => {
    let childIds = [];
    try { childIds = JSON.parse(f.child_deployment_ids || '[]'); } catch { /* ignore */ }
    if (childIds.length === 0) return true;
    return childIds.some(id => {
      const dep = deployments.find(d => d.id === id);
      return dep && dep.status !== 'ready_to_post' && dep.status !== 'posted';
    });
  });

  // Standalone = planned deps NOT inside any visible flex ad
  const flexChildIdSet = new Set(stagingFlexAds.flatMap(f => {
    try { return JSON.parse(f.child_deployment_ids || '[]'); } catch { return []; }
  }));
  const standaloneStagingDeps = plannedDeps.filter(d => !flexChildIdSet.has(d.id));

  // Helper to resolve campaign/ad set label for a deployment
  const resolvePlacement = (dep) => {
    if (!dep.local_campaign_id || dep.local_campaign_id === 'planned' || dep.local_campaign_id === 'unplanned') return null;
    const camp = campaigns.find(c => c.id === dep.local_campaign_id);
    const adSet = dep.local_adset_id ? adSets.find(a => a.id === dep.local_adset_id) : null;
    if (!camp) return null;
    return { campaignName: camp.name, adSetName: adSet?.name || null };
  };

  // Helper to resolve placement for a flex ad
  const resolveFlexPlacement = (flexAd) => {
    if (!flexAd.ad_set_id) return null;
    const adSet = adSets.find(a => a.id === flexAd.ad_set_id);
    if (!adSet) return null;
    const camp = campaigns.find(c => c.id === adSet.campaign_id);
    if (!camp) return null;
    return { campaignName: camp.name, adSetName: adSet.name };
  };

  // ─── Staging selection helpers ────────────────────────────────────────
  const toggleStagingSelect = (itemId) => {
    setSelectedInStaging(prev => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId); else next.add(itemId);
      return next;
    });
  };

  const toggleSelectAllStaging = () => {
    const allIds = [...standaloneStagingDeps.map(d => d.id), ...stagingFlexAds.map(f => f.id)];
    if (selectedInStaging.size === allIds.length && allIds.length > 0) {
      setSelectedInStaging(new Set());
    } else {
      setSelectedInStaging(new Set(allIds));
    }
  };

  // ─── Drag & Drop ───────────────────────────────────────────────────────
  const handleDragStart = (e, depId, fromStaging = false) => {
    let ids;
    if (fromStaging) {
      ids = selectedInStaging.has(depId) && selectedInStaging.size > 0
        ? [...selectedInStaging]
        : [depId];
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

  const handleDragLeave = (e) => {
    if (!e.currentTarget.contains(e.relatedTarget)) {
      setDropTarget(null);
    }
  };

  const handleDropOnStaging = async (e) => {
    e.preventDefault();
    setDropTarget(null);
    let ids;
    try {
      const data = JSON.parse(e.dataTransfer.getData('text/plain'));
      ids = data.deploymentIds;
    } catch { return; }
    if (!ids?.length) return;

    // Snapshot for undo
    snapshotForUndo(`move ${ids.length}`, async () => {
      await api.unassignFromAdSet(ids);
    });

    setDeployments(prev => prev.map(d =>
      ids.includes(d.id) ? { ...d, local_campaign_id: 'planned', local_adset_id: '', flex_ad_id: '' } : d
    ));
    setSelectedUnplanned(new Set());
    dragIdsRef.current = null;
    setDragVisual(null);

    try {
      await api.assignToAdSet(ids, 'planned', '');
    } catch {
      addToast('Failed to move ads — retrying...', 'error');
      try { await api.assignToAdSet(ids, 'planned', ''); } catch { loadDeployments(); }
    }
  };

  // Move selected queue items to planner (staging area) via button
  const handleMoveToPlanner = async (ids) => {
    if (!ids?.length) return;

    snapshotForUndo(`move ${ids.length}`, async () => {
      await api.unassignFromAdSet(ids);
    });

    setDeployments(prev => prev.map(d =>
      ids.includes(d.id) ? { ...d, local_campaign_id: 'planned', local_adset_id: '', flex_ad_id: '' } : d
    ));
    setSelectedUnplanned(new Set());

    try {
      await api.assignToAdSet(ids, 'planned', '');
    } catch {
      addToast('Failed to move ads — retrying...', 'error');
      try { await api.assignToAdSet(ids, 'planned', ''); } catch { loadDeployments(); }
    }
  };

  const handleMoveToQueue = async (ids) => {
    // Separate flex ad IDs from standalone deployment IDs
    const flexAdIds = ids.filter(id => flexAds.some(f => f.id === id));
    const standaloneDepIds = ids.filter(id => deployments.some(d => d.id === id));

    // For flex ads: collect their child deployment IDs, then delete the flex ad
    const flexChildDepIds = [];
    const flexSnapshots = []; // Save flex ad data for undo
    for (const flexId of flexAdIds) {
      const flex = flexAds.find(f => f.id === flexId);
      if (flex) {
        flexSnapshots.push({ ...flex });
        try { const childIds = JSON.parse(flex.child_deployment_ids || '[]'); flexChildDepIds.push(...childIds); } catch { /* ignore */ }
      }
    }

    // All deployment IDs to unassign: standalone + flex children
    const allDepIds = [...new Set([...standaloneDepIds, ...flexChildDepIds])];

    // Snapshot for undo
    snapshotForUndo(`move ${allDepIds.length}`, async () => {
      // Re-assign deps back to staging
      if (allDepIds.length > 0) {
        await api.assignToAdSet(allDepIds, 'planned', '');
      }
      // Restore flex ads
      for (const fSnap of flexSnapshots) {
        await api.restoreFlexAd(fSnap.id);
      }
      await loadCampaignData(true);
    });

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
    setSelectedInStaging(new Set());
    addToast(`Moved ${allDepIds.length} ad${allDepIds.length !== 1 ? 's' : ''} to queue`, 'success');

    try {
      await Promise.all(flexAdIds.map(id => api.deleteFlexAd(id)));
      if (allDepIds.length > 0) {
        await api.unassignFromAdSet(allDepIds);
      }
      await loadCampaignData(true);
    } catch {
      addToast('Failed to move to queue', 'error');
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

    // Snapshot for undo
    snapshotForUndo(`move ${ids.length}`, async () => {
      await api.assignToAdSet(ids, 'planned', '');
    });

    setDeployments(prev => prev.map(d =>
      ids.includes(d.id) ? { ...d, local_campaign_id: 'unplanned', local_adset_id: '', flex_ad_id: '' } : d
    ));
    dragIdsRef.current = null;
    setDragVisual(null);

    try {
      await api.unassignFromAdSet(ids);
    } catch {
      addToast('Failed to move to queue — retrying...', 'error');
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
  const handleCombineIntoFlex = async () => {
    if (combiningFlex) return; // Prevent double-click
    const selected = [...selectedInStaging];
    if (selected.length < 2) return;
    setCombiningFlex(true);

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
      setCombiningFlex(false);
      return;
    }
    if (allDepIds.length > 10) {
      addToast(`Maximum 10 ads per Flex ad (you selected ${allDepIds.length}). Deselect some ads and try again.`, 'error');
      setCombiningFlex(false);
      return;
    }

    const name = `Flexible Ad (${allDepIds.length} images)`;

    // Snapshot for undo — capture state of dissolved flex ads for restoration
    const dissolvedFlexSnapshots = selectedFlexIds.map(id => flexAds.find(f => f.id === id)).filter(Boolean);
    snapshotForUndo('combine', async () => {
      // The new flex ad will have been created by now — we need to find it and delete it
      // Refresh to find the real flex ad that was created
      const freshData = await api.getFlexAds(projectId);
      const newFlex = (freshData.flexAds || []).find(f => {
        try {
          const cIds = JSON.parse(f.child_deployment_ids || '[]');
          return allDepIds.every(id => cIds.includes(id)) && cIds.length === allDepIds.length;
        } catch { return false; }
      });
      if (newFlex) await api.deleteFlexAd(newFlex.id);
      // Restore dissolved flex ads
      for (const fSnap of dissolvedFlexSnapshots) {
        await api.restoreFlexAd(fSnap.id);
      }
      await loadCampaignData(true);
    });

    // Optimistic: create a temporary flex ad in state so UI updates immediately
    const tempFlexId = `temp-${Date.now()}`;
    setFlexAds(prev => [
      ...prev.filter(f => !selectedFlexIds.includes(f.id)), // Remove old flex ads being dissolved
      { id: tempFlexId, name, child_deployment_ids: JSON.stringify(allDepIds), ad_set_id: '', project_id: projectId }
    ]);
    // Mark children as belonging to the temp flex
    setDeployments(prev => prev.map(d =>
      allDepIds.includes(d.id) ? { ...d, flex_ad_id: tempFlexId } : d
    ));
    setSelectedInStaging(new Set());
    addToast('Flexible ad created', 'success');

    try {
      // Delete old flex ads first (dissolve them)
      if (selectedFlexIds.length > 0) {
        await Promise.all(selectedFlexIds.map(id => api.deleteFlexAd(id)));
      }
      await api.createFlexAd(projectId, '', name, allDepIds);
      // Refresh to get real server IDs (replaces temp)
      await Promise.all([loadCampaignData(true), loadDeployments()]);
      // Queue auto-generation of primary texts + headlines for the new flex ad
      autoGenFlexRef.current = { allDepIds };
    } catch (err) {
      addToast(err.message || 'Failed to create flexible ad', 'error');
      await Promise.all([loadCampaignData(true), loadDeployments()]);
    }
    setCombiningFlex(false);
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
      // Snapshot for undo
      snapshotForUndo('ungroup', async () => {
        await api.restoreFlexAd(flexAdId);
        await loadCampaignData(true);
      });
      // Optimistic: remove flex ad, clear flex_ad_id on owned children (children stay in staging)
      setFlexAds(prev => prev.filter(f => f.id !== flexAdId));
      if (ownedChildIds.length > 0) {
        setDeployments(prev => prev.map(d =>
          ownedChildIds.includes(d.id) ? { ...d, flex_ad_id: '' } : d
        ));
      }
      addToast('Flexible ad ungrouped', 'success');
      try {
        await api.deleteFlexAd(flexAdId);
        await loadCampaignData(true);
      } catch {
        addToast('Failed to ungroup flexible ad', 'error');
        await Promise.all([loadCampaignData(true), loadDeployments()]);
      }
    } else if (action === 'unplan') {
      // Only affect children that actually belong to this flex ad
      const ownedChildIds = childIds.filter(id => {
        const dep = deployments.find(d => d.id === id);
        return dep && dep.flex_ad_id === flexAdId;
      });
      // Snapshot for undo
      snapshotForUndo('unplan', async () => {
        await api.restoreFlexAd(flexAdId);
        if (ownedChildIds.length > 0) {
          await api.assignToAdSet(ownedChildIds, 'planned', '');
        }
        await loadCampaignData(true);
      });
      // Optimistic: remove flex ad, move owned children to queue
      setFlexAds(prev => prev.filter(f => f.id !== flexAdId));
      if (ownedChildIds.length > 0) {
        setDeployments(prev => prev.map(d =>
          ownedChildIds.includes(d.id) ? { ...d, local_campaign_id: 'unplanned', local_adset_id: '', flex_ad_id: '' } : d
        ));
      }
      addToast(`Moved ${ownedChildIds.length} ad${ownedChildIds.length !== 1 ? 's' : ''} to queue`, 'success');
      try {
        await api.deleteFlexAd(flexAdId);
        if (ownedChildIds.length > 0) {
          await api.unassignFromAdSet(ownedChildIds);
        }
        await loadCampaignData(true);
      } catch {
        addToast('Failed to move to queue', 'error');
        await Promise.all([loadCampaignData(true), loadDeployments()]);
      }
    } else if (action === 'remove') {
      // Only delete child deployments that actually belong to this flex ad
      const ownedChildIds = childIds.filter(id => {
        const dep = deployments.find(d => d.id === id);
        return dep && dep.flex_ad_id === flexAdId;
      });
      // Snapshot for undo
      snapshotForUndo('remove', async () => {
        await api.restoreFlexAd(flexAdId);
        await Promise.all(ownedChildIds.map(id => api.restoreDeployment(id)));
        await loadCampaignData(true);
      });
      // Optimistic: remove flex ad + delete owned child deployments
      setFlexAds(prev => prev.filter(f => f.id !== flexAdId));
      if (ownedChildIds.length > 0) {
        setDeployments(prev => prev.filter(d => !ownedChildIds.includes(d.id)));
      }
      addToast(`Removed ${ownedChildIds.length} ad${ownedChildIds.length !== 1 ? 's' : ''} from planner`, 'success');
      try {
        await api.deleteFlexAd(flexAdId);
        await Promise.all(ownedChildIds.map(id => api.deleteDeployment(id)));
        await loadCampaignData(true);
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
    setPrimaryTextRoundHistory([]);
    setHeadlineDirection('');
    setHeadlineThread([]);
    setHeadlineDirectionHistory([]);
    setHeadlineRoundHistory([]);
    const sticky = stickyFieldsRef.current;
    let form;
    if (data.type === 'single') {
      const dep = data.deployment;
      const url = dep.destination_url || dep.landing_page_url || '';
      const depCampaignId = dep.local_campaign_id && dep.local_campaign_id !== 'planned' && dep.local_campaign_id !== 'unplanned'
        ? dep.local_campaign_id : '';
      form = {
        ad_name: dep.ad_name || dep.ad?.headline || dep.ad?.angle || '',
        destination_urls: url ? [url] : (sticky.destination_url ? [sticky.destination_url] : ['']),
        display_link: dep.display_link || sticky.display_link || '',
        cta_button: dep.cta_button || 'LEARN_MORE',
        primary_texts: (() => { try { return dep.primary_texts ? JSON.parse(dep.primary_texts) : []; } catch { return []; } })(),
        ad_headlines: (() => { try { return dep.ad_headlines ? JSON.parse(dep.ad_headlines) : []; } catch { return []; } })(),
        planned_date: dep.planned_date || '',
        facebook_page: dep.facebook_page || sticky.facebook_page || '',
        notes: dep.notes || '',
        // Campaign/ad set assignment — use sticky defaults when not already set
        campaign_id: depCampaignId || sticky.campaign_id || '',
        new_campaign_name: '',
        ad_set_name: (() => {
          const adSet = adSets.find(a => a.id === dep.local_adset_id);
          return adSet?.name || sticky.ad_set_name || '';
        })(),
        duplicate_adset_name: dep.duplicate_adset_name || sticky.duplicate_adset_name || '',
      };
    } else {
      const flex = data.flexAd;
      const url = flex.destination_url || '';
      const flexCampaignId = (() => {
        const adSet = adSets.find(a => a.id === flex.ad_set_id);
        if (!adSet) return '';
        return adSet.campaign_id || '';
      })();
      form = {
        ad_name: flex.name || '',
        destination_urls: url ? [url] : (sticky.destination_url ? [sticky.destination_url] : ['']),
        display_link: flex.display_link || sticky.display_link || '',
        cta_button: flex.cta_button || 'LEARN_MORE',
        primary_texts: (() => { try { return flex.primary_texts ? JSON.parse(flex.primary_texts) : []; } catch { return []; } })(),
        ad_headlines: (() => { try { return flex.headlines ? JSON.parse(flex.headlines) : []; } catch { return []; } })(),
        planned_date: flex.planned_date || '',
        facebook_page: flex.facebook_page || sticky.facebook_page || '',
        notes: flex.notes || '',
        // Campaign/ad set assignment for flex — use sticky defaults when not already set
        campaign_id: flexCampaignId || sticky.campaign_id || '',
        new_campaign_name: '',
        ad_set_name: (() => {
          const adSet = adSets.find(a => a.id === flex.ad_set_id);
          return adSet?.name || sticky.ad_set_name || '';
        })(),
        duplicate_adset_name: flex.duplicate_adset_name || sticky.duplicate_adset_name || '',
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

  // Close sidebar on Escape
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        if (previewImage) { setPreviewImage(null); return; }
        if (deleteConfirm.open) { setDeleteConfirm({ open: false, ids: [], source: 'unplanned' }); return; }
        if (sidebarData) closeSidebar();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [sidebarData, deleteConfirm.open, previewImage]);

  const handleGeneratePrimaryText = async () => {
    setGeneratingPrimaryText(true);
    setPrimaryTextOpen(true); // Auto-expand so user can see results
    try {
      const depId = sidebarData.type === 'single'
        ? sidebarData.deployment.id
        : sidebarData.deps[0]?.id;
      const flexAdId = sidebarData.type === 'flex' ? sidebarData.flexAd.id : undefined;
      const direction = primaryTextDirection.trim() || undefined;
      // Snapshot current round before replacing (for undo)
      if (sidebarForm.primary_texts.filter(t => t.trim()).length > 0) {
        setPrimaryTextRoundHistory(prev => [...prev, {
          texts: [...sidebarForm.primary_texts],
          thread: [...primaryTextThread],
          directionHistory: [...primaryTextDirectionHistory],
        }]);
      }
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

  const handleUndoPrimaryText = () => {
    if (primaryTextRoundHistory.length === 0) return;
    const prev = primaryTextRoundHistory[primaryTextRoundHistory.length - 1];
    setSidebarForm(f => ({ ...f, primary_texts: prev.texts }));
    setPrimaryTextThread(prev.thread);
    setPrimaryTextDirectionHistory(prev.directionHistory);
    setPrimaryTextRoundHistory(h => h.slice(0, -1));
    addToast('Restored previous round', 'info');
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
      // Snapshot current round before replacing (for undo)
      if (sidebarForm.ad_headlines.filter(h => h.trim()).length > 0) {
        setHeadlineRoundHistory(prev => [...prev, {
          headlines: [...sidebarForm.ad_headlines],
          thread: [...headlineThread],
          directionHistory: [...headlineDirectionHistory],
        }]);
      }
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

  const handleUndoHeadlines = () => {
    if (headlineRoundHistory.length === 0) return;
    const prev = headlineRoundHistory[headlineRoundHistory.length - 1];
    setSidebarForm(f => ({ ...f, ad_headlines: prev.headlines }));
    setHeadlineThread(prev.thread);
    setHeadlineDirectionHistory(prev.directionHistory);
    setHeadlineRoundHistory(h => h.slice(0, -1));
    addToast('Restored previous headlines', 'info');
  };

  const handleSaveSidebar = async ({ closeAfter = false } = {}) => {
    // Check for multiple URLs — show confirmation dialog
    const urls = sidebarForm.destination_urls.filter(u => u.trim());
    if (urls.length > 1 && !duplicateConfirm) {
      setDuplicateConfirm({ urls, closeAfter });
      return;
    }
    setDuplicateConfirm(null);
    setSidebarSaving(true);

    // Persist sticky field defaults for future sidebar opens
    const primaryUrlForSticky = urls[0] || '';
    if (primaryUrlForSticky) stickyFieldsRef.current.destination_url = primaryUrlForSticky;
    if (sidebarForm.display_link) stickyFieldsRef.current.display_link = sidebarForm.display_link;
    if (sidebarForm.facebook_page) stickyFieldsRef.current.facebook_page = sidebarForm.facebook_page;
    if (sidebarForm.duplicate_adset_name) stickyFieldsRef.current.duplicate_adset_name = sidebarForm.duplicate_adset_name;
    // Campaign/ad set — only persist real campaign IDs (not '__new__')
    const saveCampaignId = sidebarForm.campaign_id && sidebarForm.campaign_id !== '__new__' ? sidebarForm.campaign_id : '';
    if (saveCampaignId) stickyFieldsRef.current.campaign_id = saveCampaignId;
    if (sidebarForm.ad_set_name) stickyFieldsRef.current.ad_set_name = sidebarForm.ad_set_name;

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
          display_link: sidebarForm.display_link || '',
          cta_button: sidebarForm.cta_button,
          facebook_page: sidebarForm.facebook_page || null,
          planned_date: sidebarForm.planned_date || null,
          duplicate_adset_name: sidebarForm.duplicate_adset_name || '',
          notes: sidebarForm.notes || '',
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
          display_link: sidebarForm.display_link || '',
          cta_button: sidebarForm.cta_button,
          facebook_page: sidebarForm.facebook_page || null,
          planned_date: sidebarForm.planned_date || null,
          duplicate_adset_name: sidebarForm.duplicate_adset_name || '',
          notes: sidebarForm.notes || '',
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
              flexAd.ad_set_id || '',
              (sidebarForm.ad_name || flexAd.name || 'Flex Ad') + ` (${url.replace(/^https?:\/\//, '').slice(0, 30)})`,
              newChildIds,
            );
          }
        }
      }

      // Show toast and close immediately — campaign assignment runs in background
      if (extraUrls.length > 0) {
        addToast(`Saved + created ${extraUrls.length} duplicate${extraUrls.length > 1 ? 's' : ''} with different URL${extraUrls.length > 1 ? 's' : ''}`, 'success');
      } else {
        addToast('Saved', 'success');
      }

      // Reset URLs back to just the primary after save
      setSidebarForm(prev => ({ ...prev, destination_urls: [primaryUrl || ''] }));
      sidebarInitialFormRef.current = JSON.stringify({ ...sidebarForm, destination_urls: [primaryUrl || ''] });

      // Close sidebar if Save & Close was used
      if (closeAfter || duplicateConfirm?.closeAfter) {
        setSidebarData(null);
        sidebarInitialFormRef.current = null;
      }
      setSidebarSaving(false);

      // ── Campaign/Ad Set assignment + data refresh (non-blocking background) ──
      const campaignId = sidebarForm.campaign_id;
      const adSetName = sidebarForm.ad_set_name.trim();
      const sidebarDataCopy = { ...sidebarData, deps: sidebarData.deps ? [...sidebarData.deps] : [] };
      (async () => {
        try {
          let resolvedCampaignId = campaignId;
          if (resolvedCampaignId === '__new__' && sidebarForm.new_campaign_name.trim()) {
            const result = await api.createCampaign(projectId, sidebarForm.new_campaign_name.trim());
            resolvedCampaignId = result.id;
            stickyFieldsRef.current.campaign_id = resolvedCampaignId;
          }
          if (resolvedCampaignId && resolvedCampaignId !== '__new__' && adSetName) {
            const campData = await api.getCampaigns(projectId);
            const allAdSets = campData.adSets || [];
            let targetAdSet = allAdSets.find(
              a => a.campaign_id === resolvedCampaignId && a.name.trim().toLowerCase() === adSetName.toLowerCase()
            );
            if (!targetAdSet) {
              const result = await api.createAdSet(resolvedCampaignId, adSetName, projectId);
              targetAdSet = { id: result.id };
            }
            if (sidebarDataCopy.type === 'single') {
              await api.assignToAdSet([sidebarDataCopy.deployment.id], resolvedCampaignId, targetAdSet.id);
            } else {
              const childIds = sidebarDataCopy.deps.map(d => d.id);
              if (childIds.length > 0) {
                await api.assignToAdSet(childIds, resolvedCampaignId, targetAdSet.id);
              }
              await api.updateFlexAd(sidebarDataCopy.flexAd.id, { ad_set_id: targetAdSet.id });
            }
          }
        } catch { /* campaign assignment failed silently — user can retry */ }
        // Refresh data in background
        Promise.all([loadDeployments(), loadCampaignData(true)]).catch(() => {});
      })();
      return;
    } catch {
      addToast('Failed to save', 'error');
    }
    setSidebarSaving(false);
  };

  // ─── Select All helpers ────────────────────────────────────────────────
  const toggleSelectAllUnplanned = () => {
    if (selectedUnplanned.size === unplannedDeps.length && unplannedDeps.length > 0) {
      setSelectedUnplanned(new Set());
    } else {
      setSelectedUnplanned(new Set(unplannedDeps.map(d => d.id)));
    }
  };

  // ─── Bulk delete with confirmation ─────────────────────────────────────
  const handleConfirmDelete = async () => {
    const ids = deleteConfirm.ids;

    // Separate flex ad IDs from standalone deployment IDs
    const flexAdIds = ids.filter(id => flexAds.some(f => f.id === id));
    const depIds = ids.filter(id => deployments.some(d => d.id === id));

    // Resolve flex ad children to also delete
    const flexChildDepIds = [];
    for (const fid of flexAdIds) {
      const flex = flexAds.find(f => f.id === fid);
      if (flex) {
        try { flexChildDepIds.push(...JSON.parse(flex.child_deployment_ids || '[]')); } catch { /* ignore */ }
      }
    }
    const allDepIds = [...new Set([...depIds, ...flexChildDepIds])];

    // Snapshot for undo
    snapshotForUndo(`delete ${allDepIds.length}`, async () => {
      await Promise.all([
        ...flexAdIds.map(id => api.restoreFlexAd(id)),
        ...allDepIds.map(id => api.restoreDeployment(id)),
      ]);
      await loadCampaignData(true);
    });

    // Optimistic UI update — remove immediately
    if (allDepIds.length > 0) {
      setDeployments(prev => prev.filter(d => !allDepIds.includes(d.id)));
    }
    if (flexAdIds.length > 0) {
      setFlexAds(prev => prev.filter(f => !flexAdIds.includes(f.id)));
    }
    // Clear relevant selection
    if (deleteConfirm.source === 'unplanned') {
      setSelectedUnplanned(new Set());
    } else {
      setSelectedInStaging(new Set());
    }
    // Close dialog immediately
    setDeleteConfirm({ open: false, ids: [], source: 'unplanned' });

    const totalRemoved = allDepIds.length;
    try {
      // Delete flex ads and deployments in parallel
      await Promise.all([
        ...flexAdIds.map(id => api.deleteFlexAd(id)),
        ...allDepIds.map(id => api.deleteDeployment(id)),
      ]);
      addToast(`${totalRemoved} removed from tracker`, 'success');
    } catch {
      addToast('Failed to delete some deployments', 'error');
      await Promise.all([loadCampaignData(true), loadDeployments()]);
    }
  };

  // ─── Mark as Ready to Post ─────────────────────────────────────────────
  const handleMarkReadyToPost = async (ids) => {
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

    // Optimistic UI update — immediate feedback
    setDeployments(prev => prev.map(d => allDepIds.includes(d.id) ? { ...d, status: 'ready_to_post' } : d));
    setSelectedInStaging(new Set());
    addToast(`${allDepIds.length} ad${allDepIds.length !== 1 ? 's' : ''} ready to post`, 'success');

    try {
      await Promise.all(allDepIds.map(id => api.updateDeploymentStatus(id, 'ready_to_post')));
    } catch {
      addToast('Failed to update status — refreshing...', 'error');
      loadDeployments();
    }
  };

  // ─── renderDepCard (render function, NOT a component — avoids unmount on re-render) ──
  const renderDepCard = (dep, { isDraggable = false, inStaging = false } = {}) => {
    const name = dep.ad?.headline || dep.ad?.angle || dep.ad_name || `Ad ${(dep.id || '').slice(0, 6)}`;
    const thumbUrl = dep.imageUrl;
    const isDragging = dragVisual?.includes(dep.id);
    const isSelectedUnplanned = selectedUnplanned.has(dep.id);
    const isSelectedStaging = inStaging && selectedInStaging.has(dep.id);
    const isSelected = inStaging ? isSelectedStaging : isSelectedUnplanned;
    const placement = inStaging ? resolvePlacement(dep) : null;

    return (
      <div
        key={dep.id}
        draggable={isDraggable}
        onDragStart={isDraggable ? (e) => handleDragStart(e, dep.id, inStaging) : undefined}
        onDragEnd={isDraggable ? handleDragEnd : undefined}
        onClick={inStaging ? () => openSidebar({ type: 'single', deployment: dep, ad: dep.ad }) : undefined}
        className={`relative group flex items-center gap-2.5 p-2 rounded-xl border transition-all select-none ${
          isDraggable && !inStaging ? 'cursor-grab active:cursor-grabbing' : ''
        } ${
          inStaging ? 'cursor-pointer' : ''
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
            if (inStaging) {
              toggleStagingSelect(dep.id);
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

        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-medium text-textdark truncate" title={name}>{name}</div>
          {dep.ad?.body_copy && (
            <div className="text-[10px] text-textlight truncate mt-0.5">{dep.ad.body_copy}</div>
          )}
          {placement && (
            <div className="text-[9px] text-gold truncate mt-0.5">
              {placement.campaignName}{placement.adSetName ? ` \u203A ${placement.adSetName}` : ''}
            </div>
          )}
          {dep.created_at && (
            <div className="text-[9px] text-textlight mt-0.5">
              Added {(() => {
                try {
                  const d = new Date(dep.created_at);
                  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ' at ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
                } catch { return ''; }
              })()}
            </div>
          )}
        </div>
        {thumbUrl ? (
          <img
            src={thumbUrl}
            alt=""
            draggable="false"
            className="w-10 h-10 object-cover rounded-lg bg-gray-100 flex-shrink-0 cursor-zoom-in hover:ring-2 hover:ring-navy/30 transition-all"
            loading="lazy"
            onClick={(e) => { e.stopPropagation(); setPreviewImage(thumbUrl); }}
            title="Click to preview"
          />
        ) : (
          <div className="w-10 h-10 rounded-lg bg-gray-100 flex-shrink-0" />
        )}
        <span className="text-[8px] font-bold text-purple-700 bg-purple-100 px-1 py-0.5 rounded tracking-wide flex-shrink-0">Single Image</span>

        {/* Action buttons on hover */}
        <div className="opacity-0 group-hover:opacity-100 flex items-center gap-0.5 flex-shrink-0 transition-opacity">
          {inStaging && (
            <span className="text-[10px] text-navy font-medium mr-1">Edit</span>
          )}
          {inStaging && (
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
          {inStaging && (
            <button
              onMouseDown={(e) => e.stopPropagation()}
              onDragStart={(e) => e.preventDefault()}
              onClick={(e) => { e.stopPropagation(); handleMoveToQueue([dep.id]); }}
              className="p-1 rounded-lg hover:bg-red-50 text-textlight hover:text-red-500 transition-colors"
              title="Move back to Queue"
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
  const renderFlexAdCard = (flexAd) => {
    let childIds = [];
    try { childIds = JSON.parse(flexAd.child_deployment_ids || '[]'); } catch { /* ignore */ }
    const childDeps = childIds.map(id => deployments.find(d => d.id === id)).filter(Boolean);
    const isSelected = selectedInStaging.has(flexAd.id);
    const placement = resolveFlexPlacement(flexAd);

    return (
      <div
        key={flexAd.id}
        onClick={() => openSidebar({ type: 'flex', flexAd, deps: childDeps })}
        className={`relative group flex items-center gap-2.5 p-2 rounded-xl border transition-all cursor-pointer ${
          isSelected ? 'border-navy/40 bg-navy/5' : 'border-gray-200 bg-white hover:border-navy/20 hover:shadow-sm'
        }`}
      >
        {/* Checkbox */}
        <button
          onClick={(e) => { e.stopPropagation(); toggleStagingSelect(flexAd.id); }}
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
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-medium text-textdark truncate">{flexAd.name}</div>
          <div className="text-[10px] text-textlight">{childDeps.length} image{childDeps.length !== 1 ? 's' : ''}</div>
          {placement && (
            <div className="text-[9px] text-gold truncate">
              {placement.campaignName}{placement.adSetName ? ` \u203A ${placement.adSetName}` : ''}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {childDeps.slice(0, 4).map(d => (
            d.imageUrl ? (
              <img key={d.id} src={d.imageUrl} alt="" className="w-11 h-11 object-cover rounded-lg bg-gray-100 cursor-zoom-in hover:ring-2 hover:ring-navy/30 transition-all" loading="lazy" onClick={(e) => { e.stopPropagation(); setPreviewImage(d.imageUrl); }} title="Click to preview" />
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
        <span className="text-[9px] font-bold text-purple-700 bg-purple-100 px-1.5 py-0.5 rounded tracking-wide flex-shrink-0">Flexible</span>

        {/* Hover actions / Confirmation */}
        {flexActionConfirm?.id === flexAd.id ? (
          <div className="flex items-center gap-1 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
            <span className="text-[10px] text-textmid">
              {flexActionConfirm.action === 'ungroup' ? 'Ungroup?' : flexActionConfirm.action === 'unplan' ? 'Move to queue?' : 'Remove from planner?'}
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
              title="Move to queue"
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
              {isFlex && <span className="text-[9px] font-bold text-purple-700 bg-purple-100 px-1.5 py-0.5 rounded tracking-wide">Flexible</span>}
              <h3 className="text-[14px] font-semibold text-textdark">
                Ad Details
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
                    {/* Undo — go back to previous round */}
                    {primaryTextRoundHistory.length > 0 && !generatingPrimaryText && (
                      <button
                        onClick={handleUndoPrimaryText}
                        className="mt-1.5 w-full py-1.5 rounded-lg border border-gray-200 text-[10px] text-textmid hover:text-navy hover:border-navy/30 hover:bg-navy/5 transition-colors inline-flex items-center justify-center gap-1"
                      >
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a5 5 0 015 5v2M3 10l4-4M3 10l4 4" />
                        </svg>
                        Previous round
                      </button>
                    )}
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
                  <span className="text-[11px] font-semibold text-textdark uppercase tracking-wider">Headline</span>
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
                    {/* Undo — go back to previous round */}
                    {headlineRoundHistory.length > 0 && !generatingHeadlines && (
                      <button
                        onClick={handleUndoHeadlines}
                        className="mt-1.5 w-full py-1.5 rounded-lg border border-gray-200 text-[10px] text-textmid hover:text-navy hover:border-navy/30 hover:bg-navy/5 transition-colors inline-flex items-center justify-center gap-1"
                      >
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a5 5 0 015 5v2M3 10l4-4M3 10l4 4" />
                        </svg>
                        Previous round
                      </button>
                    )}
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

            {/* ─── Website URL ─── */}
            <div>
              <label className="text-[11px] font-semibold text-textdark uppercase tracking-wider">
                Website URL{sidebarForm.destination_urls.length > 1 ? 's' : ''}
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
                  Saving will duplicate this {isFlex ? 'flexible ad' : 'ad'} for each extra URL ({sidebarForm.destination_urls.length - 1} duplicate{sidebarForm.destination_urls.length > 2 ? 's' : ''}).
                </p>
              )}
            </div>

            {/* ─── Display Link ─── */}
            <div>
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={sidebarForm.display_link !== ''}
                  onChange={(e) => setSidebarForm(prev => ({ ...prev, display_link: e.target.checked ? (prev.display_link || ' ') : '' }))}
                  className="rounded border-navy/30 text-navy focus:ring-navy/20 w-3.5 h-3.5"
                />
                <span className="text-[11px] font-semibold text-textdark uppercase tracking-wider">Use a Display Link</span>
              </label>
              {sidebarForm.display_link !== '' && (
                <input
                  type="text"
                  value={sidebarForm.display_link.trim()}
                  onChange={(e) => setSidebarForm(prev => ({ ...prev, display_link: e.target.value }))}
                  className="input-apple text-[12px] w-full mt-1.5"
                  placeholder="e.g. yourbrand.com/offer"
                />
              )}
            </div>

            {/* ─── Call to Action ─── */}
            <div>
              <label className="text-[11px] font-semibold text-textdark uppercase tracking-wider">Call to Action</label>
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

            {/* ─── Facebook Page ─── */}
            <div>
              <label className="text-[11px] font-semibold text-textdark uppercase tracking-wider">Facebook Page</label>
              <input
                type="text"
                value={sidebarForm.facebook_page}
                onChange={(e) => setSidebarForm(prev => ({ ...prev, facebook_page: e.target.value }))}
                placeholder="e.g. My Brand Page"
                className="input-apple text-[12px] w-full mt-1.5"
              />
              <p className="text-[10px] text-textmid mt-1">The Facebook Page this ad will be posted from.</p>
            </div>

            {/* ─── Start Date ─── */}
            <div>
              <label className="text-[11px] font-semibold text-textdark uppercase tracking-wider">Start Date</label>
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

            {/* ─── Notes ─── */}
            <div className="border-t border-gray-100 pt-4 mt-4">
              <label className="text-[11px] text-textmid font-medium block mb-1">Notes <span className="text-textlight">(optional)</span></label>
              <textarea
                value={sidebarForm.notes}
                onChange={e => setSidebarForm(f => ({ ...f, notes: e.target.value }))}
                placeholder="Internal notes about this ad..."
                className="input-apple text-[12px] w-full mt-1 resize-none"
                rows={3}
              />
            </div>

            {/* ─── Campaign & Placement ─── */}
            <div className="border-t border-gray-100 pt-4 mt-4">
              <h4 className="text-[11px] font-bold text-textmid uppercase tracking-wider mb-3">Campaign & Placement</h4>

              {/* Campaign dropdown */}
              <label className="text-[11px] text-textmid font-medium">Campaign</label>
              <select
                value={sidebarForm.campaign_id}
                onChange={e => setSidebarForm(f => ({ ...f, campaign_id: e.target.value, new_campaign_name: '' }))}
                className="input-apple text-[12px] w-full mt-1"
              >
                <option value="">— Select Campaign —</option>
                {campaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                <option value="__new__">+ New Campaign</option>
              </select>

              {/* New campaign name (conditional) */}
              {sidebarForm.campaign_id === '__new__' && (
                <input
                  type="text"
                  placeholder="New campaign name..."
                  value={sidebarForm.new_campaign_name}
                  onChange={e => setSidebarForm(f => ({ ...f, new_campaign_name: e.target.value }))}
                  className="input-apple text-[12px] w-full mt-2"
                  autoFocus
                />
              )}

              {/* Ad Set text input */}
              <label className="text-[11px] text-textmid font-medium mt-3 block">Ad Set</label>
              <input
                type="text"
                placeholder="Ad set name..."
                value={sidebarForm.ad_set_name}
                onChange={e => setSidebarForm(f => ({ ...f, ad_set_name: e.target.value }))}
                className="input-apple text-[12px] w-full mt-1"
              />
              <p className="text-[9px] text-textlight mt-1">
                If an ad set with this name already exists in the selected campaign, the ad will be added to it. Otherwise a new ad set will be created.
              </p>

              {/* Duplicate Ad Set Name — optional field shown to employee in Ready to Post */}
              <label className="text-[11px] text-textmid font-medium mt-3 block">Duplicate Ad Set Called <span className="text-textlight">(optional)</span></label>
              <input
                type="text"
                placeholder="e.g. LAL Purchasers — New Creative"
                value={sidebarForm.duplicate_adset_name}
                onChange={e => setSidebarForm(f => ({ ...f, duplicate_adset_name: e.target.value }))}
                className="input-apple text-[12px] w-full mt-1"
              />
              <p className="text-[9px] text-textlight mt-1">
                If set, the employee will be told to duplicate the ad set above and rename the copy to this name. Useful when reusing an ad set's targeting settings with a new name.
              </p>
            </div>

            {/* ─── Save ─── */}
            <div className="pt-3 pb-6">
              <button
                onClick={() => handleSaveSidebar({ closeAfter: true })}
                disabled={sidebarSaving}
                className="btn-primary w-full text-[12px] py-2.5 disabled:opacity-50"
              >
                {sidebarSaving ? 'Saving...' : 'Save & Close'}
              </button>
            </div>

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
                      Duplicate {isFlex ? 'flexible ad' : 'ad'} for {duplicateConfirm.urls.length} URLs?
                    </p>
                    <p className="text-[11px] text-textmid mt-1">
                      {isFlex
                        ? `This will save the current flexible ad with the first URL, then duplicate all ${sidebarData?.deps?.length || 0} child ads for each extra URL — creating ${duplicateConfirm.urls.length - 1} new flexible ad${duplicateConfirm.urls.length > 2 ? 's' : ''}:`
                        : `This will save the current ad with the first URL, then create ${duplicateConfirm.urls.length - 1} duplicate${duplicateConfirm.urls.length > 2 ? 's' : ''} — each with a different website URL:`
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
                    onClick={() => handleSaveSidebar({ closeAfter: duplicateConfirm?.closeAfter })}
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

  const stagingItemCount = standaloneStagingDeps.length + stagingFlexAds.length;

  return (
    <div>
      {/* ═══════════ Two-Column Layout: Queue (left) | Staging (right) ═══════════ */}
      <div className="flex gap-5 items-start">

        {/* ─── Left Column: Queue ─── */}
        <div
          className={`w-[300px] flex-shrink-0 sticky top-4 card p-4 transition-all max-h-[calc(100vh-120px)] flex flex-col ${
            dropTarget === 'unplanned' ? 'ring-2 ring-gold bg-gold/5' : ''
          }`}
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDropTarget('unplanned'); }}
          onDragLeave={handleDragLeave}
          onDrop={handleDropOnUnplanned}
        >
          <div className="mb-3">
            <div className="flex items-center justify-between">
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
                <h3 className="text-[13px] font-semibold text-textdark">Queue</h3>
                <span className="text-[11px] text-textlight bg-black/5 px-2 py-0.5 rounded-full">
                  {unplannedDeps.length}
                </span>
              </div>
            </div>
            <p className="text-[10px] text-textmid mt-1 leading-relaxed">Newly deployed ads land here. Drag them to the staging area to start planning.</p>
          </div>

          {/* Queue selection toolbar */}
          {selectedUnplanned.size > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 mb-3 text-[10px] p-2.5 rounded-xl bg-navy/5 border border-navy/10">
              <span className="text-navy font-medium">{selectedUnplanned.size} selected</span>
              <button
                onClick={() => handleMoveToPlanner([...selectedUnplanned])}
                className="px-2 py-0.5 rounded-md bg-teal/10 border border-teal/20 text-teal font-medium hover:bg-teal/20 transition-colors"
              >
                Move to Planner
              </button>
              <button
                onClick={() => setDeleteConfirm({ open: true, ids: [...selectedUnplanned], source: 'unplanned' })}
                className="px-2 py-0.5 rounded-md bg-red-50 border border-red-200 text-red-600 hover:bg-red-100 transition-colors"
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

          {/* Queue items — scrollable */}
          <div className="flex-1 overflow-y-auto scrollbar-thin -mx-1 px-1">
            {unplannedDeps.length === 0 ? (
              <div className="py-8 text-center">
                <p className="text-[11px] text-textlight">
                  No ads in queue. Deploy ads from Ad Studio to get started.
                </p>
              </div>
            ) : (
              <div className="space-y-1.5">
                {unplannedDeps.map(dep => renderDepCard(dep, { isDraggable: true }))}
              </div>
            )}
          </div>
        </div>

        {/* ─── Right Column: Staging Area ─── */}
        <div
          className={`flex-1 min-w-0 card p-4 transition-all ${
            dropTarget === 'staging' ? 'ring-2 ring-gold bg-gold/5' : ''
          }`}
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDropTarget('staging'); }}
          onDragLeave={handleDragLeave}
          onDrop={handleDropOnStaging}
        >
          {/* Header */}
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <div>
                <h3 className="text-[14px] font-semibold text-textdark">Planner</h3>
                <p className="text-[11px] text-textmid mt-0.5">Drag ads here to start planning. Click to fill in details and assign a campaign.</p>
              </div>
              {undoState && (
                <button
                  onClick={handleUndo}
                  className="ml-2 px-3 py-1 text-[11px] font-medium bg-navy/5 hover:bg-navy/10 text-navy rounded-full transition-colors flex items-center gap-1.5 whitespace-nowrap"
                  title="Undo (Cmd+Z)"
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h10a5 5 0 015 5v2M3 10l4-4M3 10l4 4" />
                  </svg>
                  Undo {undoState.label}
                </button>
              )}
            </div>
            <span className="text-[11px] text-textlight bg-black/5 px-2 py-0.5 rounded-full">
              {stagingItemCount} item{stagingItemCount !== 1 ? 's' : ''}
            </span>
          </div>

          {/* Staging toolbar — when items selected */}
          {selectedInStaging.size > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 mb-3 text-[10px] p-2.5 rounded-xl bg-navy/5 border border-navy/10">
              {/* Select All */}
              <button
                onClick={toggleSelectAllStaging}
                className={`w-[14px] h-[14px] rounded flex-shrink-0 flex items-center justify-center transition-colors ${
                  selectedInStaging.size === stagingItemCount && stagingItemCount > 0
                    ? 'bg-navy'
                    : selectedInStaging.size > 0
                      ? 'bg-navy/50'
                      : 'border-[1.5px] border-textlight/60 hover:border-navy/40'
                }`}
              >
                {selectedInStaging.size > 0 && (
                  <svg className="w-2 h-2 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d={
                      selectedInStaging.size === stagingItemCount ? "M5 13l4 4L19 7" : "M5 12h14"
                    } />
                  </svg>
                )}
              </button>
              <span className="text-navy font-medium">{selectedInStaging.size} selected</span>
              {selectedInStaging.size >= 2 && (
                <button
                  onClick={handleCombineIntoFlex}
                  disabled={combiningFlex}
                  className="px-2 py-1 rounded-lg bg-navy text-white hover:bg-navy-light transition-colors inline-flex items-center gap-1 disabled:opacity-50"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2z" />
                  </svg>
                  {combiningFlex ? 'Creating...' : 'Flex'}
                </button>
              )}
              <button
                onClick={() => handleMarkReadyToPost([...selectedInStaging])}
                className="px-2 py-1 rounded-lg bg-teal/10 border border-teal/30 text-teal font-medium hover:bg-teal/20 transition-colors inline-flex items-center gap-1"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                Ready to Post
              </button>
              <button
                onClick={() => handleMoveToQueue([...selectedInStaging])}
                className="px-2 py-1 rounded-lg bg-white border border-gray-200 text-textmid hover:bg-gray-50 transition-colors"
              >
                Move to Queue
              </button>
              <button
                onClick={() => setDeleteConfirm({ open: true, ids: [...selectedInStaging], source: 'staging' })}
                className="px-2 py-1 rounded-lg bg-red-50 border border-red-200 text-red-600 hover:bg-red-100 transition-colors"
              >
                Delete
              </button>
              <button
                onClick={() => setSelectedInStaging(new Set())}
                className="text-textlight hover:text-textmid ml-1"
              >
                Clear
              </button>
            </div>
          )}

          {/* Staging content */}
          {stagingItemCount === 0 ? (
            <div className={`py-12 text-center rounded-xl border-2 border-dashed transition-colors ${
              dropTarget === 'staging' ? 'border-gold bg-gold/10' : 'border-gray-200'
            }`}>
              <div className="w-12 h-12 rounded-2xl bg-navy/5 flex items-center justify-center mx-auto mb-3">
                <svg className="w-6 h-6 text-textlight" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                </svg>
              </div>
              <p className="text-[13px] text-textlight">
                {dropTarget === 'staging' ? 'Drop ads here' : 'Drag ads from Queue to start planning'}
              </p>
            </div>
          ) : (
            <div className="space-y-1.5">
              {/* Flex ads first */}
              {stagingFlexAds.map(flexAd => renderFlexAdCard(flexAd))}
              {/* Standalone deployments */}
              {standaloneStagingDeps.map(dep => renderDepCard(dep, { isDraggable: true, inStaging: true }))}
            </div>
          )}
        </div>
      </div>{/* end flex container */}

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
                This will remove the selected ads from the Ad Pipeline. The original ad creatives will remain in Ad Studio.
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

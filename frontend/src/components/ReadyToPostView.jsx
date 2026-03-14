import { useState, useEffect, useCallback, useRef } from 'react';
import JSZip from 'jszip';
import { api } from '../api';
import { ensureArray } from '../utils/collections';

/**
 * ReadyToPostView — Employee-facing view for posting ads to Meta Ads Manager.
 *
 * Designed to be extremely clear for employees who may not be familiar with
 * Meta's interface. Every section is explicitly labeled with plain-English
 * descriptions and helper text explaining where things go in Ads Manager.
 *
 * Props: projectId, deployments, setDeployments, addToast, loadDeployments, onSwitchToPlanner
 */
export default function ReadyToPostView({ projectId, deployments, setDeployments, addToast, loadDeployments, onSwitchToPlanner, isPoster, highlightFlexAdId, onHighlightDone }) {
  const [campaigns, setCampaigns] = useState([]);
  const [adSets, setAdSets] = useState([]);
  const [flexAds, setFlexAds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [confirmPosted, setConfirmPosted] = useState(null);
  const [markingPostedIds, setMarkingPostedIds] = useState(new Set());
  const [sendingBackIds, setSendingBackIds] = useState(new Set());
  const [bulkMarkingAll, setBulkMarkingAll] = useState(false);
  const [selectedImages, setSelectedImages] = useState({});
  const [downloadingAll, setDownloadingAll] = useState(new Set());
  const [downloadingSelected, setDownloadingSelected] = useState(new Set());
  const [downloadingSingle, setDownloadingSingle] = useState(new Set());
  const [expandedCards, setExpandedCards] = useState(new Set());
  const [loadError, setLoadError] = useState(null);
  const [copiedItems, setCopiedItems] = useState(new Set()); // Track copied primary texts / headlines by "cardKey-section-index"
  const [editingNotes, setEditingNotes] = useState(null); // cardKey of the card whose notes are being edited
  const [notesValue, setNotesValue] = useState(''); // current textarea value
  const [savingNotes, setSavingNotes] = useState(false);
  const [editingCard, setEditingCard] = useState(null); // cardKey of card being edited (admin only)
  const [editFields, setEditFields] = useState({}); // temp edit values
  const [savingEdit, setSavingEdit] = useState(false);
  const [sortBy, setSortBy] = useState('newest');

  // Highlight + scroll to flex ad from deep link
  const [highlightedId, setHighlightedId] = useState(highlightFlexAdId || null);
  const highlightRef = useRef(null);

  useEffect(() => {
    if (highlightedId && highlightRef.current && !loading) {
      highlightRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Clear highlight after animation
      const timer = setTimeout(() => {
        setHighlightedId(null);
        onHighlightDone?.();
      }, 2500);
      return () => clearTimeout(timer);
    }
  }, [highlightedId, loading, flexAds]);

  const toggleCardExpanded = (key) => {
    setExpandedCards(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  useEffect(() => { loadData(); }, [projectId]);

  const loadData = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [campData, flexData] = await Promise.all([
        api.getCampaigns(projectId),
        api.getFlexAds(projectId),
      ]);
      setCampaigns(ensureArray(campData?.campaigns, 'ReadyToPostView.campaigns'));
      setAdSets(ensureArray(campData?.adSets, 'ReadyToPostView.adSets'));
      setFlexAds(ensureArray(flexData?.flexAds, 'ReadyToPostView.flexAds'));
    } catch (err) {
      console.error('ReadyToPostView loadData error:', err);
      setLoadError('Failed to load campaign data. Please refresh the page.');
    }
    setLoading(false);
  };

  const safeDeployments = ensureArray(deployments, 'ReadyToPostView.deployments');
  const safeCampaigns = ensureArray(campaigns, 'ReadyToPostView.campaignsState');
  const safeAdSets = ensureArray(adSets, 'ReadyToPostView.adSetsState');
  const safeFlexAds = ensureArray(flexAds, 'ReadyToPostView.flexAdsState');
  const readyDeps = safeDeployments.filter(d => d.status === 'ready_to_post');

  // ── Helpers ──────────────────────────────────────────────────────────────

  const resolveLocation = (dep) => {
    const adSet = safeAdSets.find(a => a.id === dep.local_adset_id);
    if (!adSet) return { campaignName: null, adSetName: null };
    const campaign = safeCampaigns.find(c => safeAdSets.filter(a => a.campaign_id === c.id).some(a => a.id === dep.local_adset_id));
    return { campaignName: campaign?.name || null, adSetName: adSet?.name || null };
  };

  const resolveFlexLocation = (flexAd) => {
    const adSet = safeAdSets.find(a => a.id === flexAd.ad_set_id);
    if (!adSet) return { campaignName: null, adSetName: null };
    const campaign = safeCampaigns.find(c => safeAdSets.filter(a => a.campaign_id === c.id).some(a => a.id === flexAd.ad_set_id));
    return { campaignName: campaign?.name || null, adSetName: adSet?.name || null };
  };

  const getFlexChildDeps = (flexAd) => {
    let childIds = [];
    try { childIds = flexAd.child_deployment_ids ? JSON.parse(flexAd.child_deployment_ids) : []; } catch { /* ignore */ }
    return readyDeps.filter(d => childIds.includes(d.id));
  };

  const flexHasReadyChildren = (flexAd) => getFlexChildDeps(flexAd).length > 0;

  const copyToClipboard = async (text, label) => {
    try { await navigator.clipboard.writeText(text); addToast(`${label} copied`, 'success'); }
    catch { addToast('Failed to copy', 'error'); }
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return null;
    try {
      const d = new Date(dateStr);
      return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) +
        ' at ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    } catch { return dateStr; }
  };

  const formatAddedDate = (dateStr) => {
    if (!dateStr) return null;
    try {
      const d = new Date(dateStr);
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
        ' at ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    } catch { return null; }
  };

  const parseCount = (jsonStr) => {
    try { return JSON.parse(jsonStr).filter(Boolean).length; } catch { return 0; }
  };

  // ── Notes ──────────────────────────────────────────────────────────────

  const startEditingNotes = (cardKey, currentNotes) => {
    setEditingNotes(cardKey);
    setNotesValue(currentNotes || '');
  };

  const saveNotes = async (id, isFlexCard = false) => {
    setSavingNotes(true);
    try {
      if (isFlexCard) {
        await api.updateFlexAd(id, { notes: notesValue.trim() || '' });
        setFlexAds(prev => ensureArray(prev, 'ReadyToPostView.flexAdsState').map(f => f.id === id ? { ...f, notes: notesValue.trim() || '' } : f));
      } else {
        await api.updateDeployment(id, { notes: notesValue.trim() || '' });
        setDeployments(prev => ensureArray(prev, 'ReadyToPostView.deploymentsState').map(d => d.id === id ? { ...d, notes: notesValue.trim() || '' } : d));
      }
      addToast('Notes saved', 'success');
    } catch {
      addToast('Failed to save notes', 'error');
    }
    setSavingNotes(false);
    setEditingNotes(null);
  };

  // ── Actions ──────────────────────────────────────────────────────────────

  const handleMarkPosted = async (depId) => {
    // Optimistic UI update — immediate feedback
    const dep = readyDeps.find(d => d.id === depId);
    const { campaignName, adSetName } = dep ? resolveLocation(dep) : {};
    setDeployments(prev => ensureArray(prev, 'ReadyToPostView.deploymentsState').map(d => {
      if (d.id !== depId) return d;
      return {
        ...d,
        status: 'posted',
        posted_date: new Date().toISOString(),
        ...(campaignName ? { campaign_name: campaignName } : {}),
        ...(adSetName ? { ad_set_name: adSetName } : {}),
        ...(dep?.destination_url ? { landing_page_url: dep.destination_url } : {}),
      };
    }));
    addToast('Marked as posted', 'success');
    setConfirmPosted(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });

    // API calls in background
    try {
      const carryOverFields = {};
      if (campaignName) carryOverFields.campaign_name = campaignName;
      if (adSetName) carryOverFields.ad_set_name = adSetName;
      if (dep?.destination_url) carryOverFields.landing_page_url = dep.destination_url;
      // Fire both calls in parallel
      await Promise.all([
        Object.keys(carryOverFields).length > 0 ? api.updateDeployment(depId, carryOverFields) : Promise.resolve(),
        api.updateDeploymentStatus(depId, 'posted'),
      ]);
    } catch {
      addToast('Failed to save posted status — refreshing...', 'error');
      loadDeployments();
    }
  };

  const handleMarkFlexPosted = async (flexAd) => {
    // Optimistic UI update — immediate feedback
    const childDeps = getFlexChildDeps(flexAd);
    const { campaignName, adSetName } = resolveFlexLocation(flexAd);
    let childIds = [];
    try { childIds = flexAd.child_deployment_ids ? JSON.parse(flexAd.child_deployment_ids) : []; } catch { /* ignore */ }
    setDeployments(prev => ensureArray(prev, 'ReadyToPostView.deploymentsState').map(d => {
      if (!childIds.includes(d.id)) return d;
      return {
        ...d,
        status: 'posted',
        posted_date: new Date().toISOString(),
        ...(campaignName ? { campaign_name: campaignName } : {}),
        ...(adSetName ? { ad_set_name: adSetName } : {}),
        ...(flexAd.destination_url ? { landing_page_url: flexAd.destination_url } : {}),
      };
    }));
    addToast(`${childDeps.length} ads marked as posted`, 'success');
    setConfirmPosted(null);
    window.scrollTo({ top: 0, behavior: 'smooth' });

    // API calls in background — all in parallel
    try {
      const carryOverFields = {};
      if (campaignName) carryOverFields.campaign_name = campaignName;
      if (adSetName) carryOverFields.ad_set_name = adSetName;
      if (flexAd.destination_url) carryOverFields.landing_page_url = flexAd.destination_url;
      await Promise.all(childDeps.map(d =>
        Promise.all([
          Object.keys(carryOverFields).length > 0 ? api.updateDeployment(d.id, carryOverFields) : Promise.resolve(),
          api.updateDeploymentStatus(d.id, 'posted'),
        ])
      ));
    } catch {
      addToast('Failed to save posted status — refreshing...', 'error');
      loadDeployments();
    }
  };

  const handleSendBack = async (depId) => {
    // Optimistic UI update
    setDeployments(prev => ensureArray(prev, 'ReadyToPostView.deploymentsState').map(d => d.id === depId ? { ...d, status: 'selected' } : d));
    addToast('Sent back to Planner', 'success');
    try {
      await api.updateDeploymentStatus(depId, 'selected');
    } catch {
      addToast('Failed to send back — refreshing...', 'error');
      loadDeployments();
    }
  };

  const handleSendBackFlex = async (flexAd) => {
    // Optimistic UI update
    let childIds = [];
    try { childIds = flexAd.child_deployment_ids ? JSON.parse(flexAd.child_deployment_ids) : []; } catch { /* ignore */ }
    setDeployments(prev => ensureArray(prev, 'ReadyToPostView.deploymentsState').map(d => {
      if (childIds.includes(d.id)) return { ...d, status: 'selected' };
      return d;
    }));
    addToast('Sent back to Planner', 'success');
    try {
      const childDeps = getFlexChildDeps(flexAd);
      await Promise.all(childDeps.map(d => api.updateDeploymentStatus(d.id, 'selected')));
    } catch {
      addToast('Failed to send back — refreshing...', 'error');
      loadDeployments();
    }
  };

  const handleBulkMarkAllPosted = async () => {
    if (readyDeps.length === 0) return;
    setBulkMarkingAll(true);
    try {
      await Promise.all(readyDeps.map(d => api.updateDeploymentStatus(d.id, 'posted')));
      setDeployments(prev => ensureArray(prev, 'ReadyToPostView.deploymentsState').map(d =>
        d.status === 'ready_to_post' ? { ...d, status: 'posted', posted_date: new Date().toISOString() } : d
      ));
      addToast(`${readyDeps.length} ads marked as posted`, 'success');
    } catch { addToast('Failed to update some ads', 'error'); }
    setBulkMarkingAll(false);
  };

  // ── Posted By ──────────────────────────────────────────────────────────────

  const handlePostedByChange = async (depId, value, isFlex = false) => {
    try {
      if (isFlex) {
        await api.updateFlexAdPostedBy(depId, value || '');
        setFlexAds(prev => ensureArray(prev, 'ReadyToPostView.flexAdsState').map(f => f.id === depId ? { ...f, posted_by: value } : f));
      } else {
        await api.updateDeploymentPostedBy(depId, value || '');
        setDeployments(prev => ensureArray(prev, 'ReadyToPostView.deploymentsState').map(d => d.id === depId ? { ...d, posted_by: value } : d));
      }
    } catch {
      addToast('Failed to save', 'error');
    }
  };

  // ── Admin Edit Helpers ──────────────────────────────────────────────────────

  const startEditing = (cardKey, data, isFlex = false) => {
    // Resolve current campaign ID and ad set name
    let currentCampaignId = '';
    let currentAdSetName = '';
    if (isFlex) {
      const adSet = safeAdSets.find(a => a.id === data.ad_set_id);
      if (adSet) {
        currentCampaignId = safeCampaigns.find(c => safeAdSets.filter(a => a.campaign_id === c.id).some(a => a.id === data.ad_set_id))?.id || '';
        currentAdSetName = adSet.name || '';
      }
    } else {
      currentCampaignId = data.local_campaign_id || '';
      const adSet = safeAdSets.find(a => a.id === data.local_adset_id);
      currentAdSetName = adSet?.name || '';
    }

    const fields = isFlex
      ? {
          name: data.name || '',
          _campaign_id: currentCampaignId,
          _ad_set_name: currentAdSetName,
          ad_set_id: data.ad_set_id || '',
          destination_url: data.destination_url || '',
          display_link: data.display_link || '',
          cta_button: data.cta_button || '',
          facebook_page: data.facebook_page || '',
          duplicate_adset_name: data.duplicate_adset_name || '',
          primary_texts: (() => { try { return JSON.parse(data.primary_texts || '[]').filter(Boolean); } catch { return []; } })(),
          headlines: (() => { try { return JSON.parse(data.headlines || '[]').filter(Boolean); } catch { return []; } })(),
        }
      : {
          ad_name: data.ad_name || data.ad?.headline || '',
          local_campaign_id: currentCampaignId,
          _ad_set_name: currentAdSetName,
          local_adset_id: data.local_adset_id || '',
          destination_url: data.destination_url || '',
          display_link: data.display_link || '',
          cta_button: data.cta_button || '',
          facebook_page: data.facebook_page || '',
          duplicate_adset_name: data.duplicate_adset_name || '',
          primary_texts: (() => { try { return JSON.parse(data.primary_texts || '[]').filter(Boolean); } catch { return []; } })(),
          ad_headlines: (() => { try { return JSON.parse(data.ad_headlines || '[]').filter(Boolean); } catch { return []; } })(),
        };
    setEditFields(fields);
    setEditingCard(cardKey);
  };

  const saveEditing = async (id, isFlex = false) => {
    setSavingEdit(true);
    try {
      const payload = { ...editFields };
      const newCampaignId = isFlex ? payload._campaign_id : payload.local_campaign_id;
      const adSetNameTyped = (payload._ad_set_name || '').trim();

      // Validate: if campaign selected, ad set name is required
      if (newCampaignId && !adSetNameTyped) {
        addToast('Please enter an ad set name', 'error');
        setSavingEdit(false);
        return;
      }

      // Remove helper fields that aren't real DB fields
      delete payload._campaign_id;
      delete payload._ad_set_name;

      // Serialize arrays back to JSON strings
      if (isFlex) {
        payload.primary_texts = JSON.stringify(payload.primary_texts.filter(Boolean));
        payload.headlines = JSON.stringify(payload.headlines.filter(Boolean));
      } else {
        payload.primary_texts = JSON.stringify(payload.primary_texts.filter(Boolean));
        payload.ad_headlines = JSON.stringify(payload.ad_headlines.filter(Boolean));
      }

      // Resolve ad set: find or create by name under the selected campaign
      const adSetKey = isFlex ? 'ad_set_id' : 'local_adset_id';
      const currentAdSetId = payload[adSetKey] || '';

      if (newCampaignId && adSetNameTyped) {
        // Look for existing ad set by name under this campaign
        const existingAdSet = safeAdSets.find(a => a.campaign_id === newCampaignId && a.name === adSetNameTyped);
        if (existingAdSet) {
          payload[adSetKey] = existingAdSet.id;
        } else {
          // Check if the current ad set just needs to be moved to the new campaign
          const currentAdSet = currentAdSetId ? safeAdSets.find(a => a.id === currentAdSetId) : null;
          if (currentAdSet && currentAdSet.name === adSetNameTyped && currentAdSet.campaign_id !== newCampaignId) {
            // Move existing ad set to new campaign
            await api.updateAdSet(currentAdSetId, { campaign_id: newCampaignId });
            setAdSets(prev => ensureArray(prev, 'ReadyToPostView.adSetsState').map(a => a.id === currentAdSetId ? { ...a, campaign_id: newCampaignId } : a));
            payload[adSetKey] = currentAdSetId;
          } else {
            // Create new ad set under the new campaign
            const result = await api.createAdSet(newCampaignId, adSetNameTyped, projectId);
            const newAdSetId = result.id;
            setAdSets(prev => [...ensureArray(prev, 'ReadyToPostView.adSetsState'), { id: newAdSetId, name: adSetNameTyped, campaign_id: newCampaignId, project_id: projectId }]);
            payload[adSetKey] = newAdSetId;
          }
        }
      }

      // For non-flex ads, ensure local_campaign_id is set
      if (!isFlex && newCampaignId) {
        payload.local_campaign_id = newCampaignId;
      }

      if (isFlex) {
        await api.updateFlexAd(id, payload);
        setFlexAds(prev => ensureArray(prev, 'ReadyToPostView.flexAdsState').map(f => f.id === id ? { ...f, ...payload } : f));
      } else {
        await api.updateDeployment(id, payload);
        setDeployments(prev => ensureArray(prev, 'ReadyToPostView.deploymentsState').map(d => d.id === id ? { ...d, ...payload } : d));
      }
      addToast('Changes saved', 'success');

      // Collapse the card after saving
      setExpandedCards(prev => {
        const next = new Set(prev);
        const cardKey = isFlex ? `flex-${id}` : id;
        next.delete(cardKey);
        return next;
      });
      setEditingCard(null);
      setEditFields({});

      // Don't call loadData() here — it sets loading=true which remounts the whole view.
      // Local state updates above (setFlexAds/setAdSets/setDeployments) are sufficient.
    } catch (err) {
      console.error('Failed to save editing:', err);
      addToast('Failed to save changes', 'error');
    }
    setSavingEdit(false);
  };

  const updateEditField = (key, value) => {
    setEditFields(prev => ({ ...prev, [key]: value }));
  };

  const updateEditArrayItem = (key, index, value) => {
    setEditFields(prev => {
      const arr = [...(prev[key] || [])];
      arr[index] = value;
      return { ...prev, [key]: arr };
    });
  };

  const addEditArrayItem = (key) => {
    setEditFields(prev => ({ ...prev, [key]: [...(prev[key] || []), ''] }));
  };

  const removeEditArrayItem = (key, index) => {
    setEditFields(prev => {
      const arr = [...(prev[key] || [])];
      arr.splice(index, 1);
      return { ...prev, [key]: arr };
    });
  };

  // Pencil icon for edit button
  const EditPencilIcon = () => (
    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
    </svg>
  );

  // CTA options for dropdown
  const ctaOptions = ['SHOP_NOW', 'LEARN_MORE', 'SIGN_UP', 'SUBSCRIBE', 'DOWNLOAD', 'GET_OFFER', 'ORDER_NOW', 'BUY_NOW', 'BOOK_NOW', 'CONTACT_US', 'APPLY_NOW', 'GET_QUOTE', 'WATCH_MORE', 'SEND_MESSAGE', 'NO_BUTTON'];

  // ── Download Helpers ──────────────────────────────────────────────────────

  const downloadSingleImage = async (dep) => {
    if (!dep.imageUrl) return;
    setDownloadingSingle(prev => new Set(prev).add(dep.id));
    try {
      const response = await fetch(dep.imageUrl);
      const blob = await response.blob();
      const ext = blob.type === 'image/jpeg' ? '.jpg' : '.png';
      const name = (dep.ad_name || dep.ad?.headline || dep.id || 'ad').replace(/[^a-z0-9]/gi, '-').slice(0, 40);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = `${name}${ext}`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch { addToast('Failed to download image', 'error'); }
    setDownloadingSingle(prev => { const next = new Set(prev); next.delete(dep.id); return next; });
  };

  const downloadMultipleImages = async (depsToDownload, cardKey) => {
    const withImages = depsToDownload.filter(d => d.imageUrl);
    if (withImages.length === 0) { addToast('No images to download', 'error'); return; }
    if (withImages.length === 1) { await downloadSingleImage(withImages[0]); return; }
    const stateSet = cardKey.startsWith('selected-') ? setDownloadingSelected : setDownloadingAll;
    const stateKey = cardKey.replace('selected-', '');
    stateSet(prev => new Set(prev).add(stateKey));
    try {
      const results = await Promise.allSettled(withImages.map(async (dep) => {
        const res = await fetch(dep.imageUrl); const blob = await res.blob();
        const ext = blob.type === 'image/jpeg' ? '.jpg' : '.png';
        return { dep, blob, ext };
      }));
      const fulfilled = results.filter(r => r.status === 'fulfilled').map(r => r.value);
      if (fulfilled.length === 0) { addToast('Failed to download images', 'error'); return; }
      const zip = new JSZip(); const usedNames = new Set();
      for (const { dep, blob, ext } of fulfilled) {
        let baseName = (dep.ad_name || dep.ad?.headline || dep.id || 'ad').replace(/[^a-z0-9]/gi, '-').slice(0, 40);
        let fileName = `${baseName}${ext}`; let counter = 1;
        while (usedNames.has(fileName)) { fileName = `${baseName}-${counter}${ext}`; counter++; }
        usedNames.add(fileName); zip.file(fileName, blob);
      }
      const content = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(content);
      const a = document.createElement('a'); a.href = url; a.download = `ad-creatives-${fulfilled.length}.zip`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      addToast(`Downloaded ${fulfilled.length} images`, 'success');
    } catch { addToast('Failed to create ZIP', 'error'); }
    stateSet(prev => { const next = new Set(prev); next.delete(stateKey); return next; });
  };

  const toggleImageSelection = (cardKey, depId) => {
    setSelectedImages(prev => {
      const current = prev[cardKey] || new Set(); const next = new Set(current);
      if (next.has(depId)) next.delete(depId); else next.add(depId);
      return { ...prev, [cardKey]: next };
    });
  };

  const toggleSelectAll = (cardKey, allDepIds) => {
    setSelectedImages(prev => {
      const current = prev[cardKey] || new Set();
      const allSelected = allDepIds.every(id => current.has(id));
      return { ...prev, [cardKey]: allSelected ? new Set() : new Set(allDepIds) };
    });
  };

  // ── Reusable UI ──────────────────────────────────────────────────────────

  const CopyBtn = ({ text, label, small }) => {
    if (!text || text.trim() === '' || text === '[]') return null;
    return (
      <button onClick={(e) => { e.stopPropagation(); copyToClipboard(text, label); }}
        className={`inline-flex items-center gap-1 rounded-md bg-navy/5 text-navy font-medium hover:bg-navy/10 transition-colors flex-shrink-0 ${
          small ? 'px-1.5 py-0.5 text-[9px]' : 'px-2 py-1 text-[10px]'
        }`}>
        <svg className={small ? 'w-2.5 h-2.5' : 'w-3 h-3'} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
        {label}
      </button>
    );
  };

  // Section label — big, clear, consistent
  const SectionLabel = ({ children, helper }) => (
    <div className="mb-2">
      <div className="text-[13px] font-bold text-textdark">{children}</div>
      {helper && <p className="text-[11px] text-textmid mt-0.5 leading-relaxed">{helper}</p>}
    </div>
  );

  // Render numbered text items with copy-tracking strikethrough
  const renderNumberedTexts = (jsonStr, sectionLabel, helper, cardKey, sectionId) => {
    let items = [];
    try { items = JSON.parse(jsonStr); } catch { return null; }
    items = items.filter(Boolean);
    if (items.length === 0) return null;
    const allText = items.join('\n\n');
    const allCopied = items.every((_, i) => copiedItems.has(`${cardKey}-${sectionId}-${i}`));

    const handleCopyItem = (text, label, index) => {
      copyToClipboard(text, label);
      setCopiedItems(prev => new Set(prev).add(`${cardKey}-${sectionId}-${index}`));
    };

    const handleCopyAll = () => {
      copyToClipboard(allText, 'All ' + sectionId);
      // Mark all items as copied
      const next = new Set(copiedItems);
      items.forEach((_, i) => next.add(`${cardKey}-${sectionId}-${i}`));
      setCopiedItems(next);
    };

    return (
      <div className="border border-black/[0.06] rounded-xl p-4 bg-white">
        <div className="flex items-start justify-between gap-3 mb-2">
          <div>
            <span className="inline-block px-2 py-0.5 rounded bg-navy/10 text-navy text-[10px] font-bold uppercase tracking-widest mb-1">{sectionLabel}</span>
            {helper && <p className="text-[11px] text-textmid mt-0.5 leading-relaxed">{helper}</p>}
          </div>
          <button onClick={(e) => { e.stopPropagation(); handleCopyAll(); }}
            className={`inline-flex items-center gap-1 rounded-md font-medium hover:bg-navy/10 transition-colors flex-shrink-0 px-2 py-1 text-[10px] ${
              allCopied ? 'bg-teal/10 text-teal' : 'bg-navy/5 text-navy'
            }`}>
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              {allCopied ? (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              )}
            </svg>
            {allCopied ? 'All Copied' : 'Copy All'}
          </button>
        </div>
        <div className="space-y-2">
          {items.map((text, i) => {
            const itemKey = `${cardKey}-${sectionId}-${i}`;
            const isCopied = copiedItems.has(itemKey);
            return (
              <div key={i} className={`flex items-start gap-2.5 rounded-lg p-3 transition-all duration-300 ${isCopied ? 'bg-teal/5 border border-teal/10' : 'bg-offwhite'}`}>
                <span className={`text-[12px] font-bold rounded-full w-6 h-6 flex items-center justify-center flex-shrink-0 mt-0.5 transition-colors duration-300 ${
                  isCopied ? 'bg-teal text-white' : 'bg-navy text-white'
                }`}>{isCopied ? '✓' : i + 1}</span>
                <div className={`flex-1 text-[13px] whitespace-pre-wrap leading-relaxed transition-all duration-300 ${
                  isCopied ? 'line-through text-textmid/60 decoration-teal/40' : 'text-textdark'
                }`}>{text}</div>
                <button onClick={(e) => { e.stopPropagation(); handleCopyItem(text, 'Copy', i); }}
                  className={`inline-flex items-center gap-1 rounded-md font-medium transition-colors flex-shrink-0 px-1.5 py-0.5 text-[9px] ${
                    isCopied ? 'bg-teal/10 text-teal hover:bg-teal/15' : 'bg-navy/5 text-navy hover:bg-navy/10'
                  }`}>
                  <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    {isCopied ? (
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    ) : (
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    )}
                  </svg>
                  {isCopied ? 'Copied' : 'Copy'}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // ── Card Sections ──────────────────────────────────────────────────────

  // Top info bar: Ad Name, Ad Format, Start Date — color-coded labels
  const InfoBar = ({ name, adFormat, plannedDate }) => (
    <div className="bg-navy/[0.04] border-b border-black/[0.08] px-5 py-4 space-y-3">
      {/* Ad Name */}
      <div>
        <span className="inline-block px-2 py-0.5 rounded bg-navy/10 text-navy text-[10px] font-bold uppercase tracking-widest mb-1">Ad Name</span>
        <div className="text-[17px] font-bold text-textdark leading-tight">{name}</div>
      </div>
      {/* Ad Format + Date row */}
      <div className="flex flex-wrap items-start gap-5">
        <div>
          <span className="inline-block px-2 py-0.5 rounded bg-navy/10 text-navy text-[10px] font-bold uppercase tracking-widest mb-1">Ad Format</span>
          <div className="text-[14px] font-bold text-textdark">{adFormat}</div>
        </div>
        {plannedDate && (
          <div>
            <span className="inline-block px-2 py-0.5 rounded bg-teal/10 text-teal text-[10px] font-bold uppercase tracking-widest mb-1">Start Date</span>
            <div className="text-[14px] font-bold text-textdark">{plannedDate}</div>
          </div>
        )}
      </div>
    </div>
  );

  // Copy button with crossout tracking — for ad set name, rename, and ad name rows
  const CopyTrackBtn = ({ itemKey, text, label }) => {
    const isCopied = copiedItems.has(itemKey);
    const handleCopy = (e) => {
      e.stopPropagation();
      copyToClipboard(text, label);
      setCopiedItems(prev => new Set(prev).add(itemKey));
    };
    return (
      <button onClick={handleCopy}
        className={`inline-flex items-center gap-1 rounded-md font-medium transition-colors flex-shrink-0 px-1.5 py-0.5 text-[9px] ${
          isCopied ? 'bg-teal/10 text-teal hover:bg-teal/15' : 'bg-navy/5 text-navy hover:bg-navy/10'
        }`}>
        <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          {isCopied ? (
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          ) : (
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          )}
        </svg>
        {isCopied ? 'Copied' : 'Copy'}
      </button>
    );
  };

  // "Post in" section: Campaign + Ad Set + optional Duplicate Ad Set Name + Ad Name
  const PostInSection = ({ campaignName, adSetName, duplicateAdSetName, adName, cardKey }) => {
    if (!campaignName && !adSetName) {
      return (
        <div className="bg-gold/10 border-2 border-gold/30 rounded-xl p-4">
          <div className="flex items-center gap-2 mb-1">
            <svg className="w-5 h-5 text-gold" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
            <span className="text-[13px] font-bold text-gold">Not Assigned to a Campaign</span>
          </div>
          <p className="text-[12px] text-textmid">This ad hasn't been assigned to a campaign and ad set yet. Send it back to the Planner to assign it.</p>
        </div>
      );
    }

    const adsetKey = `${cardKey}-adset`;
    const renameKey = `${cardKey}-adset-rename`;
    const adnameKey = `${cardKey}-adname`;
    const adsetCopied = copiedItems.has(adsetKey);
    const renameCopied = copiedItems.has(renameKey);
    const adnameCopied = copiedItems.has(adnameKey);

    return (
      <div className="bg-navy/5 border-2 border-navy/15 rounded-xl p-4">
        <span className="inline-block px-2 py-0.5 rounded bg-navy text-white text-[10px] font-bold uppercase tracking-widest mb-3">Post This Ad In</span>
        <div className="space-y-2.5">
          <div className="flex items-center gap-3">
            <span className="inline-block px-2 py-0.5 rounded bg-navy/10 text-navy text-[10px] font-bold uppercase tracking-wider w-20 text-center flex-shrink-0">Campaign</span>
            <span className="text-[15px] font-bold text-textdark">{campaignName}</span>
          </div>
          <div className="flex items-center gap-3">
            <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider text-center flex-shrink-0 ${duplicateAdSetName ? 'bg-gold/15 text-gold' : 'bg-navy/10 text-navy w-20'}`} style={duplicateAdSetName ? { minWidth: '5rem' } : undefined}>{duplicateAdSetName ? 'Duplicate This Ad Set' : 'Ad Set'}</span>
            <span className={`text-[15px] font-bold flex-1 transition-all duration-300 ${adsetCopied ? 'line-through text-textmid/60 decoration-teal/40' : 'text-textdark'}`}>{duplicateAdSetName || adSetName}</span>
            <CopyTrackBtn itemKey={adsetKey} text={duplicateAdSetName || adSetName} label="Ad Set Name" />
          </div>
          {duplicateAdSetName && (
            <div className="flex items-center gap-3">
              <span className="inline-block px-2 py-0.5 rounded bg-gold/15 text-gold text-[10px] font-bold uppercase tracking-wider flex-shrink-0" style={{ minWidth: '5rem', textAlign: 'center' }}>Rename the Duplicated Ad Set</span>
              <span className={`text-[15px] font-bold flex-1 transition-all duration-300 ${renameCopied ? 'line-through text-textmid/60 decoration-teal/40' : 'text-textdark'}`}>{adSetName}</span>
              <CopyTrackBtn itemKey={renameKey} text={adSetName} label="Rename Ad Set" />
            </div>
          )}
          {adName && (
            <div className="flex items-center gap-3">
              <span className="inline-block px-2 py-0.5 rounded bg-navy/10 text-navy text-[10px] font-bold uppercase tracking-wider w-20 text-center flex-shrink-0">Ad Name</span>
              <span className={`text-[15px] font-bold flex-1 transition-all duration-300 ${adnameCopied ? 'line-through text-textmid/60 decoration-teal/40' : 'text-textdark'}`}>{adName}</span>
              <CopyTrackBtn itemKey={adnameKey} text={adName} label="Ad Name" />
            </div>
          )}
        </div>
      </div>
    );
  };

  // Website URL section — big, clear, prominent
  const WebsiteUrlSection = ({ url, cardKey }) => {
    if (!url) return null;
    const itemKey = `${cardKey}-url`;
    const isCopied = copiedItems.has(itemKey);
    const handleCopy = () => {
      copyToClipboard(url, 'Website URL');
      setCopiedItems(prev => new Set(prev).add(itemKey));
    };
    return (
      <div className={`border-2 rounded-xl p-4 transition-all duration-300 ${isCopied ? 'border-teal/25 bg-teal/5' : 'border-gold/25 bg-gold/5'}`}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-widest mb-1 transition-colors duration-300 ${isCopied ? 'bg-teal/15 text-teal' : 'bg-gold/20 text-gold'}`}>Website URL</span>
            <p className="text-[11px] text-textmid mb-2">Paste this into the <strong>"Website URL"</strong> field in Ads Manager.</p>
            <div className={`bg-white rounded-lg px-3 py-2 border transition-all duration-300 ${isCopied ? 'border-teal/20' : 'border-gold/20'}`}>
              <a href={url} target="_blank" rel="noopener noreferrer"
                className={`text-[13px] font-medium hover:underline break-all transition-all duration-300 ${isCopied ? 'line-through text-textmid/60 decoration-teal/40' : 'text-gold'}`}
              >{url}</a>
            </div>
          </div>
          <button onClick={handleCopy}
            className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-white text-[11px] font-bold transition-colors flex-shrink-0 shadow-sm ${isCopied ? 'bg-teal hover:bg-teal/90' : 'bg-gold hover:bg-gold/90'}`}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              {isCopied
                ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              }
            </svg>
            {isCopied ? 'Copied' : 'Copy URL'}
          </button>
        </div>
      </div>
    );
  };

  // Call to Action section — clear
  const CallToActionSection = ({ cta }) => {
    if (!cta) return null;
    return (
      <div className="border border-black/[0.06] rounded-xl p-4 bg-white">
        <span className="inline-block px-2 py-0.5 rounded bg-teal/10 text-teal text-[10px] font-bold uppercase tracking-widest mb-1">Call to Action</span>
        <p className="text-[11px] text-textmid mb-2">Select <strong>"{cta.replace(/_/g, ' ')}"</strong> from the "Call to Action" dropdown in Ads Manager.</p>
        <span className="inline-block px-4 py-1.5 rounded-full bg-teal/10 text-teal text-[14px] font-bold border border-teal/20">
          {cta.replace(/_/g, ' ')}
        </span>
      </div>
    );
  };

  // Display Link section — shown instead of website URL in ad
  const DisplayLinkSection = ({ displayLink, cardKey }) => {
    if (!displayLink || !displayLink.trim()) return null;
    const itemKey = `${cardKey}-displaylink`;
    const isCopied = copiedItems.has(itemKey);
    const handleCopy = () => {
      copyToClipboard(displayLink, 'Display Link');
      setCopiedItems(prev => new Set(prev).add(itemKey));
    };
    return (
      <div className={`border-2 rounded-xl p-4 transition-all duration-300 ${isCopied ? 'border-teal/15 bg-teal/5' : 'border-navy/15 bg-navy/5'}`}>
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-widest mb-1 transition-colors duration-300 ${isCopied ? 'bg-teal/15 text-teal' : 'bg-navy/10 text-navy'}`}>Display Link</span>
            <p className="text-[11px] text-textmid mb-2">Enter this into the <strong>"Display Link"</strong> field in Ads Manager (under the Website URL).</p>
            <div className={`bg-white rounded-lg px-3 py-2 border transition-all duration-300 ${isCopied ? 'border-teal/15' : 'border-navy/15'}`}>
              <span className={`text-[13px] font-medium break-all transition-all duration-300 ${isCopied ? 'line-through text-textmid/60 decoration-teal/40' : 'text-navy'}`}>{displayLink}</span>
            </div>
          </div>
          <button onClick={handleCopy}
            className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-white text-[11px] font-bold transition-colors flex-shrink-0 shadow-sm ${isCopied ? 'bg-teal hover:bg-teal/90' : 'bg-navy hover:bg-navy-light'}`}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              {isCopied
                ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              }
            </svg>
            {isCopied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
    );
  };

  // Facebook Page section — which page to post from
  const FacebookPageSection = ({ page }) => {
    if (!page) return null;
    return (
      <div className="border-2 border-navy/15 bg-navy/5 rounded-xl p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <span className="inline-block px-2 py-0.5 rounded bg-navy/10 text-navy text-[10px] font-bold uppercase tracking-widest mb-1">Facebook Page</span>
            <p className="text-[11px] text-textmid mb-2">Make sure you are posting from the correct Facebook Page. Select <strong>"{page}"</strong> as your Page identity in Ads Manager.</p>
            <div className="bg-white rounded-lg px-3 py-2 border border-navy/15">
              <span className="text-[14px] font-bold text-textdark">{page}</span>
            </div>
          </div>
        </div>
      </div>
    );
  };

  // Notes section — editable textarea at the bottom of cards
  const NotesSection = ({ notes, cardKey, depId, isFlexCard = false }) => {
    const isEditing = editingNotes === cardKey;
    return (
      <div className="border border-black/[0.06] rounded-xl p-4 bg-white">
        <div className="flex items-center justify-between mb-2">
          <span className="inline-block px-2 py-0.5 rounded bg-black/[0.04] text-textmid text-[10px] font-bold uppercase tracking-widest">Notes</span>
          {!isEditing && (
            <button
              onClick={() => startEditingNotes(cardKey, notes)}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium text-textmid hover:text-textdark hover:bg-black/[0.04] transition-colors"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
              </svg>
              Edit
            </button>
          )}
        </div>
        {isEditing ? (
          <div>
            <textarea
              value={notesValue}
              onChange={e => setNotesValue(e.target.value)}
              placeholder="Add notes..."
              rows={3}
              className="w-full text-[13px] text-textdark bg-offwhite border border-black/10 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-navy/20 resize-y"
              autoFocus
            />
            <div className="flex items-center justify-end gap-2 mt-2">
              <button
                onClick={() => setEditingNotes(null)}
                className="px-2.5 py-1 rounded-md text-[11px] text-textmid hover:bg-black/[0.04] transition-colors"
              >Cancel</button>
              <button
                onClick={() => saveNotes(depId, isFlexCard)}
                disabled={savingNotes}
                className="px-3 py-1 rounded-md text-[11px] font-semibold bg-navy text-white hover:bg-navy-light transition-colors disabled:opacity-50"
              >{savingNotes ? 'Saving...' : 'Save'}</button>
            </div>
          </div>
        ) : (
          <div
            onClick={() => startEditingNotes(cardKey, notes)}
            className="cursor-pointer rounded-lg px-3 py-2 bg-offwhite min-h-[2.5rem] hover:bg-navy/5 transition-colors"
          >
            {notes ? (
              <p className="text-[13px] text-textdark whitespace-pre-wrap">{notes}</p>
            ) : (
              <p className="text-[12px] text-textlight italic">Click to add notes...</p>
            )}
          </div>
        )}
      </div>
    );
  };

  const PostedByDropdown = ({ value, onChange }) => (
    <div className="flex items-center gap-2">
      <span className="text-[11px] font-medium text-textmid">Posted by:</span>
      <select
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        className="text-[12px] font-semibold text-textdark bg-offwhite border border-black/10 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-navy/20 cursor-pointer"
      >
        <option value="">Select...</option>
        <option value="Corinne">Corinne</option>
        <option value="Liz">Liz</option>
        <option value="Ian">Ian</option>
      </select>
    </div>
  );

  // ── Admin Edit Panel ──────────────────────────────────────────────────────

  const EditPanel = ({ cardKey, id, isFlex = false }) => {
    if (editingCard !== cardKey || isPoster) return null;
    const nameKey = isFlex ? 'name' : 'ad_name';
    const headlineKey = isFlex ? 'headlines' : 'ad_headlines';

    return (
      <div className="border-2 border-gold/30 bg-gold/5 rounded-xl p-4 space-y-3">
        <div className="flex items-center justify-between mb-1">
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-gold/20 text-gold text-[10px] font-bold uppercase tracking-widest">
            <EditPencilIcon /> Edit Ad Details
          </span>
          <div className="flex items-center gap-2">
            <button onClick={() => { setEditingCard(null); setEditFields({}); }}
              className="px-2.5 py-1 rounded-md text-[11px] text-textmid hover:bg-black/[0.04] transition-colors">Cancel</button>
            <button onClick={() => saveEditing(id, isFlex)} disabled={savingEdit}
              className="px-3 py-1 rounded-md text-[11px] font-semibold bg-navy text-white hover:bg-navy-light transition-colors disabled:opacity-50">
              {savingEdit ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </div>

        {/* Ad Name */}
        <div>
          <label className="text-[10px] text-textmid font-medium block mb-1">Ad Name</label>
          <input type="text" value={editFields[nameKey] || ''} onChange={e => updateEditField(nameKey, e.target.value)}
            className="w-full text-[12px] text-textdark bg-white border border-black/10 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-navy/20" />
        </div>

        {/* Campaign */}
        <div>
          <label className="text-[10px] text-textmid font-medium block mb-1">Campaign</label>
          <select
            value={isFlex ? (editFields._campaign_id || '') : (editFields.local_campaign_id || '')}
            onChange={e => {
              const campId = e.target.value;
              if (isFlex) {
                updateEditField('_campaign_id', campId);
              } else {
                updateEditField('local_campaign_id', campId);
              }
            }}
            className="w-full text-[12px] text-textdark bg-white border border-black/10 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-navy/20 cursor-pointer"
          >
            <option value="">Select a campaign...</option>
            {safeCampaigns.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>

        {/* Ad Set Name */}
        <div>
          <label className="text-[10px] text-textmid font-medium block mb-1">Ad Set Name</label>
          <input type="text" value={editFields._ad_set_name || ''} onChange={e => updateEditField('_ad_set_name', e.target.value)}
            className="w-full text-[12px] text-textdark bg-white border border-black/10 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-navy/20" placeholder="Type ad set name..." />
          <p className="text-[10px] text-textlight mt-0.5">Type a name. If it matches an existing ad set, it will be reused. Otherwise a new one is created.</p>
        </div>

        {/* Website URL */}
        <div>
          <label className="text-[10px] text-textmid font-medium block mb-1">Website URL</label>
          <input type="text" value={editFields.destination_url || ''} onChange={e => updateEditField('destination_url', e.target.value)}
            className="w-full text-[12px] text-textdark bg-white border border-black/10 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-navy/20" placeholder="https://..." />
        </div>

        {/* Display Link */}
        <div>
          <label className="text-[10px] text-textmid font-medium block mb-1">Display Link</label>
          <input type="text" value={editFields.display_link || ''} onChange={e => updateEditField('display_link', e.target.value)}
            className="w-full text-[12px] text-textdark bg-white border border-black/10 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-navy/20" placeholder="e.g. yourbrand.com" />
        </div>

        {/* CTA */}
        <div>
          <label className="text-[10px] text-textmid font-medium block mb-1">Call to Action</label>
          <select value={editFields.cta_button || ''} onChange={e => updateEditField('cta_button', e.target.value)}
            className="w-full text-[12px] text-textdark bg-white border border-black/10 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-navy/20 cursor-pointer">
            <option value="">None</option>
            {ctaOptions.map(opt => <option key={opt} value={opt}>{opt.replace(/_/g, ' ')}</option>)}
          </select>
        </div>

        {/* Facebook Page */}
        <div>
          <label className="text-[10px] text-textmid font-medium block mb-1">Facebook Page</label>
          <input type="text" value={editFields.facebook_page || ''} onChange={e => updateEditField('facebook_page', e.target.value)}
            className="w-full text-[12px] text-textdark bg-white border border-black/10 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-navy/20" />
        </div>

        {/* Duplicate Ad Set Name */}
        <div>
          <label className="text-[10px] text-textmid font-medium block mb-1">Duplicate Ad Set Name</label>
          <input type="text" value={editFields.duplicate_adset_name || ''} onChange={e => updateEditField('duplicate_adset_name', e.target.value)}
            className="w-full text-[12px] text-textdark bg-white border border-black/10 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-navy/20" />
        </div>

        {/* Primary Texts */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-[10px] text-textmid font-medium">Primary Texts</label>
            <button onClick={() => addEditArrayItem('primary_texts')}
              className="text-[10px] text-navy font-medium hover:text-gold transition-colors">+ Add</button>
          </div>
          {(editFields.primary_texts || []).map((text, i) => (
            <div key={i} className="flex items-start gap-2 mb-1.5">
              <span className="text-[10px] text-textlight font-bold mt-2 w-4 text-right flex-shrink-0">{i + 1}</span>
              <textarea value={text} onChange={e => updateEditArrayItem('primary_texts', i, e.target.value)} rows={2}
                className="flex-1 text-[12px] text-textdark bg-white border border-black/10 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-navy/20 resize-y" />
              <button onClick={() => removeEditArrayItem('primary_texts', i)}
                className="text-red-400 hover:text-red-600 mt-1.5 flex-shrink-0" title="Remove">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          ))}
        </div>

        {/* Headlines */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-[10px] text-textmid font-medium">Headlines</label>
            <button onClick={() => addEditArrayItem(headlineKey)}
              className="text-[10px] text-navy font-medium hover:text-gold transition-colors">+ Add</button>
          </div>
          {(editFields[headlineKey] || []).map((text, i) => (
            <div key={i} className="flex items-start gap-2 mb-1.5">
              <span className="text-[10px] text-textlight font-bold mt-2 w-4 text-right flex-shrink-0">{i + 1}</span>
              <input type="text" value={text} onChange={e => updateEditArrayItem(headlineKey, i, e.target.value)}
                className="flex-1 text-[12px] text-textdark bg-white border border-black/10 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-navy/20" />
              <button onClick={() => removeEditArrayItem(headlineKey, i)}
                className="text-red-400 hover:text-red-600 mt-1.5 flex-shrink-0" title="Remove">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          ))}
        </div>

        {/* Save/Cancel bottom */}
        <div className="flex items-center justify-end gap-2 pt-2 border-t border-gold/20">
          <button onClick={() => { setEditingCard(null); setEditFields({}); }}
            className="px-3 py-1.5 rounded-md text-[11px] text-textmid hover:bg-black/[0.04] transition-colors">Cancel</button>
          <button onClick={() => saveEditing(id, isFlex)} disabled={savingEdit}
            className="px-4 py-1.5 rounded-md text-[11px] font-semibold bg-navy text-white hover:bg-navy-light transition-colors disabled:opacity-50">
            {savingEdit ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>
    );
  };

  // ── Card Renderers ──────────────────────────────────────────────────────

  // Single ad card — collapsed by default, shows name + campaign + ad set at top
  const renderAdCard = (dep) => {
    const name = dep.ad_name || dep.ad?.headline || dep.ad?.angle || `Ad ${(dep.id || '').slice(0, 6)}`;
    const thumbUrl = dep.imageUrl;
    const plannedDate = formatDate(dep.planned_date);
    const isMarking = markingPostedIds.has(dep.id);
    const isSendingBack = sendingBackIds.has(dep.id);
    const { campaignName, adSetName } = resolveLocation(dep);
    const isExpanded = expandedCards.has(dep.id);

    return (
      <div key={dep.id} className="border border-black/[0.1] rounded-2xl bg-white shadow-sm overflow-hidden">
        {/* Always-visible header: Ad Name, Campaign, Ad Set */}
        <div className="px-5 py-4 space-y-3">
          {/* Ad Name + Format badge */}
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-[14px] leading-tight mb-1.5">
                <span className="text-textmid font-medium">Ad Name: </span>
                <span className="font-bold text-textdark">{name}</span>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="inline-block px-2 py-0.5 rounded bg-navy/10 text-navy text-[9px] font-bold uppercase tracking-wider">Ad Format: Single Image</span>
                {plannedDate && (
                  <span className="inline-block px-2 py-0.5 rounded bg-teal/10 text-teal text-[9px] font-bold uppercase tracking-wider">Start Date: {plannedDate}</span>
                )}
              </div>
            </div>
            {thumbUrl && (
              <img src={thumbUrl} alt="" className="w-14 h-14 object-cover rounded-xl bg-gray-100 flex-shrink-0" loading="lazy" />
            )}
          </div>

          {/* Added to Ready to Post timestamp */}
          {formatAddedDate(dep.created_at) && (
            <div className="flex items-center gap-1.5 text-[11px] text-textmid">
              <svg className="w-3.5 h-3.5 text-textlight flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Added to Ready to Post: {formatAddedDate(dep.created_at)}
            </div>
          )}

          {/* Campaign + Ad Set + Duplicate Ad Set — always visible */}
          <PostInSection campaignName={campaignName} adSetName={adSetName} duplicateAdSetName={dep.duplicate_adset_name} adName={name} cardKey={dep.id} />

          {/* Admin Edit Panel — always visible when editing (not inside collapsible) */}
          <EditPanel cardKey={dep.id} id={dep.id} isFlex={false} />

          {/* Expand/Collapse toggle */}
          <button
            onClick={() => toggleCardExpanded(dep.id)}
            className="w-full flex items-center justify-center gap-2 py-2 rounded-xl bg-offwhite hover:bg-navy/5 transition-colors text-[12px] font-medium text-navy"
          >
            <svg className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
            {isExpanded ? 'Hide Ad Details' : 'Show Ad Details'}
            {!isExpanded && (
              <span className="text-[10px] text-textmid font-normal">
                ({[dep.primary_texts && parseCount(dep.primary_texts) > 0 && 'Primary Text', dep.ad_headlines && parseCount(dep.ad_headlines) > 0 && 'Headline', dep.destination_url && 'Website URL', dep.display_link && 'Display Link', dep.cta_button && 'Call to Action', dep.facebook_page && 'Facebook Page'].filter(Boolean).join(', ') || 'No details'})
              </span>
            )}
          </button>
        </div>

        {/* Collapsible details */}
        {isExpanded && (
          <div className="px-5 pb-5 space-y-4 border-t border-black/[0.06] pt-4">
            <FacebookPageSection page={dep.facebook_page} />

            {/* Image */}
            {thumbUrl && (
              <div className="border border-black/[0.06] rounded-xl p-4 bg-white">
                <div className="flex items-center justify-between mb-3">
                  <span className="inline-block px-2 py-0.5 rounded bg-navy/10 text-navy text-[10px] font-bold uppercase tracking-widest">Ad Creative</span>
                  <button onClick={() => downloadSingleImage(dep)} disabled={downloadingSingle.has(dep.id)}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-navy text-white text-[12px] font-bold hover:bg-navy-light transition-colors disabled:opacity-50 shadow-sm"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                    {downloadingSingle.has(dep.id) ? 'Downloading...' : 'Download Image'}
                  </button>
                </div>
                <img src={thumbUrl} alt="" className="w-full max-w-[150px] rounded-xl bg-offwhite" loading="lazy" />
              </div>
            )}

            {/* Primary Text */}
            {renderNumberedTexts(
              dep.primary_texts,
              `Primary Text \u2014 ${parseCount(dep.primary_texts)} Variation${parseCount(dep.primary_texts) !== 1 ? 's' : ''}`,
              'Upload ALL of these into the "Primary Text" field. Meta will automatically rotate them and show the best-performing version to each person.',
              dep.id, 'primary'
            )}

            {/* Headline */}
            {renderNumberedTexts(
              dep.ad_headlines,
              `Headline \u2014 ${parseCount(dep.ad_headlines)} Variation${parseCount(dep.ad_headlines) !== 1 ? 's' : ''}`,
              'Upload ALL of these into the "Headline" field. Meta will automatically test each one and show the best performer.',
              dep.id, 'headline'
            )}

            <WebsiteUrlSection url={dep.destination_url} cardKey={dep.id} />
            <DisplayLinkSection displayLink={dep.display_link} cardKey={dep.id} />
            <CallToActionSection cta={dep.cta_button} />

            {/* Notes */}
            <NotesSection notes={dep.notes} cardKey={dep.id} depId={dep.id} />
          </div>
        )}

        {/* Actions — always visible */}
        <div className="px-5 py-3.5 border-t border-black/[0.08] bg-offwhite/50 flex items-center justify-between">
          <div className="flex items-center gap-2">
            {!isPoster && (
              <button onClick={() => handleSendBack(dep.id)} disabled={isSendingBack}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium text-textmid hover:text-textdark hover:bg-black/[0.04] transition-colors disabled:opacity-50"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                </svg>
                {isSendingBack ? 'Sending...' : 'Send Back to Planner'}
              </button>
            )}
            {!isPoster && editingCard !== dep.id && (
              <button onClick={() => startEditing(dep.id, dep, false)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium text-gold hover:text-gold/80 hover:bg-gold/[0.06] transition-colors"
              >
                <EditPencilIcon />
                Edit
              </button>
            )}
          </div>
          <div className="flex items-center gap-3">
            <PostedByDropdown value={dep.posted_by} onChange={(val) => handlePostedByChange(dep.id, val)} />
            {confirmPosted === dep.id ? (
              <div className="flex items-center gap-2">
                <button onClick={() => setConfirmPosted(null)} className="px-2.5 py-1.5 rounded-lg text-[11px] text-textmid hover:bg-white transition-colors">Cancel</button>
                <button onClick={() => handleMarkPosted(dep.id)} disabled={isMarking}
                  className="px-4 py-2 rounded-lg text-[12px] font-bold bg-teal text-white hover:bg-teal/90 transition-colors disabled:opacity-50"
                >{isMarking ? 'Updating...' : 'Confirm Posted'}</button>
              </div>
            ) : (
              <button onClick={() => setConfirmPosted(dep.id)}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-[12px] font-bold text-white bg-teal hover:bg-teal/90 transition-colors shadow-sm"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                Mark as Posted
              </button>
            )}
          </div>
        </div>
      </div>
    );
  };

  // Flex ad card — collapsed by default, shows name + campaign + ad set at top
  const renderFlexCard = (flexAd) => {
    const childDeps = getFlexChildDeps(flexAd);
    if (childDeps.length === 0) return null;

    const plannedDate = formatDate(flexAd.planned_date);
    const flexId = `flex-${flexAd.id}`;
    const isMarking = markingPostedIds.has(flexId);
    const isSendingBack = sendingBackIds.has(flexId);
    const { campaignName, adSetName } = resolveFlexLocation(flexAd);
    const cardKey = flexId;
    const selected = selectedImages[cardKey] || new Set();
    const depsWithImages = childDeps.filter(d => d.imageUrl);
    const allSelected = depsWithImages.length > 0 && depsWithImages.every(d => selected.has(d.id));
    const someSelected = selected.size > 0;
    const isDownloadingAll = downloadingAll.has(cardKey);
    const isDownloadingSelected = downloadingSelected.has(cardKey);
    const isExpanded = expandedCards.has(flexId);

    return (
      <div
        key={flexAd.id}
        ref={flexAd.id === highlightedId ? highlightRef : undefined}
        className={`border rounded-2xl bg-white shadow-sm overflow-hidden transition-all duration-700 ${flexAd.id === highlightedId ? 'border-gold ring-2 ring-gold/30' : 'border-black/[0.1]'}`}
      >
        {/* Always-visible header: Ad Name, Campaign, Ad Set */}
        <div className="px-5 py-4 space-y-3">
          {/* Ad Name + Format badge + small thumbnails */}
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-[14px] leading-tight mb-1.5">
                <span className="text-textmid font-medium">Ad Name: </span>
                <span className="font-bold text-textdark">{flexAd.name || 'Flex Ad'}</span>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="inline-block px-2 py-0.5 rounded bg-navy/10 text-navy text-[9px] font-bold uppercase tracking-wider">Ad Format: Flexible</span>
                {plannedDate && (
                  <span className="inline-block px-2 py-0.5 rounded bg-teal/10 text-teal text-[9px] font-bold uppercase tracking-wider">Start Date: {plannedDate}</span>
                )}
              </div>
            </div>
            <div className="flex gap-1 flex-shrink-0">
              {childDeps.slice(0, 3).map(d => d.imageUrl ? (
                <img key={d.id} src={d.imageUrl} alt="" className="w-10 h-10 object-cover rounded-lg bg-gray-100" loading="lazy" />
              ) : (
                <div key={d.id} className="w-10 h-10 rounded-lg bg-gray-200" />
              ))}
              {childDeps.length > 3 && (
                <div className="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center text-[10px] text-textlight font-medium">+{childDeps.length - 3}</div>
              )}
            </div>
          </div>

          {/* Added to Ready to Post timestamp */}
          {formatAddedDate(flexAd.created_at) && (
            <div className="flex items-center gap-1.5 text-[11px] text-textmid">
              <svg className="w-3.5 h-3.5 text-textlight flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Added to Ready to Post: {formatAddedDate(flexAd.created_at)}
            </div>
          )}

          {/* Campaign + Ad Set + Duplicate Ad Set — always visible */}
          <PostInSection campaignName={campaignName} adSetName={adSetName} duplicateAdSetName={flexAd.duplicate_adset_name} adName={flexAd.name || 'Flex Ad'} cardKey={flexId} />

          {/* Destination URLs Panel — Gauntlet LPs + legacy LPs + PDP */}
          {(() => {
            // Parse gauntlet LP URLs
            let gauntletUrls = [];
            try { gauntletUrls = JSON.parse(flexAd.gauntlet_lp_urls || '[]'); } catch {}
            let usedIndices = [];
            try { usedIndices = JSON.parse(flexAd.destination_urls_used || '[]'); } catch {}

            const hasGauntlet = gauntletUrls.length > 0;
            const hasLegacy = !hasGauntlet && (flexAd.lp_primary_url || flexAd.lp_secondary_url);
            const hasAnyLP = hasGauntlet || hasLegacy;

            if (!hasAnyLP) return null;

            const handleCopyDestUrl = async (url, label, index) => {
              copyToClipboard(url, label);
              // Mark as used (persist cross-out)
              if (index !== undefined && !usedIndices.includes(index)) {
                try {
                  const updated = [...usedIndices, index];
                  await api.updateFlexAd(flexAd.id, { destination_urls_used: JSON.stringify(updated) });
                } catch {}
              }
            };

            return (
              <div className="bg-offwhite rounded-xl p-3 space-y-1.5">
                <div className="text-[10px] font-semibold text-navy uppercase tracking-wide">Destination URLs</div>

                {/* Gauntlet / Destination URLs */}
                {hasGauntlet && gauntletUrls.map((lp, i) => {
                  const isUsed = usedIndices.includes(i);
                  const isObj = typeof lp === 'object' && lp !== null;
                  const url = isObj ? lp.url : lp;
                  const label = isObj ? (lp.frameName || lp.frame) : null;
                  const score = isObj ? lp.score : null;
                  return (
                    <div key={i} className={`flex items-center gap-2 ${isUsed ? 'opacity-50' : ''}`}>
                      <span className="text-[10px] text-textmid w-6 flex-shrink-0">{i + 1}.</span>
                      {label && <span className="text-[10px] text-textmid flex-shrink-0 w-28 truncate">{label}</span>}
                      {score != null && <span className="text-[10px] text-teal flex-shrink-0">({score}/10)</span>}
                      <a href={url} target="_blank" rel="noopener noreferrer"
                        className={`text-[11px] text-gold hover:text-gold/80 underline underline-offset-2 truncate flex-1 ${isUsed ? 'line-through' : ''}`}>
                        {url}
                      </a>
                      <button onClick={(e) => { e.stopPropagation(); handleCopyDestUrl(url, `URL ${i + 1}`, i); }}
                        className="inline-flex items-center px-1.5 py-0.5 rounded bg-navy/5 text-[9px] text-navy hover:bg-navy/10 transition-colors flex-shrink-0">
                        Copy
                      </button>
                    </div>
                  );
                })}

                {/* Legacy LP URLs (fallback when no gauntlet) */}
                {hasLegacy && (
                  <>
                    {flexAd.lp_primary_url && (
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-textmid w-12 flex-shrink-0">LP 1:</span>
                        <a href={flexAd.lp_primary_url} target="_blank" rel="noopener noreferrer" className="text-[11px] text-gold hover:text-gold/80 underline underline-offset-2 truncate flex-1">
                          {flexAd.lp_primary_url}
                        </a>
                        <button onClick={(e) => { e.stopPropagation(); copyToClipboard(flexAd.lp_primary_url, 'LP 1 URL'); }}
                          className="inline-flex items-center px-1.5 py-0.5 rounded bg-navy/5 text-[9px] text-navy hover:bg-navy/10 transition-colors flex-shrink-0">
                          Copy
                        </button>
                      </div>
                    )}
                    {flexAd.lp_secondary_url && (
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-textmid w-12 flex-shrink-0">LP 2:</span>
                        <a href={flexAd.lp_secondary_url} target="_blank" rel="noopener noreferrer" className="text-[11px] text-gold hover:text-gold/80 underline underline-offset-2 truncate flex-1">
                          {flexAd.lp_secondary_url}
                        </a>
                        <button onClick={(e) => { e.stopPropagation(); copyToClipboard(flexAd.lp_secondary_url, 'LP 2 URL'); }}
                          className="inline-flex items-center px-1.5 py-0.5 rounded bg-navy/5 text-[9px] text-navy hover:bg-navy/10 transition-colors flex-shrink-0">
                          Copy
                        </button>
                      </div>
                    )}
                  </>
                )}

                {/* PDP URL — always last */}
                {flexAd.destination_url && (
                  <div className={`flex items-center gap-2 ${hasGauntlet && usedIndices.includes(gauntletUrls.length) ? 'opacity-50' : ''}`}>
                    <span className="text-[10px] text-textmid w-6 flex-shrink-0">{hasGauntlet ? `${gauntletUrls.length + 1}.` : 'PDP:'}</span>
                    {hasGauntlet && <span className="text-[10px] text-textmid flex-shrink-0 w-28">Product Page</span>}
                    {hasGauntlet && <span className="text-[10px] text-teal flex-shrink-0 invisible">(0/10)</span>}
                    <a href={flexAd.destination_url} target="_blank" rel="noopener noreferrer"
                      className={`text-[11px] text-navy hover:text-navy/80 underline underline-offset-2 truncate flex-1 ${hasGauntlet && usedIndices.includes(gauntletUrls.length) ? 'line-through' : ''}`}>
                      {flexAd.destination_url}
                    </a>
                    <button onClick={(e) => { e.stopPropagation(); handleCopyDestUrl(flexAd.destination_url, 'PDP URL', hasGauntlet ? gauntletUrls.length : undefined); }}
                      className="inline-flex items-center px-1.5 py-0.5 rounded bg-navy/5 text-[9px] text-navy hover:bg-navy/10 transition-colors flex-shrink-0">
                      Copy
                    </button>
                  </div>
                )}

                <p className="text-[10px] text-textmid italic pt-1">
                  {hasGauntlet && gauntletUrls.length > 1
                    ? 'Create this ad with URL #1, then duplicate the ad in Ads Manager for each additional URL. Keep all duplicates in the same ad set — each duplicate is identical except for the destination URL.'
                    : hasGauntlet
                      ? 'Copy URL to use as the ad destination.'
                      : 'Post BOTH LP and PDP as separate ads in the same ad set. Meta auto-optimizes.'}
                </p>
              </div>
            );
          })()}

          {/* Admin Edit Panel — always visible when editing (not inside collapsible) */}
          <EditPanel cardKey={flexId} id={flexAd.id} isFlex />

          {/* Expand/Collapse toggle */}
          <button
            onClick={() => toggleCardExpanded(flexId)}
            className="w-full flex items-center justify-center gap-2 py-2 rounded-xl bg-offwhite hover:bg-navy/5 transition-colors text-[12px] font-medium text-navy"
          >
            <svg className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
            {isExpanded ? 'Hide Ad Details' : 'Show Ad Details'}
            {!isExpanded && (
              <span className="text-[10px] text-textmid font-normal">
                ({[depsWithImages.length > 0 && `${depsWithImages.length} Ad Creatives`, flexAd.primary_texts && parseCount(flexAd.primary_texts) > 0 && 'Primary Text', flexAd.headlines && parseCount(flexAd.headlines) > 0 && 'Headline', flexAd.destination_url && 'Website URL', flexAd.display_link && 'Display Link', flexAd.cta_button && 'Call to Action', flexAd.facebook_page && 'Facebook Page'].filter(Boolean).join(', ') || 'No details'})
              </span>
            )}
          </button>
        </div>

        {/* Collapsible details */}
        {isExpanded && (
          <div className="px-5 pb-5 space-y-4 border-t border-black/[0.06] pt-4">
            <FacebookPageSection page={flexAd.facebook_page} />

            {/* Ad Creatives with download */}
            <div className="border border-black/[0.06] rounded-xl p-4 bg-white">
              <div className="mb-1">
                <span className="inline-block px-2 py-0.5 rounded bg-navy/10 text-navy text-[10px] font-bold uppercase tracking-widest mb-1">
                  Ad Creatives — {depsWithImages.length} Image{depsWithImages.length !== 1 ? 's' : ''}
                </span>
                <p className="text-[11px] text-textmid mt-0.5 leading-relaxed">Upload ALL of these images. Meta will automatically rotate them and show the best-performing image to each person.</p>
              </div>

              {/* Download bar */}
              <div className="flex items-center gap-2 mt-3 mb-3">
                <button onClick={() => downloadMultipleImages(depsWithImages, cardKey)}
                  disabled={isDownloadingAll || depsWithImages.length === 0}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-navy text-white text-[13px] font-bold hover:bg-navy-light transition-colors disabled:opacity-50 shadow-sm"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  {isDownloadingAll ? 'Zipping...' : `Download All Images (${depsWithImages.length})`}
                </button>
                {someSelected && (
                  <button onClick={() => { const selectedDeps = childDeps.filter(d => selected.has(d.id)); downloadMultipleImages(selectedDeps, `selected-${cardKey}`); }}
                    disabled={isDownloadingSelected}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-gold/10 text-gold text-[11px] font-bold hover:bg-gold/20 transition-colors disabled:opacity-50"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                    {isDownloadingSelected ? '...' : `Download Selected (${selected.size})`}
                  </button>
                )}
              </div>

              {/* Select All */}
              {depsWithImages.length > 1 && (
                <label className="flex items-center gap-2 mb-2.5 cursor-pointer select-none">
                  <input type="checkbox" checked={allSelected}
                    onChange={() => toggleSelectAll(cardKey, depsWithImages.map(d => d.id))}
                    className="rounded border-navy/30 text-navy focus:ring-navy/20 w-4 h-4" />
                  <span className="text-[12px] text-textmid font-medium">Select All</span>
                </label>
              )}

              {/* Image grid */}
              <div className="grid grid-cols-5 gap-2">
                {childDeps.map(d => {
                  const isSelected = selected.has(d.id);
                  const isSingleDl = downloadingSingle.has(d.id);
                  return (
                    <div key={d.id} className="relative group">
                      {d.imageUrl && (
                        <label className="absolute top-2 left-2 z-10 cursor-pointer">
                          <input type="checkbox" checked={isSelected}
                            onChange={() => toggleImageSelection(cardKey, d.id)}
                            className="rounded border-white/80 text-navy focus:ring-navy/20 w-4 h-4 shadow-sm" />
                        </label>
                      )}
                      {d.imageUrl ? (
                        <img src={d.imageUrl} alt=""
                          className={`w-full aspect-square object-cover rounded-xl bg-offwhite transition-all ${isSelected ? 'ring-2 ring-navy ring-offset-2' : ''}`}
                          loading="lazy" />
                      ) : (
                        <div className="w-full aspect-square rounded-xl bg-offwhite" />
                      )}
                      {d.imageUrl && (
                        <button onClick={() => downloadSingleImage(d)} disabled={isSingleDl}
                          className="absolute bottom-2 right-2 p-1.5 rounded-lg bg-white/90 text-navy hover:bg-white shadow-sm opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity disabled:opacity-50"
                          title="Download this image">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                          </svg>
                        </button>
                      )}
                      <div className="text-[10px] text-textmid mt-1 truncate">{d.ad_name || d.ad?.headline || ''}</div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Primary Text */}
            {renderNumberedTexts(
              flexAd.primary_texts,
              `Primary Text — ${parseCount(flexAd.primary_texts)} Variation${parseCount(flexAd.primary_texts) !== 1 ? 's' : ''}`,
              'Upload ALL of these into the "Primary Text" field. Meta will automatically rotate them and show the best-performing version to each person.',
              flexId, 'primary'
            )}

            {/* Headline */}
            {renderNumberedTexts(
              flexAd.headlines,
              `Headline — ${parseCount(flexAd.headlines)} Variation${parseCount(flexAd.headlines) !== 1 ? 's' : ''}`,
              'Upload ALL of these into the "Headline" field. Meta will automatically test each one and show the best performer.',
              flexId, 'headline'
            )}

            <WebsiteUrlSection url={flexAd.destination_url} cardKey={flexId} />
            <DisplayLinkSection displayLink={flexAd.display_link} cardKey={flexId} />
            <CallToActionSection cta={flexAd.cta_button} />

            {/* Notes */}
            <NotesSection notes={flexAd.notes} cardKey={flexId} depId={flexAd.id} isFlexCard />
          </div>
        )}

        {/* Actions — always visible */}
        <div className="px-5 py-3.5 border-t border-black/[0.08] bg-offwhite/50 flex items-center justify-between">
          <div className="flex items-center gap-2">
            {!isPoster && (
              <button onClick={() => handleSendBackFlex(flexAd)} disabled={isSendingBack}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium text-textmid hover:text-textdark hover:bg-black/[0.04] transition-colors disabled:opacity-50"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                </svg>
                {isSendingBack ? 'Sending...' : 'Send Back to Planner'}
              </button>
            )}
            {!isPoster && editingCard !== flexId && (
              <button onClick={() => startEditing(flexId, flexAd, true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium text-gold hover:text-gold/80 hover:bg-gold/[0.06] transition-colors"
              >
                <EditPencilIcon />
                Edit
              </button>
            )}
          </div>
          <div className="flex items-center gap-3">
            <PostedByDropdown value={flexAd.posted_by} onChange={(val) => handlePostedByChange(flexAd.id, val, true)} />
            {confirmPosted === flexId ? (
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-textmid">{childDeps.length} ad{childDeps.length !== 1 ? 's' : ''}</span>
                <button onClick={() => setConfirmPosted(null)} className="px-2.5 py-1.5 rounded-lg text-[11px] text-textmid hover:bg-white transition-colors">Cancel</button>
                <button onClick={() => handleMarkFlexPosted(flexAd)} disabled={isMarking}
                  className="px-4 py-2 rounded-lg text-[12px] font-bold bg-teal text-white hover:bg-teal/90 transition-colors disabled:opacity-50"
                >{isMarking ? 'Updating...' : 'Confirm Posted'}</button>
              </div>
            ) : (
              <button onClick={() => setConfirmPosted(flexId)}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-[12px] font-bold text-white bg-teal hover:bg-teal/90 transition-colors shadow-sm"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                Mark as Posted
              </button>
            )}
          </div>
        </div>
      </div>
    );
  };

  // ── Build flat sorted list ──────────────────────────────────────────────

  const buildCardList = () => {
    const cards = [];
    const flexChildIds = new Set();
    safeFlexAds.forEach(fa => {
      try { (fa.child_deployment_ids ? JSON.parse(fa.child_deployment_ids) : []).forEach(id => flexChildIds.add(id)); } catch { /* ignore */ }
    });
    readyDeps.forEach(dep => {
      if (flexChildIds.has(dep.id)) return;
      const { campaignName, adSetName } = resolveLocation(dep);
      cards.push({ type: 'single', dep, campaignName: campaignName || '', adSetName: adSetName || '', plannedDate: dep.planned_date || '', createdAt: dep.created_at || '', name: dep.ad_name || '', key: dep.id });
    });
    safeFlexAds.forEach(fa => {
      if (!flexHasReadyChildren(fa)) return;
      const { campaignName, adSetName } = resolveFlexLocation(fa);
      cards.push({ type: 'flex', flexAd: fa, campaignName: campaignName || '', adSetName: adSetName || '', plannedDate: fa.planned_date || '', createdAt: fa.created_at || '', name: fa.name || '', key: `flex-${fa.id}` });
    });
    // Sort based on selected sort option
    cards.sort((a, b) => {
      switch (sortBy) {
        case 'newest':
          return (b.createdAt || '').localeCompare(a.createdAt || '');
        case 'oldest':
          return (a.createdAt || '').localeCompare(b.createdAt || '');
        case 'campaign': {
          const aU = !a.campaignName, bU = !b.campaignName;
          if (aU !== bU) return aU ? -1 : 1;
          if (a.campaignName !== b.campaignName) return a.campaignName.localeCompare(b.campaignName);
          if (a.adSetName !== b.adSetName) return a.adSetName.localeCompare(b.adSetName);
          if (a.plannedDate && b.plannedDate) return a.plannedDate.localeCompare(b.plannedDate);
          if (a.plannedDate) return -1; if (b.plannedDate) return 1; return 0;
        }
        case 'planned_date': {
          if (a.plannedDate && b.plannedDate) return a.plannedDate.localeCompare(b.plannedDate);
          if (a.plannedDate) return -1; if (b.plannedDate) return 1;
          return (b.createdAt || '').localeCompare(a.createdAt || '');
        }
        case 'name':
          return a.name.localeCompare(b.name);
        default:
          return (b.createdAt || '').localeCompare(a.createdAt || '');
      }
    });
    return cards;
  };

  // ── Render ──────────────────────────────────────────────────────────────

  if (loading) return <div className="text-center py-12 text-textmid text-[13px]">Loading...</div>;

  if (loadError) {
    return (
      <div className="text-center py-16">
        <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-red-50 flex items-center justify-center">
          <svg className="w-6 h-6 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
          </svg>
        </div>
        <p className="text-[14px] font-medium text-textdark">Something went wrong</p>
        <p className="text-[12px] text-textmid mt-1">{loadError}</p>
        <button onClick={loadData} className="mt-4 px-4 py-2 rounded-lg bg-navy text-white text-[12px] font-medium hover:bg-navy-light transition-colors">
          Try Again
        </button>
      </div>
    );
  }

  if (readyDeps.length === 0) {
    return (
      <div className="text-center py-16">
        <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-navy/5 flex items-center justify-center">
          <svg className="w-6 h-6 text-textlight" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
          </svg>
        </div>
        <p className="text-[14px] font-medium text-textdark">No ads ready to post</p>
        <p className="text-[12px] text-textmid mt-1">When ads are marked "Ready to Post" in the Planner, they'll appear here.</p>
      </div>
    );
  }

  const cardList = buildCardList();

  return (
    <div className="space-y-5">
      {/* Summary + Sort */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-[14px]">
            <span className="font-bold text-textdark">{cardList.length}</span>
            <span className="text-textmid ml-1.5">ad{cardList.length !== 1 ? 's' : ''} ready to post</span>
          </div>
          <p className="text-[11px] text-textmid mt-0.5">These ads are ready to be posted in Meta Ads Manager. Expand each card to see the full details and copy the content.</p>
        </div>
        <select
          value={sortBy}
          onChange={e => setSortBy(e.target.value)}
          className="text-[12px] text-textdark bg-offwhite border border-black/10 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-navy/20 cursor-pointer shrink-0"
        >
          <option value="newest">Newest First</option>
          <option value="oldest">Oldest First</option>
          <option value="campaign">Campaign → Ad Set</option>
          <option value="planned_date">Planned Date</option>
          <option value="name">Name (A-Z)</option>
        </select>
      </div>

      {/* Cards */}
      <div className="space-y-5">
        {cardList.map(card => card.type === 'single' ? renderAdCard(card.dep) : renderFlexCard(card.flexAd))}
      </div>
    </div>
  );
}

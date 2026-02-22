import { useState, useEffect, useCallback } from 'react';
import JSZip from 'jszip';
import { api } from '../api';

/**
 * ReadyToPostView — Employee-facing view showing only ads with status 'ready_to_post'.
 *
 * Layout: Flat list of self-contained cards. Important info at top of each card:
 *   1. Ad name, ad format (Single Image / Flexible Ad), scheduled date/time
 *   2. "POST IN" section: Campaign > Ad Set
 *   3. Ad Creatives section with Download All / Download Selected / individual download
 *   4. Primary Text variations (numbered, with explanations)
 *   5. Headline variations (numbered, with explanations)
 *   6. Destination URL + CTA button
 *   7. Actions: Send Back / Mark as Posted
 *
 * Props: projectId, deployments, setDeployments, addToast, loadDeployments, onSwitchToPlanner
 */
export default function ReadyToPostView({ projectId, deployments, setDeployments, addToast, loadDeployments, onSwitchToPlanner }) {
  const [campaigns, setCampaigns] = useState([]);
  const [adSets, setAdSets] = useState([]);
  const [flexAds, setFlexAds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [confirmPosted, setConfirmPosted] = useState(null);
  const [markingPostedIds, setMarkingPostedIds] = useState(new Set());
  const [sendingBackIds, setSendingBackIds] = useState(new Set());
  const [bulkMarkingAll, setBulkMarkingAll] = useState(false);
  // Image selection + download state (per card)
  const [selectedImages, setSelectedImages] = useState({}); // { [cardKey]: Set(depId) }
  const [downloadingAll, setDownloadingAll] = useState(new Set()); // cardKey
  const [downloadingSelected, setDownloadingSelected] = useState(new Set()); // cardKey
  const [downloadingSingle, setDownloadingSingle] = useState(new Set()); // depId

  useEffect(() => {
    loadData();
  }, [projectId]);

  const loadData = async () => {
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

  // Only show ready_to_post deployments
  const readyDeps = deployments.filter(d => d.status === 'ready_to_post');

  // ── Helpers ──────────────────────────────────────────────────────────────

  const resolveLocation = (dep) => {
    const adSet = adSets.find(a => a.id === dep.local_adset_id);
    if (!adSet) return { campaignName: null, adSetName: null };
    const campaign = campaigns.find(c => {
      const campAdSets = adSets.filter(a => a.campaign_id === c.id);
      return campAdSets.some(a => a.id === dep.local_adset_id);
    });
    return { campaignName: campaign?.name || null, adSetName: adSet?.name || null };
  };

  const resolveFlexLocation = (flexAd) => {
    const adSet = adSets.find(a => a.id === flexAd.ad_set_id);
    if (!adSet) return { campaignName: null, adSetName: null };
    const campaign = campaigns.find(c => {
      const campAdSets = adSets.filter(a => a.campaign_id === c.id);
      return campAdSets.some(a => a.id === flexAd.ad_set_id);
    });
    return { campaignName: campaign?.name || null, adSetName: adSet?.name || null };
  };

  const getFlexChildDeps = (flexAd) => {
    let childIds = [];
    try { childIds = flexAd.child_deployment_ids ? JSON.parse(flexAd.child_deployment_ids) : []; } catch { /* ignore */ }
    return readyDeps.filter(d => childIds.includes(d.id));
  };

  const flexHasReadyChildren = (flexAd) => getFlexChildDeps(flexAd).length > 0;

  const copyToClipboard = async (text, label) => {
    try {
      await navigator.clipboard.writeText(text);
      addToast(`${label} copied`, 'success');
    } catch {
      addToast('Failed to copy', 'error');
    }
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return null;
    try {
      const d = new Date(dateStr);
      return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) +
        ' at ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    } catch {
      return dateStr;
    }
  };

  // ── Actions ──────────────────────────────────────────────────────────────

  const handleMarkPosted = async (depId) => {
    setMarkingPostedIds(prev => new Set(prev).add(depId));
    try {
      await api.updateDeploymentStatus(depId, 'posted');
      setDeployments(prev => prev.map(d => d.id === depId ? { ...d, status: 'posted', posted_date: new Date().toISOString() } : d));
      addToast('Marked as posted', 'success');
      setConfirmPosted(null);
    } catch {
      addToast('Failed to update status', 'error');
    }
    setMarkingPostedIds(prev => { const next = new Set(prev); next.delete(depId); return next; });
  };

  const handleMarkFlexPosted = async (flexAd) => {
    const flexId = `flex-${flexAd.id}`;
    setMarkingPostedIds(prev => new Set(prev).add(flexId));
    try {
      const childDeps = getFlexChildDeps(flexAd);
      await Promise.all(childDeps.map(d => api.updateDeploymentStatus(d.id, 'posted')));
      setDeployments(prev => prev.map(d => {
        let childIds = [];
        try { childIds = flexAd.child_deployment_ids ? JSON.parse(flexAd.child_deployment_ids) : []; } catch { /* ignore */ }
        if (childIds.includes(d.id)) return { ...d, status: 'posted', posted_date: new Date().toISOString() };
        return d;
      }));
      addToast(`${childDeps.length} ads marked as posted`, 'success');
      setConfirmPosted(null);
    } catch {
      addToast('Failed to update status', 'error');
    }
    setMarkingPostedIds(prev => { const next = new Set(prev); next.delete(flexId); return next; });
  };

  const handleSendBack = async (depId) => {
    setSendingBackIds(prev => new Set(prev).add(depId));
    try {
      await api.updateDeploymentStatus(depId, 'selected');
      setDeployments(prev => prev.map(d => d.id === depId ? { ...d, status: 'selected' } : d));
      addToast('Sent back to Planner', 'success');
    } catch {
      addToast('Failed to send back', 'error');
    }
    setSendingBackIds(prev => { const next = new Set(prev); next.delete(depId); return next; });
  };

  const handleSendBackFlex = async (flexAd) => {
    const flexId = `flex-${flexAd.id}`;
    setSendingBackIds(prev => new Set(prev).add(flexId));
    try {
      const childDeps = getFlexChildDeps(flexAd);
      await Promise.all(childDeps.map(d => api.updateDeploymentStatus(d.id, 'selected')));
      setDeployments(prev => prev.map(d => {
        let childIds = [];
        try { childIds = flexAd.child_deployment_ids ? JSON.parse(flexAd.child_deployment_ids) : []; } catch { /* ignore */ }
        if (childIds.includes(d.id)) return { ...d, status: 'selected' };
        return d;
      }));
      addToast('Sent back to Planner', 'success');
    } catch {
      addToast('Failed to send back', 'error');
    }
    setSendingBackIds(prev => { const next = new Set(prev); next.delete(flexId); return next; });
  };

  const handleBulkMarkAllPosted = async () => {
    if (readyDeps.length === 0) return;
    setBulkMarkingAll(true);
    try {
      await Promise.all(readyDeps.map(d => api.updateDeploymentStatus(d.id, 'posted')));
      setDeployments(prev => prev.map(d =>
        d.status === 'ready_to_post' ? { ...d, status: 'posted', posted_date: new Date().toISOString() } : d
      ));
      addToast(`${readyDeps.length} ads marked as posted`, 'success');
    } catch {
      addToast('Failed to update some ads', 'error');
    }
    setBulkMarkingAll(false);
  };

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
      const results = await Promise.allSettled(
        withImages.map(async (dep) => {
          const res = await fetch(dep.imageUrl);
          const blob = await res.blob();
          const ext = blob.type === 'image/jpeg' ? '.jpg' : '.png';
          return { dep, blob, ext };
        })
      );
      const fulfilled = results.filter(r => r.status === 'fulfilled').map(r => r.value);
      if (fulfilled.length === 0) { addToast('Failed to download images', 'error'); return; }

      const zip = new JSZip();
      const usedNames = new Set();
      for (const { dep, blob, ext } of fulfilled) {
        let baseName = (dep.ad_name || dep.ad?.headline || dep.id || 'ad').replace(/[^a-z0-9]/gi, '-').slice(0, 40);
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
      a.download = `ad-creatives-${fulfilled.length}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      addToast(`Downloaded ${fulfilled.length} images`, 'success');
    } catch {
      addToast('Failed to create ZIP', 'error');
    }
    stateSet(prev => { const next = new Set(prev); next.delete(stateKey); return next; });
  };

  // Toggle image selection for a card
  const toggleImageSelection = (cardKey, depId) => {
    setSelectedImages(prev => {
      const current = prev[cardKey] || new Set();
      const next = new Set(current);
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

  // ── Reusable UI Components ──────────────────────────────────────────────

  const CopyBtn = ({ text, label, small }) => {
    if (!text || text.trim() === '' || text === '[]') return null;
    return (
      <button
        onClick={(e) => { e.stopPropagation(); copyToClipboard(text, label); }}
        className={`inline-flex items-center gap-1 rounded-md bg-navy/5 text-navy font-medium hover:bg-navy/10 transition-colors flex-shrink-0 ${
          small ? 'px-1.5 py-0.5 text-[9px]' : 'px-2 py-1 text-[10px]'
        }`}
      >
        <svg className={small ? 'w-2.5 h-2.5' : 'w-3 h-3'} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
        {label}
      </button>
    );
  };

  // Download icon button (small, for individual images)
  const DownloadBtn = ({ dep, small }) => {
    if (!dep.imageUrl) return null;
    const isDownloading = downloadingSingle.has(dep.id);
    return (
      <button
        onClick={(e) => { e.stopPropagation(); downloadSingleImage(dep); }}
        disabled={isDownloading}
        className={`inline-flex items-center gap-1 rounded-md bg-navy/5 text-navy font-medium hover:bg-navy/10 transition-colors flex-shrink-0 disabled:opacity-50 ${
          small ? 'px-1.5 py-0.5 text-[9px]' : 'px-2 py-1 text-[10px]'
        }`}
        title="Download image"
      >
        <svg className={small ? 'w-2.5 h-2.5' : 'w-3 h-3'} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
        </svg>
        {isDownloading ? '...' : 'Download'}
      </button>
    );
  };

  // Render numbered text items with explanation
  const renderNumberedTexts = (jsonStr, sectionLabel, explanation) => {
    let items = [];
    try { items = JSON.parse(jsonStr); } catch { return null; }
    items = items.filter(Boolean);
    if (items.length === 0) return null;

    const allText = items.join('\n\n');

    return (
      <div>
        <div className="flex items-center justify-between mb-1">
          <div className="text-[10px] font-bold text-textmid uppercase tracking-wider">{sectionLabel}</div>
          <CopyBtn text={allText} label="Copy All" />
        </div>
        {explanation && (
          <p className="text-[11px] text-textmid mb-2">{explanation}</p>
        )}
        <div className="space-y-1.5">
          {items.map((text, i) => (
            <div key={i} className="flex items-start gap-2 bg-offwhite rounded-lg p-2.5 group">
              <span className="text-[11px] font-bold text-navy/40 mt-0.5 flex-shrink-0 w-4 text-right">{i + 1}.</span>
              <div className="flex-1 text-[12px] text-textdark whitespace-pre-wrap leading-relaxed">{text}</div>
              <CopyBtn text={text} label="Copy" small />
            </div>
          ))}
        </div>
      </div>
    );
  };

  // "POST IN" section
  const PostInSection = ({ campaignName, adSetName }) => {
    if (!campaignName && !adSetName) {
      return (
        <div className="bg-gold/10 border border-gold/20 rounded-lg p-3">
          <div className="flex items-center gap-1.5">
            <svg className="w-3.5 h-3.5 text-gold" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
            </svg>
            <span className="text-[11px] font-bold text-gold uppercase tracking-wider">Not Assigned to Campaign</span>
          </div>
          <div className="text-[11px] text-textmid mt-1">This ad needs to be assigned to a campaign and ad set in the Planner first.</div>
        </div>
      );
    }

    return (
      <div className="bg-navy/5 border border-navy/10 rounded-lg p-3">
        <div className="text-[9px] font-bold text-navy/60 uppercase tracking-widest mb-1.5">Post In</div>
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-medium text-textmid uppercase w-16 flex-shrink-0">Campaign</span>
            <span className="font-semibold text-[13px] text-textdark">{campaignName}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-medium text-textmid uppercase w-16 flex-shrink-0">Ad Set</span>
            <span className="font-semibold text-[13px] text-textdark">{adSetName}</span>
          </div>
        </div>
      </div>
    );
  };

  // Info row for the card header (ad name, format, date)
  const InfoHeader = ({ name, adFormat, plannedDate, formatBadgeColor }) => (
    <div className="bg-offwhite border-b border-black/[0.06] px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-[15px] text-textdark leading-tight">{name}</span>
            <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${formatBadgeColor}`}>
              {adFormat}
            </span>
          </div>
        </div>
      </div>
      {plannedDate && (
        <div className="flex items-center gap-1.5 mt-2 bg-white/80 rounded-lg px-2.5 py-1.5 w-fit">
          <svg className="w-4 h-4 text-navy" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          <span className="text-[12px] font-semibold text-navy">Schedule: {plannedDate}</span>
        </div>
      )}
    </div>
  );

  // ── Card Renderers ──────────────────────────────────────────────────────

  // Render a single ad card
  const renderAdCard = (dep) => {
    const name = dep.ad_name || dep.ad?.headline || dep.ad?.angle || `Ad ${(dep.id || '').slice(0, 6)}`;
    const thumbUrl = dep.imageUrl;
    const plannedDate = formatDate(dep.planned_date);
    const isMarking = markingPostedIds.has(dep.id);
    const isSendingBack = sendingBackIds.has(dep.id);
    const { campaignName, adSetName } = resolveLocation(dep);

    return (
      <div key={dep.id} className="border border-black/[0.08] rounded-2xl bg-white shadow-sm overflow-hidden">
        {/* ── 1. Info Header: Name + Format + Date ── */}
        <InfoHeader
          name={name}
          adFormat="Single Image"
          plannedDate={plannedDate}
          formatBadgeColor="bg-navy/10 text-navy"
        />

        {/* ── 2. POST IN ── */}
        <div className="px-4 pt-3 pb-3">
          <PostInSection campaignName={campaignName} adSetName={adSetName} />
        </div>

        {/* ── 3. Ad Creative (single image) ── */}
        {thumbUrl && (
          <div className="px-4 pb-4">
            <div className="flex items-center justify-between mb-2">
              <div className="text-[10px] font-bold text-textmid uppercase tracking-wider">Ad Creative</div>
              <DownloadBtn dep={dep} />
            </div>
            <img src={thumbUrl} alt="" className="w-full max-w-[280px] rounded-xl bg-offwhite" loading="lazy" />
          </div>
        )}

        {/* ── 4. Content Sections ── */}
        <div className="px-4 pb-4 space-y-4">
          {renderNumberedTexts(
            dep.primary_texts,
            `Primary Text (${(() => { try { return JSON.parse(dep.primary_texts).filter(Boolean).length; } catch { return 0; } })() } Variations)`,
            'Meta will rotate these variations to find the best performer. Upload all of them when creating the ad.'
          )}

          {renderNumberedTexts(
            dep.ad_headlines,
            `Headlines (${(() => { try { return JSON.parse(dep.ad_headlines).filter(Boolean).length; } catch { return 0; } })() } Variations)`,
            'Meta will test these headline variations. Upload all of them when creating the ad.'
          )}

          {dep.destination_url && (
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <div className="text-[10px] font-bold text-textmid uppercase tracking-wider">Destination URL</div>
                <CopyBtn text={dep.destination_url} label="Copy" />
              </div>
              <a href={dep.destination_url} target="_blank" rel="noopener noreferrer"
                className="text-[12px] text-gold hover:underline break-all leading-relaxed"
              >{dep.destination_url}</a>
            </div>
          )}

          {dep.cta_button && (
            <div>
              <div className="text-[10px] font-bold text-textmid uppercase tracking-wider mb-1.5">CTA Button</div>
              <span className="inline-block px-3 py-1 rounded-full bg-navy/10 text-navy text-[12px] font-semibold">
                {dep.cta_button.replace(/_/g, ' ')}
              </span>
            </div>
          )}
        </div>

        {/* ── 5. Actions ── */}
        <div className="px-4 py-3 border-t border-black/[0.06] bg-offwhite/50 flex items-center justify-between">
          <button
            onClick={() => handleSendBack(dep.id)}
            disabled={isSendingBack}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium text-textmid hover:text-textdark hover:bg-black/[0.04] transition-colors disabled:opacity-50"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
            </svg>
            {isSendingBack ? 'Sending...' : 'Send Back to Planner'}
          </button>
          {confirmPosted === dep.id ? (
            <div className="flex items-center gap-2">
              <button onClick={() => setConfirmPosted(null)}
                className="px-2.5 py-1.5 rounded-lg text-[11px] text-textmid hover:bg-white transition-colors"
              >Cancel</button>
              <button onClick={() => handleMarkPosted(dep.id)} disabled={isMarking}
                className="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-teal text-white hover:bg-teal/90 transition-colors disabled:opacity-50"
              >{isMarking ? 'Updating...' : 'Confirm Posted'}</button>
            </div>
          ) : (
            <button onClick={() => setConfirmPosted(dep.id)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold text-white bg-teal hover:bg-teal/90 transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              Mark as Posted
            </button>
          )}
        </div>
      </div>
    );
  };

  // Render a flex ad card
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

    return (
      <div key={flexAd.id} className="border border-navy/15 rounded-2xl bg-white shadow-sm overflow-hidden">
        {/* ── 1. Info Header: Name + Format + Date ── */}
        <InfoHeader
          name={flexAd.name || 'Flex Ad'}
          adFormat="Flexible Ad"
          plannedDate={plannedDate}
          formatBadgeColor="bg-purple-100 text-purple-700"
        />

        {/* ── 2. POST IN ── */}
        <div className="px-4 pt-3 pb-3">
          <PostInSection campaignName={campaignName} adSetName={adSetName} />
        </div>

        {/* ── 3. Ad Creatives (multiple images with download) ── */}
        <div className="px-4 pb-4">
          <div className="flex items-center justify-between mb-2">
            <div className="text-[10px] font-bold text-textmid uppercase tracking-wider">
              Ad Creatives ({depsWithImages.length} Image{depsWithImages.length !== 1 ? 's' : ''})
            </div>
            <div className="flex items-center gap-1.5">
              {someSelected && (
                <button
                  onClick={() => {
                    const selectedDeps = childDeps.filter(d => selected.has(d.id));
                    downloadMultipleImages(selectedDeps, `selected-${cardKey}`);
                  }}
                  disabled={isDownloadingSelected}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium bg-gold/10 text-gold hover:bg-gold/20 transition-colors disabled:opacity-50"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  {isDownloadingSelected ? '...' : `Download Selected (${selected.size})`}
                </button>
              )}
              <button
                onClick={() => downloadMultipleImages(depsWithImages, cardKey)}
                disabled={isDownloadingAll || depsWithImages.length === 0}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-medium bg-navy/5 text-navy hover:bg-navy/10 transition-colors disabled:opacity-50"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                {isDownloadingAll ? 'Zipping...' : 'Download All'}
              </button>
            </div>
          </div>
          <p className="text-[11px] text-textmid mb-2.5">Meta will rotate these images to find the best performer. Upload all of them when creating the ad.</p>

          {/* Select All checkbox */}
          {depsWithImages.length > 1 && (
            <label className="flex items-center gap-2 mb-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={() => toggleSelectAll(cardKey, depsWithImages.map(d => d.id))}
                className="rounded border-navy/30 text-navy focus:ring-navy/20 w-3.5 h-3.5"
              />
              <span className="text-[11px] text-textmid font-medium">Select All</span>
            </label>
          )}

          {/* Image grid with selection + download */}
          <div className="grid grid-cols-3 gap-2.5">
            {childDeps.map(d => {
              const isSelected = selected.has(d.id);
              const isSingleDownloading = downloadingSingle.has(d.id);
              return (
                <div key={d.id} className="relative group">
                  {/* Selection checkbox */}
                  {d.imageUrl && (
                    <label className="absolute top-1.5 left-1.5 z-10 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleImageSelection(cardKey, d.id)}
                        className="rounded border-white/80 text-navy focus:ring-navy/20 w-4 h-4 shadow-sm"
                      />
                    </label>
                  )}
                  {d.imageUrl ? (
                    <img
                      src={d.imageUrl} alt=""
                      className={`w-full aspect-square object-cover rounded-xl bg-offwhite transition-all ${
                        isSelected ? 'ring-2 ring-navy ring-offset-1' : ''
                      }`}
                      loading="lazy"
                    />
                  ) : (
                    <div className="w-full aspect-square rounded-xl bg-offwhite" />
                  )}
                  {/* Per-image download */}
                  {d.imageUrl && (
                    <button
                      onClick={() => downloadSingleImage(d)}
                      disabled={isSingleDownloading}
                      className="absolute bottom-1.5 right-1.5 p-1.5 rounded-lg bg-white/90 text-navy hover:bg-white shadow-sm opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-50"
                      title="Download"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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

        {/* ── 4. Content Sections ── */}
        <div className="px-4 pb-4 space-y-4">
          {renderNumberedTexts(
            flexAd.primary_texts,
            `Primary Text (${(() => { try { return JSON.parse(flexAd.primary_texts).filter(Boolean).length; } catch { return 0; } })() } Variations)`,
            'Meta will rotate these text variations to find the best performer. Upload all of them when creating the ad.'
          )}

          {renderNumberedTexts(
            flexAd.headlines,
            `Headlines (${(() => { try { return JSON.parse(flexAd.headlines).filter(Boolean).length; } catch { return 0; } })() } Variations)`,
            'Meta will test these headline variations. Upload all of them when creating the ad.'
          )}

          {flexAd.destination_url && (
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <div className="text-[10px] font-bold text-textmid uppercase tracking-wider">Destination URL</div>
                <CopyBtn text={flexAd.destination_url} label="Copy" />
              </div>
              <a href={flexAd.destination_url} target="_blank" rel="noopener noreferrer"
                className="text-[12px] text-gold hover:underline break-all leading-relaxed"
              >{flexAd.destination_url}</a>
            </div>
          )}

          {flexAd.cta_button && (
            <div>
              <div className="text-[10px] font-bold text-textmid uppercase tracking-wider mb-1.5">CTA Button</div>
              <span className="inline-block px-3 py-1 rounded-full bg-navy/10 text-navy text-[12px] font-semibold">
                {flexAd.cta_button.replace(/_/g, ' ')}
              </span>
            </div>
          )}
        </div>

        {/* ── 5. Actions ── */}
        <div className="px-4 py-3 border-t border-navy/10 bg-offwhite/50 flex items-center justify-between">
          <button
            onClick={() => handleSendBackFlex(flexAd)}
            disabled={isSendingBack}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium text-textmid hover:text-textdark hover:bg-black/[0.04] transition-colors disabled:opacity-50"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
            </svg>
            {isSendingBack ? 'Sending...' : 'Send Back to Planner'}
          </button>
          {confirmPosted === flexId ? (
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-textmid">{childDeps.length} ad{childDeps.length !== 1 ? 's' : ''}</span>
              <button onClick={() => setConfirmPosted(null)}
                className="px-2.5 py-1.5 rounded-lg text-[11px] text-textmid hover:bg-white transition-colors"
              >Cancel</button>
              <button onClick={() => handleMarkFlexPosted(flexAd)} disabled={isMarking}
                className="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-teal text-white hover:bg-teal/90 transition-colors disabled:opacity-50"
              >{isMarking ? 'Updating...' : 'Confirm Posted'}</button>
            </div>
          ) : (
            <button onClick={() => setConfirmPosted(flexId)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-semibold text-white bg-teal hover:bg-teal/90 transition-colors"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              Mark All as Posted
            </button>
          )}
        </div>
      </div>
    );
  };

  // ── Build flat sorted list ──────────────────────────────────────────────

  const buildCardList = () => {
    const cards = [];
    const flexChildIds = new Set();
    flexAds.forEach(fa => {
      try {
        const ids = fa.child_deployment_ids ? JSON.parse(fa.child_deployment_ids) : [];
        ids.forEach(id => flexChildIds.add(id));
      } catch { /* ignore */ }
    });

    readyDeps.forEach(dep => {
      if (flexChildIds.has(dep.id)) return;
      const { campaignName, adSetName } = resolveLocation(dep);
      cards.push({
        type: 'single', dep,
        campaignName: campaignName || '', adSetName: adSetName || '',
        plannedDate: dep.planned_date || '', key: dep.id,
      });
    });

    flexAds.forEach(fa => {
      if (!flexHasReadyChildren(fa)) return;
      const { campaignName, adSetName } = resolveFlexLocation(fa);
      cards.push({
        type: 'flex', flexAd: fa,
        campaignName: campaignName || '', adSetName: adSetName || '',
        plannedDate: fa.planned_date || '', key: `flex-${fa.id}`,
      });
    });

    cards.sort((a, b) => {
      const aUnassigned = !a.campaignName;
      const bUnassigned = !b.campaignName;
      if (aUnassigned !== bUnassigned) return aUnassigned ? -1 : 1;
      if (a.campaignName !== b.campaignName) return a.campaignName.localeCompare(b.campaignName);
      if (a.adSetName !== b.adSetName) return a.adSetName.localeCompare(b.adSetName);
      if (a.plannedDate && b.plannedDate) return a.plannedDate.localeCompare(b.plannedDate);
      if (a.plannedDate) return -1;
      if (b.plannedDate) return 1;
      return 0;
    });

    return cards;
  };

  // ── Render ──────────────────────────────────────────────────────────────

  if (loading) {
    return <div className="text-center py-12 text-textmid text-[13px]">Loading...</div>;
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
    <div className="space-y-4">
      {/* Summary bar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-[13px]">
          <span className="font-semibold text-textdark">{readyDeps.length}</span>
          <span className="text-textmid">ad{readyDeps.length !== 1 ? 's' : ''} ready to post</span>
        </div>
        <button
          onClick={handleBulkMarkAllPosted}
          disabled={bulkMarkingAll}
          className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-[11px] font-semibold bg-teal text-white hover:bg-teal/90 transition-colors disabled:opacity-50"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          {bulkMarkingAll ? 'Marking...' : `Mark All as Posted (${readyDeps.length})`}
        </button>
      </div>

      {/* Flat card list */}
      <div className="space-y-4">
        {cardList.map(card =>
          card.type === 'single'
            ? renderAdCard(card.dep)
            : renderFlexCard(card.flexAd)
        )}
      </div>
    </div>
  );
}

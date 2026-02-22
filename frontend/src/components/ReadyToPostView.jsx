import { useState, useEffect, useCallback } from 'react';
import JSZip from 'jszip';
import { api } from '../api';

/**
 * ReadyToPostView — Employee-facing view for posting ads to Meta Ads Manager.
 *
 * Designed to be extremely clear for employees who may not be familiar with
 * Meta's interface. Every section is explicitly labeled with plain-English
 * descriptions and helper text explaining where things go in Ads Manager.
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
  const [selectedImages, setSelectedImages] = useState({});
  const [downloadingAll, setDownloadingAll] = useState(new Set());
  const [downloadingSelected, setDownloadingSelected] = useState(new Set());
  const [downloadingSingle, setDownloadingSingle] = useState(new Set());

  useEffect(() => { loadData(); }, [projectId]);

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

  const readyDeps = deployments.filter(d => d.status === 'ready_to_post');

  // ── Helpers ──────────────────────────────────────────────────────────────

  const resolveLocation = (dep) => {
    const adSet = adSets.find(a => a.id === dep.local_adset_id);
    if (!adSet) return { campaignName: null, adSetName: null };
    const campaign = campaigns.find(c => adSets.filter(a => a.campaign_id === c.id).some(a => a.id === dep.local_adset_id));
    return { campaignName: campaign?.name || null, adSetName: adSet?.name || null };
  };

  const resolveFlexLocation = (flexAd) => {
    const adSet = adSets.find(a => a.id === flexAd.ad_set_id);
    if (!adSet) return { campaignName: null, adSetName: null };
    const campaign = campaigns.find(c => adSets.filter(a => a.campaign_id === c.id).some(a => a.id === flexAd.ad_set_id));
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

  const parseCount = (jsonStr) => {
    try { return JSON.parse(jsonStr).filter(Boolean).length; } catch { return 0; }
  };

  // ── Actions ──────────────────────────────────────────────────────────────

  const handleMarkPosted = async (depId) => {
    setMarkingPostedIds(prev => new Set(prev).add(depId));
    try {
      await api.updateDeploymentStatus(depId, 'posted');
      setDeployments(prev => prev.map(d => d.id === depId ? { ...d, status: 'posted', posted_date: new Date().toISOString() } : d));
      addToast('Marked as posted', 'success');
      setConfirmPosted(null);
    } catch { addToast('Failed to update status', 'error'); }
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
    } catch { addToast('Failed to update status', 'error'); }
    setMarkingPostedIds(prev => { const next = new Set(prev); next.delete(flexId); return next; });
  };

  const handleSendBack = async (depId) => {
    setSendingBackIds(prev => new Set(prev).add(depId));
    try {
      await api.updateDeploymentStatus(depId, 'selected');
      setDeployments(prev => prev.map(d => d.id === depId ? { ...d, status: 'selected' } : d));
      addToast('Sent back to Planner', 'success');
    } catch { addToast('Failed to send back', 'error'); }
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
    } catch { addToast('Failed to send back', 'error'); }
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
    } catch { addToast('Failed to update some ads', 'error'); }
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

  // Render numbered text items
  const renderNumberedTexts = (jsonStr, sectionLabel, helper) => {
    let items = [];
    try { items = JSON.parse(jsonStr); } catch { return null; }
    items = items.filter(Boolean);
    if (items.length === 0) return null;
    const allText = items.join('\n\n');

    return (
      <div className="border border-black/[0.06] rounded-xl p-4 bg-white">
        <div className="flex items-start justify-between gap-3 mb-2">
          <div>
            <span className="inline-block px-2 py-0.5 rounded bg-navy/10 text-navy text-[10px] font-bold uppercase tracking-widest mb-1">{sectionLabel}</span>
            {helper && <p className="text-[11px] text-textmid mt-0.5 leading-relaxed">{helper}</p>}
          </div>
          <CopyBtn text={allText} label="Copy All" />
        </div>
        <div className="space-y-2">
          {items.map((text, i) => (
            <div key={i} className="flex items-start gap-2.5 bg-offwhite rounded-lg p-3">
              <span className="text-[12px] font-bold text-white bg-navy rounded-full w-6 h-6 flex items-center justify-center flex-shrink-0 mt-0.5">{i + 1}</span>
              <div className="flex-1 text-[13px] text-textdark whitespace-pre-wrap leading-relaxed">{text}</div>
              <CopyBtn text={text} label="Copy" small />
            </div>
          ))}
        </div>
      </div>
    );
  };

  // ── Card Sections ──────────────────────────────────────────────────────

  // Top info bar: Ad Name, Ad Format, Post Date — color-coded labels
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
          <span className="inline-block px-2 py-0.5 rounded bg-purple-100 text-purple-700 text-[10px] font-bold uppercase tracking-widest mb-1">Ad Format</span>
          <div className="text-[14px] font-bold text-textdark">{adFormat}</div>
        </div>
        {plannedDate && (
          <div>
            <span className="inline-block px-2 py-0.5 rounded bg-teal/10 text-teal text-[10px] font-bold uppercase tracking-widest mb-1">Post Date</span>
            <div className="text-[14px] font-bold text-textdark">{plannedDate}</div>
          </div>
        )}
      </div>
    </div>
  );

  // "Post in" section: Campaign + Ad Set
  const PostInSection = ({ campaignName, adSetName }) => {
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
    return (
      <div className="bg-navy/5 border-2 border-navy/15 rounded-xl p-4">
        <span className="inline-block px-2 py-0.5 rounded bg-navy text-white text-[10px] font-bold uppercase tracking-widest mb-3">Post This Ad In</span>
        <div className="space-y-2.5">
          <div className="flex items-center gap-3">
            <span className="inline-block px-2 py-0.5 rounded bg-navy/10 text-navy text-[10px] font-bold uppercase tracking-wider w-20 text-center flex-shrink-0">Campaign</span>
            <span className="text-[15px] font-bold text-textdark">{campaignName}</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="inline-block px-2 py-0.5 rounded bg-navy/10 text-navy text-[10px] font-bold uppercase tracking-wider w-20 text-center flex-shrink-0">Ad Set</span>
            <span className="text-[15px] font-bold text-textdark">{adSetName}</span>
          </div>
        </div>
      </div>
    );
  };

  // Website URL section — big, clear, prominent
  const WebsiteUrlSection = ({ url }) => {
    if (!url) return null;
    return (
      <div className="border-2 border-gold/25 bg-gold/5 rounded-xl p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <span className="inline-block px-2 py-0.5 rounded bg-gold/20 text-gold text-[10px] font-bold uppercase tracking-widest mb-1">Website URL</span>
            <p className="text-[11px] text-textmid mb-2">Paste this into the <strong>"Website URL"</strong> field in Ads Manager.</p>
            <div className="bg-white rounded-lg px-3 py-2 border border-gold/20">
              <a href={url} target="_blank" rel="noopener noreferrer"
                className="text-[13px] text-gold font-medium hover:underline break-all"
              >{url}</a>
            </div>
          </div>
          <button onClick={() => copyToClipboard(url, 'Website URL')}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-gold text-white text-[11px] font-bold hover:bg-gold/90 transition-colors flex-shrink-0 shadow-sm"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            Copy URL
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

  // ── Card Renderers ──────────────────────────────────────────────────────

  // Single ad card
  const renderAdCard = (dep) => {
    const name = dep.ad_name || dep.ad?.headline || dep.ad?.angle || `Ad ${(dep.id || '').slice(0, 6)}`;
    const thumbUrl = dep.imageUrl;
    const plannedDate = formatDate(dep.planned_date);
    const isMarking = markingPostedIds.has(dep.id);
    const isSendingBack = sendingBackIds.has(dep.id);
    const { campaignName, adSetName } = resolveLocation(dep);

    return (
      <div key={dep.id} className="border border-black/[0.1] rounded-2xl bg-white shadow-sm overflow-hidden">
        <InfoBar name={name} adFormat="Single Image" plannedDate={plannedDate} />

        <div className="p-5 space-y-4">
          <PostInSection campaignName={campaignName} adSetName={adSetName} />

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
              <img src={thumbUrl} alt="" className="w-full max-w-[300px] rounded-xl bg-offwhite" loading="lazy" />
            </div>
          )}

          {/* Primary Text */}
          {renderNumberedTexts(
            dep.primary_texts,
            `Primary Text \u2014 ${parseCount(dep.primary_texts)} Variation${parseCount(dep.primary_texts) !== 1 ? 's' : ''}`,
            'Upload ALL of these into the "Primary Text" field. Meta will automatically rotate them and show the best-performing version to each person.'
          )}

          {/* Headlines */}
          {renderNumberedTexts(
            dep.ad_headlines,
            `Headlines \u2014 ${parseCount(dep.ad_headlines)} Variation${parseCount(dep.ad_headlines) !== 1 ? 's' : ''}`,
            'Upload ALL of these into the "Headline" field. Meta will automatically test each one and show the best performer.'
          )}

          <WebsiteUrlSection url={dep.destination_url} />
          <CallToActionSection cta={dep.cta_button} />
        </div>

        {/* Actions */}
        <div className="px-5 py-3.5 border-t border-black/[0.08] bg-offwhite/50 flex items-center justify-between">
          <button onClick={() => handleSendBack(dep.id)} disabled={isSendingBack}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium text-textmid hover:text-textdark hover:bg-black/[0.04] transition-colors disabled:opacity-50"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
            </svg>
            {isSendingBack ? 'Sending...' : 'Send Back to Planner'}
          </button>
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
    );
  };

  // Flex ad card
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
        <InfoBar name={flexAd.name || 'Flex Ad'} adFormat="Flexible" plannedDate={plannedDate} />

        <div className="p-5 space-y-4">
          <PostInSection campaignName={campaignName} adSetName={adSetName} />

          {/* Ad Creatives with download */}
          <div className="border border-black/[0.06] rounded-xl p-4 bg-white">
            <div className="mb-1">
              <span className="inline-block px-2 py-0.5 rounded bg-navy/10 text-navy text-[10px] font-bold uppercase tracking-widest mb-1">
                Ad Creatives \u2014 {depsWithImages.length} Image{depsWithImages.length !== 1 ? 's' : ''}
              </span>
              <p className="text-[11px] text-textmid mt-0.5 leading-relaxed">Upload ALL of these images. Meta will automatically rotate them and show the best-performing image to each person.</p>
            </div>

            {/* Download bar — prominent, left-aligned */}
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
            <div className="grid grid-cols-3 gap-3">
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
                        className="absolute bottom-2 right-2 p-1.5 rounded-lg bg-white/90 text-navy hover:bg-white shadow-sm opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-50"
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
            `Primary Text \u2014 ${parseCount(flexAd.primary_texts)} Variation${parseCount(flexAd.primary_texts) !== 1 ? 's' : ''}`,
            'Upload ALL of these into the "Primary Text" field. Meta will automatically rotate them and show the best-performing version to each person.'
          )}

          {/* Headlines */}
          {renderNumberedTexts(
            flexAd.headlines,
            `Headlines \u2014 ${parseCount(flexAd.headlines)} Variation${parseCount(flexAd.headlines) !== 1 ? 's' : ''}`,
            'Upload ALL of these into the "Headline" field. Meta will automatically test each one and show the best performer.'
          )}

          <WebsiteUrlSection url={flexAd.destination_url} />
          <CallToActionSection cta={flexAd.cta_button} />
        </div>

        {/* Actions */}
        <div className="px-5 py-3.5 border-t border-navy/10 bg-offwhite/50 flex items-center justify-between">
          <button onClick={() => handleSendBackFlex(flexAd)} disabled={isSendingBack}
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
      try { (fa.child_deployment_ids ? JSON.parse(fa.child_deployment_ids) : []).forEach(id => flexChildIds.add(id)); } catch { /* ignore */ }
    });
    readyDeps.forEach(dep => {
      if (flexChildIds.has(dep.id)) return;
      const { campaignName, adSetName } = resolveLocation(dep);
      cards.push({ type: 'single', dep, campaignName: campaignName || '', adSetName: adSetName || '', plannedDate: dep.planned_date || '', key: dep.id });
    });
    flexAds.forEach(fa => {
      if (!flexHasReadyChildren(fa)) return;
      const { campaignName, adSetName } = resolveFlexLocation(fa);
      cards.push({ type: 'flex', flexAd: fa, campaignName: campaignName || '', adSetName: adSetName || '', plannedDate: fa.planned_date || '', key: `flex-${fa.id}` });
    });
    cards.sort((a, b) => {
      const aU = !a.campaignName, bU = !b.campaignName;
      if (aU !== bU) return aU ? -1 : 1;
      if (a.campaignName !== b.campaignName) return a.campaignName.localeCompare(b.campaignName);
      if (a.adSetName !== b.adSetName) return a.adSetName.localeCompare(b.adSetName);
      if (a.plannedDate && b.plannedDate) return a.plannedDate.localeCompare(b.plannedDate);
      if (a.plannedDate) return -1; if (b.plannedDate) return 1; return 0;
    });
    return cards;
  };

  // ── Render ──────────────────────────────────────────────────────────────

  if (loading) return <div className="text-center py-12 text-textmid text-[13px]">Loading...</div>;

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
      {/* Summary */}
      <div className="flex items-center justify-between">
        <div className="text-[14px]">
          <span className="font-bold text-textdark">{readyDeps.length}</span>
          <span className="text-textmid ml-1.5">ad{readyDeps.length !== 1 ? 's' : ''} ready to post</span>
        </div>
        <button onClick={handleBulkMarkAllPosted} disabled={bulkMarkingAll}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-[12px] font-bold bg-teal text-white hover:bg-teal/90 transition-colors disabled:opacity-50 shadow-sm"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          {bulkMarkingAll ? 'Marking...' : `Mark All as Posted (${readyDeps.length})`}
        </button>
      </div>

      {/* Cards */}
      <div className="space-y-5">
        {cardList.map(card => card.type === 'single' ? renderAdCard(card.dep) : renderFlexCard(card.flexAd))}
      </div>
    </div>
  );
}

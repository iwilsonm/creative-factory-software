import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';

/**
 * ReadyToPostView — Employee-facing view showing only ads with status 'ready_to_post'.
 *
 * Layout: Flat list of self-contained cards, each showing:
 *   - Ad image + name
 *   - "POST IN" section with Campaign > Ad Set names prominently displayed
 *   - Individually numbered primary texts with per-item + copy-all buttons
 *   - Individually numbered headlines with per-item + copy-all buttons
 *   - Destination URL with copy button
 *   - CTA button label
 *   - Send Back to Planner + Mark as Posted actions
 *
 * Props: projectId, deployments, setDeployments, addToast, loadDeployments, onSwitchToPlanner
 */
export default function ReadyToPostView({ projectId, deployments, setDeployments, addToast, loadDeployments, onSwitchToPlanner }) {
  const [campaigns, setCampaigns] = useState([]);
  const [adSets, setAdSets] = useState([]);
  const [flexAds, setFlexAds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [confirmPosted, setConfirmPosted] = useState(null); // dep id or flex ad id
  const [markingPostedIds, setMarkingPostedIds] = useState(new Set()); // per-ad loading state
  const [sendingBackIds, setSendingBackIds] = useState(new Set()); // per-ad send-back loading
  const [bulkMarkingAll, setBulkMarkingAll] = useState(false);

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

  // Resolve campaign + ad set names for a deployment
  const resolveLocation = (dep) => {
    const adSet = adSets.find(a => a.id === dep.local_adset_id);
    if (!adSet) return { campaignName: null, adSetName: null };
    const campaign = campaigns.find(c => {
      const campAdSets = adSets.filter(a => a.campaign_id === c.id);
      return campAdSets.some(a => a.id === dep.local_adset_id);
    });
    return {
      campaignName: campaign?.name || null,
      adSetName: adSet?.name || null,
    };
  };

  // Resolve campaign + ad set for a flex ad
  const resolveFlexLocation = (flexAd) => {
    const adSet = adSets.find(a => a.id === flexAd.ad_set_id);
    if (!adSet) return { campaignName: null, adSetName: null };
    const campaign = campaigns.find(c => {
      const campAdSets = adSets.filter(a => a.campaign_id === c.id);
      return campAdSets.some(a => a.id === flexAd.ad_set_id);
    });
    return {
      campaignName: campaign?.name || null,
      adSetName: adSet?.name || null,
    };
  };

  // Get child deps for a flex ad that are ready_to_post
  const getFlexChildDeps = (flexAd) => {
    let childIds = [];
    try { childIds = flexAd.child_deployment_ids ? JSON.parse(flexAd.child_deployment_ids) : []; } catch { /* ignore */ }
    return readyDeps.filter(d => childIds.includes(d.id));
  };

  // Check if a flex ad has any ready children
  const flexHasReadyChildren = (flexAd) => getFlexChildDeps(flexAd).length > 0;

  // Copy to clipboard
  const copyToClipboard = async (text, label) => {
    try {
      await navigator.clipboard.writeText(text);
      addToast(`${label} copied`, 'success');
    } catch {
      addToast('Failed to copy', 'error');
    }
  };

  // Format planned date
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

  // Mark as posted (per-ad loading state)
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

  // Mark all children of a flex ad as posted
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

  // Send back to Planner (single ad)
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

  // Send back all children of a flex ad
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

  // Bulk mark all ready_to_post as posted
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

  // ── Reusable UI Components ──────────────────────────────────────────────

  // Copy button component
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

  // Render numbered text items from a JSON string
  const renderNumberedTexts = (jsonStr, sectionLabel) => {
    let items = [];
    try { items = JSON.parse(jsonStr); } catch { return null; }
    items = items.filter(Boolean);
    if (items.length === 0) return null;

    const allText = items.join('\n\n');

    return (
      <div>
        <div className="flex items-center justify-between mb-2">
          <div className="text-[10px] font-bold text-textmid uppercase tracking-wider">{sectionLabel}</div>
          <CopyBtn text={allText} label={`Copy All`} />
        </div>
        <div className="space-y-1.5">
          {items.map((text, i) => (
            <div key={i} className="flex items-start gap-2 bg-offwhite rounded-lg p-2.5 group">
              <span className="text-[11px] font-bold text-navy/40 mt-0.5 flex-shrink-0 w-4 text-right">{i + 1}.</span>
              <div className="flex-1 text-[12px] text-textdark whitespace-pre-wrap leading-relaxed">{text}</div>
              <CopyBtn text={text} label={`Copy`} small />
            </div>
          ))}
        </div>
      </div>
    );
  };

  // "POST IN" section showing campaign + ad set
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

  // ── Card Renderers ──────────────────────────────────────────────────────

  // Render a single ad card (full detail, no expand/collapse)
  const renderAdCard = (dep) => {
    const name = dep.ad_name || dep.ad?.headline || dep.ad?.angle || `Ad ${(dep.id || '').slice(0, 6)}`;
    const thumbUrl = dep.imageUrl;
    const plannedDate = formatDate(dep.planned_date);
    const isMarking = markingPostedIds.has(dep.id);
    const isSendingBack = sendingBackIds.has(dep.id);
    const { campaignName, adSetName } = resolveLocation(dep);

    return (
      <div key={dep.id} className="border border-black/[0.08] rounded-2xl bg-white shadow-sm overflow-hidden">
        {/* ── Header: Image + Name + Date ── */}
        <div className="p-4 pb-3">
          <div className="flex items-start gap-3.5">
            {thumbUrl && (
              <img src={thumbUrl} alt="" className="w-20 h-20 object-cover rounded-xl bg-offwhite flex-shrink-0" loading="lazy" />
            )}
            <div className="flex-1 min-w-0">
              <div className="font-semibold text-[14px] text-textdark leading-tight">{name}</div>
              {plannedDate && (
                <div className="flex items-center gap-1.5 mt-1.5">
                  <svg className="w-3.5 h-3.5 text-textlight" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                  <span className="text-[12px] text-textmid font-medium">{plannedDate}</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── POST IN ── */}
        <div className="px-4 pb-3">
          <PostInSection campaignName={campaignName} adSetName={adSetName} />
        </div>

        {/* ── Content Sections ── */}
        <div className="px-4 pb-4 space-y-4">
          {/* Primary Texts */}
          {renderNumberedTexts(dep.primary_texts, 'Primary Text')}

          {/* Headlines */}
          {renderNumberedTexts(dep.ad_headlines, 'Headlines')}

          {/* Destination URL */}
          {dep.destination_url && (
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <div className="text-[10px] font-bold text-textmid uppercase tracking-wider">Destination URL</div>
                <CopyBtn text={dep.destination_url} label="Copy" />
              </div>
              <a
                href={dep.destination_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[12px] text-gold hover:underline break-all leading-relaxed"
              >
                {dep.destination_url}
              </a>
            </div>
          )}

          {/* CTA Button */}
          {dep.cta_button && (
            <div>
              <div className="text-[10px] font-bold text-textmid uppercase tracking-wider mb-1.5">CTA Button</div>
              <span className="inline-block px-3 py-1 rounded-full bg-navy/10 text-navy text-[12px] font-semibold">
                {dep.cta_button.replace(/_/g, ' ')}
              </span>
            </div>
          )}
        </div>

        {/* ── Actions ── */}
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
              <button
                onClick={() => setConfirmPosted(null)}
                className="px-2.5 py-1.5 rounded-lg text-[11px] text-textmid hover:bg-white transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => handleMarkPosted(dep.id)}
                disabled={isMarking}
                className="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-teal text-white hover:bg-teal/90 transition-colors disabled:opacity-50"
              >
                {isMarking ? 'Updating...' : 'Confirm Posted'}
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmPosted(dep.id)}
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

    return (
      <div key={flexAd.id} className="border border-navy/15 rounded-2xl bg-white shadow-sm overflow-hidden">
        {/* ── Header: Stacked thumbnails + Name + Date ── */}
        <div className="p-4 pb-3">
          <div className="flex items-start gap-3.5">
            {/* Stacked thumbnails */}
            <div className="flex -space-x-2 flex-shrink-0">
              {childDeps.slice(0, 3).map(d => (
                d.imageUrl ? (
                  <img key={d.id} src={d.imageUrl} alt="" className="w-16 h-16 object-cover rounded-xl bg-offwhite ring-2 ring-white" loading="lazy" />
                ) : (
                  <div key={d.id} className="w-16 h-16 rounded-xl bg-offwhite ring-2 ring-white" />
                )
              ))}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="px-1.5 py-0.5 rounded bg-navy/10 text-navy text-[9px] font-bold uppercase">Flex</span>
                <span className="font-semibold text-[14px] text-textdark leading-tight truncate">{flexAd.name}</span>
              </div>
              <div className="text-[11px] text-textmid mt-1">{childDeps.length} ad{childDeps.length !== 1 ? 's' : ''} in this flex</div>
              {plannedDate && (
                <div className="flex items-center gap-1.5 mt-1">
                  <svg className="w-3.5 h-3.5 text-textlight" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                  <span className="text-[12px] text-textmid font-medium">{plannedDate}</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* ── POST IN ── */}
        <div className="px-4 pb-3">
          <PostInSection campaignName={campaignName} adSetName={adSetName} />
        </div>

        {/* ── Content Sections ── */}
        <div className="px-4 pb-4 space-y-4">
          {/* Primary Texts */}
          {renderNumberedTexts(flexAd.primary_texts, 'Primary Text')}

          {/* Headlines */}
          {renderNumberedTexts(flexAd.headlines, 'Headlines')}

          {/* Destination URL */}
          {flexAd.destination_url && (
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <div className="text-[10px] font-bold text-textmid uppercase tracking-wider">Destination URL</div>
                <CopyBtn text={flexAd.destination_url} label="Copy" />
              </div>
              <a
                href={flexAd.destination_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[12px] text-gold hover:underline break-all leading-relaxed"
              >
                {flexAd.destination_url}
              </a>
            </div>
          )}

          {/* CTA Button */}
          {flexAd.cta_button && (
            <div>
              <div className="text-[10px] font-bold text-textmid uppercase tracking-wider mb-1.5">CTA Button</div>
              <span className="inline-block px-3 py-1 rounded-full bg-navy/10 text-navy text-[12px] font-semibold">
                {flexAd.cta_button.replace(/_/g, ' ')}
              </span>
            </div>
          )}

          {/* Child ads grid */}
          <div>
            <div className="text-[10px] font-bold text-textmid uppercase tracking-wider mb-2">Ad Creatives</div>
            <div className="grid grid-cols-3 gap-2">
              {childDeps.map(d => (
                <div key={d.id} className="text-center">
                  {d.imageUrl ? (
                    <img src={d.imageUrl} alt="" className="w-full aspect-square object-cover rounded-xl bg-offwhite" loading="lazy" />
                  ) : (
                    <div className="w-full aspect-square rounded-xl bg-offwhite" />
                  )}
                  <div className="text-[10px] text-textmid mt-1 truncate">{d.ad_name || d.ad?.headline || ''}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── Actions ── */}
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
              <button
                onClick={() => setConfirmPosted(null)}
                className="px-2.5 py-1.5 rounded-lg text-[11px] text-textmid hover:bg-white transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => handleMarkFlexPosted(flexAd)}
                disabled={isMarking}
                className="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-teal text-white hover:bg-teal/90 transition-colors disabled:opacity-50"
              >
                {isMarking ? 'Updating...' : 'Confirm Posted'}
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmPosted(flexId)}
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

  // Build a flat list of cards: standalone deps + flex ads with ready children
  // Sort by campaign name, then ad set name, then planned date
  const buildCardList = () => {
    const cards = [];

    // Collect standalone ready deps (not part of a flex ad)
    const flexChildIds = new Set();
    flexAds.forEach(fa => {
      try {
        const ids = fa.child_deployment_ids ? JSON.parse(fa.child_deployment_ids) : [];
        ids.forEach(id => flexChildIds.add(id));
      } catch { /* ignore */ }
    });

    readyDeps.forEach(dep => {
      if (flexChildIds.has(dep.id)) return; // skip, handled by flex card
      const { campaignName, adSetName } = resolveLocation(dep);
      cards.push({
        type: 'single',
        dep,
        campaignName: campaignName || '',
        adSetName: adSetName || '',
        plannedDate: dep.planned_date || '',
        key: dep.id,
      });
    });

    // Collect flex ads with ready children
    flexAds.forEach(fa => {
      if (!flexHasReadyChildren(fa)) return;
      const { campaignName, adSetName } = resolveFlexLocation(fa);
      cards.push({
        type: 'flex',
        flexAd: fa,
        campaignName: campaignName || '',
        adSetName: adSetName || '',
        plannedDate: fa.planned_date || '',
        key: `flex-${fa.id}`,
      });
    });

    // Sort: unassigned first (so they get attention), then by campaign > ad set > date
    cards.sort((a, b) => {
      // Unassigned first
      const aUnassigned = !a.campaignName;
      const bUnassigned = !b.campaignName;
      if (aUnassigned !== bUnassigned) return aUnassigned ? -1 : 1;
      // Then by campaign name
      if (a.campaignName !== b.campaignName) return a.campaignName.localeCompare(b.campaignName);
      // Then by ad set name
      if (a.adSetName !== b.adSetName) return a.adSetName.localeCompare(b.adSetName);
      // Then by planned date (soonest first, empty last)
      if (a.plannedDate && b.plannedDate) return a.plannedDate.localeCompare(b.plannedDate);
      if (a.plannedDate) return -1;
      if (b.plannedDate) return 1;
      return 0;
    });

    return cards;
  };

  // ── Render ──────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="text-center py-12 text-textmid text-[13px]">Loading...</div>
    );
  }

  const hasReadyAds = readyDeps.length > 0;

  if (!hasReadyAds) {
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
      {/* Summary bar with bulk action */}
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

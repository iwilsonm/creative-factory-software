import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';

/**
 * ReadyToPostView — Employee-facing view showing only ads with status 'ready_to_post'.
 *
 * Layout: Campaign > Ad Set > Ads hierarchy
 * Features:
 *   - Copy buttons for primary text, headlines, destination URL
 *   - Mark as Posted button (per-ad loading state)
 *   - Bulk Mark All as Posted
 *   - Planned date/time display
 *   - Edit in Planner link
 *
 * Props: projectId, deployments, setDeployments, addToast, loadDeployments, onSwitchToPlanner
 */
export default function ReadyToPostView({ projectId, deployments, setDeployments, addToast, loadDeployments, onSwitchToPlanner }) {
  const [campaigns, setCampaigns] = useState([]);
  const [adSets, setAdSets] = useState([]);
  const [flexAds, setFlexAds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [collapsed, setCollapsed] = useState(new Set());
  const [confirmPosted, setConfirmPosted] = useState(null); // dep id or flex ad id
  const [markingPostedIds, setMarkingPostedIds] = useState(new Set()); // per-ad loading state
  const [expandedCard, setExpandedCard] = useState(null); // dep id for expanded details
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

  // Helper: get deps in an ad set that are ready_to_post
  const getAdSetReadyDeps = (adsetId) =>
    readyDeps.filter(d => d.local_adset_id === adsetId && !d.flex_ad_id);

  // Helper: get flex ads in an ad set that have ready_to_post children
  const getAdSetFlexAds = (adsetId) =>
    flexAds.filter(f => f.ad_set_id === adsetId);

  // Helper: get child deps for a flex ad that are ready_to_post
  const getFlexChildDeps = (flexAd) => {
    let childIds = [];
    try { childIds = flexAd.child_deployment_ids ? JSON.parse(flexAd.child_deployment_ids) : []; } catch { /* ignore */ }
    return readyDeps.filter(d => childIds.includes(d.id));
  };

  // Check if a flex ad has any ready children
  const flexHasReadyChildren = (flexAd) => getFlexChildDeps(flexAd).length > 0;

  const getCampaignAdSets = (campaignId) =>
    adSets.filter(a => a.campaign_id === campaignId).sort((a, b) => a.sort_order - b.sort_order);

  const sortedCampaigns = [...campaigns].sort((a, b) => a.sort_order - b.sort_order);

  // Toggle campaign collapse
  const toggleCollapse = (id) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // Copy to clipboard
  const copyToClipboard = async (text, label) => {
    try {
      await navigator.clipboard.writeText(text);
      addToast(`${label} copied`, 'success');
    } catch {
      addToast('Failed to copy', 'error');
    }
  };

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

  // Format planned date
  const formatDate = (dateStr) => {
    if (!dateStr) return null;
    try {
      const d = new Date(dateStr);
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
        ' at ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    } catch {
      return dateStr;
    }
  };

  // Copy button component
  const CopyBtn = ({ text, label }) => {
    if (!text || text.trim() === '' || text === '[]') return null;
    return (
      <button
        onClick={(e) => { e.stopPropagation(); copyToClipboard(text, label); }}
        className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-navy/5 text-navy text-[10px] font-medium hover:bg-navy/10 transition-colors"
      >
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
        Copy {label}
      </button>
    );
  };

  // Parse JSON array string to readable text
  const parseJsonArray = (jsonStr) => {
    if (!jsonStr) return '';
    try {
      const arr = JSON.parse(jsonStr);
      return arr.filter(Boolean).join('\n\n');
    } catch {
      return jsonStr;
    }
  };

  // Render a single ad card
  const renderAdCard = (dep) => {
    const name = dep.ad_name || dep.ad?.headline || dep.ad?.angle || `Ad ${(dep.id || '').slice(0, 6)}`;
    const thumbUrl = dep.imageUrl;
    const isExpanded = expandedCard === dep.id;
    const primaryTexts = parseJsonArray(dep.primary_texts);
    const headlines = parseJsonArray(dep.ad_headlines);
    const plannedDate = formatDate(dep.planned_date);
    const isMarking = markingPostedIds.has(dep.id);

    return (
      <div key={dep.id} className="border border-black/[0.06] rounded-xl bg-white p-3 space-y-2">
        {/* Header row */}
        <div className="flex items-start gap-3">
          {thumbUrl && (
            <img src={thumbUrl} alt="" className="w-14 h-14 object-cover rounded-lg bg-offwhite flex-shrink-0" loading="lazy" />
          )}
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-[13px] text-textdark truncate">{name}</div>
            {plannedDate && (
              <div className="flex items-center gap-1 mt-0.5">
                <svg className="w-3 h-3 text-textlight" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                <span className="text-[11px] text-textmid">{plannedDate}</span>
              </div>
            )}
          </div>
          <button
            onClick={() => setExpandedCard(isExpanded ? null : dep.id)}
            className="text-textlight hover:text-textmid transition-colors p-1"
          >
            <svg className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        </div>

        {/* Copy buttons row */}
        <div className="flex flex-wrap gap-1.5">
          <CopyBtn text={primaryTexts} label="Primary Text" />
          <CopyBtn text={headlines} label="Headlines" />
          <CopyBtn text={dep.destination_url} label="URL" />
        </div>

        {/* Expanded details */}
        {isExpanded && (
          <div className="space-y-3 pt-2 border-t border-black/[0.04]">
            {primaryTexts && (
              <div>
                <div className="text-[10px] font-semibold text-textmid uppercase tracking-wider mb-1">Primary Text</div>
                <div className="text-[12px] text-textdark whitespace-pre-wrap bg-offwhite rounded-lg p-2.5">{primaryTexts}</div>
              </div>
            )}
            {headlines && (
              <div>
                <div className="text-[10px] font-semibold text-textmid uppercase tracking-wider mb-1">Headlines</div>
                <div className="text-[12px] text-textdark whitespace-pre-wrap bg-offwhite rounded-lg p-2.5">{headlines}</div>
              </div>
            )}
            {dep.destination_url && (
              <div>
                <div className="text-[10px] font-semibold text-textmid uppercase tracking-wider mb-1">Destination URL</div>
                <a href={dep.destination_url} target="_blank" rel="noopener noreferrer" className="text-[12px] text-gold hover:underline break-all">{dep.destination_url}</a>
              </div>
            )}
            {dep.cta_button && (
              <div>
                <div className="text-[10px] font-semibold text-textmid uppercase tracking-wider mb-1">CTA Button</div>
                <span className="text-[12px] text-textdark">{dep.cta_button.replace(/_/g, ' ')}</span>
              </div>
            )}
          </div>
        )}

        {/* Mark as Posted */}
        <div className="flex justify-end">
          {confirmPosted === dep.id ? (
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-textmid">Mark as posted?</span>
              <button
                onClick={() => setConfirmPosted(null)}
                className="px-2 py-1 rounded-md text-[11px] text-textmid hover:bg-offwhite transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => handleMarkPosted(dep.id)}
                disabled={isMarking}
                className="px-2.5 py-1 rounded-md text-[11px] font-medium bg-teal text-white hover:bg-teal/90 transition-colors disabled:opacity-50"
              >
                {isMarking ? 'Updating...' : 'Confirm'}
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmPosted(dep.id)}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium text-teal bg-teal/10 hover:bg-teal/20 transition-colors"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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

    const primaryTexts = parseJsonArray(flexAd.primary_texts);
    const headlines = parseJsonArray(flexAd.headlines);
    const plannedDate = formatDate(flexAd.planned_date);
    const isExpanded = expandedCard === `flex-${flexAd.id}`;
    const flexId = `flex-${flexAd.id}`;
    const isMarking = markingPostedIds.has(flexId);

    return (
      <div key={flexAd.id} className="border border-navy/20 rounded-xl bg-navy/[0.02] p-3 space-y-2">
        {/* Header */}
        <div className="flex items-start gap-3">
          {/* Stacked thumbnails */}
          <div className="flex -space-x-1.5 flex-shrink-0">
            {childDeps.slice(0, 3).map(d => (
              d.imageUrl ? (
                <img key={d.id} src={d.imageUrl} alt="" className="w-11 h-11 object-cover rounded-lg bg-offwhite ring-2 ring-white" loading="lazy" />
              ) : (
                <div key={d.id} className="w-11 h-11 rounded-lg bg-offwhite ring-2 ring-white" />
              )
            ))}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="px-1.5 py-0.5 rounded bg-navy/10 text-navy text-[9px] font-bold uppercase">Flex</span>
              <span className="font-semibold text-[13px] text-textdark truncate">{flexAd.name}</span>
            </div>
            <div className="text-[11px] text-textmid mt-0.5">{childDeps.length} ad{childDeps.length !== 1 ? 's' : ''}</div>
            {plannedDate && (
              <div className="flex items-center gap-1 mt-0.5">
                <svg className="w-3 h-3 text-textlight" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                <span className="text-[11px] text-textmid">{plannedDate}</span>
              </div>
            )}
          </div>
          <button
            onClick={() => setExpandedCard(isExpanded ? null : flexId)}
            className="text-textlight hover:text-textmid transition-colors p-1"
          >
            <svg className={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        </div>

        {/* Copy buttons */}
        <div className="flex flex-wrap gap-1.5">
          <CopyBtn text={primaryTexts} label="Primary Text" />
          <CopyBtn text={headlines} label="Headlines" />
          <CopyBtn text={flexAd.destination_url} label="URL" />
        </div>

        {/* Expanded details */}
        {isExpanded && (
          <div className="space-y-3 pt-2 border-t border-navy/10">
            {primaryTexts && (
              <div>
                <div className="text-[10px] font-semibold text-textmid uppercase tracking-wider mb-1">Primary Text</div>
                <div className="text-[12px] text-textdark whitespace-pre-wrap bg-white rounded-lg p-2.5">{primaryTexts}</div>
              </div>
            )}
            {headlines && (
              <div>
                <div className="text-[10px] font-semibold text-textmid uppercase tracking-wider mb-1">Headlines</div>
                <div className="text-[12px] text-textdark whitespace-pre-wrap bg-white rounded-lg p-2.5">{headlines}</div>
              </div>
            )}
            {flexAd.destination_url && (
              <div>
                <div className="text-[10px] font-semibold text-textmid uppercase tracking-wider mb-1">Destination URL</div>
                <a href={flexAd.destination_url} target="_blank" rel="noopener noreferrer" className="text-[12px] text-gold hover:underline break-all">{flexAd.destination_url}</a>
              </div>
            )}
            {flexAd.cta_button && (
              <div>
                <div className="text-[10px] font-semibold text-textmid uppercase tracking-wider mb-1">CTA Button</div>
                <span className="text-[12px] text-textdark">{flexAd.cta_button.replace(/_/g, ' ')}</span>
              </div>
            )}
            {/* Child ads */}
            <div>
              <div className="text-[10px] font-semibold text-textmid uppercase tracking-wider mb-1.5">Ads in Flex</div>
              <div className="grid grid-cols-3 gap-1.5">
                {childDeps.map(d => (
                  <div key={d.id} className="text-center">
                    {d.imageUrl ? (
                      <img src={d.imageUrl} alt="" className="w-full aspect-square object-cover rounded-lg bg-offwhite" loading="lazy" />
                    ) : (
                      <div className="w-full aspect-square rounded-lg bg-offwhite" />
                    )}
                    <div className="text-[10px] text-textmid mt-0.5 truncate">{d.ad_name || d.ad?.headline || ''}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Mark all as Posted */}
        <div className="flex justify-end">
          {confirmPosted === flexId ? (
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-textmid">Mark {childDeps.length} ad{childDeps.length !== 1 ? 's' : ''} as posted?</span>
              <button
                onClick={() => setConfirmPosted(null)}
                className="px-2 py-1 rounded-md text-[11px] text-textmid hover:bg-offwhite transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => handleMarkFlexPosted(flexAd)}
                disabled={isMarking}
                className="px-2.5 py-1 rounded-md text-[11px] font-medium bg-teal text-white hover:bg-teal/90 transition-colors disabled:opacity-50"
              >
                {isMarking ? 'Updating...' : 'Confirm'}
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmPosted(flexId)}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium text-teal bg-teal/10 hover:bg-teal/20 transition-colors"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              Mark as Posted
            </button>
          )}
        </div>
      </div>
    );
  };

  if (loading) {
    return (
      <div className="text-center py-12 text-textmid text-[13px]">Loading...</div>
    );
  }

  // Check if there are any ready_to_post ads across all campaigns
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
        <p className="text-[12px] text-textmid mt-1">When ads are set to "Ready to Post" in the Planner, they'll appear here.</p>
      </div>
    );
  }

  // Unplanned ready_to_post ads (show at top since they need attention)
  const unplannedReady = readyDeps.filter(d => d.local_campaign_id === 'unplanned' || !d.local_campaign_id);

  return (
    <div className="space-y-4">
      {/* Summary bar with bulk actions */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-[12px] text-textmid">
          <span className="font-medium text-textdark">{readyDeps.length} ad{readyDeps.length !== 1 ? 's' : ''}</span>
          ready to post
        </div>
        <div className="flex items-center gap-2">
          {onSwitchToPlanner && (
            <button
              onClick={onSwitchToPlanner}
              className="inline-flex items-center gap-1 text-[11px] text-gold hover:text-gold/80 font-medium transition-colors"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
              Edit in Planner
            </button>
          )}
          <button
            onClick={handleBulkMarkAllPosted}
            disabled={bulkMarkingAll}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-[11px] font-medium bg-teal text-white hover:bg-teal/90 transition-colors disabled:opacity-50"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            {bulkMarkingAll ? 'Marking...' : `Mark All as Posted (${readyDeps.length})`}
          </button>
        </div>
      </div>

      {/* Unassigned ready_to_post ads — shown first since they need attention */}
      {unplannedReady.length > 0 && (
        <div className="border border-gold/30 rounded-2xl bg-white overflow-hidden">
          <div className="px-4 py-3 bg-gold/5">
            <span className="font-semibold text-[13px] text-textdark">Unassigned</span>
            <span className="ml-2 px-1.5 py-0.5 rounded-full bg-navy/10 text-navy text-[10px] font-medium">{unplannedReady.length}</span>
            <span className="ml-2 text-[10px] text-textmid">These ads haven't been assigned to a campaign yet</span>
          </div>
          <div className="p-3 space-y-2">
            {unplannedReady.map(dep => renderAdCard(dep))}
          </div>
        </div>
      )}

      {/* Campaigns */}
      {sortedCampaigns.map(campaign => {
        const campAdSets = getCampaignAdSets(campaign.id);
        // Check if any ad set in this campaign has ready_to_post ads
        const campHasReady = campAdSets.some(as => {
          const deps = getAdSetReadyDeps(as.id);
          const flexes = getAdSetFlexAds(as.id).filter(f => flexHasReadyChildren(f));
          return deps.length > 0 || flexes.length > 0;
        });
        if (!campHasReady) return null;

        const isCampaignCollapsed = collapsed.has(campaign.id);

        return (
          <div key={campaign.id} className="border border-black/[0.06] rounded-2xl bg-white overflow-hidden">
            {/* Campaign header */}
            <button
              onClick={() => toggleCollapse(campaign.id)}
              className="w-full flex items-center gap-2.5 px-4 py-3 bg-offwhite hover:bg-black/[0.04] transition-colors text-left"
            >
              <svg className={`w-4 h-4 text-textmid transition-transform ${isCampaignCollapsed ? '' : 'rotate-90'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              <span className="font-semibold text-[13px] text-textdark">{campaign.name}</span>
              <span className="text-[11px] text-textmid">Campaign</span>
            </button>

            {!isCampaignCollapsed && (
              <div className="p-3 space-y-3">
                {campAdSets.map(adSet => {
                  const readyStandalone = getAdSetReadyDeps(adSet.id);
                  const readyFlexes = getAdSetFlexAds(adSet.id).filter(f => flexHasReadyChildren(f));
                  if (readyStandalone.length === 0 && readyFlexes.length === 0) return null;

                  const isAdSetCollapsed = collapsed.has(adSet.id);
                  const totalReady = readyStandalone.length + readyFlexes.length;

                  return (
                    <div key={adSet.id} className="border border-black/[0.04] rounded-xl bg-offwhite/50">
                      {/* Ad Set header */}
                      <button
                        onClick={() => toggleCollapse(adSet.id)}
                        className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-black/[0.02] transition-colors text-left rounded-xl"
                      >
                        <svg className={`w-3.5 h-3.5 text-textmid transition-transform ${isAdSetCollapsed ? '' : 'rotate-90'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                        </svg>
                        <span className="font-medium text-[12px] text-textdark">{adSet.name}</span>
                        <span className="px-1.5 py-0.5 rounded-full bg-navy/10 text-navy text-[10px] font-medium">{totalReady}</span>
                        <span className="text-[10px] text-textmid">Ad Set</span>
                      </button>

                      {!isAdSetCollapsed && (
                        <div className="px-3 pb-3 space-y-2">
                          {/* Standalone ready ads */}
                          {readyStandalone.map(dep => renderAdCard(dep))}
                          {/* Flex ads with ready children */}
                          {readyFlexes.map(fa => renderFlexCard(fa))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

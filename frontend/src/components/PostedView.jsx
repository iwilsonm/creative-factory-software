import { useState, useEffect } from 'react';
import { api } from '../api';

/**
 * PostedView — Shows posted ads grouped by flex ad, mirroring the Ready to Post card layout.
 *
 * Props: projectId, deployments, setDeployments, addToast, loadDeployments, isPoster
 */
export default function PostedView({ projectId, deployments, setDeployments, addToast, loadDeployments, isPoster }) {
  const [campaigns, setCampaigns] = useState([]);
  const [adSets, setAdSets] = useState([]);
  const [flexAds, setFlexAds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [sendingBackIds, setSendingBackIds] = useState(new Set());
  const [expandedCards, setExpandedCards] = useState(new Set());

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
    try {
      const [campData, flexData] = await Promise.all([
        api.getCampaigns(projectId),
        api.getFlexAds(projectId),
      ]);
      setCampaigns(campData.campaigns || []);
      setAdSets(campData.adSets || []);
      setFlexAds(flexData.flexAds || []);
    } catch (err) {
      console.error('PostedView loadData error:', err);
    }
    setLoading(false);
  };

  const postedDeps = deployments.filter(d => d.status === 'posted');

  // ── Helpers ──────────────────────────────────────────────────────────────

  const resolveLocation = (dep) => {
    // First check carried-over campaign_name / ad_set_name (set when marking posted)
    if (dep.campaign_name || dep.ad_set_name) {
      return { campaignName: dep.campaign_name || null, adSetName: dep.ad_set_name || null };
    }
    const adSet = adSets.find(a => a.id === dep.local_adset_id);
    if (!adSet) return { campaignName: null, adSetName: null };
    const campaign = campaigns.find(c => adSets.filter(a => a.campaign_id === c.id).some(a => a.id === dep.local_adset_id));
    return { campaignName: campaign?.name || null, adSetName: adSet?.name || null };
  };

  const resolveFlexLocation = (flexAd) => {
    // Check if child deps have carried-over names
    const childDeps = getFlexChildDeps(flexAd);
    if (childDeps.length > 0 && (childDeps[0].campaign_name || childDeps[0].ad_set_name)) {
      return { campaignName: childDeps[0].campaign_name || null, adSetName: childDeps[0].ad_set_name || null };
    }
    const adSet = adSets.find(a => a.id === flexAd.ad_set_id);
    if (!adSet) return { campaignName: null, adSetName: null };
    const campaign = campaigns.find(c => adSets.filter(a => a.campaign_id === c.id).some(a => a.id === flexAd.ad_set_id));
    return { campaignName: campaign?.name || null, adSetName: adSet?.name || null };
  };

  const getFlexChildDeps = (flexAd) => {
    let childIds = [];
    try { childIds = flexAd.child_deployment_ids ? JSON.parse(flexAd.child_deployment_ids) : []; } catch { /* ignore */ }
    return postedDeps.filter(d => childIds.includes(d.id));
  };

  const flexHasPostedChildren = (flexAd) => getFlexChildDeps(flexAd).length > 0;

  const formatDate = (dateStr) => {
    if (!dateStr) return null;
    try {
      const d = new Date(dateStr);
      return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) +
        ' at ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    } catch { return dateStr; }
  };

  // ── Actions ──────────────────────────────────────────────────────────────

  const handleSendBack = async (depId) => {
    setSendingBackIds(prev => new Set(prev).add(depId));
    try {
      await api.updateDeploymentStatus(depId, 'ready_to_post');
      setDeployments(prev => prev.map(d => d.id === depId ? { ...d, status: 'ready_to_post' } : d));
      addToast('Sent back to Ready to Post', 'success');
    } catch { addToast('Failed to send back', 'error'); }
    setSendingBackIds(prev => { const next = new Set(prev); next.delete(depId); return next; });
  };

  const handleSendBackFlex = async (flexAd) => {
    const flexId = `flex-${flexAd.id}`;
    setSendingBackIds(prev => new Set(prev).add(flexId));
    try {
      const childDeps = getFlexChildDeps(flexAd);
      await Promise.all(childDeps.map(d => api.updateDeploymentStatus(d.id, 'ready_to_post')));
      let childIds = [];
      try { childIds = flexAd.child_deployment_ids ? JSON.parse(flexAd.child_deployment_ids) : []; } catch { /* ignore */ }
      setDeployments(prev => prev.map(d => {
        if (childIds.includes(d.id)) return { ...d, status: 'ready_to_post' };
        return d;
      }));
      addToast(`${childDeps.length} ads sent back to Ready to Post`, 'success');
    } catch { addToast('Failed to send back', 'error'); }
    setSendingBackIds(prev => { const next = new Set(prev); next.delete(flexId); return next; });
  };

  // ── Card Renderers ──────────────────────────────────────────────────────

  const renderAdCard = (dep) => {
    const name = dep.ad_name || dep.ad?.headline || dep.ad?.angle || `Ad ${(dep.id || '').slice(0, 6)}`;
    const thumbUrl = dep.imageUrl;
    const postedDate = formatDate(dep.posted_date);
    const isSendingBack = sendingBackIds.has(dep.id);
    const { campaignName, adSetName } = resolveLocation(dep);
    const isExpanded = expandedCards.has(dep.id);

    return (
      <div key={dep.id} className="border border-black/[0.08] rounded-2xl bg-white shadow-sm overflow-hidden">
        <div className="px-5 py-4 space-y-2.5">
          {/* Ad Name + thumbnail */}
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-[13px] leading-tight mb-1">
                <span className="font-bold text-textdark">{name}</span>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="inline-block px-2 py-0.5 rounded bg-teal/10 text-teal text-[9px] font-bold uppercase tracking-wider">Posted</span>
                <span className="inline-block px-2 py-0.5 rounded bg-purple-100 text-purple-700 text-[9px] font-bold uppercase tracking-wider">Single Image</span>
                {postedDate && (
                  <span className="text-[10px] text-textmid">{postedDate}</span>
                )}
              </div>
            </div>
            {thumbUrl && (
              <img src={thumbUrl} alt="" className="w-12 h-12 object-cover rounded-xl bg-gray-100 flex-shrink-0" loading="lazy" />
            )}
          </div>

          {/* Campaign + Ad Set */}
          {(campaignName || adSetName) && (
            <div className="flex items-center gap-2 text-[11px]">
              {campaignName && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-navy/5 text-navy font-medium">
                  {campaignName}
                </span>
              )}
              {adSetName && (
                <>
                  <span className="text-textlight">›</span>
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-navy/5 text-navy font-medium">
                    {adSetName}
                  </span>
                </>
              )}
            </div>
          )}

          {/* Posted by */}
          {dep.posted_by && (
            <div className="text-[11px] text-textmid">Posted by: <span className="font-medium text-textdark">{dep.posted_by}</span></div>
          )}

          {/* Expand toggle */}
          {(dep.destination_url || dep.display_link || dep.cta_button || dep.facebook_page) && (
            <button
              onClick={() => toggleCardExpanded(dep.id)}
              className="w-full flex items-center justify-center gap-2 py-1.5 rounded-xl bg-offwhite hover:bg-navy/5 transition-colors text-[11px] font-medium text-navy"
            >
              <svg className={`w-3.5 h-3.5 transition-transform ${isExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
              {isExpanded ? 'Hide Details' : 'Show Details'}
            </button>
          )}
        </div>

        {/* Expanded details */}
        {isExpanded && (
          <div className="px-5 pb-4 space-y-2.5 border-t border-black/[0.04] pt-3 text-[12px]">
            {dep.destination_url && (
              <div><span className="text-textmid">URL:</span> <a href={dep.destination_url} target="_blank" rel="noopener noreferrer" className="text-gold hover:underline break-all">{dep.destination_url}</a></div>
            )}
            {dep.display_link && (
              <div><span className="text-textmid">Display Link:</span> <span className="text-textdark">{dep.display_link}</span></div>
            )}
            {dep.cta_button && (
              <div><span className="text-textmid">CTA:</span> <span className="font-medium text-teal">{dep.cta_button.replace(/_/g, ' ')}</span></div>
            )}
            {dep.facebook_page && (
              <div><span className="text-textmid">Facebook Page:</span> <span className="font-medium text-textdark">{dep.facebook_page}</span></div>
            )}
          </div>
        )}

        {/* Actions */}
        {!isPoster && (
          <div className="px-5 py-2.5 border-t border-black/[0.06] bg-offwhite/50 flex items-center justify-end">
            <button onClick={() => handleSendBack(dep.id)} disabled={isSendingBack}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium text-gold border border-gold/30 hover:bg-gold/10 transition-colors disabled:opacity-50"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
              </svg>
              {isSendingBack ? 'Sending...' : '← Ready to Post'}
            </button>
          </div>
        )}
      </div>
    );
  };

  const renderFlexCard = (flexAd) => {
    const childDeps = getFlexChildDeps(flexAd);
    if (childDeps.length === 0) return null;

    const postedDate = formatDate(childDeps[0]?.posted_date || flexAd.planned_date);
    const flexId = `flex-${flexAd.id}`;
    const isSendingBack = sendingBackIds.has(flexId);
    const { campaignName, adSetName } = resolveFlexLocation(flexAd);
    const depsWithImages = childDeps.filter(d => d.imageUrl);
    const isExpanded = expandedCards.has(flexId);

    return (
      <div key={flexAd.id} className="border border-black/[0.08] rounded-2xl bg-white shadow-sm overflow-hidden">
        <div className="px-5 py-4 space-y-2.5">
          {/* Ad Name + thumbnails */}
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="text-[13px] leading-tight mb-1">
                <span className="font-bold text-textdark">{flexAd.name || 'Flex Ad'}</span>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="inline-block px-2 py-0.5 rounded bg-teal/10 text-teal text-[9px] font-bold uppercase tracking-wider">Posted</span>
                <span className="inline-block px-2 py-0.5 rounded bg-purple-100 text-purple-700 text-[9px] font-bold uppercase tracking-wider">Flexible · {depsWithImages.length} images</span>
                {postedDate && (
                  <span className="text-[10px] text-textmid">{postedDate}</span>
                )}
              </div>
            </div>
            <div className="flex gap-1 flex-shrink-0">
              {childDeps.slice(0, 4).map(d => d.imageUrl ? (
                <img key={d.id} src={d.imageUrl} alt="" className="w-10 h-10 object-cover rounded-lg bg-gray-100" loading="lazy" />
              ) : (
                <div key={d.id} className="w-10 h-10 rounded-lg bg-gray-200" />
              ))}
              {childDeps.length > 4 && (
                <div className="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center text-[10px] text-textlight font-medium">+{childDeps.length - 4}</div>
              )}
            </div>
          </div>

          {/* Campaign + Ad Set */}
          {(campaignName || adSetName) && (
            <div className="flex items-center gap-2 text-[11px]">
              {campaignName && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-navy/5 text-navy font-medium">
                  {campaignName}
                </span>
              )}
              {adSetName && (
                <>
                  <span className="text-textlight">›</span>
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-navy/5 text-navy font-medium">
                    {adSetName}
                  </span>
                </>
              )}
            </div>
          )}

          {/* Posted by */}
          {(flexAd.posted_by || childDeps[0]?.posted_by) && (
            <div className="text-[11px] text-textmid">Posted by: <span className="font-medium text-textdark">{flexAd.posted_by || childDeps[0]?.posted_by}</span></div>
          )}

          {/* Expand toggle */}
          <button
            onClick={() => toggleCardExpanded(flexId)}
            className="w-full flex items-center justify-center gap-2 py-1.5 rounded-xl bg-offwhite hover:bg-navy/5 transition-colors text-[11px] font-medium text-navy"
          >
            <svg className={`w-3.5 h-3.5 transition-transform ${isExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
            {isExpanded ? 'Hide Details' : `Show Details (${depsWithImages.length} images)`}
          </button>
        </div>

        {/* Expanded details */}
        {isExpanded && (
          <div className="px-5 pb-4 space-y-3 border-t border-black/[0.04] pt-3">
            {/* Image grid */}
            {depsWithImages.length > 0 && (
              <div>
                <span className="text-[10px] font-bold text-textmid uppercase tracking-wider mb-2 block">Ad Creatives</span>
                <div className="grid grid-cols-5 gap-2">
                  {childDeps.map(d => (
                    <div key={d.id}>
                      {d.imageUrl ? (
                        <img src={d.imageUrl} alt="" className="w-full aspect-square object-cover rounded-xl bg-offwhite" loading="lazy" />
                      ) : (
                        <div className="w-full aspect-square rounded-xl bg-offwhite" />
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Metadata */}
            <div className="text-[12px] space-y-2">
              {flexAd.destination_url && (
                <div><span className="text-textmid">URL:</span> <a href={flexAd.destination_url} target="_blank" rel="noopener noreferrer" className="text-gold hover:underline break-all">{flexAd.destination_url}</a></div>
              )}
              {flexAd.display_link && (
                <div><span className="text-textmid">Display Link:</span> <span className="text-textdark">{flexAd.display_link}</span></div>
              )}
              {flexAd.cta_button && (
                <div><span className="text-textmid">CTA:</span> <span className="font-medium text-teal">{flexAd.cta_button.replace(/_/g, ' ')}</span></div>
              )}
              {flexAd.facebook_page && (
                <div><span className="text-textmid">Facebook Page:</span> <span className="font-medium text-textdark">{flexAd.facebook_page}</span></div>
              )}
            </div>
          </div>
        )}

        {/* Actions */}
        {!isPoster && (
          <div className="px-5 py-2.5 border-t border-black/[0.06] bg-offwhite/50 flex items-center justify-end">
            <button onClick={() => handleSendBackFlex(flexAd)} disabled={isSendingBack}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium text-gold border border-gold/30 hover:bg-gold/10 transition-colors disabled:opacity-50"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
              </svg>
              {isSendingBack ? 'Sending...' : `← Ready to Post (${childDeps.length} ads)`}
            </button>
          </div>
        )}
      </div>
    );
  };

  // ── Build card list ──────────────────────────────────────────────────────

  const buildCardList = () => {
    const cards = [];
    const flexChildIds = new Set();
    flexAds.forEach(fa => {
      try { (fa.child_deployment_ids ? JSON.parse(fa.child_deployment_ids) : []).forEach(id => flexChildIds.add(id)); } catch { /* ignore */ }
    });
    // Standalone posted deps (not part of any flex ad)
    postedDeps.forEach(dep => {
      if (flexChildIds.has(dep.id)) return;
      cards.push({ type: 'single', dep, postedDate: dep.posted_date || '', key: dep.id });
    });
    // Flex ads with posted children
    flexAds.forEach(fa => {
      if (!flexHasPostedChildren(fa)) return;
      const childDeps = getFlexChildDeps(fa);
      cards.push({ type: 'flex', flexAd: fa, postedDate: childDeps[0]?.posted_date || fa.planned_date || '', key: `flex-${fa.id}` });
    });
    // Sort: most recently posted first
    cards.sort((a, b) => {
      if (a.postedDate && b.postedDate) return b.postedDate.localeCompare(a.postedDate);
      if (a.postedDate) return -1;
      if (b.postedDate) return 1;
      return 0;
    });
    return cards;
  };

  // ── Render ──────────────────────────────────────────────────────────────

  if (loading) return <div className="text-center py-12 text-textmid text-[13px]">Loading...</div>;

  if (postedDeps.length === 0) {
    return (
      <div className="text-center py-16">
        <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-teal/5 flex items-center justify-center">
          <svg className="w-6 h-6 text-textlight" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <p className="text-[14px] font-medium text-textdark">No posted ads yet</p>
        <p className="text-[12px] text-textmid mt-1">When ads are marked as posted from the Ready to Post view, they'll appear here.</p>
      </div>
    );
  }

  const cardList = buildCardList();

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div>
        <div className="text-[14px]">
          <span className="font-bold text-textdark">{cardList.length}</span>
          <span className="text-textmid ml-1.5">posted ad{cardList.length !== 1 ? 's' : ''}</span>
        </div>
      </div>

      {/* Cards */}
      <div className="space-y-4">
        {cardList.map(card => card.type === 'single' ? renderAdCard(card.dep) : renderFlexCard(card.flexAd))}
      </div>
    </div>
  );
}

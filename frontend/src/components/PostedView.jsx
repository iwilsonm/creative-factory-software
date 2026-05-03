import { useState, useEffect } from 'react';
import { api } from '../api';
// Phase 3 / 6.10 — surface observation state on each posted card.
import ObservationPill from './observation/ObservationPill';
import AdSetTimeline from './observation/AdSetTimeline';

/**
 * PostedView — Phase 6.20b native rendering. Iterates ad_sets directly
 * (no flex_ad adapter shape). Member deployments resolved via
 * `deployments.filter(d => d.local_adset_id === adSet.externalId)`.
 *
 * Lifecycle filter: shows ad_sets in observing / passed / failed /
 * failed_external / insufficient_data. Standalone posted deployments
 * (no parent ad_set) still render as single-ad cards for back-compat.
 *
 * Props: projectId, deployments, setDeployments, addToast, loadDeployments, isPoster
 */
export default function PostedView({ projectId, deployments, setDeployments, addToast, loadDeployments, isPoster }) {
  const [campaigns, setCampaigns] = useState([]);
  const [adSets, setAdSets] = useState([]);             // Local CF ad_sets (campaign metadata)
  const [postedAdSets, setPostedAdSets] = useState([]); // Phase 6.20b — native ad_sets in posted/observed/terminal lifecycle
  const [loading, setLoading] = useState(true);
  const [sendingBackIds, setSendingBackIds] = useState(new Set());
  const [expandedCards, setExpandedCards] = useState(new Set());
  // Phase 6.10 — Phase 3 observation enrichment + AdSetTimeline drawer
  const [observationAdSets, setObservationAdSets] = useState([]);
  const [activeAdSetId, setActiveAdSetId] = useState(null);

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
      const [campData, postedSets, obsData] = await Promise.all([
        api.getCampaigns(projectId),
        // Phase 6.20b — native ad_sets directly. Lifecycle filter limits to
        // states a "posted" view should display.
        api.getAdSets(projectId, ['observing', 'passed', 'failed', 'failed_external', 'insufficient_data']),
        // Phase 6.10 — batched enrichment for ObservationPill (days_observed,
        // is_paused, latest_result, window_total). Returns ad_sets with
        // computed observation metadata.
        api.getObservationAdSets(projectId).then((r) => r?.ad_sets || []).catch(() => []),
      ]);
      setCampaigns(campData.campaigns || []);
      setAdSets(campData.adSets || []);
      setPostedAdSets(Array.isArray(postedSets) ? postedSets : []);
      setObservationAdSets(obsData);
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

  // Phase 6.20b — native ad_set version of resolveFlexLocation. Looks up
  // the campaign for an ad_set via campaign_id; falls back to child deployments'
  // carried-over names for ad_sets whose campaign relationship was inherited
  // before Phase 6.
  const resolveAdSetLocation = (adSet) => {
    const children = getAdSetChildDeps(adSet);
    if (children.length > 0 && (children[0].campaign_name || children[0].ad_set_name)) {
      return {
        campaignName: children[0].campaign_name || null,
        adSetName: children[0].ad_set_name || adSet.name || null,
      };
    }
    const campaign = campaigns.find(c => c.id === adSet.campaign_id);
    return {
      campaignName: campaign?.name || null,
      adSetName: adSet.name || null,
    };
  };

  // Phase 6.20b — native: filter posted deployments by local_adset_id match
  // (no JSON.parse of flex.child_deployment_ids).
  const getAdSetChildDeps = (adSet) => {
    return postedDeps.filter(d => d.local_adset_id === adSet.externalId);
  };

  const adSetHasPostedChildren = (adSet) => getAdSetChildDeps(adSet).length > 0;

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

  // Phase 6.20b — native send-back. Updates ad_set lifecycle to 'ready' AND
  // updates member deployments to 'ready_to_post' for legacy field parity.
  const handleSendBackAdSet = async (adSet) => {
    const sendId = `adset-${adSet.externalId}`;
    setSendingBackIds(prev => new Set(prev).add(sendId));
    try {
      const childDeps = getAdSetChildDeps(adSet);
      // Note: only allow demote from 'observing' or 'posted' (not terminal verdicts)
      // — UI button is hidden on terminal verdicts via lifecycle check.
      await Promise.all([
        api.updateAdSetUnified(projectId, adSet.externalId, { lifecycle_status: 'ready' }).catch(() => {}),
        ...childDeps.map(d => api.updateDeploymentStatus(d.id, 'ready_to_post')),
      ]);
      setDeployments(prev => prev.map(d => {
        if (childDeps.some(cd => cd.id === d.id)) return { ...d, status: 'ready_to_post' };
        return d;
      }));
      addToast(`${childDeps.length} ads sent back to Ready to Post`, 'success');
      // Refresh enriched data so observation pill updates
      loadData();
    } catch { addToast('Failed to send back', 'error'); }
    setSendingBackIds(prev => { const next = new Set(prev); next.delete(sendId); return next; });
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
      <div key={dep.id} className="border border-ed-line rounded-xl bg-ed-surface overflow-hidden">
        <div className="px-5 py-4 space-y-2.5">
          {/* Ad Name + thumbnail */}
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="font-serif text-[18px] text-ed-ink tracking-[-0.01em] leading-tight mb-1">
                <span>{name}</span>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="inline-block px-2 py-0.5 rounded bg-ed-green/10 text-ed-green text-[9px] font-bold uppercase tracking-wider">Posted</span>
                <span className="inline-block px-2 py-0.5 rounded bg-ed-accent/10 text-ed-accent text-[9px] font-bold uppercase tracking-wider">Single Image</span>
                {postedDate && (
                  <span className="font-mono-ed text-[10px] text-ed-ink3">{postedDate}</span>
                )}
              </div>
            </div>
            {thumbUrl && (
              <img src={thumbUrl} alt="" className="w-12 h-12 object-cover rounded-xl bg-ed-bg flex-shrink-0" loading="lazy" />
            )}
          </div>

          {/* Campaign + Ad Set */}
          {(campaignName || adSetName) && (
            <div className="flex items-center gap-2 text-[11px]">
              {campaignName && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-ed-accent/5 text-ed-accent font-medium">
                  {campaignName}
                </span>
              )}
              {adSetName && (
                <>
                  <span className="text-ed-ink3">›</span>
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-ed-accent/5 text-ed-accent font-medium">
                    {adSetName}
                  </span>
                </>
              )}
            </div>
          )}

          {/* Posted by */}
          {dep.posted_by && (
            <div className="text-[11px] text-ed-ink2">Posted by: <span className="font-medium text-ed-ink">{dep.posted_by}</span></div>
          )}

          {/* Expand toggle */}
          {(dep.destination_url || dep.display_link || dep.cta_button || dep.facebook_page) && (
            <button
              onClick={() => toggleCardExpanded(dep.id)}
              className="flex items-center justify-center w-full gap-1 text-[12px] font-medium text-ed-accent hover:text-ed-accent/80 bg-ed-accent/5 hover:bg-ed-accent/10 py-1.5 rounded-md cursor-pointer transition-colors mt-2"
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
          <div className="px-5 pb-4 space-y-2.5 border-t border-ed-line pt-3 text-[12px]">
            {dep.destination_url && (
              <div><span className="text-ed-ink2">URL:</span> <a href={dep.destination_url} target="_blank" rel="noopener noreferrer" className="text-ed-accent hover:underline break-all">{dep.destination_url}</a></div>
            )}
            {dep.display_link && (
              <div><span className="text-ed-ink2">Display Link:</span> <span className="text-ed-ink">{dep.display_link}</span></div>
            )}
            {dep.cta_button && (
              <div><span className="text-ed-ink2">CTA:</span> <span className="font-medium text-ed-green">{dep.cta_button.replace(/_/g, ' ')}</span></div>
            )}
            {dep.facebook_page && (
              <div><span className="text-ed-ink2">Facebook Page:</span> <span className="font-medium text-ed-ink">{dep.facebook_page}</span></div>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="px-5 py-2.5 border-t border-ed-line bg-ed-bg flex items-center justify-end">
          <button onClick={() => handleSendBack(dep.id)} disabled={isSendingBack}
            className="ed-ghost text-ed-gold border-ed-gold/30 hover:bg-ed-gold/10 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium transition-colors disabled:opacity-50"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
            </svg>
            {isSendingBack ? 'Sending...' : '← Ready to Post'}
          </button>
        </div>
      </div>
    );
  };

  // Phase 6.20b — native ad_set card renderer. Reads adSet.externalId,
  // adSet.name, adSet.lifecycle_status; member deployments via filter.
  const renderAdSetCard = (adSet) => {
    const childDeps = getAdSetChildDeps(adSet);
    if (childDeps.length === 0) return null;

    const sample = childDeps[0] || {};
    const postedDate = formatDate(sample.posted_date || adSet.posted_at);
    const sendId = `adset-${adSet.externalId}`;
    const isSendingBack = sendingBackIds.has(sendId);
    const { campaignName, adSetName } = resolveAdSetLocation(adSet);
    const depsWithImages = childDeps.filter(d => d.imageUrl);
    const isExpanded = expandedCards.has(sendId);
    // Demote allowed only from 'observing' (not terminal verdicts). UI hides
    // the send-back button on terminal verdicts.
    const canDemote = adSet.lifecycle_status === 'observing' || adSet.lifecycle_status === 'posted';

    return (
      <div key={adSet.externalId} className="border border-ed-line rounded-xl bg-ed-surface overflow-hidden">
        <div className="px-5 py-4 space-y-2.5">
          {/* Ad Set Name + thumbnails */}
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="font-serif text-[18px] text-ed-ink tracking-[-0.01em] leading-tight mb-1">
                <span>{adSet.name || 'Ad Set'}</span>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {/* Phase 6.10 — observation state pill (Day N/12, Passed, Failed, etc.).
                    Click opens AdSetTimeline drawer with full observation history. */}
                {(() => {
                  const enriched = observationAdSets.find((s) => s.externalId === adSet.externalId);
                  if (enriched) {
                    return (
                      <ObservationPill
                        adSet={enriched}
                        onClick={() => setActiveAdSetId(adSet.externalId)}
                      />
                    );
                  }
                  return (
                    <span className="inline-block px-2 py-0.5 rounded bg-ed-green/10 text-ed-green text-[9px] font-bold uppercase tracking-wider">Posted</span>
                  );
                })()}
                <span className="inline-block px-2 py-0.5 rounded bg-ed-accent/10 text-ed-accent text-[9px] font-bold uppercase tracking-wider">{depsWithImages.length} ads</span>
                {/* Manual / Meta provenance chip — derives from meta_adset_id presence on the native ad_set */}
                {adSet.meta_adset_id
                  ? <span className="inline-block px-2 py-0.5 rounded bg-ed-accent/10 text-ed-accent text-[9px] font-bold uppercase tracking-wider">Meta</span>
                  : <span className="inline-block px-2 py-0.5 rounded bg-ed-bg text-ed-ink2 text-[9px] font-bold uppercase tracking-wider">Manual</span>}
                {postedDate && (
                  <span className="font-mono-ed text-[10px] text-ed-ink3">{postedDate}</span>
                )}
              </div>
            </div>
            <div className="flex gap-1 flex-shrink-0">
              {childDeps.slice(0, 4).map(d => d.imageUrl ? (
                <img key={d.id} src={d.imageUrl} alt="" className="w-10 h-10 object-cover rounded-lg bg-ed-bg" loading="lazy" />
              ) : (
                <div key={d.id} className="w-10 h-10 rounded-lg bg-ed-line" />
              ))}
              {childDeps.length > 4 && (
                <div className="w-10 h-10 rounded-lg bg-ed-bg flex items-center justify-center text-[10px] text-ed-ink3 font-medium">+{childDeps.length - 4}</div>
              )}
            </div>
          </div>

          {/* Campaign + Ad Set */}
          {(campaignName || adSetName) && (
            <div className="flex items-center gap-2 text-[11px]">
              {campaignName && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-ed-accent/5 text-ed-accent font-medium">
                  {campaignName}
                </span>
              )}
              {adSetName && (
                <>
                  <span className="text-ed-ink3">›</span>
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-ed-accent/5 text-ed-accent font-medium">
                    {adSetName}
                  </span>
                </>
              )}
            </div>
          )}

          {/* Posted by */}
          {sample.posted_by && (
            <div className="text-[11px] text-ed-ink2">Posted by: <span className="font-medium text-ed-ink">{sample.posted_by}</span></div>
          )}

          {/* Expand toggle */}
          <button
            onClick={() => toggleCardExpanded(sendId)}
            className="flex items-center justify-center w-full gap-1 text-[12px] font-medium text-ed-accent hover:text-ed-accent/80 bg-ed-accent/5 hover:bg-ed-accent/10 py-1.5 rounded-md cursor-pointer transition-colors mt-2"
          >
            <svg className={`w-3.5 h-3.5 transition-transform ${isExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
            {isExpanded ? 'Hide Details' : `Show Details (${depsWithImages.length} images)`}
          </button>
        </div>

        {/* Expanded details */}
        {isExpanded && (
          <div className="px-5 pb-4 space-y-3 border-t border-ed-line pt-3">
            {/* Image grid */}
            {depsWithImages.length > 0 && (
              <div>
                <span className="text-[10px] uppercase tracking-[0.1em] text-ed-ink3 mb-2 block">Ad Creatives</span>
                <div className="grid grid-cols-6 gap-3">
                  {childDeps.map(d => (
                    <div key={d.id}>
                      {d.imageUrl ? (
                        <img src={d.imageUrl} alt="" className="w-full aspect-square object-cover rounded-lg bg-ed-bg" loading="lazy" />
                      ) : (
                        <div className="w-full aspect-square rounded-lg bg-ed-bg" />
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Metadata — Phase 6.20b: read from sample (first deployment).
                Behavior preserved from the adapter era; copy lives on
                deployments in unified model. */}
            <div className="text-[12px] space-y-2">
              {sample.destination_url && (
                <div><span className="text-ed-ink2">URL:</span> <a href={sample.destination_url} target="_blank" rel="noopener noreferrer" className="text-ed-accent hover:underline break-all">{sample.destination_url}</a></div>
              )}
              {sample.display_link && (
                <div><span className="text-ed-ink2">Display Link:</span> <span className="text-ed-ink">{sample.display_link}</span></div>
              )}
              {sample.cta_button && (
                <div><span className="text-ed-ink2">CTA:</span> <span className="font-medium text-ed-green">{sample.cta_button.replace(/_/g, ' ')}</span></div>
              )}
              {sample.facebook_page && (
                <div><span className="text-ed-ink2">Facebook Page:</span> <span className="font-medium text-ed-ink">{sample.facebook_page}</span></div>
              )}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="px-5 py-2.5 border-t border-ed-line bg-ed-bg flex items-center justify-end">
          {canDemote ? (
            <button onClick={() => handleSendBackAdSet(adSet)} disabled={isSendingBack}
              className="ed-ghost text-ed-gold border-ed-gold/30 hover:bg-ed-gold/10 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium transition-colors disabled:opacity-50"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
              </svg>
              {isSendingBack ? 'Sending...' : `← Ready to Post (${childDeps.length} ads)`}
            </button>
          ) : (
            <span className="text-[10px] text-ed-ink3 italic">Terminal verdict — cannot demote.</span>
          )}
        </div>
      </div>
    );
  };

  // ── Build card list ──────────────────────────────────────────────────────

  // Phase 6.20b — native list builder. Iterates ad_sets directly; orphaned
  // posted deployments (no parent ad_set in our list) render as single cards
  // for back-compat with deployments that pre-date the unified pipeline.
  const buildCardList = () => {
    const cards = [];
    const adSetMemberDepIds = new Set();
    postedAdSets.forEach((adSet) => {
      const children = getAdSetChildDeps(adSet);
      children.forEach((d) => adSetMemberDepIds.add(d.id));
    });
    // Standalone posted deps (not part of any ad_set in our filter)
    postedDeps.forEach(dep => {
      if (adSetMemberDepIds.has(dep.id)) return;
      cards.push({ type: 'single', dep, postedDate: dep.posted_date || '', key: dep.id });
    });
    // Ad sets with at least one posted child deployment
    postedAdSets.forEach(adSet => {
      if (!adSetHasPostedChildren(adSet)) return;
      const childDeps = getAdSetChildDeps(adSet);
      cards.push({
        type: 'adset',
        adSet,
        postedDate: childDeps[0]?.posted_date || adSet.posted_at || '',
        key: `adset-${adSet.externalId}`,
      });
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

  if (loading) return <div className="text-center py-12 text-ed-ink2 text-[13px]">Loading...</div>;

  if (postedDeps.length === 0) {
    return (
      <div className="text-center py-16">
        <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-ed-green/5 flex items-center justify-center">
          <svg className="w-6 h-6 text-ed-ink3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <p className="text-[14px] font-medium text-ed-ink">No posted ads yet</p>
        <p className="text-[12px] text-ed-ink2 mt-1">When ads are marked as posted from the Ready to Post view, they'll appear here.</p>
      </div>
    );
  }

  const cardList = buildCardList();

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div>
        <div className="text-[14px]">
          <span className="font-bold text-ed-ink">{cardList.length}</span>
          <span className="text-ed-ink2 ml-1.5">posted ad{cardList.length !== 1 ? 's' : ''}</span>
        </div>
      </div>

      {/* Cards */}
      <div className="space-y-4">
        {cardList.map(card => card.type === 'single' ? renderAdCard(card.dep) : renderAdSetCard(card.adSet))}
      </div>

      {/* Phase 6.10 — AdSetTimeline drawer for clicked ObservationPill.
          Opens with full observation history (snapshots + result + benchmark). */}
      <AdSetTimeline
        projectId={projectId}
        adSetId={activeAdSetId}
        open={!!activeAdSetId}
        onClose={() => setActiveAdSetId(null)}
        onChanged={loadData}
      />
    </div>
  );
}

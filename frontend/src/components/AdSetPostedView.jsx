import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';

function depName(dep) {
  if (dep.ad_name) return dep.ad_name;
  const parts = [dep.ad?.angle, dep.ad?.headline].filter(Boolean);
  return parts.length ? parts.join(' - ') : `Ad ${(dep.id || '').slice(0, 6)}`;
}

function formatDate(value) {
  if (!value) return '';
  try {
    const d = new Date(value);
    return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} at ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
  } catch {
    return value;
  }
}

export default function AdSetPostedView({ projectId, deployments, setDeployments, addToast, isPoster }) {
  const [campaigns, setCampaigns] = useState([]);
  const [adSets, setAdSets] = useState([]);
  const [expanded, setExpanded] = useState(new Set());
  const [busyIds, setBusyIds] = useState(new Set());

  useEffect(() => {
    api.getCampaigns(projectId).then(data => {
      setCampaigns(data.campaigns || []);
      setAdSets(data.adSets || []);
    }).catch(() => {});
  }, [projectId]);

  const postedDeps = useMemo(() => deployments.filter(d => d.status === 'posted'), [deployments]);

  const cards = useMemo(() => {
    const adSetById = new Map(adSets.map(a => [a.id, a]));
    const campaignById = new Map(campaigns.map(c => [c.id, c]));
    const grouped = new Map();
    const solo = [];
    for (const dep of postedDeps) {
      const adSet = dep.local_adset_id ? adSetById.get(dep.local_adset_id) : null;
      if (!adSet) {
        solo.push({ key: `single-${dep.id}`, deps: [dep], adSet: null, campaign: null });
        continue;
      }
      if (!grouped.has(adSet.id)) {
        grouped.set(adSet.id, {
          key: `adset-${adSet.id}`,
          adSet,
          campaign: campaignById.get(adSet.campaign_id) || null,
          deps: [],
        });
      }
      grouped.get(adSet.id).deps.push(dep);
    }
    return [...Array.from(grouped.values()), ...solo];
  }, [adSets, campaigns, postedDeps]);

  const toggleExpanded = (key) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const sendBack = async (card) => {
    setBusyIds(prev => new Set(prev).add(card.key));
    const ids = card.deps.map(d => d.id);
    try {
      await Promise.all(ids.map(id => api.updateDeploymentStatus(id, 'ready_to_post')));
      setDeployments(prev => prev.map(d => ids.includes(d.id) ? { ...d, status: 'ready_to_post' } : d));
      addToast('Sent back to Ready to Post', 'success');
    } catch {
      addToast('Failed to send back', 'error');
    } finally {
      setBusyIds(prev => { const next = new Set(prev); next.delete(card.key); return next; });
    }
  };

  if (cards.length === 0) {
    return (
      <div className="card p-8 text-center">
        <div className="text-[14px] font-semibold text-textdark">No posted ads yet</div>
        <p className="text-[12px] text-textmid mt-1">Posted ad sets will appear here after the Ready-to-Post workflow is completed.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {cards.map(card => {
        const name = card.adSet?.name || depName(card.deps[0] || {});
        const isExpanded = expanded.has(card.key);
        const isBusy = busyIds.has(card.key);
        const first = card.deps[0] || {};
        return (
          <div key={card.key} className="border border-black/[0.08] rounded-2xl bg-white shadow-sm overflow-hidden">
            <div className="px-5 py-4 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h4 className="text-[15px] font-bold text-textdark">{name}</h4>
                    <span className="px-2 py-0.5 rounded bg-teal/10 text-teal text-[9px] font-bold uppercase tracking-wider">Posted</span>
                    <span className="px-2 py-0.5 rounded bg-navy/10 text-navy text-[9px] font-bold uppercase tracking-wider">{card.deps.length} image{card.deps.length === 1 ? '' : 's'}</span>
                  </div>
                  <p className="text-[11px] text-textmid mt-1">
                    {first.campaign_name || card.campaign?.name || 'No campaign'} / {first.ad_set_name || card.adSet?.name || 'Ungrouped'}
                    {first.posted_date ? ` - ${formatDate(first.posted_date)}` : ''}
                  </p>
                </div>
                <div className="flex gap-1">
                  {card.deps.slice(0, 5).map(dep => dep.imageUrl ? (
                    <img key={dep.id} src={dep.imageUrl} alt="" className="w-12 h-12 object-cover rounded-lg bg-gray-100" loading="lazy" />
                  ) : <div key={dep.id} className="w-12 h-12 rounded-lg bg-gray-100" />)}
                  {card.deps.length > 5 && <div className="w-12 h-12 rounded-lg bg-gray-100 flex items-center justify-center text-[10px] text-textlight">+{card.deps.length - 5}</div>}
                </div>
              </div>
              <button onClick={() => toggleExpanded(card.key)} className="w-full py-1.5 rounded-lg bg-navy/5 hover:bg-navy/10 text-[11px] text-navy font-medium">{isExpanded ? 'Hide Details' : 'Show Details'}</button>
              {isExpanded && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] text-textmid">
                  <Detail label="URL" value={first.landing_page_url || first.destination_url} link />
                  <Detail label="Display Link" value={first.display_link} />
                  <Detail label="CTA" value={first.cta_button?.replace(/_/g, ' ')} />
                  <Detail label="Facebook Page" value={first.facebook_page} />
                  <Detail label="Posted By" value={first.posted_by} />
                  <Detail label="Notes" value={first.notes} />
                </div>
              )}
            </div>
            {!isPoster && (
              <div className="px-5 py-3 border-t border-black/[0.06] bg-offwhite/50 flex items-center justify-end">
                <button onClick={() => sendBack(card)} disabled={isBusy} className="btn-secondary text-[11px] px-3 py-1.5 disabled:opacity-50">
                  {isBusy ? 'Sending...' : 'Back to Ready to Post'}
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Detail({ label, value, link }) {
  if (!value) return null;
  return <div><span className="font-medium text-textdark">{label}:</span> {link ? <a href={value} target="_blank" rel="noopener noreferrer" className="text-gold hover:underline break-all">{value}</a> : <span>{value}</span>}</div>;
}

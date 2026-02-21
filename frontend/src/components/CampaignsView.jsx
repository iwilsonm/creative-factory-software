import { useState, useEffect, useRef } from 'react';
import { api } from '../api';

/**
 * CampaignsView — Organises deployments into campaigns and ad sets.
 *
 * Layout:
 *   Top:    "Unplanned" holding area (deployments with local_campaign_id === 'unplanned')
 *   Bottom: Campaigns list with nested ad sets (each ad set is a drop zone)
 *
 * Props:
 *   projectId, deployments, setDeployments, addToast, loadDeployments
 */
export default function CampaignsView({ projectId, deployments, setDeployments, addToast, loadDeployments }) {
  const [campaigns, setCampaigns] = useState([]);
  const [adSets, setAdSets] = useState([]);
  const [loading, setLoading] = useState(true);

  // Inline editing
  const [editingCampaign, setEditingCampaign] = useState(null); // { id, name }
  const [editingAdSet, setEditingAdSet] = useState(null); // { id, name }
  const [newCampaignName, setNewCampaignName] = useState('');
  const [creatingCampaign, setCreatingCampaign] = useState(false);
  const [addingAdSetFor, setAddingAdSetFor] = useState(null); // campaign id
  const [newAdSetName, setNewAdSetName] = useState('');

  // Drag state
  const [dragIds, setDragIds] = useState(null); // deployment IDs being dragged
  const [dropTarget, setDropTarget] = useState(null); // ad set id being hovered

  // Selection for unplanned
  const [selectedUnplanned, setSelectedUnplanned] = useState(new Set());

  // Collapsed campaigns
  const [collapsed, setCollapsed] = useState(new Set());

  const campaignInputRef = useRef(null);
  const adSetInputRef = useRef(null);

  useEffect(() => {
    loadCampaignData();
  }, [projectId]);

  const loadCampaignData = async () => {
    setLoading(true);
    try {
      const data = await api.getCampaigns(projectId);
      setCampaigns(data.campaigns || []);
      setAdSets(data.adSets || []);
    } catch { /* ignore */ }
    setLoading(false);
  };

  // ─── Derived data ───────────────────────────────────────────────────────
  const unplannedDeps = deployments.filter(d => d.local_campaign_id === 'unplanned');
  const getAdSetDeps = (adsetId) => deployments.filter(d => d.local_adset_id === adsetId);
  const getCampaignAdSets = (campaignId) =>
    adSets.filter(a => a.campaign_id === campaignId).sort((a, b) => a.sort_order - b.sort_order);
  const sortedCampaigns = [...campaigns].sort((a, b) => a.sort_order - b.sort_order);

  // ─── Campaign CRUD ──────────────────────────────────────────────────────
  const handleCreateCampaign = async () => {
    if (!newCampaignName.trim()) return;
    try {
      const result = await api.createCampaign(projectId, newCampaignName.trim());
      setNewCampaignName('');
      setCreatingCampaign(false);
      await loadCampaignData();
      addToast('Campaign created', 'success');
    } catch (err) {
      addToast('Failed to create campaign', 'error');
    }
  };

  const handleRenameCampaign = async (id, name) => {
    if (!name.trim()) { setEditingCampaign(null); return; }
    try {
      await api.updateCampaign(id, { name: name.trim() });
      setCampaigns(prev => prev.map(c => c.id === id ? { ...c, name: name.trim() } : c));
      setEditingCampaign(null);
    } catch (err) {
      addToast('Failed to rename campaign', 'error');
    }
  };

  const handleDeleteCampaign = async (id) => {
    try {
      await api.deleteCampaign(id);
      await loadCampaignData();
      await loadDeployments();
      addToast('Campaign deleted', 'success');
    } catch (err) {
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
      await loadCampaignData();
      addToast('Ad set created', 'success');
    } catch (err) {
      addToast('Failed to create ad set', 'error');
    }
  };

  const handleRenameAdSet = async (id, name) => {
    if (!name.trim()) { setEditingAdSet(null); return; }
    try {
      await api.updateAdSet(id, { name: name.trim() });
      setAdSets(prev => prev.map(a => a.id === id ? { ...a, name: name.trim() } : a));
      setEditingAdSet(null);
    } catch (err) {
      addToast('Failed to rename ad set', 'error');
    }
  };

  const handleDeleteAdSet = async (id) => {
    try {
      await api.deleteAdSet(id);
      await loadCampaignData();
      await loadDeployments();
      addToast('Ad set deleted', 'success');
    } catch (err) {
      addToast('Failed to delete ad set', 'error');
    }
  };

  // ─── Drag & Drop ───────────────────────────────────────────────────────
  const handleDragStart = (e, depId) => {
    // If the dragged card is selected, drag all selected; otherwise just this one
    const ids = selectedUnplanned.has(depId) && selectedUnplanned.size > 0
      ? [...selectedUnplanned]
      : [depId];
    setDragIds(ids);
    e.dataTransfer.setData('text/plain', JSON.stringify({ deploymentIds: ids }));
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragEnd = () => {
    setDragIds(null);
    setDropTarget(null);
  };

  const handleDragOver = (e, adsetId) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropTarget(adsetId);
  };

  const handleDragLeave = (e, adsetId) => {
    // Only clear if we actually left this element (not entering a child)
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

    // Optimistic update
    setDeployments(prev => prev.map(d =>
      ids.includes(d.id) ? { ...d, local_campaign_id: campaignId, local_adset_id: adsetId } : d
    ));
    setSelectedUnplanned(new Set());
    setDragIds(null);

    try {
      await api.assignToAdSet(ids, campaignId, adsetId);
    } catch (err) {
      addToast('Failed to assign ads', 'error');
      loadDeployments(); // revert
    }
  };

  const handleUnassign = async (depIds) => {
    // Optimistic
    setDeployments(prev => prev.map(d =>
      depIds.includes(d.id) ? { ...d, local_campaign_id: 'unplanned', local_adset_id: undefined } : d
    ));
    try {
      await api.unassignFromAdSet(depIds);
    } catch (err) {
      addToast('Failed to unassign', 'error');
      loadDeployments();
    }
  };

  // Also allow dropping back onto the Unplanned zone
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
      ids.includes(d.id) ? { ...d, local_campaign_id: 'unplanned', local_adset_id: undefined } : d
    ));
    setDragIds(null);

    try {
      await api.unassignFromAdSet(ids);
    } catch (err) {
      addToast('Failed to move to unplanned', 'error');
      loadDeployments();
    }
  };

  // Focus inputs when they appear
  useEffect(() => {
    if (creatingCampaign && campaignInputRef.current) campaignInputRef.current.focus();
  }, [creatingCampaign]);
  useEffect(() => {
    if (addingAdSetFor && adSetInputRef.current) adSetInputRef.current.focus();
  }, [addingAdSetFor]);

  // ─── Thumbnail helper ──────────────────────────────────────────────────
  const DepCard = ({ dep, draggable = false, showUnassign = false }) => {
    const name = dep.ad?.headline || dep.ad?.angle || dep.ad_name || `Ad ${(dep.id || '').slice(0, 6)}`;
    const thumbUrl = dep.imageUrl;
    const isDragging = dragIds?.includes(dep.id);

    return (
      <div
        draggable={draggable}
        onDragStart={draggable ? (e) => handleDragStart(e, dep.id) : undefined}
        onDragEnd={draggable ? handleDragEnd : undefined}
        className={`relative group flex items-center gap-2.5 p-2 rounded-xl border transition-all cursor-grab active:cursor-grabbing ${
          isDragging ? 'opacity-40 border-navy/30 bg-navy/5' :
          selectedUnplanned.has(dep.id) ? 'border-navy/40 bg-navy/5' :
          'border-gray-200 bg-white hover:border-navy/20 hover:shadow-sm'
        }`}
      >
        {draggable && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              setSelectedUnplanned(prev => {
                const next = new Set(prev);
                if (next.has(dep.id)) next.delete(dep.id); else next.add(dep.id);
                return next;
              });
            }}
            className={`w-[14px] h-[14px] rounded flex-shrink-0 flex items-center justify-center transition-colors ${
              selectedUnplanned.has(dep.id) ? 'bg-navy' : 'border-[1.5px] border-textlight/60 hover:border-navy/40'
            }`}
          >
            {selectedUnplanned.has(dep.id) && (
              <svg className="w-2 h-2 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
              </svg>
            )}
          </button>
        )}
        {thumbUrl ? (
          <img src={thumbUrl} alt="" className="w-10 h-10 object-cover rounded-lg bg-gray-100 flex-shrink-0" loading="lazy" />
        ) : (
          <div className="w-10 h-10 rounded-lg bg-gray-100 flex-shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <div className="text-[12px] font-medium text-textdark truncate" title={name}>{name}</div>
          {dep.ad?.body_copy && (
            <div className="text-[10px] text-textlight truncate mt-0.5">{dep.ad.body_copy}</div>
          )}
        </div>
        {showUnassign && (
          <button
            onClick={() => handleUnassign([dep.id])}
            className="opacity-0 group-hover:opacity-100 p-1 rounded-lg hover:bg-red-50 text-textlight hover:text-red-500 transition-all flex-shrink-0"
            title="Move back to Unplanned"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>
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
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDropTarget(null); }}
        onDrop={handleDropOnUnplanned}
      >
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <h3 className="text-[13px] font-semibold text-textdark">Unplanned</h3>
            <span className="text-[11px] text-textlight bg-black/5 px-2 py-0.5 rounded-full">
              {unplannedDeps.length}
            </span>
          </div>
          {selectedUnplanned.size > 0 && (
            <div className="flex items-center gap-2 text-[11px]">
              <span className="text-navy font-medium">{selectedUnplanned.size} selected</span>
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
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2.5">
            {unplannedDeps.map(dep => (
              <DepCard key={dep.id} dep={dep} draggable />
            ))}
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

                  <button
                    onClick={() => handleDeleteCampaign(campaign.id)}
                    className="p-1 rounded-lg hover:bg-red-50 text-textlight hover:text-red-500 transition-colors"
                    title="Delete campaign"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
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
                      const isDropHover = dropTarget === adSet.id;

                      return (
                        <div
                          key={adSet.id}
                          onDragOver={(e) => handleDragOver(e, adSet.id)}
                          onDragLeave={(e) => handleDragLeave(e, adSet.id)}
                          onDrop={(e) => handleDrop(e, campaign.id, adSet.id)}
                          className={`rounded-xl border-2 border-dashed transition-all ${
                            isDropHover
                              ? 'border-gold bg-gold/5 shadow-sm'
                              : 'border-gray-200 bg-white'
                          }`}
                        >
                          {/* Ad set header */}
                          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-gray-100">
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
                            <span className="text-[10px] text-textlight">{deps.length} ad{deps.length !== 1 ? 's' : ''}</span>
                            <button
                              onClick={() => handleDeleteAdSet(adSet.id)}
                              className="p-1 rounded hover:bg-red-50 text-textlight hover:text-red-500 transition-colors"
                              title="Delete ad set"
                            >
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                            </button>
                          </div>

                          {/* Ad set body — drop zone */}
                          <div className="p-3 min-h-[60px]">
                            {deps.length === 0 ? (
                              <div className={`py-4 text-center rounded-lg transition-colors ${
                                isDropHover ? 'bg-gold/10' : ''
                              }`}>
                                <p className="text-[11px] text-textlight">
                                  {isDropHover ? 'Drop ads here' : 'Drag ads from Unplanned to assign'}
                                </p>
                              </div>
                            ) : (
                              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                                {deps.map(dep => (
                                  <DepCard key={dep.id} dep={dep} showUnassign draggable />
                                ))}
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
    </div>
  );
}

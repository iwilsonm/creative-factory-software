import { useState, useCallback, useEffect, useMemo } from 'react';
import { api } from '../api';
import { useAsyncData } from '../hooks/useAsyncData';
import { useToast } from './Toast';
import AdSetCard from './AdSetCard';
import MetaSettingsDialog from './MetaSettingsDialog';
import ApiWarningDialog, { shouldShowApiWarning, markApiWarningDismissed } from './ApiWarningDialog';

// Phase 1 — Staging Page. Per-project tab.
// Three sub-views:
//   - Pending Review (default): ad sets with lifecycle "staging" + their member ads
//   - Rejected: ads with status "quality_rejected" (Filter agent rejections)
//   - Promoted: ad sets with lifecycle "promoted" or "posted" (history)
//
// Pending supports regroup mode: lasso-select ads across sets, then move them
// to an existing target ad set or create a new one.
export default function StagingPage({ projectId, project, conductorAngles }) {
  const toast = useToast();
  const [tab, setTab] = useState('pending');

  const { data: pendingGroups, loading: pendingLoading, refetch: refetchPending } = useAsyncData(
    () => api.getStagingPending(projectId),
    [projectId]
  );
  const { data: rejectedAds, loading: rejectedLoading, refetch: refetchRejected } = useAsyncData(
    () => api.getStagingRejected(projectId),
    [projectId]
  );
  const { data: promotedSets, loading: promotedLoading, refetch: refetchPromoted } = useAsyncData(
    () => api.getStagingPromoted(projectId),
    [projectId]
  );

  // Regroup mode state
  const [regroupMode, setRegroupMode] = useState(false);
  const [selectedAdIds, setSelectedAdIds] = useState(new Set());

  const toggleAdSelection = useCallback((adId) => {
    setSelectedAdIds((prev) => {
      const next = new Set(prev);
      if (next.has(adId)) next.delete(adId);
      else next.add(adId);
      return next;
    });
  }, []);

  const exitRegroupMode = useCallback(() => {
    setRegroupMode(false);
    setSelectedAdIds(new Set());
  }, []);

  // Meta settings dialog
  const [editingAdSet, setEditingAdSet] = useState(null);

  // Phase 2B — Meta connection status (path + page presence + account presence)
  // Used to gate the Post-to-Meta button and decide whether to show the API warning.
  const [metaStatus, setMetaStatus] = useState(null);
  useEffect(() => {
    let cancelled = false;
    api.getMetaConnectionStatus(projectId).then((s) => {
      if (!cancelled) setMetaStatus(s);
    }).catch(() => { if (!cancelled) setMetaStatus(null); });
    return () => { cancelled = true; };
  }, [projectId]);

  // Pending Post action — captured while the warning dialog is open (when path = api)
  const [pendingPostAdSet, setPendingPostAdSet] = useState(null);
  const [postingAdSetId, setPostingAdSetId] = useState(null);

  const performPost = useCallback(async (adSet) => {
    setPostingAdSetId(adSet.id);
    try {
      const result = await api.postAdSetToMeta(projectId, adSet.id);
      const adsLink = result.meta_adset_id
        ? `https://business.facebook.com/adsmanager/manage/adsets?selected_adset_ids=${result.meta_adset_id}`
        : null;
      toast.success(
        adsLink
          ? `Posted to Meta via ${result.path_used === 'mcp' ? 'MCP' : 'API'} — opening Ads Manager`
          : `Posted to Meta via ${result.path_used === 'mcp' ? 'MCP' : 'API'}`
      );
      if (adsLink) window.open(adsLink, '_blank', 'noopener');
      refetchPending();
      refetchPromoted();
    } catch (err) {
      const code = err?.code || (err?.message || '');
      if (/TOKEN_EXPIRED/i.test(code) || /token expired/i.test(err?.message || '')) {
        toast.error('Meta token expired. Reconnect in Project Settings → Meta.');
      } else if (/MCP_NOT_AUTHORIZED/i.test(code)) {
        toast.error('Meta MCP not authorized for this app. Switch to API path or get app allowlisted.');
      } else if (/NO_PAGE/i.test(code)) {
        toast.error('Pick a Facebook Page first (Project Settings → Meta).');
      } else if (/NO_ACCOUNT|NOT_CONNECTED/i.test(code)) {
        toast.error('Connect Meta + select an ad account first.');
      } else {
        toast.error(err?.message || 'Post to Meta failed');
      }
    } finally {
      setPostingAdSetId(null);
    }
  }, [projectId, refetchPending, refetchPromoted, toast]);

  const handlePostToMeta = useCallback((adSet) => {
    if (!metaStatus?.connected || !metaStatus?.account_id || !metaStatus?.page_id) {
      toast.error('Connect Meta + pick an ad account + Page in Project Settings → Meta first.');
      return;
    }
    if (metaStatus.integration_path === 'api' && shouldShowApiWarning(projectId)) {
      setPendingPostAdSet(adSet);
      return;
    }
    performPost(adSet);
  }, [metaStatus, projectId, performPost, toast]);

  const handleConfirmApiPost = useCallback(() => {
    markApiWarningDismissed(projectId);
    if (pendingPostAdSet) performPost(pendingPostAdSet);
    setPendingPostAdSet(null);
  }, [pendingPostAdSet, performPost, projectId]);

  const handleSaveMetaSettings = useCallback(async (adSetId, fields) => {
    await api.updateAdSetMetaSettings(projectId, adSetId, fields);
    toast.success('Meta settings saved');
    refetchPending();
  }, [projectId, refetchPending, toast]);

  const handlePromote = useCallback(async (adSet) => {
    await api.promoteAdSet(projectId, adSet.id);
    toast.success(`Promoted "${adSet.name}" to Ready-to-Post`);
    refetchPending();
    refetchPromoted();
  }, [projectId, refetchPending, refetchPromoted, toast]);

  const handleForcePromoteAd = useCallback(async (adId) => {
    await api.forcePromoteAd(projectId, adId);
    toast.success('Ad force-promoted to Staging');
    refetchPending();
    refetchRejected();
  }, [projectId, refetchPending, refetchRejected, toast]);

  // Regroup actions
  const handleMoveToExisting = useCallback(async (targetAdSetId) => {
    if (selectedAdIds.size === 0) return;
    try {
      await api.regroupAds(projectId, Array.from(selectedAdIds), targetAdSetId);
      toast.success(`Moved ${selectedAdIds.size} ad${selectedAdIds.size === 1 ? '' : 's'}`);
      exitRegroupMode();
      refetchPending();
    } catch (err) {
      toast.error(err?.message || 'Regroup failed');
    }
  }, [projectId, selectedAdIds, exitRegroupMode, refetchPending, toast]);

  const handleMoveToNew = useCallback(async (angleId, name) => {
    if (selectedAdIds.size === 0) return;
    if (!angleId) { toast.error('Pick an angle for the new ad set'); return; }
    try {
      const { adSetId: newId } = await api.createEmptyAdSet(projectId, { angle_id: angleId, name });
      await api.regroupAds(projectId, Array.from(selectedAdIds), newId);
      toast.success(`Created new ad set with ${selectedAdIds.size} ad${selectedAdIds.size === 1 ? '' : 's'}`);
      exitRegroupMode();
      refetchPending();
    } catch (err) {
      toast.error(err?.message || 'Could not create ad set');
    }
  }, [projectId, selectedAdIds, exitRegroupMode, refetchPending, toast]);

  const totalPendingAds = useMemo(
    () => (pendingGroups || []).reduce((sum, g) => sum + (g.ads?.length || 0), 0),
    [pendingGroups]
  );

  return (
    <div className="space-y-4">
      {/* Sub-tab strip */}
      <div className="flex items-center gap-2 border-b border-cream pb-2">
        <SubTab active={tab === 'pending'} onClick={() => setTab('pending')} label={`Pending Review (${pendingGroups?.length || 0})`} />
        <SubTab active={tab === 'rejected'} onClick={() => setTab('rejected')} label={`Rejected (${rejectedAds?.length || 0})`} />
        <SubTab active={tab === 'promoted'} onClick={() => setTab('promoted')} label={`Promoted (${promotedSets?.length || 0})`} />

        <div className="ml-auto flex items-center gap-2">
          {tab === 'pending' && totalPendingAds > 0 && (
            regroupMode ? (
              <button type="button" onClick={exitRegroupMode} className="btn-secondary text-xs">Cancel regroup</button>
            ) : (
              <button type="button" onClick={() => setRegroupMode(true)} className="btn-secondary text-xs">Regroup ads</button>
            )
          )}
        </div>
      </div>

      {regroupMode && (
        <RegroupBar
          selectedCount={selectedAdIds.size}
          adSets={pendingGroups?.map(g => g.adSet) || []}
          conductorAngles={conductorAngles}
          onMoveToExisting={handleMoveToExisting}
          onMoveToNew={handleMoveToNew}
        />
      )}

      {/* Pending Review */}
      {tab === 'pending' && (
        <div>
          {pendingLoading && <div className="text-sm text-textmid">Loading staging…</div>}
          {!pendingLoading && (pendingGroups?.length || 0) === 0 && (
            <EmptyState
              title="No ads in staging"
              body="When the Director runs (or the Creative Director generates manually), new ads will appear here pre-grouped into ad sets, one per angle."
            />
          )}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {(pendingGroups || []).map(({ adSet, ads }) => (
              <AdSetCard
                key={adSet.id}
                adSet={adSet}
                ads={ads}
                regroupMode={regroupMode}
                selectedAdIds={selectedAdIds}
                onToggleAdSelection={toggleAdSelection}
                onEditMetaSettings={setEditingAdSet}
                onPromote={handlePromote}
                variant="pending"
              />
            ))}
          </div>
        </div>
      )}

      {/* Rejected */}
      {tab === 'rejected' && (
        <div>
          {rejectedLoading && <div className="text-sm text-textmid">Loading rejected…</div>}
          {!rejectedLoading && (rejectedAds?.length || 0) === 0 && (
            <EmptyState
              title="No rejected ads"
              body="Ads that fail the Filter agent's quality threshold appear here. Force-promote any ad you disagree with to send it back to Pending."
            />
          )}
          {/* Group rejected ads by their original ad_set_id for context */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {groupRejectedByAdSet(rejectedAds || []).map(({ adSet, ads }) => (
              <AdSetCard
                key={adSet.id}
                adSet={adSet}
                ads={ads}
                onForcePromoteAd={handleForcePromoteAd}
                variant="rejected"
                readOnly
              />
            ))}
          </div>
        </div>
      )}

      {/* Promoted history */}
      {tab === 'promoted' && (
        <div>
          {promotedLoading && <div className="text-sm text-textmid">Loading history…</div>}
          {!promotedLoading && (promotedSets?.length || 0) === 0 && (
            <EmptyState
              title="No promoted ad sets yet"
              body="Ad sets you've moved to Ready-to-Post (or that have been posted to Meta) appear here for reference."
            />
          )}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {(promotedSets || []).map((adSet) => (
              <AdSetCard
                key={adSet.id}
                adSet={adSet}
                ads={[]}  /* Phase 1: history shows the set + lifecycle status; ad thumbnails come in Phase 5 Analytics tab */
                readOnly={adSet.lifecycle_status === 'posted'}
                variant={adSet.lifecycle_status === 'posted' ? 'posted' : 'promoted'}
                onPostToMeta={handlePostToMeta}
                isPosting={postingAdSetId === adSet.id}
                metaAccountId={metaStatus?.account_id}
              />
            ))}
          </div>
        </div>
      )}

      <MetaSettingsDialog
        open={!!editingAdSet}
        adSet={editingAdSet}
        onClose={() => setEditingAdSet(null)}
        onSave={handleSaveMetaSettings}
      />

      <ApiWarningDialog
        open={!!pendingPostAdSet}
        onCancel={() => setPendingPostAdSet(null)}
        onConfirm={handleConfirmApiPost}
      />
    </div>
  );
}

function SubTab({ active, onClick, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 text-sm rounded-full transition ${active ? 'bg-navy text-white' : 'text-textmid hover:bg-cream'}`}
    >
      {label}
    </button>
  );
}

function EmptyState({ title, body }) {
  return (
    <div className="card p-8 text-center">
      <div className="text-base font-semibold text-textdark mb-1">{title}</div>
      <div className="text-sm text-textmid">{body}</div>
    </div>
  );
}

function RegroupBar({ selectedCount, adSets, conductorAngles, onMoveToExisting, onMoveToNew }) {
  const [mode, setMode] = useState('existing');
  const [targetAdSetId, setTargetAdSetId] = useState('');
  const [newAngleId, setNewAngleId] = useState('');
  const [newName, setNewName] = useState('');
  const disabled = selectedCount === 0;

  return (
    <div className="bg-navy text-white rounded-lg p-3 flex flex-wrap items-center gap-3">
      <div className="text-sm font-semibold">{selectedCount} ad{selectedCount === 1 ? '' : 's'} selected</div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => setMode('existing')}
          className={`text-xs px-2 py-1 rounded ${mode === 'existing' ? 'bg-white/20' : 'bg-transparent hover:bg-white/10'}`}
        >
          Move to existing set
        </button>
        <button
          type="button"
          onClick={() => setMode('new')}
          className={`text-xs px-2 py-1 rounded ${mode === 'new' ? 'bg-white/20' : 'bg-transparent hover:bg-white/10'}`}
        >
          New ad set
        </button>
      </div>

      {mode === 'existing' ? (
        <>
          <select
            value={targetAdSetId}
            onChange={(e) => setTargetAdSetId(e.target.value)}
            className="text-xs text-textdark px-2 py-1 rounded bg-white"
          >
            <option value="">Select target ad set…</option>
            {adSets.map((s) => (
              <option key={s.id} value={s.id}>{s.name || s.id.slice(0, 8)}</option>
            ))}
          </select>
          <button
            type="button"
            disabled={disabled || !targetAdSetId}
            onClick={() => onMoveToExisting(targetAdSetId)}
            className="text-xs px-3 py-1 bg-gold rounded font-semibold disabled:opacity-50"
          >
            Move
          </button>
        </>
      ) : (
        <>
          <select
            value={newAngleId}
            onChange={(e) => setNewAngleId(e.target.value)}
            className="text-xs text-textdark px-2 py-1 rounded bg-white"
          >
            <option value="">Pick an angle…</option>
            {(conductorAngles || []).filter(a => a.status !== 'archived').map((a) => (
              <option key={a.externalId} value={a.externalId}>{a.name}</option>
            ))}
          </select>
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Ad set name (optional)"
            className="text-xs text-textdark px-2 py-1 rounded bg-white"
          />
          <button
            type="button"
            disabled={disabled || !newAngleId}
            onClick={() => onMoveToNew(newAngleId, newName)}
            className="text-xs px-3 py-1 bg-gold rounded font-semibold disabled:opacity-50"
          >
            Create + move
          </button>
        </>
      )}
    </div>
  );
}

// Group rejected ads by their parent ad_set_id (or "(orphan)" when null) so the
// Rejected view shows them in context. Each group renders as an AdSetCard.
function groupRejectedByAdSet(ads) {
  const map = new Map();
  for (const ad of ads) {
    const key = ad.ad_set_id || '__orphan__';
    if (!map.has(key)) {
      map.set(key, {
        adSet: { id: key, name: key === '__orphan__' ? 'Orphan ads' : `Ad set ${key.slice(0, 8)}` },
        ads: [],
      });
    }
    map.get(key).ads.push(ad);
  }
  return Array.from(map.values());
}

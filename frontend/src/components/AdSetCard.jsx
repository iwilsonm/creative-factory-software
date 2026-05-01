import { useState, useMemo } from 'react';
import { api } from '../api';

// Phase 1 — Staging Page: a single ad-set card.
// Shows the angle name, ad-set name, member ads (3-up thumbnail grid),
// and (when not in regroup mode) per-set actions: Edit Meta settings,
// Promote to Ready-to-Post.
//
// In regroup mode, the ads themselves become selectable checkboxes and
// per-set actions are hidden.
export default function AdSetCard({
  adSet,
  ads,
  regroupMode = false,
  selectedAdIds,           // Set<string>
  onToggleAdSelection,     // (adId: string) => void
  onEditMetaSettings,      // (adSet) => void
  onPromote,               // (adSet) => void
  onForcePromoteAd,        // (adId) => void  // only used in Rejected view
  readOnly = false,        // for Promoted history view
  variant = 'pending',     // 'pending' | 'rejected' | 'promoted'
}) {
  const [promoting, setPromoting] = useState(false);
  const [promoteError, setPromoteError] = useState('');

  const handlePromote = async () => {
    if (promoting) return;
    setPromoteError('');
    setPromoting(true);
    try {
      await onPromote?.(adSet);
    } catch (err) {
      setPromoteError(err?.message || 'Failed to promote ad set');
    } finally {
      setPromoting(false);
    }
  };

  const adCount = ads?.length ?? 0;

  return (
    <div className="card p-4">
      <div className="flex items-start justify-between gap-4 mb-3">
        <div className="flex-1 min-w-0">
          <div className="text-[11px] uppercase tracking-wide text-textlight font-semibold">
            {adSet.angle_id ? 'Angle' : 'Untitled angle'}
          </div>
          <div className="text-sm font-semibold text-textdark truncate">{adSet.name || `Ad set ${adSet.id.slice(0, 8)}`}</div>
          <div className="text-xs text-textmid mt-0.5">{adCount} ad{adCount === 1 ? '' : 's'}</div>
        </div>
        {!readOnly && !regroupMode && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onEditMetaSettings?.(adSet)}
              className="btn-secondary text-xs px-2 py-1"
            >
              Edit Meta settings
            </button>
            <button
              type="button"
              onClick={handlePromote}
              disabled={promoting || adCount === 0}
              className="btn-primary text-xs px-2 py-1 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {promoting ? 'Promoting…' : 'Promote to Ready-to-Post'}
            </button>
          </div>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2">
        {(ads || []).slice(0, 6).map((ad) => (
          <AdThumbnail
            key={ad.id}
            ad={ad}
            selectable={regroupMode || variant === 'rejected'}
            selected={selectedAdIds?.has(ad.id) || false}
            onToggle={() => onToggleAdSelection?.(ad.id)}
            onForcePromote={variant === 'rejected' ? () => onForcePromoteAd?.(ad.id) : null}
            showRejection={variant === 'rejected'}
          />
        ))}
        {ads?.length > 6 && (
          <div className="aspect-square bg-cream rounded flex items-center justify-center text-xs text-textmid">
            +{ads.length - 6} more
          </div>
        )}
      </div>

      {promoteError && (
        <div className="mt-2 text-xs text-red-600">{promoteError}</div>
      )}
    </div>
  );
}

function AdThumbnail({ ad, selectable, selected, onToggle, onForcePromote, showRejection }) {
  const imgUrl = useMemo(() => ad.storageId
    ? `/api/projects/${ad.project_id}/ads/${ad.id}/image`
    : null, [ad.id, ad.project_id, ad.storageId]);

  const reasons = useMemo(() => {
    if (!ad.filter_reasons) return [];
    try {
      const parsed = JSON.parse(ad.filter_reasons);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }, [ad.filter_reasons]);

  return (
    <div
      className={`relative aspect-square rounded overflow-hidden border ${selected ? 'border-gold border-2' : 'border-transparent'} ${selectable ? 'cursor-pointer' : ''}`}
      onClick={selectable ? onToggle : undefined}
    >
      {imgUrl ? (
        <img src={imgUrl} alt={ad.headline || ad.id} className="w-full h-full object-cover" />
      ) : (
        <div className="w-full h-full bg-cream flex items-center justify-center text-[10px] text-textlight">
          {ad.status || 'no image'}
        </div>
      )}

      {selectable && (
        <div className={`absolute top-1 right-1 w-5 h-5 rounded-full border-2 flex items-center justify-center ${selected ? 'bg-gold border-gold text-white' : 'bg-white/80 border-white/80'}`}>
          {selected && <span className="text-xs leading-none">✓</span>}
        </div>
      )}

      {showRejection && (
        <div className="absolute bottom-0 left-0 right-0 bg-black/60 text-white text-[10px] p-1">
          <div className="font-semibold">Score: {ad.filter_score != null ? ad.filter_score.toFixed(2) : '—'}</div>
          {reasons.length > 0 && (
            <div className="truncate">{reasons[0]}</div>
          )}
          {onForcePromote && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onForcePromote(); }}
              className="mt-1 px-2 py-0.5 bg-gold text-white rounded text-[10px] font-semibold"
            >
              Force-promote
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// Phase 6.10 — Combine into Ad Set modal.
// Replaces the legacy "Combine into Flex Ad" button. Validates name, picks
// campaign (existing OR create-new inline), soft-locks deployments for 90s
// while the user fills in the form, calls api.createAdSetFromAds on save.

import { useState, useEffect, useRef } from 'react';
import { api } from '../api';

const NAME_PATTERN = /^[a-zA-Z0-9 _\-—.]+$/; // letters, digits, space, underscore, hyphen, em-dash, period
const LOCK_REFRESH_MS = 30_000; // refresh soft-lock every 30s
const LOCK_TTL_MS = 90_000;

export default function CombineIntoAdSetModal({
  open,
  projectId,
  deploymentIds,
  campaigns,
  defaultCampaignId,
  existingAdSetNames,
  onClose,
  onSuccess,
}) {
  const [name, setName] = useState('');
  const [campaignMode, setCampaignMode] = useState('existing');
  const [existingCampaignId, setExistingCampaignId] = useState('');
  const [newCampaignName, setNewCampaignName] = useState('');
  const [saving, setSaving] = useState(false);
  const [lockError, setLockError] = useState(null);
  const lockTimerRef = useRef(null);

  // Reset state on open + acquire soft-lock
  useEffect(() => {
    if (!open) return;
    setName('');
    setCampaignMode('existing');
    setExistingCampaignId(defaultCampaignId || '');
    setNewCampaignName('');
    setLockError(null);

    let cancelled = false;
    (async () => {
      try {
        await api.lockDeployments(projectId, deploymentIds, LOCK_TTL_MS);
        if (cancelled) return;
        // Refresh lock periodically while modal is open
        lockTimerRef.current = setInterval(() => {
          api.lockDeployments(projectId, deploymentIds, LOCK_TTL_MS).catch(() => {
            // Silently swallow refresh errors; surface only on explicit save
          });
        }, LOCK_REFRESH_MS);
      } catch (err) {
        if (cancelled) return;
        setLockError(err.message || 'Could not lock deployments — another session may be editing them.');
      }
    })();

    return () => {
      cancelled = true;
      if (lockTimerRef.current) {
        clearInterval(lockTimerRef.current);
        lockTimerRef.current = null;
      }
    };
  }, [open, projectId, deploymentIds, defaultCampaignId]);

  if (!open) return null;

  const trimmedName = name.trim();
  const nameValid = trimmedName.length >= 1 && trimmedName.length <= 80 && NAME_PATTERN.test(trimmedName);
  const nameCollides = existingAdSetNames?.has(trimmedName);
  const newCampaignTrimmed = newCampaignName.trim();
  const newCampaignValid = campaignMode === 'new'
    ? newCampaignTrimmed.length >= 1 && newCampaignTrimmed.length <= 80 && NAME_PATTERN.test(newCampaignTrimmed)
    : true;
  const campaignValid = campaignMode === 'existing' ? !!existingCampaignId : newCampaignValid;
  const canSave = nameValid && campaignValid && deploymentIds.length > 0 && !lockError && !saving;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const body = {
        name: trimmedName,
        deployment_ids: deploymentIds,
      };
      if (campaignMode === 'new') {
        body.create_new_campaign = newCampaignTrimmed;
      } else {
        body.campaign_id = existingCampaignId;
      }
      const result = await api.createAdSetFromAds(projectId, body);
      onSuccess?.(result);
      onClose?.();
    } catch (err) {
      setLockError(err.message || 'Failed to create ad set');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 fade-in">
      <div className="absolute inset-0 bg-black/45 backdrop-blur-sm" onClick={saving ? undefined : onClose} />
      <div className="relative bg-white rounded-2xl shadow-card w-[480px] max-w-full">
        <div className="px-5 py-4 border-b border-cream">
          <h2 className="text-[15px] font-semibold text-textdark">Combine into Ad Set</h2>
          <p className="text-[11px] text-textmid mt-0.5">
            Grouping {deploymentIds.length} ad{deploymentIds.length === 1 ? '' : 's'} into a new ad set.
          </p>
        </div>

        <div className="p-5 space-y-4">
          {/* Ad set name */}
          <div>
            <label className="block text-[12px] font-medium text-textdark mb-1">
              Ad set name <span className="text-red-500">*</span>
            </label>
            <input
              autoFocus
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Skeptic to Believer — Test 1"
              className="input-apple text-[13px] w-full"
              maxLength={80}
            />
            <div className="text-[10px] mt-1 flex items-center gap-2">
              <span className={trimmedName.length > 80 ? 'text-red-500' : 'text-textlight'}>
                {trimmedName.length}/80
              </span>
              {trimmedName && !NAME_PATTERN.test(trimmedName) && (
                <span className="text-red-500">Use letters, digits, spaces, hyphens, underscores only</span>
              )}
              {nameCollides && (
                <span className="text-gold">⚠ Name already exists in this project</span>
              )}
            </div>
          </div>

          {/* Campaign picker */}
          <div>
            <label className="block text-[12px] font-medium text-textdark mb-1">
              Campaign <span className="text-red-500">*</span>
            </label>
            <div className="flex items-center gap-3 mb-2">
              <label className="flex items-center gap-1.5 text-[12px] cursor-pointer">
                <input
                  type="radio"
                  checked={campaignMode === 'existing'}
                  onChange={() => setCampaignMode('existing')}
                />
                <span className="text-textdark">Existing</span>
              </label>
              <label className="flex items-center gap-1.5 text-[12px] cursor-pointer">
                <input
                  type="radio"
                  checked={campaignMode === 'new'}
                  onChange={() => setCampaignMode('new')}
                />
                <span className="text-textdark">+ Create new</span>
              </label>
            </div>
            {campaignMode === 'existing' ? (
              <select
                value={existingCampaignId}
                onChange={(e) => setExistingCampaignId(e.target.value)}
                className="input-apple text-[13px] w-full"
              >
                <option value="">— Pick a campaign —</option>
                {(campaigns || []).map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={newCampaignName}
                onChange={(e) => setNewCampaignName(e.target.value)}
                placeholder="New campaign name"
                className="input-apple text-[13px] w-full"
                maxLength={80}
              />
            )}
            {campaignMode === 'new' && newCampaignTrimmed && !NAME_PATTERN.test(newCampaignTrimmed) && (
              <div className="text-[10px] text-red-500 mt-1">
                Use letters, digits, spaces, hyphens, underscores only
              </div>
            )}
          </div>

          {/* Lock error */}
          {lockError && (
            <div className="text-[12px] text-red-500 bg-red-50 border border-red-100 rounded-lg p-2.5">
              {lockError}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-cream flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="btn-secondary text-[12px] px-4 py-1.5"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            className="btn-primary text-[12px] px-4 py-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? 'Creating…' : 'Create Ad Set'}
          </button>
        </div>
      </div>
    </div>
  );
}

import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import { useToast } from './Toast';

export default function CreativeFilterSettings({ projectId, project, onSave }) {
  const toast = useToast();
  const [campaigns, setCampaigns] = useState([]);
  const [form, setForm] = useState({
    scout_enabled: true,
    scout_default_campaign: '',
    scout_cta: '',
    scout_display_link: '',
    scout_facebook_page: '',
    scout_score_threshold: '',
    scout_destination_urls: [],
    scout_duplicate_adset_name: '',
  });
  const [saving, setSaving] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [showAddCampaign, setShowAddCampaign] = useState(false);
  const [newCampaignName, setNewCampaignName] = useState('');
  const [addingCampaign, setAddingCampaign] = useState(false);

  // Load campaigns for dropdown
  const loadCampaigns = useCallback(async () => {
    try {
      const data = await api.getCampaigns(projectId);
      setCampaigns(data.campaigns || []);
    } catch {
      // No campaigns yet — that's fine
    }
  }, [projectId]);

  // Sync form from project data
  useEffect(() => {
    if (!project) return;
    setForm({
      scout_enabled: project.scout_enabled !== false, // default true
      scout_default_campaign: project.scout_default_campaign || '',
      scout_cta: project.scout_cta || '',
      scout_display_link: project.scout_display_link || '',
      scout_facebook_page: project.scout_facebook_page || '',
      scout_score_threshold: project.scout_score_threshold != null ? String(project.scout_score_threshold) : '',
      scout_destination_urls: (() => {
        if (project.scout_destination_urls) {
          try { return JSON.parse(project.scout_destination_urls); } catch {}
        }
        return project.scout_destination_url ? [project.scout_destination_url] : [];
      })(),
      scout_duplicate_adset_name: project.scout_duplicate_adset_name || '',
    });
  }, [project]);

  // Load campaigns on mount
  useEffect(() => {
    loadCampaigns();
  }, [loadCampaigns]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const updates = {
        scout_enabled: form.scout_enabled,
        scout_default_campaign: form.scout_default_campaign || undefined,
        scout_cta: form.scout_cta || undefined,
        scout_display_link: form.scout_display_link || undefined,
        scout_facebook_page: form.scout_facebook_page || undefined,
        scout_score_threshold: form.scout_score_threshold ? Number(form.scout_score_threshold) : undefined,
        scout_destination_urls: form.scout_destination_urls.length > 0 ? JSON.stringify(form.scout_destination_urls) : undefined,
        scout_destination_url: form.scout_destination_urls[0] || undefined,
        scout_duplicate_adset_name: form.scout_duplicate_adset_name || undefined,
      };
      await api.updateProject(projectId, updates);
      if (onSave) await onSave();
      toast.success('Dacia Creative Filter settings saved');
    } catch (err) {
      toast.error(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card p-6">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-lg bg-navy/10 flex items-center justify-center">
            <svg className="w-3.5 h-3.5 text-navy" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
            </svg>
          </div>
          <h2 className="text-[15px] font-semibold text-textdark tracking-tight">Dacia Creative Filter</h2>
          <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${
            project?.scout_enabled !== false ? 'bg-teal/10 text-teal' : 'bg-gray-100 text-textmid'
          }`}>
            {project?.scout_enabled !== false ? 'Enabled' : 'Disabled'}
          </span>
        </div>
      </div>
      <p className="text-[12px] text-textmid mb-4">
        Recursive Agent #2 — scores batch ads with Claude, groups winners into flex ads, deploys to Ready to Post.
      </p>

      <div className="space-y-4">
        {/* Enable/Disable toggle */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[13px] font-medium text-textdark">Enable Dacia Creative Filter</p>
            <p className="text-[11px] text-textlight">Automatically score and deploy completed batches</p>
          </div>
          <button
            onClick={() => setForm(p => ({ ...p, scout_enabled: !p.scout_enabled }))}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              form.scout_enabled ? 'bg-teal' : 'bg-gray-200'
            }`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
              form.scout_enabled ? 'translate-x-6' : 'translate-x-1'
            }`} />
          </button>
        </div>

        {/* Default Campaign */}
        <div>
          <label className="block text-[12px] font-medium text-textmid mb-1">Default Campaign</label>
          {campaigns.length > 0 ? (
            <div className="flex items-center gap-2">
              <select
                value={form.scout_default_campaign}
                onChange={e => setForm(p => ({ ...p, scout_default_campaign: e.target.value }))}
                className="input-apple text-[13px] flex-1"
              >
                <option value="">Select a campaign...</option>
                {campaigns.map(c => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <button
                onClick={() => setShowAddCampaign(true)}
                className="px-2.5 py-1.5 rounded-lg text-[11px] font-semibold text-navy bg-navy/10 hover:bg-navy/15 transition-colors flex-shrink-0"
              >+ Add</button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <p className="text-[11px] text-textlight flex-1">No campaigns found.</p>
              <button
                onClick={() => setShowAddCampaign(true)}
                className="px-2.5 py-1.5 rounded-lg text-[11px] font-semibold text-navy bg-navy/10 hover:bg-navy/15 transition-colors flex-shrink-0"
              >+ Create Campaign</button>
            </div>
          )}
          {showAddCampaign && (
            <div className="flex items-center gap-2 mt-2">
              <input
                type="text"
                value={newCampaignName}
                onChange={e => setNewCampaignName(e.target.value)}
                placeholder="Campaign name..."
                className="input-apple flex-1 text-[13px]"
                autoFocus
                onKeyDown={e => {
                  if (e.key === 'Enter' && newCampaignName.trim()) {
                    (async () => {
                      setAddingCampaign(true);
                      try {
                        const res = await api.createCampaign(projectId, newCampaignName.trim());
                        await loadCampaigns();
                        if (res?.id) setForm(p => ({ ...p, scout_default_campaign: res.id }));
                        setNewCampaignName('');
                        setShowAddCampaign(false);
                      } catch { toast.error('Failed to create campaign'); }
                      finally { setAddingCampaign(false); }
                    })();
                  }
                  if (e.key === 'Escape') { setShowAddCampaign(false); setNewCampaignName(''); }
                }}
              />
              <button
                disabled={addingCampaign || !newCampaignName.trim()}
                onClick={async () => {
                  if (!newCampaignName.trim()) return;
                  setAddingCampaign(true);
                  try {
                    const res = await api.createCampaign(projectId, newCampaignName.trim());
                    await loadCampaigns();
                    if (res?.id) setForm(p => ({ ...p, scout_default_campaign: res.id }));
                    setNewCampaignName('');
                    setShowAddCampaign(false);
                  } catch { toast.error('Failed to create campaign'); }
                  finally { setAddingCampaign(false); }
                }}
                className="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-navy text-white hover:bg-navy-light transition-colors disabled:opacity-50 flex-shrink-0"
              >{addingCampaign ? '...' : 'Create'}</button>
              <button
                onClick={() => { setShowAddCampaign(false); setNewCampaignName(''); }}
                className="px-2 py-1.5 rounded-lg text-[11px] text-textmid hover:bg-black/5 transition-colors flex-shrink-0"
              >Cancel</button>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* CTA */}
          <div>
            <label className="block text-[12px] font-medium text-textmid mb-1">CTA Button Text</label>
            <input
              value={form.scout_cta}
              onChange={e => setForm(p => ({ ...p, scout_cta: e.target.value }))}
              className="input-apple text-[13px]"
              placeholder='e.g., "Shop Now"'
            />
          </div>

          {/* Display Link */}
          <div>
            <label className="block text-[12px] font-medium text-textmid mb-1">Display Link</label>
            <input
              value={form.scout_display_link}
              onChange={e => setForm(p => ({ ...p, scout_display_link: e.target.value }))}
              className="input-apple text-[13px]"
              placeholder='e.g., "healnaturally.com"'
            />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Facebook Page */}
          <div>
            <label className="block text-[12px] font-medium text-textmid mb-1">Facebook Page ID</label>
            <input
              value={form.scout_facebook_page}
              onChange={e => setForm(p => ({ ...p, scout_facebook_page: e.target.value }))}
              className="input-apple text-[13px]"
              placeholder="Facebook Page ID"
            />
          </div>

          {/* Score Threshold */}
          <div>
            <label className="block text-[12px] font-medium text-textmid mb-1">Score Threshold (optional)</label>
            <input
              type="number"
              min="1"
              max="10"
              step="1"
              value={form.scout_score_threshold}
              onChange={e => setForm(p => ({ ...p, scout_score_threshold: e.target.value }))}
              className="input-apple text-[13px]"
              placeholder="Default: 7"
            />
            <p className="text-[10px] text-textlight mt-1">Ads scoring below this (1-10) are rejected. Default is 7.</p>
          </div>
        </div>

        {/* Default Destination URLs */}
        <div>
          <label className="block text-[12px] font-medium text-textmid mb-1">Default Destination URLs</label>
          {form.scout_destination_urls.length > 0 && (
            <div className="space-y-1.5 mb-2">
              {form.scout_destination_urls.map((url, i) => (
                <div key={i} className="flex items-center gap-2 group">
                  <span className="text-[12px] text-textmid truncate flex-1" title={url}>{url}</span>
                  <button
                    onClick={() => setForm(p => ({ ...p, scout_destination_urls: p.scout_destination_urls.filter((_, idx) => idx !== i) }))}
                    className="text-[11px] text-textlight hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                    title="Remove URL"
                  >&times;</button>
                </div>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <input
              value={urlInput}
              onChange={e => setUrlInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && urlInput.trim()) {
                  e.preventDefault();
                  setForm(p => ({ ...p, scout_destination_urls: [...p.scout_destination_urls, urlInput.trim()] }));
                  setUrlInput('');
                }
              }}
              className="input-apple text-[13px] flex-1"
              placeholder='Paste URL and press Enter...'
            />
            <button
              onClick={() => {
                if (urlInput.trim()) {
                  setForm(p => ({ ...p, scout_destination_urls: [...p.scout_destination_urls, urlInput.trim()] }));
                  setUrlInput('');
                }
              }}
              disabled={!urlInput.trim()}
              className="text-[11px] font-medium text-navy hover:text-gold disabled:text-textlight disabled:cursor-not-allowed px-3 py-1.5 flex-shrink-0"
            >Add</button>
          </div>
          <p className="text-[10px] text-textlight mt-1">Landing page URLs auto-filled on deployed ads. Multiple URLs enable gauntlet rotation. Angle-specific URLs override these defaults.</p>
        </div>

        {/* Duplicate Ad Set Name */}
        <div>
          <label className="block text-[12px] font-medium text-textmid mb-1">Duplicate Ad Set Name</label>
          <input
            value={form.scout_duplicate_adset_name}
            onChange={e => setForm(p => ({ ...p, scout_duplicate_adset_name: e.target.value }))}
            className="input-apple text-[13px]"
            placeholder='e.g., "Broad - LP - Scam 002"'
          />
          <p className="text-[10px] text-textlight mt-1">Default "duplicate this ad set" name for Meta Ads Manager.</p>
        </div>

        {/* Save button */}
        <div className="pt-2 border-t border-black/5">
          <button
            onClick={handleSave}
            disabled={saving}
            className="btn-primary text-[12px] px-4 py-1.5"
          >
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
        </div>
      </div>
    </div>
  );
}

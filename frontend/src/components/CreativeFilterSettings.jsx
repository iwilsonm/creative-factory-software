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
  });
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(false);

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
    });
  }, [project]);

  // Load campaigns when expanded
  useEffect(() => {
    if (expanded) loadCampaigns();
  }, [expanded, loadCampaigns]);

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
      };
      await api.updateProject(projectId, updates);
      if (onSave) await onSave();
      toast.success('Creative Filter settings saved');
    } catch (err) {
      toast.error(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const isConfigured = project?.scout_default_campaign && project?.scout_cta && project?.scout_display_link;

  return (
    <div className="mt-6 card p-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 mb-1">
          <div className="w-6 h-6 rounded-lg bg-navy/10 flex items-center justify-center">
            <svg className="w-3.5 h-3.5 text-navy" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
            </svg>
          </div>
          <h2 className="text-[15px] font-semibold text-textdark tracking-tight">Creative Filter</h2>
          {isConfigured ? (
            <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${
              project.scout_enabled !== false ? 'bg-teal/10 text-teal' : 'bg-gray-100 text-textmid'
            }`}>
              {project.scout_enabled !== false ? 'Enabled' : 'Disabled'}
            </span>
          ) : (
            <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-gold/10 text-gold">Not Configured</span>
          )}
        </div>
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-[12px] text-textlight hover:text-textmid transition-colors"
        >
          {expanded ? 'Collapse' : 'Configure'}
        </button>
      </div>
      <p className="text-[12px] text-textmid mb-2">
        Recursive Agent #2 — scores batch ads with Claude, groups winners into flex ads, deploys to Ready to Post.
      </p>

      {!expanded && isConfigured && (
        <div className="flex flex-wrap gap-3 text-[11px] text-textmid">
          <span>Campaign: <span className="font-medium text-textdark">{campaigns.find(c => c.externalId === project.scout_default_campaign)?.name || project.scout_default_campaign?.slice(0, 8) || '—'}</span></span>
          <span>CTA: <span className="font-medium text-textdark">{project.scout_cta || '—'}</span></span>
          <span>Link: <span className="font-medium text-textdark">{project.scout_display_link || '—'}</span></span>
        </div>
      )}

      {expanded && (
        <div className="mt-4 space-y-4">
          {/* Enable/Disable toggle */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[13px] font-medium text-textdark">Enable Creative Filter</p>
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
              <select
                value={form.scout_default_campaign}
                onChange={e => setForm(p => ({ ...p, scout_default_campaign: e.target.value }))}
                className="input-apple text-[13px]"
              >
                <option value="">Select a campaign...</option>
                {campaigns.map(c => (
                  <option key={c.externalId} value={c.externalId}>
                    {c.name}
                  </option>
                ))}
              </select>
            ) : (
              <div>
                <input
                  value={form.scout_default_campaign}
                  onChange={e => setForm(p => ({ ...p, scout_default_campaign: e.target.value }))}
                  className="input-apple text-[13px]"
                  placeholder="Campaign ID (create campaigns in Ad Pipeline first)"
                />
                <p className="text-[10px] text-textlight mt-1">No campaigns found — create one in the Ad Pipeline tab first.</p>
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

          {/* Save button */}
          <div className="flex items-center gap-3 pt-2 border-t border-black/5">
            <button
              onClick={handleSave}
              disabled={saving}
              className="btn-primary text-[12px] px-4 py-1.5"
            >
              {saving ? 'Saving...' : 'Save Settings'}
            </button>
            <button
              onClick={() => setExpanded(false)}
              className="text-[12px] text-textlight hover:text-textmid"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

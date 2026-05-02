import { useState, useEffect } from 'react';
import { api } from '../api';
import { useToast } from './Toast';

// Phase 1 — per-project Creative Director / Staging Page settings.
// Fields:
//   - ad_sets_per_cycle: integer, Director cycle config (legacy fallback: config.ads_per_batch)
//   - ads_per_ad_set: integer (1-20 hard cap), Director cycle config
//   - filter_quality_threshold: 0-1, Filter agent pass threshold
//   - default_campaign_id: campaigns.externalId, default Meta campaign for new ad sets
//   - adset_default_template: JSON, Meta defaults applied to every new ad set
// Plus the per-project feature flag toggle (enable_phase1_staging:<projectId>)
// stored in the global settings table.
export default function CreativeDirectorSettings({ project, onSaved }) {
  const toast = useToast();
  const [adSetsPerCycle, setAdSetsPerCycle] = useState('');
  const [adsPerAdSet, setAdsPerAdSet] = useState('');
  const [filterThreshold, setFilterThreshold] = useState('');
  const [defaultCampaignId, setDefaultCampaignId] = useState('');
  const [adsetTemplate, setAdsetTemplate] = useState('');
  const [campaigns, setCampaigns] = useState([]);
  const [stagingFlag, setStagingFlag] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // Phase 4 — sub-angle derivation + health-biased Director
  const [healthBias, setHealthBias] = useState(false);
  const [derivationEnabled, setDerivationEnabled] = useState(true);
  const [derivationMode, setDerivationMode] = useState('auto');

  useEffect(() => {
    if (!project) return;
    setAdSetsPerCycle(project.ad_sets_per_cycle != null ? String(project.ad_sets_per_cycle) : '');
    setAdsPerAdSet(project.ads_per_ad_set != null ? String(project.ads_per_ad_set) : '');
    setFilterThreshold(project.filter_quality_threshold != null ? String(project.filter_quality_threshold) : '');
    setDefaultCampaignId(project.default_campaign_id || '');
    setAdsetTemplate(project.adset_default_template || '');
    setError('');
  }, [project]);

  // Load campaigns for the default-campaign picker + feature flag from settings + Phase 4 conductor_config
  useEffect(() => {
    if (!project?.id) return;
    (async () => {
      try {
        const list = await api.getCampaigns?.(project.id);
        setCampaigns(Array.isArray(list?.campaigns) ? list.campaigns : Array.isArray(list) ? list : []);
      } catch { setCampaigns([]); }
      try {
        const settings = await api.getSettings();
        const flagKey = `enable_phase1_staging:${project.id}`;
        const flagVal = settings?.[flagKey];
        setStagingFlag(flagVal === 'true' || flagVal === true);
      } catch { setStagingFlag(false); }
      // Phase 4 — load conductor_config Phase 4 fields
      try {
        const cfg = await api.getConductorConfig?.(project.id);
        if (cfg) {
          setHealthBias(cfg.health_bias === true);
          setDerivationEnabled(cfg.sub_angle_derivation_enabled !== false);
          setDerivationMode(cfg.sub_angle_derivation_mode || 'auto');
        }
      } catch { /* OK if endpoint not present */ }
    })();
  }, [project?.id]);

  const handleSave = async () => {
    setError('');
    // Validate ads_per_ad_set hard cap
    const aps = adsPerAdSet ? Number(adsPerAdSet) : null;
    if (aps != null && (!Number.isInteger(aps) || aps < 1 || aps > 20)) {
      setError('Ads per ad set must be an integer between 1 and 20');
      return;
    }
    const asc = adSetsPerCycle ? Number(adSetsPerCycle) : null;
    if (asc != null && (!Number.isInteger(asc) || asc < 1)) {
      setError('Ad sets per cycle must be a positive integer');
      return;
    }
    const fqt = filterThreshold ? Number(filterThreshold) : null;
    if (fqt != null && (Number.isNaN(fqt) || fqt < 0 || fqt > 1)) {
      setError('Filter quality threshold must be between 0 and 1');
      return;
    }
    if (adsetTemplate && adsetTemplate.trim()) {
      try { JSON.parse(adsetTemplate); }
      catch (e) { setError(`Ad-set template JSON invalid: ${e.message}`); return; }
    }

    setSaving(true);
    try {
      const fields = {};
      if (asc != null) fields.ad_sets_per_cycle = asc;
      if (aps != null) fields.ads_per_ad_set = aps;
      if (fqt != null) fields.filter_quality_threshold = fqt;
      if (defaultCampaignId) fields.default_campaign_id = defaultCampaignId;
      if (adsetTemplate?.trim()) fields.adset_default_template = adsetTemplate.trim();
      if (Object.keys(fields).length > 0) {
        await api.updateProject(project.id, fields);
      }
      // Save feature flag (global settings)
      const flagKey = `enable_phase1_staging:${project.id}`;
      await api.updateSettings({ [flagKey]: stagingFlag ? 'true' : 'false' });
      // Phase 4 — save conductor_config Phase 4 fields (best-effort if endpoint exists)
      try {
        await api.updateConductorConfig?.(project.id, {
          health_bias: healthBias,
          sub_angle_derivation_enabled: derivationEnabled,
          sub_angle_derivation_mode: derivationMode,
        });
      } catch { /* OK */ }
      toast.success(stagingFlag
        ? 'Creative Director settings saved — Staging tab enabled'
        : 'Creative Director settings saved — Staging tab disabled'
      );
      onSaved?.({ stagingEnabled: stagingFlag });
    } catch (err) {
      setError(err?.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card p-6 space-y-5">
      <div>
        <h2 className="text-[15px] font-semibold text-textdark tracking-tight">Creative Director — Staging cycle</h2>
        <p className="text-xs text-textmid mt-1">Per-project config for the Director's generation cycle and the Staging Page. Phase 1 — schema and routes are live; the Staging tab itself is gated by the feature flag below.</p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Ad sets per cycle" hint="How many ad sets the Director generates each run.">
          <input
            type="number" min="1"
            value={adSetsPerCycle}
            onChange={(e) => setAdSetsPerCycle(e.target.value)}
            placeholder="default 5"
            className="input-apple w-full"
          />
        </Field>
        <Field label="Ads per ad set" hint="1–20. Meta recommends 3–5 for delivery.">
          <input
            type="number" min="1" max="20"
            value={adsPerAdSet}
            onChange={(e) => setAdsPerAdSet(e.target.value)}
            placeholder="default 3"
            className="input-apple w-full"
          />
        </Field>
      </div>

      <Field label="Filter quality threshold (0–1)" hint="Ads scoring below this go to the Rejected tab. Default 0.6.">
        <input
          type="number" step="0.01" min="0" max="1"
          value={filterThreshold}
          onChange={(e) => setFilterThreshold(e.target.value)}
          placeholder="default 0.6"
          className="input-apple w-full"
        />
      </Field>

      <Field label="Default Meta campaign" hint="Every new ad set inherits this campaign unless overridden on the Staging Page.">
        <select
          value={defaultCampaignId}
          onChange={(e) => setDefaultCampaignId(e.target.value)}
          className="input-apple w-full"
        >
          <option value="">— None (auto-create [Default] on first batch) —</option>
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </Field>

      <Field label="Ad-Set defaults (JSON)" hint="Meta-side template applied to every new ad set: targeting, budget, schedule, optimization_goal, billing_event.">
        <textarea
          rows={6}
          value={adsetTemplate}
          onChange={(e) => setAdsetTemplate(e.target.value)}
          placeholder={`{\n  "budget_type": "daily",\n  "budget_amount_cents": 5000,\n  "targeting": { "age_min": 25, "age_max": 65, "geo_locations": { "countries": ["US"] } },\n  "optimization_goal": "CONVERSIONS",\n  "billing_event": "IMPRESSIONS"\n}`}
          className="input-apple w-full font-mono text-xs"
        />
      </Field>

      <div className="border-t border-cream pt-4">
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={stagingFlag}
            onChange={(e) => setStagingFlag(e.target.checked)}
            className="w-5 h-5"
          />
          <div>
            <div className="text-sm font-semibold text-textdark">Enable Staging tab for this project</div>
            <div className="text-xs text-textmid">When on, the new Staging tab shows pre-grouped ad sets ready for review. When off, the legacy Ad Pipeline / flex-ad workflow is used.</div>
          </div>
        </label>
      </div>

      {/* Phase 4 — Director behavior */}
      <div className="border-t border-cream pt-4 space-y-3">
        <h3 className="text-[13px] font-semibold text-textdark">Director behavior (Phase 4)</h3>

        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={healthBias}
            onChange={(e) => setHealthBias(e.target.checked)}
            className="w-5 h-5 mt-0.5"
          />
          <div>
            <div className="text-[13px] font-semibold text-textdark">Health-bias angle selection</div>
            <div className="text-[11px] text-textmid">When on, angles with higher real-world pass rates are selected more often. New sub-angles get a 14-day exploration boost so they get tested before random rotation buries them. Off by default until validated.</div>
          </div>
        </label>

        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={derivationEnabled}
            onChange={(e) => setDerivationEnabled(e.target.checked)}
            className="w-5 h-5 mt-0.5"
          />
          <div>
            <div className="text-[13px] font-semibold text-textdark">Auto-derive sub-angles from winners</div>
            <div className="text-[11px] text-textmid">When an angle accumulates 3+ passing observations (depth-doubled per generation), Claude proposes 1-3 sub-angle variations preserving brand identity. Auto-tagged via Phase 5.</div>
          </div>
        </label>

        {derivationEnabled && (
          <div className="ml-8">
            <div className="text-[11px] font-medium text-textmid mb-1">Derivation mode</div>
            <div className="space-y-1">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="radio" checked={derivationMode === 'auto'} onChange={() => setDerivationMode('auto')} />
                <span className="text-[12px] text-textdark">Auto — sub-angles activate immediately</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="radio" checked={derivationMode === 'review'} onChange={() => setDerivationMode('review')} />
                <span className="text-[12px] text-textdark">Review — sub-angles wait in pending_review until you approve</span>
              </label>
            </div>
          </div>
        )}
      </div>

      {error && <div className="text-sm text-red-600">{error}</div>}

      <div className="flex justify-end">
        <button type="button" onClick={handleSave} disabled={saving} className="btn-primary disabled:opacity-50">
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="text-xs font-semibold text-textmid block">{label}</span>
      {hint && <span className="text-[11px] text-textlight block mb-1">{hint}</span>}
      {children}
    </label>
  );
}

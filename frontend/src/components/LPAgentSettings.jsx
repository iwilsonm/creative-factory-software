import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useToast } from './Toast';
import LPTemplateManager from './LPTemplateManager';

const NARRATIVE_FRAMES = [
  { id: 'testimonial', name: 'Testimonial Journey' },
  { id: 'mechanism', name: 'Mechanism Deep-Dive' },
  { id: 'problem_agitation', name: 'Problem Agitation' },
  { id: 'myth_busting', name: 'Myth Busting' },
  { id: 'listicle', name: 'Listicle' },
];

export default function LPAgentSettings({ projectId }) {
  const toast = useToast();
  const navigate = useNavigate();

  // Config state
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Shopify connection state
  const [shopifyStatus, setShopifyStatus] = useState(null);
  const [shopifyConnecting, setShopifyConnecting] = useState(false);
  const [shopifyForm, setShopifyForm] = useState({ store_domain: '', client_id: '', client_secret: '' });

  // Test generation state
  const [templates, setTemplates] = useState([]);
  const [testForm, setTestForm] = useState({ template_id: '', narrative_frame: 'testimonial', angle: '' });
  const [generating, setGenerating] = useState(false);
  const [genPhase, setGenPhase] = useState('');
  const [genProgress, setGenProgress] = useState(0);
  const genStartRef = useRef(null);
  const genAbortRef = useRef(null);

  // Recent generations
  const [recentGenerations, setRecentGenerations] = useState([]);

  // Debounced save
  const saveTimerRef = useRef(null);

  // ── Load config + Shopify status + templates ──
  const loadData = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const [cfgRes, shopRes, tplRes, statusRes] = await Promise.allSettled([
        api.getLPAgentConfig(projectId),
        api.getLPAgentShopifyStatus(projectId),
        api.getLPTemplates(projectId),
        api.getLPAgentStatus(projectId),
      ]);
      if (cfgRes.status === 'fulfilled') setConfig(cfgRes.value?.config || null);
      if (shopRes.status === 'fulfilled') {
        setShopifyStatus(shopRes.value);
        if (shopRes.value?.store_domain) {
          setShopifyForm(f => ({ ...f, store_domain: shopRes.value.store_domain }));
        }
      }
      if (tplRes.status === 'fulfilled') setTemplates(tplRes.value?.templates || []);
      if (statusRes.status === 'fulfilled') setRecentGenerations(statusRes.value?.recent_generations || []);
    } catch (err) {
      console.error('[LPAgentSettings] Load error:', err);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { loadData(); }, [loadData]);

  // ── Debounced config save ──
  const handleSaveConfig = useCallback((updates) => {
    // Optimistic local update
    setConfig(prev => ({ ...(prev || {}), ...updates }));

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(async () => {
      setSaving(true);
      try {
        await api.updateLPAgentConfig(projectId, updates);
      } catch (err) {
        toast.error(err.message || 'Failed to save setting');
      } finally {
        setSaving(false);
      }
    }, 500);
  }, [projectId, toast]);

  // ── Shopify connect ──
  const handleConnectShopify = async () => {
    if (!shopifyForm.store_domain || !shopifyForm.client_id || !shopifyForm.client_secret) return;
    setShopifyConnecting(true);
    try {
      const res = await api.connectLPAgentShopify(projectId, shopifyForm);
      setShopifyStatus({ connected: true, store_domain: res.store_domain });
      setShopifyForm(f => ({ ...f, client_id: '', client_secret: '' }));
      toast.success('Connected to Shopify!');
    } catch (err) {
      toast.error(err.message || 'Connection failed');
    } finally {
      setShopifyConnecting(false);
    }
  };

  // ── Shopify disconnect ──
  const handleDisconnectShopify = async () => {
    try {
      await api.disconnectLPAgentShopify(projectId);
      setShopifyStatus({ connected: false, store_domain: shopifyStatus?.store_domain });
      toast.success('Disconnected from Shopify');
    } catch (err) {
      toast.error(err.message || 'Failed to disconnect');
    }
  };

  // ── Refresh recent generations ──
  const refreshRecentGenerations = useCallback(async () => {
    try {
      const status = await api.getLPAgentStatus(projectId);
      setRecentGenerations(status?.recent_generations || []);
    } catch { /* ignore */ }
  }, [projectId]);

  // ── Test LP generation ──
  // Map SSE step names to progress percentages (roughly weighted by time)
  const STEP_PROGRESS = {
    // Route-level setup: 0-5%
    'initializing': 1, 'validating': 2, 'creating_record': 3,
    // Pipeline setup: 5-10%
    'auto_loading': 5, 'product_image_loading': 7,
    // Copy generation: 10-35%
    'auto_copy': 10, 'loading_docs': 12, 'generating': 14, 'calling_api': 16, 'parsing': 32, 'copy_complete': 35,
    // Editorial pass: 36-55%
    'editorial_starting': 36, 'editorial_complete': 55, 'editorial_skipped': 55, 'editorial_failed': 55,
    // Image generation: 56-80%
    'images_starting': 56, 'image_generating': 60, 'image_complete': 70, 'images_complete': 80, 'images_skipped': 80,
    // HTML generation: 81-95%
    'html_generating': 81, 'html_complete': 95,
    // Assembly + publish: 97-100%
    'auto_complete': 97,
  };
  // User-friendly status messages (overrides backend messages for cleaner display)
  const STEP_LABELS = {
    'initializing': 'Setting up...',
    'validating': 'Validating template...',
    'creating_record': 'Creating page...',
    'auto_loading': 'Loading template...',
    'product_image_loading': 'Loading product image...',
    'auto_copy': 'Writing copy...',
    'loading_docs': 'Loading research docs...',
    'generating': 'Preparing copy prompt...',
    'calling_api': 'Writing copy...',
    'parsing': 'Processing copy...',
    'copy_complete': 'Copy complete',
    'editorial_starting': 'Editorial review (Opus)...',
    'editorial_complete': 'Editorial review complete',
    'editorial_skipped': 'Skipping editorial review',
    'editorial_failed': 'Editorial review skipped',
    'images_starting': 'Generating images...',
    'image_generating': null, // Use backend message (has image count)
    'image_complete': null, // Use backend message
    'images_complete': 'Images complete',
    'images_skipped': 'Skipping images',
    'html_generating': 'Building HTML page...',
    'html_complete': 'HTML complete',
    'auto_complete': 'Finalizing...',
  };
  // Separate handler for phase-level events from lpAgent.js route
  const PHASE_PROGRESS = {
    'publishing': 97, 'verifying': 99,
  };

  const handleGenerateTest = () => {
    if (!testForm.template_id || !testForm.angle.trim()) {
      toast.error('Select a template and enter an angle');
      return;
    }

    setGenerating(true);
    setGenPhase('Starting generation...');
    setGenProgress(0);
    genStartRef.current = Date.now();

    const { abort, done } = api.generateTestLP(projectId, {
      template_id: testForm.template_id,
      narrative_frame: testForm.narrative_frame,
      angle_description: testForm.angle.trim(),
    }, (event) => {
      console.log('[LP Gen]', event.type, event.step || event.phase || '', event.message || '');
      if (event.type === 'progress') {
        // Use friendly label if available, otherwise use backend message
        const label = (event.step && STEP_LABELS[event.step] !== undefined)
          ? (STEP_LABELS[event.step] || event.message || '')
          : (event.message || '');
        setGenPhase(label);
        // Map step to progress percentage — never go backwards
        if (event.step && STEP_PROGRESS[event.step] !== undefined) {
          setGenProgress(prev => Math.max(prev, STEP_PROGRESS[event.step]));
        }
        // Handle per-image progress (images are 56-80% of total)
        if (event.imageProgress) {
          const { current, total, done: imgDone } = event.imageProgress;
          // Show "Generating image 1 of 3..." style message
          if (!imgDone) {
            setGenPhase(`Generating image ${current} of ${total}...`);
          } else {
            setGenPhase(`Image ${current} of ${total} complete`);
          }
          const imgPercent = imgDone
            ? 56 + Math.round((current / total) * 24)
            : 56 + Math.round(((current - 1) / total) * 24) + Math.round((1 / total) * 12);
          setGenProgress(prev => Math.max(prev, imgPercent));
        }
      } else if (event.type === 'phase') {
        setGenPhase(event.message || event.phase || '');
        if (event.phase && PHASE_PROGRESS[event.phase] !== undefined) {
          setGenProgress(prev => Math.max(prev, PHASE_PROGRESS[event.phase]));
        }
      } else if (event.type === 'complete') {
        setGenProgress(100);
        setTimeout(() => {
          setGenerating(false);
          setGenPhase('');
          setGenProgress(0);
          genStartRef.current = null;
          const msg = event.published_url
            ? 'LP generated and published!'
            : 'LP generated successfully!';
          toast.success(msg);
          refreshRecentGenerations();
        }, 500);
      } else if (event.type === 'error') {
        setGenerating(false);
        setGenPhase('');
        setGenProgress(0);
        genStartRef.current = null;
        toast.error(event.message || 'Generation failed');
      }
    });

    genAbortRef.current = abort;

    done.catch((err) => {
      if (err.name !== 'AbortError') {
        setGenerating(false);
        setGenPhase('');
        setGenProgress(0);
        genStartRef.current = null;
        toast.error(err.message || 'Generation failed');
      }
    });
  };

  // Estimate time remaining based on elapsed time and progress
  const getTimeEstimate = () => {
    if (!genStartRef.current || genProgress < 3) return null;
    const elapsed = (Date.now() - genStartRef.current) / 1000;
    if (elapsed < 5) return null; // Wait at least 5s before estimating
    const rate = genProgress / elapsed;
    if (rate <= 0) return null;
    const remaining = Math.round((100 - genProgress) / rate);
    if (remaining < 5) return 'Almost done';
    if (remaining < 60) return `~${remaining}s remaining`;
    return `~${Math.ceil(remaining / 60)}m remaining`;
  };

  // ── Derived state ──
  const enabledFrames = (() => {
    try {
      const parsed = JSON.parse(config?.default_narrative_frames || '[]');
      // Default to all frames if none are saved yet
      return parsed.length > 0 ? parsed : NARRATIVE_FRAMES.map(f => f.id);
    } catch {
      return NARRATIVE_FRAMES.map(f => f.id);
    }
  })();

  const readyTemplates = templates.filter(t => t.status === 'ready');

  // Determine agent status label
  const hasShopify = shopifyStatus?.connected;
  const hasTemplates = readyTemplates.length > 0;
  const hasPdpUrl = !!config?.pdp_url;
  const isEnabled = !!config?.enabled;

  let statusLabel = 'Inactive';
  let statusColor = 'bg-gray-100 text-textmid';
  if (isEnabled && hasShopify && hasTemplates && hasPdpUrl) {
    statusLabel = 'Active';
    statusColor = 'bg-teal/10 text-teal';
  } else if (isEnabled) {
    statusLabel = 'Missing Config';
    statusColor = 'bg-gold/10 text-gold';
  }

  if (loading) {
    return (
      <div className="space-y-4">
        {[0, 1, 2].map(i => (
          <div key={i} className="card p-5 animate-pulse">
            <div className="h-4 w-48 bg-gray-200 rounded" />
            <div className="h-3 w-64 bg-gray-100 rounded mt-3" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">

      {/* ── 1. Agent Status Header ── */}
      <div className="card p-5">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-navy/10 flex items-center justify-center">
              <svg className="w-4 h-4 text-navy" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
              </svg>
            </div>
            <h2 className="text-[15px] font-semibold text-textdark tracking-tight">LP Agent</h2>
            <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${statusColor}`}>
              {statusLabel}
            </span>
            {saving && (
              <span className="text-[10px] text-textlight animate-pulse">Saving...</span>
            )}
          </div>
        </div>

        <p className="text-[12px] text-textmid mb-4">
          Agent #3 — Generates advertorials with narrative frames, runs Opus editorial review, publishes to Shopify.
        </p>

        {/* Enable toggle */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[13px] font-medium text-textdark">Enable LP Agent</p>
            <p className="text-[11px] text-textlight">Auto-generate landing pages with Director batches</p>
          </div>
          <button
            onClick={() => handleSaveConfig({ enabled: !config?.enabled })}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              config?.enabled ? 'bg-teal' : 'bg-gray-200'
            }`}
          >
            <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
              config?.enabled ? 'translate-x-6' : 'translate-x-1'
            }`} />
          </button>
        </div>
      </div>

      {/* ── 2. Shopify Connection ── */}
      <div className="card p-5">
        <h3 className="text-[13px] font-semibold text-textdark mb-3 flex items-center gap-2">
          <svg className="w-4 h-4 text-textmid" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m9.86-2.04a4.5 4.5 0 00-1.242-7.244l-4.5-4.5a4.5 4.5 0 00-6.364 6.364L4.757 8.06" />
          </svg>
          Shopify Connection
        </h3>

        {shopifyStatus?.connected ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between bg-teal/5 rounded-lg px-3 py-2.5">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-teal" />
                <span className="text-[11px] font-medium text-teal">
                  Connected to {shopifyStatus.store_domain}
                </span>
              </div>
              <button
                onClick={handleDisconnectShopify}
                className="text-[10px] text-textlight hover:text-red-400 transition-colors"
              >
                Disconnect
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <div>
              <label className="text-[11px] text-textmid font-medium block mb-1">Store Domain</label>
              <input
                type="text"
                placeholder="your-store.myshopify.com"
                value={shopifyForm.store_domain}
                onChange={e => setShopifyForm(f => ({ ...f, store_domain: e.target.value }))}
                disabled={shopifyConnecting}
                className="input-apple w-full text-[12px]"
              />
            </div>
            <div>
              <label className="text-[11px] text-textmid font-medium block mb-1">Client ID</label>
              <input
                type="text"
                placeholder="App Client ID"
                value={shopifyForm.client_id}
                onChange={e => setShopifyForm(f => ({ ...f, client_id: e.target.value }))}
                disabled={shopifyConnecting}
                className="input-apple w-full text-[12px]"
              />
            </div>
            <div>
              <label className="text-[11px] text-textmid font-medium block mb-1">Client Secret</label>
              <input
                type="password"
                placeholder="App Client Secret"
                value={shopifyForm.client_secret}
                onChange={e => setShopifyForm(f => ({ ...f, client_secret: e.target.value }))}
                disabled={shopifyConnecting}
                className="input-apple w-full text-[12px]"
              />
            </div>
            <button
              onClick={handleConnectShopify}
              disabled={shopifyConnecting || !shopifyForm.store_domain || !shopifyForm.client_id || !shopifyForm.client_secret}
              className="btn-primary w-full text-[11px] py-2 disabled:opacity-50"
            >
              {shopifyConnecting ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Connecting to Shopify...
                </span>
              ) : 'Connect to Shopify'}
            </button>
            <p className="text-[9px] text-textlight">
              Create a custom app in your Shopify Partners Dashboard with{' '}
              <code className="bg-black/5 px-1 rounded text-[9px]">write_content</code> and{' '}
              <code className="bg-black/5 px-1 rounded text-[9px]">read_content</code> scopes,
              then enter the credentials here.
            </p>
          </div>
        )}
      </div>

      {/* ── 3. Product Page ── */}
      <div className="card p-5">
        <h3 className="text-[13px] font-semibold text-textdark mb-3 flex items-center gap-2">
          <svg className="w-4 h-4 text-textmid" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
          </svg>
          Product Page
        </h3>
        <div>
          <label className="text-[11px] text-textmid font-medium block mb-1">PDP URL (CTA destination)</label>
          <input
            type="text"
            placeholder="https://your-store.com/products/your-product"
            value={config?.pdp_url || ''}
            onChange={e => handleSaveConfig({ pdp_url: e.target.value })}
            className="input-apple w-full text-[12px]"
          />
          <p className="text-[9px] text-textlight mt-0.5">All CTA buttons on published landing pages will link here</p>
        </div>
      </div>

      {/* ── 3b. Page Metadata ── */}
      <div className="card p-5">
        <h3 className="text-[13px] font-semibold text-textdark mb-3 flex items-center gap-2">
          <svg className="w-4 h-4 text-textmid" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
          </svg>
          Page Metadata
        </h3>
        <div className="space-y-3">
          <div>
            <label className="text-[11px] text-textmid font-medium block mb-1">Author Name</label>
            <input
              type="text"
              placeholder="Health Desk"
              value={config?.default_author_name || ''}
              onChange={e => handleSaveConfig({ default_author_name: e.target.value })}
              className="input-apple w-full text-[12px]"
            />
          </div>
          <div>
            <label className="text-[11px] text-textmid font-medium block mb-1">Author Title</label>
            <input
              type="text"
              placeholder="Senior Health Correspondent"
              value={config?.default_author_title || ''}
              onChange={e => handleSaveConfig({ default_author_title: e.target.value })}
              className="input-apple w-full text-[12px]"
            />
          </div>
          <p className="text-[9px] text-textlight">
            These appear as byline metadata on generated landing pages. Leave blank for defaults.
          </p>
        </div>
      </div>

      {/* ── 4. Generation Settings ── */}
      <div className="card p-5">
        <h3 className="text-[13px] font-semibold text-textdark mb-3 flex items-center gap-2">
          <svg className="w-4 h-4 text-textmid" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.02-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.281z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          Generation Settings
        </h3>

        <div className="space-y-4">
          {/* Narrative Frames */}
          <div>
            <label className="text-[11px] text-textmid font-medium block mb-2">Narrative Frames</label>
            <p className="text-[9px] text-textlight mb-2">Select which narrative frames are available for LP generation (minimum 2).</p>
            <div className="space-y-1.5">
              {NARRATIVE_FRAMES.map(frame => {
                const isChecked = enabledFrames.includes(frame.id);
                return (
                  <label key={frame.id} className="flex items-center gap-2.5 cursor-pointer group">
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => {
                        let updated;
                        if (isChecked) {
                          updated = enabledFrames.filter(id => id !== frame.id);
                          if (updated.length < 2) {
                            toast.error('At least 2 narrative frames must be enabled');
                            return;
                          }
                        } else {
                          updated = [...enabledFrames, frame.id];
                        }
                        handleSaveConfig({ default_narrative_frames: JSON.stringify(updated) });
                      }}
                      className="w-3.5 h-3.5 rounded border-gray-300 text-navy focus:ring-navy/50 cursor-pointer"
                    />
                    <span className="text-[12px] text-textdark group-hover:text-navy transition-colors">{frame.name}</span>
                  </label>
                );
              })}
            </div>
          </div>

          {/* Toggles */}
          <div className="space-y-3 pt-3 border-t border-black/5">
            {/* Editorial pass toggle */}
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[12px] font-medium text-textdark">Opus Editorial Pass</p>
                <p className="text-[10px] text-textlight">Claude Opus reviews copy for strategic improvements before HTML assembly</p>
              </div>
              <button
                onClick={() => handleSaveConfig({ editorial_pass_enabled: config?.editorial_pass_enabled === false ? true : false })}
                className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                  config?.editorial_pass_enabled !== false ? 'bg-navy' : 'bg-gray-200'
                }`}
              >
                <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                  config?.editorial_pass_enabled !== false ? 'translate-x-4' : 'translate-x-0'
                }`} />
              </button>
            </div>

            {/* Auto-publish toggle */}
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[12px] font-medium text-textdark">Auto-Publish to Shopify</p>
                <p className="text-[10px] text-textlight">Automatically publish generated LPs to Shopify (requires connected store)</p>
              </div>
              <button
                onClick={() => handleSaveConfig({ auto_publish: config?.auto_publish === false ? true : false })}
                className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                  config?.auto_publish !== false ? 'bg-navy' : 'bg-gray-200'
                }`}
              >
                <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                  config?.auto_publish !== false ? 'translate-x-4' : 'translate-x-0'
                }`} />
              </button>
            </div>

            {/* Product reference images toggle */}
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[12px] font-medium text-textdark">Product Reference Images</p>
                <p className="text-[10px] text-textlight">Use project's product photo as reference for hero/product image slots</p>
              </div>
              <button
                onClick={() => handleSaveConfig({ use_product_reference_images: config?.use_product_reference_images === false ? true : false })}
                className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                  config?.use_product_reference_images !== false ? 'bg-navy' : 'bg-gray-200'
                }`}
              >
                <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                  config?.use_product_reference_images !== false ? 'translate-x-4' : 'translate-x-0'
                }`} />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ── 5. Template Library ── */}
      <div className="card p-5">
        <h3 className="text-[13px] font-semibold text-textdark mb-3 flex items-center gap-2">
          <svg className="w-4 h-4 text-textmid" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.25 7.125C2.25 6.504 2.754 6 3.375 6h6c.621 0 1.125.504 1.125 1.125v3.75c0 .621-.504 1.125-1.125 1.125h-6a1.125 1.125 0 01-1.125-1.125v-3.75zM14.25 8.625c0-.621.504-1.125 1.125-1.125h5.25c.621 0 1.125.504 1.125 1.125v8.25c0 .621-.504 1.125-1.125 1.125h-5.25a1.125 1.125 0 01-1.125-1.125v-8.25zM3.75 16.125c0-.621.504-1.125 1.125-1.125h5.25c.621 0 1.125.504 1.125 1.125v2.25c0 .621-.504 1.125-1.125 1.125h-5.25a1.125 1.125 0 01-1.125-1.125v-2.25z" />
          </svg>
          Template Library
        </h3>
        <LPTemplateManager projectId={projectId} />
      </div>

      {/* ── 6. Test Generation ── */}
      <div className="card p-5">
        <h3 className="text-[13px] font-semibold text-textdark mb-3 flex items-center gap-2">
          <svg className="w-4 h-4 text-textmid" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5" />
          </svg>
          Test Generation
        </h3>

        {readyTemplates.length === 0 ? (
          <div className="text-center py-4">
            <p className="text-[12px] text-textmid">No templates available. Extract a template from a URL first.</p>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex gap-2">
              <select
                value={testForm.template_id}
                onChange={e => setTestForm(f => ({ ...f, template_id: e.target.value }))}
                disabled={generating}
                className="input-apple flex-1 text-[12px]"
              >
                <option value="">Select template...</option>
                {readyTemplates.map(t => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
              <select
                value={testForm.narrative_frame}
                onChange={e => setTestForm(f => ({ ...f, narrative_frame: e.target.value }))}
                disabled={generating}
                className="input-apple flex-1 text-[12px]"
              >
                {NARRATIVE_FRAMES.filter(f => enabledFrames.includes(f.id)).map(f => (
                  <option key={f.id} value={f.id}>{f.name}</option>
                ))}
              </select>
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={testForm.angle}
                onChange={e => setTestForm(f => ({ ...f, angle: e.target.value }))}
                className="input-apple flex-1 text-[12px]"
                placeholder="Angle: e.g., Grounding reduces chronic inflammation and improves sleep"
                disabled={generating}
                onKeyDown={e => e.key === 'Enter' && !generating && handleGenerateTest()}
              />
              <button
                onClick={handleGenerateTest}
                disabled={generating || !testForm.template_id || !testForm.angle.trim()}
                className="btn-primary text-[12px] whitespace-nowrap disabled:opacity-50"
              >
                {generating ? 'Generating...' : 'Generate'}
              </button>
            </div>
            {generating && (
              <div className="space-y-1.5 mt-1">
                {/* Progress bar */}
                <div className="w-full bg-black/5 rounded-full h-2 overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-700 ease-out"
                    style={{
                      width: `${Math.max(genProgress, 2)}%`,
                      background: genProgress >= 100
                        ? '#2A9D8F'
                        : 'linear-gradient(90deg, #0B1D3A, #132B52)',
                    }}
                  />
                </div>
                {/* Status line */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <svg className="w-3 h-3 text-navy animate-spin flex-shrink-0" viewBox="0 0 24 24" fill="none">
                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4 31.4" strokeLinecap="round" />
                    </svg>
                    <span className="text-[10px] text-textmid truncate">{genPhase || 'Starting...'}</span>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                    <span className="text-[10px] font-medium text-navy">{genProgress}%</span>
                    {getTimeEstimate() && (
                      <span className="text-[9px] text-textlight">{getTimeEstimate()}</span>
                    )}
                  </div>
                </div>
              </div>
            )}
            <p className="text-[10px] text-textlight mt-1">
              Test the LP pipeline: pick a template and narrative frame, enter an angle, and generate a landing page.
            </p>
          </div>
        )}
      </div>

      {/* ── 7. Recent Generations ── */}
      <div className="card p-5">
        <h3 className="text-[13px] font-semibold text-textdark mb-3 flex items-center gap-2">
          <svg className="w-4 h-4 text-textmid" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          Recent Generations
        </h3>

        {recentGenerations.length === 0 ? (
          <p className="text-[12px] text-textmid text-center py-3">No test generations yet.</p>
        ) : (
          <div className="space-y-2">
            {recentGenerations.map(lp => {
              const isGenerating = lp.status === 'generating';
              const isPublished = lp.status === 'published';
              const isFailed = lp.status === 'failed' || lp.status === 'error';
              const isDraft = !isGenerating && !isPublished && !isFailed;

              let badgeClass = 'bg-navy/10 text-navy';
              let badgeText = 'Draft';
              if (isGenerating) { badgeClass = 'bg-gold/10 text-gold'; badgeText = 'Generating'; }
              if (isPublished) { badgeClass = 'bg-teal/10 text-teal'; badgeText = 'Published'; }
              if (isFailed) { badgeClass = 'bg-red-50 text-red-600'; badgeText = 'Failed'; }

              // Full timestamp
              const createdAt = lp.created_at ? new Date(lp.created_at) : null;
              const timestamp = createdAt ? createdAt.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';

              return (
                <div
                  key={lp.id}
                  className="flex items-center justify-between bg-offwhite rounded-lg px-3 py-2 cursor-pointer hover:bg-navy/5 transition-colors"
                  onClick={() => navigate(`/projects/${projectId}?tab=lpgen&lp=${lp.id}`)}
                  title="View this landing page"
                >
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    {isGenerating && (
                      <svg className="w-3 h-3 text-gold animate-spin flex-shrink-0" viewBox="0 0 24 24" fill="none">
                        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4 31.4" strokeLinecap="round" />
                      </svg>
                    )}
                    <span className="text-[11px] text-textdark truncate">{lp.name}</span>
                    <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded-full flex-shrink-0 ${badgeClass}`}>
                      {badgeText}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                    {isPublished && lp.published_url && (
                      <a
                        href={lp.published_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="text-[10px] text-gold hover:text-gold/80 transition-colors"
                      >
                        View live
                      </a>
                    )}
                    {timestamp && (
                      <span className="text-[9px] text-textlight">{timestamp}</span>
                    )}
                    <svg className="w-3.5 h-3.5 text-textlight" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                    </svg>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

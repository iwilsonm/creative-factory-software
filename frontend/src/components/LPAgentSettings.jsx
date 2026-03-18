import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useToast } from './Toast';
import LPTemplateManager from './LPTemplateManager';
import PipelineProgress from './PipelineProgress';
import { usePolling } from '../hooks/usePolling';
import { ensureArray } from '../utils/collections';

const NARRATIVE_FRAMES = [
  { id: 'testimonial', name: 'Testimonial Journey' },
  { id: 'mechanism', name: 'Mechanism Deep-Dive' },
  { id: 'problem_agitation', name: 'Problem Agitation' },
  { id: 'myth_busting', name: 'Myth Busting' },
  { id: 'listicle', name: 'Listicle' },
];

const FRAME_LABELS = {
  testimonial: 'Testimonial Journey',
  mechanism: 'Mechanism Deep-Dive',
  problem_agitation: 'Problem Agitation',
  myth_busting: 'Myth Busting',
  listicle: 'Listicle',
};

function safeParseQueue(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return ensureArray(parsed, 'LPAgentSettings.savedQueue');
  } catch {
    return [];
  }
}

function buildQueueSummary(report) {
  const summary = report?.summary;
  if (!summary) return 'Dry run complete.';
  return `${summary.passed || 0}/${summary.total || 0} passed, avg ${summary.avgScore || 0}/11`;
}

export default function LPAgentSettings({ projectId }) {
  const toast = useToast();
  const navigate = useNavigate();
  const queueStorageKey = useMemo(() => `lp-agent-dry-run-queue:${projectId}`, [projectId]);

  // Config state
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Shopify connection state
  const [shopifyStatus, setShopifyStatus] = useState(null);
  const [shopifyConnecting, setShopifyConnecting] = useState(false);
  const [shopifyForm, setShopifyForm] = useState({ store_domain: '', client_id: '', client_secret: '' });

  // Templates (for status check)
  const [templates, setTemplates] = useState([]);

  // Batch generation state
  const [gauntletRunning, setGauntletRunning] = useState(false);
  const [gauntletPhase, setGauntletPhase] = useState('');
  const [gauntletProgress, setGauntletProgress] = useState(0);
  const [gauntletReport, setGauntletReport] = useState(null);
  const gauntletStartRef = useRef(null);
  const gauntletAbortRef = useRef(null);
  const gauntletSSEActive = useRef(false); // true when SSE stream is connected

  // Dry-run queue state
  const [dryRunQueue, setDryRunQueue] = useState([]);
  const dryRunSSEActiveRef = useRef(false);
  const dryRunAbortRef = useRef(null);
  const restoredDryRunRef = useRef(false);

  // Conductor angles (for gauntlet dropdown)
  const [conductorAngles, setConductorAngles] = useState([]);
  const [selectedAngle, setSelectedAngle] = useState('');
  const [variantCount, setVariantCount] = useState(1);

  // Recent generations
  const [recentGenerations, setRecentGenerations] = useState([]);
  const [expandedBatches, setExpandedBatches] = useState({});
  const [publishingLPId, setPublishingLPId] = useState(null);

  // Debounced save
  const saveTimerRef = useRef(null);
  const pendingConfigRef = useRef({});
  const saveInFlightRef = useRef(false);

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

  // ── Load config + Shopify status + templates ──
  const loadData = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const [cfgRes, shopRes, tplRes, statusRes, anglesRes] = await Promise.allSettled([
        api.getLPAgentConfig(projectId),
        api.getLPAgentShopifyStatus(projectId),
        api.getLPTemplates(projectId),
        api.getLPAgentStatus(projectId),
        api.getConductorAngles(projectId),
      ]);
      if (cfgRes.status === 'fulfilled') setConfig(cfgRes.value?.config || null);
      if (shopRes.status === 'fulfilled') {
        setShopifyStatus(shopRes.value);
        if (shopRes.value?.store_domain) {
          setShopifyForm(f => ({ ...f, store_domain: shopRes.value.store_domain }));
        }
      }
      if (tplRes.status === 'fulfilled') setTemplates(ensureArray(tplRes.value?.templates, 'LPAgentSettings.templates'));
      if (statusRes.status === 'fulfilled') setRecentGenerations(ensureArray(statusRes.value?.recent_generations, 'LPAgentSettings.recentGenerations'));
      if (anglesRes.status === 'fulfilled') setConductorAngles(ensureArray(anglesRes.value?.angles ?? anglesRes.value, 'LPAgentSettings.conductorAngles'));
    } catch (err) {
      console.error('[LPAgentSettings] Load error:', err);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { loadData(); }, [loadData]);

  useEffect(() => {
    pendingConfigRef.current = {};
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
  }, [projectId]);

  useEffect(() => {
    restoredDryRunRef.current = false;
    setDryRunQueue([]);
  }, [projectId]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      dryRunAbortRef.current?.();
    };
  }, []);

  useEffect(() => {
    if (!projectId || restoredDryRunRef.current) return;
    restoredDryRunRef.current = true;
    setDryRunQueue(safeParseQueue(localStorage.getItem(queueStorageKey)).map((item) => ({
      ...item,
      status: item.status === 'running' ? 'running' : item.status,
      sseConnected: false,
    })));
  }, [projectId, queueStorageKey]);

  useEffect(() => {
    if (!projectId || !restoredDryRunRef.current) return;
    localStorage.setItem(queueStorageKey, JSON.stringify(dryRunQueue));
  }, [dryRunQueue, projectId, queueStorageKey]);

  // ── Mount-time recovery: check for active gauntlet progress ──
  useEffect(() => {
    if (!projectId) return;
    const savedQueue = safeParseQueue(localStorage.getItem(queueStorageKey));
    if (savedQueue.some(item => item.status === 'queued' || item.status === 'running')) return;
    api.getGauntletProgress(projectId).then(progress => {
      if (progress) {
        setGauntletRunning(true);
        setGauntletPhase(progress.message || progress.step || '');
        setGauntletProgress(progress.percent || 0);
        if (!gauntletStartRef.current) gauntletStartRef.current = progress.startedAt;
      }
    }).catch(() => {});
  }, [projectId, queueStorageKey]);

  useEffect(() => {
    if (!projectId) return;
    api.getGauntletProgress(projectId).then(progress => {
      if (!progress) return;
      setDryRunQueue(prev => {
        const running = prev.find(item => item.status === 'running');
        if (running) {
          return prev.map(item => item.id === running.id ? {
            ...item,
            progress: Math.max(item.progress || 0, progress.percent || 0),
            phase: progress.message || progress.step || item.phase,
            startTime: item.startTime || progress.startedAt || Date.now(),
            sseConnected: false,
          } : item);
        }
        const restoredItem = {
          id: `restored-${projectId}`,
          projectId,
          status: 'running',
          angle: selectedAngle || null,
          frameIds: enabledFrames,
          startTime: progress.startedAt || Date.now(),
          progress: progress.percent || 0,
          phase: progress.message || progress.step || 'Dry run in progress...',
          result: null,
          sseConnected: false,
        };
        return [...prev, restoredItem];
      });
    }).catch(() => {});
  }, [enabledFrames, projectId, selectedAngle]);

  // ── Polling fallback: update progress when gauntlet running but no SSE ──
  usePolling(
    async () => {
      const progress = await api.getGauntletProgress(projectId);
      if (progress) {
        setGauntletPhase(progress.message || progress.step || '');
        setGauntletProgress(prev => Math.max(prev, progress.percent || 0));
      } else {
        // Generation finished while we were polling
        setGauntletRunning(false);
        setGauntletProgress(100);
        setTimeout(() => {
          setGauntletProgress(0);
          setGauntletPhase('');
          gauntletStartRef.current = null;
        }, 1500);
        loadData();
        refreshRecentGenerations();
      }
    },
    3000,
    gauntletRunning && !gauntletSSEActive.current
  );

  const activeDryRun = dryRunQueue.find(item => item.status === 'running') || null;
  const queuedDryRuns = dryRunQueue.filter(item => item.status === 'queued');
  const finishedDryRuns = dryRunQueue.filter(item => item.status === 'complete' || item.status === 'error' || item.status === 'cancelled');
  const hasQueuedOrRunningDryRun = dryRunQueue.some(item => item.status === 'queued' || item.status === 'running');

  usePolling(
    async () => {
      const progress = await api.getGauntletProgress(projectId);
      if (progress && activeDryRun) {
        setDryRunQueue(prev => prev.map(item => item.id === activeDryRun.id ? {
          ...item,
          progress: Math.max(item.progress || 0, progress.percent || 0),
          phase: progress.message || progress.step || item.phase,
          startTime: item.startTime || progress.startedAt || Date.now(),
        } : item));
        return;
      }
      if (!progress && activeDryRun) {
        setDryRunQueue(prev => prev.map(item => item.id === activeDryRun.id ? {
          ...item,
          status: 'complete',
          progress: 100,
          phase: 'Dry run complete. Check Recent Generations for results.',
          sseConnected: false,
          finishedAt: Date.now(),
        } : item));
        refreshRecentGenerations();
      }
    },
    3000,
    Boolean(activeDryRun) && !dryRunSSEActiveRef.current
  );

  // ── Debounced config save ──
  const flushPendingConfig = useCallback(async () => {
    if (!projectId || saveInFlightRef.current) return;
    const updates = pendingConfigRef.current;
    if (Object.keys(updates).length === 0) return;

    pendingConfigRef.current = {};
    saveInFlightRef.current = true;
    setSaving(true);
    try {
      await api.updateLPAgentConfig(projectId, updates);
    } catch (err) {
      pendingConfigRef.current = { ...updates, ...pendingConfigRef.current };
      toast.error(err.message || 'Failed to save setting');
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
      if (Object.keys(pendingConfigRef.current).length > 0) {
        if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = setTimeout(flushPendingConfig, 500);
      }
    }
  }, [projectId, toast]);

  const handleSaveConfig = useCallback((updates) => {
    setConfig(prev => ({ ...(prev || {}), ...updates }));
    pendingConfigRef.current = { ...pendingConfigRef.current, ...updates };
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(flushPendingConfig, 500);
  }, [flushPendingConfig]);

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

  const handlePublishLP = async (e, lpId) => {
    e.stopPropagation();
    setPublishingLPId(lpId);
    try {
      await api.publishLandingPage(projectId, lpId);
      toast.success('Landing page published to Shopify!');
      await refreshRecentGenerations();
    } catch (err) {
      toast.error(`Publish failed: ${err.message}`);
    } finally {
      setPublishingLPId(null);
    }
  };

  const updateDryRunQueueItem = useCallback((queueId, updates) => {
    setDryRunQueue(prev => prev.map(item => item.id === queueId ? { ...item, ...updates } : item));
  }, []);

  const handleQueueDryRun = useCallback(() => {
    const queueItem = {
      id: crypto.randomUUID(),
      projectId,
      status: 'queued',
      angle: selectedAngle || null,
      frameIds: [...enabledFrames],
      startTime: null,
      progress: 0,
      phase: 'Queued',
      result: null,
      sseConnected: false,
    };
    setDryRunQueue(prev => [...prev, queueItem]);
    setGauntletReport(null);
  }, [enabledFrames, projectId, selectedAngle]);

  const handleRemoveQueuedDryRun = useCallback((queueId) => {
    setDryRunQueue(prev => prev.filter(item => item.id !== queueId || item.status !== 'queued'));
  }, []);

  const handleDismissDryRun = useCallback((queueId) => {
    setDryRunQueue(prev => prev.filter(item => item.id !== queueId));
  }, []);

  const handleClearQueuedDryRuns = useCallback(() => {
    setDryRunQueue(prev => prev.filter(item => item.status !== 'queued'));
  }, []);

  // ── Batch generation ──
  const handleRunGauntlet = (dryRun = false) => {
    setGauntletRunning(true);
    setGauntletPhase('Starting generation...');
    setGauntletProgress(0);
    setGauntletReport(null);
    gauntletStartRef.current = Date.now();
    gauntletSSEActive.current = true;

    const { abort, done } = api.runGauntletTest(projectId, { dry_run: dryRun, angle: selectedAngle || null, variant_count: variantCount > 1 ? variantCount : undefined }, (event) => {
      if (event.type === 'progress') {
        setGauntletPhase(event.message || '');
        // Map gauntlet steps to progress: each frame is ~20% of total
        if (event.gauntlet?.frame && event.gauntlet?.total) {
          const frameBase = ((event.gauntlet.frame - 1) / event.gauntlet.total) * 100;
          const frameChunk = 100 / event.gauntlet.total;
          // Sub-steps within a frame
          const subSteps = {
            'gauntlet_frame_start': 0, 'gauntlet_images': 0.1, 'gauntlet_prescore': 0.3,
            'gauntlet_generate': 0.5, 'gauntlet_scoring': 0.8, 'gauntlet_publishing': 0.9,
            'gauntlet_frame_done': 1,
          };
          const sub = subSteps[event.step] ?? 0.5;
          setGauntletProgress(prev => Math.max(prev, Math.round(frameBase + sub * frameChunk)));
        }
        if (event.step === 'gauntlet_complete') setGauntletProgress(100);
      } else if (event.type === 'complete') {
        gauntletSSEActive.current = false;
        setGauntletProgress(100);
        setGauntletReport(event.report);
        setTimeout(() => {
          setGauntletRunning(false);
          setGauntletPhase('');
          gauntletStartRef.current = null;
          const r = event.report?.summary;
          toast.success(`Generation complete: ${r?.passed || 0}/${r?.total || 5} passed, avg ${r?.avgScore || 0}/11`);
          refreshRecentGenerations();
        }, 500);
      } else if (event.type === 'error') {
        gauntletSSEActive.current = false;
        setGauntletRunning(false);
        setGauntletPhase('');
        setGauntletProgress(0);
        gauntletStartRef.current = null;
        toast.error(event.message || 'Generation failed');
      }
    });

    gauntletAbortRef.current = abort;
    done.catch((err) => {
      gauntletSSEActive.current = false;
      if (err.name !== 'AbortError') {
        setGauntletRunning(false);
        setGauntletPhase('');
        setGauntletProgress(0);
        gauntletStartRef.current = null;
        toast.error(err.message || 'Generation failed');
      }
    });
  };

  useEffect(() => {
    if (!projectId) return;
    if (gauntletRunning) return;
    if (activeDryRun) {
      if (dryRunSSEActiveRef.current) return;
      return;
    }
    const nextQueued = dryRunQueue.find(item => item.status === 'queued');
    if (!nextQueued) return;

    dryRunSSEActiveRef.current = true;
    setDryRunQueue(prev => prev.map(item => item.id === nextQueued.id ? {
      ...item,
      status: 'running',
      startTime: Date.now(),
      phase: 'Starting dry run...',
      progress: 0,
      sseConnected: true,
    } : item));

    const { abort, done } = api.runGauntletTest(projectId, {
      dry_run: true,
      angle: nextQueued.angle || null,
      frame_ids: nextQueued.frameIds,
    }, (event) => {
      if (event.type === 'progress') {
        const updates = { phase: event.message || event.step || 'Running...', sseConnected: true };
        if (event.gauntlet?.frame && event.gauntlet?.total) {
          const frameBase = ((event.gauntlet.frame - 1) / event.gauntlet.total) * 100;
          const frameChunk = 100 / event.gauntlet.total;
          const subSteps = {
            gauntlet_frame_start: 0,
            gauntlet_images: 0.1,
            gauntlet_prescore: 0.3,
            gauntlet_generate: 0.5,
            gauntlet_scoring: 0.8,
            gauntlet_publishing: 0.9,
            gauntlet_frame_done: 1,
          };
          const sub = subSteps[event.step] ?? 0.5;
          updates.progress = Math.round(frameBase + sub * frameChunk);
        } else if (event.step === 'gauntlet_complete') {
          updates.progress = 100;
        }
        setDryRunQueue(prev => prev.map(item => item.id === nextQueued.id ? {
          ...item,
          ...updates,
          progress: Math.max(item.progress || 0, updates.progress ?? item.progress ?? 0),
        } : item));
      } else if (event.type === 'complete') {
        dryRunSSEActiveRef.current = false;
        dryRunAbortRef.current = null;
        const summaryText = buildQueueSummary(event.report);
        setDryRunQueue(prev => prev.map(item => item.id === nextQueued.id ? {
          ...item,
          status: 'complete',
          progress: 100,
          phase: summaryText,
          result: event.report,
          sseConnected: false,
          finishedAt: Date.now(),
        } : item));
        refreshRecentGenerations();
      } else if (event.type === 'error') {
        dryRunSSEActiveRef.current = false;
        dryRunAbortRef.current = null;
        setDryRunQueue(prev => prev.map(item => item.id === nextQueued.id ? {
          ...item,
          status: 'error',
          progress: 0,
          phase: event.message || 'Dry run failed',
          result: { error: event.message || 'Dry run failed' },
          sseConnected: false,
          finishedAt: Date.now(),
        } : item));
      }
    });

    dryRunAbortRef.current = abort;
    done.catch((err) => {
      dryRunSSEActiveRef.current = false;
      dryRunAbortRef.current = null;
      if (err.name === 'AbortError') {
        setDryRunQueue(prev => prev.map(item => item.id === nextQueued.id ? {
          ...item,
          status: 'cancelled',
          progress: item.progress || 0,
          phase: 'Dry run cancelled locally',
          sseConnected: false,
          finishedAt: Date.now(),
        } : item));
        return;
      }
      setDryRunQueue(prev => prev.map(item => item.id === nextQueued.id ? {
        ...item,
        status: 'error',
        progress: 0,
        phase: err.message || 'Dry run failed',
        result: { error: err.message || 'Dry run failed' },
        sseConnected: false,
        finishedAt: Date.now(),
      } : item));
    });
  }, [activeDryRun, dryRunQueue, gauntletRunning, projectId, refreshRecentGenerations]);

  // Determine agent status label
  const hasShopify = shopifyStatus?.connected;
  const safeTemplates = ensureArray(templates, 'LPAgentSettings.templatesState');
  const safeConductorAngles = ensureArray(conductorAngles, 'LPAgentSettings.conductorAnglesState');
  const safeRecentGenerations = ensureArray(recentGenerations, 'LPAgentSettings.recentGenerationsState');
  const hasTemplates = safeTemplates.filter(t => t.status === 'ready').length > 0;
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

        {/* LP Default Mode */}
        {config?.enabled && (
          <div className="flex items-center justify-between mt-4 pt-4 border-t border-black/5">
            <div>
              <p className="text-[13px] font-medium text-textdark">LP Default Mode</p>
              <p className="text-[11px] text-textlight">
                {config?.lp_default_mode === 'all'
                  ? 'All angles generate LPs unless disabled per-angle'
                  : 'No angles generate LPs unless enabled per-angle'}
              </p>
            </div>
            <button
              onClick={() => handleSaveConfig({ lp_default_mode: config?.lp_default_mode === 'all' ? 'opt_in' : 'all' })}
              className={`text-[11px] font-medium px-3 py-1.5 rounded-lg transition-colors ${
                config?.lp_default_mode === 'all'
                  ? 'bg-teal/10 text-teal'
                  : 'bg-navy/10 text-navy'
              }`}
            >
              {config?.lp_default_mode === 'all' ? 'All Angles' : 'Opt-in Only'}
            </button>
          </div>
        )}
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
        <div className="mt-3">
          <label className="text-[11px] text-textmid font-medium block mb-1">Canonical Page URL (benchmark)</label>
          <input
            type="text"
            placeholder="https://example.com/your-best-landing-page"
            value={config?.canonical_page_url || ''}
            onChange={e => handleSaveConfig({ canonical_page_url: e.target.value })}
            className="input-apple w-full text-[12px]"
          />
          <p className="text-[9px] text-textlight mt-0.5">Optional. Before publishing, generated LPs will be compared against this page for structural pattern match (1-5 score). Low scores warn but don't block.</p>
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
          <p className="text-[9px] text-textlight">
            Author names are auto-generated to match the target demographic from Foundational Docs.
          </p>
          <div>
            <label className="text-[11px] text-textmid font-medium mb-1 block">Warning/Disclaimer Text</label>
            <textarea
              placeholder="This article is based on scientific research and expert opinions. Individual results may vary..."
              value={config?.default_warning_text || ''}
              onChange={e => handleSaveConfig({ default_warning_text: e.target.value })}
              className="input-apple w-full text-[12px]"
              rows={2}
            />
            <p className="text-[9px] text-textlight mt-1">
              Populates the warning/disclaimer box on generated pages. Leave blank for default.
            </p>
          </div>
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

        <div className="space-y-3">
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

            {/* Visual QA toggle */}
            <div className="flex items-center justify-between">
              <div>
                <p className="text-[12px] font-medium text-textdark">Visual QA + Auto-Fix</p>
                <p className="text-[10px] text-textlight">Screenshot-based QA with automatic fix loop (contrast, images, layout, placeholders)</p>
              </div>
              <button
                onClick={() => handleSaveConfig({ visual_qa_enabled: config?.visual_qa_enabled === false ? true : false })}
                className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                  config?.visual_qa_enabled !== false ? 'bg-navy' : 'bg-gray-200'
                }`}
              >
                <span className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                  config?.visual_qa_enabled !== false ? 'translate-x-4' : 'translate-x-0'
                }`} />
              </button>
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

      {/* ── 6. Batch Generation ── */}
      <div className="card p-5">
        <h3 className="text-[13px] font-semibold text-textdark mb-3 flex items-center gap-2">
          <svg className="w-4 h-4 text-gold" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
          </svg>
          Batch Generation
        </h3>

        <div className="space-y-3">
          {/* Narrative frame checkboxes */}
          <div>
            <label className="text-[11px] text-textmid font-medium block mb-2">Narrative Frames</label>
            <div className="space-y-1.5">
              {NARRATIVE_FRAMES.map(f => {
                const checked = enabledFrames.includes(f.id);
                return (
                  <label key={f.id} className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => {
                        const next = checked
                          ? enabledFrames.filter(id => id !== f.id)
                          : [...enabledFrames, f.id];
                        if (next.length === 0) return; // at least 1 required
                        handleSaveConfig({ default_narrative_frames: JSON.stringify(next) });
                      }}
                      className="w-3.5 h-3.5 rounded border-gray-300 text-navy focus:ring-navy/50 cursor-pointer"
                    />
                    <span className="text-[12px] text-textdark">{f.name}</span>
                  </label>
                );
              })}
            </div>
            <p className="text-[9px] text-textlight mt-1.5">
              {enabledFrames.length} frame{enabledFrames.length !== 1 ? 's' : ''} selected — will generate {enabledFrames.length} LP{enabledFrames.length !== 1 ? 's' : ''} per batch
            </p>
          </div>

          {/* Quality settings */}
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="text-[10px] text-textmid">Score threshold</label>
              <input
                type="number"
                min={0} max={11} step={0.5}
                value={config?.gauntlet_score_threshold ?? 7}
                onChange={e => handleSaveConfig({ gauntlet_score_threshold: parseFloat(e.target.value) || 7 })}
                className="input-apple text-[12px] w-full"
              />
            </div>
            <div>
              <label className="text-[10px] text-textmid">Max image retries</label>
              <input
                type="number"
                min={0} max={10}
                value={config?.gauntlet_max_image_retries ?? 5}
                onChange={e => handleSaveConfig({ gauntlet_max_image_retries: parseInt(e.target.value) || 5 })}
                className="input-apple text-[12px] w-full"
              />
            </div>
            <div>
              <label className="text-[10px] text-textmid">Max LP retries</label>
              <input
                type="number"
                min={0} max={5}
                value={config?.gauntlet_max_lp_retries ?? 2}
                onChange={e => handleSaveConfig({ gauntlet_max_lp_retries: parseInt(e.target.value) || 2 })}
                className="input-apple text-[12px] w-full"
              />
            </div>
          </div>

          {/* Word count settings */}
          <div className="pt-2 border-t border-black/5">
            <label className="text-[11px] text-textmid font-medium block mb-2">Word Count</label>
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <span className="text-[11px] text-textdark w-28">Default</span>
                <input
                  type="number"
                  min={300} max={5000} step={100}
                  value={config?.default_word_count ?? ''}
                  onChange={e => {
                    const raw = e.target.value.trim();
                    handleSaveConfig({ default_word_count: raw ? parseInt(raw, 10) : null });
                  }}
                  className="input-apple text-[12px] w-24"
                  placeholder="None"
                />
                <span className="text-[10px] text-textlight">words</span>
              </div>
              {enabledFrames.map(frameId => {
                const frame = NARRATIVE_FRAMES.find(f => f.id === frameId);
                if (!frame) return null;
                const frameWordCounts = (() => { try { return JSON.parse(config?.frame_word_counts || '{}'); } catch { return {}; } })();
                const hasOverride = frameWordCounts[frameId] != null;
                return (
                  <div key={frameId} className="flex items-center gap-3">
                    <span className="text-[11px] text-textdark w-28 truncate" title={frame.name}>{frame.name}</span>
                    {hasOverride ? (
                      <>
                        <input
                          type="number"
                          min={300} max={5000} step={100}
                          value={frameWordCounts[frameId]}
                          onChange={e => {
                            const raw = e.target.value.trim();
                            const updated = { ...frameWordCounts };
                            if (raw) updated[frameId] = parseInt(raw, 10);
                            else delete updated[frameId];
                            handleSaveConfig({ frame_word_counts: JSON.stringify(updated) });
                          }}
                          className="input-apple text-[12px] w-24"
                          placeholder="None"
                        />
                        <button
                          onClick={() => {
                            const updated = { ...frameWordCounts };
                            delete updated[frameId];
                            handleSaveConfig({ frame_word_counts: JSON.stringify(updated) });
                          }}
                          className="text-[10px] text-textlight hover:text-red-400 transition-colors"
                          title="Remove override"
                        >✕</button>
                      </>
                    ) : (
                      <button
                        onClick={() => {
                          const updated = { ...frameWordCounts, [frameId]: '' };
                          handleSaveConfig({ frame_word_counts: JSON.stringify(updated) });
                        }}
                        className="text-[10px] text-navy hover:text-navy/70 transition-colors"
                      >+ Override</button>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="text-[9px] text-textlight mt-1.5">
              Leave blank for no target. Frame-specific overrides take priority over the optional global default.
            </p>
          </div>

          {/* Angle selector + Run buttons */}
          <div className="flex items-center gap-2">
            <select
              value={selectedAngle}
              onChange={(e) => setSelectedAngle(e.target.value)}
              disabled={gauntletRunning}
              className="input-apple text-[12px] py-1.5 px-2 flex-1 min-w-0 disabled:opacity-50"
            >
              <option value="">No angle</option>
              {safeConductorAngles.filter(a => a.status === 'active').map(a => (
                <option key={a.id || a.externalId || a.name} value={a.name}>{a.name}</option>
              ))}
            </select>
            <select
              value={variantCount}
              onChange={(e) => setVariantCount(Number(e.target.value))}
              disabled={gauntletRunning}
              className="input-apple text-[12px] py-1.5 px-2 w-20 disabled:opacity-50"
              title="Variants per frame (1 = default, 2-5 = multi-variant mode, no auto-publish)"
            >
              <option value={1}>1 var</option>
              <option value={2}>2 var</option>
              <option value={3}>3 var</option>
              <option value={4}>4 var</option>
              <option value={5}>5 var</option>
            </select>
            <button
              onClick={handleQueueDryRun}
              disabled={gauntletRunning}
              className="btn-secondary text-[12px] whitespace-nowrap disabled:opacity-50"
            >
              {activeDryRun ? `Running (${queuedDryRuns.length} queued)` : queuedDryRuns.length > 0 ? `Queue Dry Run (${queuedDryRuns.length} queued)` : 'Queue Dry Run'}
            </button>
            <button
              onClick={() => handleRunGauntlet(false)}
              disabled={gauntletRunning || hasQueuedOrRunningDryRun}
              className="btn-primary text-[12px] whitespace-nowrap disabled:opacity-50"
            >
              {gauntletRunning ? 'Running...' : 'Run & Publish'}
            </button>
          </div>

          {activeDryRun && (
            <PipelineProgress
              progress={activeDryRun.progress}
              message={activeDryRun.phase}
              startTime={activeDryRun.startTime}
              className="mt-1"
            />
          )}

          {queuedDryRuns.length > 0 && (
            <div className="flex items-center gap-2">
              <p className="text-[10px] text-textlight">
                {queuedDryRuns.length} dry run{queuedDryRuns.length !== 1 ? 's' : ''} queued
              </p>
              <button
                onClick={handleClearQueuedDryRuns}
                className="text-[10px] text-textlight hover:text-red-500 transition-colors"
              >
                Clear queue
              </button>
            </div>
          )}

          {/* Progress — only show gauntlet bar when no dry-run bar is already visible */}
          {gauntletRunning && !activeDryRun && (
            <PipelineProgress
              progress={gauntletProgress}
              message={gauntletPhase}
              startTime={gauntletStartRef.current}
              className="mt-1"
            />
          )}

          {(activeDryRun || dryRunQueue.length > 0) && (
            <div className="space-y-2">
              {dryRunQueue.map((item) => {
                const isQueued = item.status === 'queued';
                const isRunning = item.status === 'running';
                const isComplete = item.status === 'complete';
                const isError = item.status === 'error' || item.status === 'cancelled';
                const summary = item.result?.summary;
                const label = item.angle || 'No angle';
                const frameCount = item.frameIds?.length || 0;

                return (
                  <div key={item.id} className="rounded-lg border border-black/5 bg-black/[0.02] px-3 py-2">
                    <div className="flex items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-[11px] font-medium text-textdark truncate">{label}</p>
                          <span className="text-[9px] text-textlight">{frameCount} frame{frameCount !== 1 ? 's' : ''}</span>
                          <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded-full ${
                            isQueued ? 'bg-black/5 text-textmid' :
                            isRunning ? 'bg-gold/10 text-gold' :
                            isComplete ? 'bg-teal/10 text-teal' :
                            'bg-red-50 text-red-600'
                          }`}>
                            {isQueued ? 'Queued' : isRunning ? 'Running' : isComplete ? 'Complete' : item.status === 'cancelled' ? 'Cancelled' : 'Failed'}
                          </span>
                        </div>
                        <p className="text-[10px] text-textmid mt-1">{item.phase || 'Queued'}</p>
                        {(isRunning || isComplete) && (
                          <p className="text-[9px] text-textlight mt-1">
                            {item.progress != null ? `${item.progress}%` : '—'}
                            {summary ? ` · ${summary.passed || 0}/${summary.total || 0} passed` : ''}
                          </p>
                        )}
                      </div>
                      {isQueued && (
                        <button
                          onClick={() => handleRemoveQueuedDryRun(item.id)}
                          className="text-[10px] text-textlight hover:text-red-500 transition-colors"
                        >
                          Remove
                        </button>
                      )}
                      {(isComplete || isError) && (
                        <button
                          onClick={() => handleDismissDryRun(item.id)}
                          className="text-[10px] text-textlight hover:text-red-500 transition-colors"
                        >
                          Dismiss
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Report */}
          {gauntletReport && !gauntletRunning && (
            <div className="bg-navy/5 rounded-lg p-3 space-y-2">
              <div className="flex items-center gap-3 text-[12px]">
                <span className="font-medium text-textdark">
                  {gauntletReport.summary?.passed}/{gauntletReport.summary?.total} passed
                </span>
                <span className="text-textmid">
                  Avg score: {gauntletReport.summary?.avgScore}/11
                </span>
                <span className="text-textmid">
                  {gauntletReport.summary?.totalDurationMin}m
                </span>
              </div>
              {gauntletReport.frames?.map((f, i) => (
                <div key={i} className="flex items-center gap-2 text-[11px]">
                  <span className={`w-2 h-2 rounded-full ${f.status === 'published' || f.status === 'passed' || f.status === 'passed_dry_run' ? 'bg-teal' : f.status === 'failed' ? 'bg-red-400' : 'bg-gold'}`} />
                  <span className="text-textdark font-medium w-40 truncate">{f.frameName}</span>
                  <span className="text-textmid">{f.score != null ? `${f.score}/11` : '—'}</span>
                  <span className="text-textlight">{f.status}</span>
                  {f.publishedUrl && (
                    <a href={f.publishedUrl} target="_blank" rel="noopener noreferrer" className="text-gold hover:underline ml-auto">View</a>
                  )}
                </div>
              ))}
            </div>
          )}

          <p className="text-[10px] text-textlight">
            Generate {enabledFrames.length} LP{enabledFrames.length !== 1 ? 's' : ''} with image pre-scoring, template caching, and quality scoring. Dry run generates and scores without publishing.
          </p>
        </div>
      </div>

      {/* ── 7. Recent Generations ── */}
      <div className="card p-5">
        <h3 className="text-[13px] font-semibold text-textdark mb-3 flex items-center gap-2">
          <svg className="w-4 h-4 text-textmid" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          Recent Generations
        </h3>

        {safeRecentGenerations.length === 0 ? (
          <p className="text-[12px] text-textmid text-center py-3">No test generations yet.</p>
        ) : (
          <div className="space-y-2">
            {(() => {
              // Group pages into batches and singles
              const batchMap = {};
              const singles = [];
              for (const lp of safeRecentGenerations) {
                if (lp.gauntlet_batch_id) {
                  if (!batchMap[lp.gauntlet_batch_id]) batchMap[lp.gauntlet_batch_id] = [];
                  batchMap[lp.gauntlet_batch_id].push(lp);
                } else {
                  singles.push(lp);
                }
              }
              // Convert batches to array sorted by earliest created_at desc
              const batches = Object.entries(batchMap).map(([batchId, batchPages]) => ({
                batchId,
                pages: batchPages.sort((a, b) => new Date(a.created_at) - new Date(b.created_at)),
                sortDate: Math.min(...batchPages.map(p => new Date(p.created_at).getTime())),
              })).sort((a, b) => b.sortDate - a.sortDate);

              // Interleave batches and singles by date
              const items = [];
              for (const batch of batches) items.push({ type: 'batch', ...batch });
              for (const page of singles) items.push({ type: 'single', page, sortDate: new Date(page.created_at).getTime() });
              items.sort((a, b) => b.sortDate - a.sortDate);

              return items.map(item => {
                if (item.type === 'batch') {
                  const { batchId, pages: batchPages } = item;
                  const expanded = expandedBatches[batchId];
                  const passedCount = batchPages.filter(p => p.gauntlet_status === 'passed' || p.gauntlet_status === 'published').length;
                  const scores = batchPages.filter(p => p.gauntlet_score != null).map(p => p.gauntlet_score);
                  const avgScore = scores.length > 0 ? Math.round(scores.reduce((s, v) => s + v, 0) / scores.length * 10) / 10 : null;
                  const angleName = batchPages[0]?.angle;

                  // Duration from batch timestamps
                  const startedAt = batchPages[0]?.gauntlet_batch_started_at;
                  const completedAt = batchPages[0]?.gauntlet_batch_completed_at;
                  let durationStr = '';
                  let timeRange = '';
                  if (startedAt) {
                    const startDate = new Date(startedAt);
                    timeRange = startDate.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
                    if (completedAt) {
                      const endDate = new Date(completedAt);
                      const diffMin = Math.round((endDate - startDate) / 60000);
                      durationStr = diffMin >= 60 ? `${Math.floor(diffMin / 60)}h ${diffMin % 60}m` : `${diffMin}m`;
                    }
                  } else {
                    const d = new Date(batchPages[0].created_at);
                    timeRange = d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
                  }

                  const allDone = batchPages.every(p => p.status !== 'generating');

                  return (
                    <div key={batchId} className="space-y-0">
                      {/* Batch header */}
                      <div
                        className="bg-offwhite rounded-lg px-3 py-2.5 cursor-pointer hover:bg-navy/5 transition-colors"
                        onClick={() => setExpandedBatches(prev => ({ ...prev, [batchId]: !prev[batchId] }))}
                      >
                        <div className="flex items-center gap-2">
                          <svg className={`w-3 h-3 text-textmid flex-shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                          </svg>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-[12px] font-medium text-textdark">
                                LP Batch{angleName && angleName.length < 80 ? <> — <span className="text-navy">{angleName}</span></> : ''} — {batchPages.length} LP{batchPages.length !== 1 ? 's' : ''}
                              </span>
                              {durationStr && <span className="text-[10px] text-textlight">{durationStr}</span>}
                              {!allDone && (
                                <span className="text-[9px] font-medium px-1.5 py-0.5 rounded-full bg-navy/10 text-navy animate-pulse">Generating...</span>
                              )}
                            </div>
                            <div className="flex items-center gap-3 mt-0.5">
                              <span className="text-[10px] text-textlight">{timeRange}</span>
                              {allDone && (
                                <>
                                  <span className="text-[10px] text-textmid">
                                    Passed: <span className={passedCount === batchPages.length ? 'text-teal' : 'text-textdark'}>{passedCount}/{batchPages.length}</span>
                                  </span>
                                  {avgScore != null && (
                                    <span className="text-[10px] text-textmid">
                                      Avg: <span className={avgScore >= 6 ? 'text-teal' : 'text-gold'}>{avgScore}</span>
                                    </span>
                                  )}
                                </>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Expanded sub-rows */}
                      {expanded && (
                        <div className="ml-5 border-l-2 border-navy/10 space-y-1 py-1">
                          {batchPages.map(lp => {
                            const frameName = FRAME_LABELS[lp.gauntlet_frame] || lp.gauntlet_frame || lp.narrative_frame || '';
                            const isPublished = lp.status === 'published';
                            const isFailed = lp.status === 'failed' || lp.status === 'error';
                            const isGenerating = lp.status === 'generating';

                            let statusBg = 'bg-navy/10 text-navy';
                            let statusText = 'Draft';
                            if (isGenerating) { statusBg = 'bg-gold/10 text-gold'; statusText = 'Generating'; }
                            if (isPublished) { statusBg = 'bg-teal/10 text-teal'; statusText = 'Published'; }
                            if (isFailed) { statusBg = 'bg-red-50 text-red-600'; statusText = 'Failed'; }

                            return (
                              <div
                                key={lp.id}
                                className="ml-2 bg-offwhite rounded-lg px-3 py-2 cursor-pointer hover:bg-navy/5 transition-colors"
                                onClick={() => navigate(`/projects/${projectId}?tab=lpgen&lp=${lp.id}`)}
                              >
                                <div className="flex items-center gap-2">
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                      <span className="text-[11px] font-medium text-textdark truncate">
                                        {frameName || lp.name}{lp.angle && lp.angle.length < 80 ? <span className="text-textmid font-normal"> - {lp.angle}</span> : ''}
                                      </span>
                                      {lp.gauntlet_score != null && (
                                        <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded-full ${lp.gauntlet_score >= 7 ? 'bg-teal/10 text-teal' : 'bg-gold/10 text-gold'}`}>
                                          {lp.gauntlet_score}/11
                                        </span>
                                      )}
                                      <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded-full ${statusBg}`}>
                                        {statusText}
                                      </span>
                                      {!isPublished && !isGenerating && !isFailed && (
                                        <button
                                          onClick={(e) => handlePublishLP(e, lp.id)}
                                          disabled={publishingLPId === lp.id}
                                          className="text-[9px] font-medium px-1.5 py-0.5 rounded-full bg-teal/10 text-teal hover:bg-teal/20 transition-colors disabled:opacity-50"
                                        >
                                          {publishingLPId === lp.id ? 'Publishing...' : 'Publish'}
                                        </button>
                                      )}
                                      {(lp.gauntlet_status === 'passed' || lp.gauntlet_status === 'published') && (
                                        <span className="text-teal text-[10px]">✓</span>
                                      )}
                                      {lp.gauntlet_status === 'failed' && (
                                        <span className="text-red-500 text-[10px]">✗</span>
                                      )}
                                      {lp.qa_status === 'passed' && (
                                        <span className="text-[9px] font-medium px-1.5 py-0.5 rounded-full bg-teal/10 text-teal">QA ✓</span>
                                      )}
                                      {lp.smoke_test_status === 'passed' && (
                                        <span className="text-[9px] font-medium px-1.5 py-0.5 rounded-full bg-teal/10 text-teal">Smoke ✓</span>
                                      )}
                                    </div>
                                    {isPublished && lp.published_url && (
                                      <span
                                        className="text-[9px] font-mono text-gold hover:text-gold/80 truncate block mt-0.5 max-w-[280px]"
                                        onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(lp.published_url); toast.success('URL copied'); }}
                                        title="Click to copy URL"
                                      >
                                        {lp.published_url}
                                      </span>
                                    )}
                                  </div>
                                  <svg className="w-3 h-3 text-textlight flex-shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                                  </svg>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                }

                // Single LP (not in a batch)
                const lp = item.page;
                const isGenerating = lp.status === 'generating';
                const isPublished = lp.status === 'published';
                const isFailed = lp.status === 'failed' || lp.status === 'error';

                let badgeClass = 'bg-navy/10 text-navy';
                let badgeText = 'Draft';
                if (isGenerating) { badgeClass = 'bg-gold/10 text-gold'; badgeText = 'Generating'; }
                if (isPublished) { badgeClass = 'bg-teal/10 text-teal'; badgeText = 'Published'; }
                if (isFailed) { badgeClass = 'bg-red-50 text-red-600'; badgeText = 'Failed'; }

                const createdAt = lp.created_at ? new Date(lp.created_at) : null;
                const timestamp = createdAt ? createdAt.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';

                return (
                  <div
                    key={lp.id}
                    className="bg-offwhite rounded-lg px-3 py-2 cursor-pointer hover:bg-navy/5 transition-colors"
                    onClick={() => navigate(`/projects/${projectId}?tab=lpgen&lp=${lp.id}`)}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <span className="text-[11px] text-textdark truncate">{lp.name}</span>
                        {lp.angle && <span className="text-[9px] text-navy font-medium flex-shrink-0">{lp.angle}</span>}
                        <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded-full flex-shrink-0 ${badgeClass}`}>{badgeText}</span>
                        {!isPublished && !isGenerating && !isFailed && (
                          <button
                            onClick={(e) => handlePublishLP(e, lp.id)}
                            disabled={publishingLPId === lp.id}
                            className="text-[9px] font-medium px-1.5 py-0.5 rounded-full bg-teal/10 text-teal hover:bg-teal/20 transition-colors flex-shrink-0 disabled:opacity-50"
                          >
                            {publishingLPId === lp.id ? 'Publishing...' : 'Publish'}
                          </button>
                        )}
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                        {timestamp && <span className="text-[9px] text-textlight">{timestamp}</span>}
                        <svg className="w-3 h-3 text-textlight" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                        </svg>
                      </div>
                    </div>
                    {isPublished && lp.published_url && (
                      <span
                        className="text-[9px] font-mono text-gold hover:text-gold/80 truncate block mt-0.5 max-w-[280px] ml-1"
                        onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(lp.published_url); toast.success('URL copied'); }}
                        title="Click to copy URL"
                      >
                        {lp.published_url}
                      </span>
                    )}
                  </div>
                );
              });
            })()}
          </div>
        )}
      </div>
    </div>
  );
}

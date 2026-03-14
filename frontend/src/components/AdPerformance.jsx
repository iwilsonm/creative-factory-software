import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../api';
import PipelineProgress from './PipelineProgress';
import { useToast } from './Toast';

const SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'angles', label: 'Angle Analysis' },
  { id: 'lp', label: 'LP Diagnostics' },
  { id: 'history', label: 'History' },
  { id: 'agent', label: 'CMO Agent' },
];

const TIER_COLORS = {
  T1: { bg: 'bg-teal/10', text: 'text-teal', label: 'T1 — Profitable' },
  T2: { bg: 'bg-gold/10', text: 'text-gold', label: 'T2 — Signal' },
  T3: { bg: 'bg-red-50', text: 'text-red-600', label: 'T3 — No Conversions' },
  T4: { bg: 'bg-red-100', text: 'text-red-700', label: 'T4 — No Spend' },
  too_early: { bg: 'bg-navy/5', text: 'text-textmid', label: 'Too Early' },
};

const SPEND_COLORS = {
  STRONG: 'text-teal',
  MODERATE: 'text-navy',
  WEAK: 'text-gold',
  NEGLIGIBLE: 'text-textmid',
  ZERO: 'text-textlight',
};

const SEVERITY_COLORS = {
  critical: 'bg-red-50 border-red-200 text-red-700',
  warning: 'bg-gold/10 border-gold/30 text-gold',
  info: 'bg-navy/5 border-navy/15 text-navy',
};

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ── SSE Progress Map ─────────────────────────────────────────────────────────

const STEP_PROGRESS = {
  triple_whale: 5,
  meta_data: 20,
  evaluate_angles: 40,
  lp_diagnostic: 55,
  update_ledger: 70,
  decision_rules: 80,
  execute_changes: 90,
  notifications: 95,
};

// ── Main Component ───────────────────────────────────────────────────────────

export default function AdPerformance({ projectId, project }) {
  const [section, setSection] = useState('overview');
  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(true);
  const toast = useToast();

  const loadDashboard = useCallback(async () => {
    try {
      const data = await api.getCmoDashboard(projectId);
      setDashboard(data);
    } catch (err) {
      console.error('Failed to load CMO dashboard:', err);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadDashboard();
  }, [loadDashboard]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="text-textmid text-sm">Loading performance data...</div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Section Switcher */}
      <div className="segmented-control">
        {SECTIONS.map(s => (
          <button
            key={s.id}
            className={section === s.id ? 'active' : ''}
            onClick={() => setSection(s.id)}
          >
            {s.label}
          </button>
        ))}
      </div>

      {section === 'overview' && (
        <OverviewSection dashboard={dashboard} onRefresh={loadDashboard} />
      )}
      {section === 'angles' && (
        <AngleAnalysisSection dashboard={dashboard} projectId={projectId} />
      )}
      {section === 'lp' && (
        <LPDiagnosticsSection dashboard={dashboard} />
      )}
      {section === 'history' && (
        <HistorySection projectId={projectId} />
      )}
      {section === 'agent' && (
        <AgentSection projectId={projectId} dashboard={dashboard} onRefresh={loadDashboard} />
      )}
    </div>
  );
}

// ── Overview Section ─────────────────────────────────────────────────────────

function OverviewSection({ dashboard, onRefresh }) {
  if (!dashboard) {
    return <EmptyState message="No data yet. Configure and run the CMO Agent to see performance data." />;
  }

  const { tierBreakdown, totalSpend, totalConversions, overallCpa, overallRoas, twSummary, recentNotifications, latestRun } = dashboard;

  return (
    <div className="space-y-4">
      {/* Notification Banner */}
      {recentNotifications && recentNotifications.length > 0 && (
        <div className="space-y-2">
          {recentNotifications.slice(0, 3).map((n, i) => (
            <div key={i} className={`px-3 py-2 rounded-lg border text-xs ${SEVERITY_COLORS[n.severity] || SEVERITY_COLORS.info}`}>
              <span className="font-semibold">{n.title}</span> — {n.message}
            </div>
          ))}
        </div>
      )}

      {/* Metric Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <MetricCard label="Total Spend" value={totalSpend != null ? `$${totalSpend.toLocaleString()}` : '—'} />
        <MetricCard label="Conversions" value={totalConversions != null ? totalConversions.toLocaleString() : '—'} />
        <MetricCard label="CPA" value={overallCpa != null ? `$${overallCpa.toFixed(2)}` : '—'} />
        <MetricCard label="ROAS" value={overallRoas != null ? `${overallRoas.toFixed(1)}x` : '—'} />
      </div>

      {/* Triple Whale Blended Metrics */}
      {twSummary && Array.isArray(twSummary) && twSummary.length > 0 && (
        <div className="card p-4">
          <h3 className="text-sm font-semibold text-textdark mb-3">Blended Metrics (Triple Whale)</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {twSummary.map((period, i) => (
              <div key={i} className="bg-offwhite rounded-lg p-3">
                <div className="text-[10px] text-textlight uppercase tracking-wide mb-2">
                  {period.period || `Period ${i + 1}`}
                </div>
                <div className="space-y-1 text-xs">
                  {period.revenue != null && <div className="flex justify-between"><span className="text-textmid">Revenue</span><span className="font-medium text-textdark">${Number(period.revenue).toLocaleString()}</span></div>}
                  {period.roas != null && <div className="flex justify-between"><span className="text-textmid">ROAS</span><span className="font-medium text-textdark">{Number(period.roas).toFixed(1)}x</span></div>}
                  {period.cpa != null && <div className="flex justify-between"><span className="text-textmid">CPA</span><span className="font-medium text-textdark">${Number(period.cpa).toFixed(2)}</span></div>}
                  {period.orders != null && <div className="flex justify-between"><span className="text-textmid">Orders</span><span className="font-medium text-textdark">{period.orders}</span></div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tier Breakdown */}
      {tierBreakdown && (
        <div className="card p-4">
          <h3 className="text-sm font-semibold text-textdark mb-3">Angle Tier Breakdown</h3>
          <div className="grid grid-cols-5 gap-2">
            {Object.entries(TIER_COLORS).map(([tier, style]) => (
              <div key={tier} className={`${style.bg} rounded-lg p-3 text-center`}>
                <div className={`text-2xl font-bold ${style.text}`}>
                  {tierBreakdown[tier] || 0}
                </div>
                <div className="text-[10px] text-textmid mt-1">{style.label}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Last Run Info */}
      {latestRun && (
        <div className="card p-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-textdark">Last Run</h3>
              <div className="text-xs text-textmid mt-1">
                {latestRun.run_type} — {latestRun.status} — {new Date(latestRun.run_at).toLocaleString()}
                {latestRun.duration_ms && ` (${(latestRun.duration_ms / 1000).toFixed(0)}s)`}
              </div>
            </div>
            <button onClick={onRefresh} className="btn-secondary text-xs px-3 py-1.5">
              Refresh
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Angle Analysis Section ────────────────────────────────────────────────────

function AngleAnalysisSection({ dashboard, projectId }) {
  const [sortBy, setSortBy] = useState('tier');
  const [sortDir, setSortDir] = useState('asc');
  const [expandedAngle, setExpandedAngle] = useState(null);

  const evaluations = dashboard?.angleEvaluations || [];

  const sorted = [...evaluations].sort((a, b) => {
    const tierOrder = { T1: 0, T2: 1, too_early: 2, T3: 3, T4: 4 };
    let cmp = 0;
    if (sortBy === 'tier') {
      cmp = (tierOrder[a.tier] ?? 5) - (tierOrder[b.tier] ?? 5);
    } else if (sortBy === 'spend') {
      cmp = b.spend - a.spend;
    } else if (sortBy === 'cpa') {
      cmp = (a.cpa ?? Infinity) - (b.cpa ?? Infinity);
    } else if (sortBy === 'roas') {
      cmp = (b.roas ?? 0) - (a.roas ?? 0);
    } else if (sortBy === 'ctr') {
      cmp = b.ctr - a.ctr;
    }
    return sortDir === 'desc' ? -cmp : cmp;
  });

  const handleSort = (col) => {
    if (sortBy === col) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(col);
      setSortDir('asc');
    }
  };

  if (evaluations.length === 0) {
    return <EmptyState message="No angle evaluation data. Run a CMO review first." />;
  }

  const SortHeader = ({ col, children }) => (
    <th
      className="text-left text-[10px] text-textmid uppercase tracking-wide py-2 px-2 cursor-pointer hover:text-navy select-none"
      onClick={() => handleSort(col)}
    >
      {children} {sortBy === col && (sortDir === 'asc' ? '↑' : '↓')}
    </th>
  );

  return (
    <div className="card overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-black/5">
            <th className="text-left text-[10px] text-textmid uppercase tracking-wide py-2 px-2">Angle</th>
            <SortHeader col="tier">Tier</SortHeader>
            <th className="text-left text-[10px] text-textmid uppercase tracking-wide py-2 px-2">Priority</th>
            <SortHeader col="spend">Spend</SortHeader>
            <SortHeader col="cpa">CPA</SortHeader>
            <SortHeader col="roas">ROAS</SortHeader>
            <SortHeader col="ctr">CTR</SortHeader>
            <th className="text-left text-[10px] text-textmid uppercase tracking-wide py-2 px-2">Conv</th>
            <th className="text-left text-[10px] text-textmid uppercase tracking-wide py-2 px-2">Ads</th>
            <th className="text-left text-[10px] text-textmid uppercase tracking-wide py-2 px-2">Days</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((e, i) => {
            const tierStyle = TIER_COLORS[e.tier] || TIER_COLORS.too_early;
            return (
              <tr
                key={i}
                className="border-b border-black/5 hover:bg-offwhite/50 cursor-pointer"
                onClick={() => setExpandedAngle(expandedAngle === e.angleName ? null : e.angleName)}
              >
                <td className="py-2 px-2">
                  <div className="font-medium text-textdark">{e.angleName}</div>
                  {e.frame && <div className="text-[10px] text-textlight">{e.frame}</div>}
                </td>
                <td className="py-2 px-2">
                  <span className={`badge ${tierStyle.bg} ${tierStyle.text}`}>{e.tier}</span>
                </td>
                <td className="py-2 px-2">
                  {e.priority && <PriorityBadge priority={e.priority} />}
                </td>
                <td className="py-2 px-2 font-medium">${e.spend?.toLocaleString()}</td>
                <td className="py-2 px-2">{e.cpa != null ? `$${e.cpa.toFixed(2)}` : '—'}</td>
                <td className="py-2 px-2">{e.roas != null ? `${e.roas.toFixed(1)}x` : '—'}</td>
                <td className="py-2 px-2">{e.ctr?.toFixed(1)}%</td>
                <td className="py-2 px-2">{e.conversions}</td>
                <td className="py-2 px-2 text-textmid">{e.adCount}</td>
                <td className="py-2 px-2 text-textmid">{e.daysActive}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── LP Diagnostics Section ───────────────────────────────────────────────────

function LPDiagnosticsSection({ dashboard }) {
  const diagnostics = dashboard?.lpDiagnostics || [];
  const validDiagnostics = diagnostics.filter(d => !d.error);

  if (validDiagnostics.length === 0) {
    return <EmptyState message="No LP diagnostic data. Configure GA4 and run a CMO review." />;
  }

  const DIAG_COLORS = {
    healthy: 'bg-teal/10 text-teal',
    hook_problem: 'bg-red-50 text-red-600',
    lp_not_convincing: 'bg-gold/10 text-gold',
    checkout_problem: 'bg-gold/10 text-gold',
    page_broken: 'bg-red-100 text-red-700',
    needs_review: 'bg-navy/5 text-navy',
    no_ga4_data: 'bg-black/5 text-textmid',
  };

  return (
    <div className="card overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-black/5">
            <th className="text-left text-[10px] text-textmid uppercase tracking-wide py-2 px-2">Landing Page</th>
            <th className="text-left text-[10px] text-textmid uppercase tracking-wide py-2 px-2">Angles</th>
            <th className="text-left text-[10px] text-textmid uppercase tracking-wide py-2 px-2">Sessions</th>
            <th className="text-left text-[10px] text-textmid uppercase tracking-wide py-2 px-2">Bounce Rate</th>
            <th className="text-left text-[10px] text-textmid uppercase tracking-wide py-2 px-2">CVR</th>
            <th className="text-left text-[10px] text-textmid uppercase tracking-wide py-2 px-2">ATC Rate</th>
            <th className="text-left text-[10px] text-textmid uppercase tracking-wide py-2 px-2">Diagnosis</th>
          </tr>
        </thead>
        <tbody>
          {validDiagnostics.map((d, i) => (
            <tr key={i} className="border-b border-black/5 hover:bg-offwhite/50">
              <td className="py-2 px-2 font-medium text-textdark max-w-[200px] truncate" title={d.landing_page}>
                {d.landing_page}
              </td>
              <td className="py-2 px-2 text-textmid">{d.angles?.join(', ') || '—'}</td>
              <td className="py-2 px-2">{d.sessions ?? '—'}</td>
              <td className="py-2 px-2">{d.bounce_rate != null ? `${(d.bounce_rate * 100).toFixed(1)}%` : '—'}</td>
              <td className="py-2 px-2">{d.cvr != null ? `${d.cvr.toFixed(1)}%` : '—'}</td>
              <td className="py-2 px-2">{d.atc_rate != null ? `${d.atc_rate.toFixed(1)}%` : '—'}</td>
              <td className="py-2 px-2">
                {d.diagnosis && (
                  <span className={`badge ${DIAG_COLORS[d.diagnosis] || DIAG_COLORS.needs_review}`}>
                    {d.diagnosis_label || d.diagnosis}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── History Section ──────────────────────────────────────────────────────────

function HistorySection({ projectId }) {
  const [selectedAngle, setSelectedAngle] = useState('');
  const [history, setHistory] = useState([]);
  const [allHistory, setAllHistory] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const data = await api.getCmoHistory(projectId);
        setAllHistory(data.history || []);
      } catch (err) {
        console.error('Failed to load history:', err);
      } finally {
        setLoading(false);
      }
    })();
  }, [projectId]);

  useEffect(() => {
    if (selectedAngle) {
      setHistory(allHistory.filter(h => h.angle_name === selectedAngle));
    } else {
      setHistory(allHistory);
    }
  }, [selectedAngle, allHistory]);

  const angleNames = [...new Set(allHistory.map(h => h.angle_name))].sort();

  if (loading) {
    return <div className="text-center py-8 text-textmid text-sm">Loading history...</div>;
  }

  if (allHistory.length === 0) {
    return <EmptyState message="No angle history yet. Run a CMO review to start tracking." />;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <select
          value={selectedAngle}
          onChange={(e) => setSelectedAngle(e.target.value)}
          className="input-apple text-xs"
        >
          <option value="">All Angles</option>
          {angleNames.map(name => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
        <span className="text-xs text-textmid">{history.length} snapshots</span>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-black/5">
              <th className="text-left text-[10px] text-textmid uppercase tracking-wide py-2 px-2">Date</th>
              <th className="text-left text-[10px] text-textmid uppercase tracking-wide py-2 px-2">Angle</th>
              <th className="text-left text-[10px] text-textmid uppercase tracking-wide py-2 px-2">Tier</th>
              <th className="text-left text-[10px] text-textmid uppercase tracking-wide py-2 px-2">Spend</th>
              <th className="text-left text-[10px] text-textmid uppercase tracking-wide py-2 px-2">CPA</th>
              <th className="text-left text-[10px] text-textmid uppercase tracking-wide py-2 px-2">ROAS</th>
              <th className="text-left text-[10px] text-textmid uppercase tracking-wide py-2 px-2">Spend Trend</th>
              <th className="text-left text-[10px] text-textmid uppercase tracking-wide py-2 px-2">CPA Trend</th>
              <th className="text-left text-[10px] text-textmid uppercase tracking-wide py-2 px-2">Priority</th>
            </tr>
          </thead>
          <tbody>
            {history.slice(0, 100).map((h, i) => {
              const tierStyle = TIER_COLORS[h.tier] || TIER_COLORS.too_early;
              return (
                <tr key={i} className="border-b border-black/5">
                  <td className="py-2 px-2 text-textmid">{h.snapshot_date}</td>
                  <td className="py-2 px-2 font-medium text-textdark">{h.angle_name}</td>
                  <td className="py-2 px-2">
                    <span className={`badge ${tierStyle.bg} ${tierStyle.text}`}>{h.tier}</span>
                  </td>
                  <td className="py-2 px-2">${h.spend?.toFixed(2)}</td>
                  <td className="py-2 px-2">{h.cpa != null ? `$${h.cpa.toFixed(2)}` : '—'}</td>
                  <td className="py-2 px-2">{h.roas != null ? `${h.roas.toFixed(1)}x` : '—'}</td>
                  <td className="py-2 px-2"><TrendArrow trend={h.spend_trend} /></td>
                  <td className="py-2 px-2"><TrendArrow trend={h.cpa_trend} inverted /></td>
                  <td className="py-2 px-2">
                    {h.priority_at_snapshot && <PriorityBadge priority={h.priority_at_snapshot} />}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── CMO Agent Section ────────────────────────────────────────────────────────

function AgentSection({ projectId, dashboard, onRefresh }) {
  const [config, setConfig] = useState(dashboard?.config || null);
  const [configDirty, setConfigDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [runs, setRuns] = useState([]);
  const [runsLoading, setRunsLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [genProgress, setGenProgress] = useState(0);
  const [genPhase, setGenPhase] = useState('');
  const genStartRef = useRef(null);
  const [selectedRun, setSelectedRun] = useState(null);
  const [testingTw, setTestingTw] = useState(false);
  const [testingGa4, setTestingGa4] = useState(false);
  const toast = useToast();

  // Load config and runs
  useEffect(() => {
    (async () => {
      try {
        const [configData, runsData] = await Promise.all([
          api.getCmoConfig(projectId),
          api.getCmoRuns(projectId),
        ]);
        if (configData.config) setConfig(configData.config);
        setRuns(runsData.runs || []);
      } catch (err) {
        console.error('Failed to load CMO data:', err);
      } finally {
        setRunsLoading(false);
      }
    })();
  }, [projectId]);

  const updateField = (field, value) => {
    setConfig(prev => ({ ...prev, [field]: value }));
    setConfigDirty(true);
  };

  const saveConfig = async () => {
    setSaving(true);
    try {
      const fields = { ...config };
      // Don't send redacted fields
      if (fields.tw_api_key === '***configured***') delete fields.tw_api_key;
      if (fields.ga4_credentials_json === '***configured***') delete fields.ga4_credentials_json;
      // Remove internal fields
      delete fields._id;
      delete fields._creationTime;
      delete fields.project_id;
      delete fields.created_at;
      delete fields.updated_at;

      await api.updateCmoConfig(projectId, fields);
      setConfigDirty(false);
      toast.success('CMO config saved');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleRun = (isDryRun) => {
    setRunning(true);
    setGenProgress(0);
    setGenPhase('Starting...');
    genStartRef.current = Date.now();

    const runFn = isDryRun ? api.dryRunCmo : api.runCmo;
    const { abort, done } = runFn(projectId, (event) => {
      if (event.type === 'progress') {
        setGenPhase(event.message || '');
        if (event.step && STEP_PROGRESS[event.step] !== undefined) {
          setGenProgress(prev => Math.max(prev, STEP_PROGRESS[event.step]));
        }
      } else if (event.type === 'complete') {
        setGenProgress(100);
        setTimeout(() => {
          setGenProgress(0);
          setGenPhase('');
          genStartRef.current = null;
          setRunning(false);
          toast.success(`CMO ${isDryRun ? 'dry run' : 'review'} complete — ${event.decisionsCount || 0} decisions`);
          // Reload data
          api.getCmoRuns(projectId).then(d => setRuns(d.runs || []));
          onRefresh();
        }, 500);
      } else if (event.type === 'error') {
        setGenProgress(0);
        setGenPhase('');
        genStartRef.current = null;
        setRunning(false);
        toast.error(event.message || 'CMO run failed');
      }
    });
  };

  const handleTestTw = async () => {
    setTestingTw(true);
    try {
      const result = await api.testCmoTripleWhale(projectId);
      if (result.success) {
        toast.success('Triple Whale connection OK');
      } else {
        toast.error(`Triple Whale: ${result.error}`);
      }
    } catch (err) {
      toast.error(err.message);
    } finally {
      setTestingTw(false);
    }
  };

  const handleTestGa4 = async () => {
    setTestingGa4(true);
    try {
      const result = await api.testCmoGa4(projectId);
      if (result.success) {
        toast.success(`GA4 connection OK — ${result.pages_found} pages found`);
      } else {
        toast.error(`GA4: ${result.error}`);
      }
    } catch (err) {
      toast.error(err.message);
    } finally {
      setTestingGa4(false);
    }
  };

  const handleApplyDecisions = async (runId) => {
    try {
      const result = await api.applyCmoDecisions(projectId, runId);
      toast.success(`Applied ${result.applied} decision(s)`);
      api.getCmoRuns(projectId).then(d => setRuns(d.runs || []));
      onRefresh();
    } catch (err) {
      toast.error(err.message);
    }
  };

  return (
    <div className="space-y-4">
      {/* Config */}
      <div className="card p-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-textdark">CMO Configuration</h3>
          {configDirty && (
            <button onClick={saveConfig} disabled={saving} className="btn-primary text-xs px-3 py-1.5">
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
          {/* Targets */}
          <div className="space-y-3">
            <h4 className="text-[11px] font-semibold text-textmid uppercase tracking-wide">Targets</h4>
            <div>
              <label className="block text-textmid mb-1">Target CPA ($)</label>
              <input
                type="number"
                value={config?.target_cpa || ''}
                onChange={e => updateField('target_cpa', parseFloat(e.target.value) || undefined)}
                className="input-apple w-full text-xs"
                placeholder="50.00"
              />
            </div>
            <div>
              <label className="block text-textmid mb-1">Target ROAS</label>
              <input
                type="number"
                value={config?.target_roas || ''}
                onChange={e => updateField('target_roas', parseFloat(e.target.value) || undefined)}
                className="input-apple w-full text-xs"
                step="0.1"
                placeholder="3.0"
              />
            </div>
            <div>
              <label className="block text-textmid mb-1">Evaluation Window (days)</label>
              <input
                type="number"
                value={config?.evaluation_window_days ?? 12}
                onChange={e => updateField('evaluation_window_days', parseInt(e.target.value) || 12)}
                className="input-apple w-full text-xs"
              />
            </div>
            <div>
              <label className="block text-textmid mb-1">Min Highest-Priority Angles</label>
              <input
                type="number"
                value={config?.min_highest_angles ?? 8}
                onChange={e => updateField('min_highest_angles', parseInt(e.target.value) || 8)}
                className="input-apple w-full text-xs"
              />
            </div>
          </div>

          {/* Schedule & Meta */}
          <div className="space-y-3">
            <h4 className="text-[11px] font-semibold text-textmid uppercase tracking-wide">Schedule & Meta</h4>
            <div>
              <label className="block text-textmid mb-1">Meta Campaign ID</label>
              <input
                type="text"
                value={config?.meta_campaign_id || ''}
                onChange={e => updateField('meta_campaign_id', e.target.value || undefined)}
                className="input-apple w-full text-xs"
                placeholder="Campaign ID from Meta"
              />
            </div>
            <div>
              <label className="block text-textmid mb-1">Tracking Start Date</label>
              <input
                type="date"
                value={config?.tracking_start_date || ''}
                onChange={e => updateField('tracking_start_date', e.target.value || undefined)}
                className="input-apple w-full text-xs"
              />
            </div>
            <div>
              <label className="block text-textmid mb-1">Review Day</label>
              <select
                value={config?.review_day_of_week ?? 1}
                onChange={e => updateField('review_day_of_week', parseInt(e.target.value))}
                className="input-apple w-full text-xs"
              >
                {DAY_NAMES.map((name, i) => (
                  <option key={i} value={i}>{name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-textmid mb-1">Review Hour (UTC)</label>
              <input
                type="number"
                value={config?.review_hour_utc ?? 3}
                onChange={e => updateField('review_hour_utc', parseInt(e.target.value))}
                className="input-apple w-full text-xs"
                min="0"
                max="23"
              />
            </div>
          </div>

          {/* Triple Whale */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-[11px] font-semibold text-textmid uppercase tracking-wide">Triple Whale</h4>
              <button onClick={handleTestTw} disabled={testingTw} className="text-[10px] text-gold hover:underline">
                {testingTw ? 'Testing...' : 'Test Connection'}
              </button>
            </div>
            <div>
              <label className="block text-textmid mb-1">API Key</label>
              <input
                type="password"
                value={config?.tw_api_key || ''}
                onChange={e => updateField('tw_api_key', e.target.value || undefined)}
                className="input-apple w-full text-xs"
                placeholder="Triple Whale API Key"
              />
            </div>
            <div>
              <label className="block text-textmid mb-1">Shopify Domain</label>
              <input
                type="text"
                value={config?.tw_shopify_domain || ''}
                onChange={e => updateField('tw_shopify_domain', e.target.value || undefined)}
                className="input-apple w-full text-xs"
                placeholder="mystore.myshopify.com"
              />
            </div>
          </div>

          {/* GA4 */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-[11px] font-semibold text-textmid uppercase tracking-wide">Google Analytics 4</h4>
              <button onClick={handleTestGa4} disabled={testingGa4} className="text-[10px] text-gold hover:underline">
                {testingGa4 ? 'Testing...' : 'Test Connection'}
              </button>
            </div>
            <div>
              <label className="block text-textmid mb-1">Property ID</label>
              <input
                type="text"
                value={config?.ga4_property_id || ''}
                onChange={e => updateField('ga4_property_id', e.target.value || undefined)}
                className="input-apple w-full text-xs"
                placeholder="123456789"
              />
            </div>
            <div>
              <label className="block text-textmid mb-1">Service Account Credentials (JSON)</label>
              <textarea
                value={config?.ga4_credentials_json === '***configured***' ? '' : (config?.ga4_credentials_json || '')}
                onChange={e => updateField('ga4_credentials_json', e.target.value || undefined)}
                className="input-apple w-full text-xs h-20 font-mono"
                placeholder={config?.ga4_credentials_json === '***configured***' ? 'Credentials configured. Paste new JSON to replace.' : 'Paste service account JSON...'}
              />
            </div>
          </div>
        </div>

        {/* Toggles */}
        <div className="mt-4 pt-4 border-t border-black/5 flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={!!config?.enabled}
              onChange={e => updateField('enabled', e.target.checked)}
              className="rounded border-textlight"
            />
            <span className="text-textdark">Enabled</span>
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={!!config?.auto_execute}
              onChange={e => updateField('auto_execute', e.target.checked)}
              className="rounded border-textlight"
            />
            <span className="text-textdark">Auto-Execute (apply decisions automatically)</span>
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={config?.notifications_enabled !== false}
              onChange={e => updateField('notifications_enabled', e.target.checked)}
              className="rounded border-textlight"
            />
            <span className="text-textdark">Notifications</span>
          </label>
        </div>
      </div>

      {/* Run Controls */}
      <div className="card p-4">
        <div className="flex items-center gap-3">
          <button
            onClick={() => handleRun(true)}
            disabled={running}
            className="btn-secondary text-xs px-4 py-2"
          >
            Dry Run
          </button>
          <button
            onClick={() => handleRun(false)}
            disabled={running}
            className="btn-primary text-xs px-4 py-2"
          >
            Run CMO Review
          </button>
          {running && <span className="text-xs text-textmid">Running...</span>}
        </div>

        {running && (
          <div className="mt-3">
            <PipelineProgress
              progress={genProgress}
              message={genPhase}
              startTime={genStartRef.current}
            />
          </div>
        )}
      </div>

      {/* Run History */}
      <div className="card p-4">
        <h3 className="text-sm font-semibold text-textdark mb-3">Run History</h3>
        {runsLoading ? (
          <div className="text-xs text-textmid">Loading...</div>
        ) : runs.length === 0 ? (
          <div className="text-xs text-textmid">No runs yet.</div>
        ) : (
          <div className="space-y-2">
            {runs.slice(0, 20).map(run => (
              <RunRow
                key={run.externalId}
                run={run}
                expanded={selectedRun === run.externalId}
                onToggle={() => setSelectedRun(selectedRun === run.externalId ? null : run.externalId)}
                onApply={() => handleApplyDecisions(run.externalId)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────────────────

function RunRow({ run, expanded, onToggle, onApply }) {
  const statusColor = run.status === 'completed' ? 'text-teal' : run.status === 'failed' ? 'text-red-600' : 'text-gold';
  let decisions = [];
  try { decisions = JSON.parse(run.decisions || '[]'); } catch {}

  return (
    <div className="border border-black/5 rounded-lg">
      <div
        className="flex items-center justify-between p-3 cursor-pointer hover:bg-offwhite/50"
        onClick={onToggle}
      >
        <div className="flex items-center gap-3 text-xs">
          <span className={`font-medium ${statusColor}`}>{run.status}</span>
          <span className="text-textmid">{run.run_type}</span>
          <span className="text-textlight">{new Date(run.run_at).toLocaleString()}</span>
          {run.duration_ms && <span className="text-textlight">{(run.duration_ms / 1000).toFixed(0)}s</span>}
        </div>
        <div className="flex items-center gap-2 text-xs">
          {run.decisions_count > 0 && (
            <span className="badge bg-navy/10 text-navy">{run.decisions_count} decisions</span>
          )}
          <span className="text-textlight">{expanded ? '▾' : '▸'}</span>
        </div>
      </div>

      {expanded && (
        <div className="px-3 pb-3 border-t border-black/5 pt-2 space-y-2">
          {run.error && (
            <div className="text-xs text-red-600 bg-red-50 p-2 rounded">{run.error}</div>
          )}

          {decisions.length > 0 && (
            <div className="space-y-1">
              <div className="text-[10px] text-textmid uppercase tracking-wide">Decisions</div>
              {decisions.map((d, i) => (
                <div key={i} className="text-xs bg-offwhite p-2 rounded">
                  <span className="font-medium text-navy">{d.rule}</span>
                  {d.angleName && <span className="text-textmid"> — {d.angleName}</span>}
                  <span className="text-textmid"> — {d.action}</span>
                  {d.newPriority && <span className="text-gold"> → {d.newPriority}</span>}
                  <div className="text-textlight mt-0.5">{d.reason}</div>
                </div>
              ))}

              {run.run_type === 'dry_run' && !run.decisions_applied && (
                <button onClick={onApply} className="btn-primary text-xs px-3 py-1.5 mt-2">
                  Apply Decisions
                </button>
              )}
              {run.decisions_applied && (
                <div className="text-xs text-teal mt-1">Decisions applied</div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MetricCard({ label, value, subtext }) {
  return (
    <div className="card p-3">
      <div className="text-[10px] text-textlight uppercase tracking-wide">{label}</div>
      <div className="text-lg font-bold text-textdark mt-1">{value}</div>
      {subtext && <div className="text-[10px] text-textmid mt-0.5">{subtext}</div>}
    </div>
  );
}

function PriorityBadge({ priority }) {
  const colors = {
    highest: 'bg-teal/10 text-teal',
    high: 'bg-navy/10 text-navy',
    medium: 'bg-gold/10 text-gold',
    low: 'bg-black/5 text-textmid',
    test: 'bg-purple-50 text-purple-600',
  };
  return (
    <span className={`badge ${colors[priority] || colors.medium}`}>
      {priority}
    </span>
  );
}

function TrendArrow({ trend, inverted = false }) {
  if (trend === 'up') {
    return <span className={inverted ? 'text-red-500' : 'text-teal'}>↑</span>;
  }
  if (trend === 'down') {
    return <span className={inverted ? 'text-teal' : 'text-red-500'}>↓</span>;
  }
  return <span className="text-textlight">→</span>;
}

function EmptyState({ message }) {
  return (
    <div className="card p-8 text-center">
      <div className="text-textmid text-sm">{message}</div>
    </div>
  );
}

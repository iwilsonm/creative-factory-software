import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';

const LEVEL_CONFIG = {
  OK:        { color: 'text-teal',      icon: '\u2713', bg: 'bg-teal/10' },
  INFO:      { color: 'text-textmid',   icon: '\u2022', bg: 'bg-black/5' },
  WARN:      { color: 'text-gold',      icon: '\u26A0', bg: 'bg-gold/10' },
  ERROR:     { color: 'text-red-400',   icon: '\u2717', bg: 'bg-red-50' },
  RESURRECT: { color: 'text-navy-light', icon: '\u21BB', bg: 'bg-navy/10' },
  SCORE:     { color: 'text-purple-500', icon: '\u2605', bg: 'bg-purple-50' },
};

const STATUS_CONFIG = {
  online:  { color: 'text-teal',    dot: 'bg-teal',    label: 'Online',  pulse: true },
  warning: { color: 'text-gold',    dot: 'bg-gold',    label: 'Delayed', pulse: true },
  offline: { color: 'text-red-400', dot: 'bg-red-400', label: 'Offline', pulse: false },
};

function timeAgo(dateStr) {
  if (!dateStr) return 'never';
  const diff = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (diff < 0) return 'just now';
  if (diff < 60) return 'just now';
  if (diff < 3600) {
    const mins = Math.floor(diff / 60);
    return `${mins} min${mins !== 1 ? 's' : ''} ago`;
  }
  if (diff < 86400) {
    const hours = Math.floor(diff / 3600);
    return `${hours}h ago`;
  }
  return `${Math.floor(diff / 86400)}d ago`;
}

function timeUntil(dateStr) {
  if (!dateStr) return null;
  const diff = Math.floor((new Date(dateStr).getTime() - Date.now()) / 1000);
  if (diff <= 0) return 'any moment';
  if (diff < 60) return `~${diff}s`;
  const mins = Math.ceil(diff / 60);
  return `~${mins} min`;
}

export default function AgentMonitor() {
  const [fixerData, setFixerData] = useState(null);
  const [filterData, setFilterData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const [fixer, filter] = await Promise.allSettled([
        api.getAgentMonitorStatus(),
        api.getFilterStatus(),
      ]);
      if (fixer.status === 'fulfilled') setFixerData(fixer.value);
      if (filter.status === 'fulfilled') setFilterData(filter.value);
      setError(fixer.status === 'rejected' && filter.status === 'rejected');
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
    const interval = setInterval(loadStatus, 30000);
    return () => clearInterval(interval);
  }, [loadStatus]);

  // Loading skeleton
  if (loading) {
    return (
      <div className="mb-8 fade-in">
        <div className="card p-5 animate-pulse">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-7 h-7 rounded-lg bg-gray-100" />
            <div className="h-4 w-48 bg-gray-100 rounded" />
          </div>
          <div className="h-1.5 w-full bg-gray-50 rounded-full mb-4" />
          <div className="grid grid-cols-4 gap-3">
            {[0, 1, 2, 3].map(i => <div key={i} className="h-14 bg-gray-50 rounded-lg" />)}
          </div>
        </div>
      </div>
    );
  }

  // Error / agents not available
  if (error || (!fixerData && !filterData)) {
    return (
      <div className="mb-8 fade-in">
        <div className="card p-5">
          <div className="flex items-center gap-3">
            <div className="w-7 h-7 rounded-lg bg-black/5 flex items-center justify-center">
              <svg className="w-3.5 h-3.5 text-textlight" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
            </div>
            <div>
              <p className="text-[13px] font-medium text-textlight">Agent Monitor</p>
              <p className="text-[11px] text-textlight/60">Not available — agents may not be installed</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mb-8 fade-in space-y-4">
      {fixerData && (
        <FixerCard data={fixerData} onRefresh={loadStatus} />
      )}
      {filterData && (
        <FilterCard data={filterData} onRefresh={loadStatus} />
      )}
    </div>
  );
}

// =============================================
// Fixer Card (Agent #1)
// =============================================
function FixerCard({ data, onRefresh }) {
  const [expanded, setExpanded] = useState(false);
  const [runningAction, setRunningAction] = useState(null);

  const handleRun = async () => {
    setRunningAction('run');
    try {
      await api.runAgentFixer();
      setTimeout(onRefresh, 3000);
    } catch { /* ignore */ }
    finally { setRunningAction(null); }
  };

  const handleResurrect = async () => {
    setRunningAction('resurrect');
    try {
      await api.runAgentResurrect();
      setTimeout(onRefresh, 3000);
    } catch { /* ignore */ }
    finally { setRunningAction(null); }
  };

  const statusCfg = STATUS_CONFIG[data.status] || STATUS_CONFIG.offline;
  const budgetPct = data.budget.daily_budget_cents > 0
    ? (data.budget.spent_cents / data.budget.daily_budget_cents) * 100
    : 0;
  const budgetBarColor = budgetPct < 50 ? 'bg-teal' : budgetPct < 80 ? 'bg-gold' : 'bg-red-400';

  return (
    <div className="card p-5">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 rounded-lg bg-navy/10 flex items-center justify-center flex-shrink-0">
            <svg className="w-3.5 h-3.5 text-navy" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </div>
          <div>
            <p className="text-[15px] font-semibold text-textdark tracking-tight">Dacia Fixer</p>
            <p className="text-[11px] text-textlight">Recursive Agent #1</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full ${statusCfg.dot} ${statusCfg.pulse ? 'animate-pulse' : ''}`} />
          <span className={`text-[11px] font-medium ${statusCfg.color}`}>{statusCfg.label}</span>
        </div>
      </div>

      {/* Budget bar */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[11px] text-textmid font-medium">Budget</span>
          <span className="text-[11px] text-textmid tabular-nums">
            {data.budget.spent_cents}{'\u00A2'} / {data.budget.daily_budget_cents}{'\u00A2'}
            <span className="text-textlight ml-1">
              (${(data.budget.spent_cents / 100).toFixed(2)} / ${(data.budget.daily_budget_cents / 100).toFixed(2)})
            </span>
          </span>
        </div>
        <div className="h-1.5 rounded-full bg-black/5 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${budgetBarColor}`}
            style={{ width: `${Math.min(budgetPct, 100)}%` }}
          />
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-4 gap-3 mb-4">
        <StatCell value={data.stats.runs} label="Runs" color="text-textdark" />
        <StatCell value={data.stats.fixes} label="Fixes" color="text-teal" />
        <StatCell value={data.stats.failures} label="Failures" color={data.stats.failures > 0 ? 'text-red-400' : 'text-textdark'} />
        <StatCell value={data.stats.resurrections} label="Resurrects" color="text-navy-light" />
      </div>

      {/* Last run / next run */}
      <p className="text-[11px] text-textmid mb-3">
        Last run: <span className="font-medium text-textdark">{timeAgo(data.lastRun)}</span>
        {data.nextRun && (
          <>
            {' \u00B7 '}
            Next: <span className="font-medium text-textdark">{timeUntil(data.nextRun)}</span>
          </>
        )}
      </p>

      {/* Control buttons */}
      <div className="flex gap-2 mb-4">
        <button
          onClick={handleRun}
          disabled={!!runningAction}
          className="btn-primary text-[12px] px-3 py-1.5 flex items-center gap-1.5 disabled:opacity-50"
        >
          {runningAction === 'run' ? (
            <><Spinner /> Running...</>
          ) : (
            <><span className="text-[10px]">{'\u25B6'}</span> Run Now</>
          )}
        </button>
        <button
          onClick={handleResurrect}
          disabled={!!runningAction}
          className="btn-secondary text-[12px] px-3 py-1.5 flex items-center gap-1.5 disabled:opacity-50"
        >
          {runningAction === 'resurrect' ? (
            <><Spinner /> Checking...</>
          ) : (
            <><span className="text-[10px]">{'\u21BB'}</span> Resurrect Now</>
          )}
        </button>
      </div>

      {/* Activity log */}
      <ActivityLog
        activity={data.activity}
        expanded={expanded}
        onToggle={() => setExpanded(!expanded)}
      />
    </div>
  );
}

// =============================================
// Creative Filter Card (Agent #2)
// =============================================
function FilterCard({ data, onRefresh }) {
  const [expanded, setExpanded] = useState(false);
  const [runningAction, setRunningAction] = useState(null);

  const handleDryRun = async () => {
    setRunningAction('dry');
    try {
      await api.runFilterDryRun();
      setTimeout(onRefresh, 3000);
    } catch { /* ignore */ }
    finally { setRunningAction(null); }
  };

  const handleRunLive = async () => {
    setRunningAction('live');
    try {
      await api.runFilterLive();
      setTimeout(onRefresh, 5000);
    } catch { /* ignore */ }
    finally { setRunningAction(null); }
  };

  const statusCfg = STATUS_CONFIG[data.status] || STATUS_CONFIG.offline;
  const budgetPct = data.budget.daily_budget_cents > 0
    ? (data.budget.spent_cents / data.budget.daily_budget_cents) * 100
    : 0;
  const budgetBarColor = budgetPct < 50 ? 'bg-teal' : budgetPct < 80 ? 'bg-gold' : 'bg-red-400';

  return (
    <div className="card p-5">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 rounded-lg bg-navy/10 flex items-center justify-center flex-shrink-0">
            <svg className="w-3.5 h-3.5 text-navy" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
            </svg>
          </div>
          <div>
            <p className="text-[15px] font-semibold text-textdark tracking-tight">Creative Filter</p>
            <p className="text-[11px] text-textlight">Recursive Agent #2</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <span className={`w-2 h-2 rounded-full ${statusCfg.dot} ${statusCfg.pulse ? 'animate-pulse' : ''}`} />
          <span className={`text-[11px] font-medium ${statusCfg.color}`}>{statusCfg.label}</span>
        </div>
      </div>

      {/* Budget bar */}
      <div className="mb-4">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[11px] text-textmid font-medium">Budget</span>
          <span className="text-[11px] text-textmid tabular-nums">
            {data.budget.spent_cents}{'\u00A2'} / {data.budget.daily_budget_cents}{'\u00A2'}
            <span className="text-textlight ml-1">
              (${(data.budget.spent_cents / 100).toFixed(2)} / ${(data.budget.daily_budget_cents / 100).toFixed(2)})
            </span>
          </span>
        </div>
        <div className="h-1.5 rounded-full bg-black/5 overflow-hidden">
          <div
            className={`h-full rounded-full transition-all duration-500 ${budgetBarColor}`}
            style={{ width: `${Math.min(budgetPct, 100)}%` }}
          />
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-5 gap-3 mb-4">
        <StatCell value={data.stats.batches} label="Batches" color="text-textdark" />
        <StatCell value={data.stats.scored} label="Scored" color="text-textdark" />
        <StatCell value={data.stats.passed} label="Passed" color="text-teal" />
        <StatCell value={data.stats.failed} label="Failed" color={data.stats.failed > 0 ? 'text-red-400' : 'text-textdark'} />
        <StatCell value={data.stats.flexAds} label="Flex Ads" color="text-navy-light" />
      </div>

      {/* Last run / next run */}
      <p className="text-[11px] text-textmid mb-3">
        Last run: <span className="font-medium text-textdark">{timeAgo(data.lastRun)}</span>
        {data.nextRun && (
          <>
            {' \u00B7 '}
            Next: <span className="font-medium text-textdark">{timeUntil(data.nextRun)}</span>
          </>
        )}
      </p>

      {/* Control buttons */}
      <div className="flex gap-2 mb-4">
        <button
          onClick={handleRunLive}
          disabled={!!runningAction}
          className="btn-primary text-[12px] px-3 py-1.5 flex items-center gap-1.5 disabled:opacity-50"
        >
          {runningAction === 'live' ? (
            <><Spinner /> Running...</>
          ) : (
            <><span className="text-[10px]">{'\u25B6'}</span> Run Now</>
          )}
        </button>
        <button
          onClick={handleDryRun}
          disabled={!!runningAction}
          className="btn-secondary text-[12px] px-3 py-1.5 flex items-center gap-1.5 disabled:opacity-50"
        >
          {runningAction === 'dry' ? (
            <><Spinner /> Running...</>
          ) : (
            <><span className="text-[10px]">{'\u2699'}</span> Dry Run</>
          )}
        </button>
      </div>

      {/* Activity log */}
      <ActivityLog
        activity={data.activity}
        expanded={expanded}
        onToggle={() => setExpanded(!expanded)}
      />
    </div>
  );
}

// =============================================
// Shared sub-components
// =============================================

function ActivityLog({ activity, expanded, onToggle }) {
  return (
    <div className="border-t border-black/5 pt-3">
      <button
        onClick={onToggle}
        className="flex items-center justify-between w-full group"
      >
        <span className="text-[12px] font-medium text-textmid">Recent Activity</span>
        <svg
          className={`w-3.5 h-3.5 text-textlight transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
          fill="none" stroke="currentColor" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {expanded && (
        <div className="mt-2 max-h-52 overflow-y-auto scrollbar-thin">
          {activity && activity.length > 0 ? (
            <div className="space-y-0.5">
              {activity.map((entry, i) => {
                const cfg = LEVEL_CONFIG[entry.level] || LEVEL_CONFIG.INFO;
                return (
                  <div key={i} className="flex items-start gap-2 py-1 px-1.5 rounded hover:bg-black/[0.02]">
                    <span className="text-[10px] text-textlight font-mono flex-shrink-0 mt-px w-10">
                      {entry.time.slice(0, 5)}
                    </span>
                    <span className={`text-[11px] flex-shrink-0 w-3 text-center ${cfg.color}`}>
                      {cfg.icon}
                    </span>
                    <span className={`text-[11px] ${cfg.color}`}>
                      {entry.message}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-[11px] text-textlight py-2">No activity recorded today.</p>
          )}
        </div>
      )}
    </div>
  );
}

function StatCell({ value, label, color }) {
  return (
    <div className="text-center p-2 rounded-lg bg-black/[0.02]">
      <p className={`text-lg font-semibold ${color} tabular-nums leading-tight`}>{value}</p>
      <p className="text-[10px] text-textlight uppercase tracking-wider mt-0.5">{label}</p>
    </div>
  );
}

function Spinner() {
  return (
    <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

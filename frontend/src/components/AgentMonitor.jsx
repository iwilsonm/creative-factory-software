import { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import LPAgentSettings from './LPAgentSettings';

const LEVEL_CONFIG = {
  OK:        { color: 'text-teal',       icon: '\u2713', bg: 'bg-teal/10' },
  INFO:      { color: 'text-textmid',    icon: '\u2022', bg: 'bg-black/5' },
  WARN:      { color: 'text-gold',       icon: '\u26A0', bg: 'bg-gold/10' },
  ERROR:     { color: 'text-red-400',    icon: '\u2717', bg: 'bg-red-50' },
  RESURRECT: { color: 'text-navy-light', icon: '\u21BB', bg: 'bg-navy/10' },
  SCORE:     { color: 'text-purple-500', icon: '\u2605', bg: 'bg-purple-50' },
};

const STATUS_CONFIG = {
  online:  { color: 'text-teal',      dot: 'bg-teal',      label: 'Online',  pulse: true },
  warning: { color: 'text-gold',      dot: 'bg-gold',      label: 'Delayed', pulse: true },
  offline: { color: 'text-red-400',   dot: 'bg-red-400',   label: 'Offline', pulse: false },
  paused:  { color: 'text-textlight', dot: 'bg-textlight', label: 'Paused',  pulse: false },
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

const VALID_AGENT_TABS = ['director', 'lp_agent', 'filter', 'fixer'];

export default function AgentMonitor() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [fixerData, setFixerData] = useState(null);
  const [filterData, setFilterData] = useState(null);
  const [pipelineStatus, setPipelineStatus] = useState(null);
  // Persist active tab in URL search params so it survives page refresh
  const tabFromUrl = searchParams.get('tab');
  const [activeTab, setActiveTabState] = useState(
    tabFromUrl && VALID_AGENT_TABS.includes(tabFromUrl) ? tabFromUrl : 'director'
  );
  const setActiveTab = useCallback((newTab) => {
    setActiveTabState(newTab);
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.set('tab', newTab);
      return next;
    }, { replace: true });
  }, [setSearchParams]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const [fixer, filter, pipeline] = await Promise.allSettled([
        api.getAgentMonitorStatus(),
        api.getFilterStatus(),
        api.getConductorPipelineStatus(),
      ]);
      if (fixer.status === 'fulfilled') setFixerData(fixer.value);
      if (filter.status === 'fulfilled') setFilterData(filter.value);
      if (pipeline.status === 'fulfilled') setPipelineStatus(pipeline.value);
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

  if (loading) {
    return (
      <div className="fade-in">
        <div className="card p-5 animate-pulse">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-7 h-7 rounded-lg bg-gray-100" />
            <div className="h-4 w-48 bg-gray-100 rounded" />
          </div>
          <div className="h-24 bg-gray-50 rounded-xl mb-4" />
          <div className="h-60 bg-gray-50 rounded-xl" />
        </div>
      </div>
    );
  }

  if (error || (!fixerData && !filterData)) {
    return (
      <div className="fade-in">
        <div className="card p-5">
          <div className="flex items-center gap-3">
            <div className="w-7 h-7 rounded-lg bg-black/5 flex items-center justify-center">
              <svg className="w-3.5 h-3.5 text-textlight" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
            </div>
            <div>
              <p className="text-[13px] font-medium text-textlight">Agent Dashboard</p>
              <p className="text-[11px] text-textlight/60">Not available</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const agentsOnline = [fixerData, filterData].filter(d => d?.status === 'online').length;
  const agentsTotal = [fixerData, filterData].filter(Boolean).length;

  const tabs = [
    { id: 'director', label: 'Creative Director' },
    { id: 'lp_agent', label: 'LP Agent' },
    { id: 'filter', label: 'Creative Filter' },
    { id: 'fixer', label: 'Fixer' },
  ];

  return (
    <div className="fade-in space-y-4">
      {/* Dashboard header */}
      <div className="card p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-7 h-7 rounded-lg bg-navy/10 flex items-center justify-center flex-shrink-0">
              <svg className="w-3.5 h-3.5 text-navy" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
            </div>
            <div>
              <h2 className="text-[15px] font-semibold text-textdark tracking-tight">Agent Dashboard</h2>
              <p className="text-[11px] text-textlight">Three autonomous agents managing your ad pipeline</p>
            </div>
          </div>
          <span className="text-[11px] text-textmid font-medium">{agentsOnline}/{agentsTotal} online</span>
        </div>

        {/* Pipeline Overview */}
        <PipelineOverview data={pipelineStatus} fixerData={fixerData} filterData={filterData} />
      </div>

      {/* Agent Tabs */}
      <div className="card p-5">
        <div className="flex gap-1 mb-4 bg-black/[0.03] rounded-xl p-1">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 text-[12px] font-medium py-2 px-3 rounded-lg transition-all duration-200 ${
                activeTab === tab.id
                  ? 'bg-white text-textdark shadow-sm'
                  : 'text-textmid hover:text-textdark'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === 'director' && <DirectorTab onRefresh={loadStatus} />}
        {activeTab === 'lp_agent' && <LPAgentTab />}
        {activeTab === 'filter' && filterData && <FilterPanel data={filterData} onRefresh={loadStatus} />}
        {activeTab === 'fixer' && fixerData && <FixerPanel data={fixerData} onRefresh={loadStatus} />}
      </div>
    </div>
  );
}

// =============================================
// Pipeline Overview
// =============================================
function PipelineOverview({ data, fixerData, filterData }) {
  const projects = data?.projects || [];
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // Get the next 5 weekdays
  const getUpcomingDays = () => {
    const days = [];
    const now = new Date();
    let d = new Date(now);
    while (days.length < 5) {
      d.setDate(d.getDate() + 1);
      const dow = d.getDay();
      if (dow >= 1 && dow <= 5) {
        days.push({
          date: d.toISOString().split('T')[0],
          dayName: dayNames[dow],
          label: days.length === 0 ? 'Tomorrow' : `${dayNames[dow]} ${d.getDate()}`,
        });
      }
    }
    return days;
  };

  const upcomingDays = getUpcomingDays();

  if (projects.length === 0) {
    return (
      <div className="rounded-xl bg-black/[0.02] border border-black/5 p-4">
        <p className="text-[12px] font-medium text-textmid mb-1">Pipeline Overview</p>
        <p className="text-[11px] text-textlight">No projects configured for the Creative Director yet. Enable a project in the Director tab to see pipeline status.</p>
        <div className="flex items-center gap-4 mt-3 text-[10px] text-textmid">
          <span>Director: {'\u2013'}</span>
          <span>Filter: {filterData?.status === 'online' ? '\u2713' : '\u2013'}</span>
          <span>Fixer: {fixerData?.status === 'online' ? '\u2713' : '\u2013'}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl bg-black/[0.02] border border-black/5 p-4">
      <p className="text-[12px] font-medium text-textmid mb-3">Pipeline Overview</p>

      {upcomingDays.slice(0, 3).map(day => (
        <div key={day.date} className="mb-3 last:mb-0">
          <p className="text-[10px] text-textlight font-medium uppercase tracking-wider mb-1.5">{day.label}</p>
          {projects.map(project => {
            const produced = project.flex_by_day?.[day.date] || 0;
            const target = project.daily_flex_target ?? 5;
            const activeBatches = project.active_batches_by_day?.[day.date] || 0;
            const pct = Math.min((produced / target) * 100, 100);
            const isMet = produced >= target;

            return (
              <div key={project.project_id} className="flex items-center gap-3 mb-1">
                <span className="text-[11px] text-textdark font-medium w-32 truncate">{project.brand_name || project.project_name}</span>
                <div className="flex-1 h-2.5 rounded-full bg-black/5 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${isMet ? 'bg-teal' : 'bg-navy'}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="text-[10px] text-textmid tabular-nums w-16 text-right">
                  {produced}/{target}
                  {isMet && <span className="text-teal ml-1">{'\u2713'}</span>}
                </span>
                {activeBatches > 0 && (
                  <span className="text-[9px] text-gold font-medium">{activeBatches} in progress</span>
                )}
              </div>
            );
          })}
        </div>
      ))}

      <div className="flex items-center gap-4 mt-3 pt-2 border-t border-black/5 text-[10px] text-textmid">
        <span>Director {'\u2713'}</span>
        <span>Filter: {filterData?.status === 'online' ? '\u2713' : '\u2717'}</span>
        <span>Fixer: {fixerData?.status === 'online' ? '\u2713' : '\u2717'}</span>
      </div>
    </div>
  );
}

// =============================================
// LP Generation Stats Panel
// =============================================
function GauntletStatsPanel({ projectId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!projectId) return;
    setLoading(true);
    api.getGauntletStats(projectId)
      .then(res => setData(res))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [projectId]);

  if (loading) return <div className="py-2 text-center text-[11px] text-textmid">Loading LP stats...</div>;
  if (!data?.hasData) return null;

  const s = data.stats;
  const FRAME_LABELS = {
    testimonial: 'Testimonial',
    mechanism: 'Mechanism',
    problem_agitation: 'Problem',
    myth_busting: 'Myth Bust',
    listicle: 'Listicle',
  };

  return (
    <div className="card p-4 space-y-3 mb-4">
      <h3 className="text-[13px] font-semibold text-navy">LP Generation Stats</h3>

      {/* Summary grid */}
      <div className="grid grid-cols-4 gap-3">
        <div className="bg-offwhite rounded-lg p-2.5 text-center">
          <div className="text-[18px] font-bold text-navy">{s.gauntletRuns}</div>
          <div className="text-[10px] text-textmid">Runs</div>
        </div>
        <div className="bg-offwhite rounded-lg p-2.5 text-center">
          <div className="text-[18px] font-bold text-teal">{s.passRate}%</div>
          <div className="text-[10px] text-textmid">Pass Rate</div>
        </div>
        <div className="bg-offwhite rounded-lg p-2.5 text-center">
          <div className="text-[18px] font-bold text-navy">{s.avgScore ?? '—'}</div>
          <div className="text-[10px] text-textmid">Avg Score</div>
        </div>
        <div className="bg-offwhite rounded-lg p-2.5 text-center">
          <div className="text-[18px] font-bold text-gold">{s.retryRate}%</div>
          <div className="text-[10px] text-textmid">Retry Rate</div>
        </div>
      </div>

      {/* Detail stats */}
      <div className="grid grid-cols-3 gap-2 text-[11px]">
        <div className="bg-offwhite rounded-lg px-2.5 py-2">
          <span className="text-textmid">Total LPs: </span>
          <span className="font-medium text-navy">{s.totalLPs}</span>
        </div>
        <div className="bg-offwhite rounded-lg px-2.5 py-2">
          <span className="text-textmid">Passed: </span>
          <span className="font-medium text-teal">{s.passed}</span>
        </div>
        <div className="bg-offwhite rounded-lg px-2.5 py-2">
          <span className="text-textmid">Failed: </span>
          <span className="font-medium text-red-400">{s.failed}</span>
        </div>
        <div className="bg-offwhite rounded-lg px-2.5 py-2">
          <span className="text-textmid">Image 1st Pass: </span>
          <span className="font-medium text-navy">{s.firstPassRate != null ? `${s.firstPassRate}%` : '—'}</span>
        </div>
        <div className="bg-offwhite rounded-lg px-2.5 py-2">
          <span className="text-textmid">Avg Img Retries: </span>
          <span className="font-medium text-navy">{s.avgPrescoreAttempts ?? '—'}</span>
        </div>
        <div className="bg-offwhite rounded-lg px-2.5 py-2">
          <span className="text-textmid">Score Range: </span>
          <span className="font-medium text-navy">{s.minScore != null ? `${s.minScore}–${s.maxScore}` : '—'}</span>
        </div>
      </div>

      {/* Score by frame (mini bar chart) */}
      {Object.keys(s.scoreByFrame || {}).length > 0 && (
        <div className="space-y-1.5">
          <div className="text-[10px] font-semibold text-textmid uppercase tracking-wide">Score by Frame</div>
          {Object.entries(s.scoreByFrame).map(([frame, score]) => (
            <div key={frame} className="flex items-center gap-2">
              <span className="text-[10px] text-textmid w-20 flex-shrink-0 truncate">{FRAME_LABELS[frame] || frame}</span>
              <div className="flex-1 h-4 bg-offwhite rounded-full overflow-hidden">
                <div
                  className="h-full bg-navy/70 rounded-full transition-all"
                  style={{ width: `${Math.min(100, (score / 10) * 100)}%` }}
                />
              </div>
              <span className="text-[10px] font-medium text-navy w-8 text-right">{score}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// =============================================
// LP Agent Tab
// =============================================
function LPAgentTab() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [projects, setProjects] = useState([]);
  const [selectedProject, setSelectedProjectState] = useState('');
  const [loading, setLoading] = useState(true);

  const setSelectedProject = useCallback((projectId) => {
    setSelectedProjectState(projectId);
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      if (projectId) next.set('project', projectId);
      else next.delete('project');
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  useEffect(() => {
    (async () => {
      try {
        const res = await api.getProjects();
        const list = res.projects || res || [];
        setProjects(list);
        const projectFromUrl = searchParams.get('project');
        if (projectFromUrl && list.some(p => p.id === projectFromUrl)) {
          setSelectedProjectState(projectFromUrl);
        } else if (list.length > 0) {
          setSelectedProject(list[0].id);
        }
      } catch { /* ignore */ }
      finally { setLoading(false); }
    })();
  }, []);

  if (loading) {
    return <div className="py-4 text-center text-[12px] text-textmid">Loading...</div>;
  }

  return (
    <div>
      {/* Project selector */}
      {projects.length > 1 && (
        <div className="mb-4">
          <select
            value={selectedProject}
            onChange={e => setSelectedProject(e.target.value)}
            className="input-apple text-[12px]"
          >
            {projects.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
      )}

      {selectedProject ? (
        <>
          <GauntletStatsPanel projectId={selectedProject} />
          <LPAgentSettings projectId={selectedProject} />
        </>
      ) : (
        <div className="py-6 text-center text-[12px] text-textmid">No projects found. Create a project first.</div>
      )}
    </div>
  );
}

// =============================================
// Creative Director Tab
// =============================================
function DirectorTab({ onRefresh }) {
  const [projects, setProjects] = useState([]);
  const [selectedProject, setSelectedProject] = useState('');
  const [config, setConfig] = useState(null);
  const [angles, setAngles] = useState([]);
  const [runs, setRuns] = useState([]);
  const [playbooks, setPlaybooks] = useState([]);
  const [subTab, setSubTab] = useState('angles');
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [runningAction, setRunningAction] = useState(null);
  const [saving, setSaving] = useState(false);

  const [campaigns, setCampaigns] = useState([]);

  // New angle form
  const [showAddAngle, setShowAddAngle] = useState(false);
  const [newAngle, setNewAngle] = useState({ name: '', description: '', prompt_hints: '', priority: 'medium', frame: 'symptom-first', core_buyer: '', symptom_pattern: '', failed_solutions: '', current_belief: '', objection: '', emotional_state: '', scene: '', desired_belief_shift: '', tone: '', avoid_list: '' });

  // Import angles
  const [showImport, setShowImport] = useState(false);
  const [importDragOver, setImportDragOver] = useState(false);
  const [importResult, setImportResult] = useState(null); // { newAngles: [], skipped: [] }
  const [importing, setImporting] = useState(false);
  const importFileRef = useRef(null);

  // Load projects list
  useEffect(() => {
    (async () => {
      try {
        const res = await api.getProjects();
        const list = res.projects || res || [];
        setProjects(list);
        if (list.length > 0 && !selectedProject) {
          setSelectedProject(list[0].id);
        }
      } catch { /* ignore */ }
      finally { setLoading(false); }
    })();
  }, []);

  // Load project-specific data when selection changes
  useEffect(() => {
    if (!selectedProject) return;
    (async () => {
      try {
        const [cfgRes, angRes, runRes, pbRes, campRes] = await Promise.allSettled([
          api.getConductorConfig(selectedProject),
          api.getConductorAngles(selectedProject),
          api.getConductorRuns(selectedProject, 20),
          api.getConductorPlaybooks(selectedProject),
          api.getCampaigns(selectedProject),
        ]);
        if (cfgRes.status === 'fulfilled') setConfig(cfgRes.value?.config || null);
        if (angRes.status === 'fulfilled') setAngles(angRes.value?.angles || []);
        if (runRes.status === 'fulfilled') setRuns(runRes.value?.runs || []);
        if (pbRes.status === 'fulfilled') setPlaybooks(pbRes.value?.playbooks || []);
        if (campRes.status === 'fulfilled') setCampaigns(campRes.value?.campaigns || []);
      } catch { /* ignore */ }
    })();
  }, [selectedProject]);

  const debounceRef = useRef(null);

  const handleSaveConfig = useCallback((updates) => {
    // Apply optimistic local update immediately for responsive UI
    setConfig(prev => ({ ...prev, ...updates }));
    // Debounce the actual API save (500ms) to avoid saving on every keystroke
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setSaving(true);
      try {
        const res = await api.updateConductorConfig(selectedProject, updates);
        setConfig(res?.config || (prev => ({ ...prev, ...updates })));
      } catch { /* ignore */ }
      finally { setSaving(false); }
    }, 500);
  }, [selectedProject]);

  const handleTestRun = async () => {
    setRunningAction('run');
    try {
      await api.triggerConductorTestRun(selectedProject);
      setTimeout(async () => {
        const runRes = await api.getConductorRuns(selectedProject, 20);
        setRuns(runRes?.runs || []);
        onRefresh();
      }, 3000);
    } catch { /* ignore */ }
    finally { setRunningAction(null); }
  };

  const handleAddAngle = async () => {
    if (!newAngle.name) return;
    // Auto-compute description if structured fields are present but description is empty
    let description = newAngle.description;
    if (!description && (newAngle.core_buyer || newAngle.symptom_pattern)) {
      const parts = [];
      if (newAngle.core_buyer) parts.push(`Core Buyer: ${newAngle.core_buyer}`);
      if (newAngle.symptom_pattern) parts.push(`Symptom Pattern: ${newAngle.symptom_pattern}`);
      if (newAngle.objection) parts.push(`Objection: ${newAngle.objection}`);
      if (newAngle.scene) parts.push(`Scene: ${newAngle.scene}`);
      if (newAngle.desired_belief_shift) parts.push(`Desired Belief Shift: ${newAngle.desired_belief_shift}`);
      description = parts.join('\n');
    }
    if (!description) return;
    try {
      await api.createConductorAngle(selectedProject, {
        name: newAngle.name,
        description,
        prompt_hints: newAngle.prompt_hints || undefined,
        source: 'manual',
        status: 'active',
        priority: newAngle.priority || undefined,
        frame: newAngle.frame || undefined,
        core_buyer: newAngle.core_buyer || undefined,
        symptom_pattern: newAngle.symptom_pattern || undefined,
        failed_solutions: newAngle.failed_solutions || undefined,
        current_belief: newAngle.current_belief || undefined,
        objection: newAngle.objection || undefined,
        emotional_state: newAngle.emotional_state || undefined,
        scene: newAngle.scene || undefined,
        desired_belief_shift: newAngle.desired_belief_shift || undefined,
        tone: newAngle.tone || undefined,
        avoid_list: newAngle.avoid_list || undefined,
      });
      setNewAngle({ name: '', description: '', prompt_hints: '', priority: 'medium', frame: 'symptom-first', core_buyer: '', symptom_pattern: '', failed_solutions: '', current_belief: '', objection: '', emotional_state: '', scene: '', desired_belief_shift: '', tone: '', avoid_list: '' });
      setShowAddAngle(false);
      const angRes = await api.getConductorAngles(selectedProject);
      setAngles(angRes?.angles || []);
    } catch { /* ignore */ }
  };

  const handleAngleStatusChange = async (angleId, newStatus) => {
    try {
      await api.updateConductorAngle(selectedProject, angleId, { status: newStatus });
      setAngles(prev => prev.map(a => a.externalId === angleId ? { ...a, status: newStatus } : a));
    } catch { /* ignore */ }
  };

  const handleToggleFocus = async (angleId, focused) => {
    try {
      await api.updateConductorAngle(selectedProject, angleId, { focused });
      setAngles(prev => prev.map(a => a.externalId === angleId ? { ...a, focused } : a));
    } catch { /* ignore */ }
  };

  const handleToggleLPEnabled = async (angleId, lpEnabled) => {
    try {
      await api.updateConductorAngle(selectedProject, angleId, { lp_enabled: lpEnabled });
      setAngles(prev => prev.map(a => a.externalId === angleId ? { ...a, lp_enabled: lpEnabled } : a));
    } catch (err) {
      console.error('[AgentMonitor] Failed to toggle LP enabled:', err);
    }
  };

  const handleToggleAllLP = async (lpEnabled) => {
    const active = angles.filter(a => a.status === 'active');
    // Optimistic update
    setAngles(prev => prev.map(a => a.status === 'active' ? { ...a, lp_enabled: lpEnabled } : a));
    // Fire all API calls in parallel
    await Promise.allSettled(
      active.map(a => api.updateConductorAngle(selectedProject, a.externalId, { lp_enabled: lpEnabled }))
    );
  };

  // --- Export angles as markdown ---
  const handleDownloadAngles = () => {
    if (angles.length === 0) return;
    const grouped = { active: [], testing: [], archived: [] };
    angles.forEach(a => {
      const bucket = a.status === 'retired' ? grouped.archived : (grouped[a.status] || grouped.active);
      bucket.push(a);
    });

    let md = '# Angles\n\n';
    const writeSection = (list) => {
      list.forEach(a => {
        md += `## ${a.name}\n`;
        md += `- **Status**: ${a.status || 'active'}\n`;
        md += `- **Source**: ${a.source || 'manual'}\n`;
        md += `- **Focused**: ${a.focused ? 'yes' : 'no'}\n`;
        if (a.prompt_hints) md += `- **Prompt Hints**: ${a.prompt_hints}\n`;
        if (a.performance_note) md += `- **Performance Note**: ${a.performance_note}\n`;
        md += `\n${a.description || ''}\n\n---\n\n`;
      });
    };
    if (grouped.active.length) { md += '<!-- Active -->\n\n'; writeSection(grouped.active); }
    if (grouped.testing.length) { md += '<!-- Testing -->\n\n'; writeSection(grouped.testing); }
    if (grouped.archived.length) { md += '<!-- Archived -->\n\n'; writeSection(grouped.archived); }

    const blob = new Blob([md.trim() + '\n'], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'angles-export.md';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // --- Parse markdown into angle objects (supports both old flat + new structured formats) ---
  const SECTION_MAP = {
    'core buyer': 'core_buyer',
    'symptom pattern': 'symptom_pattern',
    'failed solutions': 'failed_solutions',
    'current belief': 'current_belief',
    'objection': 'objection',
    'emotional state': 'emotional_state',
    'scene to center the ad on': 'scene',
    'desired belief shift': 'desired_belief_shift',
    'tone': 'tone',
    'avoid': 'avoid_list',
  };

  const parseAnglesMarkdown = (text) => {
    // Split by --- separators (new format) or ## headings (old format)
    const hasStructuredSections = text.includes('### Core Buyer') || text.includes('### Symptom Pattern');

    if (hasStructuredSections) {
      // New structured format: split by --- separators
      const blocks = text.split(/\n---\n/).map(b => b.trim()).filter(Boolean);
      const parsed = [];
      for (const block of blocks) {
        const titleMatch = block.match(/^##\s+(.+)/m);
        if (!titleMatch) continue;
        const name = titleMatch[1].trim();
        // Skip meta sections
        if (name.startsWith('Removed from') || name === 'De-prioritized or Removed' ||
            name.startsWith('Notes for System') || name.startsWith('Best categories') ||
            name.startsWith('What should') || name.startsWith('Strong output') ||
            name.startsWith('Weak output')) continue;

        const angle = { name, source: 'imported', status: 'active' };

        // Extract metadata bullets
        const statusMatch = block.match(/\*\*Status\*\*:\s*(.+)/i);
        if (statusMatch) angle.status = statusMatch[1].trim().toLowerCase();
        const priorityMatch = block.match(/\*\*Priority\*\*:\s*(.+)/i);
        if (priorityMatch) angle.priority = priorityMatch[1].trim().toLowerCase();
        const frameMatch = block.match(/\*\*Frame\*\*:\s*(.+)/i);
        if (frameMatch) angle.frame = frameMatch[1].trim().toLowerCase();

        // Extract ### sections
        const sectionRegex = /###\s+(.+)\n([\s\S]*?)(?=###|\n---|\n##|$)/g;
        let match;
        while ((match = sectionRegex.exec(block)) !== null) {
          const sectionTitle = match[1].trim().toLowerCase();
          const sectionContent = match[2].trim();
          const fieldKey = SECTION_MAP[sectionTitle];
          if (fieldKey && sectionContent) angle[fieldKey] = sectionContent;
        }

        // Auto-compute description from structured fields
        const descParts = [];
        if (angle.core_buyer) descParts.push(`Core Buyer: ${angle.core_buyer}`);
        if (angle.symptom_pattern) descParts.push(`Symptom Pattern: ${angle.symptom_pattern}`);
        if (angle.objection) descParts.push(`Objection: ${angle.objection}`);
        if (angle.scene) descParts.push(`Scene: ${angle.scene}`);
        if (angle.desired_belief_shift) descParts.push(`Desired Belief Shift: ${angle.desired_belief_shift}`);
        angle.description = descParts.length > 0 ? descParts.join('\n') : 'No structured brief provided.';

        if (angle.name && (angle.core_buyer || angle.symptom_pattern)) parsed.push(angle);
      }
      return parsed;
    }

    // Old flat format fallback
    const sections = text.split(/\n## /).slice(1);
    const parsed = [];
    for (const section of sections) {
      const lines = section.split('\n');
      const name = lines[0].trim();
      if (!name) continue;

      let status = 'active', source = 'manual', focused = false, promptHints = '', performanceNote = '';
      const descLines = [];
      let pastMeta = false;

      for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        const metaMatch = line.match(/^- \*\*(.+?)\*\*:\s*(.+)/);
        if (metaMatch && !pastMeta) {
          const key = metaMatch[1].toLowerCase();
          const val = metaMatch[2].trim();
          if (key === 'status') status = val.toLowerCase();
          else if (key === 'source') source = val.toLowerCase();
          else if (key === 'focused') focused = val.toLowerCase() === 'yes';
          else if (key === 'prompt hints') promptHints = val;
          else if (key === 'performance note') performanceNote = val;
        } else {
          pastMeta = true;
          if (line.trim() !== '---') descLines.push(line);
        }
      }
      const description = descLines.join('\n').trim();
      if (!description) continue;

      parsed.push({ name, description, status, source, focused, prompt_hints: promptHints, performance_note: performanceNote });
    }
    return parsed;
  };

  // --- Handle file read for import ---
  const handleImportFile = (file) => {
    if (!file || !file.name.endsWith('.md')) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target.result;
      const parsed = parseAnglesMarkdown(text);
      const existingNames = new Set(angles.map(a => a.name.toLowerCase()));
      const newAngles = parsed.filter(a => !existingNames.has(a.name.toLowerCase()));
      const skipped = parsed.filter(a => existingNames.has(a.name.toLowerCase()));
      setImportResult({ newAngles, skipped });
    };
    reader.readAsText(file);
  };

  const handleConfirmImport = async () => {
    if (!importResult?.newAngles?.length) return;
    setImporting(true);
    try {
      for (const angle of importResult.newAngles) {
        await api.createConductorAngle(selectedProject, {
          name: angle.name,
          description: angle.description,
          prompt_hints: angle.prompt_hints || undefined,
          source: angle.source || 'imported',
          status: angle.status || 'active',
          priority: angle.priority || undefined,
          frame: angle.frame || undefined,
          core_buyer: angle.core_buyer || undefined,
          symptom_pattern: angle.symptom_pattern || undefined,
          failed_solutions: angle.failed_solutions || undefined,
          current_belief: angle.current_belief || undefined,
          objection: angle.objection || undefined,
          emotional_state: angle.emotional_state || undefined,
          scene: angle.scene || undefined,
          desired_belief_shift: angle.desired_belief_shift || undefined,
          tone: angle.tone || undefined,
          avoid_list: angle.avoid_list || undefined,
        });
      }
      const angRes = await api.getConductorAngles(selectedProject);
      setAngles(angRes?.angles || []);
      setImportResult(null);
      setShowImport(false);
    } catch { /* ignore */ }
    finally { setImporting(false); }
  };

  if (loading) return <div className="text-[11px] text-textlight py-4">Loading...</div>;

  const subTabs = [
    { id: 'angles', label: 'Angles' },
    { id: 'playbooks', label: 'Playbooks' },
    { id: 'settings', label: 'Settings' },
    { id: 'history', label: 'Run History' },
  ];

  const activeAngles = angles.filter(a => a.status === 'active');
  const testingAngles = angles.filter(a => a.status === 'testing');
  const archivedAngles = angles.filter(a => a.status === 'archived' || a.status === 'retired');

  return (
    <div>
      {/* Project selector + controls */}
      <div className="flex items-center gap-3 mb-4">
        <select
          value={selectedProject}
          onChange={e => setSelectedProject(e.target.value)}
          className="text-[12px] text-textdark bg-offwhite border border-black/10 rounded-lg px-3 py-1.5 cursor-pointer"
        >
          {projects.map(p => (
            <option key={p.id} value={p.id}>{p.brand_name || p.name}</option>
          ))}
        </select>

        <label className="flex items-center gap-2 text-[11px] text-textmid cursor-pointer">
          <div
            onClick={() => handleSaveConfig({ enabled: !config?.enabled })}
            className={`relative w-7 h-4 rounded-full transition-colors duration-200 cursor-pointer ${config?.enabled ? 'bg-teal/30' : 'bg-black/10'}`}
          >
            <div className={`absolute top-0.5 w-3 h-3 rounded-full transition-all duration-200 shadow-sm ${config?.enabled ? 'left-3.5 bg-teal' : 'left-0.5 bg-textlight'}`} />
          </div>
          Enabled
        </label>

        <button
          onClick={handleTestRun}
          disabled={!!runningAction}
          className="btn-primary text-[11px] px-3 py-1.5 flex items-center gap-1 disabled:opacity-50 ml-auto"
        >
          {runningAction === 'run' ? <><Spinner /> Running...</> : <>Test Run</>}
        </button>
      </div>

      {/* Quick stats */}
      <div className="grid grid-cols-4 gap-2 mb-4">
        <StatCell value={config?.daily_flex_target ?? 5} label="Daily Target" color="text-textdark" />
        <StatCell value={config?.ads_per_batch || 18} label="Ads/Batch" color="text-textdark" />
        <StatCell value={activeAngles.length} label="Angles" color="text-navy" />
        <StatCell value={runs.length > 0 ? runs.filter(r => r.status === 'completed').length : 0} label="Runs" color="text-teal" />
      </div>

      {/* Sub-tabs */}
      <div className="flex gap-1 mb-4 border-b border-black/5">
        {subTabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setSubTab(tab.id)}
            className={`text-[11px] font-medium py-2 px-3 border-b-2 transition-colors ${
              subTab === tab.id
                ? 'border-navy text-navy'
                : 'border-transparent text-textmid hover:text-textdark'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Sub-tab content */}
      {subTab === 'angles' && (
        <div>
          {/* Focus mode banner */}
          {activeAngles.some(a => a.focused) && (
            <div className="mb-3 flex items-center gap-2 px-3 py-2 rounded-lg bg-gold/10 border border-gold/20">
              <svg className="w-3.5 h-3.5 text-gold flex-shrink-0" fill="currentColor" viewBox="0 0 24 24">
                <path d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
              </svg>
              <span className="text-[11px] text-gold/90 font-medium">Focus mode — Director will only use focused angles</span>
            </div>
          )}

          {/* Export / Import toolbar */}
          <div className="flex items-center gap-2 mb-3">
            <button
              onClick={handleDownloadAngles}
              disabled={angles.length === 0}
              className="btn-secondary text-[11px] px-3 py-1.5 flex items-center gap-1.5 disabled:opacity-40"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5m0 0l5-5m-5 5V3" /></svg>
              Export
            </button>
            <button
              onClick={() => { setShowImport(!showImport); setImportResult(null); }}
              className={`btn-secondary text-[11px] px-3 py-1.5 flex items-center gap-1.5 ${showImport ? 'ring-1 ring-navy/30' : ''}`}
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M17 8l-5-5m0 0L7 8m5-5v12" /></svg>
              Import
            </button>
          </div>

          {/* Import panel */}
          {showImport && (
            <div className="mb-4 rounded-xl bg-offwhite border border-black/10 p-4">
              {!importResult ? (
                <>
                  <p className="text-[12px] font-medium text-textdark mb-2">Import Angles from Markdown</p>
                  <p className="text-[10px] text-textmid mb-3">Upload a .md file with angles formatted as ## sections. Existing angles (matched by name) will be skipped.</p>
                  <div
                    onClick={() => importFileRef.current?.click()}
                    onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setImportDragOver(true); }}
                    onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); setImportDragOver(true); }}
                    onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); setImportDragOver(false); }}
                    onDrop={(e) => {
                      e.preventDefault(); e.stopPropagation(); setImportDragOver(false);
                      const file = e.dataTransfer?.files?.[0];
                      if (file) handleImportFile(file);
                    }}
                    className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-all ${
                      importDragOver ? 'border-gold bg-gold/5' : 'border-gray-300 hover:border-gold hover:bg-offwhite'
                    }`}
                  >
                    <div className="text-2xl text-gray-400 mb-2">{importDragOver ? '📂' : '📄'}</div>
                    <p className={`text-[12px] font-medium ${importDragOver ? 'text-gold' : 'text-textmid'}`}>
                      {importDragOver ? 'Drop file here' : 'Drop your .md file here, or click to browse'}
                    </p>
                    <p className="text-[10px] text-gray-400 mt-1">Markdown files only (.md)</p>
                  </div>
                  <input
                    ref={importFileRef}
                    type="file"
                    accept=".md"
                    onChange={(e) => { const file = e.target.files?.[0]; if (file) handleImportFile(file); e.target.value = ''; }}
                    className="hidden"
                  />
                </>
              ) : (
                <>
                  <p className="text-[12px] font-medium text-textdark mb-2">Import Preview</p>
                  {importResult.newAngles.length > 0 ? (
                    <div className="mb-3">
                      <p className="text-[11px] text-teal font-medium mb-1.5">{importResult.newAngles.length} new angle{importResult.newAngles.length !== 1 ? 's' : ''} to import:</p>
                      <div className="space-y-1 max-h-40 overflow-y-auto">
                        {importResult.newAngles.map((a, i) => (
                          <div key={i} className="text-[11px] text-textdark bg-teal/5 rounded px-2.5 py-1.5 border border-teal/10">
                            <span className="font-medium">{a.name}</span>
                            <span className="text-textmid ml-2">{a.description.slice(0, 80)}{a.description.length > 80 ? '...' : ''}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <p className="text-[11px] text-textmid mb-3">No new angles found — all angles in the file already exist.</p>
                  )}
                  {importResult.skipped.length > 0 && (
                    <p className="text-[10px] text-textlight mb-3">{importResult.skipped.length} angle{importResult.skipped.length !== 1 ? 's' : ''} skipped (already exist)</p>
                  )}
                  <div className="flex gap-2">
                    {importResult.newAngles.length > 0 && (
                      <button onClick={handleConfirmImport} disabled={importing} className="btn-primary text-[11px] px-3 py-1.5 disabled:opacity-50">
                        {importing ? 'Importing...' : `Import ${importResult.newAngles.length} Angle${importResult.newAngles.length !== 1 ? 's' : ''}`}
                      </button>
                    )}
                    <button onClick={() => { setImportResult(null); setShowImport(false); }} className="btn-secondary text-[11px] px-3 py-1.5">Cancel</button>
                    {!importing && importResult.newAngles.length === 0 && (
                      <button onClick={() => setImportResult(null)} className="btn-secondary text-[11px] px-3 py-1.5">Try Another File</button>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {/* Active angles */}
          {activeAngles.length > 0 && (
            <div className="mb-4">
              <div className="flex items-center justify-between mb-2">
                <p className="text-[10px] text-textlight font-medium uppercase tracking-wider">Active</p>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] text-textmid">Generate landing pages for all angles</span>
                  <button
                    onClick={() => handleToggleAllLP(!activeAngles.every(a => a.lp_enabled))}
                    title={activeAngles.every(a => a.lp_enabled) ? 'Disable LPs for all angles' : 'Enable LPs for all angles'}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                      activeAngles.every(a => a.lp_enabled) ? 'bg-teal' : 'bg-gray-200'
                    }`}
                  >
                    <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
                      activeAngles.every(a => a.lp_enabled) ? 'translate-x-[18px]' : 'translate-x-[3px]'
                    }`} />
                  </button>
                </div>
              </div>
              <div className="space-y-2">
                {activeAngles.map(a => (
                  <AngleCard key={a.externalId} angle={a} playbooks={playbooks} onStatusChange={handleAngleStatusChange} onToggleFocus={handleToggleFocus} onToggleLPEnabled={handleToggleLPEnabled} />
                ))}
              </div>
            </div>
          )}

          {/* Testing angles */}
          {testingAngles.length > 0 && (
            <div className="mb-4">
              <p className="text-[10px] text-textlight font-medium uppercase tracking-wider mb-2">Testing (auto-generated)</p>
              <div className="space-y-2">
                {testingAngles.map(a => (
                  <AngleCard key={a.externalId} angle={a} playbooks={playbooks} onStatusChange={handleAngleStatusChange} showActions />
                ))}
              </div>
            </div>
          )}

          {/* Archived — collapsible */}
          {archivedAngles.length > 0 && (
            <div className="mb-4">
              <button
                onClick={() => setArchivedOpen(v => !v)}
                className="flex items-center gap-1.5 mb-2 group cursor-pointer"
              >
                <svg className={`w-3 h-3 text-textlight transition-transform ${archivedOpen ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
                <p className="text-[10px] text-textlight font-medium uppercase tracking-wider group-hover:text-textmid transition-colors">Archived ({archivedAngles.length})</p>
              </button>
              {archivedOpen && (
                <div className="space-y-2">
                  {archivedAngles.map(a => (
                    <AngleCard key={a.externalId} angle={a} playbooks={playbooks} onStatusChange={handleAngleStatusChange} />
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Add angle */}
          {showAddAngle ? (
            <div className="rounded-xl bg-offwhite border border-black/10 p-4 mt-2">
              <p className="text-[12px] font-medium text-textdark mb-3">New Angle (Creative Brief)</p>
              <input
                type="text"
                placeholder="Angle name (e.g., Broken Sleep / Wake Up at 2 to 4 AM)"
                value={newAngle.name}
                onChange={e => setNewAngle(prev => ({ ...prev, name: e.target.value }))}
                className="input-apple w-full mb-2 text-[12px]"
              />
              <div className="grid grid-cols-2 gap-2 mb-2">
                <select value={newAngle.priority} onChange={e => setNewAngle(prev => ({ ...prev, priority: e.target.value }))} className="input-apple text-[12px]">
                  <option value="highest">Priority: Highest</option>
                  <option value="high">Priority: High</option>
                  <option value="medium">Priority: Medium</option>
                  <option value="test">Priority: Test</option>
                </select>
                <select value={newAngle.frame} onChange={e => setNewAngle(prev => ({ ...prev, frame: e.target.value }))} className="input-apple text-[12px]">
                  <option value="symptom-first">Frame: Symptom-first</option>
                  <option value="scam">Frame: Scam</option>
                  <option value="objection-first">Frame: Objection-first</option>
                  <option value="identity-first">Frame: Identity-first</option>
                  <option value="MAHA">Frame: MAHA</option>
                  <option value="news-first">Frame: News-first</option>
                  <option value="consequence-first">Frame: Consequence-first</option>
                </select>
              </div>
              <textarea placeholder="Core Buyer — who is this ad for?" value={newAngle.core_buyer} onChange={e => setNewAngle(prev => ({ ...prev, core_buyer: e.target.value }))} className="input-apple w-full mb-2 text-[12px] h-14 resize-none" />
              <textarea placeholder="Symptom Pattern — what specific experience?" value={newAngle.symptom_pattern} onChange={e => setNewAngle(prev => ({ ...prev, symptom_pattern: e.target.value }))} className="input-apple w-full mb-2 text-[12px] h-14 resize-none" />
              <textarea placeholder="Failed Solutions — what have they already tried?" value={newAngle.failed_solutions} onChange={e => setNewAngle(prev => ({ ...prev, failed_solutions: e.target.value }))} className="input-apple w-full mb-2 text-[12px] h-14 resize-none" />
              <textarea placeholder="Current Belief — what do they believe now?" value={newAngle.current_belief} onChange={e => setNewAngle(prev => ({ ...prev, current_belief: e.target.value }))} className="input-apple w-full mb-2 text-[12px] h-14 resize-none" />
              <textarea placeholder="Objection — primary resistance to the product" value={newAngle.objection} onChange={e => setNewAngle(prev => ({ ...prev, objection: e.target.value }))} className="input-apple w-full mb-2 text-[12px] h-14 resize-none" />
              <textarea placeholder="Emotional State — how do they feel right now?" value={newAngle.emotional_state} onChange={e => setNewAngle(prev => ({ ...prev, emotional_state: e.target.value }))} className="input-apple w-full mb-2 text-[12px] h-14 resize-none" />
              <textarea placeholder="Scene — the specific moment the ad centers on" value={newAngle.scene} onChange={e => setNewAngle(prev => ({ ...prev, scene: e.target.value }))} className="input-apple w-full mb-2 text-[12px] h-14 resize-none" />
              <textarea placeholder="Desired Belief Shift — what should they believe after?" value={newAngle.desired_belief_shift} onChange={e => setNewAngle(prev => ({ ...prev, desired_belief_shift: e.target.value }))} className="input-apple w-full mb-2 text-[12px] h-14 resize-none" />
              <div className="grid grid-cols-2 gap-2 mb-2">
                <input type="text" placeholder="Tone (e.g., Calm, specific, skeptical-friendly)" value={newAngle.tone} onChange={e => setNewAngle(prev => ({ ...prev, tone: e.target.value }))} className="input-apple text-[12px]" />
                <input type="text" placeholder="Avoid (e.g., Generic insomnia language, young models)" value={newAngle.avoid_list} onChange={e => setNewAngle(prev => ({ ...prev, avoid_list: e.target.value }))} className="input-apple text-[12px]" />
              </div>
              <textarea placeholder="Prompt hints — additional creative direction (optional)" value={newAngle.prompt_hints} onChange={e => setNewAngle(prev => ({ ...prev, prompt_hints: e.target.value }))} className="input-apple w-full mb-3 text-[12px] h-14 resize-none" />
              <div className="flex gap-2">
                <button onClick={handleAddAngle} className="btn-primary text-[11px] px-3 py-1.5">Save Angle</button>
                <button onClick={() => setShowAddAngle(false)} className="btn-secondary text-[11px] px-3 py-1.5">Cancel</button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setShowAddAngle(true)}
              className="btn-secondary text-[11px] px-3 py-1.5 mt-1"
            >
              + Add Angle
            </button>
          )}
        </div>
      )}

      {subTab === 'playbooks' && (
        <div>
          {playbooks.length === 0 ? (
            <p className="text-[11px] text-textlight py-4">No playbooks yet. Playbooks are created automatically after the Creative Filter scores batches for each angle.</p>
          ) : (
            <div className="space-y-3">
              {playbooks.map(pb => (
                <div key={pb.angle_name} className="rounded-xl bg-black/[0.02] border border-black/5 p-4">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-[13px] font-medium text-textdark">{pb.angle_name}</p>
                    <span className="text-[10px] text-textmid">v{pb.version} {'\u2022'} {Math.round((pb.pass_rate || 0) * 100)}% pass rate</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 mb-2">
                    <StatCell value={pb.total_scored || 0} label="Scored" color="text-textdark" />
                    <StatCell value={pb.total_passed || 0} label="Passed" color="text-teal" />
                  </div>
                  {pb.visual_patterns && (
                    <div className="mb-1.5">
                      <p className="text-[10px] text-textmid font-medium">Visual Patterns</p>
                      <p className="text-[11px] text-textdark leading-relaxed">{pb.visual_patterns}</p>
                    </div>
                  )}
                  {pb.copy_patterns && (
                    <div className="mb-1.5">
                      <p className="text-[10px] text-textmid font-medium">Copy Patterns</p>
                      <p className="text-[11px] text-textdark leading-relaxed">{pb.copy_patterns}</p>
                    </div>
                  )}
                  {pb.avoid_patterns && (
                    <div className="mb-1.5">
                      <p className="text-[10px] text-gold font-medium">Avoid</p>
                      <p className="text-[11px] text-textdark leading-relaxed">{pb.avoid_patterns}</p>
                    </div>
                  )}
                  {pb.generation_hints && (
                    <div>
                      <p className="text-[10px] text-teal font-medium">Generation Hints</p>
                      <p className="text-[11px] text-textdark leading-relaxed">{pb.generation_hints}</p>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {subTab === 'settings' && config && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-[11px] text-textmid font-medium block mb-1">Daily Flex Ad Target</label>
              <input
                type="number"
                min="0"
                max="20"
                value={config.daily_flex_target ?? 5}
                onChange={e => handleSaveConfig({ daily_flex_target: parseInt(e.target.value) ?? 5 })}
                className="input-apple w-full text-[12px]"
              />
            </div>
            <div>
              <label className="text-[11px] text-textmid font-medium block mb-1">Ads Per Batch</label>
              <input
                type="number"
                min="6"
                max="30"
                value={config.ads_per_batch || 18}
                onChange={e => handleSaveConfig({ ads_per_batch: parseInt(e.target.value) || 18 })}
                className="input-apple w-full text-[12px]"
              />
              <p className="text-[9px] text-textlight mt-0.5">Auto-adjusts with learning</p>
            </div>
          </div>

          <div>
            <label className="text-[11px] text-textmid font-medium block mb-1">Angle Mode</label>
            <div className="flex gap-3">
              {['manual', 'auto', 'mixed'].map(mode => (
                <label key={mode} className="flex items-center gap-1.5 text-[11px] text-textdark cursor-pointer">
                  <input
                    type="radio"
                    name="angle_mode"
                    checked={config.angle_mode === mode}
                    onChange={() => handleSaveConfig({ angle_mode: mode })}
                    className="accent-navy"
                  />
                  {mode.charAt(0).toUpperCase() + mode.slice(1)}
                </label>
              ))}
            </div>
          </div>

          {config.angle_mode === 'mixed' && (
            <div>
              <label className="text-[11px] text-textmid font-medium block mb-1">Explore Ratio</label>
              <input
                type="number"
                min="0"
                max="1"
                step="0.1"
                value={config.explore_ratio || 0.2}
                onChange={e => handleSaveConfig({ explore_ratio: parseFloat(e.target.value) || 0.2 })}
                className="input-apple w-24 text-[12px]"
              />
              <p className="text-[9px] text-textlight mt-0.5">Fraction of batches using auto-generated angles</p>
            </div>
          )}

          <div>
            <label className="text-[11px] text-textmid font-medium block mb-1">Rotation Strategy</label>
            <select
              value={config.angle_rotation || 'round_robin'}
              onChange={e => handleSaveConfig({ angle_rotation: e.target.value })}
              className="text-[12px] text-textdark bg-offwhite border border-black/10 rounded-lg px-3 py-1.5 cursor-pointer"
            >
              <option value="round_robin">Round Robin</option>
              <option value="weighted">Weighted (favor least-used)</option>
              <option value="random">Random (weighted)</option>
            </select>
          </div>

          <div>
            <label className="text-[11px] text-textmid font-medium block mb-1">Headline Style (optional)</label>
            <input
              type="text"
              placeholder="e.g., Short, punchy, curiosity-driven"
              value={config.headline_style || ''}
              onChange={e => handleSaveConfig({ headline_style: e.target.value })}
              className="input-apple w-full text-[12px]"
            />
          </div>

          <div>
            <label className="text-[11px] text-textmid font-medium block mb-1">Primary Text Style (optional)</label>
            <input
              type="text"
              placeholder="e.g., Story-based, emotional, 3 paragraphs"
              value={config.primary_text_style || ''}
              onChange={e => handleSaveConfig({ primary_text_style: e.target.value })}
              className="input-apple w-full text-[12px]"
            />
          </div>

          <div>
            <label className="text-[11px] text-textmid font-medium block mb-1">Default Campaign for Auto-Deployed Ads</label>
            {campaigns.length > 0 ? (
              <select
                value={config.default_campaign_id || ''}
                onChange={e => handleSaveConfig({ default_campaign_id: e.target.value })}
                className="text-[12px] text-textdark bg-offwhite border border-black/10 rounded-lg px-3 py-1.5 cursor-pointer w-full"
              >
                <option value="">Select a campaign...</option>
                {campaigns.map(c => (
                  <option key={c.externalId || c.id} value={c.externalId || c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            ) : (
              <p className="text-[11px] text-textlight">No campaigns found — create one in the project's Creative Filter settings or Ad Pipeline tab first.</p>
            )}
            <p className="text-[9px] text-textlight mt-0.5">Flex ads from the Director pipeline will auto-deploy to this campaign</p>
          </div>

          {saving && <p className="text-[10px] text-textlight">Saving...</p>}
        </div>
      )}

      {subTab === 'history' && (
        <div>
          {runs.length === 0 ? (
            <p className="text-[11px] text-textlight py-4">No runs yet. Click "Test Run" to trigger the Director, or wait for the next scheduled run.</p>
          ) : (
            <div className="space-y-2">
              {runs.map(run => (
                <div key={run.externalId} className="rounded-lg bg-black/[0.02] border border-black/5 p-3">
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                        run.status === 'completed' ? 'bg-teal/10 text-teal' :
                        run.status === 'failed' ? 'bg-red-50 text-red-400' :
                        'bg-gold/10 text-gold'
                      }`}>
                        {run.status}
                      </span>
                      <span className="text-[10px] text-textlight">{run.run_type}</span>
                    </div>
                    <span className="text-[10px] text-textlight">{timeAgo(new Date(run.run_at).toISOString())}</span>
                  </div>
                  {run.decisions && (
                    <p className="text-[11px] text-textdark leading-relaxed">{run.decisions}</p>
                  )}
                  {run.error && (
                    <p className="text-[11px] text-red-400 leading-relaxed mt-1">{run.error}</p>
                  )}
                  {run.duration_ms && (
                    <p className="text-[9px] text-textlight mt-1">{Math.round(run.duration_ms / 1000)}s</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// =============================================
// Angle Card
// =============================================
function AngleCard({ angle, playbooks, onStatusChange, onToggleFocus, onToggleLPEnabled, showActions }) {
  const pb = playbooks.find(p => p.angle_name === angle.name);
  const [expanded, setExpanded] = useState(false);
  const hasStructured = !!(angle.core_buyer || angle.symptom_pattern || angle.scene);

  const PRIORITY_COLORS = { highest: 'bg-red-100 text-red-700', high: 'bg-gold/15 text-gold', medium: 'bg-navy/10 text-navy', test: 'bg-gray-100 text-textmid' };
  const FRAME_COLORS = { 'symptom-first': 'bg-teal/10 text-teal', 'scam': 'bg-red-50 text-red-600', 'objection-first': 'bg-amber-50 text-amber-700', 'identity-first': 'bg-purple-50 text-purple-600', 'MAHA': 'bg-blue-50 text-blue-600', 'news-first': 'bg-indigo-50 text-indigo-600', 'consequence-first': 'bg-orange-50 text-orange-600' };

  return (
    <div className={`rounded-lg border ${angle.focused ? 'bg-gold/5 border-gold/30' : 'bg-white/60 border-black/5'}`}>
      {/* Clickable header row */}
      <div
        className="flex items-center justify-between p-3 cursor-pointer select-none"
        onClick={() => hasStructured && setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2 flex-wrap min-w-0">
          {angle.status === 'active' && onToggleFocus && (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleFocus(angle.externalId, !angle.focused); }}
              title={angle.focused ? 'Remove focus' : 'Focus on this angle'}
              className={`transition-colors flex-shrink-0 ${angle.focused ? 'text-gold' : 'text-textlight/40 hover:text-gold/60'}`}
            >
              <svg className="w-3.5 h-3.5" fill={angle.focused ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
              </svg>
            </button>
          )}
          {!(angle.status === 'active' && onToggleFocus) && (
            <span className="text-[11px] flex-shrink-0">{'\u25CF'}</span>
          )}
          {hasStructured && (
            <span className={`text-[11px] text-textlight flex-shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}>&#9656;</span>
          )}
          <span className="text-[13px] font-medium text-textdark">{angle.name}</span>
          {angle.focused && <span className="text-[9px] font-medium text-gold uppercase tracking-wider">Focused</span>}
          {angle.priority && <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded ${PRIORITY_COLORS[angle.priority] || 'bg-gray-100 text-gray-600'}`}>{angle.priority}</span>}
          {angle.frame && <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded ${FRAME_COLORS[angle.frame] || 'bg-gray-100 text-gray-600'}`}>{angle.frame}</span>}
          <span className="text-[10px] text-textlight">used {angle.times_used || 0}x</span>
          {pb && (
            <span className="text-[10px] text-textmid">
              pass: {Math.round((pb.pass_rate || 0) * 100)}%
              {pb.pass_rate > 0.6 ? ' \u2191' : pb.pass_rate < 0.4 ? ' \u2193' : ''}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
          {showActions && (
            <div className="flex gap-1">
              <button onClick={() => onStatusChange(angle.externalId, 'active')} className="text-[10px] text-teal hover:underline">Activate</button>
              <button onClick={() => onStatusChange(angle.externalId, 'archived')} className="text-[10px] text-red-400 hover:underline ml-2">Archive</button>
            </div>
          )}
          {!showActions && angle.status === 'active' && (
            <button onClick={() => onStatusChange(angle.externalId, 'archived')} className="text-[10px] text-textlight hover:text-red-400">Archive</button>
          )}
          {!showActions && (angle.status === 'archived' || angle.status === 'retired') && (
            <button onClick={() => onStatusChange(angle.externalId, 'active')} className="text-[10px] text-teal hover:underline">Unarchive</button>
          )}
        </div>
      </div>

      {/* Collapsed: show description for flat angles only */}
      {!expanded && !hasStructured && (
        <p className="text-[11px] text-textmid leading-relaxed px-3 pb-3">{angle.description}</p>
      )}

      {/* Expanded: show full structured brief */}
      {expanded && hasStructured && (
        <div className="px-3 pb-3 pt-1 border-t border-black/5 space-y-2 text-[12px]">
          {angle.core_buyer && <div><span className="font-semibold text-textdark">Core Buyer:</span> <span className="text-textmid">{angle.core_buyer}</span></div>}
          {angle.symptom_pattern && <div><span className="font-semibold text-textdark">Symptom Pattern:</span> <span className="text-textmid">{angle.symptom_pattern}</span></div>}
          {angle.failed_solutions && <div><span className="font-semibold text-textdark">Failed Solutions:</span> <span className="text-textmid">{angle.failed_solutions}</span></div>}
          {angle.current_belief && <div><span className="font-semibold text-textdark">Current Belief:</span> <span className="text-textmid">{angle.current_belief}</span></div>}
          {angle.objection && <div><span className="font-semibold text-textdark">Objection:</span> <span className="text-textmid">{angle.objection}</span></div>}
          {angle.emotional_state && <div><span className="font-semibold text-textdark">Emotional State:</span> <span className="text-textmid">{angle.emotional_state}</span></div>}
          {angle.scene && <div><span className="font-semibold text-textdark">Scene:</span> <span className="text-textmid italic">{angle.scene}</span></div>}
          {angle.desired_belief_shift && <div><span className="font-semibold text-textdark">Belief Shift:</span> <span className="text-textmid italic">"{angle.desired_belief_shift}"</span></div>}
          {angle.tone && <div><span className="font-semibold text-textdark">Tone:</span> <span className="text-textmid">{angle.tone}</span></div>}
          {angle.avoid_list && <div><span className="font-semibold text-textdark">Avoid:</span> <span className="text-red-500">{angle.avoid_list}</span></div>}
          {angle.prompt_hints && <div><span className="font-semibold text-textdark">Prompt Hints:</span> <span className="text-textmid">{angle.prompt_hints}</span></div>}
        </div>
      )}

      {pb && pb.generation_hints && (
        <p className="text-[10px] text-teal mt-1 leading-relaxed">
          Playbook v{pb.version}: "{pb.generation_hints.slice(0, 120)}{pb.generation_hints.length > 120 ? '...' : ''}"
        </p>
      )}
      {onToggleLPEnabled && angle.status === 'active' && (
        <div className="flex items-center justify-end gap-2 mt-2 pt-2 border-t border-black/5">
          <span className="text-[10px] text-textmid">Generate landing pages</span>
          <button
            onClick={() => onToggleLPEnabled(angle.externalId, !angle.lp_enabled)}
            title={angle.lp_enabled ? 'Disable LP generation for this angle' : 'Enable LP generation for this angle'}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
              angle.lp_enabled ? 'bg-teal' : 'bg-gray-200'
            }`}
          >
            <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
              angle.lp_enabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
            }`} />
          </button>
        </div>
      )}
    </div>
  );
}

// =============================================
// Agent Panel Wrapper
// =============================================
function AgentPanel({ children, icon, name, subtitle, status, paused, onTogglePause, togglingPause }) {
  const statusCfg = STATUS_CONFIG[status] || STATUS_CONFIG.offline;

  return (
    <div>
      {/* Agent header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2.5">
          <div className="w-6 h-6 rounded-md bg-navy/10 flex items-center justify-center flex-shrink-0">
            {icon}
          </div>
          <div>
            <p className="text-[13px] font-semibold text-textdark tracking-tight leading-tight">{name}</p>
            <p className="text-[10px] text-textlight">{subtitle}</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={onTogglePause}
            disabled={togglingPause}
            className="group flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            title={paused ? 'Resume agent' : 'Pause agent'}
          >
            <div className={`relative w-7 h-4 rounded-full transition-colors duration-200 ${paused ? 'bg-black/10' : 'bg-teal/30'}`}>
              <div className={`absolute top-0.5 w-3 h-3 rounded-full transition-all duration-200 shadow-sm ${paused ? 'left-0.5 bg-textlight' : 'left-3.5 bg-teal'}`} />
            </div>
          </button>
          <div className="flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full ${statusCfg.dot} ${statusCfg.pulse ? 'animate-pulse' : ''}`} />
            <span className={`text-[10px] font-medium ${statusCfg.color}`}>{statusCfg.label}</span>
          </div>
        </div>
      </div>
      {children}
    </div>
  );
}

// =============================================
// Fixer Panel (Agent #1)
// =============================================
function FixerPanel({ data, onRefresh }) {
  const [expanded, setExpanded] = useState(false);
  const [runningAction, setRunningAction] = useState(null);
  const [togglingPause, setTogglingPause] = useState(false);
  const [fixerPlaybooks, setFixerPlaybooks] = useState([]);
  const [healthRecords, setHealthRecords] = useState([]);

  useEffect(() => {
    (async () => {
      const [pbRes, healthRes] = await Promise.allSettled([
        api.getFixerPlaybooks(),
        api.getConductorHealth(10),
      ]);
      if (pbRes.status === 'fulfilled') setFixerPlaybooks(pbRes.value?.playbooks || []);
      if (healthRes.status === 'fulfilled') setHealthRecords(healthRes.value?.health || []);
    })();
  }, []);

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

  const handleTogglePause = async () => {
    setTogglingPause(true);
    try {
      await api.toggleFixerPause();
      await onRefresh();
    } catch { /* ignore */ }
    finally { setTogglingPause(false); }
  };

  const budgetPct = data.budget.daily_budget_cents > 0
    ? (data.budget.spent_cents / data.budget.daily_budget_cents) * 100
    : 0;
  const budgetBarColor = budgetPct < 50 ? 'bg-teal' : budgetPct < 80 ? 'bg-gold' : 'bg-red-400';

  return (
    <AgentPanel
      name="Dacia Fixer"
      subtitle="Runs every 5 min — tests code, auto-fixes, resurrects stuck batches, monitors agent team"
      status={data.status}
      paused={data.paused}
      onTogglePause={handleTogglePause}
      togglingPause={togglingPause}
      icon={
        <svg className="w-3 h-3 text-navy" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      }
    >
      <BudgetBar spent={data.budget.spent_cents} total={data.budget.daily_budget_cents} pct={budgetPct} barColor={budgetBarColor} />

      <div className="grid grid-cols-4 gap-2 mb-3">
        <StatCell value={data.stats.runs} label="Runs" color="text-textdark" />
        <StatCell value={data.stats.fixes} label="Fixes" color="text-teal" />
        <StatCell value={data.stats.failures} label="Fails" color={data.stats.failures > 0 ? 'text-red-400' : 'text-textdark'} />
        <StatCell value={data.stats.resurrections} label="Resurrects" color="text-navy-light" />
      </div>

      <p className="text-[10px] text-textmid mb-2.5">
        Last: <span className="font-medium text-textdark">{timeAgo(data.lastRun)}</span>
        {data.paused ? (
          <span className="text-textlight ml-1">{'\u00B7'} Paused</span>
        ) : data.nextRun ? (
          <>{' \u00B7 '} Next: <span className="font-medium text-textdark">{timeUntil(data.nextRun)}</span></>
        ) : null}
      </p>

      <div className="flex gap-2 mb-3">
        <button
          onClick={handleRun}
          disabled={!!runningAction}
          className="btn-primary text-[11px] px-2.5 py-1 flex items-center gap-1 disabled:opacity-50"
        >
          {runningAction === 'run' ? <><Spinner /> Running...</> : <>{'\u25B6'} Run Now</>}
        </button>
        <button
          onClick={handleResurrect}
          disabled={!!runningAction}
          className="btn-secondary text-[11px] px-2.5 py-1 flex items-center gap-1 disabled:opacity-50"
        >
          {runningAction === 'resurrect' ? <><Spinner /> Checking...</> : <>{'\u21BB'} Resurrect</>}
        </button>
      </div>

      {/* Health checks (from Fixer's agent monitoring) */}
      {healthRecords.length > 0 && (
        <div className="border-t border-black/5 pt-2.5 mb-2.5">
          <p className="text-[11px] font-medium text-textmid mb-1.5">Health Checks</p>
          <div className="space-y-1 max-h-32 overflow-y-auto">
            {healthRecords.slice(0, 5).map((hc, i) => (
              <div key={i} className="flex items-start gap-1.5 py-0.5 px-1 text-[10px]">
                <span className={hc.status === 'ok' ? 'text-teal' : 'text-gold'}>{hc.status === 'ok' ? '\u2713' : '\u26A0'}</span>
                <span className="text-textmid">{hc.details || 'Health check'}</span>
                <span className="text-textlight ml-auto">{timeAgo(new Date(hc.check_at).toISOString())}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Fixer playbook */}
      {fixerPlaybooks.length > 0 && (
        <div className="border-t border-black/5 pt-2.5 mb-2.5">
          <p className="text-[11px] font-medium text-textmid mb-1.5">Fixer Playbook (learned patterns)</p>
          <div className="space-y-1">
            {fixerPlaybooks.map((pb, i) => (
              <div key={i} className="text-[10px] px-2 py-1.5 rounded-lg bg-white/60">
                <span className="font-medium text-textdark">{pb.issue_category}</span>
                <span className="text-textlight ml-1">{'\u2014'} {pb.occurrences} occurrences, {pb.auto_resolved} auto-resolved</span>
                {pb.occurrences >= 10 && <span className="text-teal ml-1 font-medium">PREVENTIVE</span>}
                {pb.resolution_steps && (
                  <p className="text-textmid mt-0.5">"{pb.resolution_steps.slice(0, 100)}"</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <ActivityLog activity={data.activity} expanded={expanded} onToggle={() => setExpanded(!expanded)} />
    </AgentPanel>
  );
}

// =============================================
// Creative Filter Panel (Agent #2)
// =============================================
function FilterPanel({ data, onRefresh }) {
  const [expanded, setExpanded] = useState(false);
  const [runningAction, setRunningAction] = useState(null);
  const [togglingPause, setTogglingPause] = useState(false);
  const [volumes, setVolumes] = useState(null);
  const [loadingVolumes, setLoadingVolumes] = useState(false);
  const [savingVolume, setSavingVolume] = useState(null);

  const loadVolumes = useCallback(async () => {
    setLoadingVolumes(true);
    try {
      const res = await api.getFilterVolumes();
      setVolumes(res.projects || []);
    } catch { /* ignore */ }
    finally { setLoadingVolumes(false); }
  }, []);

  useEffect(() => { loadVolumes(); }, [loadVolumes]);

  const handleVolumeChange = async (projectId, newValue) => {
    setSavingVolume(projectId);
    try {
      await api.updateFilterVolume(projectId, newValue);
      setVolumes(prev => prev.map(p =>
        p.id === projectId ? { ...p, scout_daily_flex_ads: newValue } : p
      ));
    } catch { /* ignore */ }
    finally { setSavingVolume(null); }
  };

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

  const handleTogglePause = async () => {
    setTogglingPause(true);
    try {
      await api.toggleFilterPause();
      await onRefresh();
    } catch { /* ignore */ }
    finally { setTogglingPause(false); }
  };

  const budgetPct = data.budget.daily_budget_cents > 0
    ? (data.budget.spent_cents / data.budget.daily_budget_cents) * 100
    : 0;
  const budgetBarColor = budgetPct < 50 ? 'bg-teal' : budgetPct < 80 ? 'bg-gold' : 'bg-red-400';

  return (
    <AgentPanel
      name="Dacia Creative Filter"
      subtitle="Runs every 30 min — scores batch ads, groups winners into flex ads, deploys to Ready to Post"
      status={data.status}
      paused={data.paused}
      onTogglePause={handleTogglePause}
      togglingPause={togglingPause}
      icon={
        <svg className="w-3 h-3 text-navy" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
        </svg>
      }
    >
      <BudgetBar spent={data.budget.spent_cents} total={data.budget.daily_budget_cents} pct={budgetPct} barColor={budgetBarColor} />

      <div className="grid grid-cols-5 gap-2 mb-3">
        <StatCell value={data.stats.batches} label="Batches" color="text-textdark" />
        <StatCell value={data.stats.scored} label="Scored" color="text-textdark" />
        <StatCell value={data.stats.passed} label="Passed" color="text-teal" />
        <StatCell value={data.stats.failed} label="Failed" color={data.stats.failed > 0 ? 'text-red-400' : 'text-textdark'} />
        <StatCell value={data.stats.flexAds} label="Flex Ads" color="text-navy-light" />
      </div>

      <p className="text-[10px] text-textmid mb-2.5">
        Last: <span className="font-medium text-textdark">{timeAgo(data.lastRun)}</span>
        {data.paused ? (
          <span className="text-textlight ml-1">{'\u00B7'} Paused</span>
        ) : data.nextRun ? (
          <>{' \u00B7 '} Next: <span className="font-medium text-textdark">{timeUntil(data.nextRun)}</span></>
        ) : null}
      </p>

      <div className="flex gap-2 mb-3">
        <button
          onClick={handleRunLive}
          disabled={!!runningAction}
          className="btn-primary text-[11px] px-2.5 py-1 flex items-center gap-1 disabled:opacity-50"
        >
          {runningAction === 'live' ? <><Spinner /> Running...</> : <>{'\u25B6'} Run Now</>}
        </button>
        <button
          onClick={handleDryRun}
          disabled={!!runningAction}
          className="btn-secondary text-[11px] px-2.5 py-1 flex items-center gap-1 disabled:opacity-50"
        >
          {runningAction === 'dry' ? <><Spinner /> Running...</> : <>{'\u2699'} Dry Run</>}
        </button>
      </div>

      {/* Per-Brand Daily Volume Controls */}
      <div className="border-t border-black/5 pt-2.5 mb-2.5">
        <p className="text-[11px] font-medium text-textmid mb-1.5">Daily Flex Ad Volume</p>
        <p className="text-[9px] text-textlight mb-2">
          Flex ads created per day per brand. Each flex ad = 10 images.
        </p>
        {loadingVolumes ? (
          <div className="text-[10px] text-textlight py-2">Loading projects...</div>
        ) : volumes && volumes.length > 0 ? (
          <div className="space-y-1">
            {volumes.filter(p => p.scout_enabled !== false).map(project => (
              <div key={project.id} className="flex items-center justify-between gap-2 py-1.5 px-2.5 rounded-lg bg-white/60">
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] font-medium text-textdark truncate">
                    {project.brand_name || project.name}
                  </p>
                  <p className="text-[9px] text-textlight">
                    Today: {project.today_flex_ads}/{project.scout_daily_flex_ads} flex ads ({project.today_flex_ads * 10}/{project.scout_daily_flex_ads * 10} images)
                  </p>
                </div>
                <select
                  value={project.scout_daily_flex_ads}
                  onChange={e => handleVolumeChange(project.id, parseInt(e.target.value))}
                  disabled={savingVolume === project.id}
                  className="text-[11px] text-textdark bg-offwhite border border-black/10 rounded-lg px-2 py-1 w-14 cursor-pointer"
                >
                  {[1, 2, 3, 4, 5, 6, 8, 10].map(n => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-[10px] text-textlight py-1.5">No projects configured.</p>
        )}
      </div>

      <ActivityLog activity={data.activity} expanded={expanded} onToggle={() => setExpanded(!expanded)} />
    </AgentPanel>
  );
}

// =============================================
// Shared sub-components
// =============================================

function BudgetBar({ spent, total, pct, barColor }) {
  return (
    <div className="mb-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] text-textmid font-medium">Budget</span>
        <span className="text-[10px] text-textmid tabular-nums">
          {spent}{'\u00A2'} / {total}{'\u00A2'}
          <span className="text-textlight ml-1">
            (${(spent / 100).toFixed(2)} / ${(total / 100).toFixed(2)})
          </span>
        </span>
      </div>
      <div className="h-1 rounded-full bg-black/5 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${barColor}`}
          style={{ width: `${Math.min(pct, 100)}%` }}
        />
      </div>
    </div>
  );
}

function ActivityLog({ activity, expanded, onToggle }) {
  return (
    <div className="border-t border-black/5 pt-2.5">
      <button
        onClick={onToggle}
        className="flex items-center justify-between w-full group"
      >
        <span className="text-[11px] font-medium text-textmid">Recent Activity</span>
        <svg
          className={`w-3 h-3 text-textlight transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
          fill="none" stroke="currentColor" viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {expanded && (
        <div className="mt-1.5 max-h-44 overflow-y-auto scrollbar-thin">
          {activity && activity.length > 0 ? (
            <div className="space-y-0">
              {activity.map((entry, i) => {
                const cfg = LEVEL_CONFIG[entry.level] || LEVEL_CONFIG.INFO;
                return (
                  <div key={i} className="flex items-start gap-1.5 py-0.5 px-1 rounded hover:bg-black/[0.02]">
                    <span className="text-[9px] text-textlight font-mono flex-shrink-0 mt-px w-8">
                      {entry.time.slice(0, 5)}
                    </span>
                    <span className={`text-[10px] flex-shrink-0 w-3 text-center ${cfg.color}`}>
                      {cfg.icon}
                    </span>
                    <span className={`text-[10px] ${cfg.color} leading-tight`}>
                      {entry.message}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-[10px] text-textlight py-1.5">No activity recorded today.</p>
          )}
        </div>
      )}
    </div>
  );
}

function StatCell({ value, label, color }) {
  return (
    <div className="text-center py-1.5 px-1 rounded-lg bg-white/60">
      <p className={`text-base font-semibold ${color} tabular-nums leading-tight`}>{value}</p>
      <p className="text-[9px] text-textlight uppercase tracking-wider mt-0.5">{label}</p>
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

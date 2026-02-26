import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../api';

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

export default function AgentMonitor() {
  const [fixerData, setFixerData] = useState(null);
  const [filterData, setFilterData] = useState(null);
  const [pipelineStatus, setPipelineStatus] = useState(null);
  const [activeTab, setActiveTab] = useState('director');
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
            const target = project.daily_flex_target || 5;
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
  const [loading, setLoading] = useState(true);
  const [runningAction, setRunningAction] = useState(null);
  const [saving, setSaving] = useState(false);

  const [campaigns, setCampaigns] = useState([]);

  // New angle form
  const [showAddAngle, setShowAddAngle] = useState(false);
  const [newAngle, setNewAngle] = useState({ name: '', description: '', prompt_hints: '' });

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

  const handleRunNow = async () => {
    setRunningAction('run');
    try {
      await api.triggerConductorRun(selectedProject);
      setTimeout(async () => {
        const runRes = await api.getConductorRuns(selectedProject, 20);
        setRuns(runRes?.runs || []);
        onRefresh();
      }, 3000);
    } catch { /* ignore */ }
    finally { setRunningAction(null); }
  };

  const handleAddAngle = async () => {
    if (!newAngle.name || !newAngle.description) return;
    try {
      await api.createConductorAngle(selectedProject, {
        name: newAngle.name,
        description: newAngle.description,
        prompt_hints: newAngle.prompt_hints,
        source: 'manual',
        status: 'active',
      });
      setNewAngle({ name: '', description: '', prompt_hints: '' });
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

  if (loading) return <div className="text-[11px] text-textlight py-4">Loading...</div>;

  const subTabs = [
    { id: 'angles', label: 'Angles' },
    { id: 'playbooks', label: 'Playbooks' },
    { id: 'settings', label: 'Settings' },
    { id: 'history', label: 'Run History' },
  ];

  const activeAngles = angles.filter(a => a.status === 'active');
  const testingAngles = angles.filter(a => a.status === 'testing');
  const retiredAngles = angles.filter(a => a.status === 'retired');

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
          onClick={handleRunNow}
          disabled={!!runningAction}
          className="btn-primary text-[11px] px-3 py-1.5 flex items-center gap-1 disabled:opacity-50 ml-auto"
        >
          {runningAction === 'run' ? <><Spinner /> Running...</> : <>{'\u25B6'} Run Now</>}
        </button>
      </div>

      {/* Quick stats */}
      <div className="grid grid-cols-4 gap-2 mb-4">
        <StatCell value={config?.daily_flex_target || 5} label="Daily Target" color="text-textdark" />
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
          {/* Active angles */}
          {activeAngles.length > 0 && (
            <div className="mb-4">
              <p className="text-[10px] text-textlight font-medium uppercase tracking-wider mb-2">Active</p>
              <div className="space-y-2">
                {activeAngles.map(a => (
                  <AngleCard key={a.externalId} angle={a} playbooks={playbooks} onStatusChange={handleAngleStatusChange} />
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

          {/* Retired */}
          {retiredAngles.length > 0 && (
            <div className="mb-4">
              <p className="text-[10px] text-textlight font-medium uppercase tracking-wider mb-2">Retired ({retiredAngles.length})</p>
              <div className="space-y-1">
                {retiredAngles.map(a => (
                  <div key={a.externalId} className="text-[11px] text-textlight px-3 py-1.5">
                    {a.name} <span className="text-[9px]">({'\u2022'} used {a.times_used || 0}x)</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Add angle */}
          {showAddAngle ? (
            <div className="rounded-xl bg-offwhite border border-black/10 p-4 mt-2">
              <p className="text-[12px] font-medium text-textdark mb-3">New Angle</p>
              <input
                type="text"
                placeholder="Angle name (e.g., Joint Pain Fear)"
                value={newAngle.name}
                onChange={e => setNewAngle(prev => ({ ...prev, name: e.target.value }))}
                className="input-apple w-full mb-2 text-[12px]"
              />
              <textarea
                placeholder="Description — what emotion does this target? Why would it resonate?"
                value={newAngle.description}
                onChange={e => setNewAngle(prev => ({ ...prev, description: e.target.value }))}
                className="input-apple w-full mb-2 text-[12px] h-20 resize-none"
              />
              <textarea
                placeholder="Prompt hints — visual style, copy tone, key phrases (optional)"
                value={newAngle.prompt_hints}
                onChange={e => setNewAngle(prev => ({ ...prev, prompt_hints: e.target.value }))}
                className="input-apple w-full mb-3 text-[12px] h-16 resize-none"
              />
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
                min="1"
                max="20"
                value={config.daily_flex_target || 5}
                onChange={e => handleSaveConfig({ daily_flex_target: parseInt(e.target.value) || 5 })}
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
            <p className="text-[11px] text-textlight py-4">No runs yet. Click "Run Now" to trigger the Director, or wait for the next scheduled run.</p>
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
function AngleCard({ angle, playbooks, onStatusChange, showActions }) {
  const pb = playbooks.find(p => p.angle_name === angle.name);

  return (
    <div className="rounded-lg bg-white/60 border border-black/5 p-3">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <span className="text-[11px]">{'\u25CF'}</span>
          <span className="text-[13px] font-medium text-textdark">{angle.name}</span>
          <span className="text-[10px] text-textlight">used {angle.times_used || 0}x</span>
          {pb && (
            <span className="text-[10px] text-textmid">
              pass: {Math.round((pb.pass_rate || 0) * 100)}%
              {pb.pass_rate > 0.6 ? ' \u2191' : pb.pass_rate < 0.4 ? ' \u2193' : ''}
            </span>
          )}
        </div>
        {showActions && (
          <div className="flex gap-1">
            <button
              onClick={() => onStatusChange(angle.externalId, 'active')}
              className="text-[10px] text-teal hover:underline"
            >
              Activate
            </button>
            <button
              onClick={() => onStatusChange(angle.externalId, 'retired')}
              className="text-[10px] text-red-400 hover:underline ml-2"
            >
              Retire
            </button>
          </div>
        )}
        {!showActions && angle.status === 'active' && (
          <button
            onClick={() => onStatusChange(angle.externalId, 'retired')}
            className="text-[10px] text-textlight hover:text-red-400"
          >
            Retire
          </button>
        )}
      </div>
      <p className="text-[11px] text-textmid leading-relaxed">{angle.description}</p>
      {pb && pb.generation_hints && (
        <p className="text-[10px] text-teal mt-1 leading-relaxed">
          Playbook v{pb.version}: "{pb.generation_hints.slice(0, 120)}{pb.generation_hints.length > 120 ? '...' : ''}"
        </p>
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

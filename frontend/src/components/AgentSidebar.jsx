import { useState, useMemo } from 'react';

const AGENT_COLORS = {
  blue: { dot: 'bg-blue-500', bg: 'bg-blue-50', text: 'text-blue-700' },
  cyan: { dot: 'bg-cyan-500', bg: 'bg-cyan-50', text: 'text-cyan-700' },
  emerald: { dot: 'bg-emerald-500', bg: 'bg-emerald-50', text: 'text-emerald-700' },
  green: { dot: 'bg-green-500', bg: 'bg-green-50', text: 'text-green-700' },
  amber: { dot: 'bg-amber-500', bg: 'bg-amber-50', text: 'text-amber-700' },
  orange: { dot: 'bg-orange-500', bg: 'bg-orange-50', text: 'text-orange-700' },
  red: { dot: 'bg-red-500', bg: 'bg-red-50', text: 'text-red-700' },
  purple: { dot: 'bg-purple-500', bg: 'bg-purple-50', text: 'text-purple-700' },
  pink: { dot: 'bg-pink-500', bg: 'bg-pink-50', text: 'text-pink-700' },
  indigo: { dot: 'bg-indigo-500', bg: 'bg-indigo-50', text: 'text-indigo-700' },
  teal: { dot: 'bg-teal-500', bg: 'bg-teal-50', text: 'text-teal-700' },
  yellow: { dot: 'bg-yellow-500', bg: 'bg-yellow-50', text: 'text-yellow-700' },
};

function getColorClasses(color) {
  // Handle hex colors or unrecognized names
  if (!color || color.startsWith('#')) return AGENT_COLORS.blue;
  const normalized = color.toLowerCase().replace(/[^a-z]/g, '');
  return AGENT_COLORS[normalized] || AGENT_COLORS.blue;
}

export default function AgentSidebar({ agents, divisions, selectedAgent, onSelectAgent, searchQuery, onSearchChange }) {
  const [collapsedDivisions, setCollapsedDivisions] = useState({});

  const toggleDivision = (divId) => {
    setCollapsedDivisions(prev => ({ ...prev, [divId]: !prev[divId] }));
  };

  const filteredAgents = useMemo(() => {
    if (!searchQuery.trim()) return agents;
    const q = searchQuery.toLowerCase();
    return agents.filter(a =>
      a.name.toLowerCase().includes(q) ||
      a.description.toLowerCase().includes(q) ||
      (a.vibe && a.vibe.toLowerCase().includes(q))
    );
  }, [agents, searchQuery]);

  const agentsByDivision = useMemo(() => {
    const map = {};
    for (const a of filteredAgents) {
      if (!map[a.division]) map[a.division] = [];
      map[a.division].push(a);
    }
    return map;
  }, [filteredAgents]);

  return (
    <div className="w-[280px] min-w-[280px] border-r border-black/5 flex flex-col bg-white/50 overflow-hidden">
      {/* Search */}
      <div className="p-3 border-b border-black/5">
        <div className="relative">
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-textlight" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            placeholder="Search agents..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 text-xs bg-black/[0.03] border border-black/5 rounded-lg focus:outline-none focus:ring-1 focus:ring-navy/20 focus:border-navy/20 placeholder-textlight"
          />
        </div>
        <div className="mt-1.5 text-[10px] text-textlight">
          {filteredAgents.length} agent{filteredAgents.length !== 1 ? 's' : ''}
          {searchQuery && ` matching "${searchQuery}"`}
        </div>
      </div>

      {/* Agent list */}
      <div className="flex-1 overflow-y-auto">
        {divisions.map(div => {
          const divAgents = agentsByDivision[div.id];
          if (!divAgents || divAgents.length === 0) return null;
          const isCollapsed = collapsedDivisions[div.id];

          return (
            <div key={div.id}>
              <button
                onClick={() => toggleDivision(div.id)}
                className="w-full flex items-center justify-between px-3 py-2 text-[10px] font-semibold text-textmid uppercase tracking-wider hover:bg-black/[0.02] transition-colors"
              >
                <span>{div.label}</span>
                <span className="flex items-center gap-1.5">
                  <span className="text-textlight font-normal normal-case tracking-normal">{divAgents.length}</span>
                  <svg className={`w-3 h-3 text-textlight transition-transform ${isCollapsed ? '-rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                </span>
              </button>

              {!isCollapsed && divAgents.map(agent => {
                const isActive = selectedAgent?.id === agent.id;
                const colors = getColorClasses(agent.color);

                return (
                  <button
                    key={agent.id}
                    onClick={() => onSelectAgent(agent)}
                    className={`w-full text-left px-3 py-2 flex items-start gap-2 transition-colors ${
                      isActive
                        ? 'bg-navy/5 border-l-2 border-navy'
                        : 'border-l-2 border-transparent hover:bg-black/[0.02]'
                    }`}
                  >
                    <span className={`w-2 h-2 rounded-full mt-1 flex-shrink-0 ${colors.dot}`} />
                    <div className="min-w-0 flex-1">
                      <div className={`text-xs font-medium truncate ${isActive ? 'text-navy' : 'text-textdark'}`}>
                        {agent.emoji && <span className="mr-1">{agent.emoji}</span>}
                        {agent.name}
                      </div>
                      {agent.vibe && (
                        <div className="text-[10px] text-textlight mt-0.5 line-clamp-2 leading-tight">
                          {agent.vibe}
                        </div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          );
        })}

        {filteredAgents.length === 0 && (
          <div className="px-3 py-8 text-center text-xs text-textlight">
            No agents match your search.
          </div>
        )}
      </div>
    </div>
  );
}

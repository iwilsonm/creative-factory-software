import React, { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../api';
import { useToast } from './Toast';

// ─── Multi-input chip component (keywords, subreddits, forums) ──────────────
function MultiInput({ items, onAdd, onRemove, placeholder, prefix = '' }) {
  const [input, setInput] = useState('');

  const handleKeyDown = (e) => {
    if ((e.key === 'Enter' || e.key === ',') && input.trim()) {
      e.preventDefault();
      onAdd(input.trim().replace(/^,|,$/g, ''));
      setInput('');
    }
    if (e.key === 'Backspace' && !input && items.length > 0) {
      onRemove(items.length - 1);
    }
  };

  return (
    <div className="flex flex-wrap gap-1.5 p-2 border border-gray-200/80 rounded-xl bg-white/80 backdrop-blur focus-within:ring-2 focus-within:ring-blue-500/30 focus-within:border-blue-300 transition-all min-h-[38px]">
      {items.map((item, i) => (
        <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-50 text-blue-700 rounded-lg text-[12px] font-medium">
          {prefix}{item}
          <button onClick={() => onRemove(i)} className="text-blue-400 hover:text-blue-600 ml-0.5">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </span>
      ))}
      <input
        value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={items.length === 0 ? placeholder : 'Type + Enter...'}
        className="flex-1 min-w-[120px] outline-none text-[13px] bg-transparent"
      />
    </div>
  );
}

// ─── Emotion badge colors ────────────────────────────────────────────────────
const EMOTION_COLORS = {
  frustration: 'bg-orange-100 text-orange-700',
  desperation: 'bg-red-100 text-red-700',
  anger: 'bg-red-100 text-red-700',
  fear: 'bg-purple-100 text-purple-700',
  hope: 'bg-green-100 text-green-700',
  relief: 'bg-emerald-100 text-emerald-700',
  shame: 'bg-pink-100 text-pink-700',
  confusion: 'bg-yellow-100 text-yellow-700',
};

// ─── Property colors for Notion-style filters ────────────────────────────────
const PROPERTY_COLORS = {
  problem:   { bg: 'bg-blue-50',   text: 'text-blue-700',   border: 'border-blue-200',   dot: 'bg-blue-400',   hoverBg: 'hover:bg-blue-50'   },
  emotion:   { bg: 'bg-purple-50', text: 'text-purple-700', border: 'border-purple-200', dot: 'bg-purple-400', hoverBg: 'hover:bg-purple-50' },
  tag:       { bg: 'bg-teal-50',   text: 'text-teal-700',   border: 'border-teal-200',   dot: 'bg-teal-400',   hoverBg: 'hover:bg-teal-50'   },
  technique: { bg: 'bg-amber-50',  text: 'text-amber-700',  border: 'border-amber-200',  dot: 'bg-amber-400',  hoverBg: 'hover:bg-amber-50'  },
  status:    { bg: 'bg-gray-50',   text: 'text-gray-700',   border: 'border-gray-200',   dot: 'bg-gray-400',   hoverBg: 'hover:bg-gray-50'   },
};

// ─── Notion-style filter component ───────────────────────────────────────────
// properties: [{ key: 'problem', label: 'Problem', values: ['...'] }, ...]
// filters: Map<propertyKey, Set<selectedValues>>
// onToggle: (propertyKey, value) => void
// onClear: (propertyKey?) => void  — no arg = clear all
function NotionFilter({ properties, filters, onToggle, onClear }) {
  const [addingFilter, setAddingFilter] = useState(false);
  const [openDropdown, setOpenDropdown] = useState(null); // propertyKey or null
  const [searchText, setSearchText] = useState('');
  const dropdownRef = useRef(null);
  const addBtnRef = useRef(null);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target) &&
          addBtnRef.current && !addBtnRef.current.contains(e.target)) {
        setOpenDropdown(null);
        setAddingFilter(false);
        setSearchText('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Get active filter entries: [{ key, label, values: Set, colors }]
  const activeFilters = properties
    .filter(p => filters.get(p.key)?.size > 0)
    .map(p => ({ ...p, selected: filters.get(p.key), colors: PROPERTY_COLORS[p.key] || PROPERTY_COLORS.status }));

  const hasAnyFilter = activeFilters.length > 0;

  // Properties that have values to filter by
  const availableProps = properties.filter(p => p.values.length > 0);

  return (
    <div className="flex items-center gap-1.5 flex-wrap min-h-[28px]">
      {/* Active filter pills */}
      {activeFilters.map(af => (
        <div key={af.key} className="relative inline-flex">
          <button
            onClick={() => { setOpenDropdown(openDropdown === af.key ? null : af.key); setAddingFilter(false); setSearchText(''); }}
            className={`inline-flex items-center gap-1 text-[11px] pl-2 pr-1.5 py-1 rounded-lg border transition-all ${af.colors.bg} ${af.colors.text} ${af.colors.border}`}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${af.colors.dot}`} />
            <span className="font-medium">{af.label}</span>
            <span className="text-[10px] opacity-60">is</span>
            <span className="font-semibold max-w-[180px] truncate">
              {[...af.selected].join(', ')}
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); onClear(af.key); }}
              className="ml-0.5 opacity-50 hover:opacity-100 transition-opacity"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </button>

          {/* Value dropdown for existing filter */}
          {openDropdown === af.key && (
            <div ref={dropdownRef} className="absolute top-full left-0 mt-1 z-50 w-56 bg-white rounded-xl border border-gray-200 shadow-lg shadow-gray-200/50 overflow-hidden">
              <div className="p-1.5">
                <input
                  autoFocus
                  value={searchText}
                  onChange={e => setSearchText(e.target.value)}
                  placeholder={`Filter ${af.label.toLowerCase()}...`}
                  className="w-full text-[12px] px-2.5 py-1.5 rounded-lg border border-gray-200 outline-none focus:border-blue-300 focus:ring-1 focus:ring-blue-200 bg-gray-50/50"
                />
              </div>
              <div className="max-h-48 overflow-y-auto">
                {af.values
                  .filter(v => !searchText || v.toLowerCase().includes(searchText.toLowerCase()))
                  .map(v => {
                    const isSelected = af.selected.has(v);
                    return (
                      <button
                        key={v}
                        onClick={() => onToggle(af.key, v)}
                        className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-[12px] text-left transition-colors ${
                          isSelected ? `${af.colors.bg} font-medium` : 'hover:bg-gray-50'
                        }`}
                      >
                        <span className={`flex-shrink-0 w-3.5 h-3.5 rounded border flex items-center justify-center ${
                          isSelected ? `${af.colors.border} ${af.colors.bg}` : 'border-gray-300'
                        }`}>
                          {isSelected && (
                            <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                            </svg>
                          )}
                        </span>
                        <span className={`truncate ${isSelected ? af.colors.text : 'text-gray-700'}`}>{v}</span>
                      </button>
                    );
                  })}
              </div>
              <div className="border-t border-gray-100 px-3 py-1.5 flex items-center justify-between">
                <span className="text-[10px] text-gray-400">{af.selected.size} selected</span>
                <button onClick={() => onClear(af.key)} className="text-[10px] text-gray-400 hover:text-gray-600">Clear</button>
              </div>
            </div>
          )}
        </div>
      ))}

      {/* "+ Add a filter" button */}
      {availableProps.length > 0 && (
        <div className="relative inline-flex">
          <button
            ref={addBtnRef}
            onClick={() => { setAddingFilter(!addingFilter); setOpenDropdown(null); setSearchText(''); }}
            className={`inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-lg border border-dashed transition-all ${
              hasAnyFilter
                ? 'border-gray-200 text-gray-400 hover:border-gray-300 hover:text-gray-600'
                : 'border-gray-300 text-gray-500 hover:border-blue-300 hover:text-blue-600'
            }`}
          >
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v12m6-6H6" />
            </svg>
            {hasAnyFilter ? 'Add filter' : 'Filter'}
          </button>

          {/* Property picker dropdown */}
          {addingFilter && (
            <div ref={dropdownRef} className="absolute top-full left-0 mt-1 z-50 w-48 bg-white rounded-xl border border-gray-200 shadow-lg shadow-gray-200/50 overflow-hidden">
              <div className="px-3 py-2 border-b border-gray-100">
                <p className="text-[10px] font-medium text-gray-400 uppercase tracking-wider">Filter by property</p>
              </div>
              {availableProps.map(prop => {
                const colors = PROPERTY_COLORS[prop.key] || PROPERTY_COLORS.status;
                const isActive = filters.get(prop.key)?.size > 0;
                return (
                  <button
                    key={prop.key}
                    onClick={() => { setAddingFilter(false); setOpenDropdown(prop.key); setSearchText(''); }}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 text-[12px] text-left transition-colors hover:bg-gray-50 ${isActive ? 'opacity-50' : ''}`}
                  >
                    <span className={`w-2 h-2 rounded-full ${colors.dot}`} />
                    <span className="text-gray-700">{prop.label}</span>
                    <span className="text-[10px] text-gray-300 ml-auto">{prop.values.length}</span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Value dropdown for newly picked property (not yet in activeFilters) */}
          {openDropdown && !activeFilters.find(af => af.key === openDropdown) && (() => {
            const prop = properties.find(p => p.key === openDropdown);
            if (!prop) return null;
            const colors = PROPERTY_COLORS[prop.key] || PROPERTY_COLORS.status;
            const selected = filters.get(prop.key) || new Set();
            return (
              <div ref={dropdownRef} className="absolute top-full left-0 mt-1 z-50 w-56 bg-white rounded-xl border border-gray-200 shadow-lg shadow-gray-200/50 overflow-hidden">
                <div className="px-3 py-2 border-b border-gray-100 flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${colors.dot}`} />
                  <span className="text-[11px] font-medium text-gray-600">{prop.label}</span>
                </div>
                <div className="p-1.5">
                  <input
                    autoFocus
                    value={searchText}
                    onChange={e => setSearchText(e.target.value)}
                    placeholder={`Search ${prop.label.toLowerCase()}...`}
                    className="w-full text-[12px] px-2.5 py-1.5 rounded-lg border border-gray-200 outline-none focus:border-blue-300 focus:ring-1 focus:ring-blue-200 bg-gray-50/50"
                  />
                </div>
                <div className="max-h-48 overflow-y-auto">
                  {prop.values
                    .filter(v => !searchText || v.toLowerCase().includes(searchText.toLowerCase()))
                    .map(v => {
                      const isSelected = selected.has(v);
                      return (
                        <button
                          key={v}
                          onClick={() => onToggle(prop.key, v)}
                          className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-[12px] text-left transition-colors ${
                            isSelected ? `${colors.bg} font-medium` : 'hover:bg-gray-50'
                          }`}
                        >
                          <span className={`flex-shrink-0 w-3.5 h-3.5 rounded border flex items-center justify-center ${
                            isSelected ? `${colors.border} ${colors.bg}` : 'border-gray-300'
                          }`}>
                            {isSelected && (
                              <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" strokeWidth={3} stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                              </svg>
                            )}
                          </span>
                          <span className={`truncate ${isSelected ? colors.text : 'text-gray-700'}`}>{v}</span>
                        </button>
                      );
                    })}
                </div>
                {selected.size > 0 && (
                  <div className="border-t border-gray-100 px-3 py-1.5 flex items-center justify-between">
                    <span className="text-[10px] text-gray-400">{selected.size} selected</span>
                    <button onClick={() => onClear(prop.key)} className="text-[10px] text-gray-400 hover:text-gray-600">Clear</button>
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      )}

      {/* Clear all */}
      {hasAnyFilter && (
        <button
          onClick={() => onClear()}
          className="text-[10px] text-gray-400 hover:text-gray-600 transition-colors ml-1"
        >
          Clear all
        </button>
      )}
    </div>
  );
}

// ─── Format helpers ──────────────────────────────────────────────────────────
function formatDuration(ms) {
  if (!ms) return '';
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m ${remSecs}s`;
}

function formatTimeAgo(dateStr) {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ─── Main component ──────────────────────────────────────────────────────────
export default function QuoteMiner({ projectId, project, onNavigateToTracker, onSendToAdStudio }) {
  const toast = useToast();
  // Sub-tab state: 'bank' | 'headlines' | 'mine'
  const [subTab, setSubTab] = useState('mine');
  const [usageData, setUsageData] = useState({ usedHeadlines: {}, totalAds: 0 });
  const [loadingUsage, setLoadingUsage] = useState(false);

  // Config form state
  const [config, setConfig] = useState({
    target_demographic: '',
    problem: '',
    root_cause: '',
    num_quotes: 20,
  });
  const [keywords, setKeywords] = useState([]);
  const [subreddits, setSubreddits] = useState([]);
  const [forums, setForums] = useState([]);
  const [facebookGroups, setFacebookGroups] = useState([]);

  // Auto-suggest state
  const [suggesting, setSuggesting] = useState(false);
  const suggestTimeoutRef = useRef(null);

  // Mining state
  const [mining, setMining] = useState(false);
  const [progress, setProgress] = useState([]);
  const [currentRunId, setCurrentRunId] = useState(null);
  const abortRef = useRef(null);

  // Results state (legacy run view)
  const [currentQuotes, setCurrentQuotes] = useState(null);
  const [currentRunMeta, setCurrentRunMeta] = useState(null);

  // Headline generation state (legacy)
  const [generatingHeadlines, setGeneratingHeadlines] = useState(false);
  const [headlineProgress, setHeadlineProgress] = useState([]);
  const [currentHeadlines, setCurrentHeadlines] = useState(null);
  const headlineAbortRef = useRef(null);

  // History state
  const [runs, setRuns] = useState([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [viewingRunId, setViewingRunId] = useState(null);

  // ─── Quote Bank state ──────────────────────────────────────────────────────
  const [bankQuotes, setBankQuotes] = useState([]);
  const [bankFilter, setBankFilter] = useState('all'); // 'all' | 'favorites'
  const [headlineFilter, setHeadlineFilter] = useState('all'); // 'all' | 'used' | 'unused'
  // Notion-style filters (Map<propertyKey, Set<selectedValues>>)
  const [headlineFilters, setHeadlineFilters] = useState(new Map());
  const [bankFilters, setBankFilters] = useState(new Map());
  const [generatingMoreForQuote, setGeneratingMoreForQuote] = useState(null); // quoteId or null

  // Mining elapsed time
  const [miningStartTime, setMiningStartTime] = useState(null);
  const [miningElapsed, setMiningElapsed] = useState(0);
  const [bankOpen, setBankOpen] = useState(true);
  const [loadingBank, setLoadingBank] = useState(true);
  const [expandedQuoteIds, setExpandedQuoteIds] = useState(new Set());
  const [generatingBankHeadlines, setGeneratingBankHeadlines] = useState(false);
  const [bankHeadlineProgress, setBankHeadlineProgress] = useState([]);
  const bankHeadlineAbortRef = useRef(null);

  // Import state
  const [importing, setImporting] = useState(false);

  // Tag editing state
  const [editingTagQuoteId, setEditingTagQuoteId] = useState(null);
  const [tagInput, setTagInput] = useState('');

  // Backfill state
  const [backfilling, setBackfilling] = useState(false);

  // Multi-select state
  const [selectedQuoteIds, setSelectedQuoteIds] = useState(new Set());
  const [selectedHeadlineKeys, setSelectedHeadlineKeys] = useState(new Set()); // "quoteId::idx"
  const [bulkActionOpen, setBulkActionOpen] = useState(null); // 'tags' | 'emotion' | 'problem' | null
  const [bulkInput, setBulkInput] = useState('');

  // Inline editing state
  const [editingField, setEditingField] = useState(null); // { quoteId, field, value } or { quoteId, hlIdx, value } for headlines
  const [savingEdit, setSavingEdit] = useState(false);

  // (AdCreationModal removed — now routes to Ad Studio via onSendToAdStudio)

  // Progress ref for auto-scroll
  const progressEndRef = useRef(null);

  // Notion-style filter helpers: toggle value in a Map<key, Set<values>>
  const toggleMapFilter = useCallback((setter, propertyKey, value) => {
    setter(prev => {
      const next = new Map(prev);
      const existing = new Set(next.get(propertyKey) || []);
      if (existing.has(value)) existing.delete(value);
      else existing.add(value);
      if (existing.size === 0) next.delete(propertyKey);
      else next.set(propertyKey, existing);
      return next;
    });
  }, []);

  const clearMapFilter = useCallback((setter, propertyKey) => {
    setter(prev => {
      if (!propertyKey) return new Map(); // clear all
      const next = new Map(prev);
      next.delete(propertyKey);
      return next;
    });
  }, []);

  // Mining elapsed timer
  useEffect(() => {
    if (!mining || !miningStartTime) return;
    const timer = setInterval(() => {
      setMiningElapsed(Math.floor((Date.now() - miningStartTime) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [mining, miningStartTime]);

  // Load history + bank + usage on mount
  useEffect(() => {
    loadHistory();
    loadBank();
    loadUsage();
  }, [projectId]);

  const loadHistory = async () => {
    try {
      const data = await api.getQuoteMiningRuns(projectId);
      const allRuns = data.runs || [];
      setRuns(allRuns);

      // Detect in-progress runs (restored from navigation away)
      const runningRun = allRuns.find(r => r.status === 'running');
      if (runningRun && !mining) {
        const runAge = Date.now() - new Date(runningRun.created_at).getTime();
        if (runAge > 10 * 60 * 1000) return;
        setCurrentRunId(runningRun.id);
        setMining(true);
        setProgress([{ type: 'restored', message: `Reconnected to mining run: ${runningRun.target_demographic} × ${runningRun.problem}` }]);
      }
    } catch (err) {
      console.error('Failed to load quote mining history:', err);
    } finally {
      setLoadingHistory(false);
    }
  };

  const loadBank = async () => {
    try {
      const data = await api.getQuoteBank(projectId);
      const quotes = data.quotes || [];
      setBankQuotes(quotes);
      // Default to bank tab when quotes exist
      if (quotes.length > 0) setSubTab(prev => prev === 'mine' ? 'bank' : prev);
    } catch (err) {
      console.error('Failed to load quote bank:', err);
    } finally {
      setLoadingBank(false);
    }
  };

  const loadUsage = async () => {
    setLoadingUsage(true);
    try {
      const data = await api.getQuoteBankUsage(projectId);
      setUsageData(data || { usedHeadlines: {}, totalAds: 0 });
    } catch (err) {
      console.error('Failed to load usage data:', err);
    } finally {
      setLoadingUsage(false);
    }
  };

  // Import all past runs into the quote bank
  const handleImportAllRuns = async () => {
    setImporting(true);
    try {
      const data = await api.importAllRunsToBank(projectId);
      toast.success(`Imported ${data.total_added} quotes from ${data.runs_processed} runs (${data.total_duplicates} duplicates skipped)`);
      await loadBank();
      await loadUsage();
    } catch (err) {
      toast.error('Import failed: ' + err.message);
    } finally {
      setImporting(false);
    }
  };

  // Import a single run's quotes into the bank
  const handleAddRunToBank = async (runId) => {
    setImporting(true);
    try {
      const data = await api.addRunToBank(projectId, runId);
      toast.success(`Added ${data.added} quotes to bank (${data.duplicates} duplicates skipped)`);
      await loadBank();
      await loadUsage();
    } catch (err) {
      toast.error('Import failed: ' + err.message);
    } finally {
      setImporting(false);
    }
  };

  // Backfill problem labels from mining runs
  const handleBackfillProblems = async () => {
    setBackfilling(true);
    try {
      const data = await api.backfillQuoteBankProblems(projectId);
      toast.success(`Updated ${data.updated} quotes with problem labels`);
      await loadBank();
    } catch (err) {
      toast.error('Backfill failed: ' + err.message);
    } finally {
      setBackfilling(false);
    }
  };

  // Tag management
  const handleAddTag = async (quoteId, tag) => {
    const quote = bankQuotes.find(q => q.id === quoteId);
    if (!quote) return;
    const currentTags = quote.tags || [];
    if (currentTags.includes(tag)) return;
    const newTags = [...currentTags, tag];
    try {
      await api.updateQuoteBankTags(projectId, quoteId, newTags);
      setBankQuotes(prev => prev.map(q => q.id === quoteId ? { ...q, tags: newTags } : q));
    } catch (err) {
      toast.error('Failed to add tag: ' + err.message);
    }
  };

  const handleRemoveTag = async (quoteId, tag) => {
    const quote = bankQuotes.find(q => q.id === quoteId);
    if (!quote) return;
    const newTags = (quote.tags || []).filter(t => t !== tag);
    try {
      await api.updateQuoteBankTags(projectId, quoteId, newTags);
      setBankQuotes(prev => prev.map(q => q.id === quoteId ? { ...q, tags: newTags } : q));
    } catch (err) {
      toast.error('Failed to remove tag: ' + err.message);
    }
  };

  // ─── Multi-select helpers ──────────────────────────────────────────────────
  const toggleQuoteSelect = (quoteId) => {
    setSelectedQuoteIds(prev => {
      const next = new Set(prev);
      if (next.has(quoteId)) next.delete(quoteId);
      else next.add(quoteId);
      return next;
    });
  };

  const selectAllQuotes = () => {
    setSelectedQuoteIds(new Set(filteredBankQuotes.map(q => q.id)));
  };

  const clearQuoteSelection = () => {
    setSelectedQuoteIds(new Set());
    setBulkActionOpen(null);
    setBulkInput('');
  };

  const toggleHeadlineSelect = (key) => {
    setSelectedHeadlineKeys(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const clearHeadlineSelection = () => {
    setSelectedHeadlineKeys(new Set());
    setBulkActionOpen(null);
    setBulkInput('');
  };

  // ─── Bulk actions ──────────────────────────────────────────────────────────
  const handleBulkUpdate = async (field, value) => {
    const ids = [...selectedQuoteIds];
    if (ids.length === 0) return;
    try {
      await api.bulkUpdateQuoteBank(projectId, ids, { [field]: value });
      setBankQuotes(prev => prev.map(q =>
        ids.includes(q.id) ? { ...q, [field]: value } : q
      ));
      toast.success(`Updated ${field} on ${ids.length} quotes`);
      setBulkActionOpen(null);
      setBulkInput('');
    } catch (err) {
      toast.error('Bulk update failed: ' + err.message);
    }
  };

  const handleBulkAddTag = async (tag) => {
    const ids = [...selectedQuoteIds];
    if (ids.length === 0 || !tag.trim()) return;
    // For tags, we need to merge — fetch current tags and add
    let updated = 0;
    for (const id of ids) {
      const q = bankQuotes.find(q => q.id === id);
      const currentTags = q?.tags || [];
      if (!currentTags.includes(tag.trim())) {
        try {
          const newTags = [...currentTags, tag.trim()];
          await api.updateQuoteBankTags(projectId, id, newTags);
          setBankQuotes(prev => prev.map(bq => bq.id === id ? { ...bq, tags: newTags } : bq));
          updated++;
        } catch (err) {
          console.warn(`Failed to add tag to quote ${id}:`, err);
        }
      }
    }
    toast.success(`Added tag "${tag.trim()}" to ${updated} quotes`);
    setBulkActionOpen(null);
    setBulkInput('');
  };

  const handleBulkRemoveTag = async (tag) => {
    const ids = [...selectedQuoteIds];
    if (ids.length === 0) return;
    let updated = 0;
    for (const id of ids) {
      const q = bankQuotes.find(q => q.id === id);
      const currentTags = q?.tags || [];
      if (currentTags.includes(tag)) {
        try {
          const newTags = currentTags.filter(t => t !== tag);
          await api.updateQuoteBankTags(projectId, id, newTags);
          setBankQuotes(prev => prev.map(bq => bq.id === id ? { ...bq, tags: newTags } : bq));
          updated++;
        } catch (err) {
          console.warn(`Failed to remove tag from quote ${id}:`, err);
        }
      }
    }
    toast.success(`Removed tag "${tag}" from ${updated} quotes`);
    setBulkActionOpen(null);
  };

  // Bulk update from headline bank — find unique quote IDs from selected headlines
  const handleHeadlineBulkUpdate = async (field, value) => {
    // Get unique quote IDs from selected headlines
    const quoteIds = [...new Set([...selectedHeadlineKeys].map(k => k.split('::')[0]))];
    if (quoteIds.length === 0) return;
    try {
      await api.bulkUpdateQuoteBank(projectId, quoteIds, { [field]: value });
      setBankQuotes(prev => prev.map(q =>
        quoteIds.includes(q.id) ? { ...q, [field]: value } : q
      ));
      toast.success(`Updated ${field} on ${quoteIds.length} source quotes`);
      setBulkActionOpen(null);
      setBulkInput('');
    } catch (err) {
      toast.error('Bulk update failed: ' + err.message);
    }
  };

  // ─── Inline editing ────────────────────────────────────────────────────────
  const startEditing = (quoteId, field, currentValue) => {
    setEditingField({ quoteId, field, value: currentValue || '' });
  };

  const startEditingHeadline = (quoteId, hlIdx, currentValue) => {
    setEditingField({ quoteId, hlIdx, field: 'headline', value: currentValue || '' });
  };

  const cancelEditing = () => {
    setEditingField(null);
  };

  const saveEdit = async () => {
    if (!editingField) return;
    setSavingEdit(true);
    try {
      if (editingField.field === 'headline' && editingField.hlIdx !== undefined) {
        // Editing a specific headline within the JSON array
        const quote = bankQuotes.find(q => q.id === editingField.quoteId);
        if (!quote) return;
        const headlines = parseHeadlines(quote.headlines);
        headlines[editingField.hlIdx] = { ...headlines[editingField.hlIdx], text: editingField.value };
        await api.updateQuoteBankQuote(projectId, editingField.quoteId, {
          headlines: JSON.stringify(headlines),
        });
        setBankQuotes(prev => prev.map(q =>
          q.id === editingField.quoteId ? { ...q, headlines: JSON.stringify(headlines) } : q
        ));
        toast.success('Headline updated');
      } else {
        // Editing emotion, problem, or quote text
        await api.updateQuoteBankQuote(projectId, editingField.quoteId, {
          [editingField.field]: editingField.value,
        });
        setBankQuotes(prev => prev.map(q =>
          q.id === editingField.quoteId ? { ...q, [editingField.field]: editingField.value } : q
        ));
        toast.success(`${editingField.field} updated`);
      }
    } catch (err) {
      toast.error('Save failed: ' + err.message);
    } finally {
      setSavingEdit(false);
      setEditingField(null);
    }
  };

  // Auto-scroll progress
  useEffect(() => {
    if (progressEndRef.current && mining) {
      progressEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [progress, mining]);

  // ─── Auto-suggest keywords, subreddits, forums, facebook groups ───────────
  useEffect(() => {
    const demo = config.target_demographic.trim();
    const prob = config.problem.trim();

    if (demo.length > 3 && prob.length > 3 &&
        keywords.length === 0 && subreddits.length === 0 &&
        forums.length === 0 && facebookGroups.length === 0) {
      clearTimeout(suggestTimeoutRef.current);
      suggestTimeoutRef.current = setTimeout(() => {
        fetchSuggestions(demo, prob);
      }, 1500);
    }

    return () => clearTimeout(suggestTimeoutRef.current);
  }, [config.target_demographic, config.problem]);

  const fetchSuggestions = async (demographic, problem) => {
    setSuggesting(true);
    try {
      const data = await api.getQuoteMinerSuggestions(projectId, demographic || config.target_demographic.trim(), problem || config.problem.trim());
      if (data.keywords?.length) setKeywords(prev => [...new Set([...prev, ...data.keywords])]);
      if (data.subreddits?.length) setSubreddits(prev => [...new Set([...prev, ...data.subreddits])]);
      if (data.forums?.length) setForums(prev => [...new Set([...prev, ...data.forums])]);
      if (data.facebook_groups?.length) setFacebookGroups(prev => [...new Set([...prev, ...data.facebook_groups])]);
      toast.success('Search suggestions loaded');
    } catch (err) {
      console.warn('Auto-suggest failed:', err.message);
    } finally {
      setSuggesting(false);
    }
  };

  // ─── Start mining ──────────────────────────────────────────────────────────
  const handleStartMining = () => {
    if (!config.target_demographic.trim() || !config.problem.trim() || keywords.length === 0) {
      toast.error('Please fill in target demographic, problem, and at least one keyword');
      return;
    }

    setMining(true);
    setProgress([]);
    setMiningStartTime(Date.now());
    setMiningElapsed(0);
    setCurrentQuotes(null);
    setCurrentRunMeta(null);
    setViewingRunId(null);
    setCurrentHeadlines(null);
    setHeadlineProgress([]);

    const { abort, done } = api.startQuoteMining(projectId, {
      target_demographic: config.target_demographic.trim(),
      problem: config.problem.trim(),
      root_cause: config.root_cause.trim() || undefined,
      keywords,
      subreddits: subreddits.length > 0 ? subreddits : undefined,
      forums: forums.length > 0 ? forums : undefined,
      facebook_groups: facebookGroups.length > 0 ? facebookGroups : undefined,
      num_quotes: config.num_quotes,
    }, (event) => {
      if (event.type === 'run_created') {
        setCurrentRunId(event.runId);
      }
      // Refresh bank after dedup completes
      if (event.type === 'bank_updated') {
        loadBank();
      }
      setProgress(prev => [...prev, event]);
    });

    abortRef.current = abort;

    done.then(() => {
      setMining(false);
      setMiningStartTime(null);
      abortRef.current = null;
      loadHistory();
      loadBank(); // Refresh bank after mining
      if (currentRunId) {
        loadRunResults(currentRunId);
      }
    }).catch(() => {
      setMining(false);
      setMiningStartTime(null);
      abortRef.current = null;
    });
  };

  // Handle loading results from current run ID when it changes
  useEffect(() => {
    if (!mining && currentRunId) {
      loadRunResults(currentRunId);
    }
  }, [mining, currentRunId]);

  // ─── Poll for completion of restored in-progress runs ──────────────────────
  useEffect(() => {
    if (!mining || !currentRunId || abortRef.current) return;

    const pollInterval = setInterval(async () => {
      try {
        const run = await api.getQuoteMiningRun(projectId, currentRunId);
        if (run.status === 'completed') {
          clearInterval(pollInterval);
          setMining(false);
          loadRunResults(currentRunId);
          loadHistory();
          loadBank();
          toast.success(`Mining complete — ${run.quote_count} quotes found`);
        } else if (run.status === 'failed') {
          clearInterval(pollInterval);
          setMining(false);
          setProgress(prev => [...prev, { type: 'error', message: run.error_message || 'Mining failed' }]);
          loadHistory();
        }
      } catch (err) {
        console.warn('Poll failed:', err.message);
      }
    }, 5000);

    return () => clearInterval(pollInterval);
  }, [mining, currentRunId]);

  const handleCancel = () => {
    if (abortRef.current) {
      abortRef.current();
      setMining(false);
      toast.info('Mining cancelled');
    }
  };

  // ─── Load run results (legacy view) ────────────────────────────────────────
  const loadRunResults = async (runId) => {
    try {
      const run = await api.getQuoteMiningRun(projectId, runId);
      if (run && run.quotes) {
        const quotes = typeof run.quotes === 'string' ? JSON.parse(run.quotes) : run.quotes;
        setCurrentQuotes(quotes);
        setCurrentRunMeta(run);
        setViewingRunId(runId);
        if (run.headlines) {
          try {
            const headlines = typeof run.headlines === 'string' ? JSON.parse(run.headlines) : run.headlines;
            setCurrentHeadlines(headlines);
          } catch { setCurrentHeadlines(null); }
        } else {
          setCurrentHeadlines(null);
        }
      }
    } catch (err) {
      console.error('Failed to load run results:', err);
    }
  };

  // ─── Quote Bank helpers ────────────────────────────────────────────────────
  const toggleFavorite = async (quoteId) => {
    try {
      await api.toggleQuoteFavorite(projectId, quoteId);
      setBankQuotes(prev => prev.map(q =>
        q.id === quoteId ? { ...q, is_favorite: !q.is_favorite } : q
      ));
    } catch (err) {
      toast.error('Failed to toggle favorite');
    }
  };

  const deleteBankQuote = async (quoteId) => {
    if (!confirm('Remove this quote from the bank?')) return;
    try {
      await api.deleteQuoteBankQuote(projectId, quoteId);
      setBankQuotes(prev => prev.filter(q => q.id !== quoteId));
      toast.success('Quote removed');
    } catch (err) {
      toast.error('Failed to delete: ' + err.message);
    }
  };

  const toggleExpand = (quoteId) => {
    setExpandedQuoteIds(prev => {
      const next = new Set(prev);
      if (next.has(quoteId)) next.delete(quoteId);
      else next.add(quoteId);
      return next;
    });
  };

  // ─── Generate headlines for bank quotes ────────────────────────────────────
  const handleGenerateBankHeadlines = () => {
    const quotesNeedingHeadlines = filteredBankQuotes.filter(q => !q.headlines || q.headlines === '[]');
    if (quotesNeedingHeadlines.length === 0 && filteredBankQuotes.length > 0) {
      // Regenerate all
    }

    setGeneratingBankHeadlines(true);
    setBankHeadlineProgress([]);

    // Get the last run's config for demographic + problem
    const lastRun = runs.length > 0 ? runs[0] : null;

    const { abort, done } = api.generateBankHeadlines(projectId, {
      target_demographic: lastRun?.target_demographic || config.target_demographic.trim() || 'target customers',
      problem: lastRun?.problem || config.problem.trim() || 'their problem',
    }, (event) => {
      setBankHeadlineProgress(prev => [...prev, event]);
    });

    bankHeadlineAbortRef.current = abort;

    done.then(() => {
      setGeneratingBankHeadlines(false);
      bankHeadlineAbortRef.current = null;
      loadBank(); // Refresh to get headlines
      toast.success('Headlines generated for bank quotes');
    }).catch((err) => {
      setGeneratingBankHeadlines(false);
      bankHeadlineAbortRef.current = null;
      if (err.name !== 'AbortError') {
        toast.error('Headline generation failed');
      }
    });
  };

  const handleCancelBankHeadlines = () => {
    if (bankHeadlineAbortRef.current) {
      bankHeadlineAbortRef.current();
      setGeneratingBankHeadlines(false);
      toast.info('Headline generation cancelled');
    }
  };

  // ─── Generate MORE headlines for a specific quote ─────────────────────────
  const handleGenerateMoreHeadlines = (quoteId) => {
    const quote = bankQuotes.find(q => q.id === quoteId);
    if (!quote) return;

    setGeneratingMoreForQuote(quoteId);

    const lastRun = runs.length > 0 ? runs[0] : null;

    const { abort, done } = api.generateMoreHeadlines(projectId, quoteId, {
      target_demographic: lastRun?.target_demographic || config.target_demographic.trim() || 'target customers',
      problem: lastRun?.problem || config.problem.trim() || 'their problem',
    }, (event) => {
      // Progress events — could show per-quote progress later
    });

    done.then(() => {
      setGeneratingMoreForQuote(null);
      loadBank(); // Refresh to get new headlines
      toast.success('New headlines generated');
    }).catch((err) => {
      setGeneratingMoreForQuote(null);
      if (err.name !== 'AbortError') {
        toast.error('Failed to generate more headlines');
      }
    });
  };

  // ─── Legacy headline generation (for run view) ────────────────────────────
  const handleGenerateHeadlines = () => {
    if (!viewingRunId) {
      toast.error('No mining run selected');
      return;
    }

    setGeneratingHeadlines(true);
    setHeadlineProgress([]);
    setCurrentHeadlines(null);

    const { abort, done } = api.generateHeadlines(projectId, viewingRunId, (event) => {
      setHeadlineProgress(prev => [...prev, event]);
      if (event.type === 'headline_complete' && event.headlines) {
        setCurrentHeadlines(event.headlines);
      }
    });

    headlineAbortRef.current = abort;

    done.then(() => {
      setGeneratingHeadlines(false);
      headlineAbortRef.current = null;
      loadRunResults(viewingRunId);
    }).catch(() => {
      setGeneratingHeadlines(false);
      headlineAbortRef.current = null;
    });
  };

  const handleCancelHeadlines = () => {
    if (headlineAbortRef.current) {
      headlineAbortRef.current();
      setGeneratingHeadlines(false);
      toast.info('Headline generation cancelled');
    }
  };

  // ─── Copy helpers ──────────────────────────────────────────────────────────
  const copyQuote = (quote) => {
    navigator.clipboard.writeText(`"${quote.quote}"`);
    toast.success('Quote copied');
  };

  const copyAllQuotes = () => {
    if (!currentQuotes) return;
    const text = currentQuotes.map((q, i) => `${i + 1}. "${q.quote}"`).join('\n\n');
    navigator.clipboard.writeText(text);
    toast.success(`${currentQuotes.length} quotes copied`);
  };

  const copyHeadline = (headline) => {
    navigator.clipboard.writeText(headline);
    toast.success('Headline copied');
  };

  const copyAllHeadlines = () => {
    if (!currentHeadlines) return;
    const text = currentHeadlines.map((h, i) => `${i + 1}. ${h}`).join('\n');
    navigator.clipboard.writeText(text);
    toast.success(`${currentHeadlines.length} headlines copied`);
  };

  const exportAsText = () => {
    if (!currentQuotes) return;
    const lines = [
      `Quote Mining Results — ${currentRunMeta?.target_demographic || 'Unknown'} × ${currentRunMeta?.problem || 'Unknown'}`,
      `Generated: ${new Date().toLocaleString()}`,
      `Total quotes: ${currentQuotes.length}`,
      '', '═══════════════════════════════════════════', '',
    ];
    currentQuotes.forEach((q, i) => {
      lines.push(`${i + 1}. "${q.quote}"`);
      lines.push(`   Emotion: ${q.emotion || 'N/A'} | Intensity: ${q.emotional_intensity || 'N/A'}`);
      lines.push(`   Source: ${q.source || 'N/A'}${q.source_url ? ` (${q.source_url})` : ''}`);
      if (q.context) lines.push(`   Context: ${q.context}`);
      lines.push('');
    });

    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `quotes-${config.target_demographic.replace(/\s+/g, '-').toLowerCase()}-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('Exported as text file');
  };

  const exportHeadlines = () => {
    if (!currentHeadlines) return;
    const lines = [
      `Headlines — ${currentRunMeta?.target_demographic || 'Unknown'} × ${currentRunMeta?.problem || 'Unknown'}`,
      `Generated: ${new Date().toLocaleString()}`,
      `Total headlines: ${currentHeadlines.length}`,
      '', '═══════════════════════════════════════════', '',
    ];
    currentHeadlines.forEach((h, i) => { lines.push(`${i + 1}. ${h}`); });

    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `headlines-${(currentRunMeta?.target_demographic || 'unknown').replace(/\s+/g, '-').toLowerCase()}-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('Exported headlines');
  };

  // ─── Delete run ────────────────────────────────────────────────────────────
  const handleDeleteRun = async (runId) => {
    if (!confirm('Delete this mining run?')) return;
    try {
      await api.deleteQuoteMiningRun(projectId, runId);
      setRuns(prev => prev.filter(r => r.id !== runId));
      if (viewingRunId === runId) {
        setCurrentQuotes(null);
        setCurrentRunMeta(null);
        setViewingRunId(null);
      }
      toast.success('Run deleted');
    } catch (err) {
      toast.error('Failed to delete: ' + err.message);
    }
  };

  // ─── Engine status helpers ─────────────────────────────────────────────────
  const getEngineStatus = (engine) => {
    const events = progress.filter(e => e.engine === engine);
    const started = events.find(e => e.type === 'engine_start');
    const completed = events.find(e => e.type === 'engine_complete');
    const error = events.find(e => e.type === 'engine_error');
    if (error) return 'error';
    if (completed) return 'complete';
    if (started) return 'running';
    return 'pending';
  };

  const getMergeStatus = () => {
    const started = progress.find(e => e.type === 'merge_start');
    const completed = progress.find(e => e.type === 'merge_complete');
    if (completed) return 'complete';
    if (started) return 'running';
    return 'pending';
  };

  // ─── Filtered bank quotes (with Notion-style filters) ──────────────────────
  const bankProblemF = bankFilters.get('problem');
  const bankEmotionF = bankFilters.get('emotion');
  const bankTagF = bankFilters.get('tag');
  const filteredBankQuotes = bankQuotes
    .filter(q => bankFilter === 'favorites' ? q.is_favorite : true)
    .filter(q => !bankProblemF || bankProblemF.size === 0 ? true : bankProblemF.has(q.problem))
    .filter(q => !bankEmotionF || bankEmotionF.size === 0 ? true : bankEmotionF.has(q.emotion))
    .filter(q => !bankTagF || bankTagF.size === 0 ? true : (q.tags || []).some(t => bankTagF.has(t)));

  // Unique filter options for Quote Bank
  const bankUniqueProblems = [...new Set(bankQuotes.map(q => q.problem).filter(Boolean))].sort();
  const bankUniqueEmotions = [...new Set(bankQuotes.map(q => q.emotion).filter(Boolean))].sort();
  const bankUniqueTags = [...new Set(bankQuotes.flatMap(q => q.tags || []))].sort();
  const hasBankFilters = bankFilters.size > 0;

  // Bank filter properties for NotionFilter component
  const bankFilterProperties = [
    { key: 'problem', label: 'Problem', values: bankUniqueProblems },
    { key: 'emotion', label: 'Emotion', values: bankUniqueEmotions },
    { key: 'tag', label: 'Tag', values: bankUniqueTags },
  ];

  const quotesWithHeadlines = filteredBankQuotes.filter(q => q.headlines && q.headlines !== '[]');
  const quotesWithoutHeadlines = filteredBankQuotes.filter(q => !q.headlines || q.headlines === '[]');

  // Parse headlines helper — normalizes both old (string[]) and new ({ text, technique }[]) formats
  const parseHeadlines = (headlinesStr) => {
    if (!headlinesStr) return [];
    try {
      const parsed = JSON.parse(headlinesStr);
      if (!Array.isArray(parsed)) return [];
      return parsed.map(h => {
        if (typeof h === 'string') return { text: h, technique: null };
        if (h && typeof h === 'object' && h.text) return { text: h.text, technique: h.technique || null };
        return null;
      }).filter(Boolean);
    } catch {
      return [];
    }
  };

  // ─── Headline Bank computed data ──────────────────────────────────────────
  const allHeadlinesFlat = bankQuotes.flatMap(q => {
    const hls = parseHeadlines(q.headlines);
    return hls.map((hl, hlIdx) => ({
      headline: hl.text,
      technique: hl.technique,
      hlIdx,
      quoteId: q.id,
      key: `${q.id}::${hlIdx}`,
      quoteText: q.quote,
      emotion: q.emotion,
      emotional_intensity: q.emotional_intensity,
      source: q.source,
      problem: q.problem,
      tags: q.tags || [],
      isUsed: (usageData.usedHeadlines[q.id] || []).includes(hl.text),
    }));
  });
  const totalHeadlines = allHeadlinesFlat.length;
  const usedHeadlineCount = allHeadlinesFlat.filter(h => h.isUsed).length;
  const unusedHeadlineCount = totalHeadlines - usedHeadlineCount;

  // Unique filter options
  const uniqueProblems = [...new Set(allHeadlinesFlat.map(h => h.problem).filter(Boolean))].sort();
  const uniqueEmotions = [...new Set(allHeadlinesFlat.map(h => h.emotion).filter(Boolean))].sort();
  const uniqueTags = [...new Set(allHeadlinesFlat.flatMap(h => h.tags))].sort();
  const uniqueTechniques = [...new Set(allHeadlinesFlat.map(h => h.technique).filter(Boolean))].sort();

  // Headline filter properties for NotionFilter component
  const headlineFilterProperties = [
    { key: 'problem', label: 'Problem', values: uniqueProblems },
    { key: 'emotion', label: 'Emotion', values: uniqueEmotions },
    { key: 'tag', label: 'Tag', values: uniqueTags },
    { key: 'technique', label: 'Technique', values: uniqueTechniques },
  ];

  // Detect quotes needing backfill
  const quotesNeedingBackfill = bankQuotes.filter(q => !q.problem).length;

  // Bank stats
  const quotesWithHeadlinesCount = bankQuotes.filter(q => q.headlines && q.headlines !== '[]').length;

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6 fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 tracking-tight flex items-center gap-2">
            <svg className="w-5 h-5 text-purple-500" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
            </svg>
            Copywriter
          </h2>
          <p className="text-[12px] text-gray-500 mt-0.5">
            Mine quotes, generate headlines, and turn them into ads.
          </p>
        </div>
      </div>

      {/* Sub-tab navigation */}
      <div className="flex items-center justify-between">
        <div className="segmented-control">
          <button onClick={() => setSubTab('mine')} className={subTab === 'mine' ? 'active' : ''}>
            Mine Quotes
          </button>
          <button onClick={() => setSubTab('bank')} className={subTab === 'bank' ? 'active' : ''}>
            Quote Bank{bankQuotes.length > 0 ? ` (${bankQuotes.length})` : ''}
          </button>
          <button onClick={() => setSubTab('headlines')} className={subTab === 'headlines' ? 'active' : ''}>
            Headline Bank{totalHeadlines > 0 ? ` (${totalHeadlines})` : ''}
          </button>
        </div>
        {runs.length > 0 && subTab === 'mine' && (
          <button
            onClick={() => setHistoryOpen(prev => !prev)}
            className="btn-secondary text-[12px] flex items-center gap-1.5"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            History ({runs.length})
          </button>
        )}
      </div>

      {/* ═══════════════════════════════════════════════════════════════════════════
          HEADLINE BANK TAB — flat list of all headlines with usage tracking
          ═══════════════════════════════════════════════════════════════════════════ */}
      {subTab === 'headlines' && (
        <div className="space-y-4">
          {/* Stats bar */}
          <div className="card p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4 flex-wrap">
                <span className="text-[13px] font-semibold text-gray-800">{totalHeadlines} headlines</span>
                <span className="text-[12px] text-green-600 font-medium">{usedHeadlineCount} used</span>
                <span className="text-[12px] text-gray-400">{unusedHeadlineCount} unused</span>
                {uniqueTechniques.length > 0 && (
                  <span className="text-[11px] text-amber-600 font-medium">{uniqueTechniques.length} techniques</span>
                )}
                {quotesWithHeadlinesCount > 0 && (
                  <span className="text-[11px] text-purple-500">{quotesWithHeadlinesCount} quotes with headlines</span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button onClick={loadUsage} className="btn-secondary text-[11px] flex items-center gap-1">
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182" />
                  </svg>
                  Refresh
                </button>
              </div>
            </div>
          </div>

          {/* Backfill banner */}
          {quotesNeedingBackfill > 0 && (
            <div className="flex items-center gap-3 p-3 rounded-xl bg-amber-50 border border-amber-200">
              <svg className="w-4 h-4 text-amber-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
              </svg>
              <span className="text-[12px] text-amber-700">{quotesNeedingBackfill} quotes missing problem labels.</span>
              <button
                onClick={handleBackfillProblems}
                disabled={backfilling}
                className="text-[11px] font-semibold text-amber-700 hover:text-amber-900 underline disabled:opacity-50"
              >
                {backfilling ? 'Fixing…' : 'Fix now'}
              </button>
            </div>
          )}

          {/* Filters */}
          {totalHeadlines > 0 && (
            <div className="space-y-2">
              {/* Status filter */}
              <div className="flex items-center gap-2 flex-wrap">
                <div className="segmented-control text-[11px]">
                  <button onClick={() => setHeadlineFilter('all')} className={headlineFilter === 'all' ? 'active' : ''}>
                    All ({totalHeadlines})
                  </button>
                  <button onClick={() => setHeadlineFilter('used')} className={headlineFilter === 'used' ? 'active' : ''}>
                    Used ({usedHeadlineCount})
                  </button>
                  <button onClick={() => setHeadlineFilter('unused')} className={headlineFilter === 'unused' ? 'active' : ''}>
                    Unused ({unusedHeadlineCount})
                  </button>
                </div>

                {/* Notion-style property filters */}
                <span className="text-gray-200">|</span>
                <NotionFilter
                  properties={headlineFilterProperties}
                  filters={headlineFilters}
                  onToggle={(key, val) => toggleMapFilter(setHeadlineFilters, key, val)}
                  onClear={(key) => clearMapFilter(setHeadlineFilters, key)}
                />
              </div>
            </div>
          )}

          {/* Headline list */}
          {totalHeadlines === 0 ? (
            <div className="text-center py-8 text-gray-400">
              <p className="text-[13px]">No headlines yet. Generate headlines from your Quote Bank first.</p>
              <button onClick={() => setSubTab('bank')} className="text-[12px] text-purple-600 hover:text-purple-700 mt-2 font-medium">
                Go to Quote Bank →
              </button>
            </div>
          ) : (() => {
            const hlProbF = headlineFilters.get('problem');
            const hlEmotF = headlineFilters.get('emotion');
            const hlTagF = headlineFilters.get('tag');
            const hlTechF = headlineFilters.get('technique');
            const filtered = allHeadlinesFlat
              .filter(h => headlineFilter === 'all' ? true : headlineFilter === 'used' ? h.isUsed : !h.isUsed)
              .filter(h => !hlProbF || hlProbF.size === 0 ? true : hlProbF.has(h.problem))
              .filter(h => !hlEmotF || hlEmotF.size === 0 ? true : hlEmotF.has(h.emotion))
              .filter(h => !hlTagF || hlTagF.size === 0 ? true : h.tags.some(t => hlTagF.has(t)))
              .filter(h => !hlTechF || hlTechF.size === 0 ? true : hlTechF.has(h.technique));
            const allFilteredSelected = filtered.length > 0 && filtered.every(h => selectedHeadlineKeys.has(h.key));
            return (
              <>
                {/* Bulk action bar */}
                {selectedHeadlineKeys.size > 0 && (
                  <div className="sticky top-0 z-10 flex items-center gap-3 p-3 rounded-xl bg-purple-50 border border-purple-200 shadow-sm">
                    <span className="text-[12px] font-semibold text-purple-700">{selectedHeadlineKeys.size} selected</span>
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => setBulkActionOpen(bulkActionOpen === 'hl-problem' ? null : 'hl-problem')}
                        className="text-[11px] px-2.5 py-1 rounded-lg bg-white border border-purple-200 text-purple-700 hover:bg-purple-100 transition-all font-medium"
                      >Set Problem</button>
                      <button
                        onClick={() => setBulkActionOpen(bulkActionOpen === 'hl-emotion' ? null : 'hl-emotion')}
                        className="text-[11px] px-2.5 py-1 rounded-lg bg-white border border-purple-200 text-purple-700 hover:bg-purple-100 transition-all font-medium"
                      >Set Emotion</button>
                      <button
                        onClick={() => setBulkActionOpen(bulkActionOpen === 'hl-tag' ? null : 'hl-tag')}
                        className="text-[11px] px-2.5 py-1 rounded-lg bg-white border border-purple-200 text-purple-700 hover:bg-purple-100 transition-all font-medium"
                      >Add Tag</button>
                    </div>
                    <button onClick={clearHeadlineSelection} className="text-[11px] text-gray-500 hover:text-gray-700 ml-auto">Clear</button>
                  </div>
                )}

                {/* Bulk action input */}
                {bulkActionOpen && bulkActionOpen.startsWith('hl-') && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!bulkInput.trim()) return;
                      if (bulkActionOpen === 'hl-tag') {
                        // Add tag to all source quotes of selected headlines
                        const quoteIds = [...new Set([...selectedHeadlineKeys].map(k => k.split('::')[0]))];
                        (async () => {
                          for (const id of quoteIds) {
                            const q = bankQuotes.find(bq => bq.id === id);
                            const currentTags = q?.tags || [];
                            if (!currentTags.includes(bulkInput.trim())) {
                              await api.updateQuoteBankTags(projectId, id, [...currentTags, bulkInput.trim()]);
                            }
                          }
                          setBankQuotes(prev => prev.map(q =>
                            quoteIds.includes(q.id) ? { ...q, tags: [...new Set([...(q.tags || []), bulkInput.trim()])] } : q
                          ));
                          toast.success(`Added tag to ${quoteIds.length} source quotes`);
                          setBulkActionOpen(null);
                          setBulkInput('');
                        })();
                      } else {
                        const field = bulkActionOpen === 'hl-problem' ? 'problem' : 'emotion';
                        handleHeadlineBulkUpdate(field, bulkInput.trim());
                      }
                    }}
                    className="flex items-center gap-2 p-2 rounded-xl bg-gray-50 border border-gray-200"
                  >
                    <input
                      autoFocus
                      value={bulkInput}
                      onChange={e => setBulkInput(e.target.value)}
                      placeholder={bulkActionOpen === 'hl-problem' ? 'New problem label...' : bulkActionOpen === 'hl-emotion' ? 'New emotion...' : 'Tag name...'}
                      className="text-[12px] flex-1 px-3 py-1.5 rounded-lg border border-gray-200 outline-none focus:ring-2 focus:ring-purple-300 focus:border-purple-300"
                    />
                    <button type="submit" className="text-[11px] px-3 py-1.5 rounded-lg bg-purple-600 text-white font-medium hover:bg-purple-700">Apply</button>
                    <button type="button" onClick={() => { setBulkActionOpen(null); setBulkInput(''); }} className="text-[11px] text-gray-500 hover:text-gray-700">Cancel</button>
                  </form>
                )}

                {filtered.length === 0 ? (
                  <div className="text-center py-6 text-gray-400">
                    <p className="text-[12px]">No headlines match the current filters.</p>
                    <button
                      onClick={() => { setHeadlineFilter('all'); setHeadlineFilters(new Map()); }}
                      className="text-[11px] text-purple-600 hover:text-purple-700 mt-1 font-medium"
                    >Clear filters</button>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {/* Select All header row — aligned with per-item checkboxes */}
                    <div className="flex items-center gap-3 px-3 py-1.5 rounded-lg bg-gray-50/80 border border-gray-100">
                      <input
                        type="checkbox"
                        checked={allFilteredSelected}
                        onChange={() => {
                          if (allFilteredSelected) {
                            clearHeadlineSelection();
                          } else {
                            setSelectedHeadlineKeys(new Set(filtered.map(h => h.key)));
                          }
                        }}
                        className="w-3.5 h-3.5 rounded border-gray-300 text-purple-600 focus:ring-purple-500 flex-shrink-0"
                      />
                      <span className="text-[10px] text-gray-500 font-medium">Select all</span>
                      <span className="text-[10px] text-gray-400 ml-auto">{filtered.length} of {totalHeadlines} headlines</span>
                    </div>
                    {filtered.map((h, idx) => {
                      const prevQuoteId = idx > 0 ? filtered[idx - 1].quoteId : null;
                      const showGroupSep = idx > 0 && h.quoteId !== prevQuoteId;
                      const isLastInGroup = idx === filtered.length - 1 || filtered[idx + 1]?.quoteId !== h.quoteId;
                      const isSelected = selectedHeadlineKeys.has(h.key);
                      const isEditingThis = editingField && editingField.quoteId === h.quoteId && editingField.hlIdx === h.hlIdx && editingField.field === 'headline';
                      return (
                        <React.Fragment key={h.key}>
                          {showGroupSep && (
                            <div className="flex items-center gap-2 pt-3 pb-1">
                              <div className="flex-1 border-t border-gray-200/60" />
                              <button
                                onClick={() => handleGenerateMoreHeadlines(prevQuoteId)}
                                disabled={generatingMoreForQuote === prevQuoteId}
                                className="inline-flex items-center gap-1 text-[9px] font-medium text-purple-500 hover:text-purple-700 transition-colors"
                              >
                                {generatingMoreForQuote === prevQuoteId ? (
                                  <svg className="w-2.5 h-2.5 animate-spin" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" /><path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="4" strokeLinecap="round" className="opacity-75" /></svg>
                                ) : (
                                  <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
                                )}
                                Generate More
                              </button>
                              <div className="flex-1 border-t border-gray-200/60" />
                            </div>
                          )}
                          <div className={`flex items-start gap-3 p-3 rounded-xl bg-white border transition-all ${
                            isSelected ? 'border-purple-300 bg-purple-50/30' : 'border-gray-100 hover:border-gray-200'
                          }`}>
                            <input
                              type="checkbox"
                              checked={isSelected}
                              onChange={() => toggleHeadlineSelect(h.key)}
                              className="w-3.5 h-3.5 mt-1 rounded border-gray-300 text-purple-600 focus:ring-purple-500 flex-shrink-0"
                            />
                            <span className={`flex-shrink-0 mt-0.5 text-[9px] font-bold px-2 py-0.5 rounded-full ${
                              h.isUsed ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
                            }`}>
                              {h.isUsed ? 'Used' : 'Unused'}
                            </span>
                            <div className="flex-1 min-w-0">
                              {isEditingThis ? (
                                <form onSubmit={(e) => { e.preventDefault(); saveEdit(); }} className="flex items-center gap-2">
                                  <input
                                    autoFocus
                                    value={editingField.value}
                                    onChange={e => setEditingField(prev => ({ ...prev, value: e.target.value }))}
                                    className="flex-1 text-[13px] font-medium text-gray-800 px-2 py-1 rounded-lg border border-purple-300 outline-none focus:ring-2 focus:ring-purple-200"
                                  />
                                  <button type="submit" disabled={savingEdit} className="text-[10px] px-2 py-1 rounded-lg bg-purple-600 text-white font-medium">{savingEdit ? '...' : 'Save'}</button>
                                  <button type="button" onClick={cancelEditing} className="text-[10px] text-gray-500">Cancel</button>
                                </form>
                              ) : (
                                <p
                                  className="text-[13px] font-medium text-gray-800 leading-relaxed cursor-pointer hover:bg-purple-50/50 rounded px-1 -mx-1 transition-colors"
                                  onClick={() => startEditingHeadline(h.quoteId, h.hlIdx, h.headline)}
                                  title="Click to edit headline"
                                >{h.headline}</p>
                              )}
                              <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                                {h.problem && (
                                  <span
                                    className="text-[9px] font-semibold px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 cursor-pointer hover:bg-blue-100 transition-colors"
                                    onClick={() => toggleMapFilter(setHeadlineFilters, 'problem', h.problem)}
                                    title={`Filter by: ${h.problem}`}
                                  >
                                    {h.problem}
                                  </span>
                                )}
                                {h.emotion && (
                                  <span
                                    className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-full cursor-pointer hover:opacity-80 transition-opacity ${EMOTION_COLORS[h.emotion] || 'bg-gray-100 text-gray-600'}`}
                                    onClick={() => toggleMapFilter(setHeadlineFilters, 'emotion', h.emotion)}
                                    title={`Filter by: ${h.emotion}`}
                                  >
                                    {h.emotion}
                                  </span>
                                )}
                                {h.tags.map(t => (
                                  <span
                                    key={t}
                                    className="text-[9px] font-medium px-1.5 py-0.5 rounded-full bg-teal-50 text-teal-600 cursor-pointer hover:bg-teal-100 transition-colors"
                                    onClick={() => toggleMapFilter(setHeadlineFilters, 'tag', t)}
                                    title={`Filter by tag: ${t}`}
                                  >
                                    {t}
                                  </span>
                                ))}
                                {h.technique && (
                                  <span
                                    className="text-[9px] font-medium px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700 cursor-pointer hover:bg-amber-100 transition-colors"
                                    onClick={() => toggleMapFilter(setHeadlineFilters, 'technique', h.technique)}
                                    title={`Filter by technique: ${h.technique}`}
                                  >
                                    {h.technique}
                                  </span>
                                )}
                                <p className="text-[10px] text-gray-400 truncate max-w-[250px]" title={h.quoteText}>
                                  &ldquo;{h.quoteText.length > 50 ? h.quoteText.slice(0, 50) + '...' : h.quoteText}&rdquo;
                                </p>
                              </div>
                            </div>
                            <div className="flex items-center gap-1.5 flex-shrink-0">
                              <button
                                onClick={() => copyHeadline(h.headline)}
                                className="text-gray-400 hover:text-purple-600 transition-colors p-1"
                                title="Copy headline"
                              >
                                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25H10.5a2.25 2.25 0 00-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
                                </svg>
                              </button>
                              <button
                                onClick={() => {
                                  const srcQuote = bankQuotes.find(q => q.id === h.quoteId);
                                  if (srcQuote && onSendToAdStudio) {
                                    onSendToAdStudio({
                                      headline: h.headline,
                                      sourceQuoteId: srcQuote.id,
                                      quoteText: srcQuote.quote,
                                      emotion: srcQuote.emotion,
                                      problem: srcQuote.problem || config.problem,
                                    });
                                  }
                                }}
                                className="inline-flex items-center gap-1 text-[10px] font-semibold text-purple-600 hover:text-white bg-purple-50 hover:bg-purple-600 px-2.5 py-1 rounded-lg transition-all"
                                title="Turn this headline into an ad"
                              >
                                Turn into Ad
                                <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                                </svg>
                              </button>
                            </div>
                          </div>
                          {/* Generate More button at end of last group */}
                          {isLastInGroup && idx === filtered.length - 1 && (
                            <div className="flex items-center gap-2 pt-2">
                              <div className="flex-1 border-t border-gray-200/60" />
                              <button
                                onClick={() => handleGenerateMoreHeadlines(h.quoteId)}
                                disabled={generatingMoreForQuote === h.quoteId}
                                className="inline-flex items-center gap-1 text-[9px] font-medium text-purple-500 hover:text-purple-700 transition-colors"
                              >
                                {generatingMoreForQuote === h.quoteId ? (
                                  <svg className="w-2.5 h-2.5 animate-spin" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" /><path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="4" strokeLinecap="round" className="opacity-75" /></svg>
                                ) : (
                                  <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" /></svg>
                                )}
                                Generate More
                              </button>
                              <div className="flex-1 border-t border-gray-200/60" />
                            </div>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </div>
                )}
              </>
            );
          })()}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════════════
          QUOTE BANK TAB — persistent quotes across runs
          ═══════════════════════════════════════════════════════════════════════════ */}
      {subTab === 'bank' && (
        <div className="space-y-4">
          {/* Stats bar */}
          <div className="card p-4">
            <div className="flex items-center gap-4 text-[13px] flex-wrap">
              <span className="font-semibold text-gray-800">{bankQuotes.length} quotes</span>
              <span className="text-gray-400">·</span>
              <span className="text-gray-500">{quotesWithHeadlinesCount} with headlines</span>
              <span className="text-gray-400">·</span>
              <span className="text-gray-500">{totalHeadlines} total headlines</span>
              {uniqueProblems.length > 0 && (
                <>
                  <span className="text-gray-400">·</span>
                  <span className="text-gray-500">{uniqueProblems.length} problem{uniqueProblems.length !== 1 ? 's' : ''}</span>
                </>
              )}
            </div>
            {uniqueProblems.length > 0 && (
              <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                {uniqueProblems.map(p => (
                  <span key={p} className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-blue-50 text-blue-700">
                    {p}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* Backfill banner */}
          {quotesNeedingBackfill > 0 && (
            <div className="flex items-center gap-3 p-3 rounded-xl bg-amber-50 border border-amber-200">
              <svg className="w-4 h-4 text-amber-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
              </svg>
              <span className="text-[12px] text-amber-700">{quotesNeedingBackfill} quotes missing problem labels.</span>
              <button
                onClick={handleBackfillProblems}
                disabled={backfilling}
                className="text-[11px] font-semibold text-amber-700 hover:text-amber-900 underline disabled:opacity-50"
              >
                {backfilling ? 'Fixing...' : 'Fix now'}
              </button>
            </div>
          )}

          {bankQuotes.length === 0 ? (
            <div className="text-center py-8 text-gray-400">
              <svg className="w-12 h-12 mx-auto mb-3 text-gray-200" fill="none" viewBox="0 0 24 24" strokeWidth={1} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M20.25 6.375c0 2.278-3.694 4.125-8.25 4.125S3.75 8.653 3.75 6.375m16.5 0c0-2.278-3.694-4.125-8.25-4.125S3.75 4.097 3.75 6.375m16.5 0v11.25c0 2.278-3.694 4.125-8.25 4.125s-8.25-1.847-8.25-4.125V6.375" />
              </svg>
              <p className="text-[13px]">No quotes in the bank yet.</p>
              {runs.filter(r => r.status === 'completed' && r.quote_count > 0).length > 0 ? (
                <div className="mt-3 space-y-2">
                  <p className="text-[12px] text-gray-500">
                    You have {runs.filter(r => r.status === 'completed' && r.quote_count > 0).length} past run{runs.filter(r => r.status === 'completed' && r.quote_count > 0).length !== 1 ? 's' : ''} with quotes that can be imported.
                  </p>
                  <button
                    onClick={handleImportAllRuns}
                    disabled={importing}
                    className="btn-primary text-[12px] inline-flex items-center gap-1.5 disabled:opacity-50"
                  >
                    {importing ? (
                      <>
                        <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4 31.4" strokeLinecap="round" />
                        </svg>
                        Importing...
                      </>
                    ) : (
                      <>
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                        </svg>
                        Import All Past Runs to Quote Bank
                      </>
                    )}
                  </button>
                </div>
              ) : (
                <button onClick={() => setSubTab('mine')} className="text-[12px] text-purple-600 hover:text-purple-700 mt-2 font-medium">
                  Mine Quotes to get started →
                </button>
              )}
            </div>
          ) : (
            <>
              {/* Bank controls */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="segmented-control text-[11px]">
                    <button onClick={() => setBankFilter('all')} className={bankFilter === 'all' ? 'active' : ''}>
                      All ({bankQuotes.length})
                    </button>
                    <button onClick={() => setBankFilter('favorites')} className={bankFilter === 'favorites' ? 'active' : ''}>
                      ★ Favorites ({bankQuotes.filter(q => q.is_favorite).length})
                    </button>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {!generatingBankHeadlines && (
                    <button
                      onClick={handleGenerateBankHeadlines}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium rounded-lg bg-purple-600 text-white hover:bg-purple-700 shadow-sm transition-all"
                    >
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
                      </svg>
                      {quotesWithoutHeadlines.length > 0
                        ? `Generate Headlines (${quotesWithoutHeadlines.length} quotes)`
                        : 'Regenerate All Headlines'}
                    </button>
                  )}
                  {generatingBankHeadlines && (
                    <button onClick={handleCancelBankHeadlines} className="text-[11px] text-red-500 hover:text-red-700 font-medium">
                      Cancel
                    </button>
                  )}
                </div>
              </div>

              {/* Quote Bank Notion-style filters */}
              {(bankUniqueProblems.length > 0 || bankUniqueEmotions.length > 0 || bankUniqueTags.length > 0) && (
                <NotionFilter
                  properties={bankFilterProperties}
                  filters={bankFilters}
                  onToggle={(key, val) => toggleMapFilter(setBankFilters, key, val)}
                  onClear={(key) => clearMapFilter(setBankFilters, key)}
                />
              )}

              {/* Bulk action bar for Quote Bank */}
              {selectedQuoteIds.size > 0 && (
                <div className="sticky top-0 z-10 flex items-center gap-3 p-3 rounded-xl bg-blue-50 border border-blue-200 shadow-sm">
                  <span className="text-[12px] font-semibold text-blue-700">{selectedQuoteIds.size} selected</span>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => setBulkActionOpen(bulkActionOpen === 'qb-problem' ? null : 'qb-problem')}
                      className="text-[11px] px-2.5 py-1 rounded-lg bg-white border border-blue-200 text-blue-700 hover:bg-blue-100 transition-all font-medium"
                    >Set Problem</button>
                    <button
                      onClick={() => setBulkActionOpen(bulkActionOpen === 'qb-emotion' ? null : 'qb-emotion')}
                      className="text-[11px] px-2.5 py-1 rounded-lg bg-white border border-blue-200 text-blue-700 hover:bg-blue-100 transition-all font-medium"
                    >Set Emotion</button>
                    <button
                      onClick={() => setBulkActionOpen(bulkActionOpen === 'qb-tag' ? null : 'qb-tag')}
                      className="text-[11px] px-2.5 py-1 rounded-lg bg-white border border-blue-200 text-blue-700 hover:bg-blue-100 transition-all font-medium"
                    >Add Tag</button>
                    {/* Remove tag if any selected quotes have tags */}
                    {(() => {
                      const allTags = [...new Set([...selectedQuoteIds].flatMap(id => {
                        const q = bankQuotes.find(bq => bq.id === id);
                        return q?.tags || [];
                      }))];
                      return allTags.length > 0 ? (
                        <button
                          onClick={() => setBulkActionOpen(bulkActionOpen === 'qb-removetag' ? null : 'qb-removetag')}
                          className="text-[11px] px-2.5 py-1 rounded-lg bg-white border border-red-200 text-red-600 hover:bg-red-50 transition-all font-medium"
                        >Remove Tag</button>
                      ) : null;
                    })()}
                  </div>
                  <button onClick={clearQuoteSelection} className="text-[11px] text-gray-500 hover:text-gray-700 ml-auto">Clear</button>
                </div>
              )}

              {/* Bulk action input for Quote Bank */}
              {bulkActionOpen && bulkActionOpen.startsWith('qb-') && bulkActionOpen !== 'qb-removetag' && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!bulkInput.trim()) return;
                    if (bulkActionOpen === 'qb-tag') {
                      handleBulkAddTag(bulkInput.trim());
                    } else {
                      const field = bulkActionOpen === 'qb-problem' ? 'problem' : 'emotion';
                      handleBulkUpdate(field, bulkInput.trim());
                    }
                  }}
                  className="flex items-center gap-2 p-2 rounded-xl bg-gray-50 border border-gray-200"
                >
                  <input
                    autoFocus
                    value={bulkInput}
                    onChange={e => setBulkInput(e.target.value)}
                    placeholder={bulkActionOpen === 'qb-problem' ? 'New problem label...' : bulkActionOpen === 'qb-emotion' ? 'New emotion...' : 'Tag name...'}
                    className="text-[12px] flex-1 px-3 py-1.5 rounded-lg border border-gray-200 outline-none focus:ring-2 focus:ring-blue-300 focus:border-blue-300"
                  />
                  <button type="submit" className="text-[11px] px-3 py-1.5 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700">Apply</button>
                  <button type="button" onClick={() => { setBulkActionOpen(null); setBulkInput(''); }} className="text-[11px] text-gray-500 hover:text-gray-700">Cancel</button>
                </form>
              )}

              {/* Remove tag picker */}
              {bulkActionOpen === 'qb-removetag' && (() => {
                const allTags = [...new Set([...selectedQuoteIds].flatMap(id => {
                  const q = bankQuotes.find(bq => bq.id === id);
                  return q?.tags || [];
                }))].sort();
                return (
                  <div className="flex items-center gap-2 p-2 rounded-xl bg-gray-50 border border-gray-200 flex-wrap">
                    <span className="text-[11px] text-gray-500 font-medium">Remove tag:</span>
                    {allTags.map(t => (
                      <button
                        key={t}
                        onClick={() => handleBulkRemoveTag(t)}
                        className="text-[10px] px-2 py-0.5 rounded-full bg-red-50 text-red-600 border border-red-200 hover:bg-red-100 transition-colors font-medium"
                      >{t} ×</button>
                    ))}
                    <button onClick={() => setBulkActionOpen(null)} className="text-[11px] text-gray-500 hover:text-gray-700 ml-auto">Cancel</button>
                  </div>
                );
              })()}

              {/* Bank headline progress */}
              {generatingBankHeadlines && (
                <div className="p-3 bg-purple-50/60 rounded-xl border border-purple-100 space-y-2">
                  <div className="flex items-center gap-2">
                    <svg className="w-3.5 h-3.5 animate-spin text-purple-500" viewBox="0 0 24 24" fill="none">
                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4 31.4" strokeLinecap="round" />
                    </svg>
                    <span className="text-[12px] font-semibold text-purple-700">Generating headlines for bank quotes...</span>
                  </div>
                  <div className="bg-white/60 rounded-lg p-2 max-h-[100px] overflow-y-auto text-[10px] font-mono text-gray-500 space-y-0.5">
                    {bankHeadlineProgress.map((event, i) => (
                      <div key={i} className={event.type === 'error' ? 'text-red-500' : event.type?.includes('complete') ? 'text-green-600' : ''}>
                        {event.message || JSON.stringify(event)}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Bank quote cards */}
              <div className="space-y-2">
                {/* Select All header row — aligned with per-item checkboxes */}
                {filteredBankQuotes.length > 0 && (
                  <div className="flex items-center gap-3 px-3 py-1.5 rounded-lg bg-gray-50/80 border border-gray-100">
                    <input
                      type="checkbox"
                      checked={filteredBankQuotes.length > 0 && filteredBankQuotes.every(q => selectedQuoteIds.has(q.id))}
                      onChange={() => {
                        if (filteredBankQuotes.every(q => selectedQuoteIds.has(q.id))) {
                          clearQuoteSelection();
                        } else {
                          selectAllQuotes();
                        }
                      }}
                      className="w-3.5 h-3.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500 flex-shrink-0"
                    />
                    <span className="text-[10px] text-gray-500 font-medium">Select all</span>
                    <span className="text-[10px] text-gray-400 ml-auto">{filteredBankQuotes.length} quotes</span>
                  </div>
                )}
                {filteredBankQuotes.length === 0 && (
                  <p className="text-[12px] text-gray-400 py-4 text-center">
                    {hasBankFilters ? 'No quotes match the current filters.' : bankFilter === 'favorites' ? 'No favorite quotes yet. Star quotes to add them here.' : 'No quotes in bank.'}
                  </p>
                )}
                {filteredBankQuotes.map((quote) => {
                  const headlines = parseHeadlines(quote.headlines);
                  const isExpanded = expandedQuoteIds.has(quote.id);
                  const quoteUsedHeadlines = usageData.usedHeadlines[quote.id] || [];
                  const isQuoteSelected = selectedQuoteIds.has(quote.id);

                  return (
                    <div key={quote.id} className={`rounded-xl border overflow-hidden transition-all ${
                      isQuoteSelected ? 'border-blue-300 bg-blue-50/20' : 'border-gray-100 hover:border-gray-200'
                    }`}>
                      {/* Quote row */}
                      <div
                        className="flex items-start gap-3 p-3 cursor-pointer hover:bg-gray-50/50 transition-colors"
                        onClick={() => toggleExpand(quote.id)}
                      >
                        {/* Checkbox */}
                        <input
                          type="checkbox"
                          checked={isQuoteSelected}
                          onChange={(e) => { e.stopPropagation(); toggleQuoteSelect(quote.id); }}
                          onClick={e => e.stopPropagation()}
                          className="w-3.5 h-3.5 mt-1 rounded border-gray-300 text-blue-600 focus:ring-blue-500 flex-shrink-0"
                        />

                        {/* Expand chevron */}
                        <svg className={`w-4 h-4 text-gray-300 mt-0.5 flex-shrink-0 transition-transform ${isExpanded ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                        </svg>

                        {/* Quote text */}
                        <div className="flex-1 min-w-0">
                          <p className="text-[13px] text-gray-800 leading-relaxed italic">
                            &ldquo;{quote.quote.length > 150 && !isExpanded ? quote.quote.slice(0, 150) + '...' : quote.quote}&rdquo;
                          </p>
                          <div className="flex items-center flex-wrap gap-1.5 mt-1.5">
                            {quote.problem && (
                              <span
                                className="text-[9px] font-semibold px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 cursor-pointer hover:bg-blue-100 transition-colors"
                                onClick={(e) => { e.stopPropagation(); startEditing(quote.id, 'problem', quote.problem); }}
                                title="Click to edit problem"
                              >
                                {quote.problem}
                              </span>
                            )}
                            {quote.emotion && (
                              <span
                                className={`text-[9px] font-semibold px-1.5 py-0.5 rounded-full cursor-pointer hover:opacity-80 transition-opacity ${EMOTION_COLORS[quote.emotion] || 'bg-gray-100 text-gray-600'}`}
                                onClick={(e) => { e.stopPropagation(); startEditing(quote.id, 'emotion', quote.emotion); }}
                                title="Click to edit emotion"
                              >
                                {quote.emotion}
                              </span>
                            )}
                            {!quote.problem && (
                              <button
                                className="text-[9px] text-gray-400 hover:text-blue-600 px-1.5 py-0.5 rounded-full border border-dashed border-gray-300 hover:border-blue-300 transition-colors"
                                onClick={(e) => { e.stopPropagation(); startEditing(quote.id, 'problem', ''); }}
                              >+ Problem</button>
                            )}
                            {!quote.emotion && (
                              <button
                                className="text-[9px] text-gray-400 hover:text-purple-600 px-1.5 py-0.5 rounded-full border border-dashed border-gray-300 hover:border-purple-300 transition-colors"
                                onClick={(e) => { e.stopPropagation(); startEditing(quote.id, 'emotion', ''); }}
                              >+ Emotion</button>
                            )}
                            {quote.emotional_intensity === 'high' && (
                              <span className="text-[9px] font-medium px-1.5 py-0.5 rounded-full bg-red-50 text-red-600">High</span>
                            )}
                            {headlines.length > 0 && (
                              <span className="text-[9px] font-medium px-1.5 py-0.5 rounded-full bg-purple-50 text-purple-600">
                                {headlines.length} headlines
                              </span>
                            )}
                            {(() => {
                              const techs = headlines.map(h => h.technique).filter(Boolean);
                              const uniqueTechs = [...new Set(techs)];
                              return uniqueTechs.length > 0 ? (
                                <span className="text-[9px] font-medium px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-600" title={uniqueTechs.join(', ')}>
                                  {uniqueTechs.length} technique{uniqueTechs.length !== 1 ? 's' : ''}
                                </span>
                              ) : null;
                            })()}
                            {(quote.tags || []).map(t => (
                              <span key={t} className="text-[9px] font-medium px-1.5 py-0.5 rounded-full bg-teal-50 text-teal-600">
                                {t}
                              </span>
                            ))}
                            {quote.source && (
                              <span className="text-[9px] text-gray-400">{quote.source}</span>
                            )}
                          </div>
                        </div>

                        {/* Actions */}
                        <div className="flex items-center gap-1 flex-shrink-0" onClick={e => e.stopPropagation()}>
                          <button
                            onClick={() => toggleFavorite(quote.id)}
                            className={`p-1 transition-colors ${quote.is_favorite ? 'text-amber-400' : 'text-gray-300 hover:text-amber-400'}`}
                            title={quote.is_favorite ? 'Remove from favorites' : 'Add to favorites'}
                          >
                            <svg className="w-4 h-4" fill={quote.is_favorite ? 'currentColor' : 'none'} viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" />
                            </svg>
                          </button>
                          <button
                            onClick={() => deleteBankQuote(quote.id)}
                            className="text-gray-300 hover:text-red-500 transition-colors p-1"
                            title="Delete quote"
                          >
                            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                            </svg>
                          </button>
                        </div>
                      </div>

                      {/* Inline edit overlay */}
                      {editingField && editingField.quoteId === quote.id && editingField.field !== 'headline' && (
                        <div className="border-t border-gray-200 bg-yellow-50/50 px-4 py-2" onClick={e => e.stopPropagation()}>
                          <form onSubmit={(e) => { e.preventDefault(); saveEdit(); }} className="flex items-center gap-2">
                            <span className="text-[10px] text-gray-500 font-medium uppercase tracking-wider w-[60px]">{editingField.field}:</span>
                            <input
                              autoFocus
                              value={editingField.value}
                              onChange={e => setEditingField(prev => ({ ...prev, value: e.target.value }))}
                              className="flex-1 text-[12px] px-2.5 py-1 rounded-lg border border-gray-300 outline-none focus:ring-2 focus:ring-blue-200 focus:border-blue-300"
                              placeholder={`Enter ${editingField.field}...`}
                            />
                            <button type="submit" disabled={savingEdit} className="text-[10px] px-2.5 py-1 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-50">
                              {savingEdit ? '...' : 'Save'}
                            </button>
                            <button type="button" onClick={cancelEditing} className="text-[10px] text-gray-500 hover:text-gray-700">Cancel</button>
                          </form>
                        </div>
                      )}

                      {/* Expanded: Headlines + Metadata */}
                      {isExpanded && (
                        <div className="border-t border-gray-100 bg-gray-50/30 px-4 py-3 space-y-3">
                          {/* Editable metadata section */}
                          <div className="flex items-center gap-4 flex-wrap" onClick={e => e.stopPropagation()}>
                            <div className="flex items-center gap-1.5">
                              <span className="text-[9px] text-gray-400 font-medium uppercase tracking-wider">Problem:</span>
                              <span
                                className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 cursor-pointer hover:bg-blue-100 transition-colors"
                                onClick={() => startEditing(quote.id, 'problem', quote.problem || '')}
                                title="Click to edit"
                              >
                                {quote.problem || 'none'}
                              </span>
                            </div>
                            <div className="flex items-center gap-1.5">
                              <span className="text-[9px] text-gray-400 font-medium uppercase tracking-wider">Emotion:</span>
                              <span
                                className={`text-[10px] font-medium px-2 py-0.5 rounded-full cursor-pointer hover:opacity-80 transition-opacity ${EMOTION_COLORS[quote.emotion] || 'bg-gray-100 text-gray-600'}`}
                                onClick={() => startEditing(quote.id, 'emotion', quote.emotion || '')}
                                title="Click to edit"
                              >
                                {quote.emotion || 'none'}
                              </span>
                            </div>
                          </div>

                          {/* Tag editing */}
                          <div className="flex items-center gap-1.5 flex-wrap" onClick={e => e.stopPropagation()}>
                            <span className="text-[9px] text-gray-400 font-medium uppercase tracking-wider">Tags:</span>
                            {(quote.tags || []).map(t => (
                              <span key={t} className="inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full bg-teal-50 text-teal-700 border border-teal-200">
                                {t}
                                <button
                                  onClick={() => handleRemoveTag(quote.id, t)}
                                  className="text-teal-400 hover:text-teal-600"
                                >×</button>
                              </span>
                            ))}
                            {editingTagQuoteId === quote.id ? (
                              <form
                                onSubmit={(e) => {
                                  e.preventDefault();
                                  if (tagInput.trim()) {
                                    handleAddTag(quote.id, tagInput.trim());
                                    setTagInput('');
                                    setEditingTagQuoteId(null);
                                  }
                                }}
                                className="inline-flex"
                              >
                                <input
                                  autoFocus
                                  value={tagInput}
                                  onChange={e => setTagInput(e.target.value)}
                                  onBlur={() => { setEditingTagQuoteId(null); setTagInput(''); }}
                                  placeholder="Tag name"
                                  className="text-[10px] px-2 py-0.5 rounded-full border border-teal-300 outline-none focus:ring-1 focus:ring-teal-300 w-[80px]"
                                />
                              </form>
                            ) : (
                              <button
                                onClick={() => setEditingTagQuoteId(quote.id)}
                                className="text-[10px] text-gray-400 hover:text-teal-600 transition-colors px-1.5 py-0.5 rounded-full border border-dashed border-gray-300 hover:border-teal-300"
                              >+ Tag</button>
                            )}
                          </div>

                          {headlines.length === 0 ? (
                            <p className="text-[11px] text-gray-400 italic">
                              No headlines yet. Click "Generate Headlines" above to create them.
                            </p>
                          ) : (
                            <div className="space-y-1.5">
                              <p className="text-[10px] text-purple-500 font-semibold uppercase tracking-wider mb-2">
                                Headlines ({headlines.length})
                              </p>
                              {headlines.map((hl, hlIdx) => {
                                const hlUsed = quoteUsedHeadlines.includes(hl.text);
                                const isEditingThisHl = editingField && editingField.quoteId === quote.id && editingField.hlIdx === hlIdx && editingField.field === 'headline';
                                return (
                                  <div key={hlIdx} className="flex items-start gap-2 p-2 rounded-lg bg-white/80 hover:bg-purple-50/50 transition-colors">
                                    <span className={`flex-shrink-0 mt-0.5 text-[8px] font-bold px-1.5 py-0.5 rounded-full ${
                                      hlUsed ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-400'
                                    }`}>
                                      {hlUsed ? 'Used' : hlIdx + 1}
                                    </span>
                                    {isEditingThisHl ? (
                                      <form onSubmit={(e) => { e.preventDefault(); saveEdit(); }} className="flex-1 flex items-center gap-2">
                                        <input
                                          autoFocus
                                          value={editingField.value}
                                          onChange={e => setEditingField(prev => ({ ...prev, value: e.target.value }))}
                                          className="flex-1 text-[12px] font-medium text-gray-800 px-2 py-1 rounded-lg border border-purple-300 outline-none focus:ring-2 focus:ring-purple-200"
                                        />
                                        <button type="submit" disabled={savingEdit} className="text-[10px] px-2 py-1 rounded-lg bg-purple-600 text-white font-medium">{savingEdit ? '...' : 'Save'}</button>
                                        <button type="button" onClick={cancelEditing} className="text-[10px] text-gray-500">Cancel</button>
                                      </form>
                                    ) : (
                                      <p
                                        className="flex-1 text-[12px] font-medium text-gray-800 leading-relaxed cursor-pointer hover:bg-purple-50/50 rounded px-1 -mx-1 transition-colors"
                                        onClick={() => startEditingHeadline(quote.id, hlIdx, hl.text)}
                                        title="Click to edit headline"
                                      >
                                        {hl.text}
                                      </p>
                                    )}
                                    {hl.technique && (
                                      <span className="text-[8px] font-medium px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700 flex-shrink-0 whitespace-nowrap">
                                        {hl.technique}
                                      </span>
                                    )}
                                    <div className="flex items-center gap-1.5 flex-shrink-0">
                                      <button
                                        onClick={() => copyHeadline(hl.text)}
                                        className="text-gray-400 hover:text-purple-600 transition-colors p-0.5"
                                        title="Copy headline"
                                      >
                                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                                          <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25H10.5a2.25 2.25 0 00-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
                                        </svg>
                                      </button>
                                      <button
                                        onClick={() => onSendToAdStudio && onSendToAdStudio({
                                          headline: hl.text,
                                          sourceQuoteId: quote.id,
                                          quoteText: quote.quote,
                                          emotion: quote.emotion,
                                          problem: quote.problem || config.problem,
                                        })}
                                        className="inline-flex items-center gap-1 text-[10px] font-semibold text-purple-600 hover:text-white bg-purple-50 hover:bg-purple-600 px-2.5 py-1 rounded-lg transition-all"
                                        title="Turn this headline into an ad"
                                      >
                                        Turn into Ad
                                        <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                                          <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
                                        </svg>
                                      </button>
                                    </div>
                                  </div>
                                );
                              })}
                              <button
                                onClick={() => handleGenerateMoreHeadlines(quote.id)}
                                disabled={generatingMoreForQuote === quote.id}
                                className="inline-flex items-center gap-1.5 mt-2 px-3 py-1.5 text-[10px] font-medium rounded-lg bg-purple-50 text-purple-600 hover:bg-purple-100 transition-all disabled:opacity-50"
                              >
                                {generatingMoreForQuote === quote.id ? (
                                  <>
                                    <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
                                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" />
                                      <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="4" strokeLinecap="round" className="opacity-75" />
                                    </svg>
                                    Generating...
                                  </>
                                ) : (
                                  <>
                                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                                    </svg>
                                    Generate More Headlines
                                  </>
                                )}
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════════════════════
          MINE QUOTES TAB — config form + run history + results
          ═══════════════════════════════════════════════════════════════════════════ */}
      {subTab === 'mine' && historyOpen && (
        <div className="card p-4 space-y-2">
          <h3 className="text-[13px] font-semibold text-gray-700 mb-2">Past Runs</h3>
          {runs.length === 0 ? (
            <p className="text-[12px] text-gray-400">No mining runs yet.</p>
          ) : (
            <div className="space-y-1.5 max-h-[300px] overflow-y-auto">
              {runs.map(run => (
                <div
                  key={run.id}
                  className={`flex items-center justify-between p-2.5 rounded-lg border transition-all cursor-pointer hover:bg-gray-50 ${
                    viewingRunId === run.id ? 'border-purple-300 bg-purple-50/50' : 'border-gray-100'
                  }`}
                  onClick={() => loadRunResults(run.id)}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] font-medium text-gray-800 truncate">
                        {run.target_demographic} × {run.problem}
                      </span>
                      <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
                        run.status === 'completed' ? 'bg-green-100 text-green-700' :
                        run.status === 'failed' ? 'bg-red-100 text-red-700' :
                        'bg-yellow-100 text-yellow-700'
                      }`}>
                        {run.status}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-[10px] text-gray-400 mt-0.5">
                      <span>{formatTimeAgo(run.created_at)}</span>
                      {run.quote_count > 0 && <span>{run.quote_count} quotes</span>}
                      {run.duration_ms && <span>{formatDuration(run.duration_ms)}</span>}
                    </div>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDeleteRun(run.id); }}
                    className="text-gray-300 hover:text-red-500 transition-colors ml-2 p-1"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Configuration form */}
      {subTab === 'mine' && !mining && !currentQuotes && (
        <div className="card p-6 space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-[13px] font-medium text-gray-600 mb-1.5">
                Target Demographic <span className="text-red-400">*</span>
              </label>
              <input
                value={config.target_demographic}
                onChange={e => setConfig(p => ({ ...p, target_demographic: e.target.value }))}
                className="input-apple"
                placeholder="e.g., men aged 40+ with chronic pain"
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-600 mb-1.5">
                Problem (Angle) <span className="text-red-400">*</span>
              </label>
              <input
                value={config.problem}
                onChange={e => setConfig(p => ({ ...p, problem: e.target.value }))}
                className="input-apple"
                placeholder="e.g., foot pain, arthritis, neuropathy"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-[13px] font-medium text-gray-600 mb-1.5">
                Root Cause <span className="text-[11px] text-gray-400 font-normal">(optional)</span>
              </label>
              <input
                value={config.root_cause}
                onChange={e => setConfig(p => ({ ...p, root_cause: e.target.value }))}
                className="input-apple"
                placeholder="e.g., overtraining, sedentary lifestyle"
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-600 mb-1.5">
                Number of Quotes
              </label>
              <input
                type="number"
                min={5}
                max={50}
                value={config.num_quotes}
                onChange={e => setConfig(p => ({ ...p, num_quotes: parseInt(e.target.value) || 20 }))}
                className="input-apple"
              />
            </div>
          </div>

          {/* Suggesting indicator */}
          {suggesting && (
            <div className="flex items-center gap-2 px-3 py-2 bg-blue-50/80 rounded-xl border border-blue-100">
              <svg className="w-3.5 h-3.5 animate-spin text-blue-500" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4 31.4" strokeLinecap="round" />
              </svg>
              <span className="text-[12px] text-blue-600 font-medium">Generating search suggestions...</span>
            </div>
          )}

          <div className={suggesting ? 'opacity-60 pointer-events-none transition-opacity' : 'transition-opacity'}>
            <div>
              <label className="block text-[13px] font-medium text-gray-600 mb-1.5">
                Search Keywords <span className="text-red-400">*</span>
                <span className="text-[11px] text-gray-400 font-normal ml-1">Type and press Enter</span>
              </label>
              <MultiInput
                items={keywords}
                onAdd={(item) => setKeywords(prev => [...prev, item])}
                onRemove={(idx) => setKeywords(prev => prev.filter((_, i) => i !== idx))}
                placeholder='e.g., "chronic foot pain", "plantar fasciitis"'
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
              <div>
                <label className="block text-[13px] font-medium text-gray-600 mb-1.5">
                  Subreddits <span className="text-[11px] text-gray-400 font-normal">(optional)</span>
                </label>
                <MultiInput
                  items={subreddits}
                  onAdd={(item) => setSubreddits(prev => [...prev, item.replace(/^r\//, '')])}
                  onRemove={(idx) => setSubreddits(prev => prev.filter((_, i) => i !== idx))}
                  placeholder="e.g., health, ChronicPain, Fitness"
                  prefix="r/"
                />
              </div>
              <div>
                <label className="block text-[13px] font-medium text-gray-600 mb-1.5">
                  Other Forums <span className="text-[11px] text-gray-400 font-normal">(optional)</span>
                </label>
                <MultiInput
                  items={forums}
                  onAdd={(item) => setForums(prev => [...prev, item])}
                  onRemove={(idx) => setForums(prev => prev.filter((_, i) => i !== idx))}
                  placeholder="e.g., healthunlocked.com, patient.info"
                />
              </div>
            </div>

            <div className="mt-4">
              <label className="block text-[13px] font-medium text-gray-600 mb-1.5">
                Facebook Groups <span className="text-[11px] text-gray-400 font-normal">(optional)</span>
              </label>
              <MultiInput
                items={facebookGroups}
                onAdd={(item) => setFacebookGroups(prev => [...prev, item])}
                onRemove={(idx) => setFacebookGroups(prev => prev.filter((_, i) => i !== idx))}
                placeholder="e.g., Chronic Pain Warriors, Plantar Fasciitis Support"
              />
            </div>
          </div>

          <div className="flex items-center gap-3 pt-2">
            <button
              onClick={handleStartMining}
              disabled={!config.target_demographic.trim() || !config.problem.trim() || keywords.length === 0}
              className="btn-primary flex items-center gap-2 disabled:opacity-50"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
              </svg>
              Mine Quotes
            </button>
            <button
              onClick={() => fetchSuggestions()}
              disabled={suggesting || !config.target_demographic.trim() || !config.problem.trim()}
              className="btn-secondary flex items-center gap-1.5 text-[12px] disabled:opacity-50"
            >
              {suggesting ? (
                <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4 31.4" strokeLinecap="round" />
                </svg>
              ) : (
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
                </svg>
              )}
              Suggest
            </button>
            <p className="text-[11px] text-gray-400">
              Searches with Perplexity + Claude, merges with GPT-4.1. Takes 1-3 minutes.
            </p>
          </div>
        </div>
      )}

      {/* Progress panel — restored run (polling mode) */}
      {subTab === 'mine' && mining && !abortRef.current && (
        <div className="card p-6 space-y-3">
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 animate-spin text-purple-500" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4 31.4" strokeLinecap="round" />
            </svg>
            <h3 className="text-[14px] font-semibold text-gray-800">Mining in Progress...</h3>
          </div>
          <p className="text-[12px] text-gray-500">
            A mining run is still processing in the background. Results will appear automatically when complete.
          </p>
          <div className="bg-gray-50 rounded-xl p-3 text-[11px] font-mono text-gray-500 space-y-1">
            {progress.map((event, i) => (
              <div key={i} className={event.type === 'error' ? 'text-red-500' : ''}>
                {event.message || JSON.stringify(event)}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Progress panel — live SSE */}
      {subTab === 'mine' && mining && abortRef.current && (
        <div className="card p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h3 className="text-[14px] font-semibold text-gray-800">Mining in Progress...</h3>
              {miningElapsed > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-[12px] text-gray-500 font-mono tabular-nums">
                    {Math.floor(miningElapsed / 60)}:{String(miningElapsed % 60).padStart(2, '0')}
                  </span>
                  {(() => {
                    // Step-based ETA: Search ~40s, Merge ~30s, Bank dedup ~10s = ~80s total
                    const perplexityDone = getEngineStatus('perplexity') === 'complete' || getEngineStatus('perplexity') === 'error';
                    const claudeDone = getEngineStatus('claude') === 'complete' || getEngineStatus('claude') === 'error';
                    const mergeDone = getMergeStatus() === 'complete';
                    const mergeRunning = getMergeStatus() === 'running';
                    const bankUpdated = progress.some(e => e.type === 'bank_updated');

                    let estRemaining = null;
                    if (bankUpdated || mergeDone) {
                      estRemaining = '< 10s';
                    } else if (mergeRunning) {
                      estRemaining = '~20-30s';
                    } else if (perplexityDone && claudeDone) {
                      estRemaining = '~30-40s';
                    } else if (perplexityDone || claudeDone) {
                      estRemaining = '~45-60s';
                    } else if (miningElapsed < 5) {
                      estRemaining = '~1-2 min';
                    } else {
                      estRemaining = '~1-2 min';
                    }

                    return estRemaining ? (
                      <span className="text-[11px] text-blue-500 font-medium">
                        Est. remaining: {estRemaining}
                      </span>
                    ) : null;
                  })()}
                </div>
              )}
            </div>
            <button onClick={handleCancel} className="text-[12px] text-red-500 hover:text-red-700 font-medium">
              Cancel
            </button>
          </div>

          {/* Engine status indicators */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {/* Perplexity */}
            <div className={`p-3 rounded-xl border transition-all ${
              getEngineStatus('perplexity') === 'complete' ? 'border-green-200 bg-green-50/50' :
              getEngineStatus('perplexity') === 'error' ? 'border-red-200 bg-red-50/50' :
              getEngineStatus('perplexity') === 'running' ? 'border-blue-200 bg-blue-50/50' :
              'border-gray-100 bg-gray-50/50'
            }`}>
              <div className="flex items-center gap-2">
                {getEngineStatus('perplexity') === 'running' && (
                  <svg className="w-3.5 h-3.5 animate-spin text-blue-500" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4 31.4" strokeLinecap="round" />
                  </svg>
                )}
                {getEngineStatus('perplexity') === 'complete' && (
                  <svg className="w-3.5 h-3.5 text-green-500" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                )}
                {getEngineStatus('perplexity') === 'error' && (
                  <svg className="w-3.5 h-3.5 text-red-500" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                  </svg>
                )}
                <span className="text-[12px] font-semibold text-gray-700">Perplexity Sonar</span>
              </div>
              <p className="text-[10px] text-gray-500 mt-1">
                {getEngineStatus('perplexity') === 'pending' && 'Waiting...'}
                {getEngineStatus('perplexity') === 'running' && 'Searching Reddit, forums...'}
                {getEngineStatus('perplexity') === 'complete' && 'Done'}
                {getEngineStatus('perplexity') === 'error' && 'Failed (will use other engine)'}
              </p>
            </div>

            {/* Claude */}
            <div className={`p-3 rounded-xl border transition-all ${
              getEngineStatus('claude') === 'complete' ? 'border-green-200 bg-green-50/50' :
              getEngineStatus('claude') === 'error' ? 'border-red-200 bg-red-50/50' :
              getEngineStatus('claude') === 'running' ? 'border-blue-200 bg-blue-50/50' :
              'border-gray-100 bg-gray-50/50'
            }`}>
              <div className="flex items-center gap-2">
                {getEngineStatus('claude') === 'running' && (
                  <svg className="w-3.5 h-3.5 animate-spin text-blue-500" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4 31.4" strokeLinecap="round" />
                  </svg>
                )}
                {getEngineStatus('claude') === 'complete' && (
                  <svg className="w-3.5 h-3.5 text-green-500" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                )}
                {getEngineStatus('claude') === 'error' && (
                  <svg className="w-3.5 h-3.5 text-red-500" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                  </svg>
                )}
                <span className="text-[12px] font-semibold text-gray-700">Claude Web Search</span>
              </div>
              <p className="text-[10px] text-gray-500 mt-1">
                {getEngineStatus('claude') === 'pending' && 'Waiting...'}
                {getEngineStatus('claude') === 'running' && 'Browsing with domain filtering...'}
                {getEngineStatus('claude') === 'complete' && 'Done'}
                {getEngineStatus('claude') === 'error' && 'Failed (will use other engine)'}
              </p>
            </div>

            {/* Merge */}
            <div className={`p-3 rounded-xl border transition-all ${
              getMergeStatus() === 'complete' ? 'border-green-200 bg-green-50/50' :
              getMergeStatus() === 'running' ? 'border-blue-200 bg-blue-50/50' :
              'border-gray-100 bg-gray-50/50'
            }`}>
              <div className="flex items-center gap-2">
                {getMergeStatus() === 'running' && (
                  <svg className="w-3.5 h-3.5 animate-spin text-blue-500" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4 31.4" strokeLinecap="round" />
                  </svg>
                )}
                {getMergeStatus() === 'complete' && (
                  <svg className="w-3.5 h-3.5 text-green-500" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                )}
                <span className="text-[12px] font-semibold text-gray-700">GPT-4.1 Merge</span>
              </div>
              <p className="text-[10px] text-gray-500 mt-1">
                {getMergeStatus() === 'pending' && 'Waiting for search engines...'}
                {getMergeStatus() === 'running' && 'Deduplicating & ranking...'}
                {getMergeStatus() === 'complete' && 'Done'}
              </p>
            </div>
          </div>

          {/* Progress log */}
          <div className="bg-gray-50 rounded-xl p-3 max-h-[200px] overflow-y-auto text-[11px] font-mono text-gray-500 space-y-1">
            {progress.map((event, i) => (
              <div key={i} className={`${
                event.type === 'error' || event.type === 'engine_error' ? 'text-red-500' :
                event.type === 'complete' || event.type === 'saved' || event.type === 'bank_updated' ? 'text-green-600' :
                ''
              }`}>
                {event.message || JSON.stringify(event)}
              </div>
            ))}
            <div ref={progressEndRef} />
          </div>
        </div>
      )}

      {/* Results display (legacy run view) */}
      {subTab === 'mine' && currentQuotes && (
        <div className="space-y-4">
          {/* Results header */}
          <div className="card p-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-[14px] font-semibold text-gray-800 flex items-center gap-2">
                  <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-purple-100 text-purple-700 text-[11px] font-bold">
                    {currentQuotes.length}
                  </span>
                  Quotes Found
                  {currentRunMeta?.duration_ms && (
                    <span className="text-[11px] font-normal text-gray-400">
                      in {formatDuration(currentRunMeta.duration_ms)}
                    </span>
                  )}
                </h3>
                {currentRunMeta && (
                  <p className="text-[11px] text-gray-400 mt-0.5">
                    {currentRunMeta.target_demographic} × {currentRunMeta.problem}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {!generatingHeadlines && (
                  <button
                    onClick={handleGenerateHeadlines}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium rounded-lg bg-purple-600 text-white hover:bg-purple-700 shadow-sm transition-all"
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
                    </svg>
                    {currentHeadlines ? 'Regenerate Headlines' : 'Generate Headlines'}
                  </button>
                )}
                <button onClick={copyAllQuotes} className="btn-secondary text-[11px] flex items-center gap-1">
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25H10.5a2.25 2.25 0 00-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
                  </svg>
                  Copy All
                </button>
                <button onClick={exportAsText} className="btn-secondary text-[11px] flex items-center gap-1">
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                  </svg>
                  Export
                </button>
                {viewingRunId && (
                  <button
                    onClick={() => handleAddRunToBank(viewingRunId)}
                    disabled={importing}
                    className="inline-flex items-center gap-1 px-3 py-1.5 text-[11px] font-medium rounded-lg bg-green-50 text-green-700 hover:bg-green-100 border border-green-200 transition-all disabled:opacity-50"
                  >
                    {importing ? (
                      <>
                        <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                        Importing…
                      </>
                    ) : (
                      <>
                        <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
                        </svg>
                        Add to Quote Bank
                      </>
                    )}
                  </button>
                )}
                <button
                  onClick={() => { setCurrentQuotes(null); setCurrentRunMeta(null); setViewingRunId(null); setCurrentHeadlines(null); setHeadlineProgress([]); setKeywords([]); setSubreddits([]); setForums([]); setFacebookGroups([]); }}
                  className="btn-secondary text-[11px]"
                >
                  New Search
                </button>
              </div>
            </div>
          </div>

          {/* Quote list */}
          <div className="space-y-3">
            {currentQuotes.map((quote, index) => (
              <div key={index} className="card p-4 hover:shadow-md transition-shadow">
                <div className="flex items-start gap-3">
                  <div className="flex-shrink-0 w-7 h-7 rounded-full bg-gray-100 flex items-center justify-center text-[11px] font-bold text-gray-500">
                    {index + 1}
                  </div>
                  <div className="flex-1 min-w-0">
                    <blockquote className="text-[14px] text-gray-800 leading-relaxed italic">
                      &ldquo;{quote.quote}&rdquo;
                    </blockquote>
                    <div className="flex items-center flex-wrap gap-2 mt-2.5">
                      {quote.emotion && (
                        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${EMOTION_COLORS[quote.emotion] || 'bg-gray-100 text-gray-600'}`}>
                          {quote.emotion}
                        </span>
                      )}
                      {quote.emotional_intensity && (
                        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
                          quote.emotional_intensity === 'high' ? 'bg-red-50 text-red-600' : 'bg-gray-50 text-gray-500'
                        }`}>
                          {quote.emotional_intensity === 'high' ? '🔥 High' : '○ Medium'}
                        </span>
                      )}
                      {quote.source && (
                        <span className="text-[10px] text-gray-400">
                          {quote.source_url ? (
                            <a href={quote.source_url} target="_blank" rel="noopener noreferrer" className="hover:text-blue-500 hover:underline">
                              {quote.source}
                            </a>
                          ) : quote.source}
                        </span>
                      )}
                      <button
                        onClick={() => copyQuote(quote)}
                        className="text-gray-300 hover:text-gray-600 transition-colors ml-auto"
                        title="Copy quote"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25H10.5a2.25 2.25 0 00-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
                        </svg>
                      </button>
                    </div>
                    {quote.context && (
                      <p className="text-[11px] text-gray-400 mt-1.5">{quote.context}</p>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Headline generation progress (legacy) */}
          {generatingHeadlines && (
            <div className="card p-5 space-y-3 border-l-4 border-l-purple-400">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <svg className="w-4 h-4 animate-spin text-purple-500" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4 31.4" strokeLinecap="round" />
                  </svg>
                  <h3 className="text-[13px] font-semibold text-gray-800">Generating Headlines...</h3>
                </div>
                <button onClick={handleCancelHeadlines} className="text-[11px] text-red-500 hover:text-red-700 font-medium">
                  Cancel
                </button>
              </div>
              <div className="bg-gray-50 rounded-xl p-3 max-h-[120px] overflow-y-auto text-[11px] font-mono text-gray-500 space-y-1">
                {headlineProgress.map((event, i) => (
                  <div key={i} className={`${
                    event.type === 'error' ? 'text-red-500' :
                    event.type === 'headline_complete' || event.type === 'headlines_saved' ? 'text-green-600' :
                    ''
                  }`}>
                    {event.message || JSON.stringify(event)}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Headlines display (legacy flat list) */}
          {currentHeadlines && currentHeadlines.length > 0 && !generatingHeadlines && (
            <div className="card p-5 border-l-4 border-l-purple-400">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <svg className="w-4 h-4 text-purple-500" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
                  </svg>
                  <h3 className="text-[14px] font-semibold text-gray-800">
                    <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-purple-100 text-purple-700 text-[11px] font-bold mr-1.5">
                      {currentHeadlines.length}
                    </span>
                    Headlines Generated
                  </h3>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={copyAllHeadlines} className="btn-secondary text-[11px] flex items-center gap-1">
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25H10.5a2.25 2.25 0 00-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
                    </svg>
                    Copy All
                  </button>
                  <button onClick={exportHeadlines} className="btn-secondary text-[11px] flex items-center gap-1">
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                    </svg>
                    Export
                  </button>
                </div>
              </div>

              <div className="space-y-2">
                {currentHeadlines.map((headline, index) => (
                  <div key={index} className="flex items-start gap-3 p-2.5 rounded-lg bg-gray-50/80 hover:bg-purple-50/50 transition-colors group">
                    <span className="flex-shrink-0 w-6 h-6 rounded-full bg-purple-100 flex items-center justify-center text-[10px] font-bold text-purple-700 mt-0.5">
                      {index + 1}
                    </span>
                    <p className="flex-1 text-[13px] font-medium text-gray-800 leading-relaxed">
                      {headline}
                    </p>
                    <button
                      onClick={() => copyHeadline(headline)}
                      className="flex-shrink-0 text-gray-300 group-hover:text-gray-500 hover:text-purple-600 transition-colors mt-0.5"
                      title="Copy headline"
                    >
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25H10.5a2.25 2.25 0 00-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Empty state */}
      {subTab === 'mine' && !mining && !currentQuotes && bankQuotes.length === 0 && runs.length === 0 && (
        <div className="text-center py-8 text-gray-400">
          <svg className="w-12 h-12 mx-auto mb-3 text-gray-200" fill="none" viewBox="0 0 24 24" strokeWidth={1} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
          </svg>
          <p className="text-[13px]">Configure your search parameters above to start mining quotes.</p>
          <p className="text-[11px] mt-1">Make sure you have Perplexity and Anthropic API keys set in Settings.</p>
        </div>
      )}

    </div>
  );
}

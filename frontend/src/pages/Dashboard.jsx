import { useState, useEffect, useRef } from 'react';
import { api } from '../api';
import Layout from '../components/Layout';
import CostSummaryCards from '../components/CostSummaryCards';
import CostBarChart from '../components/CostBarChart';
import InfoTooltip from '../components/InfoTooltip';

// ─── Roadmap / To-Do Widget ───────────────────────────────────────────────────
const AUTHOR_META = {
  Ian:  { color: 'bg-navy/10 text-navy', dotColor: 'bg-navy' },
  Luke: { color: 'bg-teal/10 text-teal', dotColor: 'bg-teal' },
};
const AUTHORS = Object.keys(AUTHOR_META);

const PRIORITY_META = {
  1: { label: 'P1', color: 'bg-red-500', textColor: 'text-red-600', bgLight: 'bg-red-50' },
  2: { label: 'P2', color: 'bg-orange-400', textColor: 'text-orange-600', bgLight: 'bg-orange-50' },
  3: { label: 'P3', color: 'bg-blue-400', textColor: 'text-blue-600', bgLight: 'bg-blue-50' },
  4: { label: 'P4', color: 'bg-gray-400', textColor: 'text-gray-500', bgLight: 'bg-gray-50' },
};
const PRIORITIES = [1, 2, 3, 4];

function TodoWidget() {
  const [todos, setTodos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newText, setNewText] = useState('');
  const [newAuthor, setNewAuthor] = useState('Ian');
  const [newPriority, setNewPriority] = useState(null);
  const [showNewNotes, setShowNewNotes] = useState(false);
  const [newNotes, setNewNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState('');
  const [editAuthor, setEditAuthor] = useState('Ian');
  const [editPriority, setEditPriority] = useState(null);
  const [editNotes, setEditNotes] = useState('');
  const [expandedNoteId, setExpandedNoteId] = useState(null);
  const inputRef = useRef(null);
  const editInputRef = useRef(null);

  useEffect(() => {
    api.getTodos()
      .then(data => setTodos(data.todos || []))
      .catch(() => setTodos([]))
      .finally(() => setLoading(false));
  }, []);

  const persist = async (updated) => {
    setTodos(updated);
    setSaving(true);
    try { await api.saveTodos(updated); } catch {}
    setSaving(false);
  };

  const addTodo = (e) => {
    e.preventDefault();
    const text = newText.trim();
    if (!text) return;
    persist([...todos, { id: Date.now(), text, done: false, author: newAuthor, notes: newNotes.trim() || '', priority: newPriority || undefined }]);
    setNewText('');
    setNewNotes('');
    setNewPriority(null);
    setShowNewNotes(false);
    inputRef.current?.focus();
  };

  const toggle = (id) => {
    persist(todos.map(t => t.id === id ? { ...t, done: !t.done } : t));
  };

  const remove = (id) => {
    persist(todos.filter(t => t.id !== id));
    if (expandedNoteId === id) setExpandedNoteId(null);
  };

  const startEdit = (todo) => {
    setEditingId(todo.id);
    setEditText(todo.text);
    setEditAuthor(todo.author || 'Ian');
    setEditPriority(todo.priority || null);
    setEditNotes(todo.notes || '');
    setTimeout(() => editInputRef.current?.focus(), 0);
  };

  const saveEdit = () => {
    const trimmed = editText.trim();
    if (!trimmed || !editingId) { cancelEdit(); return; }
    persist(todos.map(t => t.id === editingId ? { ...t, text: trimmed, author: editAuthor, priority: editPriority || undefined, notes: editNotes.trim() } : t));
    setEditingId(null);
    setEditText('');
    setEditPriority(null);
    setEditNotes('');
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditText('');
    setEditPriority(null);
    setEditNotes('');
  };

  const handleEditKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(); }
    if (e.key === 'Escape') { cancelEdit(); }
  };

  const saveInlineNotes = (id, notes) => {
    persist(todos.map(t => t.id === id ? { ...t, notes: notes.trim() } : t));
  };

  const prioritySort = (a, b) => {
    const pa = a.priority || 99;
    const pb = b.priority || 99;
    return pa - pb;
  };
  const pending = todos.filter(t => !t.done).sort(prioritySort);
  const completed = todos.filter(t => t.done).sort(prioritySort);

  // Shared row renderer for pending and completed items
  const renderItem = (t, isDone) => {
    const isEditing = editingId === t.id;
    const isExpanded = expandedNoteId === t.id;
    const authorMeta = AUTHOR_META[t.author] || AUTHOR_META.Ian;

    return (
      <li key={t.id} className="px-1 -mx-1">
        <div className={`flex items-center gap-2 group ${isDone ? 'py-0.5' : 'py-1'} rounded-lg hover:bg-black/3 transition-colors`}>
          {/* Checkbox */}
          {isDone ? (
            <button
              onClick={() => toggle(t.id)}
              className="w-[18px] h-[18px] rounded-md bg-navy flex-shrink-0 flex items-center justify-center"
            >
              <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
              </svg>
            </button>
          ) : (
            <button
              onClick={() => toggle(t.id)}
              className="w-[18px] h-[18px] rounded-md border-2 border-gray-300 flex-shrink-0 hover:border-gold transition-colors"
            />
          )}

          {/* Text + author tag */}
          {isEditing ? (
            <div className="flex-1 space-y-1.5">
              <input
                ref={editInputRef}
                value={editText}
                onChange={e => setEditText(e.target.value)}
                onKeyDown={handleEditKeyDown}
                className="text-[13px] text-textdark w-full bg-white border border-gold rounded-md px-1.5 py-0.5 outline-none ring-2 ring-gold/15"
              />
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-0.5 bg-gray-100 rounded-md p-0.5">
                  {AUTHORS.map(a => (
                    <button
                      key={a}
                      type="button"
                      onClick={() => setEditAuthor(a)}
                      className={`text-[10px] px-2 py-0.5 rounded font-medium transition-colors ${
                        editAuthor === a
                          ? `${AUTHOR_META[a].color}`
                          : 'text-textlight hover:text-textmid'
                      }`}
                    >
                      {a}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-0.5 bg-gray-100 rounded-md p-0.5">
                  {PRIORITIES.map(p => {
                    const meta = PRIORITY_META[p];
                    return (
                      <button
                        key={p}
                        type="button"
                        onClick={() => setEditPriority(prev => prev === p ? null : p)}
                        className={`text-[10px] px-1.5 py-0.5 rounded font-semibold transition-colors ${
                          editPriority === p
                            ? `${meta.bgLight} ${meta.textColor}`
                            : 'text-textlight hover:text-textmid'
                        }`}
                      >
                        {meta.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <textarea
                value={editNotes}
                onChange={e => setEditNotes(e.target.value)}
                placeholder="Notes (optional)..."
                rows={2}
                className="text-[11px] text-textmid w-full bg-white border border-black/10 rounded-md px-1.5 py-1 outline-none focus:border-gold focus:ring-2 focus:ring-gold/15 resize-none"
              />
              <div className="flex items-center gap-1.5">
                <button onClick={saveEdit} className="btn-primary text-[10px] px-2.5 py-0.5">Save</button>
                <button onClick={cancelEdit} className="btn-secondary text-[10px] px-2.5 py-0.5">Cancel</button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 flex-1 min-w-0">
              {t.priority && PRIORITY_META[t.priority] && (
                <span className={`inline-flex items-center justify-center w-[18px] h-[14px] rounded text-[8px] font-bold text-white flex-shrink-0 ${PRIORITY_META[t.priority].color}`}>
                  {t.priority}
                </span>
              )}
              <span
                className={`text-[13px] ${isDone ? 'text-textlight line-through' : 'text-textdark'} cursor-text rounded px-0.5 truncate`}
              >
                {t.text}
              </span>
              {t.author && (
                <span className={`inline-flex items-center gap-0.5 px-1.5 py-0 rounded-full text-[9px] font-medium flex-shrink-0 ${authorMeta.color}`}>
                  {t.author}
                </span>
              )}
              {t.notes && (
                <button
                  onClick={() => setExpandedNoteId(isExpanded ? null : t.id)}
                  className="flex-shrink-0 text-gold/60 hover:text-gold transition-colors p-0.5"
                  title="View notes"
                >
                  <svg className="w-3 h-3" fill="currentColor" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
                  </svg>
                </button>
              )}
            </div>
          )}

          {/* Action buttons */}
          {!isEditing && (
            <div className="flex items-center gap-1 flex-shrink-0 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
              <button
                onClick={() => startEdit(t)}
                className="action-link"
              >
                Edit
              </button>
              {!t.notes && (
                <button
                  onClick={() => startEdit(t)}
                  className="action-link text-gold bg-gold/10 hover:bg-gold/15 hover:text-gold"
                >
                  Add Notes
                </button>
              )}
              <button
                onClick={() => remove(t.id)}
                className="icon-button-danger"
                title="Delete"
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          )}
        </div>

        {/* Expanded notes */}
        {isExpanded && !isEditing && (
          <div className="ml-7 mt-0.5 mb-1.5 pl-2 border-l-2 border-gold/20 fade-in">
            <p className="text-[11px] text-textlight whitespace-pre-wrap">{t.notes}</p>
          </div>
        )}
      </li>
    );
  };

  if (loading) {
    return (
      <div className="card p-5 mb-8 fade-in">
        <div className="h-4 w-32 bg-gray-100 rounded animate-pulse mb-3" />
        <div className="h-3 w-48 bg-gray-50 rounded animate-pulse" />
      </div>
    );
  }

  return (
    <div className="card p-5 mb-8 fade-in">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-navy/10 flex items-center justify-center flex-shrink-0">
            <svg className="w-3.5 h-3.5 text-navy" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
            </svg>
          </div>
          <h2 className="text-[15px] font-semibold text-textdark tracking-tight">Roadmap</h2>
          {saving && <span className="text-[10px] text-textlight">saving...</span>}
        </div>
        {todos.length > 0 && (
          <span className="text-[11px] text-textlight">
            {completed.length}/{todos.length} done
          </span>
        )}
      </div>

      {/* Add new item */}
      <form onSubmit={addTodo} className="mb-3">
        <div className="flex gap-2 items-center">
          <input
            ref={inputRef}
            value={newText}
            onChange={e => setNewText(e.target.value)}
            placeholder="Add a task..."
            className="input-apple text-[13px] py-1.5 flex-1"
          />
          {/* Author toggle */}
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <span className="text-[10px] text-textlight">by</span>
            <div className="flex items-center gap-0.5 bg-gray-100 rounded-md p-0.5">
              {AUTHORS.map(a => (
                <button
                  key={a}
                  type="button"
                  onClick={() => setNewAuthor(a)}
                  className={`text-[10px] px-2 py-0.5 rounded font-medium transition-colors ${
                    newAuthor === a
                      ? `${AUTHOR_META[a].color}`
                      : 'text-textlight hover:text-textmid'
                  }`}
                >
                  {a}
                </button>
              ))}
            </div>
          </div>
          {/* Priority toggle */}
          <div className="flex items-center gap-0.5 bg-gray-100 rounded-md p-0.5 flex-shrink-0">
            {PRIORITIES.map(p => {
              const meta = PRIORITY_META[p];
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => setNewPriority(prev => prev === p ? null : p)}
                  className={`text-[10px] px-1.5 py-0.5 rounded font-semibold transition-colors ${
                    newPriority === p
                      ? `${meta.bgLight} ${meta.textColor}`
                      : 'text-textlight hover:text-textmid'
                  }`}
                >
                  {meta.label}
                </button>
              );
            })}
          </div>
          <button
            type="submit"
            disabled={!newText.trim()}
            className="btn-primary text-[12px] px-3 py-1.5 disabled:opacity-30"
          >
            Add
          </button>
        </div>
        {/* Optional notes */}
        {showNewNotes ? (
          <textarea
            value={newNotes}
            onChange={e => setNewNotes(e.target.value)}
            placeholder="Notes (optional)..."
            rows={2}
            className="input-apple text-[11px] w-full mt-1.5 resize-none"
          />
        ) : (
          <button
            type="button"
            onClick={() => setShowNewNotes(true)}
            className="text-[10px] text-textlight/60 hover:text-textmid mt-1 transition-colors"
          >
            + Add notes
          </button>
        )}
      </form>

      {/* Pending items */}
      {pending.length > 0 && (
        <ul className="space-y-0.5">
          {pending.map(t => renderItem(t, false))}
        </ul>
      )}

      {/* Completed items */}
      {completed.length > 0 && (
        <div className={pending.length > 0 ? 'mt-3 pt-3 border-t border-black/5' : ''}>
          {pending.length > 0 && (
            <p className="text-[10px] font-medium text-textlight/60 uppercase tracking-wider mb-1">Completed</p>
          )}
          <ul className="space-y-0.5">
            {completed.map(t => renderItem(t, true))}
          </ul>
        </div>
      )}

      {todos.length === 0 && (
        <p className="text-[12px] text-textlight/60 text-center py-3">No tasks yet — add one above.</p>
      )}
    </div>
  );
}

function cronToLabel(cronStr) {
  if (!cronStr) return '';
  const presets = {
    '0 * * * *': 'Every hour',
    '0 */6 * * *': 'Every 6 hours',
    '0 */12 * * *': 'Every 12 hours',
    '0 9 * * *': 'Daily at 9 AM',
    '0 9 * * 1-5': 'Weekdays at 9 AM',
    '0 9 * * 1': 'Weekly (Mon 9 AM)',
  };
  if (presets[cronStr]) return presets[cronStr];
  const parts = cronStr.trim().split(/\s+/);
  if (parts.length !== 5) return cronStr;
  const [minute, hour, dom, month, dow] = parts;
  if (minute.startsWith('*/') && hour === '*') return `Every ${minute.slice(2)} min`;
  if (minute === '0' && hour.startsWith('*/')) return `Every ${hour.slice(2)} hours`;
  if (minute === '0' && hour === '*') return 'Every hour';
  if (minute === '0' && dom.startsWith('*/') && month === '*' && dow === '*') {
    const n = parseInt(dom.slice(2));
    if (n % 7 === 0) return n === 7 ? 'Weekly' : `Every ${n / 7} weeks`;
    return `Every ${n} days`;
  }
  if (minute === '0' && dom === '1' && month.startsWith('*/')) return `Every ${month.slice(2)} months`;
  if (minute === '0' && dom === '1' && month === '*') return 'Monthly';
  return cronStr;
}

// ─── History Range Options ────────────────────────────────────────────────────
const HISTORY_RANGES = [
  { key: '7d',   label: '7d',   days: 7 },
  { key: '14d',  label: '14d',  days: 14 },
  { key: '30d',  label: '30d',  days: 30 },
  { key: '60d',  label: '60d',  days: 60 },
  { key: '90d',  label: '90d',  days: 90 },
  { key: 'ytd',  label: 'YTD',  days: () => Math.ceil((Date.now() - new Date(new Date().getFullYear(), 0, 1)) / 86400000) },
  { key: 'ly',   label: 'Last Year', days: () => { const y = new Date().getFullYear() - 1; return Math.ceil((new Date(y, 11, 31) - new Date(y, 0, 1)) / 86400000) + 1; } },
  { key: 'all',  label: 'All',  days: 3650 },
  { key: 'custom', label: 'Custom', days: null },
];

function getRangeDays(range) {
  const opt = HISTORY_RANGES.find(r => r.key === range.key);
  if (!opt) return 30;
  return typeof opt.days === 'function' ? opt.days() : opt.days;
}

function getRangeLabel(range) {
  if (range.key === 'custom') return 'Custom Range';
  if (range.key === 'all') return 'All Time Spend History';
  if (range.key === 'ytd') return 'Year to Date Spend History';
  if (range.key === 'ly') return 'Last Year Spend History';
  const days = getRangeDays(range);
  return `${days} Days of Spend History`;
}

const DASHBOARD_COST_SNAPSHOT_KEY = 'dashboard_cost_snapshot_v2';
const EMPTY_DASHBOARD_COST_SNAPSHOT = {
  costs: null,
  costHistory: [],
  recurringCosts: null,
  imageRates: null,
  hasHistory: false,
};

function readDashboardCostSnapshot() {
  try {
    const raw = localStorage.getItem(DASHBOARD_COST_SNAPSHOT_KEY);
    if (!raw) return EMPTY_DASHBOARD_COST_SNAPSHOT;
    const parsed = JSON.parse(raw);
    return {
      costs: parsed?.costs || null,
      costHistory: Array.isArray(parsed?.costHistory) ? parsed.costHistory : [],
      recurringCosts: parsed?.recurringCosts || null,
      imageRates: parsed?.imageRates || null,
      hasHistory: !!parsed?.hasHistory,
    };
  } catch {
    return EMPTY_DASHBOARD_COST_SNAPSHOT;
  }
}

function writeDashboardCostSnapshot(snapshot) {
  try {
    localStorage.setItem(DASHBOARD_COST_SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch {
    // Ignore storage errors; the dashboard can still hydrate from live requests.
  }
}

export default function Dashboard() {
  const initialCostSnapshot = useRef(readDashboardCostSnapshot()).current;
  const [costs, setCosts] = useState(initialCostSnapshot.costs);
  const [costHistory, setCostHistory] = useState(initialCostSnapshot.costHistory);
  const [costsLoading, setCostsLoading] = useState(!initialCostSnapshot.costs);
  const [costHistoryLoading, setCostHistoryLoading] = useState(!initialCostSnapshot.hasHistory);
  const [recurringCosts, setRecurringCosts] = useState(initialCostSnapshot.recurringCosts);
  const [recurringLoading, setRecurringLoading] = useState(!initialCostSnapshot.recurringCosts);
  const [imageRates, setImageRates] = useState(initialCostSnapshot.imageRates);
  const [costHistoryLoaded, setCostHistoryLoaded] = useState(initialCostSnapshot.hasHistory);
  const [historyRange, setHistoryRange] = useState(HISTORY_RANGES[2]); // 30d default
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [recurringExpanded, setRecurringExpanded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const loadCostSummary = async () => {
      if (!initialCostSnapshot.costs) setCostsLoading(true);
      try {
        const [costsData, ratesData] = await Promise.all([
          api.getCosts().catch(() => null),
          api.getCostRates().catch(() => null)
        ]);
        if (cancelled) return;
        if (costsData) setCosts(costsData);
        if (ratesData) setImageRates(ratesData);
      } catch (err) {
        console.error('Failed to load cost summary:', err);
      } finally {
        if (!cancelled) setCostsLoading(false);
      }
    };

    const loadCostHistory = async () => {
      if (!initialCostSnapshot.hasHistory) setCostHistoryLoading(true);
      try {
        const historyData = await api.getCostHistory(30).catch(() => ({ history: [] }));
        if (cancelled) return;
        setCostHistory(historyData?.history || []);
        setCostHistoryLoaded(true);
      } catch (err) {
        console.error('Failed to load cost history:', err);
      } finally {
        if (!cancelled) setCostHistoryLoading(false);
      }
    };
    // Reset range to 30d on mount (initial load always fetches 30d)
    setHistoryRange(HISTORY_RANGES[2]);

    const loadRecurringCosts = async () => {
      if (!initialCostSnapshot.recurringCosts) setRecurringLoading(true);
      try {
        const recurringData = await api.getRecurringCosts().catch(() => null);
        if (cancelled) return;
        if (recurringData) setRecurringCosts(recurringData);
      } catch (err) {
        console.error('Failed to load recurring costs:', err);
      } finally {
        if (!cancelled) setRecurringLoading(false);
      }
    };

    loadCostSummary();

    const useAnimationFrame = typeof window.requestAnimationFrame === 'function';
    const scheduleSupplemental = useAnimationFrame
      ? window.requestAnimationFrame(() => {
        loadCostHistory();
        loadRecurringCosts();
      })
      : window.setTimeout(() => {
        loadCostHistory();
        loadRecurringCosts();
      }, 0);

    return () => {
      cancelled = true;
      if (useAnimationFrame && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(scheduleSupplemental);
      } else {
        clearTimeout(scheduleSupplemental);
      }
    };
  }, []);

  // Re-fetch cost history when range changes (skip initial 30d — already loaded above)
  const rangeInitRef = useRef(true);
  useEffect(() => {
    if (rangeInitRef.current) { rangeInitRef.current = false; return; }
    if (historyRange.key === 'custom') return; // custom waits for both dates
    let cancelled = false;
    const days = getRangeDays(historyRange);
    setCostHistoryLoading(true);
    api.getCostHistory(days).then(data => {
      if (!cancelled) { setCostHistory(data?.history || []); setCostHistoryLoaded(true); }
    }).catch(() => {
      if (!cancelled) setCostHistory([]);
    }).finally(() => { if (!cancelled) setCostHistoryLoading(false); });
    return () => { cancelled = true; };
  }, [historyRange]);

  // Re-fetch when custom dates change
  useEffect(() => {
    if (historyRange.key !== 'custom' || !customStart || !customEnd) return;
    const start = new Date(customStart);
    const end = new Date(customEnd);
    if (isNaN(start) || isNaN(end) || end < start) return;
    const days = Math.ceil((end - start) / 86400000) + 1;
    if (days < 1) return;
    let cancelled = false;
    setCostHistoryLoading(true);
    api.getCostHistory(days).then(data => {
      if (!cancelled) { setCostHistory(data?.history || []); setCostHistoryLoaded(true); }
    }).catch(() => {
      if (!cancelled) setCostHistory([]);
    }).finally(() => { if (!cancelled) setCostHistoryLoading(false); });
    return () => { cancelled = true; };
  }, [customStart, customEnd, historyRange]);

  useEffect(() => {
    writeDashboardCostSnapshot({
      costs,
      costHistory,
      recurringCosts,
      imageRates,
      hasHistory: costHistoryLoaded,
    });
  }, [costHistory, costHistoryLoaded, costs, imageRates, recurringCosts]);

  const hasRecurringCosts = recurringCosts && (recurringCosts.estimatedDailyCost > 0 || recurringCosts.directorProjectCount > 0);

  return (
    <Layout>
      {/* Page Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-textdark tracking-tight">Dashboard</h1>
        <p className="text-[13px] text-textmid mt-0.5">Manage your ad creative projects</p>
      </div>

      {/* 1. API Cost Summary */}
      <div className="mb-8 fade-in">
        <div className="flex items-center gap-2 mb-1">
          <h2 className="text-[15px] font-semibold text-textdark tracking-tight">API Costs</h2>
          <InfoTooltip
            text="Tracks your spending on OpenAI (document generation, creative direction) and Gemini (image generation) API calls across all projects."
            position="right"
          />
        </div>
        <p className="text-[12px] text-textlight mb-1">
          Real-time cost tracking. Today resets at midnight UTC.
        </p>
        {imageRates && imageRates.manualRate && (
          <p className="text-[11px] text-textlight mb-4">
            Image rates: <span className="text-textmid font-medium">${imageRates.manualRate.toFixed(4)}/image</span> (manual)
            {' · '}
            <span className="text-textmid font-medium">${imageRates.batchRate.toFixed(4)}/image</span> (batch 50% off)
            {imageRates.updatedAt && (
              <span className="text-textlight/60 ml-1">
                · Updated {new Date(imageRates.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </span>
            )}
          </p>
        )}
        <div className="space-y-4">
          <CostSummaryCards costs={costs} loading={costsLoading} />

          {/* Date range selector */}
          <div className="flex items-center gap-2 flex-wrap">
            <div className="inline-flex items-center bg-gray-100 rounded-lg p-0.5">
              {HISTORY_RANGES.map(r => (
                <button
                  key={r.key}
                  onClick={() => setHistoryRange(r)}
                  className={`text-[11px] px-2.5 py-1 rounded-md font-medium transition-colors whitespace-nowrap ${
                    historyRange.key === r.key
                      ? 'bg-white text-navy shadow-sm'
                      : 'text-textmid hover:text-textdark'
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>
            {historyRange.key === 'custom' && (
              <div className="flex items-center gap-1.5 text-[11px]">
                <input
                  type="date"
                  value={customStart}
                  onChange={e => setCustomStart(e.target.value)}
                  className="input-apple text-[11px] py-1 px-2 w-[130px]"
                />
                <span className="text-textlight">to</span>
                <input
                  type="date"
                  value={customEnd}
                  onChange={e => setCustomEnd(e.target.value)}
                  className="input-apple text-[11px] py-1 px-2 w-[130px]"
                />
              </div>
            )}
          </div>

          <CostBarChart data={costHistory} loading={costHistoryLoading} rangeLabel={getRangeLabel(historyRange)} />
        </div>
      </div>

      {/* 2. Recurring Automation Costs — always visible */}
      <div className="mb-8 fade-in">
        <div className="card p-4">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-gold/10 flex items-center justify-center flex-shrink-0">
              <svg className="w-4 h-4 text-gold" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
              </svg>
            </div>
            <div className="flex-1">
              <p className="text-[11px] font-medium text-textlight uppercase tracking-wider">
                Est. Daily Recurring
              </p>
              <p className="text-lg font-semibold text-textdark tracking-tight">
                {recurringLoading && !recurringCosts
                  ? 'Loading...'
                  : hasRecurringCosts
                  ? `~$${(recurringCosts.estimatedDailyCost || 0).toFixed(2)}/day`
                  : '$0.00/day'}
              </p>
            </div>
            <InfoTooltip
              text={hasRecurringCosts
                ? `Average daily automation cost based on actual spending over the last ${recurringCosts.daysCovered || 7} days. Includes batch pipeline, Creative Filter, LP generation, and Director planning.`
                : 'Shows average daily automation cost once you enable the Creative Director or set up scheduled batches.'}
              position="left"
            />
          </div>

          {recurringLoading && !recurringCosts ? (
            <div className="mt-3 ml-11 animate-pulse space-y-2">
              <div className="h-3 w-32 bg-gray-100 rounded" />
              <div className="h-10 bg-gray-50 rounded-xl" />
            </div>
          ) : hasRecurringCosts ? (
            <>
              <button
                onClick={() => setRecurringExpanded(prev => !prev)}
                className="flex items-center gap-1 text-[10px] text-textlight hover:text-textmid cursor-pointer mt-1 ml-11 transition-colors"
              >
                <svg
                  className={`w-3 h-3 transition-transform duration-200 ${recurringExpanded ? 'rotate-180' : ''}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
                Details
              </button>

              {recurringExpanded && (
                <>
                  <p className="text-[11px] text-textlight mt-2 ml-11">
                    Based on last {recurringCosts.daysCovered || 7} days ({recurringCosts.totalCompletedBatches || 0} batches, {recurringCosts.totalCompletedAds || 0} ads)
                    {' | '}~${((recurringCosts.estimatedDailyCost || 0) * 30).toFixed(0)}/month est.
                  </p>

                  {recurringCosts.breakdown && recurringCosts.breakdown.length > 0 && (
                    <div className="mt-4 ml-11">
                      <table className="w-full text-[11px]">
                        <thead>
                          <tr className="border-b border-black/5">
                            <th className="text-left font-medium text-textlight uppercase tracking-wider pb-2 pr-3">Component</th>
                            <th className="text-right font-medium text-textlight uppercase tracking-wider pb-2 pr-3">7d Spend</th>
                            <th className="text-right font-medium text-textlight uppercase tracking-wider pb-2 pr-3">Daily Est.</th>
                            <th className="text-right font-medium text-textlight uppercase tracking-wider pb-2">Share</th>
                          </tr>
                        </thead>
                        <tbody>
                          {recurringCosts.breakdown.map((row, i) => (
                            <tr key={i} className={`border-b border-gray-50 last:border-0${row.collecting ? ' opacity-50' : ''}`}>
                              <td className="py-2 pr-3 text-textdark">
                                {row.label}
                                <span className="text-textlight ml-1 text-[10px]">
                                  ({row.collecting ? 'collecting data...' : row.description})
                                </span>
                                {row.per_ad > 0 && (
                                  <span className="text-textlight ml-1 text-[10px]">
                                    — ${row.per_ad.toFixed(3)}/ad
                                  </span>
                                )}
                              </td>
                              <td className="py-2 pr-3 text-right text-textmid">${(row.period_total || 0).toFixed(2)}</td>
                              <td className="py-2 pr-3 text-right font-medium text-textdark">
                                {row.collecting ? '—' : `$${(row.daily_avg || 0).toFixed(2)}`}
                              </td>
                              <td className="py-2 text-right text-textmid">{row.collecting ? '—' : `${row.pct || 0}%`}</td>
                            </tr>
                          ))}
                        </tbody>
                        {recurringCosts.breakdown.length > 1 && (
                          <tfoot>
                            <tr className="border-t border-gray-200">
                              <td className="py-2 pr-3 text-right font-medium text-textmid">Total</td>
                              <td className="py-2 pr-3 text-right font-medium text-textmid"></td>
                              <td className="py-2 pr-3 text-right font-semibold text-textdark">${(recurringCosts.estimatedDailyCost || 0).toFixed(2)}</td>
                              <td className="py-2 text-right text-textmid">100%</td>
                            </tr>
                          </tfoot>
                        )}
                      </table>
                    </div>
                  )}
                </>
              )}
            </>
          ) : recurringCosts ? (
            <p className="text-[11px] text-textlight mt-2 ml-11">
              No automation costs recorded in the last 7 days. Enable the Creative Director or set up scheduled batches to see recurring costs.
            </p>
          ) : (
            <p className="text-[11px] text-textlight mt-2 ml-11">
              Recurring cost estimates are temporarily unavailable.
            </p>
          )}
        </div>
      </div>

      {/* 3. Roadmap / To-Do List */}
      <TodoWidget />

    </Layout>
  );
}

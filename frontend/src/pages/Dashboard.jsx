import { useState, useEffect, useRef, useContext } from 'react';
import { api } from '../api';
import { AuthContext } from '../App';

import CostBarChart from '../components/CostBarChart';
import InfoTooltip from '../components/InfoTooltip';


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

function formatCost(value) {
  if (value === 0 || value === undefined || value === null) return '$0.00';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

function getGreeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
}

function getFormattedDate() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).toUpperCase();
}

const SERVICE_DEFS = [
  { key: 'openai', label: 'OpenAI', dotClass: 'bg-[#5B8DEF]' },
  { key: 'anthropic', label: 'Anthropic', dotClass: 'bg-[#7C6DCD]' },
  { key: 'gemini', label: 'Gemini', dotClass: 'bg-ed-green' },
];

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
  } catch {}
}

export default function Dashboard() {
  const { user } = useContext(AuthContext);
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

  const rangeInitRef = useRef(true);
  useEffect(() => {
    if (rangeInitRef.current) { rangeInitRef.current = false; return; }
    if (historyRange.key === 'custom') return;
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

  useEffect(() => {
    if (historyRange.key !== 'custom' || !customStart || !customEnd) return;
    const start = new Date(customStart);
    const end = new Date(customEnd);
    if (isNaN(start) || isNaN(end) || end < start) return;
    let cancelled = false;
    setCostHistoryLoading(true);
    api.getCostHistoryRange(customStart, customEnd).then(data => {
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
  const displayName = user?.displayName || user?.username || 'there';

  const kpiCards = [
    {
      label: 'Spent Today',
      value: costsLoading ? '...' : formatCost(costs?.today?.total || 0),
      sub: costs?.today ? `${(costs.today.imageCount || 0) + (costs.today.batchImageCount || 0)} images` : null,
    },
    {
      label: 'Spent This Week',
      value: costsLoading ? '...' : formatCost(costs?.week?.total || 0),
      sub: costs?.week ? `${(costs.week.imageCount || 0) + (costs.week.batchImageCount || 0)} images` : null,
    },
    {
      label: 'Spent This Month',
      value: costsLoading ? '...' : formatCost(costs?.month?.total || 0),
      sub: costs?.month ? `${(costs.month.imageCount || 0) + (costs.month.batchImageCount || 0)} images` : null,
    },
    {
      label: 'Est. Daily Recurring',
      value: recurringLoading && !recurringCosts
        ? '...'
        : hasRecurringCosts
        ? `~${formatCost(recurringCosts.estimatedDailyCost || 0)}`
        : '$0.00',
      sub: hasRecurringCosts
        ? `~$${((recurringCosts.estimatedDailyCost || 0) * 30).toFixed(0)}/mo`
        : '/day',
    },
  ];

  return (
    <div className="px-[36px] py-[28px] max-w-[1200px]">
      {/* ─── Editorial Greeting ─── */}
      <div className="mb-9">
        <div className="ed-eyebrow mb-2.5">{getFormattedDate()}</div>
        <h1 className="font-serif text-[38px] leading-[1.05] tracking-[-0.02em] text-ed-ink font-[420] mb-2">
          {getGreeting()}, {displayName}.
        </h1>
        <p className="font-geist text-[15px] text-ed-ink2 leading-[1.5] max-w-[520px]">
          Your API spending and automation costs at a glance.
        </p>
      </div>

      {/* ─── KPI Cards ─── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5 mb-6">
        {kpiCards.map((card, i) => (
          <div key={i} className="ed-card px-5 py-[18px]">
            <div className="ed-eyebrow mb-2">{card.label}</div>
            <div className="font-mono-ed text-[28px] tracking-[-0.02em] text-ed-ink leading-none">
              {card.value}
            </div>
            {card.sub && (
              <div className="font-mono-ed text-[11.5px] text-ed-ink3 mt-1.5">
                {card.sub}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* ─── Cost Breakdown (per-period cards with service bars) ─── */}
      {costs && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5 mb-6">
          {[
            { key: 'today', label: 'Today' },
            { key: 'week', label: 'This Week' },
            { key: 'month', label: 'This Month' },
          ].map(period => {
            const data = costs[period.key];
            if (!data) return null;
            const total = data.total || 0;
            const services = SERVICE_DEFS.map(s => ({
              ...s,
              amount: data.byService?.[s.key] || 0,
              pct: total > 0 ? ((data.byService?.[s.key] || 0) / total) * 100 : 0,
            })).filter(s => s.amount > 0);

            return (
              <div key={period.key} className="ed-card px-5 py-4">
                <div className="font-geist text-[10.5px] font-medium uppercase tracking-[0.10em] text-ed-ink3 mb-2">
                  {period.label} by service
                </div>
                {total > 0 ? (
                  <>
                    <div className="w-full h-1.5 rounded-full bg-ed-line overflow-hidden mb-2.5 flex">
                      {services.map((s, idx) => (
                        <div
                          key={s.key}
                          className={`h-full ${s.dotClass}`}
                          style={{
                            width: `${s.pct}%`,
                            borderTopLeftRadius: idx === 0 ? '9999px' : 0,
                            borderBottomLeftRadius: idx === 0 ? '9999px' : 0,
                            borderTopRightRadius: idx === services.length - 1 ? '9999px' : 0,
                            borderBottomRightRadius: idx === services.length - 1 ? '9999px' : 0,
                          }}
                        />
                      ))}
                    </div>
                    <div className="flex items-center gap-3 text-[10px] text-ed-ink3 flex-wrap">
                      {services.map(s => (
                        <span key={s.key} className="flex items-center gap-1">
                          <span className={`w-1.5 h-1.5 rounded-full ${s.dotClass}`} />
                          {s.label} {formatCost(s.amount)}
                        </span>
                      ))}
                    </div>
                  </>
                ) : (
                  <p className="text-[11px] text-ed-ink3">No costs recorded</p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ─── Two-column: Cost Chart + Recurring Costs ─── */}
      <div className="grid grid-cols-1 lg:grid-cols-[1.5fr_1fr] gap-3.5 mb-6">
        {/* Cost History Chart */}
        <div className="ed-card p-0 overflow-hidden">
          <CostBarChart
            data={costHistory}
            loading={costHistoryLoading}
            rangeLabel="Spend History"
            historyRange={historyRange}
            setHistoryRange={setHistoryRange}
            historyRanges={HISTORY_RANGES}
            customStart={customStart}
            setCustomStart={setCustomStart}
            customEnd={customEnd}
            setCustomEnd={setCustomEnd}
          />
        </div>

        {/* Recurring Costs */}
        <div className="ed-card px-5 py-5">
          <h3 className="font-serif text-[18px] text-ed-ink mb-3.5">Recurring Costs</h3>

          <div className="flex items-center gap-3 mb-3">
            <div className="w-8 h-8 rounded-xl bg-ed-accent/10 flex items-center justify-center flex-shrink-0">
              <svg className="w-4 h-4 text-ed-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
              </svg>
            </div>
            <div>
              <div className="font-mono-ed text-[22px] tracking-[-0.02em] text-ed-ink leading-none">
                {recurringLoading && !recurringCosts
                  ? '...'
                  : hasRecurringCosts
                  ? `~$${(recurringCosts.estimatedDailyCost || 0).toFixed(2)}/day`
                  : '$0.00/day'}
              </div>
              <div className="font-geist text-[11px] text-ed-ink3 mt-1">
                {hasRecurringCosts
                  ? `~$${((recurringCosts.estimatedDailyCost || 0) * 30).toFixed(0)}/month estimated`
                  : 'No automation costs recorded'}
              </div>
            </div>
          </div>

          {recurringLoading && !recurringCosts ? (
            <div className="animate-pulse space-y-2 mt-3">
              <div className="h-3 w-32 bg-ed-line rounded" />
              <div className="h-10 bg-ed-line/50 rounded-xl" />
            </div>
          ) : hasRecurringCosts ? (
            <>
              <button
                onClick={() => setRecurringExpanded(prev => !prev)}
                className="inline-flex items-center gap-1 font-geist text-[12px] font-medium text-ed-accent hover:text-ed-accent/80 cursor-pointer mt-1 transition-colors"
              >
                <svg
                  className={`w-3.5 h-3.5 transition-transform duration-200 ${recurringExpanded ? 'rotate-180' : ''}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
                Details
              </button>

              {recurringExpanded && (
                <div className="mt-3 pt-3 border-t border-ed-line">
                  <p className="font-geist text-[11px] text-ed-ink3 mb-3">
                    Based on last {recurringCosts.daysCovered || 7} days ({recurringCosts.totalCompletedBatches || 0} batches, {recurringCosts.totalCompletedAds || 0} ads)
                  </p>

                  {recurringCosts.breakdown && recurringCosts.breakdown.length > 0 && (
                    <div className="space-y-2">
                      {recurringCosts.breakdown.map((row, i) => (
                        <div key={i} className={`flex items-baseline justify-between text-[12px] py-1.5 border-b border-ed-line last:border-0 ${row.collecting ? 'opacity-50' : ''}`}>
                          <div className="font-geist text-ed-ink2">
                            {row.label}
                            <span className="text-ed-ink3 ml-1 text-[10px]">
                              ({row.collecting ? 'collecting...' : row.description})
                            </span>
                          </div>
                          <span className="font-mono-ed text-[11px] text-ed-ink tabular-nums">
                            {row.collecting ? '—' : `$${(row.daily_avg || 0).toFixed(2)}/d`}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          ) : recurringCosts ? (
            <p className="font-geist text-[11px] text-ed-ink3 mt-2">
              Enable the Creative Director or set up scheduled batches to see recurring costs.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

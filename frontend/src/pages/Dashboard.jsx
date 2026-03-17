import { useState, useEffect, useRef } from 'react';
import { api } from '../api';
import Layout from '../components/Layout';
import CostSummaryCards from '../components/CostSummaryCards';
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
        <div className="flex items-center gap-2 mb-4">
          <h2 className="text-[15px] font-semibold text-textdark tracking-tight">API Costs</h2>
          <InfoTooltip
            text={`Tracks your spending on OpenAI and Gemini API calls across all projects. Real-time cost tracking — today resets at midnight UTC.${imageRates && imageRates.manualRate ? ` Image rates: $${imageRates.manualRate.toFixed(4)}/image (manual) · $${imageRates.batchRate.toFixed(4)}/image (batch 50% off).${imageRates.updatedAt ? ` Updated ${new Date(imageRates.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}.` : ''}` : ''}`}
            position="right"
          />
        </div>
        <div className="space-y-4">
          <CostSummaryCards costs={costs} loading={costsLoading} />
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


    </Layout>
  );
}

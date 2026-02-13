import { useState, useEffect } from 'react';
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

export default function Dashboard() {
  const [costs, setCosts] = useState(null);
  const [costHistory, setCostHistory] = useState([]);
  const [costsLoading, setCostsLoading] = useState(true);
  const [recurringCosts, setRecurringCosts] = useState(null);

  useEffect(() => {
    loadCosts();
  }, []);

  const loadCosts = async () => {
    try {
      const [costsData, historyData, recurringData] = await Promise.all([
        api.getCosts().catch(() => null),
        api.getCostHistory(30).catch(() => ({ history: [] })),
        api.getRecurringCosts().catch(() => null)
      ]);
      setCosts(costsData);
      setCostHistory(historyData?.history || []);
      setRecurringCosts(recurringData);
    } catch (err) {
      console.error('Failed to load costs:', err);
    } finally {
      setCostsLoading(false);
    }
  };

  return (
    <Layout>
      {/* Page Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-gray-900 tracking-tight">Dashboard</h1>
        <p className="text-[13px] text-gray-500 mt-0.5">Manage your ad creative projects</p>
      </div>

      {/* API Cost Summary */}
      <div className="mb-8 fade-in">
        <div className="flex items-center gap-2 mb-1">
          <h2 className="text-[15px] font-semibold text-gray-900 tracking-tight">API Costs</h2>
          <InfoTooltip
            text="Tracks your spending on OpenAI (document generation, creative direction) and Gemini (image generation) API calls across all projects."
            position="right"
          />
        </div>
        <p className="text-[12px] text-gray-400 mb-4">
          Real-time cost tracking. Today resets at midnight UTC.
        </p>
        <div className="space-y-4">
          <CostSummaryCards costs={costs} loading={costsLoading} />
          <CostBarChart data={costHistory} loading={costsLoading} />

          {/* Recurring Batch Cost Estimate */}
          {recurringCosts && recurringCosts.scheduledBatchCount > 0 && (
            <div className="card p-4">
              {/* Header row */}
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-xl bg-purple-100 flex items-center justify-center flex-shrink-0">
                  <svg className="w-4 h-4 text-purple-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
                  </svg>
                </div>
                <div className="flex-1">
                  <p className="text-[11px] font-medium text-gray-400 uppercase tracking-wider">
                    Est. Daily Recurring
                  </p>
                  <p className="text-lg font-semibold text-gray-900 tracking-tight">
                    ~${recurringCosts.estimatedDailyCost.toFixed(2)}/day
                  </p>
                </div>
                <InfoTooltip
                  text={`Estimated cost from ${recurringCosts.scheduledBatchCount} scheduled batch${recurringCosts.scheduledBatchCount !== 1 ? 'es' : ''} running automatically. Based on current Gemini batch rates with 50% batch discount.`}
                  position="left"
                />
              </div>
              <p className="text-[11px] text-gray-400 mt-2 ml-11">
                {recurringCosts.scheduledBatchCount} scheduled batch{recurringCosts.scheduledBatchCount !== 1 ? 'es' : ''}
                {' | '}~${(recurringCosts.estimatedDailyCost * 30).toFixed(2)}/month est.
              </p>

              {/* Rate info */}
              {recurringCosts.perImageRate > 0 && (
                <p className="text-[11px] text-gray-400 mt-1 ml-11">
                  Based on ${recurringCosts.perImageRate.toFixed(4)}/image Gemini rate
                  {recurringCosts.batchDiscount ? ` with ${Math.round(recurringCosts.batchDiscount * 100)}% batch discount ($${(recurringCosts.perImageRate * recurringCosts.batchDiscount).toFixed(4)}/image effective)` : ''}
                </p>
              )}

              {/* Breakdown table */}
              {recurringCosts.breakdown && recurringCosts.breakdown.length > 0 && (
                <div className="mt-4 ml-11">
                  <table className="w-full text-[11px]">
                    <thead>
                      <tr className="border-b border-gray-100">
                        <th className="text-left font-medium text-gray-400 uppercase tracking-wider pb-2 pr-3">Project</th>
                        <th className="text-left font-medium text-gray-400 uppercase tracking-wider pb-2 pr-3">Schedule</th>
                        <th className="text-right font-medium text-gray-400 uppercase tracking-wider pb-2 pr-3">Batch Size</th>
                        <th className="text-right font-medium text-gray-400 uppercase tracking-wider pb-2 pr-3">Runs/Day</th>
                        <th className="text-right font-medium text-gray-400 uppercase tracking-wider pb-2 pr-3">Cost/Run</th>
                        <th className="text-right font-medium text-gray-400 uppercase tracking-wider pb-2">Daily Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recurringCosts.breakdown.map((row, i) => (
                        <tr key={i} className="border-b border-gray-50 last:border-0">
                          <td className="py-2 pr-3 text-gray-700">
                            {row.project_name}
                            {row.angle && (
                              <span className="text-gray-400 ml-1">({row.angle})</span>
                            )}
                          </td>
                          <td className="py-2 pr-3 text-gray-500">{cronToLabel(row.schedule_cron)}</td>
                          <td className="py-2 pr-3 text-right text-gray-500">{row.batch_size} img</td>
                          <td className="py-2 pr-3 text-right text-gray-500">{row.runs_per_day}×</td>
                          <td className="py-2 pr-3 text-right text-gray-500">${row.cost_per_run.toFixed(4)}</td>
                          <td className="py-2 text-right font-medium text-gray-700">${row.daily_cost.toFixed(4)}</td>
                        </tr>
                      ))}
                    </tbody>
                    {recurringCosts.breakdown.length > 1 && (
                      <tfoot>
                        <tr className="border-t border-gray-200">
                          <td colSpan={5} className="py-2 pr-3 text-right font-medium text-gray-500">Total</td>
                          <td className="py-2 text-right font-semibold text-gray-900">${recurringCosts.estimatedDailyCost.toFixed(4)}</td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

    </Layout>
  );
}

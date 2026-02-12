import { useState, useEffect } from 'react';
import { api } from '../api';
import Layout from '../components/Layout';
import CostSummaryCards from '../components/CostSummaryCards';
import CostBarChart from '../components/CostBarChart';
import InfoTooltip from '../components/InfoTooltip';

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
            </div>
          )}
        </div>
      </div>

    </Layout>
  );
}

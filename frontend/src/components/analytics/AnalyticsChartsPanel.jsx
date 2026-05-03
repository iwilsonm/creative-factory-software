import { useState, useMemo } from 'react';
import TimeseriesChart from './charts/TimeseriesChart';
import AngleBreakdownBar from './charts/AngleBreakdownBar';
import ScatterChart from './charts/ScatterChart';
import StackedBarChart from './charts/StackedBarChart';
import FunnelChart from './charts/FunnelChart';
import HourlyBarChart from './charts/HourlyBarChart';

const METRIC_OPTIONS = [
  { key: 'spend', label: 'Spend' },
  { key: 'roas', label: 'ROAS' },
  { key: 'ctr', label: 'CTR' },
];

function ChartCard({ title, children, className = '' }) {
  return (
    <div className={`ed-card p-5 ${className}`}>
      {title && <div className="font-mono-ed text-[10.5px] uppercase tracking-[0.10em] text-ed-ink3 mb-4">{title}</div>}
      {children}
    </div>
  );
}

function SkeletonChart({ height = 200 }) {
  return (
    <div className="ed-card p-5 animate-pulse">
      <div className="h-3 w-28 bg-ed-line/60 rounded mb-4" />
      <div className="rounded bg-ed-line/30" style={{ height }} />
    </div>
  );
}

export default function AnalyticsChartsPanel({
  timeseries,
  byCampaign,
  hourly,
  loading,
  error,
  filteredRows,
  campaignNames = {},
}) {
  const [primaryMetric, setPrimaryMetric] = useState('spend');
  const secondaryMetric = primaryMetric === 'roas' ? 'spend' : 'roas';

  const angleRows = useMemo(() => {
    if (!filteredRows || filteredRows.length === 0) return [];
    const byAngle = {};
    for (const row of filteredRows) {
      const angle = row.campaign_name || row.name || 'Unknown';
      if (!byAngle[angle]) byAngle[angle] = { angle, spend: 0, roas: 0, _roasCount: 0 };
      byAngle[angle].spend += row.spend || 0;
      if (row.purchase_roas?.[0]?.value) {
        byAngle[angle].roas += Number(row.purchase_roas[0].value);
        byAngle[angle]._roasCount++;
      }
    }
    return Object.values(byAngle)
      .map(a => ({ ...a, roas: a._roasCount > 0 ? a.roas / a._roasCount : 0 }))
      .sort((a, b) => b.spend - a.spend)
      .slice(0, 8);
  }, [filteredRows]);

  const scatterRows = useMemo(() => {
    if (!filteredRows || filteredRows.length === 0) return [];
    return filteredRows
      .filter(r => r.spend > 0)
      .map(r => ({
        spend: r.spend || 0,
        roas: r.purchase_roas?.[0]?.value ? Number(r.purchase_roas[0].value) : 0,
        ads: 1,
        status: r.effective_status === 'ACTIVE' ? 'passed' : r.effective_status === 'PAUSED' ? 'observing' : 'failed',
      }))
      .slice(0, 50);
  }, [filteredRows]);

  const funnelStages = useMemo(() => {
    if (!filteredRows || filteredRows.length === 0) return [];
    const totals = filteredRows.reduce((acc, r) => {
      acc.impressions += r.impressions || 0;
      acc.clicks += r.clicks || 0;
      acc.purchases += r.purchase_count || 0;
      return acc;
    }, { impressions: 0, clicks: 0, purchases: 0 });
    if (totals.impressions === 0) return [];
    return [
      { stage: 'Impressions', value: totals.impressions, rate: null },
      { stage: 'Clicks', value: totals.clicks, rate: totals.impressions > 0 ? totals.clicks / totals.impressions : 0 },
      { stage: 'Purchases', value: totals.purchases, rate: totals.clicks > 0 ? totals.purchases / totals.clicks : 0 },
    ];
  }, [filteredRows]);

  const stackedData = useMemo(() => {
    if (!byCampaign || !timeseries || timeseries.length === 0) return { data: [], keys: [] };
    const campaignIds = Object.keys(byCampaign).slice(0, 7);
    if (campaignIds.length === 0) return { data: [], keys: [] };
    const dateMap = {};
    for (const cid of campaignIds) {
      for (const row of byCampaign[cid] || []) {
        if (!dateMap[row.date]) dateMap[row.date] = { date: row.date };
        dateMap[row.date][cid] = (dateMap[row.date][cid] || 0) + row.spend;
      }
    }
    const data = Object.values(dateMap).sort((a, b) => a.date.localeCompare(b.date));
    return { data, keys: campaignIds };
  }, [byCampaign, timeseries]);

  if (error) return null;

  if (loading) {
    return (
      <div className="grid gap-5 mb-6">
        <SkeletonChart height={240} />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <SkeletonChart height={180} />
          <SkeletonChart height={180} />
        </div>
      </div>
    );
  }

  if (!timeseries || timeseries.length === 0) return null;

  return (
    <div className="grid gap-5 mb-6">
      {/* Timeseries */}
      <ChartCard>
        <div className="flex items-center justify-between mb-4">
          <div className="font-mono-ed text-[10.5px] uppercase tracking-[0.10em] text-ed-ink3">Performance</div>
          <div className="flex gap-1">
            {METRIC_OPTIONS.map(opt => (
              <button
                key={opt.key}
                onClick={() => setPrimaryMetric(opt.key)}
                className={`px-2.5 py-1 rounded text-[11px] font-mono-ed tracking-wide transition-colors ${
                  primaryMetric === opt.key
                    ? 'bg-ed-accent/10 text-ed-accent'
                    : 'text-ed-ink3 hover:text-ed-ink2'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        <TimeseriesChart data={timeseries} primary={primaryMetric} secondary={secondaryMetric} />
      </ChartCard>

      {/* Two-column: Angle Breakdown + Scatter */}
      {(angleRows.length > 0 || scatterRows.length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          {angleRows.length > 0 && (
            <ChartCard title="Spend by Campaign">
              <AngleBreakdownBar rows={angleRows} />
            </ChartCard>
          )}
          {scatterRows.length > 0 && (
            <ChartCard title="ROAS vs Spend">
              <ScatterChart rows={scatterRows} />
            </ChartCard>
          )}
        </div>
      )}

      {/* Stacked bar */}
      {stackedData.data.length > 0 && (
        <ChartCard title="Daily Spend by Campaign">
          <StackedBarChart data={stackedData.data} keys={stackedData.keys} campaignNames={campaignNames} />
        </ChartCard>
      )}

      {/* Funnel + Hourly */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {funnelStages.length > 0 && (
          <ChartCard title="Conversion Funnel">
            <FunnelChart stages={funnelStages} />
          </ChartCard>
        )}
        {hourly && hourly.length === 24 && (
          <ChartCard title="Hour of Day Performance">
            <HourlyBarChart hours={hourly} metric="spend" />
          </ChartCard>
        )}
      </div>
    </div>
  );
}

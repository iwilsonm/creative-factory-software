import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';

function ensureList(value) {
  if (Array.isArray(value)) return value;
  return [];
}

function parseJSON(value, fallback = []) {
  if (!value) return fallback;
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function timeLabel(value) {
  if (!value) return 'Unknown time';
  const date = typeof value === 'number' ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown time';
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function statusClass(status) {
  const s = String(status || '').toLowerCase();
  if (['completed', 'complete', 'passed', 'ready'].includes(s)) return 'bg-teal/10 text-teal';
  if (['failed', 'error', 'rejected'].includes(s)) return 'bg-red-50 text-red-500';
  if (['running', 'processing', 'queued', 'generating_prompts', 'submitting', 'saving_results'].includes(s)) return 'bg-gold/10 text-gold';
  return 'bg-gray-100 text-textmid';
}

function scoreLabel(score) {
  if (score == null || Number.isNaN(Number(score))) return 'No score';
  const numeric = Number(score);
  return `${Math.round(numeric * 100)}%`;
}

function firstReason(raw) {
  const reasons = parseJSON(raw, []);
  if (reasons.length > 0) return String(reasons[0]);
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  return 'No reason recorded.';
}

function batchIdsForRun(run) {
  const fromRun = parseJSON(run.batches_created, []);
  const ids = fromRun
    .map((item) => item?.batch_id || item?.id || item?.externalId || item)
    .filter(Boolean)
    .map(String);
  return [...new Set(ids)];
}

export default function RecentAgentActivity({ projectId }) {
  const [runs, setRuns] = useState([]);
  const [batches, setBatches] = useState([]);
  const [ads, setAds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expandedRunIds, setExpandedRunIds] = useState([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [runList, batchRes, adList] = await Promise.all([
        api.getConductorRuns(projectId, 5),
        api.getBatches(projectId),
        api.getAds(projectId),
      ]);
      setRuns(ensureList(runList).slice(0, 5));
      setBatches(ensureList(batchRes?.batches));
      setAds(ensureList(adList));
    } catch (err) {
      setError(err.message || 'Recent agent activity could not load.');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const batchesById = useMemo(() => {
    const map = new Map();
    for (const batch of batches) map.set(String(batch.id || batch.externalId), batch);
    return map;
  }, [batches]);

  const scoredAds = useMemo(() => (
    ads
      .filter((ad) => ad.filter_score != null || ad.filter_verdict)
      .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
      .slice(0, 10)
  ), [ads]);

  const hasActivity = runs.length > 0 || scoredAds.length > 0;

  const toggleRun = (runId) => {
    setExpandedRunIds((prev) => prev.includes(runId)
      ? prev.filter((id) => id !== runId)
      : [...prev, runId]);
  };

  return (
    <div className="mt-6">
      <div className="flex items-center justify-between gap-3 mb-4">
        <div>
          <h3 className="text-[15px] font-semibold text-textdark tracking-tight">Recent agent activity</h3>
          <p className="text-[11px] text-textlight mt-0.5">Director runs and Filter scoring for this project only.</p>
        </div>
        <button onClick={load} disabled={loading} className="btn-secondary text-[11px] px-3 py-1.5">
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      <div className="card p-5">
        {loading && (
          <div className="animate-pulse space-y-3">
            <div className="h-4 w-40 bg-gray-100 rounded" />
            <div className="h-16 bg-gray-50 rounded-xl" />
            <div className="h-16 bg-gray-50 rounded-xl" />
          </div>
        )}

        {!loading && error && (
          <div className="rounded-xl border border-red-100 bg-red-50/40 p-3 text-[12px] text-red-500">
            {error}
          </div>
        )}

        {!loading && !error && !hasActivity && (
          <div className="text-center py-8">
            <p className="text-[13px] font-medium text-textdark mb-1">No agent activity for this project yet.</p>
            <p className="text-[11px] text-textlight">Director runs and scored ads will appear here once automation has data.</p>
          </div>
        )}

        {!loading && !error && hasActivity && (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
            <section>
              <div className="flex items-center justify-between mb-2">
                <p className="text-[12px] font-semibold text-textdark">Creative Director</p>
                <span className="text-[10px] text-textlight">{runs.length}/5 runs</span>
              </div>
              <div className="space-y-2">
                {runs.length === 0 ? (
                  <EmptyMini text="No Director runs yet." />
                ) : runs.map((run) => {
                  const id = run.externalId || run.id;
                  const batchIds = batchIdsForRun(run);
                  const expanded = expandedRunIds.includes(id);
                  return (
                    <div key={id} className="rounded-xl border border-gray-100 bg-gray-50/40 p-3">
                      <div className="flex items-start gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className={`badge ${statusClass(run.status)}`}>{run.status || 'unknown'}</span>
                            <span className="text-[10px] text-textlight">{timeLabel(run.run_at || run.created_at)}</span>
                          </div>
                          <p className="text-[12px] font-medium text-textdark truncate">
                            {run.run_type || 'Director run'}
                          </p>
                          <p className="text-[11px] text-textmid mt-1">
                            {batchIds.length} batch{batchIds.length === 1 ? '' : 'es'}
                            {run.total_ads_generated != null && ` · ${run.total_ads_generated} generated`}
                            {run.total_ads_scored != null && ` · ${run.total_ads_scored} scored`}
                            {run.total_ads_passed != null && ` · ${run.total_ads_passed} passed`}
                          </p>
                        </div>
                        <button
                          onClick={() => toggleRun(id)}
                          disabled={batchIds.length === 0}
                          className="btn-secondary text-[10px] px-2 py-1 disabled:opacity-50"
                        >
                          {expanded ? 'Hide' : 'Details'}
                        </button>
                      </div>
                      {expanded && (
                        <div className="mt-3 space-y-1.5">
                          {batchIds.map((batchId) => {
                            const batch = batchesById.get(batchId);
                            return (
                              <BatchDetail key={batchId} batchId={batchId} batch={batch} />
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>

            <section>
              <div className="flex items-center justify-between mb-2">
                <p className="text-[12px] font-semibold text-textdark">Creative Filter</p>
                <span className="text-[10px] text-textlight">{scoredAds.length}/10 scored ads</span>
              </div>
              <div className="space-y-2">
                {scoredAds.length === 0 ? (
                  <EmptyMini text="No scored ads yet." />
                ) : scoredAds.map((ad) => (
                  <div key={ad.id} className="rounded-xl border border-gray-100 bg-gray-50/40 p-3">
                    <div className="flex items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`badge ${statusClass(ad.filter_verdict)}`}>{ad.filter_verdict || 'scored'}</span>
                          <span className="text-[10px] text-textlight">{scoreLabel(ad.filter_score)}</span>
                        </div>
                        <p className="text-[12px] font-medium text-textdark truncate">{ad.headline || ad.angle_name || ad.id}</p>
                        <p className="text-[11px] text-textmid mt-1 max-h-9 overflow-hidden">{firstReason(ad.filter_reasons)}</p>
                        {ad.batch_job_id && (
                          <p className="text-[10px] text-textlight mt-1">Batch {String(ad.batch_job_id).slice(0, 8)}</p>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

function BatchDetail({ batchId, batch }) {
  if (!batch) {
    return (
      <div className="rounded-lg bg-white border border-gray-100 px-2 py-1.5 text-[11px] text-textlight">
        Batch {batchId.slice(0, 8)} no longer appears in this project.
      </div>
    );
  }
  return (
    <div className="rounded-lg bg-white border border-gray-100 px-2 py-1.5 text-[11px]">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-textdark">{batch.angle_name || batch.angle || `Batch ${batchId.slice(0, 8)}`}</span>
        <span className={`badge ${statusClass(batch.status)}`}>{batch.status || 'pending'}</span>
        <span className="text-textlight">{batch.completed_count || 0}/{batch.batch_size || 0} complete</span>
        {batch.failed_count > 0 && <span className="text-red-500">{batch.failed_count} failed</span>}
      </div>
      {batch.error_message && (
        <p className="text-red-500 mt-1">{batch.error_message}</p>
      )}
    </div>
  );
}

function EmptyMini({ text }) {
  return (
    <div className="rounded-xl border border-dashed border-gray-200 bg-gray-50/30 p-4 text-center text-[11px] text-textlight">
      {text}
    </div>
  );
}

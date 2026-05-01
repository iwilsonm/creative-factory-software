// Phase 3 — Observation tab. Lists ad sets in observing/terminal lifecycle
// states with their day counters and verdicts. Click a row to open the
// AdSetTimeline drawer. Also surfaces archived angles for un-archive.

import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import { useToast } from './Toast';
import ObservationPill from './observation/ObservationPill';
import AdSetTimeline from './observation/AdSetTimeline';

export default function ObservationTab({ projectId }) {
  const toast = useToast();
  const [adSets, setAdSets] = useState([]);
  const [archived, setArchived] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeAdSetId, setActiveAdSetId] = useState(null);
  const [filter, setFilter] = useState('all');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [adRes, archRes] = await Promise.all([
        api.getObservationAdSets(projectId),
        api.getArchivedAngles(projectId),
      ]);
      setAdSets(adRes.ad_sets || []);
      setArchived(archRes.angles || []);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  const filtered = adSets.filter((a) => {
    if (filter === 'all') return true;
    if (filter === 'observing') return a.lifecycle_status === 'observing';
    if (filter === 'passed') return a.lifecycle_status === 'passed';
    if (filter === 'failed') return ['failed', 'failed_external'].includes(a.lifecycle_status);
    if (filter === 'insufficient') return a.lifecycle_status === 'insufficient_data';
    return true;
  });

  const counts = {
    all: adSets.length,
    observing: adSets.filter((a) => a.lifecycle_status === 'observing').length,
    passed: adSets.filter((a) => a.lifecycle_status === 'passed').length,
    failed: adSets.filter((a) => ['failed', 'failed_external'].includes(a.lifecycle_status)).length,
    insufficient: adSets.filter((a) => a.lifecycle_status === 'insufficient_data').length,
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="page-tabs">
          {[
            { id: 'all', label: `All (${counts.all})` },
            { id: 'observing', label: `Observing (${counts.observing})` },
            { id: 'passed', label: `Passed (${counts.passed})` },
            { id: 'failed', label: `Failed (${counts.failed})` },
            { id: 'insufficient', label: `Insufficient (${counts.insufficient})` },
          ].map((f) => (
            <button key={f.id} onClick={() => setFilter(f.id)} className={filter === f.id ? 'active' : ''}>
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <button onClick={load} disabled={loading} className="btn-secondary text-[12px] px-3 py-1.5">
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead className="bg-gray-50/60 border-b border-gray-100">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-textmid">Ad set</th>
                <th className="px-3 py-2 text-left font-medium text-textmid w-44">Status</th>
                <th className="px-3 py-2 text-right font-medium text-textmid w-24">Spend</th>
                <th className="px-3 py-2 text-right font-medium text-textmid w-20">ROAS</th>
                <th className="px-3 py-2 text-left font-medium text-textmid">Posted</th>
              </tr>
            </thead>
            <tbody>
              {!loading && filtered.length === 0 && (
                <tr><td colSpan={5} className="px-3 py-12 text-center text-textlight">No ad sets in this view.</td></tr>
              )}
              {filtered.map((a) => {
                const ccy = a.account_currency || 'USD';
                const result = a.latest_result;
                const spend = result?.spend ?? 0;
                const roas = result?.roas;
                return (
                  <tr key={a.externalId} onClick={() => setActiveAdSetId(a.externalId)} className="border-b border-gray-50 hover:bg-gray-50/50 cursor-pointer">
                    <td className="px-3 py-2 text-textdark truncate max-w-[260px]">{a.name}</td>
                    <td className="px-3 py-2"><ObservationPill adSet={a} /></td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {ccy === 'USD' ? `$${spend.toFixed(2)}` : `${Math.round(spend).toLocaleString()} ${ccy}`}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{roas != null ? roas.toFixed(2) : '—'}</td>
                    <td className="px-3 py-2 text-textlight">{a.posted_at ? a.posted_at.slice(0, 10) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {archived.length > 0 && (
        <div className="card p-5">
          <h3 className="text-[13px] font-semibold text-textdark mb-3">Archived angles ({archived.length})</h3>
          <div className="space-y-2">
            {archived.map((angle) => (
              <ArchivedAngleRow
                key={angle.externalId}
                angle={angle}
                onUnarchive={async () => {
                  try {
                    await api.unarchiveAngle(projectId, angle.externalId);
                    toast.success(`Un-archived "${angle.name}"`);
                    load();
                  } catch (err) { toast.error(err.message); }
                }}
              />
            ))}
          </div>
        </div>
      )}

      <AdSetTimeline
        projectId={projectId}
        adSetId={activeAdSetId}
        open={!!activeAdSetId}
        onClose={() => setActiveAdSetId(null)}
        onChanged={load}
      />
    </div>
  );
}

function ArchivedAngleRow({ angle, onUnarchive }) {
  return (
    <div className="flex items-center gap-3 p-3 border border-gray-100 rounded-xl">
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-textdark">{angle.name}</div>
        <div className="text-[11px] text-textlight truncate">{angle.performance_note || 'Archived.'}</div>
      </div>
      <button onClick={onUnarchive} className="btn-secondary text-[11px] px-3 py-1">
        Un-archive
      </button>
    </div>
  );
}

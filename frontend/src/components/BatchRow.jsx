import { useState } from 'react';
import {
  CRON_PRESETS, INTERVAL_UNITS, ASPECT_RATIOS,
  STATUS_COLORS, STATUS_LABELS,
  intervalToCron, cronToLabel, parseCronToInterval,
  getNextRun, formatNextRun, formatDate, formatDuration
} from './batchUtils';

export default function BatchRow({ batch, onRunNow, onCancel, onDelete, onEdit, onPause, onResume }) {
  const isActive = ['generating_prompts', 'submitting', 'processing'].includes(batch.status);
  const canRun = ['pending', 'completed', 'failed'].includes(batch.status);
  const canCancel = isActive;
  const isPaused = !batch.scheduled && !!batch.schedule_cron;
  const canPause = !!batch.scheduled && !!batch.schedule_cron;
  const canEdit = !isActive || batch.scheduled;

  const [editing, setEditing] = useState(false);
  const [editSize, setEditSize] = useState(batch.batch_size);
  const [editAngle, setEditAngle] = useState(batch.angle || '');
  const [editAspect, setEditAspect] = useState(batch.aspect_ratio || '1:1');
  const [editScheduled, setEditScheduled] = useState(!!batch.scheduled);
  const [editCronPreset, setEditCronPreset] = useState(() => {
    if (!batch.schedule_cron) return '0 9 * * *';
    const match = CRON_PRESETS.find(p => p.value === batch.schedule_cron && p.value !== 'custom');
    return match ? match.value : 'custom';
  });
  const [editIntervalAmount, setEditIntervalAmount] = useState(() => {
    if (!batch.schedule_cron) return 30;
    const parsed = parseCronToInterval(batch.schedule_cron);
    return parsed ? parsed.amount : 30;
  });
  const [editIntervalUnit, setEditIntervalUnit] = useState(() => {
    if (!batch.schedule_cron) return 'minutes';
    const parsed = parseCronToInterval(batch.schedule_cron);
    return parsed ? parsed.unit : 'minutes';
  });
  const [saving, setSaving] = useState(false);

  const getEditCron = () => {
    if (editCronPreset === 'custom') return intervalToCron(editIntervalAmount, editIntervalUnit);
    return editCronPreset;
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await onEdit(batch.id, {
        batch_size: editSize,
        angle: editAngle.trim() || '',
        aspect_ratio: editAspect,
        scheduled: editScheduled,
        schedule_cron: editScheduled ? getEditCron() : undefined,
      });
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  // Parse batch_stats for progress bar
  let batchStats = null;
  if (batch.batch_stats) {
    try {
      batchStats = typeof batch.batch_stats === 'string' ? JSON.parse(batch.batch_stats) : batch.batch_stats;
    } catch {}
  }
  const progressTotal = batchStats?.totalCount || batchStats?.totalRequests || 0;
  const progressDone = (batchStats?.successfulCount || batchStats?.succeededRequests || 0) + (batchStats?.failedCount || batchStats?.failedRequests || 0);
  const progressPct = progressTotal > 0 ? Math.round((progressDone / progressTotal) * 100) : 0;

  // Parse pipeline_state for stage-level progress
  let pipelineState = null;
  if (batch.pipeline_state) {
    try {
      pipelineState = typeof batch.pipeline_state === 'string' ? JSON.parse(batch.pipeline_state) : batch.pipeline_state;
    } catch {}
  }
  const pipelineStage = pipelineState?.stage ?? null;
  const pipelineCurrent = pipelineState?.current || 0;
  const pipelineTotal = pipelineState?.total || 0;
  const pipelinePct = pipelineStage === 3 && pipelineTotal > 0
    ? Math.round((pipelineCurrent / pipelineTotal) * 100)
    : pipelineStage === 'complete' ? 100
    : pipelineStage === 2 ? 60
    : pipelineStage === 1 ? 30
    : pipelineStage === 0 ? 10
    : 0;

  return (
    <div className="rounded-xl bg-black/[0.02] border border-black/5 hover:bg-black/[0.03] transition-colors">
      <div className="flex items-center gap-3 p-3">
        {/* Status indicator */}
        <div className="flex-shrink-0">
          {isActive ? (
            <div className="w-5 h-5 rounded-full border-2 border-navy/20 border-t-navy animate-spin" />
          ) : batch.status === 'completed' ? (
            <div className="w-5 h-5 rounded-full bg-teal/10 flex items-center justify-center">
              <svg className="w-3 h-3 text-teal" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
              </svg>
            </div>
          ) : batch.status === 'failed' ? (
            <div className="w-5 h-5 rounded-full bg-red-100 flex items-center justify-center">
              <svg className="w-3 h-3 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
          ) : (
            <div className="w-5 h-5 rounded-full bg-black/5 flex items-center justify-center">
              <div className="w-2 h-2 rounded-full bg-textlight" />
            </div>
          )}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[13px] font-medium text-textdark">
              {batch.batch_size} image{batch.batch_size !== 1 ? 's' : ''}
            </span>
            <span className={`badge text-[10px] ${STATUS_COLORS[batch.status] || STATUS_COLORS.pending}`}>
              {batch.status === 'generating_prompts' && batch.pipeline_state
                ? (() => {
                    try {
                      const ps = JSON.parse(batch.pipeline_state);
                      return ps.stage_label || STATUS_LABELS[batch.status];
                    } catch { return STATUS_LABELS[batch.status]; }
                  })()
                : (STATUS_LABELS[batch.status] || batch.status)}
            </span>
            {batch.filter_assigned && (
              <span className="badge bg-teal/10 text-teal text-[10px]">Filter</span>
            )}
            {batch.schedule_cron ? (
              batch.scheduled ? (
                <span className="badge bg-navy/10 text-navy text-[10px]">
                  {cronToLabel(batch.schedule_cron)}
                </span>
              ) : (
                <span className="badge bg-orange-100/80 text-orange-600 text-[10px]">
                  Paused · {cronToLabel(batch.schedule_cron)}
                </span>
              )
            ) : null}
            {batch.retry_count > 0 && (
              <span className="badge bg-gold/10 text-gold text-[10px]">
                {batch.retry_count}/3 retries
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            <span className="text-[11px] text-textlight">{batch.aspect_ratio}</span>
            {batch.angle && (
              <>
                <span className="text-[11px] text-textlight/60">|</span>
                <span className="text-[11px] text-textmid truncate" title={batch.angle}>
                  {batch.angle}
                </span>
              </>
            )}
            {batch.completed_count > 0 && (
              <>
                <span className="text-[11px] text-textlight/60">|</span>
                <span className="text-[11px] text-teal">{batch.completed_count} saved</span>
                {batch.failed_count > 0 && (
                  <span className="text-[11px] text-red-400">· {batch.failed_count} failed</span>
                )}
                {batch.run_count > 1 && (
                  <span className="text-[11px] text-textlight">· {batch.run_count} runs</span>
                )}
              </>
            )}
            {batch.error_message && (
              <>
                <span className="text-[11px] text-textlight/60">|</span>
                <span className="text-[11px] text-red-500 truncate" title={batch.error_message}>
                  {batch.error_message.slice(0, 50)}
                </span>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-textlight">{formatDate(batch.created_at)}</span>
            {batch.status === 'completed' && formatDuration(batch.started_at, batch.completed_at) && (
              <>
                <span className="text-[10px] text-textlight/60">·</span>
                <span className="text-[10px] text-teal">Completed in {formatDuration(batch.started_at, batch.completed_at)}</span>
              </>
            )}
            {!!batch.scheduled && batch.schedule_cron && (() => {
              const next = getNextRun(batch.schedule_cron);
              const label = formatNextRun(next);
              return label ? (
                <>
                  <span className="text-[10px] text-textlight/60">·</span>
                  <span className="text-[10px] text-navy/60">Next: {label}</span>
                </>
              ) : null;
            })()}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {canPause && (
            <button
              onClick={() => onPause(batch.id)}
              className="text-[11px] text-orange-500 hover:text-orange-600 font-medium transition-colors px-2 py-1 rounded-lg hover:bg-orange-50/50"
              title="Pause automation"
            >
              Pause
            </button>
          )}
          {isPaused && (
            <button
              onClick={() => onResume(batch.id)}
              className="text-[11px] text-teal hover:text-teal/80 font-medium transition-colors px-2 py-1 rounded-lg hover:bg-teal/5"
              title="Resume automation"
            >
              Resume
            </button>
          )}
          {canCancel && (
            <button
              onClick={() => onCancel(batch.id)}
              className="text-[11px] text-gold hover:text-gold/80 font-medium transition-colors px-2 py-1 rounded-lg hover:bg-gold/5"
              title="Cancel batch"
            >
              Cancel
            </button>
          )}
          {canEdit && (
            <button
              onClick={() => setEditing(!editing)}
              className="text-[11px] text-textlight hover:text-textmid font-medium transition-colors px-2 py-1 rounded-lg hover:bg-black/[0.02]"
              title="Edit batch"
            >
              {editing ? 'Close' : 'Edit'}
            </button>
          )}
          {canRun && (
            <button
              onClick={() => onRunNow(batch.id)}
              className="text-[11px] text-navy hover:text-navy-light font-medium transition-colors px-2 py-1 rounded-lg hover:bg-navy/5"
              title="Run now"
            >
              Run
            </button>
          )}
          <button
            onClick={() => onDelete(batch.id)}
            className="text-[11px] text-red-400 hover:text-red-500 font-medium transition-colors px-2 py-1 rounded-lg hover:bg-red-50/50"
            title="Delete"
          >
            Delete
          </button>
        </div>
      </div>

      {/* Inline edit panel */}
      {editing && (
        <div className="px-3 pb-3 pt-1 border-t border-black/5 fade-in">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-2">
            <div>
              <label className="block text-[10px] font-medium text-textlight mb-0.5">Batch Size</label>
              <input
                type="number"
                min={1}
                max={50}
                value={editSize}
                onChange={e => setEditSize(Math.max(1, Math.min(50, parseInt(e.target.value) || 1)))}
                disabled={saving}
                className="input-apple text-[12px] py-1.5"
              />
            </div>
            <div>
              <label className="block text-[10px] font-medium text-textlight mb-0.5">Aspect Ratio</label>
              <select
                value={editAspect}
                onChange={e => setEditAspect(e.target.value)}
                disabled={saving}
                className="input-apple text-[12px] py-1.5"
              >
                {ASPECT_RATIOS.map(ar => (
                  <option key={ar.value} value={ar.value}>{ar.label}</option>
                ))}
              </select>
            </div>
            <div className="col-span-2">
              <label className="block text-[10px] font-medium text-textlight mb-0.5">Ad Topic / Angle</label>
              <input
                value={editAngle}
                onChange={e => setEditAngle(e.target.value)}
                disabled={saving}
                placeholder='e.g., "before & after"'
                className="input-apple text-[12px] py-1.5"
              />
            </div>
          </div>

          {/* Schedule editing */}
          <div className="flex items-center gap-2 mb-2">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={editScheduled}
                onChange={e => setEditScheduled(e.target.checked)}
                disabled={saving}
                className="w-3.5 h-3.5 rounded border-black/10 text-navy focus:ring-navy/20"
              />
              <span className="text-[11px] text-textmid font-medium">Scheduled</span>
            </label>
          </div>
          {editScheduled && (
            <div className="grid grid-cols-2 gap-2 mb-2">
              <select
                value={editCronPreset}
                onChange={e => setEditCronPreset(e.target.value)}
                disabled={saving}
                className="input-apple text-[12px] py-1.5"
              >
                {CRON_PRESETS.map(p => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
              {editCronPreset === 'custom' && (
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    min={INTERVAL_UNITS.find(u => u.value === editIntervalUnit)?.min || 1}
                    max={INTERVAL_UNITS.find(u => u.value === editIntervalUnit)?.max || 60}
                    value={editIntervalAmount}
                    onChange={e => {
                      const unit = INTERVAL_UNITS.find(u => u.value === editIntervalUnit);
                      const val = parseInt(e.target.value) || unit?.min || 1;
                      setEditIntervalAmount(Math.max(unit?.min || 1, Math.min(unit?.max || 60, val)));
                    }}
                    disabled={saving}
                    className="input-apple w-16 text-center text-[12px] py-1.5"
                  />
                  <select
                    value={editIntervalUnit}
                    onChange={e => {
                      setEditIntervalUnit(e.target.value);
                      const unit = INTERVAL_UNITS.find(u => u.value === e.target.value);
                      if (unit && editIntervalAmount < unit.min) setEditIntervalAmount(unit.min);
                      if (unit && editIntervalAmount > unit.max) setEditIntervalAmount(unit.max);
                    }}
                    disabled={saving}
                    className="input-apple flex-1 text-[12px] py-1.5"
                  >
                    {INTERVAL_UNITS.map(u => (
                      <option key={u.value} value={u.value}>{u.label}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}

          <div className="flex items-center gap-2">
            <button
              onClick={handleSave}
              disabled={saving}
              className="btn-primary text-[11px] py-1 px-3"
            >
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
            <button
              onClick={() => setEditing(false)}
              disabled={saving}
              className="text-[11px] text-textlight hover:text-textmid transition-colors px-2 py-1"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Pipeline progress bar for generating_prompts stage */}
      {batch.status === 'generating_prompts' && pipelineState && (
        <div className="px-3 pb-3">
          <div className="flex items-center gap-2">
            <div className="flex-1 h-1.5 rounded-full bg-black/10 overflow-hidden">
              <div
                className="h-full bg-teal rounded-full transition-all duration-500"
                style={{ width: `${pipelinePct}%` }}
              />
            </div>
            <span className="text-[10px] text-textlight flex-shrink-0">
              {pipelineState.stage_label || `Stage ${pipelineStage}`}
            </span>
          </div>
        </div>
      )}

      {/* Progress bar for processing batches */}
      {batch.status === 'processing' && progressTotal > 0 && (
        <div className="px-3 pb-3">
          <div className="flex items-center gap-2">
            <div className="flex-1 h-1.5 rounded-full bg-black/10 overflow-hidden">
              <div
                className="h-full bg-teal rounded-full transition-all duration-500"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <span className="text-[10px] text-textlight flex-shrink-0">
              {progressDone}/{progressTotal} generated
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

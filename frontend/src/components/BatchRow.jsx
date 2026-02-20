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
    <div className="rounded-xl bg-gray-50/30 border border-gray-100/80 hover:bg-gray-50/60 transition-colors">
      <div className="flex items-center gap-3 p-3">
        {/* Status indicator */}
        <div className="flex-shrink-0">
          {isActive ? (
            <div className="w-5 h-5 rounded-full border-2 border-blue-200 border-t-blue-500 animate-spin" />
          ) : batch.status === 'completed' ? (
            <div className="w-5 h-5 rounded-full bg-green-100 flex items-center justify-center">
              <svg className="w-3 h-3 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
            <div className="w-5 h-5 rounded-full bg-gray-100 flex items-center justify-center">
              <div className="w-2 h-2 rounded-full bg-gray-400" />
            </div>
          )}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[13px] font-medium text-gray-800">
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
            {batch.schedule_cron ? (
              batch.scheduled ? (
                <span className="badge bg-purple-100/80 text-purple-600 text-[10px]">
                  {cronToLabel(batch.schedule_cron)}
                </span>
              ) : (
                <span className="badge bg-orange-100/80 text-orange-600 text-[10px]">
                  Paused · {cronToLabel(batch.schedule_cron)}
                </span>
              )
            ) : null}
            {batch.retry_count > 0 && (
              <span className="badge bg-amber-100/80 text-amber-700 text-[10px]">
                {batch.retry_count}/3 retries
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            <span className="text-[11px] text-gray-400">{batch.aspect_ratio}</span>
            {batch.angle && (
              <>
                <span className="text-[11px] text-gray-300">|</span>
                <span className="text-[11px] text-gray-500 truncate" title={batch.angle}>
                  {batch.angle}
                </span>
              </>
            )}
            {batch.completed_count > 0 && (
              <>
                <span className="text-[11px] text-gray-300">|</span>
                <span className="text-[11px] text-green-600">{batch.completed_count} saved</span>
                {batch.failed_count > 0 && (
                  <span className="text-[11px] text-red-400">· {batch.failed_count} failed</span>
                )}
                {batch.run_count > 1 && (
                  <span className="text-[11px] text-gray-400">· {batch.run_count} runs</span>
                )}
              </>
            )}
            {batch.error_message && (
              <>
                <span className="text-[11px] text-gray-300">|</span>
                <span className="text-[11px] text-red-500 truncate" title={batch.error_message}>
                  {batch.error_message.slice(0, 50)}
                </span>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-gray-400">{formatDate(batch.created_at)}</span>
            {batch.status === 'completed' && formatDuration(batch.started_at, batch.completed_at) && (
              <>
                <span className="text-[10px] text-gray-300">·</span>
                <span className="text-[10px] text-emerald-500">Completed in {formatDuration(batch.started_at, batch.completed_at)}</span>
              </>
            )}
            {!!batch.scheduled && batch.schedule_cron && (() => {
              const next = getNextRun(batch.schedule_cron);
              const label = formatNextRun(next);
              return label ? (
                <>
                  <span className="text-[10px] text-gray-300">·</span>
                  <span className="text-[10px] text-purple-400">Next: {label}</span>
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
              className="text-[11px] text-green-500 hover:text-green-600 font-medium transition-colors px-2 py-1 rounded-lg hover:bg-green-50/50"
              title="Resume automation"
            >
              Resume
            </button>
          )}
          {canCancel && (
            <button
              onClick={() => onCancel(batch.id)}
              className="text-[11px] text-amber-500 hover:text-amber-600 font-medium transition-colors px-2 py-1 rounded-lg hover:bg-amber-50/50"
              title="Cancel batch"
            >
              Cancel
            </button>
          )}
          {canEdit && (
            <button
              onClick={() => setEditing(!editing)}
              className="text-[11px] text-gray-400 hover:text-gray-600 font-medium transition-colors px-2 py-1 rounded-lg hover:bg-gray-50/50"
              title="Edit batch"
            >
              {editing ? 'Close' : 'Edit'}
            </button>
          )}
          {canRun && (
            <button
              onClick={() => onRunNow(batch.id)}
              className="text-[11px] text-blue-500 hover:text-blue-600 font-medium transition-colors px-2 py-1 rounded-lg hover:bg-blue-50/50"
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
        <div className="px-3 pb-3 pt-1 border-t border-gray-100/80 fade-in">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-2">
            <div>
              <label className="block text-[10px] font-medium text-gray-400 mb-0.5">Batch Size</label>
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
              <label className="block text-[10px] font-medium text-gray-400 mb-0.5">Aspect Ratio</label>
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
              <label className="block text-[10px] font-medium text-gray-400 mb-0.5">Ad Topic / Angle</label>
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
                className="w-3.5 h-3.5 rounded border-gray-300 text-blue-500 focus:ring-blue-500/20"
              />
              <span className="text-[11px] text-gray-500 font-medium">Scheduled</span>
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
              className="text-[11px] text-gray-400 hover:text-gray-600 transition-colors px-2 py-1"
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
            <div className="flex-1 h-1.5 rounded-full bg-gray-200 overflow-hidden">
              <div
                className="h-full bg-blue-400 rounded-full transition-all duration-500"
                style={{ width: `${pipelinePct}%` }}
              />
            </div>
            <span className="text-[10px] text-gray-400 flex-shrink-0">
              {pipelineState.stage_label || `Stage ${pipelineStage}`}
            </span>
          </div>
        </div>
      )}

      {/* Progress bar for processing batches */}
      {batch.status === 'processing' && progressTotal > 0 && (
        <div className="px-3 pb-3">
          <div className="flex items-center gap-2">
            <div className="flex-1 h-1.5 rounded-full bg-gray-200 overflow-hidden">
              <div
                className="h-full bg-blue-400 rounded-full transition-all duration-500"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <span className="text-[10px] text-gray-400 flex-shrink-0">
              {progressDone}/{progressTotal} generated
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

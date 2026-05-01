// Phase 3 — Lifecycle pill for observation states.

const PILL_BASE = 'inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full';

export default function ObservationPill({ adSet, onClick }) {
  const status = adSet.lifecycle_status;
  const days = adSet.days_observed ?? 0;
  const window = adSet.window_total ?? 12;
  const paused = adSet.is_paused || !!adSet.observation_paused_at;

  let cls = '';
  let label = '';
  let title = '';

  if (paused && status === 'observing') {
    cls = 'bg-gray-100 text-textmid';
    label = `Paused • Day ${days}/${window}`;
    title = 'Day counter is frozen until you resume.';
  } else if (status === 'observing') {
    cls = 'bg-gold/10 text-gold';
    label = `Observing • Day ${days}/${window}`;
    title = `Posted ${days} day${days === 1 ? '' : 's'} ago. Verdict on day ${window}.`;
  } else if (status === 'passed') {
    cls = 'bg-teal/15 text-teal';
    label = 'Passed';
    title = adSet.latest_result?.reason || 'Met benchmark.';
  } else if (status === 'failed') {
    cls = 'bg-red-50 text-red-500 border border-red-200';
    label = 'Failed';
    title = adSet.latest_result?.reason || 'Below benchmark.';
  } else if (status === 'failed_external') {
    cls = 'bg-red-50 text-red-500 border border-red-200';
    label = 'Failed (external)';
    title = 'Ad set was deleted on Meta side. Counted as failure.';
  } else if (status === 'insufficient_data') {
    cls = 'bg-gray-100 text-textmid';
    label = 'Insufficient data';
    title = adSet.latest_result?.reason || 'Spend below threshold.';
  } else {
    return null;
  }

  return (
    <button
      onClick={onClick}
      title={title}
      className={`${PILL_BASE} ${cls} ${onClick ? 'cursor-pointer hover:brightness-95' : ''}`}
    >
      {label}
    </button>
  );
}

/**
 * PipelineProgress — Shared progress bar for all long-running SSE pipelines.
 *
 * Reference implementation: LPAgentSettings.jsx test generation progress bar.
 *
 * Pattern:
 *   Backend emits: { type: 'progress', step: 'step_name', message: '...' }
 *   Frontend maps step names → percentages (STEP_PROGRESS) and labels (STEP_LABELS)
 *   This component renders the progress bar + status line.
 *
 * Props:
 *   progress  (number 0-100)  — current percentage
 *   message   (string)        — current status text
 *   startTime (number|null)   — Date.now() timestamp for ETA calculation
 *   className (string)        — optional wrapper class
 */
export default function PipelineProgress({ progress = 0, message = '', startTime = null, className = '' }) {
  const getTimeEstimate = () => {
    if (!startTime || progress < 3) return null;
    const elapsed = (Date.now() - startTime) / 1000;
    if (elapsed < 5) return null;
    const rate = progress / elapsed;
    if (rate <= 0) return null;
    const remaining = Math.round((100 - progress) / rate);
    if (remaining < 5) return 'Almost done';
    if (remaining < 60) return `~${remaining}s remaining`;
    return `~${Math.ceil(remaining / 60)}m remaining`;
  };

  return (
    <div className={`space-y-1.5 ${className}`}>
      {/* Progress bar */}
      <div className="w-full bg-black/5 rounded-full h-2 overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-700 ease-out"
          style={{
            width: `${Math.max(progress, 2)}%`,
            background: progress >= 100
              ? '#2A9D8F'
              : 'linear-gradient(90deg, #0B1D3A, #132B52)',
          }}
        />
      </div>
      {/* Status line */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 min-w-0">
          {progress < 100 && (
            <svg className="w-3 h-3 text-navy animate-spin flex-shrink-0" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4 31.4" strokeLinecap="round" />
            </svg>
          )}
          {progress >= 100 && (
            <svg className="w-3 h-3 text-teal flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
            </svg>
          )}
          <span className="text-[10px] text-textmid truncate">{message || 'Starting...'}</span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0 ml-2">
          <span className={`text-[10px] font-medium ${progress >= 100 ? 'text-teal' : 'text-navy'}`}>{progress}%</span>
          {progress < 100 && getTimeEstimate() && (
            <span className="text-[9px] text-textlight">{getTimeEstimate()}</span>
          )}
        </div>
      </div>
    </div>
  );
}

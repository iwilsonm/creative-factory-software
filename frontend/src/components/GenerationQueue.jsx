import { forwardRef } from 'react';

function formatStartTime(timestamp) {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

const GenerationQueue = forwardRef(function GenerationQueue(
  { activeGens, genQueueExpanded, setGenQueueExpanded, activeGenCount, dismissGen },
  ref
) {
  if (activeGens.length === 0) return null;

  return (
    <div ref={ref} className="card p-4 mb-6 fade-in">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-lg bg-blue-100 flex items-center justify-center flex-shrink-0">
            {activeGenCount > 0 ? (
              <div className="w-3 h-3 rounded-full border-2 border-blue-200 border-t-blue-500 animate-spin" />
            ) : (
              <svg className="w-3 h-3 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
            )}
          </div>
          <h3 className="text-[14px] font-semibold text-gray-900 tracking-tight">Ad Queue</h3>
          <span className="text-[11px] text-gray-400">
            {activeGenCount > 0
              ? `${activeGenCount} generating...`
              : 'All complete'}
          </span>
        </div>
        <button
          onClick={() => setGenQueueExpanded(!genQueueExpanded)}
          className="text-gray-400 hover:text-gray-600 transition-colors p-1"
        >
          <svg className={`w-4 h-4 transition-transform ${genQueueExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      </div>

      {genQueueExpanded && (
        <div className="space-y-1.5">
          {(() => {
            const pending = activeGens.filter(g => g.status && g.status !== 'completed' && !g.error);

            return activeGens.map((gen) => {
              const queuePos = pending.findIndex(g => g.id === gen.id);
              const batchNum = queuePos >= 0 ? Math.floor(queuePos / 2) : 0;
              const baseSeconds = 50;
              const estSeconds = baseSeconds + batchNum * 60;
              const estLabel = estSeconds < 120 ? `~${estSeconds}s` : `~${(estSeconds / 60).toFixed(1)} min`;

              return (
                <div key={gen.id} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-gray-50/80">
                  {gen.error ? (
                    <svg className="w-3.5 h-3.5 text-red-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" /></svg>
                  ) : gen.status === 'completed' ? (
                    <svg className="w-3.5 h-3.5 text-green-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                  ) : (
                    <div className="w-3.5 h-3.5 rounded-full border-2 border-gray-300 border-t-blue-500 animate-spin flex-shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className={`text-[12px] font-medium truncate ${gen.error ? 'text-red-600' : gen.status === 'completed' ? 'text-green-600' : 'text-gray-700'}`}>
                      {gen.label && <span className="text-gray-400 mr-1.5">{gen.label}</span>}
                      {gen.error || gen.message || 'Starting...'}
                    </p>
                    {gen.warning && (
                      <p className="text-[10px] text-amber-500 truncate">{gen.warning}</p>
                    )}
                  </div>
                  {!gen.error && gen.status !== 'completed' && gen.startTime && (
                    <span className="hidden sm:inline text-[10px] text-gray-400 whitespace-nowrap flex-shrink-0">
                      Started {formatStartTime(gen.startTime)} · {estLabel}
                    </span>
                  )}
                  {(gen.error || gen.status === 'completed') && (
                    <button onClick={() => dismissGen(gen.id)} className="text-gray-300 hover:text-gray-500 flex-shrink-0 transition-colors">
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                  )}
                </div>
              );
            });
          })()}
        </div>
      )}
    </div>
  );
});

export default GenerationQueue;

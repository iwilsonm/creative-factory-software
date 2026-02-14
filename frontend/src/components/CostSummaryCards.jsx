import { useState } from 'react';

const PERIODS = [
  { key: 'today', label: 'Spent Today' },
  { key: 'week', label: 'Spent This Week' },
  { key: 'month', label: 'Spent This Month' }
];

const OPERATION_META = {
  image_generation: { label: 'Images (manual)', color: 'bg-emerald-400', icon: '🖼' },
  image_generation_batch: { label: 'Images (batch)', color: 'bg-purple-400', icon: '📦' },
  ad_creative_director: { label: 'Creative direction', color: 'bg-blue-400', icon: '✍️' },
  foundational_docs: { label: 'Docs & research', color: 'bg-amber-400', icon: '📄' },
  other: { label: 'Other', color: 'bg-gray-300', icon: '' },
  unknown: { label: 'Other', color: 'bg-gray-300', icon: '' },
};

function formatCost(value) {
  if (value === 0 || value === undefined || value === null) return '$0.00';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

export default function CostSummaryCards({ costs, loading }) {
  const [expandedCards, setExpandedCards] = useState(new Set());

  const toggleCard = (key) => {
    setExpandedCards(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  if (loading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[0, 1, 2].map(i => (
          <div key={i} className="card p-4 animate-pulse">
            <div className="h-3 w-16 bg-gray-200 rounded mb-3" />
            <div className="h-6 w-24 bg-gray-200 rounded mb-2" />
            <div className="h-2 w-full bg-gray-100 rounded" />
          </div>
        ))}
      </div>
    );
  }

  if (!costs) return null;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      {PERIODS.map(period => {
        const data = costs[period.key];
        if (!data) return null;

        const openai = data.byService?.openai || 0;
        const gemini = data.byService?.gemini || 0;
        const total = data.total || 0;
        const openaiPct = total > 0 ? (openai / total) * 100 : 0;
        const geminiPct = total > 0 ? (gemini / total) * 100 : 0;

        // Image counts
        const manualImages = data.imageCount || 0;
        const batchImages = data.batchImageCount || 0;
        const totalImages = manualImages + batchImages;

        // Operation breakdown — sorted by cost descending
        const ops = data.byOperation || {};
        const opEntries = Object.entries(ops)
          .map(([key, val]) => {
            // Handle both old format (number) and new format ({ cost, imageCount })
            const cost = typeof val === 'number' ? val : (val?.cost || 0);
            const imgCount = typeof val === 'number' ? 0 : (val?.imageCount || 0);
            return { key, cost, imageCount: imgCount };
          })
          .filter(e => e.cost > 0)
          .sort((a, b) => b.cost - a.cost);

        return (
          <div key={period.key} className="card p-4">
            <p className="text-[11px] font-medium text-gray-400 uppercase tracking-wider mb-1">
              {period.label}
            </p>
            <div className="flex items-baseline gap-3 mb-2">
              <p className="text-xl font-semibold text-gray-900 tracking-tight">
                {formatCost(total)}
              </p>
              {totalImages > 0 && (
                <span className="text-[11px] text-gray-400 font-medium">
                  {totalImages} image{totalImages !== 1 ? 's' : ''}
                </span>
              )}
            </div>

            {total > 0 && (
              <>
                {/* Service breakdown bar */}
                <div className="w-full h-1.5 rounded-full bg-gray-100 overflow-hidden mb-2">
                  {openai > 0 && (
                    <div
                      className="h-full bg-blue-400 float-left rounded-l-full"
                      style={{ width: `${openaiPct}%` }}
                    />
                  )}
                  {gemini > 0 && (
                    <div
                      className="h-full bg-emerald-400 float-left"
                      style={{
                        width: `${geminiPct}%`,
                        borderTopRightRadius: '9999px',
                        borderBottomRightRadius: '9999px'
                      }}
                    />
                  )}
                </div>

                {/* Service legend */}
                <div className="flex items-center gap-3 text-[10px] text-gray-400 mb-3">
                  {openai > 0 && (
                    <span className="flex items-center gap-1">
                      <span className="w-2 h-2 rounded-full bg-blue-400" />
                      OpenAI {formatCost(openai)}
                    </span>
                  )}
                  {gemini > 0 && (
                    <span className="flex items-center gap-1">
                      <span className="w-2 h-2 rounded-full bg-emerald-400" />
                      Gemini {formatCost(gemini)}
                    </span>
                  )}
                </div>

                {/* Operation breakdown toggle + detail */}
                {opEntries.length > 0 && (
                  <>
                    <button
                      onClick={() => toggleCard(period.key)}
                      className="flex items-center gap-1 text-[10px] text-gray-400 hover:text-gray-600 cursor-pointer mt-1 transition-colors"
                    >
                      <span className="text-[8px]">{expandedCards.has(period.key) ? '▾' : '▸'}</span>
                      Details
                    </button>

                    {expandedCards.has(period.key) && (
                      <div className="border-t border-gray-100 pt-2 mt-1.5 space-y-1.5">
                        {opEntries.map(op => {
                          const meta = OPERATION_META[op.key] || OPERATION_META.other;
                          return (
                            <div key={op.key} className="flex items-center justify-between text-[11px]">
                              <div className="flex items-center gap-1.5 text-gray-500">
                                <span className={`w-1.5 h-1.5 rounded-full ${meta.color}`} />
                                <span>{meta.label}</span>
                                {op.imageCount > 0 && (
                                  <span className="text-gray-300">
                                    ({op.imageCount} img{op.imageCount !== 1 ? 's' : ''})
                                  </span>
                                )}
                              </div>
                              <span className="text-gray-500 font-medium tabular-nums">
                                {formatCost(op.cost)}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </>
                )}
              </>
            )}

            {total === 0 && (
              <p className="text-[11px] text-gray-300">No costs recorded</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

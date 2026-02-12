const PERIODS = [
  { key: 'today', label: 'Spent Today' },
  { key: 'week', label: 'Spent This Week' },
  { key: 'month', label: 'Spent This Month' }
];

function formatCost(value) {
  if (value === 0 || value === undefined || value === null) return '$0.00';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

export default function CostSummaryCards({ costs, loading }) {
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

        return (
          <div key={period.key} className="card p-4">
            <p className="text-[11px] font-medium text-gray-400 uppercase tracking-wider mb-1">
              {period.label}
            </p>
            <p className="text-xl font-semibold text-gray-900 tracking-tight mb-2">
              {formatCost(total)}
            </p>

            {total > 0 && (
              <>
                {/* Breakdown bar */}
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

                {/* Legend */}
                <div className="flex items-center gap-3 text-[10px] text-gray-400">
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

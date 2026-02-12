import { useState, useMemo } from 'react';

function formatCost(value) {
  if (value === 0) return '$0';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(2)}`;
  return `$${value.toFixed(2)}`;
}

function formatDateLabel(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function CostBarChart({ data, loading }) {
  const [hoveredIndex, setHoveredIndex] = useState(null);

  const chartData = useMemo(() => {
    if (!data || data.length === 0) return { bars: [], maxValue: 0, yLabels: [] };

    const maxValue = Math.max(...data.map(d => d.total), 0.01);

    // Generate nice Y-axis labels
    const yLabels = [];
    const step = maxValue / 4;
    for (let i = 4; i >= 0; i--) {
      yLabels.push(step * i);
    }

    return { bars: data, maxValue, yLabels };
  }, [data]);

  if (loading) {
    return (
      <div className="card p-5">
        <div className="h-3 w-32 bg-gray-200 rounded mb-4 animate-pulse" />
        <div className="h-40 bg-gray-50 rounded-xl animate-pulse" />
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div className="card p-5">
        <h4 className="text-[13px] font-semibold text-gray-700 mb-3">30 Days of Spend History</h4>
        <div className="h-32 flex items-center justify-center text-[12px] text-gray-400">
          No cost data yet. Costs will appear here after generating ads.
        </div>
      </div>
    );
  }

  const { bars, maxValue, yLabels } = chartData;
  const chartHeight = 160;
  const barWidth = Math.max(4, Math.min(14, (100 / bars.length) * 0.7));
  const barGap = Math.max(1, (100 / bars.length) * 0.3);

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-4">
        <h4 className="text-[13px] font-semibold text-gray-700">30 Days of Spend History</h4>
        <div className="flex items-center gap-3 text-[10px] text-gray-400">
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-blue-400" />
            OpenAI
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-emerald-400" />
            Gemini
          </span>
        </div>
      </div>

      <div className="relative" style={{ height: chartHeight + 30 }}>
        {/* Y-axis labels */}
        <div className="absolute left-0 top-0 bottom-[30px] w-10 flex flex-col justify-between text-[9px] text-gray-400 font-mono">
          {yLabels.map((v, i) => (
            <span key={i}>{formatCost(v)}</span>
          ))}
        </div>

        {/* Chart area */}
        <div className="ml-12 relative" style={{ height: chartHeight }}>
          {/* Grid lines */}
          {yLabels.map((_, i) => (
            <div
              key={i}
              className="absolute w-full border-t border-gray-100/80"
              style={{ top: `${(i / (yLabels.length - 1)) * 100}%` }}
            />
          ))}

          {/* SVG Bars */}
          <svg
            width="100%"
            height={chartHeight}
            viewBox={`0 0 ${bars.length * (barWidth + barGap)} ${chartHeight}`}
            preserveAspectRatio="none"
            className="relative z-10"
          >
            {bars.map((bar, i) => {
              const openaiH = maxValue > 0 ? (bar.openai / maxValue) * chartHeight : 0;
              const geminiH = maxValue > 0 ? (bar.gemini / maxValue) * chartHeight : 0;
              const x = i * (barWidth + barGap);

              return (
                <g
                  key={bar.date}
                  onMouseEnter={() => setHoveredIndex(i)}
                  onMouseLeave={() => setHoveredIndex(null)}
                  className="cursor-pointer"
                >
                  {/* Hover target (full height, invisible) */}
                  <rect
                    x={x}
                    y={0}
                    width={barWidth}
                    height={chartHeight}
                    fill="transparent"
                  />
                  {/* OpenAI bar (bottom) */}
                  {openaiH > 0 && (
                    <rect
                      x={x}
                      y={chartHeight - openaiH - geminiH}
                      width={barWidth}
                      height={openaiH}
                      rx={1}
                      fill={hoveredIndex === i ? '#60a5fa' : '#93bbfd'}
                      className="transition-all duration-150"
                    />
                  )}
                  {/* Gemini bar (top of stack) */}
                  {geminiH > 0 && (
                    <rect
                      x={x}
                      y={chartHeight - geminiH}
                      width={barWidth}
                      height={geminiH}
                      rx={1}
                      fill={hoveredIndex === i ? '#34d399' : '#6ee7b7'}
                      className="transition-all duration-150"
                    />
                  )}
                </g>
              );
            })}
          </svg>
        </div>

        {/* X-axis date labels (show every ~5th) */}
        <div className="ml-12 flex justify-between mt-1 text-[9px] text-gray-400">
          {bars.filter((_, i) => i === 0 || i === bars.length - 1 || i % Math.ceil(bars.length / 5) === 0)
            .map(bar => (
              <span key={bar.date}>{formatDateLabel(bar.date)}</span>
            ))}
        </div>

        {/* Tooltip */}
        {hoveredIndex !== null && bars[hoveredIndex] && (
          <div
            className="absolute z-20 bg-gray-900 text-white text-[11px] rounded-lg px-3 py-2 shadow-lg pointer-events-none"
            style={{
              left: `${12 + (hoveredIndex / bars.length) * 85}%`,
              top: 0,
              transform: 'translateX(-50%)'
            }}
          >
            <p className="font-medium mb-0.5">{formatDateLabel(bars[hoveredIndex].date)}</p>
            <p>Total: {formatCost(bars[hoveredIndex].total)}</p>
            {bars[hoveredIndex].openai > 0 && (
              <p className="text-blue-300">OpenAI: {formatCost(bars[hoveredIndex].openai)}</p>
            )}
            {bars[hoveredIndex].gemini > 0 && (
              <p className="text-emerald-300">Gemini: {formatCost(bars[hoveredIndex].gemini)}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

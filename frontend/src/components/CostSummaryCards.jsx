import { useState } from 'react';

const PERIODS = [
  { key: 'today', label: 'Spent Today' },
  { key: 'week', label: 'Spent This Week' },
  { key: 'month', label: 'Spent This Month' }
];

const OPERATION_META = {
  image_generation: { label: 'Images (manual)', color: 'bg-teal', icon: '' },
  image_generation_batch: { label: 'Images (batch)', color: 'bg-teal/70', icon: '' },
  ad_creative_director: { label: 'Creative direction', color: 'bg-[#5B8DEF]', icon: '' },
  foundational_docs: { label: 'Docs & research', color: 'bg-[#5B8DEF]/70', icon: '' },
  doc_correction: { label: 'Doc corrections', color: 'bg-[#7C6DCD]', icon: '' },
  batch_brief_extraction: { label: 'Brief extraction', color: 'bg-[#7C6DCD]/70', icon: '' },
  batch_headline_generation: { label: 'Headlines (batch)', color: 'bg-[#7C6DCD]', icon: '' },
  batch_body_copy: { label: 'Body copy (batch)', color: 'bg-[#7C6DCD]/70', icon: '' },
  batch_image_prompt: { label: 'Image prompts (batch)', color: 'bg-[#7C6DCD]', icon: '' },
  ad_angle_generation: { label: 'Angle generation', color: 'bg-[#7C6DCD]/70', icon: '' },
  ad_headline_generation: { label: 'Headline generation', color: 'bg-[#7C6DCD]', icon: '' },
  headline_generation: { label: 'Headlines', color: 'bg-[#7C6DCD]/70', icon: '' },
  headline_generation_per_quote: { label: 'Headlines (per quote)', color: 'bg-[#7C6DCD]', icon: '' },
  headline_generation_more: { label: 'Headlines (more)', color: 'bg-[#7C6DCD]/70', icon: '' },
  quote_mining: { label: 'Quote mining (Perplexity)', color: 'bg-gold', icon: '' },
  quote_mining_web_search: { label: 'Quote mining (Claude)', color: 'bg-[#7C6DCD]/70', icon: '' },
  lp_design_analysis: { label: 'LP design analysis', color: 'bg-[#7C6DCD]/70', icon: '' },
  lp_generation: { label: 'LP copy generation', color: 'bg-[#7C6DCD]', icon: '' },
  lp_html_generation: { label: 'LP HTML generation', color: 'bg-[#7C6DCD]/70', icon: '' },
  lp_image_generation: { label: 'LP images', color: 'bg-teal/70', icon: '' },
  other: { label: 'Other', color: 'bg-textlight/50', icon: '' },
  unknown: { label: 'Other', color: 'bg-textlight/50', icon: '' },
};

// Service definitions for the breakdown bar + legend
const SERVICE_DEFS = [
  { key: 'openai', label: 'OpenAI', barClass: 'bg-[#5B8DEF]', dotClass: 'bg-[#5B8DEF]' },
  { key: 'anthropic', label: 'Anthropic', barClass: 'bg-[#7C6DCD]', dotClass: 'bg-[#7C6DCD]' },
  { key: 'gemini', label: 'Gemini', barClass: 'bg-teal', dotClass: 'bg-teal' },
  { key: 'perplexity', label: 'Perplexity', barClass: 'bg-gold', dotClass: 'bg-gold' },
];

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
            <div className="h-2 w-full bg-black/5 rounded" />
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

        const total = data.total || 0;

        // Build service amounts array
        const services = SERVICE_DEFS.map(s => ({
          ...s,
          amount: data.byService?.[s.key] || 0,
          pct: total > 0 ? ((data.byService?.[s.key] || 0) / total) * 100 : 0,
        })).filter(s => s.amount > 0);

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
            <p className="text-[11px] font-medium text-textlight uppercase tracking-wider mb-1">
              {period.label}
            </p>
            <div className="flex items-baseline gap-3 mb-2">
              <p className="text-xl font-semibold text-textdark tracking-tight">
                {formatCost(total)}
              </p>
              {totalImages > 0 && (
                <span className="text-[11px] text-textlight font-medium">
                  {totalImages} image{totalImages !== 1 ? 's' : ''}
                </span>
              )}
            </div>

            {total > 0 && (
              <>
                {/* Service breakdown bar */}
                <div className="w-full h-1.5 rounded-full bg-black/5 overflow-hidden mb-2 flex">
                  {services.map((s, idx) => (
                    <div
                      key={s.key}
                      className={`h-full ${s.barClass}`}
                      style={{
                        width: `${s.pct}%`,
                        borderTopLeftRadius: idx === 0 ? '9999px' : 0,
                        borderBottomLeftRadius: idx === 0 ? '9999px' : 0,
                        borderTopRightRadius: idx === services.length - 1 ? '9999px' : 0,
                        borderBottomRightRadius: idx === services.length - 1 ? '9999px' : 0,
                      }}
                    />
                  ))}
                </div>

                {/* Service legend */}
                <div className="flex items-center gap-3 text-[10px] text-textlight mb-3 flex-wrap">
                  {services.map(s => (
                    <span key={s.key} className="flex items-center gap-1">
                      <span className={`w-2 h-2 rounded-full ${s.dotClass}`} />
                      {s.label} {formatCost(s.amount)}
                    </span>
                  ))}
                </div>

                {/* Operation breakdown toggle + detail */}
                {opEntries.length > 0 && (
                  <>
                    <button
                      onClick={() => toggleCard(period.key)}
                      className="flex items-center gap-1 text-[10px] text-textlight hover:text-textmid cursor-pointer mt-1 transition-colors"
                    >
                      <svg
                        className={`w-3 h-3 transition-transform duration-200 ${expandedCards.has(period.key) ? 'rotate-180' : ''}`}
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                      Details
                    </button>

                    {expandedCards.has(period.key) && (
                      <div className="border-t border-black/5 pt-2 mt-1.5 space-y-1.5">
                        {opEntries.map(op => {
                          const meta = OPERATION_META[op.key] || OPERATION_META.other;
                          return (
                            <div key={op.key} className="flex items-center justify-between text-[11px]">
                              <div className="flex items-center gap-1.5 text-textmid">
                                <span className={`w-1.5 h-1.5 rounded-full ${meta.color}`} />
                                <span>{meta.label}</span>
                                {op.imageCount > 0 && (
                                  <span className="text-textlight/60">
                                    ({op.imageCount} img{op.imageCount !== 1 ? 's' : ''})
                                  </span>
                                )}
                              </div>
                              <span className="text-textmid font-medium tabular-nums">
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
              <p className="text-[11px] text-textlight/60">No costs recorded</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

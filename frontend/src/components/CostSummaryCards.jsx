import { useState } from 'react';

const PERIODS = [
  { key: 'today', label: 'Spent Today' },
  { key: 'week', label: 'Spent This Week' },
  { key: 'month', label: 'Spent This Month' }
];

// Every operation maps to a group for the collapsed detail view
const OPERATION_META = {
  // Ad Generation
  ad_creative_director:          { group: 'ad_gen' },
  ad_generation_mode1:           { group: 'ad_gen' },
  ad_generation_mode2:           { group: 'ad_gen' },
  ad_headline_extraction:        { group: 'ad_gen' },
  ad_angle_generation:           { group: 'ad_gen' },
  ad_headline_generation:        { group: 'ad_gen' },
  ad_headline_generation_sidebar:{ group: 'ad_gen' },
  ad_image_generation:           { group: 'ad_gen' },
  prompt_guideline_review:       { group: 'ad_gen' },
  prompt_edit:                   { group: 'ad_gen' },
  cmo_angle_writing:             { group: 'ad_gen' },
  primary_text_generation:       { group: 'ad_gen' },
  // Batch Pipeline
  batch_brief_extraction:        { group: 'batch' },
  batch_headline_generation:     { group: 'batch' },
  batch_body_copy:               { group: 'batch' },
  batch_body_copy_repair:        { group: 'batch' },
  batch_image_prompt:            { group: 'batch' },
  batch_ocr_extraction:          { group: 'batch' },
  // Image Generation
  image_generation:              { group: 'images' },
  image_generation_batch:        { group: 'images' },
  lp_image_generation:           { group: 'images' },
  lp_autofix_image:              { group: 'images' },
  lp_image_prescore_retry:       { group: 'images' },
  lp_gauntlet_image_regen:       { group: 'images' },
  // Docs & Research
  foundational_docs:             { group: 'docs' },
  deep_research:                 { group: 'docs' },
  doc_correction:                { group: 'docs' },
  auto_describe:                 { group: 'docs' },
  template_analysis:             { group: 'docs' },
  // Quote Mining
  quote_mining:                  { group: 'quotes' },
  quote_mining_web_search:       { group: 'quotes' },
  quote_mining_suggestions:      { group: 'quotes' },
  quote_merge_rank:              { group: 'quotes' },
  quote_deduplication:           { group: 'quotes' },
  body_copy_generation:          { group: 'quotes' },
  // Headlines
  headline_generation:           { group: 'headlines' },
  headline_generation_per_quote: { group: 'headlines' },
  headline_generation_more:      { group: 'headlines' },
  // LP Generation
  lp_generation:                 { group: 'lp_gen' },
  lp_html_generation:            { group: 'lp_gen' },
  lp_design_analysis:            { group: 'lp_gen' },
  lp_editorial_pass:             { group: 'lp_gen' },
  lp_image_context_extraction:   { group: 'lp_gen' },
  lp_title_only_generation:      { group: 'lp_gen' },
  lp_template_extraction:        { group: 'lp_gen' },
  lp_legacy_docs_analysis:       { group: 'lp_gen' },
  lp_legacy_swipe_analysis:      { group: 'lp_gen' },
  lp_legacy_first_half:          { group: 'lp_gen' },
  lp_legacy_second_half:         { group: 'lp_gen' },
  // LP Quality & Fixes
  lp_visual_qa:                  { group: 'lp_qa' },
  lp_quality_gate:               { group: 'lp_qa' },
  lp_canonical_benchmark:        { group: 'lp_qa' },
  lp_headline_repair:            { group: 'lp_qa' },
  lp_content_alignment_repair:   { group: 'lp_qa' },
  lp_autofix_css:                { group: 'lp_qa' },
  lp_image_prescore:             { group: 'lp_qa' },
  lp_gauntlet_score:             { group: 'lp_qa' },
  // Creative Filter
  filter_score_ad:               { group: 'filter' },
  filter_group_ads:              { group: 'filter' },
  filter_primary_text_generation:{ group: 'filter' },
  filter_headline_generation:    { group: 'filter' },
  // Director
  conductor_angle_generation:    { group: 'conductor' },
  conductor_learning_analysis:   { group: 'conductor' },
  // Copywriter Chat
  copywriter_chat_init:          { group: 'chat' },
  copywriter_chat:               { group: 'chat' },
  // OpenAI Billing API (org-wide, not operation-specific)
  openai_billing:                { group: 'billing' },
  openai_billing_gpt5:           { group: 'billing' },
  openai_billing_gpt4:           { group: 'billing' },
  openai_billing_gpt4_mini:      { group: 'billing' },
  openai_billing_research:       { group: 'billing' },
  // Fallbacks
  other:                         { group: 'other' },
  unknown:                       { group: 'other' },
};

const OPERATION_GROUPS = {
  ad_gen:    { label: 'Ad Generation',       color: 'bg-[#5B8DEF]' },
  batch:     { label: 'Batch Pipeline',      color: 'bg-[#7C6DCD]' },
  images:    { label: 'Image Generation',    color: 'bg-teal' },
  docs:      { label: 'Docs & Research',     color: 'bg-[#5B8DEF]/70' },
  quotes:    { label: 'Quote Mining',        color: 'bg-gold' },
  headlines: { label: 'Headlines',           color: 'bg-[#7C6DCD]/70' },
  lp_gen:    { label: 'LP Generation',       color: 'bg-[#7C6DCD]' },
  lp_qa:     { label: 'LP Quality & Fixes',  color: 'bg-[#7C6DCD]/70' },
  filter:    { label: 'Creative Filter',     color: 'bg-[#7C6DCD]' },
  conductor: { label: 'Director',            color: 'bg-[#7C6DCD]' },
  chat:      { label: 'Copywriter Chat',     color: 'bg-[#7C6DCD]' },
  billing:   { label: 'OpenAI Billing Sync', color: 'bg-[#5B8DEF]/50' },
  other:     { label: 'Other',              color: 'bg-textlight/50' },
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

        // Operation breakdown — grouped by category, sorted by cost descending
        const ops = data.byOperation || {};
        const grouped = {};
        for (const [key, val] of Object.entries(ops)) {
          const cost = typeof val === 'number' ? val : (val?.cost || 0);
          const imgCount = typeof val === 'number' ? 0 : (val?.imageCount || 0);
          if (cost <= 0) continue;
          const groupKey = (OPERATION_META[key] || OPERATION_META.other).group;
          if (!grouped[groupKey]) grouped[groupKey] = { cost: 0, imageCount: 0 };
          grouped[groupKey].cost += cost;
          grouped[groupKey].imageCount += imgCount;
        }
        const opEntries = Object.entries(grouped)
          .map(([key, data]) => ({
            key,
            cost: data.cost,
            imageCount: data.imageCount,
            ...(OPERATION_GROUPS[key] || OPERATION_GROUPS.other),
          }))
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
                      className="inline-flex items-center gap-1 text-[12px] font-medium text-navy hover:text-navy/80 bg-navy/5 hover:bg-navy/10 px-2 py-1 rounded-md cursor-pointer mt-2 transition-all"
                    >
                      <svg
                        className={`w-3.5 h-3.5 transition-transform duration-200 ${expandedCards.has(period.key) ? 'rotate-180' : ''}`}
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
                        {opEntries.map(op => (
                          <div key={op.key} className="flex items-center justify-between text-[11px]">
                            <div className="flex items-center gap-1.5 text-textmid">
                              <span className={`w-1.5 h-1.5 rounded-full ${op.color}`} />
                              <span>{op.label}</span>
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
                        ))}
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

// Phase 3 — Pure function: score a single ad set's lifetime-window insights
// against the project's resolved benchmark and return a verdict.
//
// Tiers (composite of starvation gate + min_spend gate + primary metric):
//   spend < starvation_threshold              → failed (reason: "starved")
//   spend < min_spend                          → insufficient_data
//   primary_gate=roas: roas >= roas_min        → passed | failed (underperforming)
//   primary_gate=cpa : cpa  <= cpa_max         → passed | failed (underperforming)
//   primary metric requires action_type;
//     missing action OR conversions=0          → insufficient_data
//   optional ctr_min: if set, must also pass
//
// Pure: no I/O, no side effects. Easy to unit-test.

const STARVATION_THRESHOLD = 0.5; // dollars/account currency. Sub-50¢ = "Meta refused to spend"

function pickActionRow(actionsArray, actionType) {
  if (!Array.isArray(actionsArray)) return null;
  return actionsArray.find((a) => a?.action_type === actionType) || null;
}

function num(v, fallback = 0) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Resolve raw insights into the metrics needed for scoring.
 * Insights shape comes from Meta /insights with our standard field set.
 */
function deriveMetrics(insights, actionType) {
  const spend = num(insights?.spend);
  const impressions = num(insights?.impressions);
  const clicks = num(insights?.clicks);
  const ctrPct = num(insights?.ctr); // Meta returns percent (e.g., 1.5 = 1.5%)
  const ctrFraction = ctrPct / 100;

  // ROAS — Meta returns purchase_roas array
  let roas = 0;
  const roasRow = pickActionRow(insights?.purchase_roas, actionType);
  if (roasRow) {
    roas = num(roasRow.value);
  } else if (Array.isArray(insights?.purchase_roas) && insights.purchase_roas.length > 0) {
    // If only one ROAS entry exists and our action_type isn't there, take it (legacy fallback)
    roas = num(insights.purchase_roas[0]?.value);
  }

  // Conversions — count of the configured action_type
  let conversions = 0;
  const actionRow = pickActionRow(insights?.actions, actionType);
  if (actionRow) conversions = num(actionRow.value);

  // CPA — cost_per_action_type for our action_type
  let cpa = 0;
  const cpaRow = pickActionRow(insights?.cost_per_action_type, actionType);
  if (cpaRow) cpa = num(cpaRow.value);

  return { spend, impressions, clicks, ctrFraction, roas, cpa, conversions };
}

/**
 * @param {object} params
 * @param {object} params.insights      — raw Meta insights row (lifetime-window)
 * @param {object} params.benchmark     — { min_spend, primary_gate, roas_min, cpa_max, ctr_min, action_type }
 * @param {number} params.daysObserved  — for "insufficient_data" reason text
 * @param {string} params.accountCurrency — for reason text formatting
 * @returns {{ verdict, fail_reason_code, primary_metric_value, reason, sufficient_data, metrics }}
 */
export function scoreObservation({ insights, benchmark, daysObserved = 0, accountCurrency = 'USD' }) {
  if (!benchmark || typeof benchmark !== 'object') {
    throw new Error('benchmarkScorer: benchmark is required');
  }
  const minSpend = num(benchmark.min_spend);
  const primaryGate = (benchmark.primary_gate || 'roas').toLowerCase();
  const roasMin = num(benchmark.roas_min);
  const cpaMax = num(benchmark.cpa_max);
  const ctrMin = benchmark.ctr_min === '' || benchmark.ctr_min == null
    ? null
    : num(benchmark.ctr_min);
  const actionType = benchmark.action_type || 'purchase';

  const metrics = deriveMetrics(insights, actionType);
  const ccy = accountCurrency;

  // Tier 1 — starvation: Meta allocated < threshold
  if (metrics.spend < STARVATION_THRESHOLD) {
    return {
      verdict: 'failed',
      fail_reason_code: 'starved',
      primary_metric_value: metrics.spend,
      sufficient_data: false,
      reason: `Starved: only ${formatMoney(metrics.spend, ccy)} spent over ${daysObserved} days (< ${formatMoney(STARVATION_THRESHOLD, ccy)}). Meta declined to allocate budget — angle treated as failed.`,
      metrics,
    };
  }

  // Tier 2 — insufficient spend: above starvation, below min_spend gate
  if (metrics.spend < minSpend) {
    return {
      verdict: 'insufficient_data',
      fail_reason_code: null,
      primary_metric_value: metrics.spend,
      sufficient_data: false,
      reason: `Insufficient data: ${formatMoney(metrics.spend, ccy)} spent < ${formatMoney(minSpend, ccy)} threshold. Cannot reliably evaluate primary metric.`,
      metrics,
    };
  }

  // Tier 3 — primary metric requires conversions of the configured action_type
  if ((primaryGate === 'roas' || primaryGate === 'cpa') && metrics.conversions === 0) {
    return {
      verdict: 'insufficient_data',
      fail_reason_code: null,
      primary_metric_value: 0,
      sufficient_data: false,
      reason: `Insufficient data: no '${actionType}' conversions recorded despite ${formatMoney(metrics.spend, ccy)} spend. Verify action_type in Observation settings.`,
      metrics,
    };
  }

  // Tier 4 — primary gate
  let passed = false;
  let primaryValue = 0;
  let primaryReason = '';
  if (primaryGate === 'roas') {
    primaryValue = metrics.roas;
    passed = metrics.roas >= roasMin;
    primaryReason = passed
      ? `ROAS ${metrics.roas.toFixed(2)} ≥ ${roasMin.toFixed(2)} threshold`
      : `ROAS ${metrics.roas.toFixed(2)} < ${roasMin.toFixed(2)} threshold`;
  } else if (primaryGate === 'cpa') {
    primaryValue = metrics.cpa;
    passed = metrics.cpa > 0 && metrics.cpa <= cpaMax;
    primaryReason = passed
      ? `CPA ${formatMoney(metrics.cpa, ccy)} ≤ ${formatMoney(cpaMax, ccy)} threshold`
      : `CPA ${formatMoney(metrics.cpa, ccy)} > ${formatMoney(cpaMax, ccy)} threshold`;
  } else {
    throw new Error(`benchmarkScorer: unknown primary_gate "${primaryGate}"`);
  }

  // Optional CTR floor
  let ctrPassed = true;
  let ctrReason = '';
  if (ctrMin != null) {
    ctrPassed = metrics.ctrFraction >= ctrMin;
    ctrReason = ctrPassed
      ? `; CTR ${(metrics.ctrFraction * 100).toFixed(2)}% ≥ ${(ctrMin * 100).toFixed(2)}% floor`
      : `; CTR ${(metrics.ctrFraction * 100).toFixed(2)}% < ${(ctrMin * 100).toFixed(2)}% floor`;
  }

  if (passed && ctrPassed) {
    return {
      verdict: 'passed',
      fail_reason_code: null,
      primary_metric_value: primaryValue,
      sufficient_data: true,
      reason: `Passed: ${primaryReason}${ctrReason}. Spend ${formatMoney(metrics.spend, ccy)} over ${daysObserved} days.`,
      metrics,
    };
  }

  return {
    verdict: 'failed',
    fail_reason_code: 'underperforming',
    primary_metric_value: primaryValue,
    sufficient_data: true,
    reason: `Failed: ${primaryReason}${ctrReason}. Spend ${formatMoney(metrics.spend, ccy)} over ${daysObserved} days.`,
    metrics,
  };
}

// Internal helper — currency-agnostic display ($X.XX for USD, integer otherwise).
function formatMoney(amount, currency) {
  if (currency === 'USD') return `$${amount.toFixed(2)}`;
  return `${Math.round(amount).toLocaleString('en-US')} ${currency}`;
}

// Re-exported for tests + UI display.
export const PHASE3_STARVATION_THRESHOLD = STARVATION_THRESHOLD;

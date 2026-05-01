// Phase 3 — Unit tests for the pure benchmarkScorer.
// Verifies tier ordering: starvation < insufficient_data < primary metric.

import { describe, it, expect } from 'vitest';
import { scoreObservation, PHASE3_STARVATION_THRESHOLD } from '../services/benchmarkScorer.js';

const BENCHMARK_ROAS = {
  min_spend: 2,
  primary_gate: 'roas',
  roas_min: 1.5,
  cpa_max: 40,
  ctr_min: '',
  action_type: 'purchase',
};

const BENCHMARK_CPA = {
  ...BENCHMARK_ROAS,
  primary_gate: 'cpa',
};

function insightsRow(overrides = {}) {
  return {
    spend: '0',
    impressions: '0',
    clicks: '0',
    ctr: '0',
    cpm: '0',
    cpc: '0',
    actions: [],
    cost_per_action_type: [],
    purchase_roas: [],
    ...overrides,
  };
}

describe('benchmarkScorer — starvation tier (< $0.50)', () => {
  it('marks zero spend as starved/failed', () => {
    const r = scoreObservation({ insights: insightsRow({ spend: '0' }), benchmark: BENCHMARK_ROAS, daysObserved: 12 });
    expect(r.verdict).toBe('failed');
    expect(r.fail_reason_code).toBe('starved');
  });

  it('marks $0.30 spend over 12d as starved', () => {
    const r = scoreObservation({ insights: insightsRow({ spend: '0.30' }), benchmark: BENCHMARK_ROAS, daysObserved: 12 });
    expect(r.verdict).toBe('failed');
    expect(r.fail_reason_code).toBe('starved');
    expect(r.reason).toMatch(/Starved/i);
  });

  it('PHASE3_STARVATION_THRESHOLD is $0.50', () => {
    expect(PHASE3_STARVATION_THRESHOLD).toBe(0.5);
  });
});

describe('benchmarkScorer — insufficient_data tier (≥ $0.50, < min_spend)', () => {
  it('marks $1.00 with min_spend $2 as insufficient_data', () => {
    const r = scoreObservation({ insights: insightsRow({ spend: '1.00' }), benchmark: BENCHMARK_ROAS, daysObserved: 12 });
    expect(r.verdict).toBe('insufficient_data');
    expect(r.fail_reason_code).toBe(null);
  });

  it('marks $0.50 (exactly the starvation boundary) as insufficient_data, not starved', () => {
    const r = scoreObservation({ insights: insightsRow({ spend: '0.50' }), benchmark: BENCHMARK_ROAS, daysObserved: 12 });
    expect(r.verdict).toBe('insufficient_data');
  });
});

describe('benchmarkScorer — ROAS primary gate', () => {
  it('passes when spend ≥ min_spend AND ROAS ≥ roas_min', () => {
    const r = scoreObservation({
      insights: insightsRow({
        spend: '5',
        actions: [{ action_type: 'purchase', value: '2' }],
        purchase_roas: [{ action_type: 'purchase', value: '1.8' }],
      }),
      benchmark: BENCHMARK_ROAS,
      daysObserved: 12,
    });
    expect(r.verdict).toBe('passed');
    expect(r.reason).toMatch(/ROAS 1\.80.*≥/);
  });

  it('fails (underperforming) when ROAS < roas_min', () => {
    const r = scoreObservation({
      insights: insightsRow({
        spend: '5',
        actions: [{ action_type: 'purchase', value: '1' }],
        purchase_roas: [{ action_type: 'purchase', value: '0.9' }],
      }),
      benchmark: BENCHMARK_ROAS,
      daysObserved: 12,
    });
    expect(r.verdict).toBe('failed');
    expect(r.fail_reason_code).toBe('underperforming');
    expect(r.reason).toMatch(/ROAS 0\.90.*</);
  });

  it('insufficient_data when spend ≥ min_spend but conversions = 0 (no purchase action)', () => {
    const r = scoreObservation({
      insights: insightsRow({ spend: '5', actions: [], purchase_roas: [] }),
      benchmark: BENCHMARK_ROAS,
      daysObserved: 12,
    });
    expect(r.verdict).toBe('insufficient_data');
    expect(r.reason).toMatch(/no 'purchase' conversions/i);
  });

  it('insufficient_data when configured action_type is missing entirely', () => {
    const r = scoreObservation({
      insights: insightsRow({
        spend: '5',
        actions: [{ action_type: 'lead', value: '3' }],   // brand uses 'lead', not 'purchase'
      }),
      benchmark: BENCHMARK_ROAS,
      daysObserved: 12,
    });
    expect(r.verdict).toBe('insufficient_data');
  });
});

describe('benchmarkScorer — CPA primary gate', () => {
  it('passes when CPA ≤ cpa_max', () => {
    const r = scoreObservation({
      insights: insightsRow({
        spend: '50',
        actions: [{ action_type: 'purchase', value: '2' }],
        cost_per_action_type: [{ action_type: 'purchase', value: '25' }],
      }),
      benchmark: BENCHMARK_CPA,
      daysObserved: 12,
    });
    expect(r.verdict).toBe('passed');
    expect(r.reason).toMatch(/CPA \$25\.00 ≤ \$40\.00/);
  });

  it('fails when CPA > cpa_max', () => {
    const r = scoreObservation({
      insights: insightsRow({
        spend: '120',
        actions: [{ action_type: 'purchase', value: '2' }],
        cost_per_action_type: [{ action_type: 'purchase', value: '60' }],
      }),
      benchmark: BENCHMARK_CPA,
      daysObserved: 12,
    });
    expect(r.verdict).toBe('failed');
    expect(r.fail_reason_code).toBe('underperforming');
  });
});

describe('benchmarkScorer — CTR floor', () => {
  it('with CTR floor: fails when CTR < floor even if ROAS passes', () => {
    const r = scoreObservation({
      insights: insightsRow({
        spend: '5',
        ctr: '0.5',  // 0.5% — below 1% floor
        actions: [{ action_type: 'purchase', value: '1' }],
        purchase_roas: [{ action_type: 'purchase', value: '2.0' }],
      }),
      benchmark: { ...BENCHMARK_ROAS, ctr_min: 0.01 },  // 1% floor
      daysObserved: 12,
    });
    expect(r.verdict).toBe('failed');
    expect(r.reason).toMatch(/CTR 0\.50%.*</);
  });

  it('with CTR floor: passes when both ROAS and CTR clear', () => {
    const r = scoreObservation({
      insights: insightsRow({
        spend: '5',
        ctr: '2.5',  // 2.5%
        actions: [{ action_type: 'purchase', value: '1' }],
        purchase_roas: [{ action_type: 'purchase', value: '2.0' }],
      }),
      benchmark: { ...BENCHMARK_ROAS, ctr_min: 0.01 },
      daysObserved: 12,
    });
    expect(r.verdict).toBe('passed');
  });
});

describe('benchmarkScorer — defensive numeric handling', () => {
  it('treats missing fields as 0 — yields starved verdict', () => {
    const r = scoreObservation({ insights: {}, benchmark: BENCHMARK_ROAS, daysObserved: 12 });
    expect(r.verdict).toBe('failed');
    expect(r.fail_reason_code).toBe('starved');
  });

  it('throws if benchmark missing', () => {
    expect(() => scoreObservation({ insights: insightsRow(), daysObserved: 12 })).toThrow(/benchmark is required/);
  });
});

import { describe, expect, it, vi } from 'vitest';

vi.mock('../convexClient.js', () => ({
  getProject: vi.fn(),
  getLatestDoc: vi.fn(),
  getBatchJob: vi.fn(),
  updateBatchJob: vi.fn(),
  getAdsByBatchId: vi.fn(),
  getAd: vi.fn(),
  downloadToBuffer: vi.fn(),
  createAdSet: vi.fn(),
  createFlexAd: vi.fn(),
  createDeploymentDuplicate: vi.fn(),
  updateDeployment: vi.fn(),
  getFlexAdsByProject: vi.fn(),
  getConductorConfig: vi.fn(),
}));

vi.mock('../services/anthropic.js', () => ({
  chat: vi.fn(),
  chatWithImage: vi.fn(),
  extractJSON: vi.fn(),
}));

vi.mock('../services/headlineDiversity.js', () => ({
  filterHeadlineCandidatePool: vi.fn((items) => items),
  selectDiverseHeadlines: vi.fn((items) => items),
}));

describe('creativeFilterService scoring normalization', () => {
  it('defaults Director template ads to the template copy-on-creative contract', async () => {
    const { buildAdScoringContract } = await import('../services/creativeFilterService.js');
    const contract = buildAdScoringContract({
      template_image_id: 'template-1',
    });

    expect(contract).toEqual({
      scoring_mode: 'template_copy_on_creative',
      copy_render_expectation: 'rendered',
      product_expectation: 'required',
    });
  });

  it('passes a valid template ad with visible copy and visible product', async () => {
    const { normalizeDirectorScore } = await import('../services/creativeFilterService.js');
    const normalized = normalizeDirectorScore(
      {
        ad_id: 'ad-1',
        hard_requirements: {
          spelling_grammar: true,
          product_present: true,
          correct_product: true,
          visual_integrity: true,
          rendered_text_integrity: true,
        },
        copy_polish: 8,
        meta_compliance: 8,
        effectiveness: 8,
        visual_integrity_score: 8,
        visual_contract_match: 9,
      },
      {
        scoring_mode: 'template_copy_on_creative',
        copy_render_expectation: 'rendered',
        product_expectation: 'required',
      },
      { hasImage: true }
    );

    expect(normalized.hard_requirements.all_passed).toBe(true);
    expect(normalized.pass).toBe(true);
    expect(normalized.overall_score).toBeGreaterThanOrEqual(7);
  });

  it('hard-fails when the required product is missing', async () => {
    const { normalizeDirectorScore } = await import('../services/creativeFilterService.js');
    const normalized = normalizeDirectorScore(
      {
        ad_id: 'ad-2',
        hard_requirements: {
          spelling_grammar: true,
          product_present: false,
          correct_product: true,
          visual_integrity: true,
          rendered_text_integrity: true,
        },
        copy_polish: 9,
        meta_compliance: 9,
        effectiveness: 9,
        visual_integrity_score: 9,
        visual_contract_match: 9,
      },
      {
        scoring_mode: 'template_copy_on_creative',
        copy_render_expectation: 'rendered',
        product_expectation: 'required',
      },
      { hasImage: true }
    );

    expect(normalized.hard_requirements.product_present).toBe(false);
    expect(normalized.hard_requirements.all_passed).toBe(false);
    expect(normalized.pass).toBe(false);
    expect(normalized.overall_score).toBe(0);
  });

  it('does not hard-fail a valid ad just because copy polish is weak', async () => {
    const { normalizeDirectorScore } = await import('../services/creativeFilterService.js');
    const normalized = normalizeDirectorScore(
      {
        ad_id: 'ad-3',
        hard_requirements: {
          spelling_grammar: true,
          product_present: true,
          correct_product: true,
          visual_integrity: true,
          rendered_text_integrity: true,
        },
        copy_polish: 5,
        meta_compliance: 8,
        effectiveness: 8,
        visual_integrity_score: 8,
        visual_contract_match: 8,
      },
      {
        scoring_mode: 'template_copy_on_creative',
        copy_render_expectation: 'rendered',
        product_expectation: 'required',
      },
      { hasImage: true }
    );

    expect(normalized.hard_requirements.all_passed).toBe(true);
    expect(normalized.overall_score).toBeGreaterThan(0);
  });

  it('floors copy and effectiveness to mid-competent for valid template ads', async () => {
    const { normalizeDirectorScore } = await import('../services/creativeFilterService.js');
    const normalized = normalizeDirectorScore(
      {
        ad_id: 'ad-3b',
        hard_requirements: {
          spelling_grammar: true,
          product_present: true,
          correct_product: true,
          visual_integrity: true,
          rendered_text_integrity: true,
        },
        copy_polish: 3,
        meta_compliance: 8,
        effectiveness: 2,
        visual_integrity_score: 8,
        visual_contract_match: 7,
      },
      {
        scoring_mode: 'template_copy_on_creative',
        copy_render_expectation: 'rendered',
        product_expectation: 'required',
      },
      { hasImage: true }
    );

    expect(normalized.copy_polish).toBe(5);
    expect(normalized.effectiveness).toBe(5);
    expect(normalized.overall_score).toBeGreaterThanOrEqual(7);
    expect(normalized.pass).toBe(true);
  });

  it('computes pass/fail in code instead of trusting the model pass flag', async () => {
    const { normalizeDirectorScore } = await import('../services/creativeFilterService.js');
    const normalized = normalizeDirectorScore(
      {
        ad_id: 'ad-4',
        pass: true,
        hard_requirements: {
          spelling_grammar: true,
          product_present: true,
          correct_product: true,
          visual_integrity: true,
          rendered_text_integrity: true,
        },
        copy_polish: 4,
        meta_compliance: 4,
        effectiveness: 4,
        visual_integrity_score: 4,
        visual_contract_match: 4,
      },
      {
        scoring_mode: 'template_copy_on_creative',
        copy_render_expectation: 'rendered',
        product_expectation: 'required',
      },
      { hasImage: true }
    );

    expect(normalized.pass).toBe(false);
    expect(normalized.overall_score).toBeLessThan(7);
  });
});

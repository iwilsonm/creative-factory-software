import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockUuid = vi.fn();

const mockGetConductorConfig = vi.fn();
const mockUpsertConductorConfig = vi.fn();
const mockGetActiveConductorAngles = vi.fn();
const mockUpdateConductorAngle = vi.fn();
const mockGetConductorPlaybook = vi.fn();
const mockCreateConductorRun = vi.fn();
const mockUpdateConductorRun = vi.fn();
const mockGetConductorRuns = vi.fn();
const mockCreateBatchJob = vi.fn();
const mockGetBatchJob = vi.fn();
const mockUpdateBatchJob = vi.fn();
const mockGetAdsByBatchId = vi.fn();
const mockGetAd = vi.fn();
const mockGetFlexAdsByProject = vi.fn();
const mockGetBatchesByProject = vi.fn();
const mockGetProject = vi.fn();
const mockGetAllConductorConfigs = vi.fn();
const mockConvexMutation = vi.fn();

const mockGetAdaptiveBatchSize = vi.fn();
const mockRunBatch = vi.fn();
const mockPollBatchJob = vi.fn();
const mockTriggerLPGeneration = vi.fn();
const mockScoreBatchForInlineFilter = vi.fn();
const mockFinalizePassingAds = vi.fn();
const mockScoreAd = vi.fn();
const mockBuildStructuredAnglePrompt = vi.fn();
const mockHasStructuredBrief = vi.fn();
const mockBuildAngleBriefJSON = vi.fn();
const mockGenerateImagePrompt = vi.fn();
const mockRegenerateImageOnly = vi.fn();
const mockRepairBodyCopy = vi.fn();

vi.mock('uuid', () => ({
  v4: () => mockUuid(),
}));

vi.mock('../convexClient.js', () => ({
  getConductorConfig: (...args) => mockGetConductorConfig(...args),
  upsertConductorConfig: (...args) => mockUpsertConductorConfig(...args),
  getActiveConductorAngles: (...args) => mockGetActiveConductorAngles(...args),
  updateConductorAngle: (...args) => mockUpdateConductorAngle(...args),
  getConductorPlaybook: (...args) => mockGetConductorPlaybook(...args),
  createConductorRun: (...args) => mockCreateConductorRun(...args),
  updateConductorRun: (...args) => mockUpdateConductorRun(...args),
  getConductorRuns: (...args) => mockGetConductorRuns(...args),
  createBatchJob: (...args) => mockCreateBatchJob(...args),
  getBatchJob: (...args) => mockGetBatchJob(...args),
  updateBatchJob: (...args) => mockUpdateBatchJob(...args),
  getAdsByBatchId: (...args) => mockGetAdsByBatchId(...args),
  getAd: (...args) => mockGetAd(...args),
  getFlexAdsByProject: (...args) => mockGetFlexAdsByProject(...args),
  getBatchesByProject: (...args) => mockGetBatchesByProject(...args),
  getProject: (...args) => mockGetProject(...args),
  getAllConductorConfigs: (...args) => mockGetAllConductorConfigs(...args),
  convexClient: {
    mutation: (...args) => mockConvexMutation(...args),
  },
  api: {
    adCreatives: {
      create: 'adCreatives.create',
    },
  },
}));

vi.mock('../services/conductorLearning.js', () => ({
  getAdaptiveBatchSize: (...args) => mockGetAdaptiveBatchSize(...args),
}));

vi.mock('../services/batchProcessor.js', () => ({
  runBatch: (...args) => mockRunBatch(...args),
  pollBatchJob: (...args) => mockPollBatchJob(...args),
}));

vi.mock('../services/lpAutoGenerator.js', () => ({
  triggerLPGeneration: (...args) => mockTriggerLPGeneration(...args),
}));

vi.mock('../services/creativeFilterService.js', () => ({
  scoreBatchForInlineFilter: (...args) => mockScoreBatchForInlineFilter(...args),
  finalizePassingAds: (...args) => mockFinalizePassingAds(...args),
  scoreAd: (...args) => mockScoreAd(...args),
}));

vi.mock('../utils/angleParser.js', () => ({
  buildStructuredAnglePrompt: (...args) => mockBuildStructuredAnglePrompt(...args),
  hasStructuredBrief: (...args) => mockHasStructuredBrief(...args),
  buildAngleBriefJSON: (...args) => mockBuildAngleBriefJSON(...args),
}));

vi.mock('../services/adGenerator.js', () => ({
  generateImagePrompt: (...args) => mockGenerateImagePrompt(...args),
  regenerateImageOnly: (...args) => mockRegenerateImageOnly(...args),
  repairBodyCopy: (...args) => mockRepairBodyCopy(...args),
}));

function makeAngle(overrides = {}) {
  return {
    externalId: 'angle-1',
    name: 'Wakes to Pee, Then Cannot Fall Back Asleep',
    description: 'Sleep angle',
    prompt_hints: '',
    times_used: 0,
    ...overrides,
  };
}

function makeProject(overrides = {}) {
  return {
    id: 'proj-1',
    externalId: 'proj-1',
    name: 'Heal Naturally',
    brand_name: 'Heal Naturally',
    product_image_storageId: null,
    ...overrides,
  };
}

function makePassingAds(round, count) {
  return Array.from({ length: count }, (_, index) => ({
    ad: {
      id: `round-${round}-pass-${index}`,
      headline: `Headline ${round}-${index}`,
      body_copy: `Body ${round}-${index}`,
    },
    score: {
      ad_id: `round-${round}-pass-${index}`,
      overall_score: 90,
      pass: true,
    },
  }));
}

function makeScoredAds(round, total, passed) {
  return Array.from({ length: total }, (_, index) => ({
    ad: {
      id: `round-${round}-ad-${index}`,
      headline: `Headline ${round}-${index}`,
      body_copy: `Body ${round}-${index}`,
    },
    score: {
      ad_id: `round-${round}-ad-${index}`,
      overall_score: index < passed ? 90 : 40,
      pass: index < passed,
      hard_requirements: { all_passed: index < passed, headline_alignment: index < passed },
      compliance_flags: [],
      spelling_errors: [],
      weaknesses: index < passed ? [] : ['weak hook'],
      strengths: index < passed ? ['clear hook'] : [],
      image_issues: [],
    },
  }));
}

function makeScoreResult(round, total, passed, batch = null) {
  return {
    batch: batch || {
      id: `batch-${round}`,
      pipeline_state: JSON.stringify({
        headline_diagnostics: {
          headline_candidates: total + 4,
          headline_count: total,
          duplicate_rejections: 2,
          history_rejections: 1,
          lane_count: 3,
          lane_distribution: {
            symptom_recognition: Math.max(1, Math.floor(total / 3)),
            failed_solutions: Math.max(1, Math.floor(total / 3)),
            skeptical_confession: Math.max(1, total - (2 * Math.max(1, Math.floor(total / 3)))),
          },
        },
      }),
      gpt_prompts: '[]',
    },
    passingAds: makePassingAds(round, passed),
    scoredAds: makeScoredAds(round, total, passed),
    ads_scored: total,
    ads_passed: passed,
  };
}

async function importConductorEngine() {
  vi.resetModules();
  return import('../services/conductorEngine.js');
}

describe('conductorEngine test-run pipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(global, 'setTimeout').mockImplementation((fn, _ms, ...args) => {
      if (typeof fn === 'function') {
        fn(...args);
      }
      return 0;
    });

    mockUuid
      .mockReturnValueOnce('run-uuid-1')
      .mockReturnValueOnce('batch-uuid-1')
      .mockReturnValueOnce('batch-uuid-2')
      .mockReturnValueOnce('batch-uuid-3');

    mockGetConductorRuns.mockResolvedValue([]);
    mockGetConductorConfig.mockResolvedValue({ enabled: true });
    mockGetProject.mockResolvedValue(makeProject());
    mockGetActiveConductorAngles.mockResolvedValue([makeAngle()]);
    mockGetConductorPlaybook.mockResolvedValue(null);
    mockUpdateConductorAngle.mockResolvedValue();
    mockCreateConductorRun.mockResolvedValue();
    mockUpdateConductorRun.mockResolvedValue();
    mockCreateBatchJob.mockResolvedValue();
    mockRunBatch.mockResolvedValue();
    mockPollBatchJob.mockResolvedValue('completed');
    mockFinalizePassingAds.mockResolvedValue({
      flex_ads_created: 1,
      flex_ad_id: 'flex-123',
      ready_to_post_count: 10,
    });
    mockBuildStructuredAnglePrompt.mockImplementation((angle) => angle.description || angle.name);
    mockHasStructuredBrief.mockReturnValue(false);
    mockBuildAngleBriefJSON.mockReturnValue({ frame: 'symptom-first' });
    mockGetFlexAdsByProject.mockResolvedValue([]);
    mockGetBatchesByProject.mockResolvedValue([]);
    mockGetAllConductorConfigs.mockResolvedValue([]);
    mockGetBatchJob.mockResolvedValue(null);
    mockUpdateBatchJob.mockResolvedValue();
    mockGetAdsByBatchId.mockResolvedValue([]);
    mockGetAd.mockImplementation(async (externalId) => ({
      id: externalId,
      externalId,
      project_id: 'proj-1',
      angle: 'Sleep angle',
      angle_name: 'Wakes to Pee, Then Cannot Fall Back Asleep',
      headline: `Headline for ${externalId}`,
      body_copy: `Body for ${externalId}`,
      storageId: 'storage-1',
      aspect_ratio: '1:1',
    }));
    mockConvexMutation.mockResolvedValue();
    mockTriggerLPGeneration.mockResolvedValue();
    mockGenerateImagePrompt.mockResolvedValue('documentary image prompt');
    mockRegenerateImageOnly.mockResolvedValue({ id: 'repaired-image-ad' });
    mockRepairBodyCopy.mockResolvedValue({ body_copy: 'Repaired body copy with clear CTA.' });
    mockScoreAd.mockResolvedValue({
      ad_id: 'repair-score',
      overall_score: 45,
      pass: false,
      hard_requirements: { all_passed: false, headline_alignment: true, image_completeness: true },
      compliance_flags: [],
      spelling_errors: [],
      weaknesses: ['still weak'],
      strengths: [],
      image_issues: [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts round 2 with 2 ads after a 9/18 first round', async () => {
    mockScoreBatchForInlineFilter
      .mockResolvedValueOnce(makeScoreResult(1, 18, 9))
      .mockResolvedValueOnce(makeScoreResult(2, 2, 1));

    const { runFullTestPipeline } = await importConductorEngine();
    const result = await runFullTestPipeline('proj-1', () => {}, { angleOverride: 'angle-1' });

    expect(result.terminal_status).toBe('deployed');
    expect(mockCreateBatchJob).toHaveBeenCalledTimes(2);
    expect(mockCreateBatchJob.mock.calls[0][0].batch_size).toBe(18);
    expect(mockCreateBatchJob.mock.calls[1][0].batch_size).toBe(2);
  });

  it('starts round 2 with 12 ads after a 4/18 first round', async () => {
    mockScoreBatchForInlineFilter
      .mockResolvedValueOnce(makeScoreResult(1, 18, 4))
      .mockResolvedValueOnce(makeScoreResult(2, 12, 6));

    const { runFullTestPipeline } = await importConductorEngine();
    const result = await runFullTestPipeline('proj-1', () => {}, { angleOverride: 'angle-1' });

    expect(result.terminal_status).toBe('deployed');
    expect(mockCreateBatchJob).toHaveBeenCalledTimes(2);
    expect(mockCreateBatchJob.mock.calls[0][0].batch_size).toBe(18);
    expect(mockCreateBatchJob.mock.calls[1][0].batch_size).toBe(12);
  });

  it('does not fail the run when headline diagnostics extraction throws', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const explodingBatch = new Proxy({}, {
      get() {
        throw new Error('diagnostics blew up');
      },
    });
    mockScoreBatchForInlineFilter.mockResolvedValueOnce(makeScoreResult(1, 18, 10, explodingBatch));

    const { runFullTestPipeline } = await importConductorEngine();
    const result = await runFullTestPipeline('proj-1', () => {}, { angleOverride: 'angle-1' });

    expect(result.terminal_status).toBe('deployed');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to extract headline diagnostics'),
      'diagnostics blew up'
    );
    warnSpy.mockRestore();
  });

  it('does not start another round when repairs push the run to 10 passed ads', async () => {
    const repairableFailures = Array.from({ length: 9 }, (_, index) => ({
      ad: {
        id: `round-1-fail-${index}`,
        headline: `Repairable headline ${index}`,
        body_copy: `Repairable body ${index}`,
        project_id: 'proj-1',
        batch_job_id: 'batch-1',
      },
      score: {
        ad_id: `round-1-fail-${index}`,
        overall_score: 54,
        pass: false,
        hard_requirements: {
          all_passed: false,
          headline_alignment: true,
          first_line_hook: false,
          cta_at_end: true,
          image_completeness: true,
        },
        compliance_flags: [],
        spelling_errors: [],
        weaknesses: ['weak hook'],
        strengths: [],
        image_issues: [],
      },
    }));

    mockScoreBatchForInlineFilter.mockResolvedValueOnce({
      batch: {
        id: 'batch-1',
        pipeline_state: JSON.stringify({}),
        gpt_prompts: '[]',
      },
      passingAds: makePassingAds(1, 9),
      scoredAds: [...makeScoredAds(1, 9, 9), ...repairableFailures],
      ads_scored: 18,
      ads_passed: 9,
    });
    mockScoreAd
      .mockResolvedValueOnce({
        ad_id: 'repair-score-1',
        overall_score: 88,
        pass: true,
        hard_requirements: { all_passed: true, headline_alignment: true, first_line_hook: true, cta_at_end: true, image_completeness: true },
        compliance_flags: [],
        spelling_errors: [],
        weaknesses: [],
        strengths: ['clear hook'],
        image_issues: [],
      })
      .mockResolvedValueOnce({
        ad_id: 'repair-score-2',
        overall_score: 42,
        pass: false,
        hard_requirements: { all_passed: false, headline_alignment: true, first_line_hook: false, cta_at_end: true, image_completeness: true },
        compliance_flags: [],
        spelling_errors: [],
        weaknesses: ['still weak'],
        strengths: [],
        image_issues: [],
      });

    const { runFullTestPipeline } = await importConductorEngine();
    const result = await runFullTestPipeline('proj-1', () => {}, { angleOverride: 'angle-1' });

    expect(result.terminal_status).toBe('deployed');
    expect(result.ads_passed).toBe(10);
    expect(mockCreateBatchJob).toHaveBeenCalledTimes(1);
  });

  it('records post-score failures as orchestration_failed with saved progress', async () => {
    mockScoreBatchForInlineFilter.mockResolvedValueOnce(makeScoreResult(1, 18, 4));
    mockUpdateConductorRun.mockImplementation(async (_id, fields) => {
      if (fields.status === 'running' && fields.decisions?.startsWith('Round 1 complete:')) {
        throw new Error('round progress write failed');
      }
    });

    const { runFullTestPipeline } = await importConductorEngine();
    const result = await runFullTestPipeline('proj-1', () => {}, { angleOverride: 'angle-1' });

    expect(result.pipeline_failed).toBe(true);
    expect(result.terminal_status).toBe('orchestration_failed');
    expect(result.rounds).toHaveLength(1);

    const failureCall = mockUpdateConductorRun.mock.calls.find(([, fields]) => fields.terminal_status === 'orchestration_failed');
    expect(failureCall?.[1]).toMatchObject({
      error_stage: 'persist_round_progress',
      total_ads_generated: 18,
      total_ads_scored: 18,
      total_ads_passed: 4,
      total_rounds: 1,
    });
  });

  it('resumes a completed background round without referencing an undefined batch and triggers LP generation', async () => {
    const runAt = Date.parse('2026-03-07T10:00:00Z');
    mockGetAllConductorConfigs.mockResolvedValue([{ project_id: 'proj-1' }]);
    mockGetConductorRuns.mockResolvedValue([
      {
        externalId: 'run-uuid-1',
        project_id: 'proj-1',
        run_type: 'test',
        run_at: runAt,
        status: 'running',
        batches_created: JSON.stringify([
          { batch_id: 'batch-uuid-1', angle_name: 'Wakes to Pee, Then Cannot Fall Back Asleep', ad_count: 18, round: 1 },
        ]),
        rounds_json: '[]',
        total_ads_generated: 18,
        total_ads_scored: 0,
        total_ads_passed: 0,
        skip_lp_gen: false,
      },
    ]);
    mockGetBatchJob.mockResolvedValue({
      id: 'batch-uuid-1',
      externalId: 'batch-uuid-1',
      status: 'completed',
      angle_name: 'Wakes to Pee, Then Cannot Fall Back Asleep',
      angle_prompt: 'Sleep angle',
      angle_brief: null,
      batch_size: 18,
    });
    mockScoreBatchForInlineFilter.mockResolvedValueOnce(makeScoreResult(1, 18, 10));

    const { resumeBackgroundTestRuns } = await importConductorEngine();
    await resumeBackgroundTestRuns();

    expect(mockTriggerLPGeneration).toHaveBeenCalledWith(
      'batch-uuid-1',
      'proj-1',
      'Wakes to Pee, Then Cannot Fall Back Asleep'
    );

    const completedCall = mockUpdateConductorRun.mock.calls.find(([, fields]) => fields.terminal_status === 'deployed');
    expect(completedCall).toBeTruthy();
  });
});

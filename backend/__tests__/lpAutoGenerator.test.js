import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockUpdateBatchJob = vi.fn();
const mockGetBatchJob = vi.fn();
const mockUpdateFlexAd = vi.fn();
const mockUpdateLandingPage = vi.fn();

vi.mock('../convexClient.js', () => ({
  getLPAgentConfig: vi.fn(),
  getLPTemplatesByProject: vi.fn(),
  createLandingPage: vi.fn(),
  updateLandingPage: (...args) => mockUpdateLandingPage(...args),
  updateBatchJob: (...args) => mockUpdateBatchJob(...args),
  getBatchJob: (...args) => mockGetBatchJob(...args),
  getAdsByBatchId: vi.fn(),
  getProject: vi.fn(),
  getActiveConductorAngles: vi.fn(),
  getRecentLPHeadlineHistoryByAngle: vi.fn(),
  getRecentLPHeadlineHistoryByAngleAndFrame: vi.fn(),
  recordLPHeadlineHistory: vi.fn(),
  updateFlexAd: (...args) => mockUpdateFlexAd(...args),
  uploadBuffer: vi.fn(),
  downloadToBuffer: vi.fn(),
}));

vi.mock('../services/lpGenerator.js', () => ({
  generateAndValidateLP: vi.fn(),
  generateAutoLP: vi.fn(),
  generateSlotImages: vi.fn(),
  preScoreAndRetryImages: vi.fn(),
  scoreGauntletLP: vi.fn(),
  regenerateFailedImages: vi.fn(),
  detectImageMimeType: vi.fn(),
  NARRATIVE_FRAMES: [],
  assembleLandingPage: vi.fn(),
  postProcessLP: vi.fn(),
  repairLPHeadline: vi.fn(),
  getCachedImageContext: vi.fn(),
  getFoundationalDocs: vi.fn(),
}));

vi.mock('../services/lpPublisher.js', () => ({
  publishAndSmokeTest: vi.fn(),
  generateSlug: vi.fn(),
  extractHeadlineForSlug: vi.fn(),
}));

vi.mock('../services/gauntletProgress.js', () => ({
  setProgress: vi.fn(),
  clearProgress: vi.fn(),
}));

describe('lpAutoGenerator batch/flex mirroring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateBatchJob.mockResolvedValue();
    mockUpdateFlexAd.mockResolvedValue();
    mockUpdateLandingPage.mockResolvedValue();
  });

  it('updates the batch job with LP fields', async () => {
    mockGetBatchJob.mockResolvedValue({
      id: 'batch-1',
      externalId: 'batch-1',
      flex_ad_id: 'flex-1',
      lp_primary_url: 'https://lp1.example',
      lp_secondary_url: 'https://lp2.example',
      gauntlet_lp_urls: '[{"url":"https://lp1.example"}]',
    });

    const { updateBatchJobAndMirror } = await import('../services/lpAutoGenerator.js');
    await updateBatchJobAndMirror('batch-1', {
      lp_primary_url: 'https://lp1.example',
      lp_secondary_url: 'https://lp2.example',
      gauntlet_lp_urls: '[{"url":"https://lp1.example"}]',
    });

    expect(mockUpdateBatchJob).toHaveBeenCalledWith('batch-1', {
      lp_primary_url: 'https://lp1.example',
      lp_secondary_url: 'https://lp2.example',
      gauntlet_lp_urls: '[{"url":"https://lp1.example"}]',
    });
  });

  it('mirrors LP fields onto the linked flex ad', async () => {
    mockGetBatchJob.mockResolvedValue({
      id: 'batch-1',
      externalId: 'batch-1',
      flex_ad_id: 'flex-1',
      lp_primary_url: 'https://lp1.example',
      lp_secondary_url: 'https://lp2.example',
      gauntlet_lp_urls: '[{"url":"https://lp1.example"},{"url":"https://lp2.example"}]',
    });

    const { updateBatchJobAndMirror } = await import('../services/lpAutoGenerator.js');
    await updateBatchJobAndMirror('batch-1', {
      lp_primary_status: 'live',
      lp_secondary_status: 'live',
      gauntlet_lp_urls: '[{"url":"https://lp1.example"},{"url":"https://lp2.example"}]',
    });

    expect(mockUpdateFlexAd).toHaveBeenCalledWith('flex-1', {
      lp_primary_url: 'https://lp1.example',
      lp_secondary_url: 'https://lp2.example',
      gauntlet_lp_urls: '[{"url":"https://lp1.example"},{"url":"https://lp2.example"}]',
    });
  });

  it('does not crash when the batch has no linked flex ad', async () => {
    mockGetBatchJob.mockResolvedValue({
      id: 'batch-1',
      externalId: 'batch-1',
      flex_ad_id: null,
      lp_primary_url: 'https://lp1.example',
      lp_secondary_url: '',
      gauntlet_lp_urls: '[{"url":"https://lp1.example"}]',
    });

    const { updateBatchJobAndMirror } = await import('../services/lpAutoGenerator.js');
    await expect(updateBatchJobAndMirror('batch-1', {
      lp_primary_url: 'https://lp1.example',
      gauntlet_lp_urls: '[{"url":"https://lp1.example"}]',
    })).resolves.toMatchObject({ id: 'batch-1', flex_ad_id: null });

    expect(mockUpdateFlexAd).not.toHaveBeenCalled();
  });

  it('falls back to minimal gauntlet score persistence if the compact payload fails', async () => {
    mockUpdateLandingPage
      .mockRejectedValueOnce(new Error('Server Error'))
      .mockResolvedValueOnce();

    const { scorePersistOnly } = await import('../services/lpAutoGenerator.js');
    const result = await scorePersistOnly({
      lpId: 'lp-1',
      lastScore: {
        score: 8,
        reasoning: 'Strong page with one minor weakness.',
        fatal_flaws: [{ type: 'missing_offer', image_position: 'middle' }],
        image_sensibility: 3,
        visual_coherence: 2,
        cta_effectiveness: 2,
        copy_quality: 1,
      },
      passed: true,
      frameResult: { imagePrescoreAttempts: 2 },
      frameDurationMs: 12345,
    });

    expect(result.persistenceMode).toBe('minimal');
    expect(mockUpdateLandingPage).toHaveBeenCalledTimes(2);
    expect(mockUpdateLandingPage).toHaveBeenNthCalledWith(
      1,
      'lp-1',
      expect.not.objectContaining({
        qa_report: expect.anything(),
      }),
    );
    expect(mockUpdateLandingPage).toHaveBeenNthCalledWith(
      2,
      'lp-1',
      expect.objectContaining({
        gauntlet_score: 8,
        gauntlet_status: 'passed',
        qa_status: 'passed',
        qa_score: expect.any(Number),
      }),
    );
  });

  it('stores compact gauntlet score fields without qa_report on the primary path', async () => {
    mockUpdateLandingPage.mockResolvedValueOnce();

    const { scorePersistOnly } = await import('../services/lpAutoGenerator.js');
    const result = await scorePersistOnly({
      lpId: 'lp-2',
      lastScore: {
        score: 9,
        reasoning: 'Clear frame alignment and strong score.',
        fatal_flaws: [],
        image_sensibility: 4,
        visual_coherence: 2,
        cta_effectiveness: 2,
        copy_quality: 1,
      },
      passed: true,
      frameResult: { imagePrescoreAttempts: 1 },
      frameDurationMs: 6789,
    });

    expect(result.persistenceMode).toBe('full');
    expect(mockUpdateLandingPage).toHaveBeenCalledTimes(1);
    expect(mockUpdateLandingPage).toHaveBeenCalledWith(
      'lp-2',
      expect.not.objectContaining({
        qa_report: expect.anything(),
      }),
    );
    expect(mockUpdateLandingPage).toHaveBeenCalledWith(
      'lp-2',
      expect.objectContaining({
        gauntlet_score: 9,
        gauntlet_status: 'passed',
        qa_status: 'passed',
        qa_score: expect.any(Number),
        qa_issues_count: 0,
      }),
    );
  });

  it('omits gauntlet_score when no numeric score exists', async () => {
    mockUpdateLandingPage.mockResolvedValueOnce();

    const { scorePersistOnly } = await import('../services/lpAutoGenerator.js');
    const result = await scorePersistOnly({
      lpId: 'lp-3',
      lastScore: null,
      passed: false,
      frameResult: { imagePrescoreAttempts: 2 },
      frameDurationMs: 4321,
    });

    expect(result.persistenceMode).toBe('full');
    expect(mockUpdateLandingPage).toHaveBeenCalledTimes(1);
    expect(mockUpdateLandingPage).toHaveBeenCalledWith(
      'lp-3',
      expect.not.objectContaining({
        gauntlet_score: null,
      }),
    );
    expect(mockUpdateLandingPage).toHaveBeenCalledWith(
      'lp-3',
      expect.objectContaining({
        gauntlet_status: 'failed',
        qa_status: 'failed',
        qa_score: 0,
      }),
    );
  });
});

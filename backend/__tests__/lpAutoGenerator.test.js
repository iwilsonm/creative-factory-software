import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockUpdateBatchJob = vi.fn();
const mockGetBatchJob = vi.fn();
const mockUpdateFlexAd = vi.fn();

vi.mock('../convexClient.js', () => ({
  getLPAgentConfig: vi.fn(),
  getLPTemplatesByProject: vi.fn(),
  createLandingPage: vi.fn(),
  updateLandingPage: vi.fn(),
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
});

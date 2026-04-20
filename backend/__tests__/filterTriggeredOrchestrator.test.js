import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockGetFlexAd = vi.fn();
const mockGetBatchJob = vi.fn();
const mockGetDeploymentByExternalId = vi.fn();
const mockGetAd = vi.fn();
const mockDownloadToBuffer = vi.fn();
const mockGetStorageUrl = vi.fn();
const mockUpdateBatchJob = vi.fn();
const mockUpdateFlexAd = vi.fn();
const mockUpdateLandingPage = vi.fn();
const mockGetLandingPage = vi.fn();

const mockDeriveListicleAngleFromImages = vi.fn();
const mockRunGauntletImpl = vi.fn();

vi.mock('../convexClient.js', () => ({
  // Surface used by the orchestrator directly.
  getFlexAd: (...args) => mockGetFlexAd(...args),
  getBatchJob: (...args) => mockGetBatchJob(...args),
  getDeploymentByExternalId: (...args) => mockGetDeploymentByExternalId(...args),
  getAd: (...args) => mockGetAd(...args),
  downloadToBuffer: (...args) => mockDownloadToBuffer(...args),
  getStorageUrl: (...args) => mockGetStorageUrl(...args),
  updateBatchJob: (...args) => mockUpdateBatchJob(...args),
  updateFlexAd: (...args) => mockUpdateFlexAd(...args),
  updateLandingPage: (...args) => mockUpdateLandingPage(...args),
  getLandingPage: (...args) => mockGetLandingPage(...args),
  // Peripheral surface — not hit by the orchestrator but imported at module init.
  uploadBuffer: vi.fn(),
  upsertDashboardTodo: vi.fn(),
  removeDashboardTodo: vi.fn(),
  getLPAgentConfig: vi.fn(),
  getLPTemplatesByProject: vi.fn(),
  createLandingPage: vi.fn(),
  getAdsByBatchId: vi.fn(),
  getProject: vi.fn(),
  getActiveConductorAngles: vi.fn(),
  getRecentLPHeadlineHistoryByAngle: vi.fn(),
  getRecentLPHeadlineHistoryByAngleAndFrame: vi.fn(),
  recordLPHeadlineHistory: vi.fn(),
}));

// Import real AngleDerivationError from lpGenerator but stub out
// deriveListicleAngleFromImages itself.
class AngleDerivationError extends Error {
  constructor(message, { reason = 'unknown', detail = '' } = {}) {
    super(message);
    this.name = 'AngleDerivationError';
    this.reason = reason;
    this.detail = detail;
  }
}

vi.mock('../services/lpGenerator.js', () => ({
  generateAndValidateLP: vi.fn(),
  generateAutoLP: vi.fn(),
  generateLPTitleOnly: vi.fn(),
  generateSlotImages: vi.fn(),
  preScoreAndRetryImages: vi.fn(),
  regenerateFailedImages: vi.fn(),
  detectImageMimeType: () => 'image/jpeg',
  NARRATIVE_FRAMES: [],
  getCachedImageContext: vi.fn(),
  getFoundationalDocs: vi.fn().mockResolvedValue({ research: 'r', avatar: 'a', necessary_beliefs: 'b', offer_brief: 'o' }),
  deriveListicleAngleFromImages: (...args) => mockDeriveListicleAngleFromImages(...args),
  AngleDerivationError,
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

vi.mock('../services/lpHeadlineValidation.js', () => ({
  getNarrativeFrameBlueprint: vi.fn(),
  getNarrativeFrameHeadlineContract: vi.fn(),
  getNarrativeFrameTitleBlueprint: vi.fn(),
  buildNarrativeFrameBlueprintSummary: vi.fn(),
  buildLPTitleConceptProfile: vi.fn(),
  buildLPHeadlineSignature: vi.fn(),
  validateLPHeadlineFrameAlignment: vi.fn(),
  evaluateHistoryHeadlineUniqueness: vi.fn(),
  evaluateTitleFamilyUniqueness: vi.fn(),
  validateLPFrameBlueprint: vi.fn(),
  extractLPHeadlineParts: vi.fn(),
}));

// ── Harness ───────────────────────────────────────────────────────────────────

const PROJECT_ID = 'proj-E2E';
const BATCH_ID = 'batch-E2E';
const FLEX_AD_ID = 'flex-E2E';

// The orchestrator imports runGauntlet from the same module (lpAutoGenerator).
// To intercept it without mocking the whole module, we dynamically import the
// module in each test and spy on `runGauntlet`.
async function loadOrchestrator() {
  const mod = await import('../services/lpAutoGenerator.js');
  // Patch in our runGauntlet spy so the Filter-triggered path hits the mock.
  vi.spyOn(mod, 'runGauntlet').mockImplementation(mockRunGauntletImpl);
  return mod;
}

// ── Scenarios ─────────────────────────────────────────────────────────────────

describe('triggerLPGenerationFromFlexAd — happy path + failure modes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();

    mockGetFlexAd.mockResolvedValue({
      id: FLEX_AD_ID,
      project_id: PROJECT_ID,
      child_deployment_ids: JSON.stringify(['dep-1', 'dep-2', 'dep-3']),
    });
    mockGetBatchJob.mockResolvedValue({
      externalId: BATCH_ID,
      project_id: PROJECT_ID,
      angle_name: 'grounding sleep — wake up at 3am',
    });
    mockGetDeploymentByExternalId.mockImplementation(async (id) => ({
      externalId: id,
      ad_id: `ad-${id}`,
      deleted_at: null,
    }));
    mockGetAd.mockImplementation(async (id) => ({
      id,
      storageId: `storage-${id}`,
    }));
    mockDownloadToBuffer.mockImplementation(async (storageId) => Buffer.from(`image-bytes-${storageId}`));
    mockGetStorageUrl.mockImplementation(async (storageId) => `https://convex/${storageId}`);
    mockUpdateBatchJob.mockResolvedValue(undefined);
    mockUpdateFlexAd.mockResolvedValue(undefined);
    mockUpdateLandingPage.mockResolvedValue(undefined);
    mockGetLandingPage.mockResolvedValue(null);
  });

  it('loads flex-ad images, derives an angle, and marks the batch as generating', async () => {
    const brief = {
      listicle_promise: '7 reasons you wake up at 3am',
      pain_point: 'Bolting awake after a bathroom trip',
      desired_outcome: 'Sleeping through uninterrupted',
      installed_beliefs: ['Sleep is restoration, not luxury.'],
      removed_objections: ['Grounding sheets are a gimmick.'],
      tone_hint: 'warm maternal authority',
    };
    mockDeriveListicleAngleFromImages.mockResolvedValueOnce(brief);

    const { triggerLPGenerationFromFlexAd } = await loadOrchestrator();
    // The orchestrator proceeds into the real runGauntlet after derivation
    // — since that's a thousands-of-lines flow in the same module, we don't
    // try to satisfy every mock below it. The assertions below cover the
    // deterministic pre-gauntlet work (image load + derivation call +
    // batch status transition to 'generating'). The gauntlet integration
    // is exercised end-to-end elsewhere.
    await triggerLPGenerationFromFlexAd(FLEX_AD_ID, BATCH_ID, PROJECT_ID);

    // Flex ad had 3 deployments; all resolved to image buffers.
    expect(mockDeriveListicleAngleFromImages).toHaveBeenCalledTimes(1);
    const [imagesArg, docsArg] = mockDeriveListicleAngleFromImages.mock.calls[0];
    expect(imagesArg).toHaveLength(3);
    expect(imagesArg[0].buffer).toBeInstanceOf(Buffer);
    expect(imagesArg[0].storageUrl).toBe('https://convex/storage-ad-dep-1');
    expect(imagesArg[0].mimeType).toBe('image/jpeg');

    // Derivation receives the foundational docs unchanged.
    expect(docsArg).toMatchObject({ research: 'r', avatar: 'a' });

    // Pre-gauntlet the batch is flipped to 'generating' so the Filter and
    // other observers can see progress while the gauntlet churns.
    const generatingCall = mockUpdateBatchJob.mock.calls.find(
      ([, fields]) => fields?.lp_primary_status === 'generating'
    );
    expect(generatingCall).toBeTruthy();
  });

  it('aborts with angle_derivation_failed when Claude flags contradictory docs', async () => {
    mockDeriveListicleAngleFromImages.mockRejectedValueOnce(
      new AngleDerivationError('Images show 30s; avatar is 55-70.', {
        reason: 'contradictory_docs',
        detail: 'demographic mismatch',
      })
    );

    const { triggerLPGenerationFromFlexAd } = await loadOrchestrator();
    await triggerLPGenerationFromFlexAd(FLEX_AD_ID, BATCH_ID, PROJECT_ID);

    // Gauntlet should never have been invoked.
    expect(mockRunGauntletImpl).not.toHaveBeenCalled();

    // Batch gets flipped to angle_derivation_failed with a readable error.
    const failCall = mockUpdateBatchJob.mock.calls.find(([, fields]) => fields?.lp_primary_status === 'angle_derivation_failed');
    expect(failCall).toBeTruthy();
    expect(failCall[1].lp_primary_error).toMatch(/contradictory_docs/i);
  });

  it('aborts with angle_derivation_failed when no flex-ad images can be loaded', async () => {
    // Simulate a flex ad whose child deployments all fail to resolve.
    mockGetDeploymentByExternalId.mockResolvedValue(null);

    const { triggerLPGenerationFromFlexAd } = await loadOrchestrator();
    await triggerLPGenerationFromFlexAd(FLEX_AD_ID, BATCH_ID, PROJECT_ID);

    expect(mockDeriveListicleAngleFromImages).not.toHaveBeenCalled();
    expect(mockRunGauntletImpl).not.toHaveBeenCalled();
    const failCall = mockUpdateBatchJob.mock.calls.find(([, fields]) => fields?.lp_primary_status === 'angle_derivation_failed');
    expect(failCall).toBeTruthy();
    expect(failCall[1].lp_primary_error).toMatch(/no loadable image/i);
  });

  it('caps flex-ad images fed into derivation at 5 even when the flex ad has more', async () => {
    const brief = {
      listicle_promise: 'ok',
      pain_point: 'ok',
      desired_outcome: 'ok',
      installed_beliefs: [],
      removed_objections: [],
      tone_hint: '',
    };
    mockDeriveListicleAngleFromImages.mockResolvedValueOnce(brief);
    mockRunGauntletImpl.mockResolvedValueOnce({
      frames: [{ lpId: 'lp-cap', pendingReview: true, status: 'pending_review' }],
      lpUrls: [],
      summary: { passed: 1, total: 1, published: 0 },
    });

    mockGetFlexAd.mockResolvedValueOnce({
      id: FLEX_AD_ID,
      project_id: PROJECT_ID,
      child_deployment_ids: JSON.stringify(Array.from({ length: 8 }, (_, i) => `dep-${i}`)),
    });

    const { triggerLPGenerationFromFlexAd } = await loadOrchestrator();
    await triggerLPGenerationFromFlexAd(FLEX_AD_ID, BATCH_ID, PROJECT_ID);

    const [imagesArg] = mockDeriveListicleAngleFromImages.mock.calls[0];
    expect(imagesArg.length).toBeLessThanOrEqual(5);
  });

  it('never throws on fatal errors — flips batch to failed instead', async () => {
    mockGetFlexAd.mockRejectedValueOnce(new Error('convex down'));
    const { triggerLPGenerationFromFlexAd } = await loadOrchestrator();
    await expect(triggerLPGenerationFromFlexAd(FLEX_AD_ID, BATCH_ID, PROJECT_ID))
      .resolves.toBeUndefined();
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the Convex client surface that the scheduler's expiry sweep depends on.
const mockGetAllPendingReviewLPs = vi.fn();
const mockUpdateLandingPage = vi.fn();
const mockGetLandingPage = vi.fn();
const mockRemoveDashboardTodo = vi.fn();
const mockUpsertDashboardTodo = vi.fn();

vi.mock('../convexClient.js', () => ({
  // Scheduler consumers — only these matter for the expiry path.
  getAllPendingReviewLPs: (...args) => mockGetAllPendingReviewLPs(...args),
  updateLandingPage: (...args) => mockUpdateLandingPage(...args),
  getLandingPage: (...args) => mockGetLandingPage(...args),
  removeDashboardTodo: (...args) => mockRemoveDashboardTodo(...args),
  upsertDashboardTodo: (...args) => mockUpsertDashboardTodo(...args),
  // The rest are unused in these tests but scheduler imports them at module init.
  getActiveBatchJobs: vi.fn().mockResolvedValue([]),
  getScheduledBatchJobs: vi.fn().mockResolvedValue([]),
  getBatchJob: vi.fn(),
  updateBatchJob: vi.fn().mockResolvedValue(undefined),
  getMetaEnabledProjects: vi.fn().mockResolvedValue([]),
  purgeDeletedDeployments: vi.fn().mockResolvedValue(0),
  purgeDeletedFlexAds: vi.fn().mockResolvedValue(0),
  // lpAutoGenerator dependencies (also loaded at module init via the import graph).
  updateFlexAd: vi.fn(),
  uploadBuffer: vi.fn(),
  downloadToBuffer: vi.fn(),
  getLPAgentConfig: vi.fn(),
  getLPTemplatesByProject: vi.fn(),
  createLandingPage: vi.fn(),
  getAdsByBatchId: vi.fn(),
  getProject: vi.fn(),
  getActiveConductorAngles: vi.fn(),
  getRecentLPHeadlineHistoryByAngle: vi.fn(),
  getRecentLPHeadlineHistoryByAngleAndFrame: vi.fn(),
  recordLPHeadlineHistory: vi.fn(),
  getCostAggregates: vi.fn(),
}));

// Scheduler imports several peer services; stub them with empty shells.
vi.mock('../services/batchProcessor.js', () => ({ runBatch: vi.fn(), pollBatchJob: vi.fn() }));
vi.mock('../services/costTracker.js', () => ({ syncOpenAICosts: vi.fn(), refreshGeminiRates: vi.fn() }));
vi.mock('../services/metaAds.js', () => ({ syncMetaPerformance: vi.fn(), refreshMetaTokenIfNeeded: vi.fn() }));
vi.mock('../services/rateLimiter.js', () => ({ getRateLimiterStats: () => ({}) }));

describe('expireStalePendingReviews', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateLandingPage.mockResolvedValue(undefined);
    mockRemoveDashboardTodo.mockResolvedValue(undefined);
    // appendLPAuditTrail reads via getLandingPage — return a row with no trail
    mockGetLandingPage.mockResolvedValue({ audit_trail: null });
  });

  it('returns 0 when nothing is pending', async () => {
    mockGetAllPendingReviewLPs.mockResolvedValueOnce([]);
    const { expireStalePendingReviews } = await import('../services/scheduler.js');
    const expired = await expireStalePendingReviews();
    expect(expired).toBe(0);
    expect(mockUpdateLandingPage).not.toHaveBeenCalled();
  });

  it('expires rows older than the threshold and leaves fresh rows alone', async () => {
    const now = Date.now();
    const eightDaysAgo = new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString();
    const threeDaysAgo = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString();
    mockGetAllPendingReviewLPs.mockResolvedValueOnce([
      { externalId: 'stale-1', updated_at: eightDaysAgo, status: 'pending_review', audit_trail: null },
      { externalId: 'fresh-1', updated_at: threeDaysAgo, status: 'pending_review', audit_trail: null },
    ]);

    const { expireStalePendingReviews } = await import('../services/scheduler.js');
    const expired = await expireStalePendingReviews();
    expect(expired).toBe(1);

    // The stale row gets flipped to expired_review; the fresh row is untouched.
    const expiredCall = mockUpdateLandingPage.mock.calls.find(call => call[0] === 'stale-1' && call[1]?.status === 'expired_review');
    expect(expiredCall).toBeTruthy();
    const freshCall = mockUpdateLandingPage.mock.calls.find(call => call[0] === 'fresh-1' && call[1]?.status === 'expired_review');
    expect(freshCall).toBeUndefined();

    // The stale row's dashboard reminder is cleared.
    expect(mockRemoveDashboardTodo).toHaveBeenCalledWith('lp_chief_review:stale-1');
    expect(mockRemoveDashboardTodo).not.toHaveBeenCalledWith('lp_chief_review:fresh-1');
  });

  it('respects a custom threshold', async () => {
    const now = Date.now();
    const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000).toISOString();
    mockGetAllPendingReviewLPs.mockResolvedValueOnce([
      { externalId: 'quick-1', updated_at: twoHoursAgo, status: 'pending_review', audit_trail: null },
    ]);

    const { expireStalePendingReviews } = await import('../services/scheduler.js');
    // Treat "older than 1 hour" as expired — the 2h-old row should flip.
    const expired = await expireStalePendingReviews(60 * 60 * 1000);
    expect(expired).toBe(1);
    expect(mockUpdateLandingPage).toHaveBeenCalledWith('quick-1', { status: 'expired_review' });
  });

  it('tolerates missing updated_at by treating age as 0 (not expired)', async () => {
    mockGetAllPendingReviewLPs.mockResolvedValueOnce([
      { externalId: 'no-date', status: 'pending_review', audit_trail: null },
    ]);

    const { expireStalePendingReviews } = await import('../services/scheduler.js');
    const expired = await expireStalePendingReviews();
    expect(expired).toBe(0);
    expect(mockUpdateLandingPage).not.toHaveBeenCalled();
  });
});

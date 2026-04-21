import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';

// ── Mock shims ────────────────────────────────────────────────────────────────

const mockGetLandingPage = vi.fn();
const mockUpdateLandingPage = vi.fn();
const mockPublishToShopify = vi.fn();
const mockUnpublishFromShopify = vi.fn();
const mockVerifyLive = vi.fn();
const mockRemoveDashboardTodo = vi.fn();
const mockUpsertDashboardTodo = vi.fn();

// Every LP in the handler reads audit_trail via getLandingPage, updates it
// via updateLandingPage. Mocking these two is enough — no Convex traffic.
vi.mock('../convexClient.js', () => ({
  getLandingPage: (...args) => mockGetLandingPage(...args),
  updateLandingPage: (...args) => mockUpdateLandingPage(...args),
  getLandingPagesByProject: vi.fn(),
  getProject: vi.fn(),
  getLPAgentConfig: vi.fn(),
  createLandingPage: vi.fn(),
  deleteLandingPage: vi.fn(),
  createLandingPageVersion: vi.fn(),
  getLandingPageVersions: vi.fn(),
  getLandingPageVersion: vi.fn(),
  getStorageUrl: vi.fn(),
  uploadBuffer: vi.fn(),
  getLPTemplate: vi.fn(),
  getDocsByProject: vi.fn(),
  removeDashboardTodo: (...args) => mockRemoveDashboardTodo(...args),
  upsertDashboardTodo: (...args) => mockUpsertDashboardTodo(...args),
  getBatchJob: vi.fn(),
  getFlexAd: vi.fn(),
  getSetting: vi.fn(),
  getCostAggregates: vi.fn(),
  // PEF plan 2026-04-21 — new helpers the route file imports
  countLandingPagesCreatedToday: vi.fn(),
  tryAcquireLPGenerationLock: vi.fn(),
  releaseLPGenerationLock: vi.fn(),
}));

// New services the route file imports (PEF plan 2026-04-21)
vi.mock('../services/lpImageStrategy.js', () => ({
  generateImageConcepts: vi.fn(),
}));
vi.mock('../services/lpImageCandidateGenerator.js', () => ({
  generateImageCandidates: vi.fn(),
}));

vi.mock('../services/lpPublisher.js', () => ({
  publishToShopify: (...args) => mockPublishToShopify(...args),
  unpublishFromShopify: (...args) => mockUnpublishFromShopify(...args),
  verifyLive: (...args) => mockVerifyLive(...args),
}));

// Trim the lpGenerator + lpAutoGenerator surface the routes pull in so we
// never load the real Claude/Gemini wrappers at test-module init.
vi.mock('../services/lpGenerator.js', () => ({
  generateLandingPageCopy: vi.fn(),
  checkDocsReady: vi.fn(),
  // analyzeSwipeDesign deleted per PEF plan 2026-04-21
  generateSlotImages: vi.fn(),
  generateHtmlTemplate: vi.fn(),
  assembleLandingPage: vi.fn(),
  postProcessLP: vi.fn(),
  injectContrastSafetyCSS: vi.fn(),
  ensureMinLightness: vi.fn(),
  enforceBackgroundLightness: vi.fn(),
  extractImageContext: vi.fn(),
  generateAutoLP: vi.fn(),
  runVisualQA: vi.fn(),
  assignBeliefOrObjectionToSlots: vi.fn(),
  NARRATIVE_FRAMES: [],
}));

vi.mock('../services/lpAutoGenerator.js', () => ({
  appendLPAuditTrail: vi.fn(),
  clearChiefReviewTodo: vi.fn(),
  markLPPendingReview: vi.fn(),
  chiefReviewTodoExternalId: (lpId) => `lp_chief_review:${lpId}`,
  triggerLPGenerationFromFlexAd: vi.fn(),
  runGauntlet: vi.fn(),
}));

vi.mock('../services/lpSwipeFetcher.js', () => ({ fetchSwipePage: vi.fn() }));
vi.mock('../services/gemini.js', () => ({ generateImage: vi.fn() }));
vi.mock('../services/retry.js', () => ({ withRetry: (fn) => fn() }));
vi.mock('../auth.js', () => ({
  requireAuth: (req, _res, next) => next(), // handled in the test-side middleware
  requireRole: () => (req, res, next) => {
    const role = req.user?.role;
    if (role !== 'admin' && role !== 'manager') {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  },
}));

// ── Test harness ──────────────────────────────────────────────────────────────

const PROJECT_ID = 'proj-chief';
const PAGE_ID = 'lp-chief';

async function makeApp({ userRole = 'admin' } = {}) {
  // Fake session middleware — populates req.user so requireRole decisions are
  // deterministic. The production mount applies requireAuth + requireRole
  // (admin/manager) in server.js; we replicate that here.
  const { default: router } = await import('../routes/landingPages.js');
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 'user-1', username: 'ian', role: userRole };
    next();
  });
  app.use('/api/projects', router);
  return app;
}

async function hit(app, method, path, body) {
  // Tiny in-process request helper. No supertest dep needed — listen on an
  // ephemeral port, fetch, shut down.
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    let parsed = null;
    try { parsed = await res.json(); } catch { /* non-JSON — leave null */ }
    return { status: res.status, body: parsed };
  } finally {
    server.close();
  }
}

// ── Scenarios ─────────────────────────────────────────────────────────────────

describe('/approve-and-publish', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateLandingPage.mockResolvedValue(undefined);
    mockPublishToShopify.mockResolvedValue({
      published_url: 'https://shop.example.com/pages/lp-abc',
      shopify_page_id: '42',
      shopify_handle: 'lp-abc',
    });
  });

  afterEach(() => { vi.resetModules(); });

  it('401-equivalent for posters via requireRole', async () => {
    mockGetLandingPage.mockResolvedValue({
      externalId: PAGE_ID,
      project_id: PROJECT_ID,
      status: 'pending_review',
      audit_trail: null,
    });
    const app = await makeApp({ userRole: 'poster' });
    const { status, body } = await hit(app, 'POST', `/api/projects/${PROJECT_ID}/landing-pages/${PAGE_ID}/approve-and-publish`);
    expect(status).toBe(403);
    expect(body.error).toMatch(/insufficient/i);
    expect(mockPublishToShopify).not.toHaveBeenCalled();
  });

  it('404 when the LP belongs to a different project', async () => {
    mockGetLandingPage.mockResolvedValue({
      externalId: PAGE_ID,
      project_id: 'different-project',
      status: 'pending_review',
      audit_trail: null,
    });
    const app = await makeApp();
    const { status } = await hit(app, 'POST', `/api/projects/${PROJECT_ID}/landing-pages/${PAGE_ID}/approve-and-publish`);
    expect(status).toBe(404);
    expect(mockPublishToShopify).not.toHaveBeenCalled();
  });

  it('200 idempotent when the LP is already published', async () => {
    mockGetLandingPage.mockResolvedValue({
      externalId: PAGE_ID,
      project_id: PROJECT_ID,
      status: 'published',
      shopify_page_id: '42',
      shopify_handle: 'lp-abc',
      published_url: 'https://shop.example.com/pages/lp-abc',
      audit_trail: null,
    });
    const app = await makeApp();
    const { status, body } = await hit(app, 'POST', `/api/projects/${PROJECT_ID}/landing-pages/${PAGE_ID}/approve-and-publish`);
    expect(status).toBe(200);
    expect(body.already_published).toBe(true);
    expect(body.shopify_page_id).toBe('42');
    expect(mockPublishToShopify).not.toHaveBeenCalled();
  });

  it('409 when a publish is in flight (status=publishing)', async () => {
    mockGetLandingPage.mockResolvedValue({
      externalId: PAGE_ID,
      project_id: PROJECT_ID,
      status: 'publishing',
      audit_trail: null,
    });
    const app = await makeApp();
    const { status } = await hit(app, 'POST', `/api/projects/${PROJECT_ID}/landing-pages/${PAGE_ID}/approve-and-publish`);
    expect(status).toBe(409);
    expect(mockPublishToShopify).not.toHaveBeenCalled();
  });

  it('409 when the LP is not in pending_review (e.g. draft)', async () => {
    mockGetLandingPage.mockResolvedValue({
      externalId: PAGE_ID,
      project_id: PROJECT_ID,
      status: 'draft',
      audit_trail: null,
    });
    const app = await makeApp();
    const { status } = await hit(app, 'POST', `/api/projects/${PROJECT_ID}/landing-pages/${PAGE_ID}/approve-and-publish`);
    expect(status).toBe(409);
  });

  it('200 happy path: sets publishing mutex, calls Shopify, clears dashboard todo', async () => {
    mockGetLandingPage.mockResolvedValue({
      externalId: PAGE_ID,
      project_id: PROJECT_ID,
      status: 'pending_review',
      audit_trail: null,
    });
    const app = await makeApp();
    const { status, body } = await hit(app, 'POST', `/api/projects/${PROJECT_ID}/landing-pages/${PAGE_ID}/approve-and-publish`);
    expect(status).toBe(200);
    expect(body.published_url).toBe('https://shop.example.com/pages/lp-abc');
    expect(mockPublishToShopify).toHaveBeenCalledTimes(1);
    expect(mockPublishToShopify).toHaveBeenCalledWith(PAGE_ID, PROJECT_ID);
    // Mutex transition: status gets set to 'publishing' before the Shopify call.
    const publishingCall = mockUpdateLandingPage.mock.calls.find(c => c[1]?.status === 'publishing');
    expect(publishingCall).toBeTruthy();
  });

  it('500 with rollback to pending_review when Shopify throws', async () => {
    mockGetLandingPage.mockResolvedValue({
      externalId: PAGE_ID,
      project_id: PROJECT_ID,
      status: 'pending_review',
      audit_trail: null,
    });
    mockPublishToShopify.mockRejectedValueOnce(new Error('Shopify 503'));
    const app = await makeApp();
    const { status, body } = await hit(app, 'POST', `/api/projects/${PROJECT_ID}/landing-pages/${PAGE_ID}/approve-and-publish`);
    expect(status).toBe(500);
    expect(body.error).toMatch(/shopify 503/i);
    // Rollback: after the publishing mutex flip + Shopify throw, the status
    // must be put back to pending_review so the user can retry.
    const rollbackCall = mockUpdateLandingPage.mock.calls.find(c => c[1]?.status === 'pending_review');
    expect(rollbackCall).toBeTruthy();
  });
});

describe('/reject-with-notes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateLandingPage.mockResolvedValue(undefined);
  });

  afterEach(() => { vi.resetModules(); });

  it('400 when notes is missing', async () => {
    mockGetLandingPage.mockResolvedValue({
      externalId: PAGE_ID,
      project_id: PROJECT_ID,
      status: 'pending_review',
      audit_trail: null,
    });
    const app = await makeApp();
    const { status } = await hit(app, 'POST', `/api/projects/${PROJECT_ID}/landing-pages/${PAGE_ID}/reject-with-notes`, { notes: '' });
    expect(status).toBe(400);
  });

  it('403 for poster role', async () => {
    const app = await makeApp({ userRole: 'poster' });
    const { status } = await hit(app, 'POST', `/api/projects/${PROJECT_ID}/landing-pages/${PAGE_ID}/reject-with-notes`, { notes: 'Angle drift: off-avatar' });
    expect(status).toBe(403);
  });

  it('409 when the LP is not in pending_review', async () => {
    mockGetLandingPage.mockResolvedValue({
      externalId: PAGE_ID,
      project_id: PROJECT_ID,
      status: 'draft',
      audit_trail: null,
    });
    const app = await makeApp();
    const { status } = await hit(app, 'POST', `/api/projects/${PROJECT_ID}/landing-pages/${PAGE_ID}/reject-with-notes`, { notes: 'abc' });
    expect(status).toBe(409);
  });

  it('200 flips the LP back to draft', async () => {
    mockGetLandingPage.mockResolvedValue({
      externalId: PAGE_ID,
      project_id: PROJECT_ID,
      status: 'pending_review',
      audit_trail: null,
    });
    const app = await makeApp();
    const { status, body } = await hit(app, 'POST', `/api/projects/${PROJECT_ID}/landing-pages/${PAGE_ID}/reject-with-notes`, { notes: 'Angle drift: images show 30s, avatar is 55-70.' });
    expect(status).toBe(200);
    expect(body.success).toBe(true);
    const draftCall = mockUpdateLandingPage.mock.calls.find(c => c[1]?.status === 'draft');
    expect(draftCall).toBeTruthy();
  });
});

describe('/publish guard (Chief Checkpoint)', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.resetModules(); });

  it('400 when /publish is called on a pending_review page', async () => {
    mockGetLandingPage.mockResolvedValue({
      externalId: PAGE_ID,
      project_id: PROJECT_ID,
      status: 'pending_review',
      audit_trail: null,
    });
    const app = await makeApp();
    const { status, body } = await hit(app, 'POST', `/api/projects/${PROJECT_ID}/landing-pages/${PAGE_ID}/publish`);
    expect(status).toBe(400);
    expect(body.error).toMatch(/approve-and-publish/i);
    expect(mockPublishToShopify).not.toHaveBeenCalled();
  });

  it('400 when /publish is called on an expired_review page', async () => {
    mockGetLandingPage.mockResolvedValue({
      externalId: PAGE_ID,
      project_id: PROJECT_ID,
      status: 'expired_review',
      audit_trail: null,
    });
    const app = await makeApp();
    const { status, body } = await hit(app, 'POST', `/api/projects/${PROJECT_ID}/landing-pages/${PAGE_ID}/publish`);
    expect(status).toBe(400);
    expect(body.error).toMatch(/restore/i);
    expect(mockPublishToShopify).not.toHaveBeenCalled();
  });
});

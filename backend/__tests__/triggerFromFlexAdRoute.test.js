import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockGetBatchJob = vi.fn();
const mockGetFlexAd = vi.fn();
const mockGetLPAgentConfig = vi.fn();
const mockGetSetting = vi.fn();
const mockTriggerOrchestrator = vi.fn();

vi.mock('../convexClient.js', () => ({
  getBatchJob: (...args) => mockGetBatchJob(...args),
  getFlexAd: (...args) => mockGetFlexAd(...args),
  getLPAgentConfig: (...args) => mockGetLPAgentConfig(...args),
  getSetting: (...args) => mockGetSetting(...args),
  upsertLPAgentConfig: vi.fn(),
  getLPTemplate: vi.fn(),
  getLPTemplatesByProject: vi.fn(),
  createLandingPage: vi.fn(),
  updateLandingPage: vi.fn(),
  getLandingPagesByProject: vi.fn(),
  uploadBuffer: vi.fn(),
}));

vi.mock('../services/lpAutoGenerator.js', () => ({
  runGauntlet: vi.fn(),
  markLPPendingReview: vi.fn(),
  clearChiefReviewTodo: vi.fn(),
  appendLPAuditTrail: vi.fn(),
  chiefReviewTodoExternalId: (lpId) => `lp_chief_review:${lpId}`,
  triggerLPGenerationFromFlexAd: (...args) => mockTriggerOrchestrator(...args),
}));

vi.mock('../services/retry.js', () => ({ withRetry: (fn) => fn() }));
vi.mock('../services/lpGenerator.js', () => ({
  generateAndValidateLP: vi.fn(),
  NARRATIVE_FRAMES: [],
}));
vi.mock('../services/lpPublisher.js', () => ({
  publishAndSmokeTest: vi.fn(),
  generateSlug: vi.fn(),
  extractHeadlineForSlug: vi.fn(),
}));
vi.mock('../services/gauntletProgress.js', () => ({ getProjectProgress: vi.fn() }));
vi.mock('../utils/sseHelper.js', () => ({ createSSEStream: vi.fn() }));

// ── Harness ───────────────────────────────────────────────────────────────────

const PROJECT_ID = 'proj-flex';
const BATCH_ID = 'batch-flex';
const FLEX_AD_ID = 'flex-1';
const SECRET = 'a'.repeat(64);

async function makeApp() {
  const { filterTriggerRouter } = await import('../routes/lpAgent.js');
  const app = express();
  app.use(express.json());
  // Production mount: filterTriggerRouter is placed BEFORE the requireAuth-
  // protected lpAgentRoutes. In tests we mount it alone, so the only auth
  // path the handler can take is the X-Filter-Secret header (no session).
  app.use('/api/projects', filterTriggerRouter);
  return app;
}

async function hit(app, { headers = {}, body } = {}) {
  const server = app.listen(0);
  const port = server.address().port;
  try {
    const res = await fetch(
      `http://127.0.0.1:${port}/api/projects/${PROJECT_ID}/lp-agent/trigger-from-flex-ad`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body || {}),
      }
    );
    let parsed = null;
    try { parsed = await res.json(); } catch { /* no body */ }
    return { status: res.status, body: parsed };
  } finally {
    server.close();
  }
}

// ── Scenarios ─────────────────────────────────────────────────────────────────

describe('/lp-agent/trigger-from-flex-ad — authorization matrix', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSetting.mockImplementation(async (key) => (key === 'filter_shared_secret' ? SECRET : null));
    mockGetBatchJob.mockResolvedValue({ externalId: BATCH_ID, project_id: PROJECT_ID, angle_name: 'grounding sleep', lp_primary_id: null });
    mockGetFlexAd.mockResolvedValue({ id: FLEX_AD_ID, project_id: PROJECT_ID, child_deployment_ids: '["dep-1","dep-2"]' });
    mockGetLPAgentConfig.mockResolvedValue({ enabled: true });
    mockTriggerOrchestrator.mockResolvedValue(undefined);
  });
  afterEach(() => { vi.resetModules(); });

  it('401 when neither session nor X-Filter-Secret is present', async () => {
    const app = await makeApp();
    const { status } = await hit(app, { body: { batch_id: BATCH_ID, flex_ad_id: FLEX_AD_ID } });
    expect(status).toBe(401);
    expect(mockTriggerOrchestrator).not.toHaveBeenCalled();
  });

  it('401 when X-Filter-Secret is present but wrong', async () => {
    const app = await makeApp();
    const { status } = await hit(app, {
      headers: { 'X-Filter-Secret': 'b'.repeat(64) },
      body: { batch_id: BATCH_ID, flex_ad_id: FLEX_AD_ID },
    });
    expect(status).toBe(401);
    expect(mockTriggerOrchestrator).not.toHaveBeenCalled();
  });

  it('401 when filter_shared_secret is unset on the backend', async () => {
    mockGetSetting.mockResolvedValueOnce(null);
    const app = await makeApp();
    const { status } = await hit(app, {
      headers: { 'X-Filter-Secret': SECRET },
      body: { batch_id: BATCH_ID, flex_ad_id: FLEX_AD_ID },
    });
    expect(status).toBe(401);
  });

  it('401 when the secret length differs (timing-safe guard)', async () => {
    const app = await makeApp();
    const { status } = await hit(app, {
      headers: { 'X-Filter-Secret': 'short' },
      body: { batch_id: BATCH_ID, flex_ad_id: FLEX_AD_ID },
    });
    expect(status).toBe(401);
  });

  it('202 accepted when the X-Filter-Secret matches', async () => {
    const app = await makeApp();
    const { status, body } = await hit(app, {
      headers: { 'X-Filter-Secret': SECRET },
      body: { batch_id: BATCH_ID, flex_ad_id: FLEX_AD_ID },
    });
    expect(status).toBe(202);
    expect(body.accepted).toBe(true);
    expect(mockTriggerOrchestrator).toHaveBeenCalledWith(FLEX_AD_ID, BATCH_ID, PROJECT_ID);
  });
});

describe('/lp-agent/trigger-from-flex-ad — input validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSetting.mockImplementation(async (key) => (key === 'filter_shared_secret' ? SECRET : null));
    mockGetBatchJob.mockResolvedValue({ externalId: BATCH_ID, project_id: PROJECT_ID, lp_primary_id: null });
    mockGetFlexAd.mockResolvedValue({ id: FLEX_AD_ID, project_id: PROJECT_ID });
    mockGetLPAgentConfig.mockResolvedValue({ enabled: true });
  });
  afterEach(() => { vi.resetModules(); });

  const authHeaders = { 'X-Filter-Secret': SECRET };

  it('400 when batch_id is missing', async () => {
    const app = await makeApp();
    const { status } = await hit(app, { headers: authHeaders, body: { flex_ad_id: FLEX_AD_ID } });
    expect(status).toBe(400);
  });

  it('400 when flex_ad_id is missing', async () => {
    const app = await makeApp();
    const { status } = await hit(app, { headers: authHeaders, body: { batch_id: BATCH_ID } });
    expect(status).toBe(400);
  });

  it('404 when the batch is not in the given project', async () => {
    mockGetBatchJob.mockResolvedValueOnce({ externalId: BATCH_ID, project_id: 'other-project' });
    const app = await makeApp();
    const { status } = await hit(app, { headers: authHeaders, body: { batch_id: BATCH_ID, flex_ad_id: FLEX_AD_ID } });
    expect(status).toBe(404);
  });

  it('404 when the flex ad is not in the given project', async () => {
    mockGetFlexAd.mockResolvedValueOnce({ id: FLEX_AD_ID, project_id: 'other-project' });
    const app = await makeApp();
    const { status } = await hit(app, { headers: authHeaders, body: { batch_id: BATCH_ID, flex_ad_id: FLEX_AD_ID } });
    expect(status).toBe(404);
  });

  it('409 (idempotent) when batch.lp_primary_id is already set', async () => {
    mockGetBatchJob.mockResolvedValueOnce({ externalId: BATCH_ID, project_id: PROJECT_ID, lp_primary_id: 'existing-lp' });
    const app = await makeApp();
    const { status, body } = await hit(app, { headers: authHeaders, body: { batch_id: BATCH_ID, flex_ad_id: FLEX_AD_ID } });
    expect(status).toBe(409);
    expect(body.lp_id).toBe('existing-lp');
  });

  it('202 with skipped=true when the LP Agent is disabled for the project', async () => {
    mockGetLPAgentConfig.mockResolvedValueOnce({ enabled: false });
    const app = await makeApp();
    const { status, body } = await hit(app, { headers: authHeaders, body: { batch_id: BATCH_ID, flex_ad_id: FLEX_AD_ID } });
    expect(status).toBe(202);
    expect(body.skipped).toBe(true);
  });
});

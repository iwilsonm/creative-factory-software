import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockOpenAIChat = vi.fn();
const mockAnthropicChat = vi.fn();
const mockGetProject = vi.fn();
const mockGetLatestDoc = vi.fn();
const mockCreateAdSet = vi.fn();
const mockCreateDeploymentDuplicate = vi.fn();
const mockUpdateDeployment = vi.fn();
const mockGetAd = vi.fn();
const mockGetAdSetsByProject = vi.fn();
const mockEnsureDefaultCampaign = vi.fn();
const mockGetActiveConductorAngles = vi.fn();

vi.mock('../services/openai.js', () => ({
  chat: (...args) => mockOpenAIChat(...args),
}));

vi.mock('../services/anthropic.js', () => ({
  chat: (...args) => mockAnthropicChat(...args),
  chatWithImage: vi.fn(),
  extractJSON: (text) => {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  },
}));

vi.mock('../services/headlineDiversity.js', () => ({
  filterHeadlineCandidatePool: vi.fn((items) => ({ survivors: items })),
  selectDiverseHeadlines: vi.fn((items, limit) => ({ selected: items.slice(0, limit) })),
}));

vi.mock('../services/autoPostGate.js', () => ({
  evaluateAutoPostGate: vi.fn(() => ({ allowed: false, reason: 'disabled' })),
}));

vi.mock('../services/metaWriter.js', () => ({
  postAdSetToMeta: vi.fn(),
}));

vi.mock('../convexClient.js', () => ({
  getProject: (...args) => mockGetProject(...args),
  getLatestDoc: (...args) => mockGetLatestDoc(...args),
  getBatchJob: vi.fn(),
  updateBatchJob: vi.fn(),
  getAdsByBatchId: vi.fn(),
  getAd: (...args) => mockGetAd(...args),
  downloadToBuffer: vi.fn(),
  createAdSet: (...args) => mockCreateAdSet(...args),
  createDeploymentDuplicate: (...args) => mockCreateDeploymentDuplicate(...args),
  updateDeployment: (...args) => mockUpdateDeployment(...args),
  convexClient: {},
  api: {},
  updateAdSet: vi.fn(),
  getAdSetsByProject: (...args) => mockGetAdSetsByProject(...args),
  getConductorConfig: vi.fn(),
  getActiveConductorAngles: (...args) => mockGetActiveConductorAngles(...args),
  ensureDefaultCampaign: (...args) => mockEnsureDefaultCampaign(...args),
  setFilterVerdict: vi.fn(),
  upsertConductorConfig: vi.fn(),
  createAutoPostLog: vi.fn(),
}));

function makePassedAd(index, score = 8 + index / 10) {
  return {
    ad: {
      id: `ad-${index}`,
      project_id: 'project-1',
      headline: `Approved headline ${index}`,
      body_copy: `Approved primary text ${index}. Tap the button to learn more.`,
      angle: 'Selected test angle',
    },
    score: {
      pass: true,
      overall_score: score,
      angle_category: 'Selected test angle',
    },
  };
}

function setupFinalizeMocks() {
  mockGetProject.mockResolvedValue({
    id: 'project-1',
    name: 'Heal Naturally',
    brand_name: 'Heal Naturally',
    default_campaign_id: 'campaign-1',
  });
  mockGetLatestDoc.mockResolvedValue({ content: 'doc context' });
  mockGetAd.mockImplementation((id) => Promise.resolve({
    id,
    headline: `Approved headline ${id}`,
    angle: 'Selected test angle',
  }));
  mockGetAdSetsByProject.mockResolvedValue([]);
  mockEnsureDefaultCampaign.mockResolvedValue('campaign-1');
  mockGetActiveConductorAngles.mockResolvedValue([]);
  mockCreateAdSet.mockResolvedValue(undefined);
  mockCreateDeploymentDuplicate.mockResolvedValue(undefined);
  mockUpdateDeployment.mockResolvedValue(undefined);
  mockAnthropicChat.mockImplementation((messages, model, options = {}) => {
    if (options.operation === 'filter_group_ads_fallback') {
      return Promise.resolve('not json');
    }
    if (options.operation === 'filter_primary_text_generation') {
      return Promise.resolve(JSON.stringify({
        primary_texts: ['Primary 1', 'Primary 2', 'Primary 3', 'Primary 4', 'Primary 5'],
      }));
    }
    if (options.operation === 'filter_headline_generation') {
      return Promise.resolve(JSON.stringify({
        headlines: ['Headline 1', 'Headline 2', 'Headline 3', 'Headline 4', 'Headline 5', 'Headline 6', 'Headline 7'],
      }));
    }
    return Promise.resolve('{}');
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockOpenAIChat.mockResolvedValue('not json');
  setupFinalizeMocks();
});

describe('Creative Filter approved-ad grouping', () => {
  it('creates a Ready-to-Post ad set for target 1 when the grouping model returns no usable group', async () => {
    const { finalizePassingAds } = await import('../services/creativeFilterService.js');

    const result = await finalizePassingAds({
      passingAds: [makePassedAd(1)],
      projectId: 'project-1',
      batchId: 'batch-1',
      postingDay: 'test',
      angleName: 'Selected test angle',
      targetCount: 1,
    });

    expect(result.flex_ads_created).toBe(1);
    expect(result.ready_to_post_count).toBe(1);
    expect(mockCreateAdSet).toHaveBeenCalledWith(expect.objectContaining({
      lifecycle_status: 'ready',
      ready_source: 'creative_director',
    }));
    expect(mockCreateDeploymentDuplicate).toHaveBeenCalledTimes(1);
  });

  it('fills missing grouped image IDs from approved ads before deployment', async () => {
    mockOpenAIChat.mockResolvedValueOnce(JSON.stringify({
      flex_ads: [
        {
          angle_theme: 'Selected test angle',
          image_ad_ids: ['ad-2'],
          headlines: [],
          primary_texts: [],
        },
      ],
    }));
    const { finalizePassingAds } = await import('../services/creativeFilterService.js');

    const result = await finalizePassingAds({
      passingAds: [makePassedAd(1, 8.1), makePassedAd(2, 8.9)],
      projectId: 'project-1',
      batchId: 'batch-1',
      postingDay: 'test',
      angleName: 'Selected test angle',
      targetCount: 2,
    });

    expect(result.flex_ads_created).toBe(1);
    expect(result.ready_to_post_count).toBe(2);
    expect(mockCreateDeploymentDuplicate).toHaveBeenCalledTimes(2);
    const deployedAdIds = mockCreateDeploymentDuplicate.mock.calls.map(([payload]) => payload.ad_id);
    expect(deployedAdIds.sort()).toEqual(['ad-1', 'ad-2']);
  });

  it('returns a specific copy error when final Ready-to-Post copy cannot meet minimums', async () => {
    mockAnthropicChat.mockImplementation((messages, model, options = {}) => {
      if (options.operation === 'filter_group_ads_fallback') return Promise.resolve('not json');
      if (options.operation === 'filter_primary_text_generation') {
        return Promise.resolve(JSON.stringify({ primary_texts: ['Only one primary text'] }));
      }
      if (options.operation === 'filter_headline_generation') {
        return Promise.resolve(JSON.stringify({ headlines: ['Headline 1', 'Headline 2', 'Headline 3'] }));
      }
      return Promise.resolve('{}');
    });
    const { finalizePassingAds } = await import('../services/creativeFilterService.js');

    const result = await finalizePassingAds({
      passingAds: [makePassedAd(1)],
      projectId: 'project-1',
      batchId: 'batch-1',
      postingDay: 'test',
      angleName: 'Selected test angle',
      targetCount: 1,
    });

    expect(result.flex_ads_created).toBe(0);
    expect(result.copy_error).toContain('Final copy generation failed');
    expect(mockCreateAdSet).not.toHaveBeenCalled();
  });
});

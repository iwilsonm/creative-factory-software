import { normalizeArrayFields, normalizeArrayResponse } from './utils/collections';

const API_BASE = '/api';

// Shared error path for non-OK responses across all fetch wrappers.
// Vercel's gateway returns plain-text bodies for 413 (Request Entity Too Large) before
// the function runs, so JSON parsing must be tolerant.
async function throwForResponseError(res) {
  if (res.status === 413) {
    throw new Error('Request body too large. Please reduce image size.');
  }
  let err;
  try {
    err = await res.json();
  } catch {
    err = { error: `HTTP ${res.status}` };
  }
  throw new Error(err.error || `Request failed with ${res.status}`);
}

async function request(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers
    },
    ...options
  });

  if (res.status === 401 && !path.includes('/auth/')) {
    window.location.href = '/login';
    throw new Error('Not authenticated');
  }

  if (!res.ok) {
    await throwForResponseError(res);
  }

  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error('Invalid response from server');
  }
  return data;
}

/**
 * Stream SSE from a POST endpoint (no body).
 * @param {string} path - API path
 * @param {(event: object) => void} onEvent - Called for each parsed SSE event
 * @returns {{ abort: () => void, done: Promise<void> }}
 */
function streamSSE(path, onEvent) {
  const controller = new AbortController();

  const done = (async () => {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal
    });

    if (!res.ok) {
      await throwForResponseError(res);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done: readerDone, value } = await reader.read();
      if (readerDone) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') return;
          try {
            onEvent(JSON.parse(data));
          } catch {}
        }
      }
    }
  })();

  return { abort: () => controller.abort(), done };
}

/**
 * Stream SSE from a POST endpoint with a JSON body.
 * Same as streamSSE but sends request body (needed for manual research submission).
 * @param {string} path - API path
 * @param {object} body - JSON body to send
 * @param {(event: object) => void} onEvent - Called for each parsed SSE event
 * @returns {{ abort: () => void, done: Promise<void> }}
 */
function streamSSEWithBody(path, body, onEvent) {
  const controller = new AbortController();

  const done = (async () => {
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!res.ok) {
      await throwForResponseError(res);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done: readerDone, value } = await reader.read();
      if (readerDone) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6);
          if (data === '[DONE]') return;
          try {
            onEvent(JSON.parse(data));
          } catch {}
        }
      }
    }
  })();

  return { abort: () => controller.abort(), done };
}

// ─── Request Cache (tiered TTLs) ──────────────────────────────────────────────
// Caches read-only GET responses so back-navigation doesn't re-fetch.
// Mutations invalidate related entries immediately.
const _requestCache = new Map();

// Per-path TTLs — longer for data that rarely changes mid-session
function _getCacheTTL(path) {
  if (path === '/auth/session') return 5 * 60 * 1000;    // 5 min
  if (path === '/projects/options') return 2 * 60 * 1000; // 2 min
  if (path === '/projects') return 2 * 60 * 1000;         // 2 min
  if (path.match(/^\/projects\/[^/]+$/)) return 2 * 60 * 1000; // 2 min
  if (path === '/conductor/pipeline-status') return 30 * 1000; // 30s
  if (path.match(/^\/deployments/)) return 60 * 1000;     // 1 min
  if (path.match(/^\/conductor\//)) return 2 * 60 * 1000; // 2 min
  if (path.match(/^\/costs/)) return 2 * 60 * 1000;       // 2 min
  if (path.match(/\/landing-pages$/)) return 2 * 60 * 1000; // 2 min
  return 30 * 1000; // 30s default
}

function cachedRequest(path) {
  const cached = _requestCache.get(path);
  if (cached && Date.now() - cached.time < _getCacheTTL(path)) return Promise.resolve(cached.data);
  return request(path).then(data => {
    _requestCache.set(path, { data, time: Date.now() });
    return data;
  });
}

function invalidateCache(...paths) {
  for (const p of paths) _requestCache.delete(p);
}

// Exported for use by components after SSE completions (e.g., doc generation)
export function invalidateProjectCache(projectId) {
  invalidateCache('/projects', `/projects/${projectId}`, `/projects/${projectId}/stats`);
}

export const api = {
  // Auth
  getSession: () => cachedRequest('/auth/session'),
  setup: (username, password) => request('/auth/setup', { method: 'POST', body: JSON.stringify({ username, password }) }),
  login: (username, password) => request('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }).then(r => { invalidateCache('/auth/session'); return r; }),
  logout: () => request('/auth/logout', { method: 'POST' }).then(r => { _requestCache.clear(); localStorage.removeItem('auth_state'); return r; }),
  changePassword: (currentPassword, newPassword) => request('/auth/password', { method: 'PUT', body: JSON.stringify({ currentPassword, newPassword }) }),

  // User Management (admin only)
  getUsers: () => request('/users'),
  createUser: (data) => request('/users', { method: 'POST', body: JSON.stringify(data) }),
  updateUser: (id, data) => request(`/users/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  resetUserPassword: (id, newPassword) => request(`/users/${id}/reset-password`, { method: 'PUT', body: JSON.stringify({ newPassword }) }),
  deleteUser: (id) => request(`/users/${id}`, { method: 'DELETE' }),

  // Projects
  getProjects: () =>
    cachedRequest('/projects').then(data => normalizeArrayResponse(data, 'projects', 'api.getProjects.projects').projects),
  getProjectOptions: () =>
    cachedRequest('/projects/options').then(data => normalizeArrayResponse(data, 'projects', 'api.getProjectOptions.projects')),
  getProject: (id) => cachedRequest(`/projects/${id}`),
  getProjectStats: (id) => request(`/projects/${id}/stats`),
  createProject: (data) => request('/projects', { method: 'POST', body: JSON.stringify(data) }).then(r => { invalidateCache('/projects', '/projects/options'); return r; }),
  updateProject: (id, data) => request(`/projects/${id}`, { method: 'PUT', body: JSON.stringify(data) }).then(r => { invalidateCache('/projects', '/projects/options', `/projects/${id}`); return r; }),
  deleteProject: (id) => request(`/projects/${id}`, { method: 'DELETE' }).then(r => { invalidateCache('/projects', '/projects/options', `/projects/${id}`); return r; }),

  // Foundational Documents
  getDocs: (projectId) => request(`/projects/${projectId}/docs`),
  updateDoc: (projectId, docId, content) => request(`/projects/${projectId}/docs/${docId}`, { method: 'PUT', body: JSON.stringify({ content }) }),
  approveDoc: (projectId, docId) => request(`/projects/${projectId}/docs/${docId}/approve`, { method: 'PUT' }),

  // Research prompts for manual research flow
  getResearchPrompts: (projectId) => request(`/projects/${projectId}/research-prompts`),

  // Direct upload of foundational documents (bypass generation entirely)
  uploadDocs: (projectId, docs) => request(`/projects/${projectId}/upload-docs`, { method: 'POST', body: JSON.stringify({ docs }) }),

  // Copy Correction — find and fix inaccurate info in docs
  correctDocs: (projectId, correction) =>
    request(`/projects/${projectId}/correct-docs`, { method: 'POST', body: JSON.stringify({ correction }) }),
  applyCorrections: (projectId, corrections, correctionText) =>
    request(`/projects/${projectId}/apply-corrections`, { method: 'POST', body: JSON.stringify({ corrections, correction_text: correctionText }) }),
  getCorrectionHistory: (projectId) =>
    request(`/projects/${projectId}/correction-history`),
  revertCorrection: (projectId, correctionId) =>
    request(`/projects/${projectId}/revert-correction`, { method: 'POST', body: JSON.stringify({ correction_id: correctionId }) }),

  // SSE streams — returns an abort controller, calls onEvent for each SSE message
  generateDocs: (projectId, onEvent) => streamSSE(`/projects/${projectId}/generate-docs`, onEvent),
  regenerateDoc: (projectId, docType, onEvent) => streamSSE(`/projects/${projectId}/generate-doc/${docType}`, onEvent),
  generateDocsManual: (projectId, researchContent, onEvent) =>
    streamSSEWithBody(`/projects/${projectId}/generate-docs-manual`, { researchContent }, onEvent),

  // Upload & extraction
  extractText: async (file) => {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch(`${API_BASE}/upload/extract-text`, {
      method: 'POST',
      credentials: 'include',
      body: formData
      // No Content-Type header — browser sets multipart boundary automatically
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Upload failed with ${res.status}`);
    return data;
  },
  autoDescribe: (salesPageContent) => request('/upload/auto-describe', { method: 'POST', body: JSON.stringify({ sales_page_content: salesPageContent }) }),
  fetchSalesPageFromUrl: (url) => request('/upload/fetch-url', { method: 'POST', body: JSON.stringify({ url }) }),

  // Google Drive
  driveStatus: () => request('/drive/status'),
  driveUploadServiceAccount: (content) => request('/drive/upload-service-account', { method: 'POST', body: JSON.stringify({ content }) }),
  driveTest: () => request('/drive/test', { method: 'POST' }),
  driveFolders: (parentId) => request(`/drive/folders${parentId ? `?parentId=${parentId}` : ''}`),
  driveFolderInfo: (folderId) => request(`/drive/folders/${folderId}`),

  // Inspiration Folder
  getInspirationImages: (projectId) =>
    request(`/projects/${projectId}/inspiration`).then(data => normalizeArrayResponse(data, 'images', 'api.getInspirationImages.images')),
  syncInspiration: (projectId) => request(`/projects/${projectId}/inspiration/sync`, { method: 'POST' }),

  // Template Images
  getTemplates: (projectId) =>
    request(`/projects/${projectId}/templates`).then(data => normalizeArrayResponse(data, 'templates', 'api.getTemplates.templates')),
  uploadTemplate: async (projectId, file, descriptionOrOptions = '') => {
    // Backwards-compatible: 3rd arg may be a string (legacy `description`) or an options object `{ description, signal }`.
    const opts = typeof descriptionOrOptions === 'string'
      ? { description: descriptionOrOptions }
      : (descriptionOrOptions || {});
    const { description = '', signal } = opts;
    const formData = new FormData();
    formData.append('image', file);
    if (description) formData.append('description', description);
    const res = await fetch(`${API_BASE}/projects/${projectId}/templates`, {
      method: 'POST',
      credentials: 'include',
      body: formData,
      signal
    });
    let data;
    try {
      data = await res.json();
    } catch {
      // Vercel gateway 413 (request too large) returns non-JSON before the function runs.
      if (res.status === 413) throw new Error('too large for upload (server limit)');
      if (!res.ok) throw new Error(`Upload failed with ${res.status}`);
      throw new Error('Invalid response from server');
    }
    if (!res.ok) throw new Error(data.error || `Upload failed with ${res.status}`);
    return data;
  },
  updateTemplate: (projectId, imageId, description) =>
    request(`/projects/${projectId}/templates/${imageId}`, { method: 'PUT', body: JSON.stringify({ description }) }),
  deleteTemplate: (projectId, imageId) =>
    request(`/projects/${projectId}/templates/${imageId}`, { method: 'DELETE' }),
  analyzeTemplate: (projectId, templateId, force = false) =>
    request(`/projects/${projectId}/templates/${templateId}/analyze`, {
      method: 'POST',
      body: JSON.stringify({ force })
    }),

  // Project Product Image
  uploadProductImage: async (projectId, file) => {
    const formData = new FormData();
    formData.append('image', file);
    const res = await fetch(`${API_BASE}/projects/${projectId}/product-image`, {
      method: 'POST',
      credentials: 'include',
      body: formData
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Upload failed with ${res.status}`);
    return data;
  },
  deleteProductImage: (projectId) =>
    request(`/projects/${projectId}/product-image`, { method: 'DELETE' }),

  // Ad Generation
  generateAd: (projectId, options, onEvent) =>
    streamSSEWithBody(`/projects/${projectId}/generate-ad`, options, onEvent),
  regenerateImage: (projectId, options, onEvent) =>
    streamSSEWithBody(`/projects/${projectId}/regenerate-image`, options, onEvent),
  editPrompt: (projectId, originalPrompt, editInstruction, referenceImage, referenceImageMime) =>
    request(`/projects/${projectId}/edit-prompt`, {
      method: 'POST',
      body: JSON.stringify({
        original_prompt: originalPrompt,
        edit_instruction: editInstruction,
        ...(referenceImage ? { reference_image: referenceImage, reference_image_mime: referenceImageMime } : {})
      })
    }),
  getAds: (projectId) =>
    request(`/projects/${projectId}/ads`).then(data => normalizeArrayResponse(data, 'ads', 'api.getAds.ads')),
  getInProgressAds: (projectId) => request(`/projects/${projectId}/ads/in-progress`),
  getAd: (projectId, adId) => request(`/projects/${projectId}/ads/${adId}`),
  deleteAd: (projectId, adId) =>
    request(`/projects/${projectId}/ads/${adId}`, { method: 'DELETE' }),
  updateAdTags: (projectId, adId, tags) =>
    request(`/projects/${projectId}/ads/${adId}/tags`, { method: 'PATCH', body: JSON.stringify({ tags }) }),
  toggleAdFavorite: (projectId, adId, isFavorite) =>
    request(`/projects/${projectId}/ads/${adId}/favorite`, { method: 'PATCH', body: JSON.stringify({ is_favorite: isFavorite }) }),

  // Batch Jobs
  getBatches: (projectId) => request(`/projects/${projectId}/batches`),
  getBatch: (projectId, batchId) => request(`/projects/${projectId}/batches/${batchId}`),
  createBatch: (projectId, data) => request(`/projects/${projectId}/batches`, { method: 'POST', body: JSON.stringify(data) }),
  updateBatch: (projectId, batchId, data) => request(`/projects/${projectId}/batches/${batchId}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteBatch: (projectId, batchId) => request(`/projects/${projectId}/batches/${batchId}`, { method: 'DELETE' }),
  runBatch: (projectId, batchId) => request(`/projects/${projectId}/batches/${batchId}/run`, { method: 'POST' }),
  cancelBatch: (projectId, batchId) => request(`/projects/${projectId}/batches/${batchId}/cancel`, { method: 'POST' }),

  // Costs
  getCosts: () => cachedRequest('/costs'),
  getProjectCosts: (projectId) => cachedRequest(`/projects/${projectId}/costs`),
  getCostHistory: (days = 30, projectId) => {
    let url = `/costs/history?days=${days}`;
    if (projectId) url += `&project_id=${projectId}`;
    return cachedRequest(url);
  },
  getCostHistoryRange: (startDate, endDate, projectId) => {
    const params = new URLSearchParams({ start: startDate, end: endDate });
    if (projectId) params.set('project_id', projectId);
    return cachedRequest(`/costs/history?${params.toString()}`);
  },
  getRecurringCosts: () => cachedRequest('/costs/recurring'),
  getCostRates: () => cachedRequest('/costs/rates'),
  syncCosts: () => request('/costs/sync', { method: 'POST' }),
  getAgentCosts: (days = 30) => request(`/costs/agents?days=${days}`),

  // Settings
  getSettings: () => request('/settings'),
  updateSettings: (data) => request('/settings', { method: 'PUT', body: JSON.stringify(data) }),
  testOpenAI: () => request('/settings/test-openai', { method: 'POST' }),
  testGemini: () => request('/settings/test-gemini', { method: 'POST' }),
  // Phase 2 (PEF item G) — verify a specific OpenAI chat model is available.
  testOpenAIModel: (model) =>
    request('/settings/test-model', {
      method: 'POST',
      body: JSON.stringify({ model }),
      headers: { 'Content-Type': 'application/json' },
    }),
  testDrive: () => request('/settings/test-drive', { method: 'POST' }),
  refreshGeminiRates: () => request('/settings/refresh-gemini-rates', { method: 'POST' }),

  // Dashboard Todos
  getTodos: () => cachedRequest('/settings/todos'),
  saveTodos: (todos) => request('/settings/todos', { method: 'PUT', body: JSON.stringify({ todos }) }).then(r => { invalidateCache('/settings/todos'); return r; }),

  // Conductor (Dacia Creative Director)
  getConductorConfig: (projectId) => cachedRequest(`/conductor/config/${projectId}`),
  updateConductorConfig: (projectId, data) => request(`/conductor/config/${projectId}`, { method: 'PUT', body: JSON.stringify(data) }).then(r => { invalidateCache(`/conductor/config/${projectId}`, '/conductor/pipeline-status'); return r; }),
  getAllConductorConfigs: () => cachedRequest('/conductor/configs'),

  getConductorAngles: (projectId) =>
    cachedRequest(`/conductor/angles/${projectId}`).then(data => normalizeArrayResponse(data, 'angles', 'api.getConductorAngles.angles')),
  getConductorActiveAngles: (projectId) =>
    cachedRequest(`/conductor/angles/${projectId}/active`).then(data => normalizeArrayResponse(data, 'angles', 'api.getConductorActiveAngles.angles')),
  createConductorAngle: (projectId, data) => request(`/conductor/angles/${projectId}`, { method: 'POST', body: JSON.stringify(data) }).then(r => { invalidateCache(`/conductor/angles/${projectId}`, `/conductor/angles/${projectId}/active`); return r; }),
  updateConductorAngle: (projectId, angleId, data) => request(`/conductor/angles/${projectId}/${angleId}`, { method: 'PUT', body: JSON.stringify(data) }).then(r => { invalidateCache(`/conductor/angles/${projectId}`, `/conductor/angles/${projectId}/active`); return r; }),
  deleteConductorAngle: (projectId, angleId) => request(`/conductor/angles/${projectId}/${angleId}`, { method: 'DELETE' }).then(r => { invalidateCache(`/conductor/angles/${projectId}`, `/conductor/angles/${projectId}/active`); return r; }),
  getConductorRuns: (projectId, limit) =>
    request(`/conductor/runs/${projectId}${limit ? `?limit=${limit}` : ''}`).then(data => normalizeArrayResponse(data, 'runs', 'api.getConductorRuns.runs')),
  triggerConductorRun: (projectId) => request(`/conductor/run/${projectId}`, { method: 'POST' }),
  triggerConductorTestRun: (projectId, body, onEvent) => streamSSEWithBody(`/conductor/test-run/${projectId}`, body, onEvent),
  getTestRunProgress: (projectId) => request(`/conductor/test-run/progress/${projectId}`),
  cancelTestRun: (projectId) => request(`/conductor/test-run/cancel/${projectId}`, { method: 'POST' }),
  getConductorPlaybooks: (projectId) =>
    cachedRequest(`/conductor/playbooks/${projectId}`).then(data => normalizeArrayResponse(data, 'playbooks', 'api.getConductorPlaybooks.playbooks')),
  getConductorPlaybook: (projectId, angleName) => request(`/conductor/playbooks/${projectId}/${encodeURIComponent(angleName)}`),
  triggerLearningStep: (projectId, angleName, scoredAds) => request('/conductor/learn', { method: 'POST', body: JSON.stringify({ projectId, angleName, scoredAds }) }),
  getConductorPipelineStatus: () => cachedRequest('/conductor/pipeline-status'),
  getConductorHealth: (limit) => request(`/conductor/health${limit ? `?limit=${limit}` : ''}`),
  getFixerPlaybooks: () => request('/conductor/fixer-playbooks'),

  // Phase 2A — Meta integration
  initMetaOAuth: (projectId) =>
    request('/meta/oauth/init', { method: 'POST', body: JSON.stringify({ projectId }) }),
  getMetaConnectionStatus: (projectId) =>
    request(`/meta/connection-status?projectId=${projectId}`),
  getMetaAdAccounts: (projectId) =>
    request(`/meta/ad-accounts?projectId=${projectId}`).then(d => d?.accounts ?? []),
  selectMetaAdAccount: (projectId, payload) =>
    request('/meta/select-account', { method: 'POST', body: JSON.stringify({ projectId, ...payload }) }),
  setMetaIntegrationPath: (projectId, path) =>
    request('/meta/integration-path', { method: 'POST', body: JSON.stringify({ projectId, path }) }),
  disconnectMeta: (projectId) =>
    request('/meta/disconnect', { method: 'POST', body: JSON.stringify({ projectId }) }),
  getMetaCampaigns: (projectId) =>
    request(`/meta/campaigns?projectId=${projectId}`).then(d => d?.campaigns ?? []),
  // Phase 2B
  getMetaPages: (projectId) =>
    request(`/meta/pages?projectId=${projectId}`).then(d => d?.pages ?? []),
  selectMetaPage: (projectId, payload) =>
    request('/meta/select-page', { method: 'POST', body: JSON.stringify({ projectId, ...payload }) }),
  postAdSetToMeta: (projectId, adSetId) =>
    request(`/projects/${projectId}/staging/adsets/${adSetId}/post-to-meta`, { method: 'POST' }),

  // Phase 1 — Staging Page
  getStagingPending: (projectId) =>
    request(`/projects/${projectId}/staging/pending`).then(data => data?.groups ?? []),
  getStagingRejected: (projectId) =>
    request(`/projects/${projectId}/staging/rejected`).then(data => data?.ads ?? []),
  getStagingPromoted: (projectId) =>
    request(`/projects/${projectId}/staging/promoted`).then(data => data?.adSets ?? []),
  updateAdSetMetaSettings: (projectId, adSetId, fields) =>
    request(`/projects/${projectId}/staging/adsets/${adSetId}/meta-settings`, { method: 'PUT', body: JSON.stringify(fields) }),
  promoteAdSet: (projectId, adSetId) =>
    request(`/projects/${projectId}/staging/adsets/${adSetId}/promote`, { method: 'POST' }),
  regroupAds: (projectId, adIds, targetAdSetId) =>
    request(`/projects/${projectId}/staging/regroup`, { method: 'POST', body: JSON.stringify({ adIds, targetAdSetId }) }),
  createEmptyAdSet: (projectId, body) =>
    request(`/projects/${projectId}/staging/adsets/new`, { method: 'POST', body: JSON.stringify(body) }),
  forcePromoteAd: (projectId, adId) =>
    request(`/projects/${projectId}/ads/${adId}/force-promote`, { method: 'POST' }),

  // Agent Monitor (Dacia Fixer — Agent #1)
  getAgentMonitorStatus: () => request('/agent-monitor/status'),
  runAgentFixer: () => request('/agent-monitor/run', { method: 'POST' }),
  runAgentResurrect: () => request('/agent-monitor/resurrect', { method: 'POST' }),
  toggleFixerPause: () => request('/agent-monitor/pause', { method: 'POST' }),
  // Agent Monitor (Dacia Creative Filter — Agent #2)
  getFilterStatus: () => request('/agent-monitor/filter/status'),
  runFilterDryRun: () => request('/agent-monitor/filter/run', { method: 'POST' }),
  runFilterLive: () => request('/agent-monitor/filter/run-live', { method: 'POST' }),
  toggleFilterPause: () => request('/agent-monitor/filter/pause', { method: 'POST' }),
  getFilterVolumes: () =>
    request('/agent-monitor/filter/volumes').then(data => normalizeArrayResponse(data, 'projects', 'api.getFilterVolumes.projects')),
  updateFilterVolume: (projectId, value) => request(`/agent-monitor/filter/volumes/${projectId}`, { method: 'PUT', body: JSON.stringify({ scout_daily_flex_ads: value }) }),

  // Performance Tracker / Deployments
  getDeployments: () =>
    cachedRequest('/deployments').then(data => normalizeArrayResponse(data, 'deployments', 'api.getDeployments.deployments')),
  getProjectDeployments: (projectId) => cachedRequest(`/deployments?projectId=${projectId}`),
  createDeployments: (adIds) => request('/deployments', { method: 'POST', body: JSON.stringify({ adIds }) }),
  updateDeployment: (id, fields) => request(`/deployments/${id}`, { method: 'PUT', body: JSON.stringify(fields) }),
  updateDeploymentStatus: (id, status) => request(`/deployments/${id}/status`, { method: 'PUT', body: JSON.stringify({ status }) }),
  updateDeploymentPostedBy: (id, posted_by) => request(`/deployments/${id}/posted-by`, { method: 'PUT', body: JSON.stringify({ posted_by }) }),
  deleteDeployment: (id) => request(`/deployments/${id}`, { method: 'DELETE' }),
  restoreDeployment: (id) => request(`/deployments/${id}/restore`, { method: 'POST' }),
  getDeletedDeployments: (projectId) => request(`/deployments/deleted${projectId ? `?projectId=${projectId}` : ''}`),
  renameAllDeployments: () => request('/deployments/rename-all', { method: 'POST' }),
  backfillHeadlines: () => request('/deployments/backfill-headlines', { method: 'POST' }),

  // Campaigns & Ad Sets (local organization)
  getCampaigns: (projectId) =>
    request(`/deployments/campaigns?projectId=${projectId}`).then(data =>
      normalizeArrayFields(data, {
        campaigns: 'api.getCampaigns.campaigns',
        adSets: 'api.getCampaigns.adSets',
      })
    ),
  createCampaign: (projectId, name) => request('/deployments/campaigns', { method: 'POST', body: JSON.stringify({ projectId, name }) }),
  updateCampaign: (id, fields) => request(`/deployments/campaigns/${id}`, { method: 'PUT', body: JSON.stringify(fields) }),
  deleteCampaign: (id) => request(`/deployments/campaigns/${id}`, { method: 'DELETE' }),
  createAdSet: (campaignId, name, projectId) => request(`/deployments/campaigns/${campaignId}/adsets`, { method: 'POST', body: JSON.stringify({ name, projectId }) }),
  updateAdSet: (id, fields) => request(`/deployments/adsets/${id}`, { method: 'PUT', body: JSON.stringify(fields) }),
  deleteAdSet: (id) => request(`/deployments/adsets/${id}`, { method: 'DELETE' }),
  moveToUnplanned: (deploymentIds) => request('/deployments/move-to-unplanned', { method: 'POST', body: JSON.stringify({ deploymentIds }) }),
  assignToAdSet: (deploymentIds, campaignId, adsetId) => request('/deployments/assign-to-adset', { method: 'POST', body: JSON.stringify({ deploymentIds, campaignId, adsetId }) }),
  unassignFromAdSet: (deploymentIds) => request('/deployments/unassign', { method: 'POST', body: JSON.stringify({ deploymentIds }) }),

  // Duplicate
  duplicateDeployment: (id, overrides) => request(`/deployments/${id}/duplicate`, { method: 'POST', body: JSON.stringify({ overrides }) }),

  // Flex Ads
  getFlexAds: (projectId) =>
    request(`/deployments/flex-ads?projectId=${projectId}`).then(data => normalizeArrayResponse(data, 'flexAds', 'api.getFlexAds.flexAds')),
  getFlexAdCount: (projectId, angleName) => request(`/deployments/flex-ads/count?projectId=${projectId}${angleName ? `&angleName=${encodeURIComponent(angleName)}` : ''}`),
  createFlexAd: (projectId, adSetId, name, deploymentIds) =>
    request('/deployments/flex-ads', { method: 'POST', body: JSON.stringify({ projectId, adSetId, name, deploymentIds }) }),
  updateFlexAd: (id, fields) =>
    request(`/deployments/flex-ads/${id}`, { method: 'PUT', body: JSON.stringify(fields) }),
  updateFlexAdPostedBy: (id, posted_by) =>
    request(`/deployments/flex-ads/${id}/posted-by`, { method: 'PUT', body: JSON.stringify({ posted_by }) }),
  deleteFlexAd: (id) =>
    request(`/deployments/flex-ads/${id}`, { method: 'DELETE' }),
  restoreFlexAd: (id) =>
    request(`/deployments/flex-ads/${id}/restore`, { method: 'POST' }),

  // Primary Text & Headline Generation (sidebar)
  generatePrimaryText: (deploymentId, flexAdId, direction, messages) =>
    request(`/deployments/${deploymentId}/generate-primary-text`, { method: 'POST', body: JSON.stringify({ flexAdId, direction, messages }) }),
  generateAdHeadlines: (deploymentId, primaryTexts, flexAdId, direction, messages) =>
    request(`/deployments/${deploymentId}/generate-ad-headlines`, { method: 'POST', body: JSON.stringify({ primaryTexts, flexAdId, direction, messages }) }),

  // Ad Studio — inline generation helpers for composing a single ad
  generateAdAngle: (projectId) =>
    request(`/projects/${projectId}/generate-angle`, { method: 'POST' }),
  generateAdHeadline: (projectId, { angle }) =>
    request(`/projects/${projectId}/generate-headline`, {
      method: 'POST',
      body: JSON.stringify({ angle: angle || undefined })
    }),
  generateAdBodyCopy: (projectId, { headline, angle, style }) =>
    request(`/projects/${projectId}/generate-body-copy`, {
      method: 'POST',
      body: JSON.stringify({ headline, angle, style: style || 'short' })
    }),

  // Settings — API-key connectivity tests
  testAnthropic: () => request('/settings/test-anthropic', { method: 'POST' }),

  // ────────────────────────────────────────────────
  // Phase 5 — Analytics tab
  // ────────────────────────────────────────────────
  getAnalyticsCampaigns: (projectId, opts = {}) => {
    const qs = new URLSearchParams(Object.entries(opts).filter(([, v]) => v != null && v !== '')).toString();
    return request(`/projects/${projectId}/analytics/campaigns${qs ? `?${qs}` : ''}`);
  },
  getAnalyticsAdSets: (projectId, opts = {}) => {
    const qs = new URLSearchParams(Object.entries(opts).filter(([, v]) => v != null && v !== '')).toString();
    return request(`/projects/${projectId}/analytics/adsets${qs ? `?${qs}` : ''}`);
  },
  getAnalyticsAds: (projectId, opts = {}) => {
    const qs = new URLSearchParams(Object.entries(opts).filter(([, v]) => v != null && v !== '')).toString();
    return request(`/projects/${projectId}/analytics/ads${qs ? `?${qs}` : ''}`);
  },

  // Tags CRUD
  getTags: (projectId) => request(`/projects/${projectId}/tags`),
  createTag: (projectId, { name, color }) =>
    request(`/projects/${projectId}/tags`, { method: 'POST', body: JSON.stringify({ name, color }) }),
  updateTag: (projectId, tagId, { name, color }) =>
    request(`/projects/${projectId}/tags/${tagId}`, { method: 'PUT', body: JSON.stringify({ name, color }) }),
  deleteTag: (projectId, tagId) =>
    request(`/projects/${projectId}/tags/${tagId}`, { method: 'DELETE' }),

  // Tag assignments
  getTagAssignments: (projectId, entityType) =>
    request(`/projects/${projectId}/tags/assignments?entity_type=${encodeURIComponent(entityType)}`),
  applyTag: (projectId, { tag_id, entity_type, entity_id, entity_id_kind = 'meta' }) =>
    request(`/projects/${projectId}/tags/assignments`, {
      method: 'POST',
      body: JSON.stringify({ tag_id, entity_type, entity_id, entity_id_kind }),
    }),
  removeTagAssignment: (projectId, { tag_id, entity_id, entity_type }) =>
    request(`/projects/${projectId}/tags/assignments`, {
      method: 'DELETE',
      body: JSON.stringify({ tag_id, entity_id, entity_type }),
    }),

  // Saved views
  getSavedViews: (projectId) => request(`/projects/${projectId}/analytics/views`),
  createSavedView: (projectId, { name, scope, level, config }) =>
    request(`/projects/${projectId}/analytics/views`, {
      method: 'POST',
      body: JSON.stringify({ name, scope, level, config }),
    }),
  updateSavedView: (projectId, viewId, updates) =>
    request(`/projects/${projectId}/analytics/views/${viewId}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    }),
  deleteSavedView: (projectId, viewId) =>
    request(`/projects/${projectId}/analytics/views/${viewId}`, { method: 'DELETE' }),

  // ────────────────────────────────────────────────
  // Phase 3 — Observation, benchmark, archive
  // ────────────────────────────────────────────────
  getObservationConfig: (projectId) => request(`/projects/${projectId}/observation/config`),
  updateObservationConfig: (projectId, body) =>
    request(`/projects/${projectId}/observation/config`, { method: 'PUT', body: JSON.stringify(body) }),
  suggestObservationDefaults: (projectId) =>
    request(`/projects/${projectId}/observation/suggest`, { method: 'POST' }),

  getObservationAdSets: (projectId) =>
    request(`/projects/${projectId}/observation/ad-sets`),
  getObservationAdSet: (projectId, adSetId) =>
    request(`/projects/${projectId}/observation/ad-sets/${adSetId}`),
  refreshObservationSnapshot: (projectId, adSetId) =>
    request(`/projects/${projectId}/observation/ad-sets/${adSetId}/snapshot`, { method: 'POST' }),
  markObservation: (projectId, adSetId, { verdict, reason }) =>
    request(`/projects/${projectId}/observation/ad-sets/${adSetId}/mark`, {
      method: 'POST',
      body: JSON.stringify({ verdict, reason }),
    }),
  pauseObservation: (projectId, adSetId) =>
    request(`/projects/${projectId}/observation/ad-sets/${adSetId}/pause`, { method: 'POST' }),
  resumeObservation: (projectId, adSetId) =>
    request(`/projects/${projectId}/observation/ad-sets/${adSetId}/resume`, { method: 'POST' }),
  extendObservation: (projectId, adSetId, additional_days) =>
    request(`/projects/${projectId}/observation/ad-sets/${adSetId}/extend`, {
      method: 'POST',
      body: JSON.stringify({ additional_days }),
    }),

  getObservationHealth: (projectId) =>
    request(`/projects/${projectId}/observation/health`),

  getArchivedAngles: (projectId) =>
    request(`/projects/${projectId}/angles/archived`),
  archiveAngle: (projectId, angleId, reason) =>
    request(`/projects/${projectId}/angles/${angleId}/archive`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  unarchiveAngle: (projectId, angleId) =>
    request(`/projects/${projectId}/angles/${angleId}/unarchive`, { method: 'POST' }),

  // Admin
  runObservationCron: (dryRun = false) =>
    request(`/admin/observation/cron-run${dryRun ? '?dry_run=1' : ''}`, { method: 'POST' }),
  getLastObservationCron: () => request('/admin/observation/last-cron'),
};

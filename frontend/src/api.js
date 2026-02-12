const API_BASE = '/api';

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

  let data;
  try {
    data = await res.json();
  } catch {
    if (!res.ok) {
      throw new Error(`Request failed with ${res.status}`);
    }
    throw new Error('Invalid response from server');
  }
  if (!res.ok) {
    throw new Error(data.error || `Request failed with ${res.status}`);
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
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error || `Request failed with ${res.status}`);
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
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error || `Request failed with ${res.status}`);
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

export const api = {
  // Auth
  getSession: () => request('/auth/session'),
  setup: (username, password) => request('/auth/setup', { method: 'POST', body: JSON.stringify({ username, password }) }),
  login: (username, password) => request('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  changePassword: (currentPassword, newPassword) => request('/auth/password', { method: 'PUT', body: JSON.stringify({ currentPassword, newPassword }) }),

  // Projects
  getProjects: () => request('/projects'),
  getProject: (id) => request(`/projects/${id}`),
  createProject: (data) => request('/projects', { method: 'POST', body: JSON.stringify(data) }),
  updateProject: (id, data) => request(`/projects/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteProject: (id) => request(`/projects/${id}`, { method: 'DELETE' }),

  // Foundational Documents
  getDocs: (projectId) => request(`/projects/${projectId}/docs`),
  updateDoc: (projectId, docId, content) => request(`/projects/${projectId}/docs/${docId}`, { method: 'PUT', body: JSON.stringify({ content }) }),
  approveDoc: (projectId, docId) => request(`/projects/${projectId}/docs/${docId}/approve`, { method: 'PUT' }),

  // Research prompts for manual research flow
  getResearchPrompts: (projectId) => request(`/projects/${projectId}/research-prompts`),

  // Direct upload of foundational documents (bypass generation entirely)
  uploadDocs: (projectId, docs) => request(`/projects/${projectId}/upload-docs`, { method: 'POST', body: JSON.stringify({ docs }) }),

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

  // Google Drive
  driveStatus: () => request('/drive/status'),
  driveUploadServiceAccount: (content) => request('/drive/upload-service-account', { method: 'POST', body: JSON.stringify({ content }) }),
  driveTest: () => request('/drive/test', { method: 'POST' }),
  driveFolders: (parentId) => request(`/drive/folders${parentId ? `?parentId=${parentId}` : ''}`),
  driveFolderInfo: (folderId) => request(`/drive/folders/${folderId}`),

  // Inspiration Folder
  getInspirationImages: (projectId) => request(`/projects/${projectId}/inspiration`),
  syncInspiration: (projectId) => request(`/projects/${projectId}/inspiration/sync`, { method: 'POST' }),

  // Template Images
  getTemplates: (projectId) => request(`/projects/${projectId}/templates`),
  uploadTemplate: async (projectId, file, description = '') => {
    const formData = new FormData();
    formData.append('image', file);
    if (description) formData.append('description', description);
    const res = await fetch(`${API_BASE}/projects/${projectId}/templates`, {
      method: 'POST',
      credentials: 'include',
      body: formData
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Upload failed with ${res.status}`);
    return data;
  },
  updateTemplate: (projectId, imageId, description) =>
    request(`/projects/${projectId}/templates/${imageId}`, { method: 'PUT', body: JSON.stringify({ description }) }),
  deleteTemplate: (projectId, imageId) =>
    request(`/projects/${projectId}/templates/${imageId}`, { method: 'DELETE' }),

  // Ad Generation
  generateAd: (projectId, options, onEvent) =>
    streamSSEWithBody(`/projects/${projectId}/generate-ad`, options, onEvent),
  regenerateImage: (projectId, options, onEvent) =>
    streamSSEWithBody(`/projects/${projectId}/regenerate-image`, options, onEvent),
  getAds: (projectId) => request(`/projects/${projectId}/ads`),
  getAd: (projectId, adId) => request(`/projects/${projectId}/ads/${adId}`),
  deleteAd: (projectId, adId) =>
    request(`/projects/${projectId}/ads/${adId}`, { method: 'DELETE' }),

  // Batch Jobs
  getBatches: (projectId) => request(`/projects/${projectId}/batches`),
  getBatch: (projectId, batchId) => request(`/projects/${projectId}/batches/${batchId}`),
  createBatch: (projectId, data) => request(`/projects/${projectId}/batches`, { method: 'POST', body: JSON.stringify(data) }),
  updateBatch: (projectId, batchId, data) => request(`/projects/${projectId}/batches/${batchId}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteBatch: (projectId, batchId) => request(`/projects/${projectId}/batches/${batchId}`, { method: 'DELETE' }),
  runBatch: (projectId, batchId) => request(`/projects/${projectId}/batches/${batchId}/run`, { method: 'POST' }),
  cancelBatch: (projectId, batchId) => request(`/projects/${projectId}/batches/${batchId}/cancel`, { method: 'POST' }),

  // Costs
  getCosts: () => request('/costs'),
  getProjectCosts: (projectId) => request(`/projects/${projectId}/costs`),
  getCostHistory: (days = 30, projectId) => {
    let url = `/costs/history?days=${days}`;
    if (projectId) url += `&project_id=${projectId}`;
    return request(url);
  },
  getRecurringCosts: () => request('/costs/recurring'),
  syncCosts: () => request('/costs/sync', { method: 'POST' }),

  // Settings
  getSettings: () => request('/settings'),
  updateSettings: (data) => request('/settings', { method: 'PUT', body: JSON.stringify(data) }),
  testOpenAI: () => request('/settings/test-openai', { method: 'POST' }),
  testGemini: () => request('/settings/test-gemini', { method: 'POST' }),
  testDrive: () => request('/settings/test-drive', { method: 'POST' }),
  refreshGeminiRates: () => request('/settings/refresh-gemini-rates', { method: 'POST' })
};

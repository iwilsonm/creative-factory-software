import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getProject: vi.fn(),
  getProjectSummaries: vi.fn(),
  getArchivedProjectSummaries: vi.fn(),
  getProjectOptions: vi.fn(),
  updateProject: vi.fn(),
  archiveProject: vi.fn(),
  unarchiveProject: vi.fn(),
  getProjectStats: vi.fn(),
  uploadBuffer: vi.fn(),
  getStorageUrl: vi.fn(),
  setProjectProductImage: vi.fn(),
  createProjectWithTemplateSeeding: vi.fn(),
}));

vi.mock('../auth.js', () => ({
  requireAuth: (req, res, next) => {
    req.user = { id: 'user-1', username: 'admin', role: 'admin', displayName: 'Admin' };
    next();
  },
  requireRole: () => (req, res, next) => next(),
}));

vi.mock('../convexClient.js', () => ({
  getProject: mocks.getProject,
  getProjectSummaries: mocks.getProjectSummaries,
  getArchivedProjectSummaries: mocks.getArchivedProjectSummaries,
  getProjectOptions: mocks.getProjectOptions,
  updateProject: mocks.updateProject,
  archiveProject: mocks.archiveProject,
  unarchiveProject: mocks.unarchiveProject,
  getProjectStats: mocks.getProjectStats,
  uploadBuffer: mocks.uploadBuffer,
  getStorageUrl: mocks.getStorageUrl,
  setProjectProductImage: mocks.setProjectProductImage,
}));

vi.mock('../services/projectCreation.js', () => ({
  createProjectWithTemplateSeeding: mocks.createProjectWithTemplateSeeding,
}));

const { default: projectRoutes } = await import('../routes/projects.js');

function activeProject(id) {
  return {
    id,
    name: `Project ${id}`,
    brand_name: `Brand ${id}`,
    status: 'docs_ready',
    archived_at: null,
    adCount: 1,
    docCount: 1,
  };
}

function archivedProject(id, archivedAt) {
  return {
    ...activeProject(id),
    archived_at: archivedAt,
  };
}

async function request(method, path, body) {
  const app = express();
  app.use(express.json());
  app.use('/api/projects', projectRoutes);
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    return { status: res.status, data };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('project archive routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps active and archived project lists separate', async () => {
    mocks.getProjectSummaries.mockResolvedValue([
      activeProject('active-1'),
      activeProject('active-2'),
      activeProject('active-3'),
    ]);
    mocks.getArchivedProjectSummaries.mockResolvedValue([
      archivedProject('archived-1', '2026-05-06T10:00:00.000Z'),
      archivedProject('archived-2', '2026-05-05T10:00:00.000Z'),
    ]);

    const active = await request('GET', '/api/projects');
    const archived = await request('GET', '/api/projects/archived');

    expect(active.status).toBe(200);
    expect(active.data).toHaveLength(3);
    expect(active.data.every((project) => project.archived_at === null)).toBe(true);
    expect(archived.status).toBe(200);
    expect(archived.data.projects).toHaveLength(2);
    expect(archived.data.projects.every((project) => project.archived_at)).toBe(true);
  });

  it('archives and unarchives projects through reversible archived_at updates', async () => {
    mocks.getProject
      .mockResolvedValueOnce(activeProject('project-1'))
      .mockResolvedValueOnce(archivedProject('project-1', '2026-05-06T10:00:00.000Z'))
      .mockResolvedValueOnce(archivedProject('project-1', '2026-05-06T10:00:00.000Z'))
      .mockResolvedValueOnce(activeProject('project-1'));
    mocks.archiveProject.mockResolvedValue();
    mocks.unarchiveProject.mockResolvedValue();

    const archived = await request('PATCH', '/api/projects/project-1/archive');
    const restored = await request('PATCH', '/api/projects/project-1/unarchive');

    expect(archived.status).toBe(200);
    expect(archived.data.project.archived_at).toBe('2026-05-06T10:00:00.000Z');
    expect(mocks.archiveProject).toHaveBeenCalledWith('project-1');
    expect(restored.status).toBe(200);
    expect(restored.data.project.archived_at).toBeNull();
    expect(mocks.unarchiveProject).toHaveBeenCalledWith('project-1');
  });

  it('maps legacy DELETE to archive and leaves child data untouched', async () => {
    const childAds = [{ id: 'ad-1', project_id: 'project-with-children' }];
    mocks.getProject
      .mockResolvedValueOnce({ ...activeProject('project-with-children'), childAds })
      .mockResolvedValueOnce({ ...archivedProject('project-with-children', '2026-05-06T10:00:00.000Z'), childAds });
    mocks.archiveProject.mockResolvedValue();

    const response = await request('DELETE', '/api/projects/project-with-children');

    expect(response.status).toBe(200);
    expect(response.data.project.childAds).toEqual(childAds);
    expect(mocks.archiveProject).toHaveBeenCalledWith('project-with-children');
    expect(mocks.updateProject).not.toHaveBeenCalled();
    expect(mocks.getProjectStats).not.toHaveBeenCalled();
  });
});

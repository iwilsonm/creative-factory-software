import { describe, expect, it } from 'vitest';
import {
  buildTemplateProvenanceResolver,
  createTemplateSeeder,
  selectTemplatesToSeed,
} from '../services/templateAdoption.js';
import { createProjectCreationService } from '../services/projectCreation.js';

function template(overrides) {
  return {
    externalId: overrides.externalId,
    project_id: overrides.project_id,
    filename: overrides.filename || `${overrides.externalId}.png`,
    storageId: overrides.storageId,
    description: overrides.description || '',
    tags: overrides.tags || [],
    archived_at: overrides.archived_at ?? null,
    analysis: overrides.analysis || '',
    source_template_id: overrides.source_template_id,
    source_project_id: overrides.source_project_id,
    source_storage_id: overrides.source_storage_id,
  };
}

function makeSeederHarness({ projects, templatesByProject }) {
  const created = [];
  const updates = [];
  const storage = new Map();
  let copyCounter = 0;

  for (const rows of templatesByProject.values()) {
    for (const row of rows) {
      if (row.storageId) storage.set(String(row.storageId), Buffer.from(`source:${row.storageId}`));
    }
  }

  const seeder = createTemplateSeeder({
    getProjectOptions: async () => projects,
    getTemplateImagesByProject: async (projectId) => templatesByProject.get(projectId) || [],
    updateProject: async (projectId, fields) => updates.push({ projectId, ...fields }),
    downloadToBuffer: async (storageId) => {
      const buffer = storage.get(String(storageId));
      if (!buffer) throw new Error(`missing storage ${storageId}`);
      return buffer;
    },
    uploadBuffer: async (buffer) => {
      const storageId = `copy-${++copyCounter}`;
      storage.set(storageId, Buffer.from(buffer));
      return storageId;
    },
    createTemplate: async (args) => {
      created.push(args);
      const existing = templatesByProject.get(args.project_id) || [];
      templatesByProject.set(args.project_id, [...existing, args]);
    },
    uuidv4: () => `new-template-${copyCounter + 1}`,
    invalidateQueryCache: () => {},
    console: { warn: () => {} },
  });

  return { seeder, created, updates, storage };
}

describe('template inheritance seeding', () => {
  it('seeds zero templates and still marks the project complete', async () => {
    const targetId = 'target';
    const { seeder, created, updates } = makeSeederHarness({
      projects: [{ id: targetId }],
      templatesByProject: new Map([[targetId, []]]),
    });

    const result = await seeder(targetId);

    expect(result).toMatchObject({ copied: 0, failed: [], status: 'complete' });
    expect(created).toHaveLength(0);
    expect(updates.at(0)).toMatchObject({ projectId: targetId, template_seeding_status: 'in_progress' });
    expect(updates.at(-1)).toMatchObject({ projectId: targetId, template_seeding_status: 'complete' });
  });

  it('dedupes the same source storage across three source projects', async () => {
    const templatesByProject = new Map([
      ['source-a', [template({ externalId: 'a1', project_id: 'source-a', storageId: 'shared-storage' })]],
      ['source-b', [template({ externalId: 'b1', project_id: 'source-b', storageId: 'shared-storage' })]],
      ['source-c', [template({ externalId: 'c1', project_id: 'source-c', storageId: 'shared-storage' })]],
      ['target', []],
    ]);
    const { seeder, created } = makeSeederHarness({
      projects: [{ id: 'source-a' }, { id: 'source-b' }, { id: 'source-c' }, { id: 'target' }],
      templatesByProject,
    });

    const result = await seeder('target');

    expect(result.copied).toBe(1);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      project_id: 'target',
      source_storage_id: 'shared-storage',
      source_template_id: 'a1',
    });
    expect(created[0].storageId).not.toBe('shared-storage');
  });

  it('copies every distinct source storage id', async () => {
    const templatesByProject = new Map([
      ['source-a', [
        template({ externalId: 'a1', project_id: 'source-a', storageId: 'storage-1' }),
        template({ externalId: 'a2', project_id: 'source-a', storageId: 'storage-2' }),
      ]],
      ['source-b', [template({ externalId: 'b1', project_id: 'source-b', storageId: 'storage-3' })]],
      ['target', []],
    ]);
    const { seeder, created } = makeSeederHarness({
      projects: [{ id: 'source-a' }, { id: 'source-b' }, { id: 'target' }],
      templatesByProject,
    });

    const result = await seeder('target');

    expect(result.copied).toBe(3);
    expect(new Set(created.map(row => row.source_storage_id))).toEqual(new Set(['storage-1', 'storage-2', 'storage-3']));
    expect(new Set(created.map(row => row.storageId))).toEqual(new Set(['copy-1', 'copy-2', 'copy-3']));
  });

  it('keeps inherited templates independent when the source blob is deleted', async () => {
    const templatesByProject = new Map([
      ['source-a', [template({ externalId: 'a1', project_id: 'source-a', storageId: 'storage-1' })]],
      ['target', []],
    ]);
    const { seeder, created, storage } = makeSeederHarness({
      projects: [{ id: 'source-a' }, { id: 'target' }],
      templatesByProject,
    });

    await seeder('target');
    const copiedStorageId = created[0].storageId;

    storage.delete('storage-1');

    expect(storage.has('storage-1')).toBe(false);
    expect(storage.has(copiedStorageId)).toBe(true);
  });

  it('uses source_storage_id provenance instead of template ids for inherited copies', () => {
    const original = template({ externalId: 'original', project_id: 'a', storageId: 'storage-root' });
    const inherited = template({
      externalId: 'copy-a',
      project_id: 'b',
      storageId: 'storage-copy',
      source_template_id: 'original',
      source_storage_id: 'storage-root',
    });

    const key = buildTemplateProvenanceResolver([original, inherited]);
    const { selected } = selectTemplatesToSeed([original, inherited], []);

    expect(key(original)).toBe('storage-root');
    expect(key(inherited)).toBe('storage-root');
    expect(selected).toHaveLength(1);
  });

  it('routes project creation through the seeding helper for every created project', async () => {
    const createdProjects = [];
    const seededProjects = [];
    const createProjectWithTemplateSeeding = createProjectCreationService({
      uuidv4: () => `project-${createdProjects.length + 1}`,
      createProject: async (project) => createdProjects.push(project),
      seedProjectTemplatesFromAll: async (projectId) => {
        seededProjects.push(projectId);
        return { copied: 1, skipped: 0, failed: [], status: 'complete' };
      },
      getProject: async (projectId) => ({
        id: projectId,
        name: `Project ${projectId}`,
        template_seeding_status: 'complete',
      }),
      console: { warn: () => {} },
    });

    const results = [];
    for (let i = 0; i < 50; i += 1) {
      results.push(await createProjectWithTemplateSeeding({ name: `Project ${i + 1}` }));
    }

    expect(createdProjects).toHaveLength(50);
    expect(seededProjects).toHaveLength(50);
    expect(results.every(result => result.templateSeeding.status === 'complete')).toBe(true);
    expect(results.every(result => result.templateSeeding.copied > 0)).toBe(true);
  });
});

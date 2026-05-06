import { v4 as uuidv4 } from 'uuid';
import {
  api,
  convexClient,
  downloadToBuffer,
  getProjectOptions,
  getTemplateImagesByProject,
  invalidateQueryCache,
  updateProject,
  uploadBuffer,
} from '../convexClient.js';

const SEED_COPY_CONCURRENCY = 5;
export const SOURCE_TEMPLATE_ROW_CAP = 5000;

function activeStoredTemplate(template) {
  return !!template?.storageId && !template?.archived_at;
}

function inferMimeType(filename = '') {
  const lower = String(filename || '').toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.png')) return 'image/png';
  return 'image/png';
}

function storageIdString(storageId) {
  return storageId ? String(storageId) : '';
}

export function buildTemplateProvenanceResolver(templates = []) {
  const byExternalId = new Map();
  for (const template of templates || []) {
    if (template?.externalId) byExternalId.set(template.externalId, template);
    if (template?.id) byExternalId.set(template.id, template);
  }

  const resolving = new Set();
  const resolve = (template) => {
    if (!template) return '';
    if (template.source_storage_id) return String(template.source_storage_id);

    const sourceTemplateId = template.source_template_id;
    if (sourceTemplateId && !resolving.has(sourceTemplateId)) {
      const sourceTemplate = byExternalId.get(sourceTemplateId);
      if (sourceTemplate) {
        resolving.add(sourceTemplateId);
        const inheritedKey = resolve(sourceTemplate);
        resolving.delete(sourceTemplateId);
        if (inheritedKey) return inheritedKey;
      }
    }

    return storageIdString(template.storageId);
  };

  return resolve;
}

export function snapshotSeedSourceTemplates(projects, templatesByProject, targetProjectId, rowCap = SOURCE_TEMPLATE_ROW_CAP) {
  const rows = [];
  let capHit = false;

  for (const project of projects || []) {
    const projectId = project?.id || project?.externalId;
    if (!projectId || projectId === targetProjectId) continue;
    const projectTemplates = templatesByProject.get(projectId) || [];
    for (const template of projectTemplates) {
      if (rows.length >= rowCap) {
        capHit = true;
        break;
      }
      rows.push(template);
    }
    if (capHit) break;
  }

  return { rows, capHit };
}

export function selectTemplatesToSeed(sourceTemplates, targetTemplates = []) {
  const combined = [...(sourceTemplates || []), ...(targetTemplates || [])];
  const provenanceKey = buildTemplateProvenanceResolver(combined);

  const existingKeys = new Set(
    (targetTemplates || [])
      .filter(activeStoredTemplate)
      .map(provenanceKey)
      .filter(Boolean)
  );

  const selected = [];
  const selectedKeys = new Set();

  for (const template of sourceTemplates || []) {
    if (!activeStoredTemplate(template)) continue;
    const key = provenanceKey(template);
    if (!key || existingKeys.has(key) || selectedKeys.has(key)) continue;
    selected.push({ template, key });
    selectedKeys.add(key);
  }

  return { selected, skipped: existingKeys.size };
}

async function setTemplateSeedingStatus(projectId, status, error = '', deps) {
  await deps.updateProject(projectId, {
    template_seeding_status: status,
    template_seeding_error: error || '',
  });
}

async function copyTemplateIntoProject(targetProjectId, source, sourceStorageKey, deps) {
  const buffer = await deps.downloadToBuffer(source.storageId);
  const storageId = await deps.uploadBuffer(buffer, inferMimeType(source.filename));
  const externalId = deps.uuidv4();

  await deps.createTemplate({
    externalId,
    project_id: targetProjectId,
    filename: source.filename || 'template.png',
    storageId,
    description: source.description || '',
    tags: Array.isArray(source.tags) ? source.tags : [],
    analysis: source.analysis || undefined,
    source_template_id: source.source_template_id || source.externalId || source.id || undefined,
    source_project_id: source.source_project_id || source.project_id || undefined,
    source_storage_id: sourceStorageKey,
  });

  return { copied_template_id: externalId, storageId };
}

export function createTemplateSeeder(customDeps = {}) {
  const deps = {
    uuidv4,
    getProjectOptions,
    getTemplateImagesByProject,
    updateProject,
    downloadToBuffer,
    uploadBuffer,
    createTemplate: (args) => convexClient.mutation(api.templateImages.create, args),
    invalidateQueryCache,
    console,
    ...customDeps,
  };

  return async function seedProjectTemplatesFromAll(targetProjectId, options = {}) {
    const rowCap = options.rowCap ?? SOURCE_TEMPLATE_ROW_CAP;
    await setTemplateSeedingStatus(targetProjectId, 'in_progress', '', deps);

    const projects = await deps.getProjectOptions();
    const templatesByProject = new Map();

    await Promise.all((projects || []).map(async (project) => {
      const projectId = project?.id || project?.externalId;
      if (!projectId) return;
      templatesByProject.set(projectId, await deps.getTemplateImagesByProject(projectId));
    }));

    const { rows: sourceSnapshot, capHit } = snapshotSeedSourceTemplates(
      projects,
      templatesByProject,
      targetProjectId,
      rowCap
    );
    if (capHit) {
      deps.console.warn?.(`[TemplateSeeding] Source row cap ${rowCap} hit while seeding ${targetProjectId}. Copying first ${rowCap} source rows only.`);
    }

    const targetTemplates = templatesByProject.get(targetProjectId) || [];
    const { selected, skipped } = selectTemplatesToSeed(sourceSnapshot, targetTemplates);
    const copied = [];
    const failed = [];

    for (let i = 0; i < selected.length; i += SEED_COPY_CONCURRENCY) {
      const batch = selected.slice(i, i + SEED_COPY_CONCURRENCY);
      const settled = await Promise.allSettled(batch.map(({ template, key }) =>
        copyTemplateIntoProject(targetProjectId, template, key, deps)
          .then(result => ({ template, key, ...result }))
      ));

      settled.forEach((result, index) => {
        const { template, key } = batch[index];
        if (result.status === 'fulfilled') {
          copied.push({
            source_storage_id: key,
            source_template_id: template.source_template_id || template.externalId || template.id || null,
            copied_template_id: result.value.copied_template_id,
          });
          return;
        }

        failed.push({
          source_storage_id: key,
          source_template_id: template.source_template_id || template.externalId || template.id || null,
          filename: template.filename || '',
          error: result.reason?.message || 'Unknown template seeding error',
        });
        deps.console.warn?.(`[TemplateSeeding] Failed to seed ${key} into ${targetProjectId}: ${result.reason?.message}`);
      });
    }

    deps.invalidateQueryCache?.('template_images');
    deps.invalidateQueryCache?.('projects');

    const capWarning = capHit
      ? `Template seeding copied from the first ${rowCap} source rows; additional source rows were skipped.`
      : '';
    if (failed.length > 0) {
      const message = `Template seeding copied ${copied.length}/${selected.length} templates. ${failed.length} failed.`;
      await setTemplateSeedingStatus(targetProjectId, 'failed', message, deps);
    } else {
      await setTemplateSeedingStatus(targetProjectId, 'complete', capWarning, deps);
    }

    return {
      copied: copied.length,
      skipped,
      failed,
      capHit,
      sourceRowsScanned: sourceSnapshot.length,
      status: failed.length > 0 ? 'failed' : 'complete',
      warning: capWarning || null,
    };
  };
}

export const seedProjectTemplatesFromAll = createTemplateSeeder();

// Backward-compatible name for the existing retry endpoint and older callers.
export const adoptSharedTemplatesIntoProject = seedProjectTemplatesFromAll;

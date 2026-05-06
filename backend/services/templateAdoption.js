import { v4 as uuidv4 } from 'uuid';
import {
  api,
  convexClient,
  downloadToBuffer,
  getAllTemplateImages,
  getTemplateImagesByProject,
  invalidateQueryCache,
  uploadBuffer,
} from '../convexClient.js';

const ADOPTION_COPY_CONCURRENCY = 5;

function canonicalTemplateId(template) {
  return template?.source_template_id || template?.externalId || template?.id || '';
}

function activeStoredTemplate(template) {
  return !!template?.storageId && !template?.archived_at;
}

function dedupeCanonicalTemplates(templates) {
  const byCanonical = new Map();
  for (const template of templates || []) {
    if (!activeStoredTemplate(template)) continue;
    const canonicalId = canonicalTemplateId(template);
    if (!canonicalId || byCanonical.has(canonicalId)) continue;
    byCanonical.set(canonicalId, template);
  }
  return [...byCanonical.values()];
}

async function copyTemplateIntoProject(targetProjectId, source) {
  const buffer = await downloadToBuffer(source.storageId);
  const storageId = await uploadBuffer(buffer, 'image/png');
  const externalId = uuidv4();

  await convexClient.mutation(api.templateImages.create, {
    externalId,
    project_id: targetProjectId,
    filename: source.filename || 'template.png',
    storageId,
    description: source.description || '',
    tags: Array.isArray(source.tags) ? source.tags : [],
    analysis: source.analysis || undefined,
    source_template_id: canonicalTemplateId(source),
    source_project_id: source.project_id || undefined,
  });

  return externalId;
}

export async function adoptSharedTemplatesIntoProject(targetProjectId) {
  const [allTemplates, existingTargetTemplates] = await Promise.all([
    getAllTemplateImages(),
    getTemplateImagesByProject(targetProjectId),
  ]);

  const existingCanonicals = new Set(
    (existingTargetTemplates || [])
      .map(canonicalTemplateId)
      .filter(Boolean)
  );

  const sourceTemplates = dedupeCanonicalTemplates(allTemplates)
    .filter(template => !existingCanonicals.has(canonicalTemplateId(template)));

  const copied = [];
  const failed = [];

  for (let i = 0; i < sourceTemplates.length; i += ADOPTION_COPY_CONCURRENCY) {
    const batch = sourceTemplates.slice(i, i + ADOPTION_COPY_CONCURRENCY);
    const settled = await Promise.allSettled(batch.map(async (source) => {
      const canonicalId = canonicalTemplateId(source);
      const copiedId = await copyTemplateIntoProject(targetProjectId, source);
      return { source, canonicalId, copiedId };
    }));

    settled.forEach((result, index) => {
      const source = batch[index];
      const canonicalId = canonicalTemplateId(source);
      if (result.status === 'fulfilled') {
        copied.push({
          source_template_id: result.value.canonicalId,
          copied_template_id: result.value.copiedId,
        });
        existingCanonicals.add(result.value.canonicalId);
        return;
      }

      failed.push({
        source_template_id: canonicalId,
        filename: source.filename || '',
        error: result.reason?.message || 'Unknown template adoption error',
      });
      console.warn(`[TemplateAdoption] Failed to adopt ${canonicalId} into ${targetProjectId}: ${result.reason?.message}`);
    });
  }

  invalidateQueryCache('template_images');

  return {
    copied: copied.length,
    skipped: existingCanonicals.size - copied.length,
    failed,
  };
}

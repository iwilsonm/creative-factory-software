import { ConvexHttpClient } from 'convex/browser';
import { api } from '../../convex/_generated/api.js';
import '../convexClient.js';

const projectId = process.argv[2];
const limit = Number(process.argv[3] || 30);
const client = new ConvexHttpClient(process.env.CONVEX_URL);

const ads = projectId
  ? await client.query(api.adCreatives.getByProject, { projectId })
  : await client.query(api.adCreatives.getAll, {});

const rows = ads
  .slice()
  .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
  .slice(0, limit)
  .map((ad) => ({
    id: ad.externalId,
    projectId: ad.project_id,
    status: ad.status,
    mode: ad.generation_mode,
    storage: Boolean(ad.storageId),
    ageMinutes: ad.created_at ? Math.round((Date.now() - new Date(ad.created_at).getTime()) / 60000) : null,
    progressAgeMinutes: ad.last_progress_at ? Math.round((Date.now() - new Date(ad.last_progress_at).getTime()) / 60000) : null,
    failureStage: ad.failure_stage || null,
    error: ad.error_message || null,
    createdAt: ad.created_at || null,
  }));

console.table(rows);

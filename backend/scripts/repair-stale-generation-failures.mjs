#!/usr/bin/env node

import { ConvexHttpClient } from 'convex/browser';
import { api } from '../../convex/_generated/api.js';
import '../convexClient.js';
import { buildStaleAdRepairUpdate } from '../utils/adGenerationRecovery.js';

const ids = process.argv.slice(2).map((id) => id.trim()).filter(Boolean);

if (ids.length === 0) {
  console.error('Usage: node backend/scripts/repair-stale-generation-failures.mjs <ad-id> [ad-id...]');
  process.exit(1);
}

const client = new ConvexHttpClient(process.env.CONVEX_URL);
const results = [];

for (const id of ids) {
  const ad = await client.query(api.adCreatives.getByExternalId, { externalId: id });
  if (!ad) {
    results.push({ id, status: 'missing' });
    continue;
  }

  const update = buildStaleAdRepairUpdate(ad);
  const fallbackUpdate = {
    status: ad.status || 'failed',
    error_message: ad.error_message || 'Image generation timed out before an image was saved. Please retry this ad.',
    failure_stage: ad.failure_stage || 'stale_generating_image_timeout',
    last_progress_at: new Date().toISOString(),
  };

  await client.mutation(api.adCreatives.update, {
    externalId: id,
    ...(update || fallbackUpdate),
  });

  results.push({
    id,
    priorStatus: ad.status,
    repairedStatus: (update || fallbackUpdate).status,
    failureStage: (update || fallbackUpdate).failure_stage || null,
  });
}

console.table(results);

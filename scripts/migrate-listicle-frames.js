#!/usr/bin/env node

/**
 * Runner for the listicle-only migration on `lp_agent_config` rows.
 *
 * Usage:
 *   node scripts/migrate-listicle-frames.js --dry-run   # print intended writes, change nothing
 *   node scripts/migrate-listicle-frames.js             # actually write
 *
 * The underlying mutation (`convex/migrateListicleFrames.ts`) is idempotent.
 * Running this script twice is safe — a second run reports zero updates.
 *
 * Prereqs:
 *   1. `npx convex deploy -y` has already pushed the migration function.
 *   2. `CONVEX_URL` env var points at the target deployment (prod uses
 *      `https://energized-hare-760.convex.cloud`; local dev uses whatever
 *      `npx convex dev` printed).
 */

import { ConvexHttpClient } from 'convex/browser';
import { api } from '../convex/_generated/api.js';

const DRY_RUN = process.argv.includes('--dry-run');
const CONVEX_URL = process.env.CONVEX_URL || 'https://energized-hare-760.convex.cloud';

async function main() {
  console.log(`[migrate-listicle-frames] target: ${CONVEX_URL}`);
  console.log(`[migrate-listicle-frames] mode: ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE (writes)'}`);

  const client = new ConvexHttpClient(CONVEX_URL);
  const result = await client.mutation(api.migrateListicleFrames.migrateToListicleOnly, {
    dry_run: DRY_RUN,
  });

  console.log('');
  console.log(`Rows scanned: ${result.rows_scanned}`);
  console.log(`Rows needing update: ${result.rows_updated}`);

  if (result.updates && result.updates.length > 0) {
    console.log('');
    console.log('Planned / applied changes:');
    for (const entry of result.updates) {
      console.log(`  project=${entry.project_id}`);
      console.log(`    before: ${entry.before ?? '(null)'}`);
      console.log(`    after:  ${entry.after}`);
    }
  } else {
    console.log('');
    console.log('No rows needed updating — already listicle-only.');
  }

  console.log('');
  if (DRY_RUN && result.rows_updated > 0) {
    console.log('Dry run complete. Re-run without --dry-run to apply.');
  } else if (!DRY_RUN && result.rows_updated > 0) {
    console.log('Migration complete.');
  }
}

main().catch((err) => {
  console.error('[migrate-listicle-frames] failed:', err);
  process.exit(1);
});

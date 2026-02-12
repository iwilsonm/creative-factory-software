#!/usr/bin/env node
/**
 * migrate-to-convex.js — One-time data migration from SQLite → Convex
 *
 * Run on VPS where SQLite DB and image files exist:
 *   CONVEX_URL=https://strong-civet-577.convex.cloud node backend/scripts/migrate-to-convex.js
 *
 * What it does:
 *   1. Reads all data from SQLite (settings, projects, docs, ads, templates, batches, costs)
 *   2. Uploads local image files to Convex file storage
 *   3. Inserts records into Convex tables
 *
 * Safe to re-run: checks for existing records by externalId before inserting.
 */

import Database from 'better-sqlite3';
import { ConvexHttpClient } from 'convex/browser';
import { api } from '../../convex/_generated/api.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Config ---
const DB_PATH = path.join(__dirname, '..', '..', 'data', 'ad-platform.db');
const CONVEX_URL = process.env.CONVEX_URL;

if (!CONVEX_URL) {
  console.error('ERROR: CONVEX_URL not set. Usage: CONVEX_URL=https://your-project.convex.cloud node migrate-to-convex.js');
  process.exit(1);
}

if (!fs.existsSync(DB_PATH)) {
  console.error(`ERROR: SQLite database not found at ${DB_PATH}`);
  process.exit(1);
}

const db = new Database(DB_PATH, { readonly: true });
const convex = new ConvexHttpClient(CONVEX_URL);

// Helper: upload a local file to Convex storage
async function uploadFileToConvex(filePath, mimeType = 'image/png') {
  if (!filePath || !fs.existsSync(filePath)) return null;

  const buffer = fs.readFileSync(filePath);
  const uploadUrl = await convex.mutation(api.fileStorage.generateUploadUrl, {});

  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': mimeType },
    body: buffer,
  });

  if (!response.ok) {
    throw new Error(`Upload failed: ${response.status} ${response.statusText}`);
  }

  const result = await response.json();
  return result.storageId;
}

// Detect MIME type from file extension
function guessMime(filePath) {
  if (!filePath) return 'image/png';
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.png': 'image/png', '.gif': 'image/gif',
    '.webp': 'image/webp', '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml',
  };
  return map[ext] || 'image/png';
}

// ========================================
// Migration functions
// ========================================

async function migrateSettings() {
  console.log('\n--- Settings ---');
  const rows = db.prepare('SELECT key, value FROM settings').all();
  let count = 0;
  for (const row of rows) {
    try {
      await convex.mutation(api.settings.set, { key: row.key, value: row.value || '' });
      count++;
    } catch (err) {
      console.error(`  Setting "${row.key}" failed:`, err.message);
    }
  }
  console.log(`  Migrated ${count}/${rows.length} settings.`);
}

async function migrateProjects() {
  console.log('\n--- Projects ---');
  const rows = db.prepare('SELECT * FROM projects').all();
  let count = 0;
  for (const row of rows) {
    // Check if already exists
    const existing = await convex.query(api.projects.getByExternalId, { externalId: row.id });
    if (existing) {
      console.log(`  Project "${row.name}" already exists, skipping.`);
      count++;
      continue;
    }
    try {
      await convex.mutation(api.projects.create, {
        externalId: row.id,
        name: row.name || '',
        brand_name: row.brand_name || '',
        niche: row.niche || '',
        product_description: row.product_description || '',
        sales_page_content: row.sales_page_content || '',
        drive_folder_id: row.drive_folder_id || '',
        inspiration_folder_id: row.inspiration_folder_id || '',
        prompt_guidelines: row.prompt_guidelines || undefined,
        status: row.status || 'setup',
      });
      count++;
      console.log(`  Project "${row.name}" migrated.`);
    } catch (err) {
      console.error(`  Project "${row.name}" failed:`, err.message);
    }
  }
  console.log(`  Migrated ${count}/${rows.length} projects.`);
}

async function migrateDocs() {
  console.log('\n--- Foundational Docs ---');
  const rows = db.prepare('SELECT * FROM foundational_docs ORDER BY version ASC').all();
  let count = 0;
  for (const row of rows) {
    const existing = await convex.query(api.foundationalDocs.getByExternalId, { externalId: row.id });
    if (existing) {
      count++;
      continue;
    }
    try {
      await convex.mutation(api.foundationalDocs.create, {
        externalId: row.id,
        project_id: row.project_id,
        doc_type: row.doc_type,
        content: row.content || '',
        version: row.version || 1,
        approved: !!(row.approved),
        source: row.source || 'generated',
      });
      count++;
    } catch (err) {
      console.error(`  Doc ${row.id.slice(0, 8)} (${row.doc_type}) failed:`, err.message);
    }
  }
  console.log(`  Migrated ${count}/${rows.length} docs.`);
}

async function migrateTemplateImages() {
  console.log('\n--- Template Images ---');
  const rows = db.prepare('SELECT * FROM template_images').all();
  let count = 0;
  for (const row of rows) {
    const existing = await convex.query(api.templateImages.getByExternalId, { externalId: row.id });
    if (existing) {
      count++;
      continue;
    }
    try {
      let storageId = undefined;
      if (row.file_path && fs.existsSync(row.file_path)) {
        console.log(`  Uploading template image: ${path.basename(row.file_path)}`);
        storageId = await uploadFileToConvex(row.file_path, guessMime(row.file_path));
      }

      await convex.mutation(api.templateImages.create, {
        externalId: row.id,
        project_id: row.project_id,
        filename: row.filename || path.basename(row.file_path || 'unknown'),
        mimeType: row.mimeType || guessMime(row.file_path),
        storageId,
        label: row.label || undefined,
      });
      count++;
    } catch (err) {
      console.error(`  Template ${row.id.slice(0, 8)} failed:`, err.message);
    }
  }
  console.log(`  Migrated ${count}/${rows.length} template images.`);
}

async function migrateAdCreatives() {
  console.log('\n--- Ad Creatives ---');
  const rows = db.prepare('SELECT * FROM ad_creatives ORDER BY created_at ASC').all();
  let count = 0;
  let uploadCount = 0;
  for (const row of rows) {
    const existing = await convex.query(api.adCreatives.getByExternalId, { externalId: row.id });
    if (existing) {
      count++;
      continue;
    }
    try {
      let storageId = undefined;
      if (row.image_path && fs.existsSync(row.image_path)) {
        storageId = await uploadFileToConvex(row.image_path, guessMime(row.image_path));
        uploadCount++;
        if (uploadCount % 10 === 0) {
          console.log(`  Uploaded ${uploadCount} images so far...`);
        }
      }

      await convex.mutation(api.adCreatives.create, {
        externalId: row.id,
        project_id: row.project_id,
        generation_mode: row.generation_mode || 'mode1',
        angle: row.angle || undefined,
        headline: row.headline || undefined,
        body_copy: row.body_copy || undefined,
        image_prompt: row.image_prompt || undefined,
        gpt_creative_output: row.gpt_creative_output || undefined,
        template_image_id: row.template_image_id || undefined,
        inspiration_image_id: row.inspiration_image_id || undefined,
        storageId,
        drive_file_id: row.drive_file_id || undefined,
        drive_url: row.drive_url || undefined,
        aspect_ratio: row.aspect_ratio || '1:1',
        status: row.status || 'completed',
        auto_generated: !!(row.auto_generated),
        parent_ad_id: row.parent_ad_id || undefined,
      });
      count++;
    } catch (err) {
      console.error(`  Ad ${row.id.slice(0, 8)} failed:`, err.message);
    }
  }
  console.log(`  Migrated ${count}/${rows.length} ad creatives (${uploadCount} images uploaded).`);
}

async function migrateBatchJobs() {
  console.log('\n--- Batch Jobs ---');
  const rows = db.prepare('SELECT * FROM batch_jobs').all();
  let count = 0;
  for (const row of rows) {
    const existing = await convex.query(api.batchJobs.getByExternalId, { externalId: row.id });
    if (existing) {
      count++;
      continue;
    }
    try {
      let productImageStorageId = undefined;
      if (row.product_image_path && fs.existsSync(row.product_image_path)) {
        productImageStorageId = await uploadFileToConvex(row.product_image_path, guessMime(row.product_image_path));
      }

      await convex.mutation(api.batchJobs.create, {
        externalId: row.id,
        project_id: row.project_id,
        generation_mode: row.generation_mode || 'mode1',
        batch_size: row.batch_size || 1,
        angle: row.angle || undefined,
        aspect_ratio: row.aspect_ratio || '1:1',
        template_image_id: row.template_image_id || undefined,
        inspiration_image_id: row.inspiration_image_id || undefined,
        product_image_storageId: productImageStorageId,
        scheduled: !!(row.scheduled),
        schedule_cron: row.schedule_cron || undefined,
      });

      // Update additional fields that aren't in create
      if (row.status !== 'pending' || row.gemini_batch_job || row.gpt_prompts) {
        const updates = { externalId: row.id };
        if (row.status) updates.status = row.status;
        if (row.gemini_batch_job) updates.gemini_batch_job = row.gemini_batch_job;
        if (row.gpt_prompts) updates.gpt_prompts = row.gpt_prompts;
        if (row.error_message) updates.error_message = row.error_message;
        if (row.completed_at) updates.completed_at = row.completed_at;
        if (row.completed_count) updates.completed_count = row.completed_count;
        if (row.retry_count) updates.retry_count = row.retry_count;
        if (row.batch_stats) updates.batch_stats = row.batch_stats;
        await convex.mutation(api.batchJobs.update, updates);
      }

      count++;
    } catch (err) {
      console.error(`  Batch ${row.id.slice(0, 8)} failed:`, err.message);
    }
  }
  console.log(`  Migrated ${count}/${rows.length} batch jobs.`);
}

async function migrateCosts() {
  console.log('\n--- API Costs ---');
  const rows = db.prepare('SELECT * FROM api_costs').all();
  let count = 0;
  for (const row of rows) {
    try {
      await convex.mutation(api.apiCosts.log, {
        externalId: row.id,
        project_id: row.project_id || undefined,
        service: row.service,
        operation: row.operation || undefined,
        cost_usd: row.cost_usd || 0,
        rate_used: row.rate_used || undefined,
        image_count: row.image_count || undefined,
        resolution: row.resolution || undefined,
        source: row.source || 'calculated',
        period_date: row.period_date || new Date().toISOString().split('T')[0],
      });
      count++;
    } catch (err) {
      // Skip duplicates silently
      if (!err.message.includes('already exists')) {
        console.error(`  Cost ${row.id?.slice(0, 8)} failed:`, err.message);
      }
    }
  }
  console.log(`  Migrated ${count}/${rows.length} cost records.`);
}

// ========================================
// Run migration
// ========================================

async function main() {
  console.log('=== SQLite → Convex Migration ===');
  console.log(`Database: ${DB_PATH}`);
  console.log(`Convex URL: ${CONVEX_URL}`);
  console.log();

  const start = Date.now();

  await migrateSettings();
  await migrateProjects();
  await migrateDocs();
  await migrateTemplateImages();
  await migrateAdCreatives();
  await migrateBatchJobs();
  await migrateCosts();

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\n=== Migration complete in ${elapsed}s ===`);
  console.log('Verify data in Convex dashboard: npx convex dashboard');
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});

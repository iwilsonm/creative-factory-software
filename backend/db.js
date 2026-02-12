import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '..', 'data', 'app.db');

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Initialize all tables
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    brand_name TEXT,
    niche TEXT,
    product_description TEXT,
    sales_page_content TEXT,
    drive_folder_id TEXT,
    inspiration_folder_id TEXT,
    status TEXT DEFAULT 'setup',
    created_at DATETIME DEFAULT (datetime('now')),
    updated_at DATETIME DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS foundational_docs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    doc_type TEXT NOT NULL,
    content TEXT,
    version INTEGER DEFAULT 1,
    approved BOOLEAN DEFAULT 0,
    source TEXT DEFAULT 'generated',
    created_at DATETIME DEFAULT (datetime('now')),
    updated_at DATETIME DEFAULT (datetime('now')),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS template_images (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    file_path TEXT NOT NULL,
    description TEXT,
    created_at DATETIME DEFAULT (datetime('now')),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS ad_creatives (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    generation_mode TEXT NOT NULL,
    angle TEXT,
    image_prompt TEXT,
    gpt_creative_output TEXT,
    template_image_id TEXT,
    inspiration_image_id TEXT,
    image_path TEXT,
    drive_file_id TEXT,
    drive_url TEXT,
    aspect_ratio TEXT DEFAULT '1:1',
    status TEXT DEFAULT 'generating_copy',
    auto_generated BOOLEAN DEFAULT 0,
    created_at DATETIME DEFAULT (datetime('now')),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (template_image_id) REFERENCES template_images(id)
  );

  CREATE TABLE IF NOT EXISTS batch_jobs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    generation_mode TEXT NOT NULL,
    batch_size INTEGER DEFAULT 1,
    angle TEXT,
    aspect_ratio TEXT DEFAULT '1:1',
    template_image_id TEXT,
    gemini_batch_job TEXT,
    gpt_prompts TEXT,
    status TEXT DEFAULT 'pending',
    scheduled BOOLEAN DEFAULT 0,
    schedule_cron TEXT,
    created_at DATETIME DEFAULT (datetime('now')),
    completed_at DATETIME,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS api_costs (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    service TEXT NOT NULL,
    operation TEXT,
    cost_usd REAL,
    rate_used REAL,
    image_count INTEGER,
    resolution TEXT,
    source TEXT,
    period_date DATE,
    created_at DATETIME DEFAULT (datetime('now'))
  );
`);

// --- Migrations: add columns to existing tables if they don't exist ---
// SQLite doesn't support IF NOT EXISTS for ALTER TABLE ADD COLUMN,
// so we check the table info first.
const fdCols = db.prepare("PRAGMA table_info(foundational_docs)").all().map(c => c.name);
if (!fdCols.includes('source')) {
  db.exec("ALTER TABLE foundational_docs ADD COLUMN source TEXT DEFAULT 'generated'");
}
if (!fdCols.includes('updated_at')) {
  // SQLite ALTER TABLE doesn't allow non-constant defaults like datetime('now'),
  // so we use a plain TEXT default and handle timestamping in application code.
  db.exec("ALTER TABLE foundational_docs ADD COLUMN updated_at DATETIME");
  // Backfill: set updated_at = created_at for existing rows
  db.exec("UPDATE foundational_docs SET updated_at = created_at WHERE updated_at IS NULL");
}

// Migration: add new columns to ad_creatives
const acCols = db.prepare("PRAGMA table_info(ad_creatives)").all().map(c => c.name);
if (!acCols.includes('headline')) {
  db.exec("ALTER TABLE ad_creatives ADD COLUMN headline TEXT");
}
if (!acCols.includes('body_copy')) {
  db.exec("ALTER TABLE ad_creatives ADD COLUMN body_copy TEXT");
}
if (!acCols.includes('parent_ad_id')) {
  db.exec("ALTER TABLE ad_creatives ADD COLUMN parent_ad_id TEXT");
}

// Migration: add new columns to batch_jobs
const bjCols = db.prepare("PRAGMA table_info(batch_jobs)").all().map(c => c.name);
if (!bjCols.includes('error_message')) {
  db.exec("ALTER TABLE batch_jobs ADD COLUMN error_message TEXT");
}
if (!bjCols.includes('completed_count')) {
  db.exec("ALTER TABLE batch_jobs ADD COLUMN completed_count INTEGER DEFAULT 0");
}
if (!bjCols.includes('retry_count')) {
  db.exec("ALTER TABLE batch_jobs ADD COLUMN retry_count INTEGER DEFAULT 0");
}
if (!bjCols.includes('batch_stats')) {
  db.exec("ALTER TABLE batch_jobs ADD COLUMN batch_stats TEXT");
}
if (!bjCols.includes('inspiration_image_id')) {
  db.exec("ALTER TABLE batch_jobs ADD COLUMN inspiration_image_id TEXT");
}
if (!bjCols.includes('product_image_path')) {
  db.exec("ALTER TABLE batch_jobs ADD COLUMN product_image_path TEXT");
}

// Migration: add prompt_guidelines column to projects
const projCols = db.prepare("PRAGMA table_info(projects)").all().map(c => c.name);
if (!projCols.includes('prompt_guidelines')) {
  db.exec("ALTER TABLE projects ADD COLUMN prompt_guidelines TEXT");
}

// --- Settings helpers ---

export function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

export function getAllSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const result = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

// --- Project helpers ---

export function createProject({ id, name, brand_name, niche, product_description, sales_page_content, drive_folder_id, inspiration_folder_id }) {
  db.prepare(`
    INSERT INTO projects (id, name, brand_name, niche, product_description, sales_page_content, drive_folder_id, inspiration_folder_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, brand_name, niche, product_description, sales_page_content, drive_folder_id, inspiration_folder_id);
}

export function getProject(id) {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
}

export function getAllProjects() {
  return db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all();
}

export function updateProject(id, fields) {
  const allowed = ['name', 'brand_name', 'niche', 'product_description', 'sales_page_content', 'drive_folder_id', 'inspiration_folder_id', 'prompt_guidelines', 'status'];
  const updates = [];
  const values = [];
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      updates.push(`${key} = ?`);
      values.push(fields[key]);
    }
  }
  if (updates.length === 0) return;
  updates.push("updated_at = datetime('now')");
  values.push(id);
  db.prepare(`UPDATE projects SET ${updates.join(', ')} WHERE id = ?`).run(...values);
}

export function deleteProject(id) {
  db.prepare('DELETE FROM projects WHERE id = ?').run(id);
}

// --- Foundational doc helpers ---

export function getDocsByProject(projectId) {
  return db.prepare('SELECT * FROM foundational_docs WHERE project_id = ? ORDER BY doc_type, version DESC').all(projectId);
}

export function getLatestDoc(projectId, docType) {
  return db.prepare('SELECT * FROM foundational_docs WHERE project_id = ? AND doc_type = ? ORDER BY version DESC LIMIT 1').get(projectId, docType);
}

// --- Ad creative helpers ---

export function getAdsByProject(projectId) {
  return db.prepare('SELECT * FROM ad_creatives WHERE project_id = ? ORDER BY created_at DESC').all(projectId);
}

// --- Stats helpers ---

export function getProjectStats(projectId) {
  const docCount = db.prepare('SELECT COUNT(*) as count FROM foundational_docs WHERE project_id = ?').get(projectId).count;
  const adCount = db.prepare('SELECT COUNT(*) as count FROM ad_creatives WHERE project_id = ?').get(projectId).count;
  return { docCount, adCount };
}

// --- Batch job helpers ---

export function createBatchJob({ id, project_id, generation_mode, batch_size, angle, aspect_ratio, template_image_id, inspiration_image_id, product_image_path, scheduled, schedule_cron }) {
  db.prepare(`
    INSERT INTO batch_jobs (id, project_id, generation_mode, batch_size, angle, aspect_ratio, template_image_id, inspiration_image_id, product_image_path, scheduled, schedule_cron, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `).run(id, project_id, generation_mode, batch_size || 1, angle || null, aspect_ratio || '1:1', template_image_id || null, inspiration_image_id || null, product_image_path || null, scheduled ? 1 : 0, schedule_cron || null);
}

export function getBatchJob(id) {
  return db.prepare('SELECT * FROM batch_jobs WHERE id = ?').get(id);
}

export function getBatchesByProject(projectId) {
  return db.prepare('SELECT * FROM batch_jobs WHERE project_id = ? ORDER BY created_at DESC').all(projectId);
}

export function getActiveBatchJobs() {
  return db.prepare("SELECT * FROM batch_jobs WHERE status IN ('generating_prompts', 'submitting', 'processing')").all();
}

export function getScheduledBatchJobs() {
  return db.prepare("SELECT * FROM batch_jobs WHERE scheduled = 1 AND schedule_cron IS NOT NULL").all();
}

export function getAllScheduledBatchesForCost() {
  return db.prepare(`
    SELECT batch_size, schedule_cron, aspect_ratio, project_id
    FROM batch_jobs
    WHERE scheduled = 1 AND schedule_cron IS NOT NULL
  `).all();
}

export function updateBatchJob(id, fields) {
  const allowed = ['status', 'gemini_batch_job', 'gpt_prompts', 'error_message', 'completed_at', 'completed_count', 'scheduled', 'schedule_cron', 'retry_count', 'batch_stats'];
  const updates = [];
  const values = [];
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      updates.push(`${key} = ?`);
      values.push(fields[key]);
    }
  }
  if (updates.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE batch_jobs SET ${updates.join(', ')} WHERE id = ?`).run(...values);
}

export function deleteBatchJob(id) {
  db.prepare('DELETE FROM batch_jobs WHERE id = ?').run(id);
}

// --- API Cost helpers ---

export function logCost({ id, project_id, service, operation, cost_usd, rate_used, image_count, resolution, source, period_date }) {
  db.prepare(`
    INSERT INTO api_costs (id, project_id, service, operation, cost_usd, rate_used, image_count, resolution, source, period_date)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, project_id || null, service, operation || null, cost_usd || 0, rate_used || null, image_count || null, resolution || null, source || 'calculated', period_date || new Date().toISOString().split('T')[0]);
}

export function getCostAggregates(startDate, endDate, projectId = null) {
  let whereClause = 'WHERE period_date >= ? AND period_date <= ?';
  const params = [startDate, endDate];
  if (projectId) {
    whereClause += ' AND project_id = ?';
    params.push(projectId);
  }

  const total = db.prepare(`SELECT COALESCE(SUM(cost_usd), 0) as total FROM api_costs ${whereClause}`).get(...params);

  const byService = db.prepare(`
    SELECT service, COALESCE(SUM(cost_usd), 0) as total
    FROM api_costs ${whereClause}
    GROUP BY service
  `).all(...params);

  const byOperation = db.prepare(`
    SELECT operation, COALESCE(SUM(cost_usd), 0) as total
    FROM api_costs ${whereClause}
    GROUP BY operation
  `).all(...params);

  return {
    total: total.total,
    byService: Object.fromEntries(byService.map(r => [r.service, r.total])),
    byOperation: Object.fromEntries(byOperation.map(r => [r.operation || 'unknown', r.total]))
  };
}

export function getDailyCostHistory(days = 30, projectId = null) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  const startStr = startDate.toISOString().split('T')[0];

  let whereClause = 'WHERE period_date >= ?';
  const params = [startStr];
  if (projectId) {
    whereClause += ' AND project_id = ?';
    params.push(projectId);
  }

  return db.prepare(`
    SELECT
      period_date as date,
      COALESCE(SUM(CASE WHEN service = 'openai' THEN cost_usd ELSE 0 END), 0) as openai,
      COALESCE(SUM(CASE WHEN service = 'gemini' THEN cost_usd ELSE 0 END), 0) as gemini,
      COALESCE(SUM(cost_usd), 0) as total
    FROM api_costs ${whereClause}
    GROUP BY period_date
    ORDER BY period_date ASC
  `).all(...params);
}

export function deleteCostsBySource(source, startDate) {
  db.prepare('DELETE FROM api_costs WHERE source = ? AND period_date >= ?').run(source, startDate);
}

export default db;

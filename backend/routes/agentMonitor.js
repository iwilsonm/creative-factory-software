import { Router } from 'express';
import { promises as fs } from 'fs';
import { statSync } from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = Router();

// --- Fixer (Agent #1) ---
const FIXER_DIR = path.join(__dirname, '..', '..', 'dacia-fixer');
const LOGS_DIR = path.join(FIXER_DIR, 'logs');
const FIXER_SCRIPT = path.join(FIXER_DIR, 'fixer.sh');
const DAILY_BUDGET_CENTS = 133;
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// --- Creative Filter (Agent #2) ---
const FILTER_DIR = path.join(__dirname, '..', '..', 'dacia-creative-filter');
const FILTER_LOGS_DIR = path.join(FILTER_DIR, 'logs');
const FILTER_SCRIPT = path.join(FILTER_DIR, 'filter.sh');
const FILTER_BUDGET_CENTS = 133;
const FILTER_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

const stripAnsi = (str) => str.replace(/\x1b\[[0-9;]*m/g, '');

function getToday() {
  return new Date().toISOString().split('T')[0];
}

function parseLogLine(line, agentTag = 'FIXER') {
  const clean = stripAnsi(line).trim();
  if (!clean) return null;
  const re = new RegExp(`^\\[(\\d{2}:\\d{2}:\\d{2})\\]\\s+\\[${agentTag}\\]\\s+\\[(\\w+)\\]\\s+(.+)$`);
  const match = clean.match(re);
  if (!match) return null;
  return { time: match[1], level: match[2], message: match[3].trim() };
}

// GET /api/agent-monitor/status
router.get('/status', async (req, res) => {
  try {
    const today = getToday();
    const logFile = path.join(LOGS_DIR, `fixer_${today}.log`);
    const spendFile = path.join(LOGS_DIR, `spend_${today}.txt`);

    // Read spend
    let spentCents = 0;
    try {
      const spendContent = await fs.readFile(spendFile, 'utf-8');
      spentCents = Math.round(parseFloat(spendContent.trim()) || 0);
    } catch { /* file doesn't exist yet */ }

    // Read log file
    let logContent = '';
    let lastRunAt = null;
    let stats = { runs: 0, fixes: 0, failures: 0, resurrections: 0 };
    let activity = [];

    try {
      logContent = await fs.readFile(logFile, 'utf-8');
      const fileStat = statSync(logFile);
      lastRunAt = fileStat.mtime.toISOString();
    } catch { /* no log file today */ }

    if (logContent) {
      const stripped = stripAnsi(logContent);
      // Count patterns — matching fixer.sh log output
      stats.runs = (stripped.match(/Checking:/g) || []).length;
      stats.fixes = (stripped.match(/Fix verified/g) || []).length;
      stats.failures = (stripped.match(/Failed after/g) || []).length;
      stats.resurrections = (stripped.match(/Resurrected/g) || []).length;

      // Parse last 30 lines for activity feed
      const lines = logContent.split('\n').filter(l => l.trim());
      const recentLines = lines.slice(-30);
      activity = recentLines
        .map(l => parseLogLine(l, 'FIXER'))
        .filter(Boolean)
        .reverse(); // newest first
    }

    // Determine agent status from last run time
    let status = 'offline';
    if (lastRunAt) {
      const elapsed = Date.now() - new Date(lastRunAt).getTime();
      if (elapsed < 10 * 60 * 1000) status = 'online';
      else if (elapsed < 30 * 60 * 1000) status = 'warning';
    }

    // Compute next run estimate
    let nextRun = null;
    if (lastRunAt) {
      nextRun = new Date(new Date(lastRunAt).getTime() + CHECK_INTERVAL_MS).toISOString();
    }

    res.json({
      status,
      budget: { spent_cents: spentCents, daily_budget_cents: DAILY_BUDGET_CENTS },
      stats,
      lastRun: lastRunAt,
      nextRun,
      activity,
    });
  } catch (err) {
    console.error('[AgentMonitor] Status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/agent-monitor/run
router.post('/run', async (req, res) => {
  try {
    const projectDir = path.join(__dirname, '..', '..');
    exec(`bash "${FIXER_SCRIPT}" batch_creation`, {
      cwd: projectDir,
      env: { ...process.env, PATH: process.env.PATH },
      timeout: 120000,
    }, (error, stdout, stderr) => {
      if (error) console.error('[AgentMonitor] Run error:', error.message);
      if (stdout) console.log('[AgentMonitor] Run output:', stdout.slice(0, 500));
    });
    res.json({ ok: true, message: 'Fixer run triggered' });
  } catch (err) {
    console.error('[AgentMonitor] Run trigger error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/agent-monitor/resurrect
router.post('/resurrect', async (req, res) => {
  try {
    const projectDir = path.join(__dirname, '..', '..');
    exec(`bash "${FIXER_SCRIPT}" --resurrect`, {
      cwd: projectDir,
      env: { ...process.env, PATH: process.env.PATH },
      timeout: 60000,
    }, (error, stdout, stderr) => {
      if (error) console.error('[AgentMonitor] Resurrect error:', error.message);
      if (stdout) console.log('[AgentMonitor] Resurrect output:', stdout.slice(0, 500));
    });
    res.json({ ok: true, message: 'Resurrection triggered' });
  } catch (err) {
    console.error('[AgentMonitor] Resurrect trigger error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// Creative Filter (Agent #2) endpoints
// =============================================

// GET /api/agent-monitor/filter/status
router.get('/filter/status', async (req, res) => {
  try {
    const today = getToday();
    const logFile = path.join(FILTER_LOGS_DIR, `filter_${today}.log`);
    const spendFile = path.join(FILTER_LOGS_DIR, `spend_${today}.txt`);

    // Read spend
    let spentCents = 0;
    try {
      const spendContent = await fs.readFile(spendFile, 'utf-8');
      spentCents = Math.round(parseFloat(spendContent.trim()) || 0);
    } catch { /* file doesn't exist yet */ }

    // Read log file
    let logContent = '';
    let lastRunAt = null;
    let stats = { batches: 0, scored: 0, passed: 0, failed: 0, flexAds: 0 };
    let activity = [];

    try {
      logContent = await fs.readFile(logFile, 'utf-8');
      const fileStat = statSync(logFile);
      lastRunAt = fileStat.mtime.toISOString();
    } catch { /* no log file today */ }

    if (logContent) {
      const stripped = stripAnsi(logContent);
      // Count patterns matching filter.sh's log patterns
      stats.batches = (stripped.match(/processing complete/gi) || []).length;
      stats.scored = (stripped.match(/Scoring \d+ ads/gi) || []).length;
      stats.passed = (stripped.match(/PASS/gi) || []).length;
      stats.failed = (stripped.match(/FAIL/gi) || []).length;
      stats.flexAds = (stripped.match(/Deployed flex ad/gi) || []).length;

      // Parse last 30 lines for activity feed
      const lines = logContent.split('\n').filter(l => l.trim());
      const recentLines = lines.slice(-30);
      activity = recentLines
        .map(l => parseLogLine(l, 'FILTER'))
        .filter(Boolean)
        .reverse();
    }

    // Determine agent status from last run time (30-min interval)
    let status = 'offline';
    if (lastRunAt) {
      const elapsed = Date.now() - new Date(lastRunAt).getTime();
      if (elapsed < 35 * 60 * 1000) status = 'online';
      else if (elapsed < 65 * 60 * 1000) status = 'warning';
    }

    // Compute next run estimate
    let nextRun = null;
    if (lastRunAt) {
      nextRun = new Date(new Date(lastRunAt).getTime() + FILTER_INTERVAL_MS).toISOString();
    }

    res.json({
      status,
      budget: { spent_cents: spentCents, daily_budget_cents: FILTER_BUDGET_CENTS },
      stats,
      lastRun: lastRunAt,
      nextRun,
      activity,
    });
  } catch (err) {
    console.error('[AgentMonitor] Filter status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/agent-monitor/filter/run
router.post('/filter/run', async (req, res) => {
  try {
    const projectDir = path.join(__dirname, '..', '..');
    exec(`bash "${FILTER_SCRIPT}" --dry-run`, {
      cwd: projectDir,
      env: { ...process.env, PATH: process.env.PATH },
      timeout: 120000,
    }, (error, stdout, stderr) => {
      if (error) console.error('[AgentMonitor] Filter run error:', error.message);
      if (stdout) console.log('[AgentMonitor] Filter run output:', stdout.slice(0, 500));
    });
    res.json({ ok: true, message: 'Creative Filter run triggered (dry-run)' });
  } catch (err) {
    console.error('[AgentMonitor] Filter run trigger error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/agent-monitor/filter/run-live
router.post('/filter/run-live', async (req, res) => {
  try {
    const projectDir = path.join(__dirname, '..', '..');
    exec(`bash "${FILTER_SCRIPT}"`, {
      cwd: projectDir,
      env: { ...process.env, PATH: process.env.PATH },
      timeout: 300000, // 5 min — scoring can take a while
    }, (error, stdout, stderr) => {
      if (error) console.error('[AgentMonitor] Filter live run error:', error.message);
      if (stdout) console.log('[AgentMonitor] Filter live run output:', stdout.slice(0, 500));
    });
    res.json({ ok: true, message: 'Creative Filter run triggered' });
  } catch (err) {
    console.error('[AgentMonitor] Filter live trigger error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;

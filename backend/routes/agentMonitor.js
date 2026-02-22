import { Router } from 'express';
import { promises as fs } from 'fs';
import { statSync } from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = Router();

const FIXER_DIR = path.join(__dirname, '..', '..', 'dacia-fixer');
const LOGS_DIR = path.join(FIXER_DIR, 'logs');
const FIXER_SCRIPT = path.join(FIXER_DIR, 'fixer.sh');
const DAILY_BUDGET_CENTS = 133;
const CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const stripAnsi = (str) => str.replace(/\x1b\[[0-9;]*m/g, '');

function getToday() {
  return new Date().toISOString().split('T')[0];
}

function parseLogLine(line) {
  const clean = stripAnsi(line).trim();
  if (!clean) return null;
  const match = clean.match(/^\[(\d{2}:\d{2}:\d{2})\]\s+\[FIXER\]\s+\[(\w+)\]\s+(.+)$/);
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
      // Count patterns — matching fixer.sh show_status() logic
      stats.runs = (stripped.match(/Checking:/g) || []).length;
      stats.fixes = (stripped.match(/\[OK\]/g) || []).length;
      stats.failures = (stripped.match(/Failed after/g) || []).length;
      stats.resurrections = (stripped.match(/Resurrected/g) || []).length;

      // Parse last 30 lines for activity feed
      const lines = logContent.split('\n').filter(l => l.trim());
      const recentLines = lines.slice(-30);
      activity = recentLines
        .map(parseLogLine)
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

export default router;

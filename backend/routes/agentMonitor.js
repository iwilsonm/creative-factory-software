import { Router } from 'express';
import { promises as fs } from 'fs';
import { statSync } from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { logCost, getAllProjects, updateProject, convexClient, api } from '../convexClient.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = Router();

// --- Creative Filter ---
const FILTER_DIR = path.join(__dirname, '..', '..', 'dacia-creative-filter');
const FILTER_LOGS_DIR = path.join(FILTER_DIR, 'logs');
const FILTER_SCRIPT = path.join(FILTER_DIR, 'filter.sh');
const FILTER_BUDGET_CENTS = 133;
const FILTER_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const FILTER_PAUSE_FILE = path.join(FILTER_DIR, '.paused');

const stripAnsi = (str) => str.replace(/\x1b\[[0-9;]*m/g, '');

async function isAgentPaused(pauseFile) {
  try {
    await fs.access(pauseFile);
    return true;
  } catch {
    return false;
  }
}

function getToday() {
  return new Date().toISOString().split('T')[0];
}

function parseLogLine(line, agentTag = 'FILTER') {
  const clean = stripAnsi(line).trim();
  if (!clean) return null;
  const re = new RegExp(`^\\[(\\d{2}:\\d{2}:\\d{2})\\]\\s+\\[${agentTag}\\]\\s+\\[(\\w+)\\]\\s+(.+)$`);
  const match = clean.match(re);
  if (!match) return null;
  return { time: match[1], level: match[2], message: match[3].trim() };
}

// =============================================
// Creative Filter endpoints
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

    // Check if agent is paused
    const paused = await isAgentPaused(FILTER_PAUSE_FILE);

    // Determine agent status from last run time (30-min interval)
    let status = paused ? 'paused' : 'offline';
    if (!paused && lastRunAt) {
      const elapsed = Date.now() - new Date(lastRunAt).getTime();
      if (elapsed < 35 * 60 * 1000) status = 'online';
      else if (elapsed < 65 * 60 * 1000) status = 'warning';
    }

    // Compute next run estimate
    let nextRun = null;
    if (!paused && lastRunAt) {
      nextRun = new Date(new Date(lastRunAt).getTime() + FILTER_INTERVAL_MS).toISOString();
    }

    res.json({
      status,
      paused,
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
    res.json({ success: true, message: 'Creative Filter run triggered (dry-run)' });
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
    res.json({ success: true, message: 'Creative Filter run triggered' });
  } catch (err) {
    console.error('[AgentMonitor] Filter live trigger error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/agent-monitor/filter/pause  — Toggle filter pause state
router.post('/filter/pause', async (req, res) => {
  try {
    const paused = await isAgentPaused(FILTER_PAUSE_FILE);
    if (paused) {
      await fs.unlink(FILTER_PAUSE_FILE);
      res.json({ success: true, paused: false, message: 'Creative Filter resumed' });
    } else {
      await fs.writeFile(FILTER_PAUSE_FILE, new Date().toISOString(), 'utf-8');
      res.json({ success: true, paused: true, message: 'Creative Filter paused' });
    }
  } catch (err) {
    console.error('[AgentMonitor] Filter pause toggle error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// Creative Filter — Per-Brand Volume Controls
// =============================================

// GET /api/agent-monitor/filter/volumes
// Returns all projects with their legacy manual filter cap and today's ad-set count
router.get('/filter/volumes', async (req, res) => {
  try {
    const projects = await getAllProjects();
    const today = getToday();

    const volumes = await Promise.all(projects.map(async (p) => {
      // Phase 6 — count today's Director-produced ad_sets instead of flex_ads.
      let todayCount = 0;
      try {
        const adSets = await convexClient.query(api.adSets.getByProject, { projectId: p.id });
        todayCount = (adSets || []).filter(s =>
          s.created_at && s.created_at.startsWith(today) &&
          s.name && /^Director — /.test(s.name)
        ).length;
      } catch { /* no ad sets or query error */ }

      return {
        id: p.id,
        name: p.name,
        brand_name: p.brand_name,
        scout_enabled: p.scout_enabled,
        scout_daily_flex_ads: p.scout_daily_flex_ads ?? 2,  // legacy field name; manual filter cap
        scout_daily_ad_sets: p.scout_daily_flex_ads ?? 2,
        today_flex_ads: todayCount,                          // legacy alias
        today_ad_sets: todayCount,
      };
    }));

    res.json({ projects: volumes });
  } catch (err) {
    console.error('[AgentMonitor] Filter volumes error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/agent-monitor/filter/volumes/:projectId
// Update a project's legacy manual filter cap
router.put('/filter/volumes/:projectId', async (req, res) => {
  try {
    const { scout_daily_flex_ads } = req.body;
    const value = Math.max(1, Math.min(10, parseInt(scout_daily_flex_ads) || 2));
    await updateProject(req.params.projectId, { scout_daily_flex_ads: value });
    res.json({ success: true, scout_daily_flex_ads: value });
  } catch (err) {
    console.error('[AgentMonitor] Update volume error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// Agent Cost Logging (shared by both agents)
// =============================================
// Separate router — mounted WITHOUT auth so agents can call from localhost
// =============================================

const costRouter = Router();

// POST /api/agent-cost/log
// Called by agent shell scripts to log LLM costs to Convex api_costs table
// No auth required — only accessible from localhost via curl
costRouter.post('/log', async (req, res) => {
  try {
    const { agent, operation, cost_cents, model, service } = req.body;

    if (!agent || !operation || !cost_cents) {
      return res.status(400).json({ error: 'Missing required fields: agent, operation, cost_cents' });
    }

    const costUsd = (parseFloat(cost_cents) || 0) / 100;
    if (costUsd <= 0) {
      return res.json({ success: true, message: 'Zero cost, skipped' });
    }

    const record = {
      id: uuidv4(),
      project_id: undefined,
      service: service || 'anthropic',
      operation: `${agent}_${operation}`,
      cost_usd: Math.round(costUsd * 1000000) / 1000000,
      rate_used: undefined,
      image_count: undefined,
      resolution: undefined,
      source: 'calculated',
      period_date: new Date().toISOString().split('T')[0],
    };

    await logCost(record);
    res.json({ success: true, cost_usd: record.cost_usd });
  } catch (err) {
    console.error('[AgentMonitor] Log cost error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /agent-monitor/gauntlet-stats — Gauntlet aggregate stats for a project
 */
router.get('/gauntlet-stats', async (req, res) => {
  try {
    const { projectId } = req.query;
    if (!projectId) return res.status(400).json({ error: 'projectId required' });

    const { getLandingPageGauntletStats } = await import('../convexClient.js');
    const stats = await getLandingPageGauntletStats(projectId);

    if (!stats) {
      return res.json({ hasData: false, stats: null });
    }

    res.json({
      hasData: true,
      stats,
    });
  } catch (err) {
    console.error('[AgentMonitor] Gauntlet stats error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export { costRouter as agentCostRouter };
export default router;

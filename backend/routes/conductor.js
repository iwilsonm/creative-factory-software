import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  getConductorConfig, upsertConductorConfig, getAllConductorConfigs,
  getConductorAngles, getActiveConductorAngles, createConductorAngle, updateConductorAngle, deleteConductorAngle,
  getConductorRuns, createConductorRun,
  getConductorHealth, createConductorHealth,
  getConductorPlaybooks, getConductorPlaybook,
  getFixerPlaybooks, upsertFixerPlaybook,
  getFlexAdsByProject, getBatchesByProject,
  getAllProjects,
} from '../convexClient.js';

const router = Router();

// =============================================
// Conductor Config — per-project Director settings
// =============================================

// GET /api/conductor/config?projectId=xxx — query param variant (used by Creative Filter shell script)
router.get('/config', async (req, res) => {
  try {
    const { projectId } = req.query;
    if (!projectId) return res.status(400).json({ error: 'projectId required' });
    const config = await getConductorConfig(projectId);
    res.json(config || {});
  } catch (err) {
    console.error('[Conductor] Get config error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/conductor/config/:projectId
router.get('/config/:projectId', async (req, res) => {
  try {
    const config = await getConductorConfig(req.params.projectId);
    res.json({ config: config || null });
  } catch (err) {
    console.error('[Conductor] Get config error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/conductor/config/:projectId
router.put('/config/:projectId', async (req, res) => {
  try {
    // Whitelist allowed fields to prevent arbitrary field injection
    const allowedConfigFields = [
      'enabled', 'daily_flex_target', 'ads_per_batch', 'angle_mode',
      'angle_rotation', 'explore_ratio', 'run_schedule', 'posting_days',
      'score_threshold', 'auto_learn',
      'shopify_store_domain', 'shopify_access_token', 'shopify_client_id',
      'shopify_lander_template', 'pdp_url', 'lp_auto_enabled',
    ];
    const fields = {};
    for (const key of allowedConfigFields) {
      if (req.body[key] !== undefined) fields[key] = req.body[key];
    }
    await upsertConductorConfig(req.params.projectId, fields);
    const config = await getConductorConfig(req.params.projectId);
    res.json({ success: true, config });
  } catch (err) {
    console.error('[Conductor] Update config error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/conductor/configs — all project configs (for pipeline overview)
router.get('/configs', async (req, res) => {
  try {
    const configs = await getAllConductorConfigs();
    res.json({ configs });
  } catch (err) {
    console.error('[Conductor] Get all configs error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// Conductor Angles — angle library per project
// =============================================

// GET /api/conductor/angles/:projectId
router.get('/angles/:projectId', async (req, res) => {
  try {
    const angles = await getConductorAngles(req.params.projectId);
    res.json({ angles });
  } catch (err) {
    console.error('[Conductor] Get angles error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/conductor/angles/:projectId
router.post('/angles/:projectId', async (req, res) => {
  try {
    const { name, description, prompt_hints, source, status } = req.body;
    if (!name || !description) {
      return res.status(400).json({ error: 'Name and description are required' });
    }
    const id = uuidv4();
    await createConductorAngle({
      id,
      project_id: req.params.projectId,
      name,
      description,
      prompt_hints,
      source: source || 'manual',
      status: status || 'active',
    });
    res.json({ success: true, id });
  } catch (err) {
    console.error('[Conductor] Create angle error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/conductor/angles/:projectId/:angleId
router.put('/angles/:projectId/:angleId', async (req, res) => {
  try {
    // Whitelist allowed fields to prevent arbitrary field injection
    const allowedAngleFields = ['name', 'description', 'prompt_hints', 'status', 'source', 'focused'];
    const fields = {};
    for (const key of allowedAngleFields) {
      if (req.body[key] !== undefined) fields[key] = req.body[key];
    }
    await updateConductorAngle(req.params.angleId, fields);
    res.json({ success: true });
  } catch (err) {
    console.error('[Conductor] Update angle error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/conductor/angles/:projectId/:angleId
router.delete('/angles/:projectId/:angleId', async (req, res) => {
  try {
    // Retire instead of hard delete (preserves history)
    await updateConductorAngle(req.params.angleId, { status: 'retired' });
    res.json({ success: true });
  } catch (err) {
    console.error('[Conductor] Retire angle error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// Conductor Runs — audit log
// =============================================

// GET /api/conductor/runs/:projectId
router.get('/runs/:projectId', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const runs = await getConductorRuns(req.params.projectId, limit);
    res.json({ runs });
  } catch (err) {
    console.error('[Conductor] Get runs error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/conductor/run/:projectId — manual trigger
router.post('/run/:projectId', async (req, res) => {
  try {
    // Lazy-import to avoid circular deps — conductorEngine imports convexClient
    const { runDirectorForProject } = await import('../services/conductorEngine.js');
    const result = await runDirectorForProject(req.params.projectId, 'manual');
    res.json({ success: true, result });
  } catch (err) {
    console.error('[Conductor] Manual run error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/conductor/test-run/:projectId — test batch (bypasses windows/deficit)
router.post('/test-run/:projectId', async (req, res) => {
  try {
    const { runTestBatch } = await import('../services/conductorEngine.js');
    const result = await runTestBatch(req.params.projectId);
    res.json({ success: true, result });
  } catch (err) {
    console.error('[Conductor] Test run error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// Conductor Playbooks — per-angle learning memory
// =============================================

// GET /api/conductor/playbooks/:projectId
router.get('/playbooks/:projectId', async (req, res) => {
  try {
    const playbooks = await getConductorPlaybooks(req.params.projectId);
    res.json({ playbooks });
  } catch (err) {
    console.error('[Conductor] Get playbooks error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/conductor/playbooks/:projectId/:angleName
router.get('/playbooks/:projectId/:angleName', async (req, res) => {
  try {
    const playbook = await getConductorPlaybook(req.params.projectId, req.params.angleName);
    res.json({ playbook: playbook || null });
  } catch (err) {
    console.error('[Conductor] Get playbook error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// Learning Step — triggered after Filter scoring
// =============================================

// POST /api/conductor/learn — trigger learning analysis for a scored batch
router.post('/learn', async (req, res) => {
  try {
    const { projectId, angleName, scoredAds } = req.body;
    if (!projectId || !angleName) {
      return res.status(400).json({ error: 'projectId and angleName required' });
    }
    // Lazy import to avoid loading anthropic at route registration
    const { runLearningStep } = await import('../services/conductorLearning.js');
    const result = await runLearningStep(projectId, angleName, scoredAds || []);
    res.json({ success: true, result });
  } catch (err) {
    console.error('[Conductor] Learning step error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// Pipeline Overview — cross-project posting day status
// =============================================

// GET /api/conductor/pipeline-status
router.get('/pipeline-status', async (req, res) => {
  try {
    const configs = await getAllConductorConfigs();
    const projects = await getAllProjects();

    const status = await Promise.all(configs.filter(c => c.enabled).map(async (config) => {
      const project = projects.find(p => p.id === config.project_id);
      if (!project) return null;

      // Get flex ads for this project to count by posting_day
      const flexAds = await getFlexAdsByProject(config.project_id);
      const batches = await getBatchesByProject(config.project_id);

      // Count flex ads per posting day
      const flexByDay = {};
      for (const fa of flexAds) {
        if (fa.posting_day) {
          flexByDay[fa.posting_day] = (flexByDay[fa.posting_day] || 0) + 1;
        }
      }

      // Count in-progress batches per posting day
      const activeBatchesByDay = {};
      for (const b of batches) {
        if (b.posting_day && ['pending', 'generating_prompts', 'submitting', 'processing'].includes(b.status)) {
          activeBatchesByDay[b.posting_day] = (activeBatchesByDay[b.posting_day] || 0) + 1;
        }
      }

      return {
        project_id: config.project_id,
        project_name: project.name,
        brand_name: project.brand_name,
        daily_flex_target: config.daily_flex_target,
        flex_by_day: flexByDay,
        active_batches_by_day: activeBatchesByDay,
      };
    }));

    res.json({ projects: status.filter(Boolean) });
  } catch (err) {
    console.error('[Conductor] Pipeline status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// Conductor Health — Fixer monitoring log
// =============================================

// GET /api/conductor/health
router.get('/health', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const health = await getConductorHealth(limit);
    res.json({ health });
  } catch (err) {
    console.error('[Conductor] Get health error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/conductor/health — log a health check (from Fixer)
router.post('/health', async (req, res) => {
  try {
    const { externalId, agent, check_at, status, details, action_taken, batches_stuck, batches_recovered } = req.body;
    if (!externalId || !agent || !status) {
      return res.status(400).json({ error: 'externalId, agent, and status required' });
    }
    await createConductorHealth({
      externalId,
      agent,
      check_at: check_at || Date.now(),
      status,
      details: details || '',
      action_taken: action_taken || '',
      batches_stuck: batches_stuck || 0,
      batches_recovered: batches_recovered || 0,
    });
    res.json({ success: true });
  } catch (err) {
    console.error('[Conductor] Create health error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// =============================================
// Fixer Playbook — Fixer learning memory
// =============================================

// GET /api/conductor/fixer-playbooks
router.get('/fixer-playbooks', async (req, res) => {
  try {
    const playbooks = await getFixerPlaybooks();
    res.json({ playbooks });
  } catch (err) {
    console.error('[Conductor] Get fixer playbooks error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/conductor/fixer-playbooks — upsert a fixer playbook entry
router.post('/fixer-playbooks', async (req, res) => {
  try {
    const { issue_category, occurrences, last_occurred, root_causes, resolution_steps, prevention_hints, avg_resolution_ms, auto_resolved, escalated } = req.body;
    if (!issue_category) {
      return res.status(400).json({ error: 'issue_category required' });
    }
    await upsertFixerPlaybook({
      issue_category,
      occurrences: occurrences || 1,
      last_occurred: last_occurred || Date.now(),
      root_causes: root_causes || '',
      resolution_steps: resolution_steps || '',
      prevention_hints: prevention_hints || '',
      avg_resolution_ms: avg_resolution_ms || 0,
      auto_resolved: auto_resolved || 0,
      escalated: escalated || 0,
    });
    res.json({ success: true });
  } catch (err) {
    console.error('[Conductor] Upsert fixer playbook error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;

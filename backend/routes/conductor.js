import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  getConductorConfig, upsertConductorConfig, getAllConductorConfigs,
  getConductorAngles, getActiveConductorAngles, createConductorAngle, updateConductorAngle, deleteConductorAngle,
  getConductorRuns, createConductorRun,
  getConductorHealth, createConductorHealth,
  getConductorPlaybooks, getConductorPlaybook,
  getFixerPlaybooks, upsertFixerPlaybook,
  getConductorSlots,
  getFlexAdsByProject, getBatchesByProject,
  getProjectOptions,
  getBatchJob, getLandingPagesByBatchJob,
} from '../convexClient.js';
import { buildDescriptionFromBrief } from '../utils/angleParser.js';
import { streamService } from '../utils/sseHelper.js';

const router = Router();
const PIPELINE_STATUS_TTL_MS = 30 * 1000;
let pipelineStatusCache = {
  value: null,
  expiresAt: 0,
  inFlight: null,
};

function safeParseJSON(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function resetPipelineStatusCache() {
  pipelineStatusCache = {
    value: null,
    expiresAt: 0,
    inFlight: null,
  };
}

async function computePipelineStatus() {
  const [configs, projects] = await Promise.all([
    getAllConductorConfigs(),
    getProjectOptions(),
  ]);
  const projectMap = new Map(projects.map(project => [project.id, project]));

  const status = await Promise.all(configs.filter(c => c.enabled).map(async (config) => {
    const project = projectMap.get(config.project_id);
    if (!project) return null;

    const [flexAds, batches, slots] = await Promise.all([
      getFlexAdsByProject(config.project_id),
      getBatchesByProject(config.project_id),
      getConductorSlots(config.project_id),
    ]);

    const flexByDay = {};
    for (const fa of flexAds) {
      if (fa.posting_day) {
        flexByDay[fa.posting_day] = (flexByDay[fa.posting_day] || 0) + 1;
      }
    }

    const activeBatchesByDay = {};
    for (const batch of batches) {
      if (batch.posting_day && ['pending', 'generating_prompts', 'submitting', 'processing'].includes(batch.status)) {
        activeBatchesByDay[batch.posting_day] = (activeBatchesByDay[batch.posting_day] || 0) + 1;
      }
    }

    const slotsByDay = {};
    for (const slot of slots) {
      const key = slot.posting_day;
      if (!key) continue;
      if (!slotsByDay[key]) slotsByDay[key] = [];
      slotsByDay[key].push({
        slot_index: slot.slot_index,
        angle_name: slot.angle_name,
        status: slot.status,
        attempt_count: slot.attempt_count || 0,
        failure_reason: slot.failure_reason || null,
        produced_flex_ad_id: slot.produced_flex_ad_id || null,
        batch_ids: safeParseJSON(slot.batch_ids, []),
        diagnostics_summary: safeParseJSON(slot.diagnostics_summary, null),
      });
    }

    for (const day of Object.keys(slotsByDay)) {
      slotsByDay[day].sort((a, b) => (a.slot_index || 0) - (b.slot_index || 0));
    }

    return {
      project_id: config.project_id,
      project_name: project.name,
      brand_name: project.brand_name,
      daily_flex_target: config.daily_flex_target,
      flex_by_day: flexByDay,
      active_batches_by_day: activeBatchesByDay,
      slots_by_day: slotsByDay,
    };
  }));

  return { projects: status.filter(Boolean) };
}

function refreshPipelineStatusCache() {
  if (pipelineStatusCache.inFlight) {
    return pipelineStatusCache.inFlight;
  }

  pipelineStatusCache.inFlight = computePipelineStatus()
    .then((value) => {
      pipelineStatusCache.value = value;
      pipelineStatusCache.expiresAt = Date.now() + PIPELINE_STATUS_TTL_MS;
      pipelineStatusCache.inFlight = null;
      return value;
    })
    .catch((err) => {
      pipelineStatusCache.inFlight = null;
      throw err;
    });

  return pipelineStatusCache.inFlight;
}

async function getCachedPipelineStatus() {
  const now = Date.now();
  if (pipelineStatusCache.value && pipelineStatusCache.expiresAt > now) {
    return pipelineStatusCache.value;
  }

  if (pipelineStatusCache.value) {
    refreshPipelineStatusCache().catch((err) => {
      console.error('[Conductor] Pipeline refresh error:', err.message);
    });
    return pipelineStatusCache.value;
  }

  return refreshPipelineStatusCache();
}

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
      'headline_style', 'primary_text_style', 'meta_campaign_name',
      'meta_adset_defaults', 'default_campaign_id',
    ];
    const fields = {};
    for (const key of allowedConfigFields) {
      if (req.body[key] !== undefined) fields[key] = req.body[key];
    }
    await upsertConductorConfig(req.params.projectId, fields);
    resetPipelineStatusCache();
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

// GET /api/conductor/angles/:projectId/active
router.get('/angles/:projectId/active', async (req, res) => {
  try {
    const angles = await getActiveConductorAngles(req.params.projectId);
    res.json({ angles });
  } catch (err) {
    console.error('[Conductor] Get active angles error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/conductor/angles/:projectId
router.post('/angles/:projectId', async (req, res) => {
  try {
    const { name, description, prompt_hints, source, status,
      priority, frame, core_buyer, symptom_pattern, failed_solutions,
      current_belief, objection, emotional_state, scene,
      desired_belief_shift, tone, avoid_list } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }
    // Auto-compute description from structured fields if not provided
    const computedDescription = description || buildDescriptionFromBrief({
      core_buyer, symptom_pattern, objection, scene, desired_belief_shift
    });
    const id = uuidv4();
    await createConductorAngle({
      id,
      project_id: req.params.projectId,
      name,
      description: computedDescription,
      prompt_hints,
      source: source || 'manual',
      status: status || 'active',
      priority, frame, core_buyer, symptom_pattern, failed_solutions,
      current_belief, objection, emotional_state, scene,
      desired_belief_shift, tone, avoid_list,
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
    const allowedAngleFields = [
      'name', 'description', 'prompt_hints', 'status', 'source', 'focused', 'lp_enabled',
      'priority', 'frame', 'core_buyer', 'symptom_pattern', 'failed_solutions',
      'current_belief', 'objection', 'emotional_state', 'scene',
      'desired_belief_shift', 'tone', 'avoid_list', 'destination_urls',
    ];
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
    // Archive instead of hard delete (preserves history)
    await updateConductorAngle(req.params.angleId, { status: 'archived' });
    res.json({ success: true });
  } catch (err) {
    console.error('[Conductor] Archive angle error:', err.message);
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

// GET /api/conductor/run-batch-lp/:projectId/:batchId
router.get('/run-batch-lp/:projectId/:batchId', async (req, res) => {
  try {
    const { projectId, batchId } = req.params;
    const batch = await getBatchJob(batchId);
    if (!batch || batch.project_id !== projectId) {
      return res.status(404).json({ error: 'Batch not found' });
    }

    const landingPages = await getLandingPagesByBatchJob(batchId);
    const mappedPages = landingPages.map((page) => {
      const qaReport = safeParseJSON(page.qa_report, {});
      const smokeReport = safeParseJSON(page.smoke_test_report, {});
      const qaIssues = Array.isArray(qaReport?.issues) ? qaReport.issues : [];
      const smokeChecks = Array.isArray(smokeReport?.checks) ? smokeReport.checks : [];

      return {
        id: page.externalId,
        name: page.name || null,
        status: page.status || null,
        angle: page.angle || null,
        narrative_frame: page.narrative_frame || null,
        headline_text: page.headline_text || null,
        subheadline_text: page.subheadline_text || null,
        headline_frame_alignment_status: page.headline_frame_alignment_status || null,
        headline_frame_alignment_reason: page.headline_frame_alignment_reason || null,
        headline_uniqueness_status: page.headline_uniqueness_status || null,
        headline_uniqueness_reason: page.headline_uniqueness_reason || null,
        headline_duplicate_of_lp_id: page.headline_duplicate_of_lp_id || null,
        headline_history_status: page.headline_history_status || null,
        headline_history_reason: page.headline_history_reason || null,
        template_id: page.template_id || null,
        published_url: page.published_url || null,
        error_message: page.error_message || null,
        created_at: page.created_at || null,
        updated_at: page.updated_at || null,
        qa_status: page.qa_status || null,
        qa_score: page.qa_score ?? null,
        qa_issues_count: page.qa_issues_count ?? qaIssues.length,
        qa_summary: qaReport?.summary || null,
        qa_source: qaReport?.source || null,
        qa_issues: qaIssues,
        qa_categories: qaReport?.categories && typeof qaReport.categories === 'object' ? qaReport.categories : null,
        smoke_test_status: page.smoke_test_status || null,
        smoke_test_at: page.smoke_test_at || null,
        smoke_passed: typeof smokeReport?.passed === 'boolean' ? smokeReport.passed : null,
        smoke_failed_count: typeof smokeReport?.failedCount === 'number' ? smokeReport.failedCount : null,
        smoke_checks: smokeChecks,
        smoke_visible_placeholder_matches: Array.isArray(smokeReport?.visiblePlaceholderMatches) ? smokeReport.visiblePlaceholderMatches : [],
        smoke_raw_placeholder_matches: Array.isArray(smokeReport?.rawHtmlPlaceholderMatches) ? smokeReport.rawHtmlPlaceholderMatches : [],
        generation_attempts: page.generation_attempts ?? null,
        fix_attempts: page.fix_attempts ?? null,
        generation_duration_ms: page.generation_duration_ms ?? null,
        gauntlet_batch_id: page.gauntlet_batch_id || null,
        gauntlet_frame: page.gauntlet_frame || null,
        gauntlet_attempt: page.gauntlet_attempt ?? null,
        gauntlet_retry_type: page.gauntlet_retry_type || null,
        gauntlet_score: page.gauntlet_score ?? null,
        gauntlet_score_reasoning: page.gauntlet_score_reasoning || null,
        gauntlet_status: page.gauntlet_status || null,
        gauntlet_image_prescore_attempts: page.gauntlet_image_prescore_attempts ?? null,
        gauntlet_batch_started_at: page.gauntlet_batch_started_at || null,
        gauntlet_batch_completed_at: page.gauntlet_batch_completed_at || null,
      };
    });

    const scoredPages = mappedPages.filter((page) => typeof page.gauntlet_score === 'number');
    const summary = {
      total: mappedPages.length,
      passed: mappedPages.filter((page) => ['passed', 'published', 'passed_dry_run'].includes(page.gauntlet_status) || page.status === 'published').length,
      published: mappedPages.filter((page) => !!page.published_url || page.status === 'published').length,
      failed: mappedPages.filter((page) => ['failed', 'error', 'publish_failed', 'smoke_failed'].includes(page.status) || page.gauntlet_status === 'failed').length,
      headlinePassed: mappedPages.filter((page) =>
        page.headline_frame_alignment_status === 'passed' &&
        page.headline_uniqueness_status === 'passed' &&
        page.headline_history_status !== 'failed'
      ).length,
      avgScore: scoredPages.length > 0
        ? Math.round((scoredPages.reduce((sum, page) => sum + page.gauntlet_score, 0) / scoredPages.length) * 10) / 10
        : null,
      totalImagePrescoreAttempts: mappedPages.reduce((sum, page) => sum + (page.gauntlet_image_prescore_attempts || 0), 0),
      totalGenerationDurationMs: mappedPages.reduce((sum, page) => sum + (page.generation_duration_ms || 0), 0),
    };

    res.json({
      batch: {
        id: batch.id,
        angle_name: batch.angle_name || null,
        lp_primary_id: batch.lp_primary_id || null,
        lp_primary_url: batch.lp_primary_url || null,
        lp_primary_status: batch.lp_primary_status || null,
        lp_primary_error: batch.lp_primary_error || null,
        lp_primary_retry_count: batch.lp_primary_retry_count || 0,
        lp_secondary_id: batch.lp_secondary_id || null,
        lp_secondary_url: batch.lp_secondary_url || null,
        lp_secondary_status: batch.lp_secondary_status || null,
        lp_secondary_error: batch.lp_secondary_error || null,
        lp_secondary_retry_count: batch.lp_secondary_retry_count || 0,
        lp_narrative_frames: safeParseJSON(batch.lp_narrative_frames, []),
        gauntlet_lp_urls: safeParseJSON(batch.gauntlet_lp_urls, []),
      },
      summary,
      landingPages: mappedPages,
    });
  } catch (err) {
    console.error('[Conductor] Get run batch LP details error:', err.message);
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

// POST /api/conductor/test-run/:projectId — full pipeline: Director → batch → Gemini → Filter → Ready to Post
router.post('/test-run/:projectId', async (req, res) => {
  streamService(req, res, async (sendEvent) => {
    const { angle_id, generate_lp } = req.body || {};
    const { runFullTestPipeline } = await import('../services/conductorEngine.js');
    const result = await runFullTestPipeline(req.params.projectId, sendEvent, { angleOverride: angle_id || null, skipLPGen: generate_lp === false });
    if (result.pipeline_failed) {
      sendEvent({ type: 'error', message: result.failure_reason, ...result });
    } else if (result.run_in_background) {
      sendEvent({ type: 'background', ...result });
    } else {
      sendEvent({ type: 'complete', ...result });
    }
  });
});

// POST /api/conductor/test-run/cancel/:projectId — cancel active test run
router.post('/test-run/cancel/:projectId', async (req, res) => {
  try {
    const { cancelTestRun } = await import('../services/conductorEngine.js');
    const cancelled = cancelTestRun(req.params.projectId);
    res.json({ success: true, cancelled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/conductor/test-run/progress/:projectId — poll active test run progress (survives SSE disconnect)
router.get('/test-run/progress/:projectId', async (req, res) => {
  try {
    const { getActiveTestRunSnapshot } = await import('../services/conductorEngine.js');
    const active = await getActiveTestRunSnapshot(req.params.projectId);
    res.json({ active });
  } catch (err) {
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
    res.json(await getCachedPipelineStatus());
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

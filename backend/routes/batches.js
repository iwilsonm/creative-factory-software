import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth } from '../auth.js';
import {
  getProject, createBatchJob, getBatchJob, getBatchesByProject,
  updateBatchJob, deleteBatchJob, uploadBuffer
} from '../convexClient.js';
import { runBatch } from '../services/batchProcessor.js';
import { registerCronJob, unregisterCronJob, loadScheduledBatches } from '../services/scheduler.js';

const router = Router();
router.use(requireAuth);

/**
 * POST /:projectId/batches — Create a new batch job
 */
router.post('/:projectId/batches', async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const {
    generation_mode = 'mode1',
    batch_size = 5,
    angle,
    aspect_ratio = '1:1',
    template_image_id,
    template_image_ids,        // JSON string array of uploaded template IDs (multi-select)
    inspiration_image_id,
    inspiration_image_ids,     // JSON string array of drive template IDs (multi-select)
    product_image,
    product_image_mime,
    skip_product_image,
    scheduled = false,
    schedule_cron,
    run_immediately = true
  } = req.body;

  // Validate
  if (!['mode1', 'mode2'].includes(generation_mode)) {
    return res.status(400).json({ error: 'generation_mode must be "mode1" or "mode2".' });
  }
  // mode2 requires either single template_image_id or multi template_image_ids
  if (generation_mode === 'mode2' && !template_image_id && !template_image_ids) {
    return res.status(400).json({ error: 'template_image_id or template_image_ids is required for mode2.' });
  }
  const size = Math.max(1, Math.min(50, parseInt(batch_size) || 5));

  const id = uuidv4();

  // Upload product image to Convex storage if provided, else use project-level image
  let productImageStorageId = undefined;
  if (skip_product_image) {
    // Explicitly skip product image (user opted out)
    productImageStorageId = undefined;
  } else if (product_image && product_image_mime) {
    const buffer = Buffer.from(product_image, 'base64');
    productImageStorageId = await uploadBuffer(buffer, product_image_mime);
  } else if (project.product_image_storageId) {
    // Re-use the project-level product image (no need to re-upload)
    productImageStorageId = project.product_image_storageId;
  }

  try {
    await createBatchJob({
      id,
      project_id: req.params.projectId,
      generation_mode,
      batch_size: size,
      angle: angle || null,
      aspect_ratio,
      template_image_id: template_image_id || null,
      template_image_ids: template_image_ids || null,
      inspiration_image_id: inspiration_image_id || null,
      inspiration_image_ids: inspiration_image_ids || null,
      product_image_storageId: productImageStorageId,
      scheduled: !!scheduled,
      schedule_cron: schedule_cron || null
    });

    // If scheduled, register the cron job
    if (scheduled && schedule_cron) {
      const batch = await getBatchJob(id);
      registerCronJob(batch);
    }

    // If run immediately (and not just scheduled for later)
    if (run_immediately && !scheduled) {
      // Run in background — don't await
      runBatch(id).catch(err => {
        console.error(`[Batches API] Background batch ${id.slice(0, 8)} failed:`, err.message);
      });
    }

    const batch = await getBatchJob(id);
    res.status(201).json(batch);

  } catch (err) {
    console.error('[Batches API] Create error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /:projectId/batches — List all batch jobs for a project
 */
router.get('/:projectId/batches', async (req, res) => {
  const project = await getProject(req.params.projectId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const batches = await getBatchesByProject(req.params.projectId);
  res.json({ batches, total: batches.length });
});

/**
 * GET /:projectId/batches/:batchId — Get a single batch job
 */
router.get('/:projectId/batches/:batchId', async (req, res) => {
  const batch = await getBatchJob(req.params.batchId);
  if (!batch || batch.project_id !== req.params.projectId) {
    return res.status(404).json({ error: 'Batch job not found' });
  }
  res.json(batch);
});

/**
 * PUT /:projectId/batches/:batchId — Update batch config (schedule, etc.)
 */
router.put('/:projectId/batches/:batchId', async (req, res) => {
  const batch = await getBatchJob(req.params.batchId);
  if (!batch || batch.project_id !== req.params.projectId) {
    return res.status(404).json({ error: 'Batch job not found' });
  }

  const { scheduled, schedule_cron, angle, batch_size, aspect_ratio } = req.body;
  const updates = {};

  if (scheduled !== undefined) updates.scheduled = scheduled ? 1 : 0;
  if (schedule_cron !== undefined) updates.schedule_cron = schedule_cron;
  if (angle !== undefined) updates.angle = angle;
  if (batch_size !== undefined) updates.batch_size = batch_size;
  if (aspect_ratio !== undefined) updates.aspect_ratio = aspect_ratio;

  if (Object.keys(updates).length > 0) {
    await updateBatchJob(req.params.batchId, updates);
  }

  // Update cron registration (handles both edit and pause/resume)
  if (scheduled === true) {
    const updated = await getBatchJob(req.params.batchId);
    if (updated.schedule_cron) registerCronJob(updated);
  } else if (scheduled === false) {
    unregisterCronJob(req.params.batchId);
  }

  res.json(await getBatchJob(req.params.batchId));
});

/**
 * DELETE /:projectId/batches/:batchId — Delete/cancel a batch job
 */
router.delete('/:projectId/batches/:batchId', async (req, res) => {
  const batch = await getBatchJob(req.params.batchId);
  if (!batch || batch.project_id !== req.params.projectId) {
    return res.status(404).json({ error: 'Batch job not found' });
  }

  // Unregister cron if scheduled
  unregisterCronJob(req.params.batchId);

  await deleteBatchJob(req.params.batchId);
  res.json({ success: true, id: req.params.batchId });
});

/**
 * POST /:projectId/batches/:batchId/run — Manually trigger a batch job
 */
router.post('/:projectId/batches/:batchId/run', async (req, res) => {
  const batch = await getBatchJob(req.params.batchId);
  if (!batch || batch.project_id !== req.params.projectId) {
    return res.status(404).json({ error: 'Batch job not found' });
  }

  if (!['pending', 'completed', 'failed'].includes(batch.status)) {
    return res.status(400).json({ error: `Cannot run batch in "${batch.status}" state. Wait for current run to finish.` });
  }

  // Reset status
  await updateBatchJob(req.params.batchId, { status: 'pending', error_message: null });

  // Run in background
  runBatch(req.params.batchId).catch(err => {
    console.error(`[Batches API] Manual run ${req.params.batchId.slice(0, 8)} failed:`, err.message);
  });

  res.json({ success: true, message: 'Batch job started.', batch: await getBatchJob(req.params.batchId) });
});

/**
 * POST /:projectId/batches/:batchId/cancel — Cancel an active batch job
 */
router.post('/:projectId/batches/:batchId/cancel', async (req, res) => {
  const batch = await getBatchJob(req.params.batchId);
  if (!batch || batch.project_id !== req.params.projectId) {
    return res.status(404).json({ error: 'Batch job not found' });
  }

  if (!['generating_prompts', 'submitting', 'processing'].includes(batch.status)) {
    return res.status(400).json({ error: `Cannot cancel batch in "${batch.status}" state.` });
  }

  // If it has a Gemini batch job, attempt to cancel it
  if (batch.gemini_batch_job) {
    try {
      const { getClient } = await import('../services/gemini.js');
      const ai = getClient();
      await ai.batches.cancel({ name: batch.gemini_batch_job });
    } catch (err) {
      console.warn(`[Batches API] Could not cancel Gemini batch: ${err.message}`);
    }
  }

  await updateBatchJob(req.params.batchId, { status: 'failed', error_message: 'Cancelled by user' });
  res.json({ success: true, message: 'Batch cancelled.', batch: await getBatchJob(req.params.batchId) });
});

/**
 * POST /retry/:batchId — Retry a failed batch (used by Dacia Fixer)
 * This route is mounted at /api/batches/retry/:batchId (flat, no project nesting)
 */
router.post('/retry/:batchId', async (req, res) => {
  try {
    const batch = await getBatchJob(req.params.batchId);
    if (!batch) {
      return res.status(404).json({ error: 'Batch job not found' });
    }

    if (!['pending', 'completed', 'failed'].includes(batch.status)) {
      return res.status(400).json({ error: `Cannot retry batch in "${batch.status}" state.` });
    }

    await updateBatchJob(req.params.batchId, {
      status: 'pending',
      error_message: null,
      retry_count: 0,
    });

    runBatch(req.params.batchId).catch(err => {
      console.error(`[Batches API] Background retry failed for ${req.params.batchId}:`, err.message);
    });

    res.json({ success: true, message: 'Batch retry started.', batch: await getBatchJob(req.params.batchId) });
  } catch (err) {
    console.error('[Batches API] Retry error:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;

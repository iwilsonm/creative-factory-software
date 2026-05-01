import { Router } from 'express';
import crypto from 'crypto';
import { getSetting, getBatchJob, updateBatchJob } from '../convexClient.js';
import { requireAuth, requireRole } from '../auth.js';

const router = Router();
const LP_DISABLED_MESSAGE = 'LP Agent modules are not installed in this build.';

function secretsMatch(provided, expected) {
  if (!provided || !expected || provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

async function allowAuthOrFilterSecret(req, res, next) {
  if (req.session?.userId) {
    return requireAuth(req, res, () => requireRole('admin', 'manager')(req, res, next));
  }

  const expectedSecret = await getSetting('filter_shared_secret');
  const providedSecret = req.get('X-Filter-Secret');
  if (secretsMatch(providedSecret, expectedSecret)) {
    return next();
  }

  return res.status(401).json({ error: 'Not authenticated' });
}

router.get('/:projectId/lp-agent/config', requireAuth, async (req, res) => {
  res.json({
    config: {
      project_id: req.params.projectId,
      enabled: false,
      available: false,
      reason: LP_DISABLED_MESSAGE,
    },
  });
});

router.post('/:projectId/lp-agent/trigger-from-flex-ad', allowAuthOrFilterSecret, async (req, res) => {
  const { batch_id: batchId, flex_ad_id: flexAdId } = req.body || {};
  if (!batchId || !flexAdId) {
    return res.status(400).json({ error: 'batch_id and flex_ad_id are required.' });
  }

  const batch = await getBatchJob(batchId);
  if (!batch || batch.project_id !== req.params.projectId) {
    return res.status(404).json({ error: 'Batch not found.' });
  }

  try {
    await updateBatchJob(batchId, {
      flex_ad_id: flexAdId,
      lp_primary_status: 'skipped',
      lp_primary_error: LP_DISABLED_MESSAGE,
      lp_secondary_status: 'skipped',
      lp_secondary_error: LP_DISABLED_MESSAGE,
    });
  } catch (err) {
    console.warn(`[LP Agent] Could not mark batch ${batchId.slice(0, 8)} as LP-skipped:`, err.message);
  }

  res.status(409).json({
    success: false,
    disabled: true,
    error: LP_DISABLED_MESSAGE,
  });
});

export { LP_DISABLED_MESSAGE };
export default router;

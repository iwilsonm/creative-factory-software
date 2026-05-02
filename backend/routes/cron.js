// Phase 3 — Cron-only routes invoked by Vercel Cron.
//
// Vercel Cron sends Authorization: Bearer ${CRON_SECRET} automatically when
// CRON_SECRET is set in env vars. We validate with timing-safe compare and
// reject anything else with 401. Also adds a 30-min last-run guard to prevent
// replay storms even with valid secrets.

import { Router } from 'express';
import crypto from 'crypto';
import { runAllProjectsObservation } from '../services/observationTracker.js';
import { getSetting } from '../convexClient.js';

const router = Router();

const LAST_RUN_GUARD_MS = 30 * 60 * 1000; // 30 minutes

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

async function requireCronSecret(req, res, next) {
  // Vercel env var is named "Chron" in this deployment (Marco's naming choice).
  const secret = process.env.Chron;
  if (!secret) {
    console.error('[cron] env var "Chron" not configured — rejecting request');
    return res.status(500).json({ error: 'Cron not configured on this deployment.' });
  }
  const authHeader = req.headers.authorization || '';
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!timingSafeEqual(provided, secret)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

router.post('/observation', requireCronSecret, async (req, res) => {
  try {
    const lastRunRaw = await getSetting('phase3_last_cron_run_at');
    if (lastRunRaw) {
      const last = parseInt(lastRunRaw, 10);
      if (Number.isFinite(last) && Date.now() - last < LAST_RUN_GUARD_MS) {
        return res.status(200).json({
          skipped: true,
          reason: `Last run was ${Math.round((Date.now() - last) / 1000)}s ago — too soon. Guard threshold: ${LAST_RUN_GUARD_MS / 1000}s.`,
        });
      }
    }
    const result = await runAllProjectsObservation();
    res.json({ success: true, result });
  } catch (err) {
    console.error('[cron observation] failed:', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;

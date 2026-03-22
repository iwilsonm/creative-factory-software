import express from 'express';
import session from 'express-session';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

import { getSetting, setSetting, backfillProjectStats } from './convexClient.js';
import ConvexSessionStore from './ConvexSessionStore.js';
import { requireAuth, requireRole, migrateToMultiUser } from './auth.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import projectRoutes from './routes/projects.js';
import settingsRoutes from './routes/settings.js';
import documentRoutes from './routes/documents.js';
import uploadRoutes from './routes/upload.js';
import driveRoutes, { inspirationRouter } from './routes/drive.js';
import templateRoutes from './routes/templates.js';
import adRoutes from './routes/ads.js';
import batchRoutes from './routes/batches.js';
import costsRoutes from './routes/costs.js';
import deploymentRoutes from './routes/deployments.js';
import quoteMiningRoutes from './routes/quoteMining.js';
import chatRoutes from './routes/chat.js';
import metaRoutes, { metaCallbackRouter } from './routes/meta.js';
import landingPageRoutes from './routes/landingPages.js';
import lpTemplateRoutes from './routes/lpTemplates.js';
import agentMonitorRoutes, { agentCostRouter } from './routes/agentMonitor.js';
import conductorRoutes from './routes/conductor.js';
import lpAgentRoutes from './routes/lpAgent.js';
import cmoRoutes from './routes/cmo.js';
import salesPageRoutes from './routes/salesPages.js';
import rateLimit from 'express-rate-limit';
import { initScheduler, getSchedulerStatus } from './services/scheduler.js';
import { getRateLimiterStats } from './services/rateLimiter.js';
import { syncOpenAICosts, refreshGeminiRates } from './services/costTracker.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

// Patch Express 4 to catch async route handler errors.
// Without this, an async handler that throws creates an unhandledRejection
// and the request hangs forever (Express 4 does not catch async errors).
// This replaces Layer.handle_request to capture the Promise returned by async handlers
// and forward rejections to next(), where Express's error middleware handles them.
import Layer from 'express/lib/router/layer.js';
Layer.prototype.handle_request = function handle(req, res, next) {
  const fn = this.handle;
  if (fn.length > 3) return next(); // skip error-handling middleware
  try {
    const result = fn(req, res, next);
    if (result && typeof result.catch === 'function') {
      result.catch(next);
    }
  } catch (err) {
    next(err);
  }
};

// Global error handlers — log and let PM2 handle restart
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
  process.exit(1); // Let PM2 restart
});

// Wrap startup in async IIFE since getSetting is now async
(async () => {
  // Trust proxy when behind Nginx (needed for rate limiting, secure cookies)
  if (process.env.NODE_ENV === 'production') {
    app.set('trust proxy', 1);
  }

  // Disable ETags for API responses — 304s through the Vite dev proxy
  // cause empty response bodies, breaking fetch().json() on the frontend
  app.set('etag', false);

  // Generate or retrieve session secret
  let sessionSecret = await getSetting('session_secret');
  if (!sessionSecret) {
    sessionSecret = crypto.randomBytes(32).toString('hex');
    await setSetting('session_secret', sessionSecret);
  }

  // Request logging
  app.use((req, res, next) => {
    const start = Date.now();
    const url = req.originalUrl || req.url;
    if (url.startsWith('/api/') && !url.includes('/health')) {
      console.log(`[REQ] ${req.method} ${url}`);
    }
    res.on('finish', () => {
      if (url.startsWith('/api/') && !url.includes('/health')) {
        console.log(`[REQ] ${req.method} ${url} → ${res.statusCode} (${Date.now()-start}ms)`);
      }
    });
    next();
  });

  // Middleware
  app.use(compression());
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        fontSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "blob:", "https://*.convex.cloud", "https://*.googleapis.com", "https://*.fbcdn.net"],
        connectSrc: ["'self'", "https://*.convex.cloud", "https://api.anthropic.com", "https://api.openai.com"],
        frameSrc: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
      },
    },
  }));
  app.use(cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true
  }));
  app.use(express.json({ limit: '50mb' }));

  // Session — stored in Convex (persists across PM2 restarts)
  app.use(session({
    store: new ConvexSessionStore(),
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
    }
  }));

  // Rate limiting for expensive/LLM-triggering endpoints
  const llmRateLimit = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 10, // 10 requests per minute per user
    keyGenerator: (req) => req.session?.userId || req.ip,
    message: { error: 'Too many requests. Please wait a moment before trying again.' },
    standardHeaders: true,
    legacyHeaders: false,
  });
  // Apply to generation-heavy routes
  app.use('/api/projects/:id/generate-docs', llmRateLimit);
  app.use('/api/projects/:id/generate-ad', llmRateLimit);
  app.use('/api/projects/:id/generate-landing-page', llmRateLimit);
  app.use('/api/projects/:id/lp-agent/generate-test', llmRateLimit);
  app.use('/api/projects/:id/lp-agent/gauntlet-test', llmRateLimit);
  app.use('/api/projects/:id/lp-agent/shopify/connect', llmRateLimit);
  app.use('/api/deployments/generate-ad-copy', llmRateLimit);
  app.use('/api/deployments/generate-ad-headlines', llmRateLimit);
  app.use('/api/deployments/filter/generate-copy', llmRateLimit);
  app.use('/api/quote-mining/start', llmRateLimit);
  app.use('/api/conductor/run', llmRateLimit);
  app.use('/api/conductor/learn', llmRateLimit);
  app.use('/api/cmo/run', llmRateLimit);
  app.use('/api/cmo/dry-run', llmRateLimit);
  app.use('/api/projects/:id/generate-sales-page', llmRateLimit);
  app.use('/api/projects/:id/sales-pages/install-theme', llmRateLimit);
  // NOTE: Generated images are no longer served from local disk.
  // They are served via 302 redirect to Convex storage URLs in the ads route.

  // Migrate legacy single-user auth to multi-user (runs once, idempotent)
  await migrateToMultiUser();

  // Repair missing stored project counters once after startup so list pages can
  // use lightweight summary queries without per-project scans.
  backfillProjectStats()
    .then(({ updated }) => {
      if (updated > 0) {
        console.log(`[Projects] Backfilled stored stats for ${updated} project(s)`);
      }
    })
    .catch((err) => {
      console.error('[Projects] Stored stats backfill error:', err.message);
    });

  // Health check — no auth required (used by Dacia Fixer health probes)
  app.get('/api/health', async (req, res) => {
    const checks = {};

    // Convex connectivity — try a lightweight query
    try {
      await getSetting('session_secret');
      checks.convex = 'ok';
    } catch (e) {
      checks.convex = 'error';
    }

    // Scheduler status
    checks.scheduler = getSchedulerStatus();

    // Rate limiter
    checks.rateLimiter = getRateLimiterStats();

    // Memory
    const mem = process.memoryUsage();
    checks.memory = {
      rss_mb: Math.round(mem.rss / 1024 / 1024),
      heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
      heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
    };

    // Uptime
    checks.uptime_seconds = Math.round(process.uptime());

    // Disk usage (Linux)
    try {
      const { execSync } = await import('child_process');
      const df = execSync("df -h /opt/ad-platform 2>/dev/null | awk 'NR==2 {print $5}'", { encoding: 'utf8', timeout: 3000 }).trim();
      checks.disk_usage_pct = parseInt(df) || null;
    } catch { checks.disk_usage_pct = null; }

    // Nginx process check
    try {
      const { execSync } = await import('child_process');
      const count = execSync('pgrep -c nginx 2>/dev/null || echo 0', { encoding: 'utf8', timeout: 2000 }).trim();
      checks.nginx = parseInt(count) > 0 ? 'ok' : 'down';
    } catch { checks.nginx = 'unknown'; }

    const overall = checks.convex === 'ok' ? 'ok' : 'degraded';
    res.json({ status: overall, timestamp: new Date().toISOString(), checks });
  });

  // Routes — auth (no role restriction)
  app.use('/api/auth', authRoutes);
  // Meta OAuth callback — no auth (sameSite: 'strict' blocks cookie on cross-site redirect)
  app.use('/api', metaCallbackRouter);
  // Localhost-only guard — agent scripts call these via curl from the VPS
  const localhostOnly = (req, res, next) => {
    const ip = req.ip || req.connection?.remoteAddress;
    if (['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return next();
    res.status(403).json({ error: 'Forbidden' });
  };
  // Routes — agent cost logging (localhost only)
  app.use('/api/agent-cost', localhostOnly, agentCostRouter);
  // Agent-triggered endpoints (localhost only)
  app.post('/api/agent-cost/sync-openai', localhostOnly, async (req, res) => {
    try {
      await syncOpenAICosts();
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  app.post('/api/agent-cost/refresh-gemini-rates', localhostOnly, async (req, res) => {
    try {
      const result = await refreshGeminiRates();
      res.json({ success: true, refreshed: result.refreshed });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  // Routes — admin only
  app.use('/api/users', userRoutes);
  app.use('/api/settings', settingsRoutes);
  // Routes — projects (all roles can list/view projects for navigation)
  app.use('/api/projects', projectRoutes);
  // Routes — deployments (poster has limited access — controlled per-route inside)
  // IMPORTANT: Must be mounted BEFORE broad /api routes with requireRole('admin', 'manager')
  // because Express runs middleware in order and those broad /api mounts would block poster users
  // from reaching deployment routes (costsRoutes and metaRoutes are mounted on /api prefix)
  app.use('/api', deploymentRoutes);
  // Routes — admin/manager only
  app.use('/api/projects', requireAuth, requireRole('admin', 'manager'), documentRoutes);
  app.use('/api/upload', requireAuth, requireRole('admin', 'manager'), uploadRoutes);
  app.use('/api/drive', requireAuth, requireRole('admin', 'manager'), driveRoutes);
  app.use('/api/projects', requireAuth, requireRole('admin', 'manager'), inspirationRouter);
  app.use('/api/projects', requireAuth, requireRole('admin', 'manager'), templateRoutes);
  app.use('/api/projects', requireAuth, requireRole('admin', 'manager'), adRoutes);
  app.use('/api/projects', requireAuth, requireRole('admin', 'manager'), batchRoutes);
  app.use('/api/batches', requireAuth, requireRole('admin', 'manager'), batchRoutes);  // Flat mount for Dacia Fixer retry endpoint
  app.use('/api', requireAuth, requireRole('admin', 'manager'), costsRoutes);
  app.use('/api/projects', requireAuth, requireRole('admin', 'manager'), quoteMiningRoutes);
  app.use('/api/projects', requireAuth, requireRole('admin', 'manager'), chatRoutes);
  app.use('/api', requireAuth, requireRole('admin', 'manager'), metaRoutes);
  app.use('/api/projects', requireAuth, requireRole('admin', 'manager'), landingPageRoutes);
  app.use('/api/projects', requireAuth, requireRole('admin', 'manager'), lpTemplateRoutes);
  // Routes — agent monitor (admin only)
  app.use('/api/agent-monitor', requireAuth, requireRole('admin'), agentMonitorRoutes);
  app.use('/api/conductor', requireAuth, requireRole('admin', 'manager'), conductorRoutes);
  app.use('/api/projects', requireAuth, requireRole('admin', 'manager'), lpAgentRoutes);
  app.use('/api/cmo', requireAuth, requireRole('admin', 'manager'), cmoRoutes);
  app.use('/api/projects', requireAuth, requireRole('admin', 'manager'), salesPageRoutes);

  // Catch-all error handler
  app.use((err, req, res, _next) => {
    console.error(`[ERROR] ${req.method} ${req.path}:`, err.message);
    res.status(err.status || 500).json({
      error: err.message || 'Internal server error',
    });
  });

  // Serve frontend in production
  if (process.env.NODE_ENV === 'production') {
    const frontendDist = path.join(__dirname, '..', 'frontend', 'dist');
    // Vite hashed assets (JS/CSS) — cache for 1 year (immutable content-hash filenames)
    app.use('/assets', express.static(path.join(frontendDist, 'assets'), {
      maxAge: '1y',
      immutable: true
    }));
    // Other static files (favicon, etc.) — short cache
    app.use(express.static(frontendDist, {
      maxAge: '5m',
      setHeaders: (res, filePath) => {
        // Never cache index.html — ensures new deploys are picked up immediately
        if (filePath.endsWith('index.html')) {
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        }
      }
    }));
    app.get('*', (req, res) => {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.sendFile(path.join(frontendDist, 'index.html'));
    });
  }

  app.listen(PORT, () => {
    console.log(`Ad Platform backend running on port ${PORT}`);
    initScheduler();
  });
})().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

import express from 'express';
import session from 'express-session';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

import { getSetting, setSetting } from './convexClient.js';
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
import metaRoutes from './routes/meta.js';
import landingPageRoutes from './routes/landingPages.js';
import { initScheduler, getSchedulerStatus } from './services/scheduler.js';
import { getRateLimiterStats } from './services/rateLimiter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

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

  // Generate or retrieve session secret
  let sessionSecret = await getSetting('session_secret');
  if (!sessionSecret) {
    sessionSecret = crypto.randomBytes(32).toString('hex');
    await setSetting('session_secret', sessionSecret);
  }

  // Middleware
  app.use(compression());
  app.use(helmet({ contentSecurityPolicy: false }));
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

  // NOTE: Generated images are no longer served from local disk.
  // They are served via 302 redirect to Convex storage URLs in the ads route.

  // Migrate legacy single-user auth to multi-user (runs once, idempotent)
  await migrateToMultiUser();

  // Routes — auth (no role restriction)
  app.use('/api/auth', authRoutes);
  // Routes — admin only
  app.use('/api/users', userRoutes);
  app.use('/api/settings', settingsRoutes);
  // Routes — projects (all roles can list/view projects for navigation)
  app.use('/api/projects', projectRoutes);
  // Routes — admin/manager only
  app.use('/api/projects', requireAuth, requireRole('admin', 'manager'), documentRoutes);
  app.use('/api/upload', requireAuth, requireRole('admin', 'manager'), uploadRoutes);
  app.use('/api/drive', requireAuth, requireRole('admin', 'manager'), driveRoutes);
  app.use('/api/projects', requireAuth, requireRole('admin', 'manager'), inspirationRouter);
  app.use('/api/projects', requireAuth, requireRole('admin', 'manager'), templateRoutes);
  app.use('/api/projects', requireAuth, requireRole('admin', 'manager'), adRoutes);
  app.use('/api/projects', requireAuth, requireRole('admin', 'manager'), batchRoutes);
  app.use('/api', requireAuth, requireRole('admin', 'manager'), costsRoutes);
  app.use('/api/projects', requireAuth, requireRole('admin', 'manager'), quoteMiningRoutes);
  app.use('/api/projects', requireAuth, requireRole('admin', 'manager'), chatRoutes);
  app.use('/api', requireAuth, requireRole('admin', 'manager'), metaRoutes);
  app.use('/api/projects', requireAuth, requireRole('admin', 'manager'), landingPageRoutes);
  // Routes — deployments (poster has limited access — controlled per-route inside)
  app.use('/api', deploymentRoutes);

  // Health check — real connectivity + operational checks
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

    const overall = checks.convex === 'ok' ? 'ok' : 'degraded';
    res.json({ status: overall, timestamp: new Date().toISOString(), checks });
  });

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
    // Other static files (index.html, favicon) — short cache to pick up new deploys
    app.use(express.static(frontendDist, {
      maxAge: '5m'
    }));
    app.get('*', (req, res) => {
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

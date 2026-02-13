import express from 'express';
import session from 'express-session';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

import { getSetting, setSetting } from './convexClient.js';
import authRoutes from './routes/auth.js';
import projectRoutes from './routes/projects.js';
import settingsRoutes from './routes/settings.js';
import documentRoutes from './routes/documents.js';
import uploadRoutes from './routes/upload.js';
import driveRoutes, { inspirationRouter } from './routes/drive.js';
import templateRoutes from './routes/templates.js';
import adRoutes from './routes/ads.js';
import batchRoutes from './routes/batches.js';
import costsRoutes from './routes/costs.js';
import { initScheduler } from './services/scheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

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

  // Session
  app.use(session({
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

  // Routes
  app.use('/api/auth', authRoutes);
  app.use('/api/projects', projectRoutes);
  app.use('/api/projects', documentRoutes);
  app.use('/api/settings', settingsRoutes);
  app.use('/api/upload', uploadRoutes);
  app.use('/api/drive', driveRoutes);
  app.use('/api/projects', inspirationRouter);
  app.use('/api/projects', templateRoutes);
  app.use('/api/projects', adRoutes);
  app.use('/api/projects', batchRoutes);
  app.use('/api', costsRoutes);

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
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

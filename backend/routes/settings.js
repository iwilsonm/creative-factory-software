import { Router } from 'express';
import { requireAuth, requireRole } from '../auth.js';
import { getSetting, setSetting, getAllSettings, getDashboardTodos, replaceDashboardTodos } from '../convexClient.js';
import { getDriveClient } from './drive.js';
import { refreshGeminiRates } from '../services/costTracker.js';

const router = Router();
router.use(requireAuth, requireRole('admin'));

// Sensitive keys that should be masked when returning
const SENSITIVE_KEYS = ['auth_password_hash', 'session_secret'];
const API_KEY_KEYS = ['openai_api_key', 'openai_admin_key', 'gemini_api_key', 'anthropic_api_key', 'cloudflare_api_token'];

// Get all settings (mask sensitive values)
router.get('/', async (req, res) => {
  const settings = await getAllSettings();
  const masked = { ...settings };

  for (const key of SENSITIVE_KEYS) {
    delete masked[key];
  }
  for (const key of API_KEY_KEYS) {
    if (masked[key]) {
      masked[key] = masked[key].slice(0, 8) + '...' + masked[key].slice(-4);
    }
  }

  res.json(masked);
});

// Update settings
router.put('/', async (req, res) => {
  const allowed = [
    'openai_api_key',
    'openai_admin_key',
    'gemini_api_key',
    'anthropic_api_key',
    'default_drive_folder_id',
    'gemini_rate_1k',
    'gemini_rate_2k',
    'gemini_rate_4k',
    'openai_image_rate_per_image',
    'cloudflare_account_id',
    'cloudflare_api_token',
    'cloudflare_pages_projects',
    'pinned_project_ids',  // JSON array of project externalIds (global pinning)
  ];

  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      await setSetting(key, req.body[key]);
    }
  }

  res.json({ success: true });
});

// Test OpenAI connection
router.post('/test-openai', async (req, res) => {
  const apiKey = await getSetting('openai_api_key');
  if (!apiKey) return res.status(400).json({ error: 'OpenAI API key not configured' });

  try {
    const response = await fetch('https://api.openai.com/v1/models', {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    if (!response.ok) {
      return res.status(400).json({ error: `OpenAI API returned ${response.status}` });
    }
    res.json({ success: true, message: 'OpenAI API key is valid' });
  } catch (err) {
    res.status(500).json({ error: `Connection failed: ${err.message}` });
  }
});

// Phase 2 (PEF item G) — verify a specific OpenAI chat model is callable
// before Ian saves it as `openai_lp_image_strategy_model`. Catches typos and
// model deprecations at config time instead of at runtime mid-generation.
router.post('/test-model', async (req, res) => {
  const { model } = req.body || {};
  if (!model || typeof model !== 'string') {
    return res.status(400).json({ error: 'model (string) required in body' });
  }
  const apiKey = await getSetting('openai_api_key');
  if (!apiKey) return res.status(400).json({ error: 'OpenAI API key not configured' });

  try {
    // Fire a 1-token chat call. If the model is invalid OpenAI returns 404
    // model_not_found. If it's valid, the call returns a tiny response.
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: model.trim(),
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      }),
    });

    if (response.ok) {
      return res.json({ success: true, model: model.trim(), message: `Model "${model.trim()}" is available.` });
    }

    let errorBody = null;
    try { errorBody = await response.json(); } catch { errorBody = null; }
    const errorCode = errorBody?.error?.code || null;
    const errorMsg = errorBody?.error?.message || `HTTP ${response.status}`;

    if (response.status === 404 || errorCode === 'model_not_found') {
      return res.status(400).json({
        error: `Model "${model.trim()}" not available. ${errorMsg}`,
        code: 'model_not_found',
      });
    }
    return res.status(400).json({ error: errorMsg, code: errorCode });
  } catch (err) {
    res.status(500).json({ error: `Connection failed: ${err.message}` });
  }
});

// Test Gemini connection
router.post('/test-gemini', async (req, res) => {
  const apiKey = await getSetting('gemini_api_key');
  if (!apiKey) return res.status(400).json({ error: 'Gemini API key not configured' });

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    if (!response.ok) {
      return res.status(400).json({ error: `Gemini API returned ${response.status}` });
    }
    res.json({ success: true, message: 'Gemini API key is valid' });
  } catch (err) {
    res.status(500).json({ error: `Connection failed: ${err.message}` });
  }
});

// Test Google Drive connection
router.post('/test-drive', async (req, res) => {
  try {
    const drive = getDriveClient();
    const response = await drive.about.get({ fields: 'user' });
    res.json({
      success: true,
      message: `Connected as ${response.data.user?.displayName || 'service account'}`
    });
  } catch (err) {
    res.status(500).json({ error: `Drive connection failed: ${err.message}` });
  }
});

// Test Anthropic connection
router.post('/test-anthropic', async (req, res) => {
  const apiKey = await getSetting('anthropic_api_key');
  if (!apiKey) return res.status(400).json({ error: 'Anthropic API key not configured' });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 5,
        messages: [{ role: 'user', content: 'Hello' }]
      })
    });
    if (!response.ok) {
      const body = await response.text();
      return res.status(400).json({ error: `Anthropic API returned ${response.status}: ${body.slice(0, 200)}` });
    }
    res.json({ success: true, message: 'Anthropic API key is valid' });
  } catch (err) {
    res.status(500).json({ error: `Connection failed: ${err.message}` });
  }
});

// =============================================
// Dashboard To-Do List (dedicated Convex table)
// =============================================

router.get('/todos', async (req, res) => {
  try {
    const todos = await getDashboardTodos();
    res.json({ todos });
  } catch {
    res.json({ todos: [] });
  }
});

router.put('/todos', async (req, res) => {
  const { todos } = req.body;
  if (!Array.isArray(todos)) return res.status(400).json({ error: 'todos must be an array' });
  await replaceDashboardTodos(todos);
  res.json({ success: true });
});

// Refresh Gemini image rates from Google pricing page
router.post('/refresh-gemini-rates', async (req, res) => {
  try {
    const result = await refreshGeminiRates();
    if (result.refreshed) {
      res.json({ success: true, rates: result.rates });
    } else {
      res.json({ success: false, message: result.reason });
    }
  } catch (err) {
    res.status(500).json({ error: `Rate refresh failed: ${err.message}` });
  }
});

export default router;

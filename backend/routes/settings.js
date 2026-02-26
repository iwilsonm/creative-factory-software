import { Router } from 'express';
import { requireAuth, requireRole } from '../auth.js';
import { getSetting, setSetting, getAllSettings, getDashboardTodos, replaceDashboardTodos } from '../convexClient.js';
import { getDriveClient } from './drive.js';
import { refreshGeminiRates } from '../services/costTracker.js';

const router = Router();
router.use(requireAuth, requireRole('admin'));

// Sensitive keys that should be masked when returning
const SENSITIVE_KEYS = ['auth_password_hash', 'session_secret'];
const API_KEY_KEYS = ['openai_api_key', 'openai_admin_key', 'gemini_api_key', 'perplexity_api_key', 'anthropic_api_key', 'cloudflare_api_token'];

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
    'perplexity_api_key',
    'anthropic_api_key',
    'default_drive_folder_id',
    'gemini_rate_1k',
    'gemini_rate_2k',
    'gemini_rate_4k',
    'cloudflare_account_id',
    'cloudflare_api_token',
    'cloudflare_pages_projects'
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

// Test Perplexity connection
router.post('/test-perplexity', async (req, res) => {
  const apiKey = await getSetting('perplexity_api_key');
  if (!apiKey) return res.status(400).json({ error: 'Perplexity API key not configured' });

  try {
    const response = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'sonar',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 5
      })
    });
    if (!response.ok) {
      const body = await response.text();
      return res.status(400).json({ error: `Perplexity API returned ${response.status}: ${body.slice(0, 200)}` });
    }
    res.json({ success: true, message: 'Perplexity API key is valid' });
  } catch (err) {
    res.status(500).json({ error: `Connection failed: ${err.message}` });
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

// =============================================
// =============================================
// Headline Generator Reference Docs (3 documents — powers Copywriter headline generation)
// =============================================

const HEADLINE_REF_KEYS = {
  engine: 'headline_ref_engine',
  greatest: 'headline_ref_greatest',
  swipe: 'headline_ref_swipe',
};

// Get all 3 reference docs
router.get('/headline-references', async (req, res) => {
  try {
    const [engine, greatest, swipe] = await Promise.all([
      getSetting('headline_ref_engine'),
      getSetting('headline_ref_greatest'),
      getSetting('headline_ref_swipe'),
    ]);
    res.json({
      engine: engine || null,
      greatest: greatest || null,
      swipe: swipe || null,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch headline references' });
  }
});

// Save one reference doc
router.put('/headline-references/:docKey', async (req, res) => {
  try {
    const settingsKey = HEADLINE_REF_KEYS[req.params.docKey];
    if (!settingsKey) return res.status(400).json({ error: 'Invalid docKey. Must be: engine, greatest, or swipe' });

    const { content } = req.body;
    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Content is required' });
    }
    await setSetting(settingsKey, content.trim());
    res.json({ success: true, charCount: content.trim().length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save headline reference' });
  }
});

// Delete one reference doc
router.delete('/headline-references/:docKey', async (req, res) => {
  try {
    const settingsKey = HEADLINE_REF_KEYS[req.params.docKey];
    if (!settingsKey) return res.status(400).json({ error: 'Invalid docKey. Must be: engine, greatest, or swipe' });

    await setSetting(settingsKey, '');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete headline reference' });
  }
});

export default router;

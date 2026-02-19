import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { getSetting, setSetting, getAllSettings } from '../convexClient.js';
import { getDriveClient } from './drive.js';
import { refreshGeminiRates } from '../services/costTracker.js';

const router = Router();
router.use(requireAuth);

// Sensitive keys that should be masked when returning
const SENSITIVE_KEYS = ['auth_password_hash', 'session_secret'];
const API_KEY_KEYS = ['openai_api_key', 'openai_admin_key', 'gemini_api_key'];

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
    'default_drive_folder_id',
    'gemini_rate_1k',
    'gemini_rate_2k',
    'gemini_rate_4k'
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

// =============================================
// Dashboard To-Do List (stored as JSON in settings)
// =============================================

router.get('/todos', async (req, res) => {
  try {
    const raw = await getSetting('dashboard_todos');
    const todos = raw ? JSON.parse(raw) : [];
    res.json({ todos });
  } catch {
    res.json({ todos: [] });
  }
});

router.put('/todos', async (req, res) => {
  const { todos } = req.body;
  if (!Array.isArray(todos)) return res.status(400).json({ error: 'todos must be an array' });
  await setSetting('dashboard_todos', JSON.stringify(todos));
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
// Headline Reference Document (global, stored in settings)
// =============================================

router.get('/headline-reference', async (req, res) => {
  try {
    const content = await getSetting('headline_reference_content');
    res.json({ content: content || null });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch headline reference' });
  }
});

router.put('/headline-reference', async (req, res) => {
  try {
    const { content } = req.body;
    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Content is required' });
    }
    await setSetting('headline_reference_content', content.trim());
    res.json({ success: true, charCount: content.trim().length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save headline reference' });
  }
});

router.delete('/headline-reference', async (req, res) => {
  try {
    await setSetting('headline_reference_content', '');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete headline reference' });
  }
});

export default router;

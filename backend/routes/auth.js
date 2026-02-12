import { Router } from 'express';
import bcrypt from 'bcrypt';
import rateLimit from 'express-rate-limit';
import { getSetting, setSetting } from '../convexClient.js';
import { isSetupComplete } from '../auth.js';

const router = Router();

const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'Too many login attempts. Try again in a minute.' }
});

// Check session status + whether setup is done
router.get('/session', async (req, res) => {
  const setupDone = await isSetupComplete();
  res.json({
    authenticated: !!(req.session && req.session.authenticated),
    username: req.session?.username || null,
    setupComplete: setupDone
  });
});

// First-run setup — create account
router.post('/setup', async (req, res) => {
  if (await isSetupComplete()) {
    return res.status(400).json({ error: 'Setup already completed' });
  }
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  const hash = await bcrypt.hash(password, 12);
  await setSetting('auth_username', username);
  await setSetting('auth_password_hash', hash);

  req.session.authenticated = true;
  req.session.username = username;

  res.json({ success: true });
});

// Login
router.post('/login', loginLimiter, async (req, res) => {
  if (!(await isSetupComplete())) {
    return res.status(400).json({ error: 'Setup not completed. Please run setup first.' });
  }
  const { username, password } = req.body;
  const storedUsername = await getSetting('auth_username');
  const storedHash = await getSetting('auth_password_hash');

  if (username !== storedUsername) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const match = await bcrypt.compare(password, storedHash);
  if (!match) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  req.session.authenticated = true;
  req.session.username = username;

  res.json({ success: true, username });
});

// Logout
router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: 'Logout failed' });
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

// Change password
router.put('/password', async (req, res) => {
  if (!req.session?.authenticated) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current and new password required' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }

  const storedHash = await getSetting('auth_password_hash');
  const match = await bcrypt.compare(currentPassword, storedHash);
  if (!match) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  const hash = await bcrypt.hash(newPassword, 12);
  await setSetting('auth_password_hash', hash);

  res.json({ success: true });
});

export default router;

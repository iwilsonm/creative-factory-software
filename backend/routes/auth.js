import { Router } from 'express';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import rateLimit from 'express-rate-limit';
import { getUserByUsername, getUserByExternalId, createUser, updateUser, updateUserPassword, getUserCount } from '../convexClient.js';
import { requireAuth, isSetupComplete } from '../auth.js';
import { validateStrongPassword } from '../security.js';

const router = Router();

const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'Too many login attempts. Try again in a minute.' }
});

// Check session status + whether setup is done
router.get('/session', async (req, res) => {
  const setupDone = await isSetupComplete();
  if (req.session && req.session.userId) {
    const user = await getUserByExternalId(req.session.userId);
    if (!user || !user.is_active) {
      req.session.destroy(() => {});
      res.clearCookie('connect.sid');
      return res.json({
        authenticated: false,
        username: null,
        user: null,
        setupComplete: setupDone
      });
    }

    req.session.username = user.username;
    req.session.role = user.role;
    req.session.displayName = user.display_name;
    res.json({
      authenticated: true,
      username: user.username,
      user: {
        username: user.username,
        role: user.role,
        displayName: user.display_name,
      },
      setupComplete: setupDone
    });
  } else {
    res.json({
      authenticated: false,
      username: null,
      user: null,
      setupComplete: setupDone
    });
  }
});

// First-run setup — create initial admin account (only when 0 users exist)
router.post('/setup', async (req, res) => {
  if (await isSetupComplete()) {
    return res.status(400).json({ error: 'Setup already completed' });
  }
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  const passwordError = validateStrongPassword(password);
  if (passwordError) {
    return res.status(400).json({ error: passwordError });
  }

  const hash = await bcrypt.hash(password, 12);
  const userId = uuidv4();
  await createUser({
    externalId: userId,
    username,
    display_name: username,
    password_hash: hash,
    role: 'admin',
    is_active: true,
  });

  req.session.userId = userId;
  req.session.username = username;
  req.session.role = 'admin';
  req.session.displayName = username;

  res.json({
    success: true,
    user: { username, role: 'admin', displayName: username }
  });
});

// Login — multi-user: lookup from users table
router.post('/login', loginLimiter, async (req, res) => {
  if (!(await isSetupComplete())) {
    return res.status(400).json({ error: 'Setup not completed. Please run setup first.' });
  }
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }

  const user = await getUserByUsername(username);
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  if (!user.is_active) {
    return res.status(401).json({ error: 'Account is deactivated. Contact your administrator.' });
  }

  const match = await bcrypt.compare(password, user.password_hash);
  if (!match) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  req.session.userId = user.externalId;
  req.session.username = user.username;
  req.session.role = user.role;
  req.session.displayName = user.display_name;

  res.json({
    success: true,
    username: user.username,
    user: {
      username: user.username,
      role: user.role,
      displayName: user.display_name,
    }
  });
});

// Logout
router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) return res.status(500).json({ error: 'Logout failed' });
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

// Change own password (any authenticated user)
router.put('/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current and new password required' });
  }
  const passwordError = validateStrongPassword(newPassword, 'New password');
  if (passwordError) {
    return res.status(400).json({ error: passwordError });
  }

  const user = await getUserByExternalId(req.user.id);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  const match = await bcrypt.compare(currentPassword, user.password_hash);
  if (!match) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  const hash = await bcrypt.hash(newPassword, 12);
  await updateUserPassword(user.externalId, hash);

  res.json({ success: true });
});

function normalizeUsername(value) {
  return String(value || '').trim();
}

function validateUsername(username) {
  if (!username) return 'Username is required';
  if (username.length < 3) return 'Username must be at least 3 characters';
  if (username.length > 50) return 'Username must be 50 characters or fewer';
  if (!/^[A-Za-z0-9._-]+$/.test(username)) {
    return 'Username can only use letters, numbers, periods, underscores, and hyphens';
  }
  return null;
}

// Update own profile fields used by the UI greeting/nav.
router.put('/profile', requireAuth, async (req, res) => {
  const displayName = String(req.body?.displayName || '').trim();
  const username = normalizeUsername(req.body?.username);
  if (!displayName) {
    return res.status(400).json({ error: 'Display name is required' });
  }
  if (displayName.length > 80) {
    return res.status(400).json({ error: 'Display name must be 80 characters or fewer' });
  }
  const usernameError = validateUsername(username);
  if (usernameError) {
    return res.status(400).json({ error: usernameError });
  }

  const user = await getUserByExternalId(req.user.id);
  if (!user || !user.is_active) {
    return res.status(404).json({ error: 'User not found' });
  }

  if (username !== user.username) {
    const existing = await getUserByUsername(username);
    if (existing && existing.externalId !== user.externalId) {
      return res.status(409).json({ error: 'Username already exists' });
    }
  }

  await updateUser(user.externalId, { username, display_name: displayName });
  req.session.username = username;
  req.session.displayName = displayName;

  res.json({
    success: true,
    user: {
      username,
      role: user.role,
      displayName,
    },
  });
});

export default router;

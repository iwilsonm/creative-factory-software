import { Router } from 'express';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import rateLimit from 'express-rate-limit';
import { getUserByUsername, getUserByExternalId, createUser, updateUserPassword, getUserCount } from '../convexClient.js';
import { requireAuth, isSetupComplete } from '../auth.js';

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
    res.json({
      authenticated: true,
      username: req.session.username || null,
      user: {
        username: req.session.username,
        role: req.session.role,
        displayName: req.session.displayName,
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
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
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
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
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

export default router;

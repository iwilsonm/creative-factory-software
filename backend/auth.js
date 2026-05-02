import { v4 as uuidv4 } from 'uuid';
import { getSetting, getUserByExternalId, getUserCount, createUser } from './convexClient.js';

export async function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const user = await getUserByExternalId(req.session.userId);
  if (!user || !user.is_active) {
    req.session.destroy(() => {});
    res.clearCookie('connect.sid');
    return res.status(401).json({ error: 'Not authenticated' });
  }

  req.session.username = user.username;
  req.session.role = user.role;
  req.session.displayName = user.display_name;
  req.user = {
    id: user.externalId,
    username: user.username,
    role: user.role,
    displayName: user.display_name,
  };
  return next();
}

/**
 * Role-based access middleware factory.
 * Usage: requireRole('admin') or requireRole('admin', 'manager')
 */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Not authenticated' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

/**
 * Check if initial setup is complete (any users exist).
 * Cached after first positive result — once users exist, this never changes.
 */
let _setupComplete = null;
export async function isSetupComplete() {
  if (_setupComplete) return true;
  const count = await getUserCount();
  if (count > 0) {
    _setupComplete = true;
    return true;
  }
  return false;
}

/**
 * One-time migration: create admin user from legacy settings credentials.
 * Called on server start. If users table is empty and legacy auth_username exists,
 * creates an admin user with those credentials.
 */
export async function migrateToMultiUser() {
  const count = await getUserCount();
  if (count > 0) {
    console.log('[Auth] Users table has entries — migration not needed.');
    return;
  }

  // Check for legacy single-user credentials in settings
  const username = await getSetting('auth_username');
  const passwordHash = await getSetting('auth_password_hash');

  if (username && passwordHash) {
    console.log(`[Auth] Migrating legacy user "${username}" to users table as admin...`);
    await createUser({
      externalId: uuidv4(),
      username,
      display_name: username,
      password_hash: passwordHash,
      role: 'admin',
      is_active: true,
    });
    console.log('[Auth] Migration complete — admin user created from legacy credentials.');
  } else {
    console.log('[Auth] No legacy credentials found and no users exist. Fresh install — setup required.');
  }
}

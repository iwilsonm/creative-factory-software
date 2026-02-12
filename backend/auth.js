import { getSetting } from './db.js';

export function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) {
    return next();
  }
  res.status(401).json({ error: 'Not authenticated' });
}

export function isSetupComplete() {
  const username = getSetting('auth_username');
  const passwordHash = getSetting('auth_password_hash');
  return !!(username && passwordHash);
}

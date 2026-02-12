import { getSetting } from './convexClient.js';

export function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) {
    return next();
  }
  res.status(401).json({ error: 'Not authenticated' });
}

export async function isSetupComplete() {
  const username = await getSetting('auth_username');
  const passwordHash = await getSetting('auth_password_hash');
  return !!(username && passwordHash);
}

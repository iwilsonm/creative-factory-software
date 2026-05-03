import crypto from 'crypto';

const COMMON_PASSWORDS = new Set([
  '123456',
  '123456789',
  'password',
  'password1',
  'qwerty',
  'letmein',
  'admin123',
  'creativefactory',
]);

export function timingSafeEqualString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

export function getCronSecret() {
  return process.env.CRON_SECRET || process.env.Chron || '';
}

export function isValidCronBearer(req) {
  const secret = getCronSecret();
  if (!secret) return false;
  const authHeader = req.headers?.authorization || '';
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  return timingSafeEqualString(provided, secret);
}

export function validateStrongPassword(password, label = 'Password') {
  if (typeof password !== 'string' || password.length < 12) {
    return `${label} must be at least 12 characters.`;
  }
  const normalized = password.trim().toLowerCase();
  if (COMMON_PASSWORDS.has(normalized)) {
    return `${label} is too common. Choose a stronger password.`;
  }
  if (!/[A-Za-z]/.test(password) || !/[0-9\W_]/.test(password)) {
    return `${label} must include letters and at least one number or symbol.`;
  }
  return null;
}

export function listSafeFieldNames(body, allowed = []) {
  if (!body || typeof body !== 'object') return [];
  return Object.keys(body).filter((key) => allowed.includes(key));
}

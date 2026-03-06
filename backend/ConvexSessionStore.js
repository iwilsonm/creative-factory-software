/**
 * ConvexSessionStore — Custom express-session store backed by Convex.
 *
 * Sessions persist across PM2 restarts because they're stored in
 * Convex cloud, not in-memory.
 *
 * In-memory cache (5-min TTL) eliminates ~250ms Convex round-trip
 * on every authenticated request after the first one.
 */

import session from 'express-session';
import { getSession, setSession, destroySession, cleanupExpiredSessions } from './convexClient.js';

const ONE_DAY_MS = 86400000;
const SESSION_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const sessionCache = new Map();

// Evict stale cache entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of sessionCache) {
    if (now - entry.time > SESSION_CACHE_TTL) sessionCache.delete(key);
  }
}, 10 * 60 * 1000).unref();

export default class ConvexSessionStore extends session.Store {
  constructor(options = {}) {
    super(options);
    // Clean up expired sessions every hour
    this._cleanupInterval = setInterval(() => {
      cleanupExpiredSessions().catch(err => {
        console.error('[ConvexSessionStore] Cleanup error:', err.message);
      });
    }, 60 * 60 * 1000);
  }

  async get(sid, callback) {
    try {
      // Check in-memory cache first
      const cached = sessionCache.get(sid);
      if (cached && Date.now() - cached.time < SESSION_CACHE_TTL) {
        return callback(null, cached.data);
      }

      const data = await getSession(sid);
      if (!data) return callback(null, null);
      const parsed = JSON.parse(data);
      // Check if expired
      if (parsed.cookie && parsed.cookie.expires) {
        const expires = new Date(parsed.cookie.expires).getTime();
        if (expires < Date.now()) {
          await destroySession(sid);
          sessionCache.delete(sid);
          return callback(null, null);
        }
      }
      sessionCache.set(sid, { data: parsed, time: Date.now() });
      callback(null, parsed);
    } catch (err) {
      console.error('[ConvexSessionStore] get error:', err.message);
      callback(err);
    }
  }

  async set(sid, sessionData, callback) {
    try {
      const ttl = sessionData.cookie && sessionData.cookie.maxAge
        ? sessionData.cookie.maxAge
        : ONE_DAY_MS;
      const expiresAt = Date.now() + ttl;
      const data = JSON.stringify(sessionData);
      await setSession(sid, data, expiresAt);
      sessionCache.set(sid, { data: sessionData, time: Date.now() });
      if (callback) callback(null);
    } catch (err) {
      console.error('[ConvexSessionStore] set error:', err.message);
      if (callback) callback(err);
    }
  }

  async touch(sid, sessionData, callback) {
    try {
      const ttl = sessionData.cookie && sessionData.cookie.maxAge
        ? sessionData.cookie.maxAge
        : ONE_DAY_MS;
      const expiresAt = Date.now() + ttl;
      const data = JSON.stringify(sessionData);
      await setSession(sid, data, expiresAt);
      sessionCache.set(sid, { data: sessionData, time: Date.now() });
      if (callback) callback(null);
    } catch (err) {
      console.error('[ConvexSessionStore] touch error:', err.message);
      if (callback) callback(err);
    }
  }

  async destroy(sid, callback) {
    try {
      await destroySession(sid);
      sessionCache.delete(sid);
      if (callback) callback(null);
    } catch (err) {
      if (callback) callback(err);
    }
  }

  close() {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
    }
  }
}

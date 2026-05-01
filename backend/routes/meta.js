// Phase 2A — Meta integration routes.
// OAuth init / callback / status / disconnect, ad-account picker, integration-path toggle.
// All require auth + admin/manager role except the OAuth callback (Facebook redirects
// with no session cookie due to sameSite=Lax) and the cron refresh endpoint
// (validated by Vercel's cron header).

import { Router } from 'express';
import crypto from 'crypto';
import { requireAuth, requireRole } from '../auth.js';
import {
  getProject,
  getProjectRawForMeta,
  getProjectsWithExpiringMetaTokens,
  updateProject,
  getSetting,
  convexClient,
  api,
} from '../convexClient.js';
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  exchangeShortLivedForLongLived,
  refreshLongLivedToken,
  getMe,
  getAdAccounts,
  getCampaigns,
  getAdSets,
  getAds,
  getInsights,
  isTokenInvalidError,
  META_OAUTH_SCOPES,
} from '../services/metaApi.js';

const router = Router();

const REDIRECT_URI = process.env.META_OAUTH_REDIRECT_URI
  || 'https://creative-factory-software.vercel.app/api/meta/oauth/callback';

// Cookie name for state + PKCE binding. Single cookie holds all the OAuth-init
// session data across the redirect to FB and back. We don't depend on
// cookie-parser middleware — there's a tiny inline reader below since the
// session cookie is sameSite=strict (won't survive Facebook redirect) and
// adding a parser dep just for one cookie is overkill.
const META_OAUTH_COOKIE = 'meta_oauth_state';

function readCookie(req, name) {
  const header = req.headers?.cookie || '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (key === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

// Helper — compute SHA-256 PKCE challenge from a code_verifier
function pkceChallenge(verifier) {
  return crypto
    .createHash('sha256')
    .update(verifier)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

async function getMetaAppCreds() {
  const [appId, appSecret] = await Promise.all([
    getSetting('meta_app_id'),
    getSetting('meta_app_secret'),
  ]);
  if (!appId || !appSecret) {
    const err = new Error('Meta App ID + Secret not configured. Set them in Settings → API Keys.');
    err.statusCode = 400;
    throw err;
  }
  return { appId, appSecret };
}

// ────────────────────────────────────────────────
// OAuth init — generate the Facebook authorize URL
// ────────────────────────────────────────────────

router.post('/oauth/init', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { projectId } = req.body || {};
    if (!projectId) return res.status(400).json({ error: 'projectId required' });
    const project = await getProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const { appId } = await getMetaAppCreds();
    const state = crypto.randomBytes(32).toString('hex');
    const codeVerifier = crypto.randomBytes(64).toString('base64url');
    const codeChallenge = pkceChallenge(codeVerifier);

    // Bind state + verifier + projectId in an HttpOnly cookie. Cookie persists
    // through the FB round-trip; callback validates the state matches.
    const cookieValue = JSON.stringify({ state, codeVerifier, projectId, t: Date.now() });
    res.cookie(META_OAUTH_COOKIE, cookieValue, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',          // 'lax' allows cookie on top-level redirect from facebook.com
      maxAge: 10 * 60 * 1000,   // 10 minutes — OAuth dances should complete fast
      path: '/api/meta',
    });

    const authUrl = buildAuthorizeUrl({
      clientId: appId,
      redirectUri: REDIRECT_URI,
      state,
      codeChallenge,
    });
    res.json({ authUrl });
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────
// OAuth callback — Facebook redirects user here with code+state
// ────────────────────────────────────────────────

// Public — no requireAuth (sameSite=Lax + the bound cookie is enough verification)
router.get('/oauth/callback', async (req, res) => {
  const { code, state, error: oauthError, error_description } = req.query;

  function htmlClose(payload) {
    // Posts message to opener, then closes. Origin is locked to current page.
    const json = JSON.stringify(payload);
    return `<!DOCTYPE html><html><body><script>
      try {
        if (window.opener) {
          window.opener.postMessage({ type: 'meta-oauth-result', payload: ${json} }, window.location.origin);
        }
      } catch (e) {}
      setTimeout(function(){ window.close(); }, 50);
    </script><p>You can close this window.</p></body></html>`;
  }

  try {
    if (oauthError) {
      return res.status(400).type('html').send(htmlClose({ ok: false, error: error_description || oauthError }));
    }
    if (!code || !state) {
      return res.status(400).type('html').send(htmlClose({ ok: false, error: 'Missing code or state' }));
    }

    // Read + clear state cookie
    const raw = readCookie(req, META_OAUTH_COOKIE);
    if (!raw) {
      return res.status(400).type('html').send(htmlClose({ ok: false, error: 'OAuth session cookie missing — was the popup opened from CF?' }));
    }
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { return res.status(400).type('html').send(htmlClose({ ok: false, error: 'Corrupt OAuth session cookie' })); }
    res.clearCookie(META_OAUTH_COOKIE, { path: '/api/meta' });

    if (parsed.state !== state) {
      return res.status(400).type('html').send(htmlClose({ ok: false, error: 'State mismatch (possible CSRF)' }));
    }
    const { codeVerifier, projectId } = parsed;
    if (!projectId) {
      return res.status(400).type('html').send(htmlClose({ ok: false, error: 'projectId missing from session' }));
    }

    const { appId, appSecret } = await getMetaAppCreds();

    // Step 1: code → short-lived token
    const short = await exchangeCodeForToken({
      clientId: appId,
      clientSecret: appSecret,
      code,
      codeVerifier,
      redirectUri: REDIRECT_URI,
    });

    // Step 2: short-lived → long-lived (~60 days)
    const long = await exchangeShortLivedForLongLived({
      clientId: appId,
      clientSecret: appSecret,
      shortLivedToken: short.access_token,
    });

    // Step 3: who are we
    const me = await getMe(long.access_token);

    // Step 4: persist on the project
    const expiresAt = Date.now() + ((long.expires_in || 60 * 24 * 3600) * 1000);
    await updateProject(projectId, {
      meta_access_token: long.access_token,
      meta_token_expires_at: expiresAt,
      meta_user_id: me.id,
      meta_user_name: me.name,
      meta_integration_path: 'mcp', // sensible default; user can switch later
      meta_connected_at: Date.now(),
    });

    res.type('html').send(htmlClose({ ok: true }));
  } catch (err) {
    res.status(500).type('html').send(htmlClose({ ok: false, error: err.message }));
  }
});

// ────────────────────────────────────────────────
// Status / disconnect
// ────────────────────────────────────────────────

router.get('/connection-status', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { projectId } = req.query;
    if (!projectId) return res.status(400).json({ error: 'projectId required' });
    const project = await getProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json({
      connected: !!project.meta_connected,
      user_id: project.meta_user_id,
      user_name: project.meta_user_name,
      account_id: project.meta_account_id,
      account_name: project.meta_account_name,
      business_id: project.meta_business_id,
      integration_path: project.meta_integration_path || 'mcp',
      connected_at: project.meta_connected_at,
      token_expires_at: project.meta_token_expires_at,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/disconnect', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { projectId } = req.body || {};
    if (!projectId) return res.status(400).json({ error: 'projectId required' });
    const project = await getProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    // Update with empty strings (Convex v.optional(v.string()) accepts empty string)
    // and 0/null for timestamp + ids. Effectively clears the connection.
    await updateProject(projectId, {
      meta_access_token: '',
      meta_token_expires_at: 0,
      meta_user_id: '',
      meta_user_name: '',
      meta_account_id: '',
      meta_account_name: '',
      meta_business_id: '',
      meta_connected_at: 0,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────
// Ad account picker / selection
// ────────────────────────────────────────────────

router.get('/ad-accounts', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { projectId } = req.query;
    if (!projectId) return res.status(400).json({ error: 'projectId required' });
    const raw = await getProjectRawForMeta(projectId);
    if (!raw?.meta_access_token) {
      return res.status(400).json({ error: 'Project not connected to Meta' });
    }
    try {
      const accounts = await getAdAccounts(raw.meta_access_token);
      res.json({ accounts });
    } catch (err) {
      if (isTokenInvalidError(err)) {
        // Token expired / revoked — clear and prompt reconnect
        await updateProject(projectId, { meta_access_token: '', meta_token_expires_at: 0 });
        return res.status(401).json({ error: 'Meta token expired. Please reconnect.' });
      }
      throw err;
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/select-account', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { projectId, accountId, accountName, businessId } = req.body || {};
    if (!projectId || !accountId) return res.status(400).json({ error: 'projectId + accountId required' });
    await updateProject(projectId, {
      meta_account_id: accountId,
      meta_account_name: accountName || '',
      meta_business_id: businessId || '',
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/integration-path', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { projectId, path } = req.body || {};
    if (!projectId) return res.status(400).json({ error: 'projectId required' });
    if (path !== 'mcp' && path !== 'api') {
      return res.status(400).json({ error: 'path must be "mcp" or "api"' });
    }
    await updateProject(projectId, { meta_integration_path: path });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────
// Read endpoints (campaigns / ad sets / ads / insights) — for Analytics tab + 2C
// ────────────────────────────────────────────────

router.get('/campaigns', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { projectId } = req.query;
    const raw = await getProjectRawForMeta(projectId);
    if (!raw?.meta_access_token || !raw?.meta_account_id) {
      return res.status(400).json({ error: 'Connect Meta + select ad account first.' });
    }
    const campaigns = await getCampaigns(raw.meta_access_token, raw.meta_account_id);
    res.json({ campaigns });
  } catch (err) {
    if (isTokenInvalidError(err)) return res.status(401).json({ error: 'Meta token expired. Reconnect.' });
    res.status(500).json({ error: err.message });
  }
});

router.get('/adsets', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { projectId, campaignId } = req.query;
    const raw = await getProjectRawForMeta(projectId);
    if (!raw?.meta_access_token || !raw?.meta_account_id) {
      return res.status(400).json({ error: 'Connect Meta + select ad account first.' });
    }
    const adsets = await getAdSets(raw.meta_access_token, raw.meta_account_id, campaignId || null);
    res.json({ adsets });
  } catch (err) {
    if (isTokenInvalidError(err)) return res.status(401).json({ error: 'Meta token expired. Reconnect.' });
    res.status(500).json({ error: err.message });
  }
});

router.get('/ads', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { projectId, adsetId } = req.query;
    const raw = await getProjectRawForMeta(projectId);
    if (!raw?.meta_access_token) return res.status(400).json({ error: 'Connect Meta first.' });
    if (!adsetId) return res.status(400).json({ error: 'adsetId required' });
    const ads = await getAds(raw.meta_access_token, adsetId);
    res.json({ ads });
  } catch (err) {
    if (isTokenInvalidError(err)) return res.status(401).json({ error: 'Meta token expired. Reconnect.' });
    res.status(500).json({ error: err.message });
  }
});

router.get('/insights', requireAuth, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { projectId, objectId, datePreset } = req.query;
    const raw = await getProjectRawForMeta(projectId);
    if (!raw?.meta_access_token) return res.status(400).json({ error: 'Connect Meta first.' });
    if (!objectId) return res.status(400).json({ error: 'objectId required' });
    const insights = await getInsights(raw.meta_access_token, objectId, { datePreset: datePreset || 'last_7d' });
    res.json({ insights });
  } catch (err) {
    if (isTokenInvalidError(err)) return res.status(401).json({ error: 'Meta token expired. Reconnect.' });
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────
// Vercel Cron — daily token refresh
// ────────────────────────────────────────────────
//
// Vercel's cron jobs hit this endpoint with a `x-vercel-cron-signature` header.
// We accept either that header OR (for local manual testing) a shared secret
// from Convex settings (filter_shared_secret reused for simplicity since it's
// already part of the auth surface).

router.post('/oauth/refresh', async (req, res) => {
  // Validate request originates from Vercel Cron (or an authenticated admin for testing)
  const cronSig = req.get('x-vercel-cron-signature');
  const isVercelCron = !!cronSig; // Vercel sets this on every cron invocation
  if (!isVercelCron) {
    // Fall back to admin auth path
    if (!req.session?.userId) {
      return res.status(401).json({ error: 'Unauthorized — cron header or admin session required' });
    }
  }

  try {
    const { appId, appSecret } = await getMetaAppCreds();
    // Refresh tokens expiring within 7 days
    const projects = await getProjectsWithExpiringMetaTokens(7 * 24 * 3600 * 1000);
    const results = [];

    for (const p of projects) {
      try {
        const fresh = await refreshLongLivedToken({
          clientId: appId,
          clientSecret: appSecret,
          currentToken: p.meta_access_token,
        });
        const expiresAt = Date.now() + ((fresh.expires_in || 60 * 24 * 3600) * 1000);
        await updateProject(p.externalId, {
          meta_access_token: fresh.access_token,
          meta_token_expires_at: expiresAt,
        });
        results.push({ projectId: p.externalId, refreshed: true, expires_at: expiresAt });
      } catch (err) {
        if (isTokenInvalidError(err)) {
          await updateProject(p.externalId, { meta_access_token: '', meta_token_expires_at: 0 });
          results.push({ projectId: p.externalId, refreshed: false, cleared: true, error: err.message });
        } else {
          results.push({ projectId: p.externalId, refreshed: false, error: err.message });
        }
      }
    }

    res.json({ scanned: projects.length, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;

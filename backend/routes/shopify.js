import { Router } from 'express';
import { getConductorConfig, upsertConductorConfig } from '../convexClient.js';
import { withRetry } from '../services/retry.js';

const router = Router();

/**
 * POST /api/projects/:id/shopify/connect
 * Exchange client credentials for a Shopify Admin API access token.
 */
router.post('/:id/shopify/connect', async (req, res) => {
  try {
    const projectId = req.params.id;
    const { store_domain, client_id, client_secret } = req.body;

    if (!store_domain || !client_id || !client_secret) {
      return res.status(400).json({ error: 'store_domain, client_id, and client_secret are required' });
    }

    // Normalize domain — strip protocol and trailing slashes
    const domain = store_domain.replace(/^https?:\/\//, '').replace(/\/+$/, '');

    // Step 1: Exchange credentials for access token
    let tokenData;
    try {
      tokenData = await withRetry(async () => {
        const resp = await fetch(`https://${domain}/admin/oauth/access_token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id,
            client_secret,
            grant_type: 'client_credentials',
          }),
        });
        if (!resp.ok) {
          const body = await resp.text();
          const err = new Error(`Shopify token exchange failed (${resp.status}): ${body}`);
          err.status = resp.status;
          throw err;
        }
        return resp.json();
      }, { maxRetries: 2, baseDelayMs: 1000, label: 'Shopify token exchange' });
    } catch (err) {
      const status = err.status || 500;
      if (status === 401 || status === 403) {
        return res.status(400).json({ error: 'Invalid Client ID or Client Secret. Check your Shopify app credentials.' });
      }
      if (status === 404) {
        return res.status(400).json({ error: `Store not found: ${domain}. Verify the store domain is correct.` });
      }
      return res.status(400).json({ error: `Token exchange failed: ${err.message}` });
    }

    const accessToken = tokenData.access_token;
    if (!accessToken) {
      return res.status(400).json({ error: 'No access token returned from Shopify. Check your app configuration.' });
    }

    // Step 2: Validate token by listing pages
    try {
      await withRetry(async () => {
        const resp = await fetch(`https://${domain}/admin/api/2024-01/pages.json?limit=1`, {
          headers: { 'X-Shopify-Access-Token': accessToken },
        });
        if (!resp.ok) {
          const body = await resp.text();
          const err = new Error(`Shopify validation failed (${resp.status}): ${body}`);
          err.status = resp.status;
          throw err;
        }
        return resp.json();
      }, { maxRetries: 2, baseDelayMs: 1000, label: 'Shopify token validation' });
    } catch (err) {
      const status = err.status || 500;
      if (status === 403) {
        return res.status(400).json({ error: 'Token is valid but lacks required scopes. Ensure your app has write_content and read_content scopes.' });
      }
      return res.status(400).json({ error: `Token validation failed: ${err.message}` });
    }

    // Step 3: Store credentials (never store client_secret)
    await upsertConductorConfig(projectId, {
      shopify_store_domain: domain,
      shopify_access_token: accessToken,
      shopify_client_id: client_id,
    });

    res.json({ success: true, store_domain: domain, connected: true });
  } catch (err) {
    console.error('[Shopify] Connect error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/projects/:id/shopify/disconnect
 * Clear the access token. Keep store_domain for easy reconnection.
 */
router.post('/:id/shopify/disconnect', async (req, res) => {
  try {
    await upsertConductorConfig(req.params.id, {
      shopify_access_token: '',
      shopify_client_id: '',
    });
    res.json({ success: true });
  } catch (err) {
    console.error('[Shopify] Disconnect error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/projects/:id/shopify/status
 * Check if Shopify is connected and token is valid.
 */
router.get('/:id/shopify/status', async (req, res) => {
  try {
    const config = await getConductorConfig(req.params.id);
    const domain = config?.shopify_store_domain || null;
    const token = config?.shopify_access_token || '';

    if (!domain || !token) {
      return res.json({ connected: false, store_domain: domain });
    }

    // Lightweight validation — check token still works
    try {
      const resp = await fetch(`https://${domain}/admin/api/2024-01/shop.json`, {
        headers: { 'X-Shopify-Access-Token': token },
      });
      if (resp.ok) {
        return res.json({ connected: true, store_domain: domain });
      }
      return res.json({ connected: false, store_domain: domain, error: 'Token expired or revoked' });
    } catch {
      // Network error — don't mark as disconnected, just report unknown
      return res.json({ connected: true, store_domain: domain, warning: 'Could not verify token — Shopify may be temporarily unreachable' });
    }
  } catch (err) {
    console.error('[Shopify] Status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;

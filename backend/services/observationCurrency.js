// Phase 3 — Resolve account currency for a project. Cached on
// projects.meta_account_currency. Fetched from Meta /act_X?fields=currency
// the first time a cron tick processes a project that doesn't have it stored.

import fetch from 'node-fetch';
import { withRetry } from './retry.js';
import { updateProject } from '../convexClient.js';

const GRAPH_BASE = 'https://graph.facebook.com/v25.0';

export async function ensureAccountCurrency(project) {
  if (project.meta_account_currency) return project.meta_account_currency;
  if (!project.meta_access_token || !project.meta_account_id) return null;

  const params = new URLSearchParams({
    access_token: project.meta_access_token,
    fields: 'currency',
  }).toString();
  const url = `${GRAPH_BASE}/${project.meta_account_id}?${params}`;
  try {
    const resp = await withRetry(
      () => fetch(url, { method: 'GET' }),
      { label: `[observationCurrency ${project.externalId}]` }
    );
    const body = await resp.json();
    if (body?.error) throw new Error(body.error.message || 'Meta API error');
    const currency = body.currency || 'USD';
    await updateProject(project.externalId, { meta_account_currency: currency });
    return currency;
  } catch (err) {
    console.warn(`[observationCurrency] failed for ${project.externalId}: ${err.message}`);
    return 'USD'; // fallback
  }
}

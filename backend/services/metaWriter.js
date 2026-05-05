// Phase 2B — Meta posting orchestrator.
//
// Single entry point: postAdSetToMeta(adSetId, projectId).
// Resolves project + ad set, uploads images via direct API (Meta MCP doesn't
// expose image upload), then branches on integration_path: either calls
// Claude+MCP (metaMcp.postAdSetWithAds) or direct API (metaApi.create*).
// Persists Meta-side IDs back to Convex; flips lifecycle_status to "posted".

import crypto from 'crypto';
import {
  getProjectRawForMeta,
  getAdSet,
  updateProject,
  updateAdSet,
  updateDeployment,
  getDeploymentsByProject,
  getDeploymentByExternalId,
  getAd,
  ensureDefaultCampaign,
  getSetting,
  downloadToBuffer,
  convexClient,
  api,
} from '../convexClient.js';
import {
  uploadImage,
  createCampaign as createMetaCampaign,
  createAdSet as createMetaAdSet,
  createAd,
  buildLinkAdCreative,
  isTokenInvalidError,
} from './metaApi.js';
import { postAdSetWithAds, MCPNotAuthorizedError } from './metaMcp.js';

function parseList(value) {
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean);
  if (!value || value === 'null') return [];
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed.map(String).map((s) => s.trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function firstText(value, fallback = '') {
  return parseList(value)[0] || fallback || '';
}

function normalizePostOptions(options = {}) {
  const deliveryMode = ['active', 'scheduled', 'paused'].includes(options.deliveryMode)
    ? options.deliveryMode
    : (options.adStatus === 'PAUSED' ? 'paused' : 'active');
  const adStatus = deliveryMode === 'paused' ? 'PAUSED' : 'ACTIVE';
  const scheduleStartTime = deliveryMode === 'scheduled' && options.scheduleStartTime
    ? options.scheduleStartTime
    : null;
  return {
    ...options,
    deliveryMode,
    adStatus,
    scheduleStartTime,
  };
}

// Map our local Meta-settings shape (from project.adset_default_template + per-set
// overrides) to the parameter shape Meta's API expects.
function buildAdSetSpec(adSet, project, options = {}) {
  const targetingJson = adSet.meta_targeting || project?.adset_default_template_targeting || null;
  let targeting;
  try {
    targeting = targetingJson
      ? (typeof targetingJson === 'string' ? JSON.parse(targetingJson) : targetingJson)
      : { geo_locations: { countries: ['US'] } };  // safe default
  } catch { targeting = { geo_locations: { countries: ['US'] } }; }

  let schedule = null;
  try {
    schedule = adSet.meta_schedule
      ? (typeof adSet.meta_schedule === 'string' ? JSON.parse(adSet.meta_schedule) : adSet.meta_schedule)
      : null;
  } catch { schedule = null; }

  const isDaily = (adSet.meta_budget_type || 'daily') === 'daily';
  const budgetCents = adSet.meta_budget_amount_cents ?? 5000;  // default $50

  return {
    name: adSet.name,
    daily_budget: isDaily ? budgetCents : undefined,
    lifetime_budget: !isDaily ? budgetCents : undefined,
    billing_event: adSet.meta_billing_event || 'IMPRESSIONS',
    optimization_goal: adSet.meta_optimization_goal || 'LINK_CLICKS',
    targeting,
    status: options.adStatus || 'PAUSED',
    start_time: options.scheduleStartTime || schedule?.start_time || undefined,
    end_time: schedule?.end_time || undefined,
  };
}

function publicPostError(code, message, stage, details = '') {
  const e = new Error(message);
  e.code = code;
  e.stage = stage;
  if (details) e.details = details;
  return e;
}

async function ensureSingleDeploymentAdSet(deployment, project, projectId) {
  if (deployment.local_adset_id) {
    const existing = await getAdSet(deployment.local_adset_id).catch(() => null);
    if (existing) return existing;
  }
  const campaignId = deployment.local_campaign_id && deployment.local_campaign_id !== 'unplanned'
    ? deployment.local_campaign_id
    : await ensureDefaultCampaign({ ...project, id: projectId });
  const now = new Date().toISOString();
  const adSetId = crypto.randomUUID();
  await convexClient.mutation(api.adSets.create, {
    externalId: adSetId,
    campaign_id: campaignId,
    project_id: projectId,
    name: deployment.ad_set_name || deployment.ad_name || `Ready Ad ${deployment.externalId.slice(0, 8)}`,
    sort_order: 0,
    lifecycle_status: 'ready',
    ready_source: deployment.ready_source || 'manual_planner',
    ready_at: deployment.ready_at || now,
    created_at: now,
    updated_at: now,
  });
  await updateDeployment(deployment.externalId, {
    local_campaign_id: campaignId,
    local_adset_id: adSetId,
  });
  return await getAdSet(adSetId);
}

async function resolveReadyPostContext({ adSetId, deploymentId, project, projectId }) {
  if (deploymentId) {
    const deployment = await getDeploymentByExternalId(deploymentId);
    if (!deployment || deployment.deleted_at) throw publicPostError('NOT_FOUND', 'Ready-to-Post deployment not found.', 'resolve_deployment');
    if (deployment.project_id !== projectId) throw publicPostError('WRONG_PROJECT', 'Deployment does not belong to this project.', 'resolve_deployment');
    if (deployment.status !== 'ready_to_post') throw publicPostError('NOT_READY', `Cannot post deployment with status "${deployment.status}". Only Ready-to-Post ads can be posted.`, 'resolve_deployment');
    const adSet = await ensureSingleDeploymentAdSet(deployment, project, projectId);
    return { adSet, deployments: [deployment] };
  }

  const adSet = await getAdSet(adSetId);
  if (!adSet) throw publicPostError('NOT_FOUND', 'Ad set not found.', 'resolve_ad_set');
  if (adSet.project_id !== projectId) throw publicPostError('WRONG_PROJECT', 'Ad set does not belong to this project.', 'resolve_ad_set');
  if (!['ready', 'promoted'].includes(adSet.lifecycle_status || '')) {
    throw publicPostError('NOT_READY', `Cannot post ad set with lifecycle "${adSet.lifecycle_status}" — only Ready ad sets can be posted.`, 'resolve_ad_set');
  }
  const deployments = (await getDeploymentsByProject(projectId))
    .filter((d) => !d.deleted_at && d.local_adset_id === adSetId && d.status === 'ready_to_post');
  if (deployments.length === 0) throw publicPostError('NO_ADS', 'This Ready-to-Post ad set has no ready child ads to post.', 'resolve_ads');
  return { adSet, deployments };
}

async function buildPostableAds(deployments, token, accountId, projectId) {
  const rows = [];
  for (const deployment of deployments) {
    const ad = await getAd(deployment.ad_id);
    if (!ad) {
      await updateDeployment(deployment.externalId, { meta_post_error: 'Source creative not found.' });
      continue;
    }
    let imageHash = ad.meta_image_hash || null;
    if (!imageHash) {
      if (!ad.storageId) {
        await updateDeployment(deployment.externalId, { meta_post_error: 'Source creative has no image.' });
        continue;
      }
      try {
        const buffer = await downloadToBuffer(ad.storageId);
        const { hash } = await uploadImage(token, accountId, buffer, `${deployment.externalId}.png`);
        imageHash = hash;
        await convexClient.mutation(api.adCreatives.update, {
          externalId: ad.id,
          meta_image_hash: imageHash,
        });
      } catch (err) {
        if (isTokenInvalidError(err)) throw err;
        await updateDeployment(deployment.externalId, { meta_post_error: `Image upload failed: ${err.message}` });
        continue;
      }
    }
    rows.push({
      deployment,
      ad,
      imageHash,
      name: deployment.ad_name || ad.headline || `[Dacia Automation] ${deployment.externalId.slice(0, 8)}`,
      headline: firstText(deployment.ad_headlines, ad.headline || ''),
      body_copy: firstText(deployment.primary_texts, ad.body_copy || ''),
      link: deployment.destination_url || deployment.landing_page_url || '',
      cta_button: deployment.cta_button || 'LEARN_MORE',
    });
  }
  if (rows.length === 0) {
    throw publicPostError('IMAGE_UPLOAD_FAILED', 'No ads could be uploaded or prepared. Check the per-ad posting errors on this Ready-to-Post item.', 'image_upload');
  }
  return rows;
}

/**
 * Post a single staged ad set + its member ads to Meta.
 *
 * @param {string} adSetId        the ad_set externalId
 * @param {string} projectId      the project externalId
 * @returns {Promise<{ meta_adset_id, meta_ad_ids: string[], path_used: 'mcp'|'api' }>}
 * @throws  Error with .code = 'NOT_CONNECTED' | 'NO_PAGE' | 'NO_ADS' | 'TOKEN_EXPIRED' | 'MCP_NOT_AUTHORIZED'
 */
export async function postAdSetToMeta(adSetId, projectId, options = {}) {
  return postReadyItemToMeta({ adSetId, projectId, options });
}

export async function postDeploymentToMeta(deploymentId, projectId, options = {}) {
  return postReadyItemToMeta({ deploymentId, projectId, options });
}

async function postReadyItemToMeta({ adSetId = null, deploymentId = null, projectId, options = {} }) {
  const postOptions = normalizePostOptions(options);
  // 1. Resolve project + token + page
  const project = await getProjectRawForMeta(projectId);
  if (!project) {
    const e = new Error('Project not found'); e.code = 'NOT_FOUND'; throw e;
  }
  if (!project.meta_access_token) {
    const e = new Error('Project not connected to Meta. Connect in Project Settings → Meta.');
    e.code = 'NOT_CONNECTED'; throw e;
  }
  if (!project.meta_account_id) {
    const e = new Error('No ad account selected. Pick one in Project Settings → Meta.');
    e.code = 'NO_ACCOUNT'; throw e;
  }
  if (!project.meta_page_id) {
    const e = new Error('No Facebook Page selected. Pick one in Project Settings → Meta.');
    e.code = 'NO_PAGE'; throw e;
  }

  const token = project.meta_access_token;
  const accountId = project.meta_account_id;
  const pageId = project.meta_page_id;
  const path = project.meta_integration_path === 'api' ? 'api' : 'mcp';

  if (path === 'api' && postOptions.apiRiskAccepted !== true) {
    const e = new Error('Direct API posting requires explicit API risk confirmation. Direct API posting is not recommended.');
    e.code = 'API_CONFIRMATION_REQUIRED';
    e.stage = 'risk_confirmation';
    throw e;
  }

  // 2. Resolve ad set + ads
  const { adSet, deployments } = await resolveReadyPostContext({ adSetId, deploymentId, project, projectId });

  // 3. Resolve a Meta campaign for this ad set. If the ad_set already has
  //    meta_campaign_id from a prior partial post, reuse it. Otherwise create
  //    a new campaign on Meta. We name it after the angle for clarity.
  let metaCampaignId = adSet.meta_campaign_id;
  if (!metaCampaignId) {
    try {
      const campaignRes = await createMetaCampaign(token, accountId, {
        name: `[Dacia Automation] ${adSet.name}`,
        objective: 'OUTCOME_TRAFFIC',
        status: postOptions.adStatus,
        special_ad_categories: [],
      });
      metaCampaignId = campaignRes.id;
    } catch (err) {
      if (isTokenInvalidError(err)) {
        await updateProject(projectId, { meta_access_token: '', meta_token_expires_at: 0 });
        const e = new Error('Meta token expired. Reconnect in Project Settings → Meta.');
        e.code = 'TOKEN_EXPIRED'; throw e;
      }
      throw err;
    }
  }

  // 4. Upload images for each ad. Direct API regardless of path (MCP doesn't
  //    expose image upload). Idempotent: same bytes → same hash.
  let postableAds;
  try {
    postableAds = await buildPostableAds(deployments, token, accountId, projectId);
  } catch (err) {
    if (isTokenInvalidError(err)) {
      await updateProject(projectId, { meta_access_token: '', meta_token_expires_at: 0 });
      const e = new Error('Meta token expired during image upload. Reconnect in Project Settings → Meta.');
      e.code = 'TOKEN_EXPIRED'; e.stage = 'image_upload'; throw e;
    }
    throw err;
  }

  // 5. Branch on integration path
  let metaAdsetId;
  let metaAdIds = [];
  let pathUsed = path;
  const adSetSpec = buildAdSetSpec(adSet, project, postOptions);

  // Default destination URL — first ad's destination_url if available, else a placeholder
  const defaultLink = postableAds[0]?.link
    || project.scout_destination_url
    || `https://www.facebook.com/${pageId}`;

  if (path === 'mcp') {
    // MCP path via Anthropic
    const anthropicKey = await getSetting('anthropic_api_key');
    if (!anthropicKey) {
      const e = new Error('Anthropic API key not configured. Set in Settings → API Keys.');
      e.code = 'NO_ANTHROPIC_KEY'; throw e;
    }
    const adsSpec = postableAds.map(({ deployment, name, headline, body_copy, imageHash, link, cta_button }) => ({
      name: name ? `[Dacia Automation] ${name.slice(0, 50)}` : `[Dacia Automation] ${deployment.externalId.slice(0, 8)}`,
      headline,
      body_copy,
      image_hash: imageHash,
      link: link || defaultLink,
      cta_button: cta_button || 'LEARN_MORE',
      status: postOptions.adStatus,
    }));

    try {
      const result = await postAdSetWithAds({
        anthropicApiKey: anthropicKey,
        metaToken: token,
        accountId,
        pageId,
        campaignId: metaCampaignId,
        adSetSpec,
        adsSpec,
        projectId,
      });
      metaAdsetId = result.meta_adset_id;
      metaAdIds = result.meta_ad_ids;
      if (!metaAdsetId || !Array.isArray(metaAdIds) || metaAdIds.length === 0) {
        throw publicPostError('MCP_POST_FAILED', 'Meta MCP did not return a Meta ad set ID and ad IDs after posting.', 'mcp_post');
      }
    } catch (err) {
      if (err instanceof MCPNotAuthorizedError) {
        // MCP path is gated for this FB App. Re-throw with code so caller can
        // surface the right error / disable the toggle option.
        const e = new Error(err.message); e.code = 'MCP_NOT_AUTHORIZED'; throw e;
      }
      if (!err.code) err.code = 'MCP_POST_FAILED';
      if (!err.stage) err.stage = 'mcp_post';
      throw err;
    }
  } else {
    // Direct API path
    try {
      const adsetRes = await createMetaAdSet(token, accountId, {
        ...adSetSpec,
        campaign_id: metaCampaignId,
      });
      metaAdsetId = adsetRes.id;

      for (const { deployment, ad, name, headline, body_copy, imageHash, link, cta_button } of postableAds) {
        try {
          const creative = buildLinkAdCreative({
            name: name ? `[Dacia Automation] ${name.slice(0, 50)} creative` : `[Dacia Automation] ${deployment.externalId.slice(0, 8)} creative`,
            page_id: pageId,
            message: body_copy || '',
            headline: headline || '',
            description: '',
            link: link || defaultLink,
            image_hash: imageHash,
            call_to_action_type: cta_button || 'LEARN_MORE',
          });
          const adRes = await createAd(token, accountId, {
            name: name ? `[Dacia Automation] ${name.slice(0, 50)}` : `[Dacia Automation] ${deployment.externalId.slice(0, 8)}`,
            adset_id: metaAdsetId,
            creative,
            status: postOptions.adStatus,
          });
          metaAdIds.push(adRes.id);
          // Persist the per-ad Meta IDs as we go
          await updateDeployment(deployment.externalId, {
            meta_ad_id: adRes.id,
            meta_post_error: '',
          });
          await convexClient.mutation(api.adCreatives.update, {
            externalId: ad.id,
            meta_ad_id: adRes.id,
            meta_post_error: '',
          });
        } catch (err) {
          if (isTokenInvalidError(err)) {
            await updateProject(projectId, { meta_access_token: '', meta_token_expires_at: 0 });
            const e = new Error('Meta token expired during ad creation. Reconnect.');
            e.code = 'TOKEN_EXPIRED'; throw e;
          }
          // Persist per-ad error and continue with the rest
          await updateDeployment(deployment.externalId, {
            meta_post_error: `Ad create failed: ${err.message}`,
          });
          await convexClient.mutation(api.adCreatives.update, {
            externalId: ad.id,
            meta_post_error: `Ad create failed: ${err.message}`,
          });
          console.warn(`[metaWriter] Ad create failed for ${ad.id.slice(0, 8)}: ${err.message}`);
        }
      }
    } catch (err) {
      if (isTokenInvalidError(err)) {
        await updateProject(projectId, { meta_access_token: '', meta_token_expires_at: 0 });
        const e = new Error('Meta token expired during ad set creation. Reconnect.');
        e.code = 'TOKEN_EXPIRED'; throw e;
      }
      if (!err.code) err.code = 'AD_SET_CREATE_FAILED';
      if (!err.stage) err.stage = 'ad_set_create';
      throw err;
    }
  }

  if (metaAdIds.length < postableAds.length) {
    throw publicPostError(
      'PARTIAL_AD_CREATE_FAILED',
      `Meta created ${metaAdIds.length}/${postableAds.length} ads. The item was not moved to Posted because not every ad was confirmed.`,
      'ad_create'
    );
  }

  const postedAt = new Date().toISOString();
  await Promise.all(postableAds.map(({ deployment, ad }, index) => Promise.all([
    updateDeployment(deployment.externalId, {
      status: 'posted',
      posted_date: postedAt,
      meta_ad_id: metaAdIds[index],
      meta_post_error: '',
    }),
    convexClient.mutation(api.adCreatives.update, {
      externalId: ad.id,
      meta_ad_id: metaAdIds[index],
      meta_post_error: '',
    }),
  ])));

  // 6. Persist ad set side. Phase 3: flip lifecycle directly to "observing"
  // (posted → observing happens atomically; the daily cron picks it up from
  // here on for snapshots and eventual benchmark evaluation).
  await updateAdSet(adSet.externalId || adSet.id || adSetId, {
    meta_adset_id: metaAdsetId,
    meta_campaign_id: metaCampaignId,
    meta_post_path: pathUsed,
    meta_post_error: '',
    posted_at: postedAt,
    lifecycle_status: 'observing',
  });

  return {
    meta_adset_id: metaAdsetId,
    meta_ad_ids: metaAdIds,
    path_used: pathUsed,
    delivery_mode: postOptions.deliveryMode,
    status_created: postOptions.adStatus,
    posted_count: postableAds.length,
  };
}

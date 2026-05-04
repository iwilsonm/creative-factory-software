// Phase 2B — Meta posting orchestrator.
//
// Single entry point: postAdSetToMeta(adSetId, projectId).
// Resolves project + ad set, uploads images via direct API (Meta MCP doesn't
// expose image upload), then branches on integration_path: either calls
// Claude+MCP (metaMcp.postAdSetWithAds) or direct API (metaApi.create*).
// Persists Meta-side IDs back to Convex; flips lifecycle_status to "posted".

import {
  getProjectRawForMeta,
  getAdSet,
  getAdSetsByProject,
  updateProject,
  updateAdSet,
  getSetting,
  downloadToBuffer,
  convexClient,
  api,
} from '../convexClient.js';
import {
  uploadImage,
  createCampaign,
  createAdSet,
  createAd,
  buildLinkAdCreative,
  isTokenInvalidError,
} from './metaApi.js';
import { postAdSetWithAds, MCPNotAuthorizedError } from './metaMcp.js';

// Map our local Meta-settings shape (from project.adset_default_template + per-set
// overrides) to the parameter shape Meta's API expects.
function buildAdSetSpec(adSet, project, adStatus = 'PAUSED') {
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
    status: adStatus,
    start_time: schedule?.start_time || undefined,
    end_time: schedule?.end_time || undefined,
  };
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
  const adStatus = options.adStatus || 'PAUSED';
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

  if (path === 'api') {
    const e = new Error('Direct API posting is not currently enabled. Please use the MCP integration path. You can change this in Project Settings → Meta.');
    e.code = 'API_BLOCKED';
    throw e;
  }

  // 2. Resolve ad set + ads
  const adSet = await getAdSet(adSetId);
  if (!adSet) {
    const e = new Error('Ad set not found'); e.code = 'NOT_FOUND'; throw e;
  }
  if (adSet.project_id !== projectId) {
    const e = new Error('Ad set does not belong to this project'); e.code = 'WRONG_PROJECT'; throw e;
  }

  const adsByAdSet = await convexClient.query(api.adCreatives.getByAdSet, { adSetId });
  const ads = (adsByAdSet || []).filter((a) => a.status === 'staging' || a.status === 'completed');
  if (ads.length === 0) {
    const e = new Error('Ad set has no eligible ads to post'); e.code = 'NO_ADS'; throw e;
  }

  // 3. Resolve a Meta campaign for this ad set. If the ad_set already has
  //    meta_campaign_id from a prior partial post, reuse it. Otherwise create
  //    a new campaign on Meta. We name it after the angle for clarity.
  let metaCampaignId = adSet.meta_campaign_id;
  if (!metaCampaignId) {
    try {
      const campaignRes = await createCampaign(token, accountId, {
        name: `[CF] ${adSet.name}`,
        objective: 'OUTCOME_TRAFFIC',
        status: adStatus,
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
  const adsWithHashes = [];
  for (const ad of ads) {
    let imageHash = ad.meta_image_hash || null;
    if (!imageHash) {
      if (!ad.storageId) {
        // Skip ads that don't have an image — log + skip rather than fail the whole post
        console.warn(`[metaWriter] Skipping ad ${ad.id.slice(0, 8)}: no storageId`);
        continue;
      }
      try {
        const buffer = await downloadToBuffer(ad.storageId);
        const { hash } = await uploadImage(token, accountId, buffer, `${ad.id}.png`);
        imageHash = hash;
        // Persist hash for future retries (idempotent)
        await convexClient.mutation(api.adCreatives.update, {
          externalId: ad.id,
          meta_image_hash: imageHash,
        });
      } catch (err) {
        if (isTokenInvalidError(err)) {
          await updateProject(projectId, { meta_access_token: '', meta_token_expires_at: 0 });
          const e = new Error('Meta token expired during image upload. Reconnect.');
          e.code = 'TOKEN_EXPIRED'; throw e;
        }
        // Persist error on the ad so frontend can show which one failed
        await convexClient.mutation(api.adCreatives.update, {
          externalId: ad.id,
          meta_post_error: `Image upload failed: ${err.message}`,
        });
        console.warn(`[metaWriter] Image upload failed for ad ${ad.id.slice(0, 8)}: ${err.message}`);
        continue;
      }
    }
    adsWithHashes.push({ ad, imageHash });
  }
  if (adsWithHashes.length === 0) {
    const e = new Error('No ads could be uploaded (image upload failed for all)');
    e.code = 'IMAGE_UPLOAD_FAILED'; throw e;
  }

  // 5. Branch on integration path
  let metaAdsetId;
  let metaAdIds = [];
  let pathUsed = path;
  const adSetSpec = buildAdSetSpec(adSet, project, adStatus);

  // Default destination URL — first ad's destination_url if available, else a placeholder
  const defaultLink = adsWithHashes[0]?.ad?.destination_url
    || project.scout_destination_url
    || `https://www.facebook.com/${pageId}`;

  if (path === 'mcp') {
    // MCP path via Anthropic
    const anthropicKey = await getSetting('anthropic_api_key');
    if (!anthropicKey) {
      const e = new Error('Anthropic API key not configured. Set in Settings → API Keys.');
      e.code = 'NO_ANTHROPIC_KEY'; throw e;
    }
    const adsSpec = adsWithHashes.map(({ ad, imageHash }) => ({
      name: ad.headline ? `[CF] ${ad.headline.slice(0, 50)}` : `[CF] ${ad.id.slice(0, 8)}`,
      headline: ad.headline || '',
      body_copy: ad.body_copy || '',
      image_hash: imageHash,
      link: ad.destination_url || defaultLink,
      cta_button: 'LEARN_MORE',
      status: adStatus,
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
    } catch (err) {
      if (err instanceof MCPNotAuthorizedError) {
        // MCP path is gated for this FB App. Re-throw with code so caller can
        // surface the right error / disable the toggle option.
        const e = new Error(err.message); e.code = 'MCP_NOT_AUTHORIZED'; throw e;
      }
      throw err;
    }
  } else {
    // Direct API path
    try {
      const adsetRes = await createAdSet(token, accountId, {
        ...adSetSpec,
        campaign_id: metaCampaignId,
      });
      metaAdsetId = adsetRes.id;

      for (const { ad, imageHash } of adsWithHashes) {
        try {
          const creative = buildLinkAdCreative({
            name: ad.headline ? `[CF] ${ad.headline.slice(0, 50)} creative` : `[CF] ${ad.id.slice(0, 8)} creative`,
            page_id: pageId,
            message: ad.body_copy || '',
            headline: ad.headline || '',
            description: '',
            link: ad.destination_url || defaultLink,
            image_hash: imageHash,
            call_to_action_type: 'LEARN_MORE',
          });
          const adRes = await createAd(token, accountId, {
            name: ad.headline ? `[CF] ${ad.headline.slice(0, 50)}` : `[CF] ${ad.id.slice(0, 8)}`,
            adset_id: metaAdsetId,
            creative,
            status: adStatus,
          });
          metaAdIds.push(adRes.id);
          // Persist the per-ad Meta IDs as we go
          await convexClient.mutation(api.adCreatives.update, {
            externalId: ad.id,
            meta_ad_id: adRes.id,
            meta_post_error: null,
          });
        } catch (err) {
          if (isTokenInvalidError(err)) {
            await updateProject(projectId, { meta_access_token: '', meta_token_expires_at: 0 });
            const e = new Error('Meta token expired during ad creation. Reconnect.');
            e.code = 'TOKEN_EXPIRED'; throw e;
          }
          // Persist per-ad error and continue with the rest
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
      throw err;
    }
  }

  // 6. Persist ad set side. Phase 3: flip lifecycle directly to "observing"
  // (posted → observing happens atomically; the daily cron picks it up from
  // here on for snapshots and eventual benchmark evaluation).
  await updateAdSet(adSetId, {
    meta_adset_id: metaAdsetId,
    meta_campaign_id: metaCampaignId,
    meta_post_path: pathUsed,
    meta_post_error: null,
    posted_at: new Date().toISOString(),
    lifecycle_status: 'observing',
  });

  return { meta_adset_id: metaAdsetId, meta_ad_ids: metaAdIds, path_used: pathUsed };
}

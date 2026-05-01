// Phase 2B — Meta MCP path via Anthropic mcp_servers connector.
//
// Routes Meta ad creation through Claude. Claude receives a structured prompt
// + the Meta MCP server URL + Marco's Marketing API token, then calls
// ads_create_ad_set + ads_create_ad MCP tools to do the actual work.
//
// Whether this path is feasible end-to-end is the live probe: direct curl to
// mcp.facebook.com/ads with Marco's token returned 401 "restricted to certain
// users." Anthropic may broker the auth differently — we'll find out the first
// time this is invoked. If the same 401 comes back, throw MCP_NOT_AUTHORIZED.

import Anthropic from '@anthropic-ai/sdk';
import { logAnthropicCost } from './costTracker.js';

const META_MCP_URL = 'https://mcp.facebook.com/ads';
const MCP_BETA_HEADER = 'mcp-client-2025-11-20';
const MCP_TOOLSET_NAME = 'meta-ads';
const MCP_MODEL = 'claude-sonnet-4-6';   // cheaper than Opus for tool orchestration

export class MCPNotAuthorizedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MCPNotAuthorizedError';
    this.code = 'MCP_NOT_AUTHORIZED';
  }
}

/**
 * Orchestrate creation of an ad set + N ads on Meta via Claude + Meta's MCP.
 *
 * @param {object} args
 * @param {string} args.anthropicApiKey
 * @param {string} args.metaToken                 user's long-lived Marketing API token
 * @param {string} args.accountId                 ad account ID (act_XXX)
 * @param {string} args.pageId                    Facebook Page ID to post from
 * @param {string} args.campaignId                existing Meta campaign ID to post under
 * @param {object} args.adSetSpec                 { name, daily_budget, lifetime_budget, billing_event, optimization_goal, targeting, status, start_time?, end_time? }
 * @param {Array}  args.adsSpec                   [{ name, headline, body_copy, image_hash, link, cta_button, status }]
 * @param {string} [args.projectId]               for cost tracking
 * @returns {Promise<{ meta_adset_id: string, meta_ad_ids: string[] }>}
 */
export async function postAdSetWithAds({
  anthropicApiKey,
  metaToken,
  accountId,
  pageId,
  campaignId,
  adSetSpec,
  adsSpec,
  projectId = null,
}) {
  if (!anthropicApiKey) throw new Error('Anthropic API key required for MCP path');
  if (!metaToken) throw new Error('Meta token required');
  if (!accountId || !campaignId) throw new Error('accountId + campaignId required');
  if (!Array.isArray(adsSpec) || adsSpec.length === 0) throw new Error('adsSpec must be a non-empty array');

  const client = new Anthropic({ apiKey: anthropicApiKey });

  // Build a tightly-scoped prompt. Claude needs:
  // - The ad set parameters in one place
  // - Each ad's creative spec
  // - A clear instruction: call ads_create_ad_set FIRST, then loop ads_create_ad
  // - A return-format instruction so we can parse the result
  const promptUser = `You are creating Meta (Facebook) ads via the Meta Ads MCP server. Use ONLY the MCP tools — do not respond with text alternatives.

CONTEXT:
- Ad account: ${accountId}
- Facebook Page: ${pageId}
- Campaign (already exists): ${campaignId}

STEP 1 — Create the ad set by calling ads_create_ad_set with these parameters:
${JSON.stringify({
  ad_account_id: accountId,
  campaign_id: campaignId,
  ad_set_name: adSetSpec.name,
  billing_event: adSetSpec.billing_event || 'IMPRESSIONS',
  optimization_goal: adSetSpec.optimization_goal || 'LINK_CLICKS',
  targeting: adSetSpec.targeting || { geo_locations: { countries: ['US'] } },
  daily_budget: adSetSpec.daily_budget,
  lifetime_budget: adSetSpec.lifetime_budget,
  start_time: adSetSpec.start_time,
  end_time: adSetSpec.end_time,
  status: adSetSpec.status || 'PAUSED',
}, null, 2)}

STEP 2 — For each ad below, call ads_create_ad with that ad's parameters using the ad set ID from STEP 1:
${adsSpec.map((a, i) => JSON.stringify({
  index: i,
  ad_account_id: accountId,
  ad_name: a.name,
  ad_set_id: '<from STEP 1>',
  creative: {
    name: `${a.name} creative`,
    object_story_spec: {
      page_id: pageId,
      link_data: {
        link: a.link,
        message: a.body_copy,
        name: a.headline,
        image_hash: a.image_hash,
        call_to_action: { type: a.cta_button || 'LEARN_MORE', value: { link: a.link } },
      },
    },
  },
  status: a.status || 'PAUSED',
}, null, 2)).join('\n\n')}

STEP 3 — Reply with ONLY this JSON object (no other text, no code fences):
{ "ad_set_id": "<from STEP 1>", "ad_ids": ["<from each STEP 2 call in order>"] }

Do not call any tools other than ads_create_ad_set and ads_create_ad. Do not call ads_get_*. Do not ask clarifying questions.`;

  const startedAt = Date.now();
  let response;
  try {
    response = await client.beta.messages.create({
      model: MCP_MODEL,
      max_tokens: 4000,
      messages: [{ role: 'user', content: promptUser }],
      mcp_servers: [
        {
          type: 'url',
          url: META_MCP_URL,
          name: MCP_TOOLSET_NAME,
          authorization_token: metaToken,
        },
      ],
      tools: [
        {
          type: 'mcp_toolset',
          mcp_server_name: MCP_TOOLSET_NAME,
          default_config: { enabled: false },
          configs: {
            ads_create_ad_set: { enabled: true },
            ads_create_ad: { enabled: true },
          },
        },
      ],
      betas: [MCP_BETA_HEADER],
    });
  } catch (err) {
    // Anthropic API call failed before reaching MCP. Could be auth error,
    // bad model name, network. Bubble up.
    throw new Error(`Anthropic MCP call failed: ${err.message}`);
  }

  // Cost-track the Anthropic side (fire-and-forget)
  try {
    const inTok = response?.usage?.input_tokens || 0;
    const outTok = response?.usage?.output_tokens || 0;
    logAnthropicCost({
      model: MCP_MODEL,
      inputTokens: inTok,
      outputTokens: outTok,
      operation: 'meta_mcp_post_ad_set',
      projectId,
    }).catch(() => {});
  } catch {}

  // Inspect content blocks. Look for:
  // - mcp_tool_result blocks: success/failure of each MCP call
  // - text blocks: Claude's final JSON reply (or refusal)
  const blocks = Array.isArray(response.content) ? response.content : [];
  const toolResults = blocks.filter((b) => b.type === 'mcp_tool_result');
  const textBlocks = blocks.filter((b) => b.type === 'text').map((b) => b.text || '').join('\n');

  // Detect auth failure surfaced through MCP. Meta's MCP returns 401 "restricted
  // to certain users" — when relayed through Anthropic, this appears as a
  // tool_result with is_error: true and an Authorization Error payload.
  const authErrors = toolResults.filter((r) => {
    if (!r.is_error) return false;
    const txt = JSON.stringify(r.content || []);
    return /authoriz|restricted|401|Unauthorized/i.test(txt);
  });
  if (authErrors.length > 0 && toolResults.every((r) => r.is_error)) {
    throw new MCPNotAuthorizedError(
      `Meta MCP rejected calls (likely the FB App is not on Meta's MCP allowlist for AI-connector access). Details: ${
        JSON.stringify(authErrors[0].content || []).slice(0, 300)
      }`
    );
  }

  // Other tool errors (non-auth) — bubble up with detail
  const otherErrors = toolResults.filter((r) => r.is_error);
  if (otherErrors.length > 0) {
    throw new Error(`MCP tool error: ${JSON.stringify(otherErrors[0].content || []).slice(0, 500)}`);
  }

  // Parse Claude's final JSON reply
  let parsed;
  const jsonMatch = textBlocks.match(/\{[\s\S]*"ad_set_id"[\s\S]*"ad_ids"[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`MCP path: Claude did not return parseable JSON. Output was: ${textBlocks.slice(0, 400)}`);
  }
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (err) {
    throw new Error(`MCP path: JSON parse failed: ${err.message}. Output: ${textBlocks.slice(0, 400)}`);
  }
  if (!parsed.ad_set_id || !Array.isArray(parsed.ad_ids)) {
    throw new Error(`MCP path: missing ad_set_id or ad_ids in output. Got: ${JSON.stringify(parsed)}`);
  }
  return {
    meta_adset_id: parsed.ad_set_id,
    meta_ad_ids: parsed.ad_ids,
    elapsed_ms: Date.now() - startedAt,
  };
}

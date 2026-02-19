/**
 * quoteMiner.js — Dual-engine quote mining service
 *
 * Runs Perplexity Sonar and Claude Opus 4.6 web search in parallel
 * to find emotionally powerful first-person quotes from online communities.
 * Results are merged, deduplicated, and ranked by GPT-4.1.
 */

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { getSetting } from '../convexClient.js';
import { chat } from './openai.js';
import { withRetry } from './retry.js';

// ── Perplexity client (reuses OpenAI SDK with different baseURL) ──────────────
let perplexityClient = null;
let lastPerplexityKey = null;

async function getPerplexityClient() {
  const apiKey = await getSetting('perplexity_api_key');
  if (!apiKey) throw new Error('Perplexity API key not configured. Set it in Settings.');
  if (!perplexityClient || lastPerplexityKey !== apiKey) {
    perplexityClient = new OpenAI({ apiKey, baseURL: 'https://api.perplexity.ai' });
    lastPerplexityKey = apiKey;
  }
  return perplexityClient;
}

// ── Anthropic client ──────────────────────────────────────────────────────────
let anthropicClient = null;
let lastAnthropicKey = null;

export async function getAnthropicClient() {
  const apiKey = await getSetting('anthropic_api_key');
  if (!apiKey) throw new Error('Anthropic API key not configured. Set it in Settings.');
  if (!anthropicClient || lastAnthropicKey !== apiKey) {
    anthropicClient = new Anthropic({ apiKey });
    lastAnthropicKey = apiKey;
  }
  return anthropicClient;
}

// ── Generate search suggestions using GPT-4.1-mini ──────────────────────────
export async function generateSuggestions(targetDemographic, problem) {
  const result = await chat([
    {
      role: 'system',
      content: 'You suggest search terms and online communities for researching a target audience. Return ONLY valid JSON, no markdown.'
    },
    {
      role: 'user',
      content: `Target Demographic: ${targetDemographic}
Problem: ${problem}

Suggest:
- 8-12 specific search keywords/phrases this demographic would type when discussing this problem online (include emotional language, slang, and common misspellings)
- 5-8 relevant subreddit names (no "r/" prefix, just the name)
- 3-5 niche forum domains or health communities (e.g., healthunlocked.com, patient.info)
- 3-5 Facebook group names where this demographic congregates

Return JSON: { "keywords": [...], "subreddits": [...], "forums": [...], "facebook_groups": [...] }`
    }
  ], 'gpt-4.1-mini', { response_format: { type: 'json_object' } });

  return JSON.parse(result);
}

// ── Build the mining prompt ───────────────────────────────────────────────────
function buildMiningPrompt(config) {
  const { target_demographic, problem, root_cause, keywords, subreddits, forums, facebook_groups, num_quotes } = config;

  const keywordList = JSON.parse(keywords);
  const subredditList = subreddits ? JSON.parse(subreddits) : [];
  const forumList = forums ? JSON.parse(forums) : [];
  const fbGroupList = facebook_groups ? JSON.parse(facebook_groups) : [];

  let sourcesSection = '';
  if (subredditList.length > 0) {
    sourcesSection += `\nReddit subreddits to search: ${subredditList.map(s => `r/${s}`).join(', ')}`;
  }
  if (forumList.length > 0) {
    sourcesSection += `\nOther forums/communities to search: ${forumList.join(', ')}`;
  }
  if (fbGroupList.length > 0) {
    sourcesSection += `\nFacebook groups to search: ${fbGroupList.join(', ')}`;
  }

  return `You are an expert copywriting researcher. Your task is to scrape online discussions and extract authentic, emotional, first-person quotes from ${target_demographic} describing their experiences with ${problem}${root_cause ? `, especially related to ${root_cause}` : ''}.

Sources to Scrape:
Reddit, forums, Facebook groups, and other online communities.${sourcesSection}

Search terms to use:
${keywordList.map(k => `* "${k}"`).join('\n')}

Tasks:
- Search posts and comment threads related to the search terms above
- Extract ${num_quotes || 20} emotionally powerful, first-person quotes that read like a gut punch — short, raw, personal confessions

Guidelines for Quotes:
* Prioritize first-person posts ("I", "my", "me")
* Keep spelling and tone intact
* Do NOT paraphrase or summarize — quotes must be verbatim
* Avoid clinical explanations, advice, or product recommendations
* Focus on emotional pain, fear, shame, frustration, or identity loss
* Do not include usernames or identifying details

Output format — return ONLY a valid JSON array, no markdown code fences, no explanation text:
[
  {
    "quote": "The verbatim first-person quote text...",
    "source": "reddit.com/r/subreddit or forum name",
    "source_url": "https://full-url-if-available",
    "emotional_intensity": "high or medium",
    "emotion": "frustration or desperation or anger or fear or hope or relief or shame or confusion",
    "context": "Brief 1-sentence context about where/why this was posted"
  }
]

Sort results by emotional intensity — highest (gut punch) first, lowest last. Return ONLY the JSON array.`;
}

// ── Perplexity Sonar search ───────────────────────────────────────────────────
async function searchWithPerplexity(config, onProgress) {
  const client = await getPerplexityClient();
  const prompt = buildMiningPrompt(config);

  onProgress({ type: 'engine_start', engine: 'perplexity', message: 'Starting Perplexity Sonar search...' });

  const response = await withRetry(
    () => client.chat.completions.create({
      model: 'sonar-pro',
      messages: [
        {
          role: 'system',
          content: 'You are a research assistant that finds authentic first-person quotes from online discussions. Always return results as a JSON array. Do not use markdown code fences — return raw JSON only.'
        },
        { role: 'user', content: prompt }
      ]
    }),
    { label: '[Perplexity search]' }
  );

  const rawText = response.choices[0]?.message?.content || '';
  const citations = response.citations || [];

  onProgress({
    type: 'engine_complete',
    engine: 'perplexity',
    message: `Perplexity search complete (${rawText.length} chars, ${citations.length} citations).`
  });

  return { rawText, citations: citations.map(c => typeof c === 'string' ? { url: c } : c) };
}

// ── Claude Opus 4.6 web search ────────────────────────────────────────────────
async function searchWithClaude(config, onProgress) {
  const client = await getAnthropicClient();
  const prompt = buildMiningPrompt(config);

  // Build domain filters
  const subredditList = config.subreddits ? JSON.parse(config.subreddits) : [];
  const forumList = config.forums ? JSON.parse(config.forums) : [];

  const allowedDomains = new Set();
  if (subredditList.length > 0) allowedDomains.add('reddit.com');
  allowedDomains.add('facebook.com');
  allowedDomains.add('quora.com');
  for (const forum of forumList) {
    try {
      const url = new URL(forum.startsWith('http') ? forum : `https://${forum}`);
      allowedDomains.add(url.hostname);
    } catch { /* skip invalid URLs */ }
  }

  const toolConfig = {
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: 15,
  };
  // Only restrict domains if we have a reasonable list (too many = too restrictive)
  const domainList = [...allowedDomains];
  if (domainList.length > 0 && domainList.length <= 10) {
    toolConfig.allowed_domains = domainList;
  }

  onProgress({ type: 'engine_start', engine: 'claude', message: 'Starting Claude Opus web search...' });

  const response = await withRetry(
    () => client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 16000,
      messages: [
        { role: 'user', content: prompt }
      ],
      tools: [toolConfig]
    }),
    { label: '[Claude web search]' }
  );

  // Extract text content from Claude's response
  let rawText = '';
  const citations = [];
  for (const block of response.content) {
    if (block.type === 'text') {
      rawText += block.text;
      // Collect inline citations if present
      if (block.citations) {
        for (const c of block.citations) {
          if (c.url) citations.push({ url: c.url, title: c.title || '' });
        }
      }
    }
  }

  onProgress({
    type: 'engine_complete',
    engine: 'claude',
    message: `Claude search complete (${rawText.length} chars).`
  });

  return { rawText, citations };
}

// ── Merge, deduplicate, and rank with GPT-4.1 ────────────────────────────────
async function mergeAndRankQuotes(perplexityResult, claudeResult, config, onProgress) {
  onProgress({ type: 'merge_start', message: 'Merging and ranking quotes with GPT-4.1...' });

  const numQuotes = config.num_quotes || 20;

  const mergePrompt = `You are a copywriting research assistant. I have two sets of raw search results from different search engines, both containing first-person quotes from ${config.target_demographic} about ${config.problem}.

Your tasks:
1. Parse both result sets and extract all individual quotes
2. Deduplicate — if the same quote (or very similar wording) appears in both sources, keep only one copy
3. Verify each quote is truly first-person (contains "I", "my", "we", "me", etc.)
4. Remove any quotes that are clinical, third-person, clearly paraphrased, or are advice/recommendations
5. Rank remaining quotes by emotional intensity — gut-punch confessions first, milder frustrations last
6. Keep the top ${numQuotes} quotes

SOURCE 1 (Perplexity Sonar):
${perplexityResult.rawText}

SOURCE 2 (Claude Web Search):
${claudeResult.rawText}

Return a JSON object with a "quotes" array. Each quote object must have these fields:
- "quote": The verbatim quote text
- "source": Platform or community name (e.g., "Reddit r/health")
- "source_url": URL if available, empty string if not
- "emotional_intensity": "high" or "medium"
- "emotion": One of: frustration, desperation, anger, fear, hope, relief, shame, confusion
- "context": Brief 1-sentence context

Return ONLY valid JSON, no extra text.`;

  const result = await chat(
    [{ role: 'user', content: mergePrompt }],
    'gpt-4.1',
    { response_format: { type: 'json_object' } }
  );

  // Parse GPT-4.1 response
  let quotes = [];
  try {
    const parsed = JSON.parse(result);
    // Handle both { quotes: [...] } and direct array formats
    quotes = Array.isArray(parsed) ? parsed : (parsed.quotes || []);
  } catch (err) {
    // Try to extract JSON array from the response
    const match = result.match(/\[[\s\S]*\]/);
    if (match) {
      quotes = JSON.parse(match[0]);
    } else {
      throw new Error('Failed to parse merged quotes from GPT-4.1');
    }
  }

  // Collect all unique source URLs
  const allCitations = [
    ...perplexityResult.citations,
    ...claudeResult.citations
  ];
  const sourcesUsed = [...new Set(allCitations.map(c => c.url).filter(Boolean))];

  onProgress({
    type: 'merge_complete',
    message: `Merge complete — ${quotes.length} unique quotes ranked by emotional intensity.`,
    quoteCount: quotes.length
  });

  return { quotes, sourcesUsed };
}

// ── Main orchestrator ─────────────────────────────────────────────────────────
export async function runQuoteMining(config, onProgress) {
  const startTime = Date.now();

  onProgress({ type: 'start', message: 'Starting dual-engine quote mining...' });

  // Run both engines in parallel — if one fails, the other can still succeed
  const [perplexityResult, claudeResult] = await Promise.allSettled([
    searchWithPerplexity(config, onProgress),
    searchWithClaude(config, onProgress)
  ]);

  // Extract results, handling partial failures
  const pResult = perplexityResult.status === 'fulfilled'
    ? perplexityResult.value
    : { rawText: '', citations: [] };
  const cResult = claudeResult.status === 'fulfilled'
    ? claudeResult.value
    : { rawText: '', citations: [] };

  if (perplexityResult.status === 'rejected') {
    console.warn('[QuoteMiner] Perplexity failed:', perplexityResult.reason?.message);
    onProgress({
      type: 'engine_error',
      engine: 'perplexity',
      message: `Perplexity error: ${perplexityResult.reason?.message || 'Unknown error'}`
    });
  }
  if (claudeResult.status === 'rejected') {
    console.warn('[QuoteMiner] Claude failed:', claudeResult.reason?.message);
    onProgress({
      type: 'engine_error',
      engine: 'claude',
      message: `Claude error: ${claudeResult.reason?.message || 'Unknown error'}`
    });
  }

  if (!pResult.rawText && !cResult.rawText) {
    throw new Error('Both search engines failed. Please check your API keys in Settings and try again.');
  }

  // Merge and rank
  const { quotes, sourcesUsed } = await mergeAndRankQuotes(pResult, cResult, config, onProgress);

  const durationMs = Date.now() - startTime;

  onProgress({
    type: 'complete',
    message: `Mining complete! Found ${quotes.length} quotes in ${Math.round(durationMs / 1000)}s.`,
    quoteCount: quotes.length
  });

  return {
    quotes,
    sourcesUsed,
    perplexityRaw: pResult.rawText,
    claudeRaw: cResult.rawText,
    durationMs
  };
}

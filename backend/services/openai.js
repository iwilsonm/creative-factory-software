import OpenAI from 'openai';
import { getSetting } from '../convexClient.js';
import { withRetry } from './retry.js';
import { logOpenAICost } from './costTracker.js';

let client = null;
let lastApiKey = null;

async function getClient() {
  const apiKey = await getSetting('openai_api_key');
  if (!apiKey) throw new Error('OpenAI API key not configured. Set it in Settings.');
  // Recreate if key changed
  if (!client || lastApiKey !== apiKey) {
    client = new OpenAI({ apiKey });
    lastApiKey = apiKey;
  }
  return client;
}

/**
 * Auto-log OpenAI cost from a chat completion response (fire-and-forget).
 * Follows the same pattern as anthropic.js logCostFromResponse.
 */
function logCostFromResponse(response, model, options) {
  if (!response?.usage) return;
  const { prompt_tokens, completion_tokens } = response.usage;
  if (!prompt_tokens && !completion_tokens) return;
  logOpenAICost({
    model,
    operation: options.operation || 'other',
    inputTokens: prompt_tokens || 0,
    outputTokens: completion_tokens || 0,
    projectId: options.projectId || null,
  }).catch(() => {});
}

/**
 * Send a multi-turn conversation to GPT and stream the response (Chat Completions API).
 * Cost is auto-logged via stream_options.include_usage.
 *
 * @param {Array} messages
 * @param {Function} onChunk - callback for each token
 * @param {string} model
 * @param {object} [options] - { operation, projectId } for cost tracking
 */
export async function chatStream(messages, onChunk, model = 'gpt-4.1', options = {}) {
  const openai = await getClient();
  const { operation, projectId } = options;
  const stream = await withRetry(
    () => openai.chat.completions.create({
      model, messages, stream: true,
      stream_options: { include_usage: true },
    }),
    { label: '[OpenAI chatStream]' }
  );

  let fullResponse = '';
  let usage = null;
  for await (const chunk of stream) {
    if (chunk.usage) usage = chunk.usage;
    const delta = chunk.choices?.[0]?.delta?.content || '';
    if (delta) {
      fullResponse += delta;
      if (onChunk) onChunk(delta);
    }
  }

  // Auto-log cost from final chunk usage
  if (usage) {
    logOpenAICost({
      model,
      operation: operation || 'other',
      inputTokens: usage.prompt_tokens || 0,
      outputTokens: usage.completion_tokens || 0,
      projectId: projectId || null,
    }).catch(() => {});
  }

  return fullResponse;
}

/**
 * Send a multi-turn conversation to GPT and get the full response (no streaming).
 * Cost is auto-logged from response.usage.
 *
 * @param {Array} messages
 * @param {string} model
 * @param {object} [options] - API options + { operation, projectId } for cost tracking
 */
export async function chat(messages, model = 'gpt-4.1', options = {}) {
  const openai = await getClient();
  const { operation, projectId, ...apiOptions } = options;
  const response = await withRetry(
    () => openai.chat.completions.create({ model, messages, ...apiOptions }),
    { label: '[OpenAI chat]' }
  );
  logCostFromResponse(response, model, { operation, projectId });
  return response.choices[0].message.content;
}

/**
 * Run a deep research query using the Responses API with o3-deep-research.
 * Cost is logged from billing API sync (Responses API doesn't return token usage in the same format).
 */
export async function deepResearch(prompt, options = {}) {
  const openai = await getClient();
  const {
    instructions,
    onProgress,
    pollIntervalMs = 5000,
    timeoutMs = 30 * 60 * 1000,
    model = 'o3-deep-research',
    operation = 'deep_research',
    projectId = null,
  } = options;

  const input = [];
  if (instructions) {
    input.push({
      role: 'developer',
      content: [{ type: 'input_text', text: instructions }]
    });
  }
  input.push({
    role: 'user',
    content: [{ type: 'input_text', text: prompt }]
  });

  let response = await withRetry(
    () => openai.responses.create({
      model,
      input,
      background: true,
      tools: [
        { type: 'web_search_preview' }
      ],
      reasoning: {
        summary: 'auto'
      }
    }),
    { label: '[OpenAI deepResearch init]' }
  );

  if (onProgress) {
    onProgress({
      status: response.status,
      message: 'Deep research started. The model is browsing the web and analyzing sources...'
    });
  }

  const startTime = Date.now();
  while (response.status === 'queued' || response.status === 'in_progress') {
    if (Date.now() - startTime > timeoutMs) {
      throw new Error(`Deep research timed out after ${timeoutMs / 1000 / 60} minutes`);
    }

    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));

    response = await withRetry(
      () => openai.responses.retrieve(response.id),
      { label: '[OpenAI deepResearch poll]', maxRetries: 2 }
    );

    if (onProgress) {
      const searchCalls = (response.output || []).filter(o => o.type === 'web_search_call');
      const reasoningSteps = (response.output || []).filter(o => o.type === 'reasoning');

      onProgress({
        status: response.status,
        searchesCompleted: searchCalls.length,
        reasoningSteps: reasoningSteps.length,
        message: `Status: ${response.status} | ${searchCalls.length} web searches completed`,
        elapsedMs: Date.now() - startTime
      });
    }
  }

  if (response.status === 'failed') {
    const errorMsg = response.error?.message || 'Deep research failed with unknown error';
    throw new Error(`Deep research failed: ${errorMsg}`);
  }

  if (response.status === 'cancelled') {
    throw new Error('Deep research was cancelled');
  }

  // Log cost if usage data is available in the Responses API response
  if (response.usage) {
    logOpenAICost({
      model,
      operation,
      inputTokens: response.usage.input_tokens || response.usage.prompt_tokens || 0,
      outputTokens: response.usage.output_tokens || response.usage.completion_tokens || 0,
      projectId,
    }).catch(() => {});
  }

  const outputMessage = (response.output || []).find(
    o => o.type === 'message' && o.role === 'assistant'
  );

  if (!outputMessage) {
    if (response.output_text) {
      return { text: response.output_text, citations: [] };
    }
    throw new Error('Deep research completed but no output found');
  }

  const textContent = outputMessage.content?.find(c => c.type === 'output_text');
  if (!textContent) {
    throw new Error('Deep research completed but no text content found');
  }

  const citations = (textContent.annotations || [])
    .filter(a => a.type === 'url_citation')
    .map(a => ({
      title: a.title,
      url: a.url,
      startIndex: a.start_index,
      endIndex: a.end_index
    }));

  return {
    text: textContent.text,
    citations
  };
}

/**
 * Send a message with an image (base64) to GPT.
 * Cost is auto-logged from response.usage.
 */
export async function chatWithImage(messages, text, base64Image, mimeType, model = 'gpt-4.1', options = {}) {
  const openai = await getClient();
  const { operation, projectId } = options;
  const newMessage = {
    role: 'user',
    content: [
      { type: 'text', text },
      { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } }
    ]
  };

  const response = await withRetry(
    () => openai.chat.completions.create({ model, messages: [...messages, newMessage] }),
    { label: '[OpenAI chatWithImage]' }
  );
  logCostFromResponse(response, model, { operation, projectId });
  return response.choices[0].message.content;
}

/**
 * Send a message with multiple images (base64) to GPT.
 * Cost is auto-logged from response.usage.
 */
export async function chatWithImages(messages, text, images, model = 'gpt-4.1', options = {}) {
  const openai = await getClient();
  const { operation, projectId } = options;
  const content = [
    { type: 'text', text }
  ];

  for (const img of images) {
    content.push({
      type: 'image_url',
      image_url: { url: `data:${img.mimeType};base64,${img.base64}` }
    });
  }

  const newMessage = { role: 'user', content };

  const response = await withRetry(
    () => openai.chat.completions.create({ model, messages: [...messages, newMessage] }),
    { label: '[OpenAI chatWithImages]' }
  );
  logCostFromResponse(response, model, { operation, projectId });
  return response.choices[0].message.content;
}

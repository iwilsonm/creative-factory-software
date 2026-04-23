import OpenAI from 'openai';
import { toFile } from 'openai/uploads';
import sharp from 'sharp';
import { getSetting } from '../convexClient.js';
import { withRetry } from './retry.js';
import { logOpenAICost, logOpenAIImageCost } from './costTracker.js';

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
 * Detect "model not available" errors from OpenAI. The SDK surfaces these as
 * APIError instances with status 404 and code/type 'model_not_found'.
 * Returns the offending model string from the error message if found, else true.
 */
function isModelNotFoundError(err) {
  if (!err) return false;
  const code = err.code || err.error?.code;
  const type = err.type || err.error?.type;
  const status = err.status || err.statusCode;
  if (code === 'model_not_found' || type === 'model_not_found') return true;
  if (status === 404 && /model/i.test(err.message || '')) return true;
  return false;
}

const OPENAI_FALLBACK_CHAIN = {
  'gpt-5.4': 'gpt-5.2',     // PEF plan 2026-04-21 — graceful fallback if 5.4 not yet available
};

/**
 * Send a multi-turn conversation to GPT and get the full response (no streaming).
 * Cost is auto-logged from response.usage.
 *
 * On `model_not_found`, the wrapper retries ONCE with the configured fallback
 * model (see OPENAI_FALLBACK_CHAIN). Emits a `warning` event via `options.onWarning`
 * so the SSE caller can surface the fallback to the user.
 *
 * @param {Array} messages
 * @param {string} model
 * @param {object} [options] - API options + { operation, projectId, onWarning } for cost tracking
 */
export async function chat(messages, model = 'gpt-4.1', options = {}) {
  const openai = await getClient();
  const { operation, projectId, onWarning, ...apiOptions } = options;
  let activeModel = model;
  try {
    const response = await withRetry(
      () => openai.chat.completions.create({ model: activeModel, messages, ...apiOptions }),
      { label: `[OpenAI chat ${activeModel}]` }
    );
    logCostFromResponse(response, activeModel, { operation, projectId });
    return response.choices[0].message.content;
  } catch (err) {
    const fallbackModel = OPENAI_FALLBACK_CHAIN[activeModel];
    if (fallbackModel && isModelNotFoundError(err)) {
      console.warn(`[OpenAI chat] Model ${activeModel} not found — falling back to ${fallbackModel}`);
      if (typeof onWarning === 'function') {
        try {
          onWarning({
            type: 'warning',
            tag: 'model_fallback',
            from: activeModel,
            to: fallbackModel,
            message: `OpenAI model ${activeModel} not available — using ${fallbackModel} instead.`,
          });
        } catch { /* swallow */ }
      }
      activeModel = fallbackModel;
      const response = await withRetry(
        () => openai.chat.completions.create({ model: activeModel, messages, ...apiOptions }),
        { label: `[OpenAI chat ${activeModel}]` }
      );
      logCostFromResponse(response, activeModel, { operation, projectId });
      return response.choices[0].message.content;
    }
    throw err;
  }
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

// =============================================
// Image generation — OpenAI gpt-image-2 family
// =============================================

// gpt-image-2 supports "flexible image sizes" per docs but specific allowed strings
// aren't enumerated publicly. These map to values that gpt-image-1 accepted — if
// gpt-image-2 rejects any, the API error surfaces in the caller's toast verbatim.
const ASPECT_TO_SIZE = {
  '1:1': '1024x1024',
  '4:5': '1024x1280',
  '9:16': '1024x1536',
  '16:9': '1536x1024',
};
const SIZE_FALLBACK = '1024x1024';
const DEFAULT_IMAGE_MODEL = 'gpt-image-2-2026-04-21';

/**
 * Generate an ad image via OpenAI's Images API.
 *
 * Signature intentionally matches `gemini.js#generateImage` so `adGenerator.js`
 * can branch between providers without per-call shape changes.
 *
 * @param {string} prompt - Image generation prompt
 * @param {string} [aspectRatio='1:1'] - '1:1' | '4:5' | '9:16' | '16:9'
 * @param {Buffer|null} [productImage=null] - Optional product reference image
 * @param {object} [options]
 * @param {string|null} [options.projectId]
 * @param {string} [options.operation='ad_image_generation']
 * @param {string} [options.imageModel] - Defaults to gpt-image-2-2026-04-21
 * @returns {Promise<{ imageBuffer: Buffer, mimeType: string, textResponse: string }>}
 */
export async function generateImage(prompt, aspectRatio = '1:1', productImage = null, options = {}) {
  const {
    projectId = null,
    operation = 'ad_image_generation',
    imageModel = DEFAULT_IMAGE_MODEL,
  } = options;

  const openai = await getClient();
  const size = ASPECT_TO_SIZE[aspectRatio] || SIZE_FALLBACK;

  const response = await withRetry(
    async () => {
      if (productImage) {
        // /v1/images/edits expects a PNG file-like for the reference image.
        const pngBuffer = await sharp(productImage).png().toBuffer();
        const file = await toFile(pngBuffer, 'reference.png', { type: 'image/png' });
        return openai.images.edit({
          model: imageModel,
          image: file,
          prompt,
          size,
          n: 1,
          response_format: 'b64_json',
        });
      }
      return openai.images.generate({
        model: imageModel,
        prompt,
        size,
        n: 1,
        response_format: 'b64_json',
      });
    },
    {
      maxRetries: 2,
      label: '[OpenAI generateImage]',
      shouldRetry: (err) => {
        // Don't retry fatal states — model-not-found, auth, tier gate.
        const status = err?.status || err?.response?.status;
        if (status === 400 || status === 401 || status === 403 || status === 404) return false;
        const msg = String(err?.message || '').toLowerCase();
        if (msg.includes('model') && (msg.includes('not found') || msg.includes('does not exist'))) return false;
        return true;
      },
    }
  );

  const b64 = response?.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI image generation returned no image data');
  const imageBuffer = Buffer.from(b64, 'base64');

  // Fire-and-forget cost log — matches logGeminiCost pattern.
  logOpenAIImageCost(projectId, operation, size, imageModel).catch(() => {});

  return { imageBuffer, mimeType: 'image/png', textResponse: '' };
}


import { GoogleGenAI } from '@google/genai';
import { getSetting } from '../convexClient.js';
import { withRetry } from './retry.js';
import { withGeminiLimit } from './rateLimiter.js';
import { logGeminiCost } from './costTracker.js';

let client = null;
let lastApiKey = null;

async function getClient() {
  const apiKey = await getSetting('gemini_api_key');
  if (!apiKey) throw new Error('Gemini API key not configured. Set it in Settings.');
  // Recreate if key changed
  if (!client || lastApiKey !== apiKey) {
    client = new GoogleGenAI({ apiKey });
    lastApiKey = apiKey;
  }
  return client;
}

// Model name mapping
const GEMINI_MODELS = {
  'nano-banana-pro': 'gemini-3-pro-image-preview',
  'nano-banana-2': 'gemini-3.1-flash-image-preview',
};

/**
 * Generate an image using Nano Banana Pro or Nano Banana 2.
 * Cost is auto-logged to Convex api_costs table.
 *
 * @param {string} prompt
 * @param {string} aspectRatio
 * @param {object|null} productImage - { base64, mimeType }
 * @param {object} [options] - { projectId, operation, isBatch, imageModel } for cost tracking + model selection
 */
export async function generateImage(prompt, aspectRatio = '1:1', productImage = null, options = {}) {
  const { projectId = null, operation = 'image_generation', isBatch = false, imageModel } = options;
  const ai = await getClient();

  // Resolve model name — default to Nano Banana 2
  const modelId = GEMINI_MODELS[imageModel] || GEMINI_MODELS['nano-banana-2'];
  const modelLabel = imageModel === 'nano-banana-pro' ? 'Nano Banana Pro' : 'Nano Banana 2';

  try {
  let contents;
  if (productImage) {
    contents = [
      { text: prompt },
      {
        inlineData: {
          data: productImage.base64,
          mimeType: productImage.mimeType
        }
      }
    ];
  } else {
    contents = prompt;
  }

  // Gemini sometimes returns 400 INVALID_ARGUMENT for transient issues (rate limits, capacity).
  // Custom retry predicate to handle this, plus standard network/server errors.
  const shouldRetryGemini = (err) => {
    const status = err.status || err.statusCode || err.httpCode;
    // Retry 400 from Gemini (transient INVALID_ARGUMENT errors)
    if (status === 400 && err.message?.includes('INVALID_ARGUMENT')) return true;
    // Retry 429 (rate limit) and 5xx (server errors)
    if (status === 429 || status >= 500) return true;
    // Retry network errors
    const networkCodes = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNREFUSED'];
    if (err.code && networkCodes.includes(err.code)) return true;
    if (err.message && /fetch|network|socket|ECONNRESET|ETIMEDOUT/i.test(err.message)) return true;
    return false;
  };

  const response = await withGeminiLimit(
    () => withRetry(
      () => ai.models.generateContent({
        model: modelId,
        contents,
        config: {
          responseModalities: ['TEXT', 'IMAGE'],
          imageConfig: {
            aspectRatio: aspectRatio || '1:1',
            imageSize: '512'
          }
        }
      }),
      { label: `[Gemini ${modelLabel}]`, maxRetries: 3, shouldRetry: shouldRetryGemini, baseDelayMs: 2000 }
    ),
    `[Gemini ${modelLabel} ${aspectRatio || '1:1'}]`
  );

  let imageBuffer = null;
  let mimeType = 'image/png';
  let textResponse = '';

  if (response.candidates && response.candidates[0]) {
    const parts = response.candidates[0].content?.parts || [];
    for (const part of parts) {
      if (part.inlineData) {
        imageBuffer = Buffer.from(part.inlineData.data, 'base64');
        mimeType = part.inlineData.mimeType || 'image/png';
      } else if (part.text) {
        textResponse += part.text;
      }
    }
  }

  if (!imageBuffer) {
    throw new Error(`${modelLabel} did not return an image. The model may have refused the prompt or encountered an error.`);
  }

  // Auto-log Gemini cost (fire-and-forget)
  logGeminiCost(projectId, 1, '512', isBatch, operation).catch(() => {});

  return { imageBuffer, mimeType, textResponse };
  } catch (err) {
    // Clean up Gemini API error messages — the SDK returns raw JSON as the message string
    if (err.message?.includes('INVALID_ARGUMENT')) {
      throw new Error('Image generation temporarily unavailable (Gemini API capacity issue). Please try again in a moment.');
    }
    if (err.message?.includes('RESOURCE_EXHAUSTED') || err.status === 429) {
      throw new Error('Image generation rate limit reached. Please wait a moment and try again.');
    }
    throw err;
  }
}

export { getClient };

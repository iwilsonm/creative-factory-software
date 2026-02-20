/**
 * Anthropic Claude API wrapper — mirrors the openai.js interface for drop-in use.
 *
 * Provides chat() and chatWithImage() functions that match the OpenAI signatures
 * but route to Claude Sonnet 4.6 via the Anthropic SDK.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getSetting } from '../convexClient.js';
import { withRetry } from './retry.js';

let client = null;
let lastApiKey = null;

async function getClient() {
  const apiKey = await getSetting('anthropic_api_key');
  if (!apiKey) throw new Error('Anthropic API key not configured. Set it in Settings.');
  if (!client || lastApiKey !== apiKey) {
    client = new Anthropic({ apiKey });
    lastApiKey = apiKey;
  }
  return client;
}

/**
 * Send a conversation to Claude and get the full response (no streaming).
 *
 * Accepts OpenAI-style messages array: [{ role: 'user'|'assistant', content: string }]
 * Automatically extracts system messages and passes them via the `system` parameter.
 *
 * @param {Array} messages - OpenAI-format messages array
 * @param {string} [model='claude-sonnet-4-6'] - Anthropic model name
 * @param {object} [options={}] - Extra options (e.g., max_tokens, response_format)
 * @returns {string} The assistant's response text
 */
export async function chat(messages, model = 'claude-sonnet-4-6', options = {}) {
  const anthropic = await getClient();

  // Separate system messages from conversation messages
  const systemMessages = messages.filter(m => m.role === 'system');
  const conversationMessages = messages.filter(m => m.role !== 'system');

  // Build system prompt from system messages (if any)
  const systemPrompt = systemMessages.length > 0
    ? systemMessages.map(m => m.content).join('\n\n')
    : undefined;

  // Convert messages — Anthropic requires alternating user/assistant
  const anthropicMessages = conversationMessages.map(m => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: typeof m.content === 'string' ? m.content : m.content,
  }));

  // Handle JSON mode — Anthropic doesn't have response_format, use prefill instead
  const wantJSON = options.response_format?.type === 'json_object';
  if (wantJSON) {
    // Add a prefill to force JSON output
    anthropicMessages.push({ role: 'assistant', content: '{' });
  }

  const createParams = {
    model,
    max_tokens: options.max_tokens || 16384,
    messages: anthropicMessages,
  };

  if (systemPrompt) {
    createParams.system = systemPrompt;
  }

  const response = await withRetry(
    () => anthropic.messages.create(createParams),
    { label: '[Anthropic chat]' }
  );

  let text = response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('');

  // If we used JSON prefill, prepend the opening brace back
  if (wantJSON) {
    text = '{' + text;
  }

  return text;
}

/**
 * Send a message with a single image (base64) to Claude.
 *
 * @param {Array} messages - Previous conversation messages (OpenAI format)
 * @param {string} text - Text prompt to accompany the image
 * @param {string} base64Image - Base64-encoded image data
 * @param {string} mimeType - Image MIME type (e.g., 'image/png', 'image/jpeg')
 * @param {string} [model='claude-sonnet-4-6'] - Anthropic model name
 * @returns {string} The assistant's response text
 */
export async function chatWithImage(messages, text, base64Image, mimeType, model = 'claude-sonnet-4-6') {
  const anthropic = await getClient();

  // Separate system messages from conversation messages
  const systemMessages = messages.filter(m => m.role === 'system');
  const conversationMessages = messages.filter(m => m.role !== 'system');

  const systemPrompt = systemMessages.length > 0
    ? systemMessages.map(m => m.content).join('\n\n')
    : undefined;

  // Convert previous messages
  const anthropicMessages = conversationMessages.map(m => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: typeof m.content === 'string' ? m.content : m.content,
  }));

  // Normalize MIME type for Anthropic (supports image/jpeg, image/png, image/gif, image/webp)
  let normalizedMime = mimeType;
  if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mimeType)) {
    normalizedMime = 'image/png'; // fallback
  }

  // Add the new message with image in Anthropic's format
  anthropicMessages.push({
    role: 'user',
    content: [
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: normalizedMime,
          data: base64Image,
        },
      },
      {
        type: 'text',
        text: text,
      },
    ],
  });

  const createParams = {
    model,
    max_tokens: 16384,
    messages: anthropicMessages,
  };

  if (systemPrompt) {
    createParams.system = systemPrompt;
  }

  const response = await withRetry(
    () => anthropic.messages.create(createParams),
    { label: '[Anthropic chatWithImage]' }
  );

  return response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('');
}

/**
 * Anthropic Claude API wrapper — mirrors the openai.js interface for drop-in use.
 *
 * Provides chat() and chatWithImage() functions that match the OpenAI signatures
 * but route to Claude via the Anthropic SDK.
 *
 * JSON mode: Neither Opus 4.6 nor Sonnet 4.6 support assistant message prefill.
 * For JSON output we add a JSON instruction to the system prompt and extract
 * JSON from the response text using a robust brace-matching parser.
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
 * Extract the first complete JSON object from a text string.
 * Handles cases where the model wraps JSON in markdown fences or adds prose.
 */
function extractJSON(text) {
  // Try direct parse first
  try { return JSON.parse(text.trim()); } catch {}

  // Strip markdown code fences
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch {}
  }

  // Find the first { ... } block (greedy)
  const braceStart = text.indexOf('{');
  if (braceStart !== -1) {
    // Find matching closing brace
    let depth = 0;
    for (let i = braceStart; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') depth--;
      if (depth === 0) {
        try { return JSON.parse(text.slice(braceStart, i + 1)); } catch {}
        break;
      }
    }
    // Last resort: try from first { to last }
    const lastBrace = text.lastIndexOf('}');
    if (lastBrace > braceStart) {
      try { return JSON.parse(text.slice(braceStart, lastBrace + 1)); } catch {}
    }
  }

  return null;
}

/**
 * Send a conversation to Claude and get the full response (no streaming).
 *
 * Accepts OpenAI-style messages array: [{ role: 'user'|'assistant', content: string }]
 * Automatically extracts system messages and passes them via the `system` parameter.
 *
 * JSON mode handling:
 * Adds a JSON instruction to the system prompt and extracts JSON from response.
 * No assistant prefill — current Claude models do not support it.
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
  let systemPrompt = systemMessages.length > 0
    ? systemMessages.map(m => m.content).join('\n\n')
    : undefined;

  // Convert messages — Anthropic requires alternating user/assistant
  const anthropicMessages = conversationMessages.map(m => ({
    role: m.role === 'user' ? 'user' : 'assistant',
    content: typeof m.content === 'string' ? m.content : m.content,
  }));

  // Handle JSON mode — add instruction to system prompt (no prefill, current models do not support it)
  const wantJSON = options.response_format?.type === 'json_object';
  if (wantJSON) {
    const jsonInstruction = '\n\nIMPORTANT: You must respond with ONLY a valid JSON object. No markdown fences, no prose before or after — just the raw JSON object starting with { and ending with }.';
    systemPrompt = systemPrompt ? systemPrompt + jsonInstruction : jsonInstruction;
  }

  const createParams = {
    model,
    max_tokens: options.max_tokens || 16384,
    messages: anthropicMessages,
  };

  if (systemPrompt) {
    createParams.system = systemPrompt;
  }

  // Use timeout if specified (in ms), default 120s
  const timeoutMs = options.timeout || 120000;

  const response = await withRetry(
    () => {
      const apiCall = anthropic.messages.create(createParams);
      // Race against timeout to prevent hanging calls
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Anthropic API call timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs)
      );
      return Promise.race([apiCall, timeoutPromise]);
    },
    { label: '[Anthropic chat]', maxRetries: options.maxRetries ?? 3 }
  );

  let text = response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('');

  // For JSON mode, extract the JSON object from the response
  if (wantJSON) {
    const parsed = extractJSON(text);
    if (parsed) {
      text = JSON.stringify(parsed);
    }
    // If extraction failed, return raw text — caller's repairJSON will handle it
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

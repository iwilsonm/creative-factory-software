import Anthropic from '@anthropic-ai/sdk';
import { getSetting } from '../convexClient.js';
import { withRetry } from './retry.js';

let client = null;
let lastApiKey = null;

async function getClient() {
  const apiKey = await getSetting('anthropic_api_key');
  if (!apiKey) throw new Error('Anthropic API key not configured. Set it in Settings.');
  // Recreate if key changed
  if (!client || lastApiKey !== apiKey) {
    client = new Anthropic({ apiKey });
    lastApiKey = apiKey;
  }
  return client;
}

/**
 * Convert OpenAI-style messages to Anthropic format.
 * - Extracts system messages into a separate system string (Anthropic doesn't use system role in messages)
 * - Keeps user/assistant messages as-is
 * - Converts any multipart content arrays (text + image_url) to Anthropic image format
 */
function convertMessages(messages) {
  const systemParts = [];
  const converted = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemParts.push(typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content));
      continue;
    }

    // Convert content if it's an array (multipart content with images)
    if (Array.isArray(msg.content)) {
      const newContent = msg.content.map(part => {
        if (part.type === 'image_url') {
          // Convert OpenAI image_url format to Anthropic image format
          const url = part.image_url.url;
          const match = url.match(/^data:(image\/[^;]+);base64,(.+)$/);
          if (match) {
            return {
              type: 'image',
              source: {
                type: 'base64',
                media_type: match[1],
                data: match[2]
              }
            };
          }
        }
        return part; // text parts pass through as-is
      });
      converted.push({ role: msg.role, content: newContent });
    } else {
      converted.push({ role: msg.role, content: msg.content });
    }
  }

  return {
    system: systemParts.length > 0 ? systemParts.join('\n\n') : undefined,
    messages: converted
  };
}

/**
 * Send a multi-turn conversation to Claude and get the full response (no streaming).
 * Same signature as openai.js chat() for easy swapping.
 */
export async function chat(messages, model = 'claude-sonnet-4-5-20250514', options = {}) {
  const anthropic = await getClient();
  const { system, messages: converted } = convertMessages(messages);

  const params = {
    model,
    max_tokens: options.max_tokens || 8192,
    messages: converted,
    ...options
  };
  if (system) params.system = system;
  // Remove max_tokens from spread options to avoid duplicate
  delete params.max_tokens;
  params.max_tokens = options.max_tokens || 8192;

  const response = await withRetry(
    () => anthropic.messages.create(params),
    { label: '[Anthropic chat]' }
  );
  return response.content[0].text;
}

/**
 * Send a message with an image (base64) to Claude.
 * Same signature as openai.js chatWithImage() for easy swapping.
 */
export async function chatWithImage(messages, text, base64Image, mimeType, model = 'claude-sonnet-4-5-20250514') {
  const anthropic = await getClient();

  const newMessage = {
    role: 'user',
    content: [
      { type: 'text', text },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: mimeType,
          data: base64Image
        }
      }
    ]
  };

  const { system, messages: converted } = convertMessages(messages);
  const allMessages = [...converted, newMessage];

  const params = {
    model,
    max_tokens: 8192,
    messages: allMessages
  };
  if (system) params.system = system;

  const response = await withRetry(
    () => anthropic.messages.create(params),
    { label: '[Anthropic chatWithImage]' }
  );
  return response.content[0].text;
}

/**
 * Send a message with multiple images (base64) to Claude.
 * Same signature as openai.js chatWithImages() for easy swapping.
 */
export async function chatWithImages(messages, text, images, model = 'claude-sonnet-4-5-20250514') {
  const anthropic = await getClient();

  const content = [
    { type: 'text', text }
  ];

  for (const img of images) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: img.mimeType,
        data: img.base64
      }
    });
  }

  const newMessage = { role: 'user', content };

  const { system, messages: converted } = convertMessages(messages);
  const allMessages = [...converted, newMessage];

  const params = {
    model,
    max_tokens: 8192,
    messages: allMessages
  };
  if (system) params.system = system;

  const response = await withRetry(
    () => anthropic.messages.create(params),
    { label: '[Anthropic chatWithImages]' }
  );
  return response.content[0].text;
}

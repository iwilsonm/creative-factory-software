import OpenAI from 'openai';
import { getSetting } from '../db.js';
import { withRetry } from './retry.js';

let client = null;

function getClient() {
  const apiKey = getSetting('openai_api_key');
  if (!apiKey) throw new Error('OpenAI API key not configured. Set it in Settings.');
  // Recreate if key changed
  if (!client || client.apiKey !== apiKey) {
    client = new OpenAI({ apiKey });
  }
  return client;
}

/**
 * Send a multi-turn conversation to GPT and stream the response (Chat Completions API).
 * Used for prep/synthesis steps that don't need deep research.
 * @param {Array} messages - OpenAI chat messages array
 * @param {(chunk: string) => void} onChunk - Called with each text delta
 * @param {string} model - Model to use (default: gpt-4.1)
 * @returns {Promise<string>} The full assistant response
 */
export async function chatStream(messages, onChunk, model = 'gpt-4.1') {
  const openai = getClient();
  const stream = await withRetry(
    () => openai.chat.completions.create({ model, messages, stream: true }),
    { label: '[OpenAI chatStream]' }
  );

  let fullResponse = '';
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content || '';
    if (delta) {
      fullResponse += delta;
      if (onChunk) onChunk(delta);
    }
  }
  return fullResponse;
}

/**
 * Send a multi-turn conversation to GPT and get the full response (no streaming).
 * Used for quick tasks like auto-describe.
 * @param {Array} messages - OpenAI chat messages array
 * @param {string} model - Model to use (default: gpt-4.1)
 * @returns {Promise<string>} The assistant response
 */
export async function chat(messages, model = 'gpt-4.1') {
  const openai = getClient();
  const response = await withRetry(
    () => openai.chat.completions.create({ model, messages }),
    { label: '[OpenAI chat]' }
  );
  return response.choices[0].message.content;
}

/**
 * Run a deep research query using the Responses API with o3-deep-research.
 * This uses background mode since deep research can take 5-15+ minutes.
 *
 * @param {string} prompt - The fully-formed research prompt
 * @param {object} options
 * @param {string} options.instructions - System-level instructions for the researcher
 * @param {(status: object) => void} options.onProgress - Called with status updates during polling
 * @param {number} options.pollIntervalMs - Polling interval (default: 5000ms)
 * @param {number} options.timeoutMs - Max wait time (default: 30 minutes)
 * @param {string} options.model - Deep research model (default: o3-deep-research)
 * @returns {Promise<{ text: string, citations: Array }>} The research report and citations
 */
export async function deepResearch(prompt, options = {}) {
  const openai = getClient();
  const {
    instructions,
    onProgress,
    pollIntervalMs = 5000,
    timeoutMs = 30 * 60 * 1000, // 30 minutes
    model = 'o3-deep-research'
  } = options;

  // Build the input messages
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

  // Create the deep research request in background mode
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

  // Poll for completion
  const startTime = Date.now();
  while (response.status === 'queued' || response.status === 'in_progress') {
    // Check timeout
    if (Date.now() - startTime > timeoutMs) {
      throw new Error(`Deep research timed out after ${timeoutMs / 1000 / 60} minutes`);
    }

    // Wait before polling
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));

    // Retrieve updated status
    response = await withRetry(
      () => openai.responses.retrieve(response.id),
      { label: '[OpenAI deepResearch poll]', maxRetries: 2 }
    );

    if (onProgress) {
      // Try to extract some progress info from intermediate output
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

  // Check for failure
  if (response.status === 'failed') {
    const errorMsg = response.error?.message || 'Deep research failed with unknown error';
    throw new Error(`Deep research failed: ${errorMsg}`);
  }

  if (response.status === 'cancelled') {
    throw new Error('Deep research was cancelled');
  }

  // Extract the final report text and citations
  const outputMessage = (response.output || []).find(
    o => o.type === 'message' && o.role === 'assistant'
  );

  if (!outputMessage) {
    // Fallback: try output_text
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
 * @param {Array} messages - Existing conversation messages
 * @param {string} text - Text prompt
 * @param {string} base64Image - Base64-encoded image
 * @param {string} mimeType - e.g. 'image/png'
 * @param {string} model - Model to use (default: gpt-4.1)
 * @returns {Promise<string>} The assistant response
 */
export async function chatWithImage(messages, text, base64Image, mimeType, model = 'gpt-4.1') {
  const openai = getClient();
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
  return response.choices[0].message.content;
}

/**
 * Send a message with multiple images (base64) to GPT.
 * @param {Array} messages - Existing conversation messages
 * @param {string} text - Text prompt
 * @param {Array<{ base64: string, mimeType: string }>} images - Array of images to attach
 * @param {string} model - Model to use (default: gpt-4.1)
 * @returns {Promise<string>} The assistant response
 */
export async function chatWithImages(messages, text, images, model = 'gpt-4.1') {
  const openai = getClient();
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
  return response.choices[0].message.content;
}

import { GoogleGenAI } from '@google/genai';
import { getSetting } from '../db.js';
import { withRetry } from './retry.js';

let client = null;
let lastApiKey = null;

function getClient() {
  const apiKey = getSetting('gemini_api_key');
  if (!apiKey) throw new Error('Gemini API key not configured. Set it in Settings.');
  // Recreate if key changed
  if (!client || lastApiKey !== apiKey) {
    client = new GoogleGenAI({ apiKey });
    lastApiKey = apiKey;
  }
  return client;
}

/**
 * Generate an image using Nano Banana Pro (Gemini 3 Pro Image Preview).
 * @param {string} prompt - The complete image generation prompt (from GPT-5.2 creative director)
 * @param {string} aspectRatio - Aspect ratio (default: "1:1")
 * @param {object} [productImage] - Optional product image to attach alongside the prompt
 * @param {string} productImage.base64 - Base64-encoded image data
 * @param {string} productImage.mimeType - MIME type (e.g. 'image/png')
 * @returns {{ imageBuffer: Buffer, mimeType: string, textResponse: string }}
 */
export async function generateImage(prompt, aspectRatio = '1:1', productImage = null) {
  const ai = getClient();

  // Build contents: text prompt + optional product image
  let contents;
  if (productImage) {
    // Multimodal: text + image parts
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
    // Text-only prompt
    contents = prompt;
  }

  const response = await withRetry(
    () => ai.models.generateContent({
      model: 'gemini-3-pro-image-preview',
      contents,
      config: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: {
          aspectRatio: aspectRatio || '1:1',
          imageSize: '2K'
        }
      }
    }),
    { label: '[Gemini generateImage]', maxRetries: 2 }
  );

  // Extract image and text from response
  let imageBuffer = null;
  let mimeType = 'image/png';
  let textResponse = '';

  if (response.candidates && response.candidates[0]) {
    const parts = response.candidates[0].content?.parts || [];
    for (const part of parts) {
      if (part.inlineData) {
        // Image data - decode from base64
        imageBuffer = Buffer.from(part.inlineData.data, 'base64');
        mimeType = part.inlineData.mimeType || 'image/png';
      } else if (part.text) {
        textResponse += part.text;
      }
    }
  }

  if (!imageBuffer) {
    throw new Error('Gemini did not return an image. The model may have refused the prompt or encountered an error.');
  }

  return { imageBuffer, mimeType, textResponse };
}

// Export client getter for batch API access (ai.batches.create, ai.batches.get)
export { getClient };

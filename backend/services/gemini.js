import { GoogleGenAI } from '@google/genai';
import { getSetting } from '../convexClient.js';
import { withRetry } from './retry.js';

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

/**
 * Generate an image using Nano Banana Pro (Gemini 3 Pro Image Preview).
 */
export async function generateImage(prompt, aspectRatio = '1:1', productImage = null) {
  const ai = await getClient();

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
    throw new Error('Gemini did not return an image. The model may have refused the prompt or encountered an error.');
  }

  return { imageBuffer, mimeType, textResponse };
}

export { getClient };

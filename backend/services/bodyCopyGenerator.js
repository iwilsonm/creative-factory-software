/**
 * bodyCopyGenerator.js — Generate ad body copy from headline + quote emotion
 *
 * Uses GPT-4.1-mini for fast, cheap body copy generation that
 * aligns with a specific headline and the emotional tone of the source quote.
 */

import { chat } from './openai.js';

/**
 * Generate body copy for a static ad image.
 * @param {string} headline - The chosen headline
 * @param {object} quote - The source quote object { quote, emotion, emotional_intensity }
 * @param {string} targetDemographic - e.g., "women over 60"
 * @param {string} problem - e.g., "middle-of-the-night insomnia"
 * @returns {Promise<string>} The generated body copy text
 */
export async function generateBodyCopy(headline, quote, targetDemographic, problem) {
  const result = await chat([
    {
      role: 'system',
      content: `You are a direct response copywriter specializing in static image ads. Generate short, punchy body copy (1-3 sentences max) that appears below the headline in an ad. The body copy should:
- Support and reinforce the headline
- Mirror the emotional tone of the source quote
- Speak directly to the target demographic using "you" language
- Include a subtle curiosity hook or call-to-action
- Be concise enough to fit on a static ad image (under 30 words)
Return ONLY the body copy text, nothing else.`
    },
    {
      role: 'user',
      content: `HEADLINE: "${headline}"

SOURCE QUOTE (the raw emotion this ad should channel):
"${quote.quote}"
Emotion: ${quote.emotion || 'unknown'}
Intensity: ${quote.emotional_intensity || 'unknown'}

TARGET DEMOGRAPHIC: ${targetDemographic}
PROBLEM: ${problem}

Generate body copy that would appear below the headline in a static image ad.`
    }
  ], 'gpt-4.1-mini');

  return result.trim();
}

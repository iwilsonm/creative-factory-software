/**
 * bodyCopyGenerator.js — Generate ad body copy from headline + quote emotion
 *
 * Uses GPT-4.1-mini for fast, cheap body copy generation that
 * aligns with a specific headline and the emotional tone of the source quote.
 */

import { chat } from './openai.js';

const STYLE_INSTRUCTIONS = {
  short: `Write 1-2 concise sentences (under 30 words). Punchy, direct, and action-oriented.`,
  bullets: `Write 3-5 short, punchy bullet points. Each bullet should be a single compelling phrase or sentence. Use a simple dash (-) prefix for each bullet. Keep total length under 60 words.`,
  paragraph: `Write 2-3 flowing sentences that tell a mini-story or paint a vivid picture. Conversational but persuasive. Keep under 50 words.`,
  story: `Write a mini-story narrative hook (40-50 words). Start with a relatable moment or scenario, then pivot to the product/solution. Make the reader see themselves in the story.`,
};

/**
 * Generate body copy for a static ad image.
 * @param {string} headline - The chosen headline
 * @param {object} quote - The source quote object { quote, emotion, emotional_intensity }
 * @param {string} targetDemographic - e.g., "women over 60"
 * @param {string} problem - e.g., "middle-of-the-night insomnia"
 * @param {string} [style='short'] - Body copy style: 'short' | 'bullets' | 'paragraph' | 'story'
 * @returns {Promise<string>} The generated body copy text
 */
export async function generateBodyCopy(headline, quote, targetDemographic, problem, style = 'short') {
  const styleKey = STYLE_INSTRUCTIONS[style] ? style : 'short';
  const styleInstruction = STYLE_INSTRUCTIONS[styleKey];

  const result = await chat([
    {
      role: 'system',
      content: `You are a direct response copywriter specializing in static image ads. Generate body copy that appears below the headline in an ad. The body copy should:
- Support and reinforce the headline
- Mirror the emotional tone of the source quote
- Speak directly to the target demographic using "you" language
- Include a subtle curiosity hook or call-to-action

STYLE: ${styleInstruction}

Return ONLY the body copy text, nothing else. No quotes, no labels, no explanations.`
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

Generate body copy in the "${styleKey}" style that would appear below the headline in a static image ad.`
    }
  ], 'gpt-4.1-mini', { operation: 'body_copy_generation' });

  return result.trim();
}

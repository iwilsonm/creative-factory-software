/**
 * conductorAngles.js — Claude-powered angle auto-generation
 *
 * Generates new advertising angles from foundational docs + quote bank.
 * Used by the Director when angle_mode is "auto" or "mixed".
 */

import { v4 as uuidv4 } from 'uuid';
import { chat as anthropicChat } from './anthropic.js';
import {
  getLatestDoc,
  getConductorAngles,
  createConductorAngle,
  getQuoteBankByProject,
} from '../convexClient.js';

/**
 * Generate N new angles for a project using Claude.
 * @param {string} projectId
 * @param {number} count - how many angles to generate
 * @returns {Array<{ name, description, prompt_hints }>}
 */
export async function generateAngles(projectId, count = 3) {
  // Load foundational docs
  const [avatar, offerBrief, beliefs] = await Promise.all([
    getLatestDoc(projectId, 'avatar'),
    getLatestDoc(projectId, 'offer_brief'),
    getLatestDoc(projectId, 'necessary_beliefs'),
  ]);

  const docContext = [
    avatar?.content ? `CUSTOMER AVATAR:\n${avatar.content}` : '',
    offerBrief?.content ? `OFFER BRIEF:\n${offerBrief.content}` : '',
    beliefs?.content ? `NECESSARY BELIEFS:\n${beliefs.content}` : '',
  ].filter(Boolean).join('\n\n');

  if (!docContext) {
    throw new Error('No foundational docs found. Generate docs before creating angles.');
  }

  // Load existing angles
  const existingAngles = await getConductorAngles(projectId);
  const activeAngles = existingAngles.filter(a => a.status === 'active' || a.status === 'testing');
  const retiredAngles = existingAngles.filter(a => a.status === 'archived' || a.status === 'retired');

  // Load top quotes from quote bank (most emotionally intense)
  const quotes = await getQuoteBankByProject(projectId);
  const topQuotes = quotes
    .filter(q => q.emotional_intensity === 'high')
    .slice(0, 10)
    .map(q => `"${q.quote}" — ${q.source || 'unknown'} (${q.emotion || 'unknown emotion'})`)
    .join('\n');

  const prompt = `You are the Creative Director for a direct response advertising campaign.

PRODUCT CONTEXT:
${docContext}

EXISTING ANGLES IN ROTATION:
${activeAngles.length > 0
    ? activeAngles.map(a => `- ${a.name}: ${a.description} (used ${a.times_used}x)`).join('\n')
    : '(none yet)'}

ANGLES ALREADY ARCHIVED:
${retiredAngles.length > 0
    ? retiredAngles.map(a => `- ${a.name}: ${a.description}`).join('\n')
    : '(none)'}

${topQuotes ? `QUOTE BANK HIGHLIGHTS (real customer voices):\n${topQuotes}` : ''}

TASK:
Generate ${count} new advertising angles for this product. Each angle must:
1. Target a distinct emotional trigger or audience segment
2. NOT overlap with existing or retired angles
3. Be specific enough to guide ad creative (not generic like "health benefits")
4. Include a short name, detailed description, and specific prompt hints for guiding image and copy generation

Return ONLY a JSON array, no other text:
[{
  "name": "Short Angle Name",
  "description": "2-3 sentence description of the angle, the emotion it targets, and why it would resonate with the target audience",
  "prompt_hints": "Specific direction for ad creative: visual style, copy tone, key phrases to use, imagery suggestions"
}]`;

  const response = await anthropicChat(prompt, {
    model: 'claude-sonnet-4-5-20250929',
    maxTokens: 2000,
    operation: 'conductor_angle_generation',
    projectId,
  });

  // Parse response
  let angles;
  try {
    // Handle potential markdown code fences
    let text = response.trim();
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    angles = JSON.parse(text);
  } catch (err) {
    console.error('[ConductorAngles] Failed to parse Claude response:', response.slice(0, 200));
    throw new Error('Failed to parse angle generation response');
  }

  if (!Array.isArray(angles)) {
    throw new Error('Expected JSON array from angle generation');
  }

  // Save angles to database
  const savedAngles = [];
  for (const angle of angles.slice(0, count)) {
    const id = uuidv4();
    await createConductorAngle({
      id,
      project_id: projectId,
      name: angle.name,
      description: angle.description,
      prompt_hints: angle.prompt_hints || '',
      source: 'auto_generated',
      status: 'testing',
    });
    savedAngles.push({ id, ...angle });
  }

  console.log(`[ConductorAngles] Generated ${savedAngles.length} new angles for project ${projectId.slice(0, 8)}`);
  return savedAngles;
}

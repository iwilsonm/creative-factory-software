/**
 * Angle Writer Service
 *
 * LLM-powered generation of new angles for winning frames.
 * When a frame has 2+ T1 (profitable) angles, the CMO generates new variations.
 *
 * Uses Claude Opus for creative strategy generation.
 */

import { v4 as uuidv4 } from 'uuid';
import { chat } from './anthropic.js';
import {
  getConductorAngles,
  createConductorAngle,
} from '../convexClient.js';

/**
 * Generate new angle variations for a winning frame.
 *
 * @param {object} params
 * @param {string} params.projectId
 * @param {string} params.frame - The winning frame (e.g. "symptom-first")
 * @param {object[]} params.winningAngles - T1 angles in this frame
 * @param {number} [params.count=3] - Number of new angles to generate
 * @returns {Promise<object[]>} Array of newly created angle objects
 */
export async function generateNewAngles({ projectId, frame, winningAngles, count = 3 }) {
  // Get all existing angles to avoid duplicates
  const existingAngles = await getConductorAngles(projectId);
  const existingNames = new Set(existingAngles.map(a => a.name.toLowerCase()));

  const prompt = `You are a Senior Performance Marketer analyzing ad angle performance data.

## Context
We have a winning advertising frame: "${frame}"
This frame has ${winningAngles.length} profitable (T1) angles that are performing well.

## Winning Angles (T1 — Profitable)
${winningAngles.map(a => `- **${a.angleName}**: CPA $${a.cpa}, ROAS ${a.roas}x, ${a.conversions} conversions, $${a.spend} spend`).join('\n')}

## Existing Angles (avoid duplicating)
${existingAngles.map(a => `- ${a.name}: ${a.description?.slice(0, 80) || 'no description'}`).join('\n')}

## Task
Generate ${count} NEW angle variations within the "${frame}" frame that:
1. Build on the patterns from the winning angles above
2. Explore different buyer segments, pain points, or emotional hooks
3. Are distinct from ALL existing angles listed above
4. Follow the same structured format

## Output Format
Return a JSON array of exactly ${count} angle objects:
[
  {
    "name": "short-kebab-case-name",
    "description": "2-3 sentence description of this angle's creative strategy",
    "core_buyer": "Who this angle targets",
    "symptom_pattern": "What symptom/pain point to lead with",
    "emotional_state": "The emotional state to tap into",
    "scene": "Scene to center the ad on",
    "desired_belief_shift": "What belief should shift",
    "tone": "Tone direction",
    "avoid_list": "What to avoid"
  }
]

Return ONLY the JSON array, no markdown fences.`;

  const response = await chat(
    [{ role: 'user', content: prompt }],
    'claude-sonnet-4-20250514',
    { operation: 'cmo_angle_writing', projectId }
  );

  // Parse response
  let newAngles;
  try {
    const cleaned = response.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    newAngles = JSON.parse(cleaned);
  } catch {
    const match = response.match(/\[[\s\S]*\]/);
    if (match) {
      try { newAngles = JSON.parse(match[0]); } catch { /* fall through */ }
    }
    if (!newAngles) {
      console.error('[AngleWriter] Failed to parse LLM response');
      return [];
    }
  }

  if (!Array.isArray(newAngles)) return [];

  // Create the angles in the database
  const created = [];
  for (const angle of newAngles.slice(0, count)) {
    // Skip if name already exists
    if (existingNames.has((angle.name || '').toLowerCase())) continue;

    const id = uuidv4();
    try {
      await createConductorAngle({
        id,
        project_id: projectId,
        name: angle.name,
        description: angle.description || '',
        source: 'auto_generated',
        status: 'testing',
        priority: 'medium',
        frame,
        core_buyer: angle.core_buyer || undefined,
        symptom_pattern: angle.symptom_pattern || undefined,
        emotional_state: angle.emotional_state || undefined,
        scene: angle.scene || undefined,
        desired_belief_shift: angle.desired_belief_shift || undefined,
        tone: angle.tone || undefined,
        avoid_list: angle.avoid_list || undefined,
      });

      created.push({ id, name: angle.name, frame, description: angle.description });
    } catch (err) {
      console.error(`[AngleWriter] Failed to create angle "${angle.name}":`, err.message);
    }
  }

  return created;
}

/**
 * conductorLearning.js — Recursive learning system for ad generation
 *
 * After each Filter scoring round, analyzes winners vs losers per angle
 * and updates the conductor_playbooks with pattern insights.
 * The Director injects these playbooks into future batch prompts.
 */

import { chat as anthropicChat } from './anthropic.js';
import {
  getConductorPlaybook,
  upsertConductorPlaybook,
  getConductorAngles,
} from '../convexClient.js';

/**
 * Run learning analysis for a specific angle after Filter scoring.
 * Called by the Creative Filter after scoring a batch that has angle_name set.
 *
 * @param {string} projectId
 * @param {string} angleName — the angle this batch was generated for
 * @param {Array} scoredAds — array of { ad_id, score, reasoning, headline, body, angle, image_prompt }
 */
export async function runLearningStep(projectId, angleName, scoredAds) {
  if (!angleName || !scoredAds?.length) {
    console.log('[Learning] No angle or scored ads — skipping learning step');
    return null;
  }

  console.log(`[Learning] Running analysis for angle "${angleName}" (${scoredAds.length} ads scored)`);

  // Separate winners and losers
  const sorted = [...scoredAds].sort((a, b) => (b.score || 0) - (a.score || 0));
  const winners = sorted.filter(a => (a.score || 0) >= 7).slice(0, 3);
  const losers = sorted.filter(a => (a.score || 0) < 7).slice(-3);

  if (winners.length === 0 && losers.length === 0) {
    console.log('[Learning] No clear winners or losers — skipping');
    return null;
  }

  // Load existing playbook
  const existingPlaybook = await getConductorPlaybook(projectId, angleName);

  // Load angle description for context
  const angles = await getConductorAngles(projectId);
  const angle = angles.find(a => a.name === angleName);
  const angleDesc = angle
    ? `${angle.description}\nPrompt hints: ${angle.prompt_hints || 'none'}`
    : angleName;

  // Calculate cumulative stats
  const totalScored = (existingPlaybook?.total_scored || 0) + scoredAds.length;
  const passedThisRound = scoredAds.filter(a => (a.score || 0) >= 7).length;
  const totalPassed = (existingPlaybook?.total_passed || 0) + passedThisRound;
  const passRate = totalScored > 0 ? totalPassed / totalScored : 0;

  // Format winners/losers for the prompt
  const formatAd = (ad) => {
    const parts = [];
    if (ad.headline) parts.push(`Headline: ${ad.headline}`);
    if (ad.body) parts.push(`Body: ${ad.body?.slice(0, 200)}`);
    if (ad.image_prompt) parts.push(`Image prompt: ${ad.image_prompt?.slice(0, 200)}`);
    parts.push(`Score: ${ad.score}/10`);
    if (ad.reasoning) parts.push(`Reasoning: ${ad.reasoning}`);
    return parts.join('\n  ');
  };

  const winnersText = winners.length > 0
    ? winners.map((a, i) => `Winner ${i + 1}:\n  ${formatAd(a)}`).join('\n\n')
    : '(No clear winners this round)';

  const losersText = losers.length > 0
    ? losers.map((a, i) => `Loser ${i + 1}:\n  ${formatAd(a)}`).join('\n\n')
    : '(No clear losers this round)';

  const previousPlaybook = existingPlaybook
    ? `PREVIOUS PLAYBOOK (v${existingPlaybook.version}):
Visual patterns: ${existingPlaybook.visual_patterns || 'none yet'}
Copy patterns: ${existingPlaybook.copy_patterns || 'none yet'}
Avoid patterns: ${existingPlaybook.avoid_patterns || 'none yet'}
Generation hints: ${existingPlaybook.generation_hints || 'none yet'}`
    : '(No previous playbook — this is the first analysis)';

  const prompt = `You are analyzing ad creative performance for the angle "${angleName}".

ANGLE DESCRIPTION:
${angleDesc}

${previousPlaybook}

THIS ROUND'S WINNERS (passed Filter, score >= 7):
${winnersText}

THIS ROUND'S LOSERS (failed Filter, score < 7):
${losersText}

HISTORICAL STATS:
Total ads scored for this angle: ${totalScored}
Total that passed: ${totalPassed}
Pass rate: ${Math.round(passRate * 100)}%
${existingPlaybook ? `Previous pass rate: ${Math.round((existingPlaybook.pass_rate || 0) * 100)}%` : ''}

Analyze the patterns:
1. What visual styles are winning? What's failing?
2. What copy approaches resonate? What falls flat?
3. What specific things should future prompts AVOID?
4. What concrete generation hints would improve future ads?

Return ONLY a JSON object, no other text:
{
  "visual_patterns": "What visual styles work well for this angle",
  "copy_patterns": "What copy approaches resonate with the audience",
  "avoid_patterns": "Specific things that consistently fail — AVOID these",
  "generation_hints": "Concrete, actionable prompt adjustments for the ad generator",
  "raw_analysis": "Your full analysis in 2-3 sentences"
}`;

  try {
    const response = await anthropicChat(
      [{ role: 'user', content: prompt }],
      'claude-sonnet-4-6',
      {
        maxTokens: 1500,
        operation: 'conductor_learning_analysis',
        projectId,
      }
    );

    // Parse response
    let analysis;
    let text = response.trim();
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    analysis = JSON.parse(text);

    // Save/update playbook
    const newVersion = (existingPlaybook?.version || 0) + 1;

    await upsertConductorPlaybook({
      project_id: projectId,
      angle_name: angleName,
      version: newVersion,
      total_scored: totalScored,
      total_passed: totalPassed,
      pass_rate: passRate,
      visual_patterns: analysis.visual_patterns || '',
      copy_patterns: analysis.copy_patterns || '',
      avoid_patterns: analysis.avoid_patterns || '',
      generation_hints: analysis.generation_hints || '',
      raw_analysis: analysis.raw_analysis || '',
    });

    console.log(`[Learning] Updated playbook for "${angleName}" to v${newVersion} (pass rate: ${Math.round(passRate * 100)}%)`);

    return {
      angleName,
      version: newVersion,
      passRate,
      totalScored,
      totalPassed,
    };
  } catch (err) {
    console.error(`[Learning] Failed to analyze angle "${angleName}":`, err.message);
    return null;
  }
}

/**
 * Get the adaptive batch size for an angle based on its playbook.
 * Called by the Director when creating batches.
 *
 * @param {string} projectId
 * @param {string} angleName
 * @param {number} defaultSize — from conductor_config.ads_per_batch
 * @returns {number} adjusted batch size
 */
export async function getAdaptiveBatchSize(projectId, angleName, defaultSize = 18) {
  if (!angleName) return defaultSize;

  const playbook = await getConductorPlaybook(projectId, angleName);
  if (!playbook || playbook.total_scored < 50) {
    // Not enough data to adapt
    return defaultSize;
  }

  const passRate = playbook.pass_rate || 0;

  if (passRate > 0.7) return Math.max(14, defaultSize - 4);    // Confident — fewer needed
  if (passRate >= 0.5) return defaultSize;                      // Normal
  if (passRate >= 0.3) return Math.min(22, defaultSize + 4);    // Compensate
  return Math.min(26, defaultSize + 8);                          // Struggling angle
}

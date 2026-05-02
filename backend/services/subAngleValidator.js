// Phase 4 — Pure validators + sanitizer for sub-angle candidates.
// Extracted from subAngleDeriver.js so they can be unit-tested without
// pulling in Convex / Anthropic transitive deps.

export const DEFAULTS = {
  health_bias: false,
  sub_angle_derivation_enabled: true,
  sub_angle_derivation_mode: 'auto',
  sub_angle_derivation_threshold: 3,
  sub_angle_derivation_min_unique_days: 1,
  sub_angle_derivation_max_per_run: 3,
  sub_angle_derivation_cooldown_days: 7,
  sub_angle_max_depth: 3,
  sub_angle_exploration_boost_days: 14,
  sub_angle_lineage_cap_share: 0.6,
  sub_angle_min_active_for_health_bias: 3,
  sub_angle_min_active_for_lineage_cap: 5,
  sub_angle_per_project_daily_cost_cap_usd: 0.45,
};

export const FRAME_ENUM = [
  'symptom-first', 'scam', 'objection-first', 'identity-first',
  'MAHA', 'news-first', 'consequence-first',
];

export const STRING_CAP = 500;
export const PROMPT_HINTS_CAP = 2000;

const INJECTION_PATTERN = /^(\s*ignore|system:|<\/?(system|instruction|user|assistant)[^>]*>)/i;

export function sanitizeContextForLLM(text, maxLen = 4000) {
  if (!text) return '';
  const lines = String(text).split('\n');
  const clean = lines.filter((l) => !INJECTION_PATTERN.test(l));
  let joined = clean.join('\n');
  if (joined.length > maxLen) joined = joined.slice(0, maxLen) + '... [truncated]';
  return joined;
}

export function validateSubAngleCandidate(candidate, parent, existingNames) {
  const out = { ok: true, normalized: {}, normalizations: [] };

  if (typeof candidate.name !== 'string' || !candidate.name.trim()) {
    out.ok = false;
    out.normalizations.push({ field: 'name', issue: 'missing or empty' });
    return out;
  }
  let baseName = candidate.name.trim().slice(0, 80);
  if (baseName === parent.name) {
    out.ok = false;
    out.normalizations.push({ field: 'name', issue: 'collides with parent' });
    return out;
  }
  let finalName = baseName;
  let suffix = 2;
  while (existingNames.has(finalName)) {
    finalName = `${baseName} v${suffix++}`;
    if (suffix > 20) {
      out.ok = false;
      out.normalizations.push({ field: 'name', issue: 'cannot find unique name' });
      return out;
    }
  }
  out.normalized.name = finalName;

  out.normalized.description = String(candidate.description || '').slice(0, STRING_CAP);
  if (!out.normalized.description) {
    out.ok = false;
    out.normalizations.push({ field: 'description', issue: 'missing' });
    return out;
  }

  if (typeof candidate.frame === 'string' && FRAME_ENUM.includes(candidate.frame)) {
    out.normalized.frame = candidate.frame;
  } else if (parent.frame && FRAME_ENUM.includes(parent.frame)) {
    out.normalized.frame = parent.frame;
    if (candidate.frame) {
      out.normalizations.push({ field: 'frame', issue: `invalid '${candidate.frame}' → parent's '${parent.frame}'` });
    }
  } else {
    out.normalized.frame = undefined;
  }

  const fields = ['scene', 'objection', 'emotional_state', 'symptom_pattern', 'core_buyer', 'failed_solutions', 'current_belief', 'desired_belief_shift', 'tone', 'avoid_list'];
  for (const f of fields) {
    if (candidate[f]) {
      out.normalized[f] = sanitizeContextForLLM(String(candidate[f]), STRING_CAP);
    } else if (parent[f]) {
      out.normalized[f] = parent[f];
    }
  }

  if (candidate.prompt_hints) {
    const cleaned = sanitizeContextForLLM(String(candidate.prompt_hints), PROMPT_HINTS_CAP);
    if (cleaned.length < 20 && parent.prompt_hints) {
      out.normalized.prompt_hints = parent.prompt_hints;
      out.normalizations.push({ field: 'prompt_hints', issue: 'sanitized too short → inherited from parent' });
    } else {
      out.normalized.prompt_hints = cleaned;
    }
  } else if (parent.prompt_hints) {
    out.normalized.prompt_hints = parent.prompt_hints;
  }

  out.normalized.reasoning = sanitizeContextForLLM(String(candidate.reasoning || candidate.justification || ''), 1000);

  return out;
}

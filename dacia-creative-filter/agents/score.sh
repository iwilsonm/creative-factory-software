#!/bin/bash
# ============================================================
# DACIA CREATIVE FILTER - Score Agent (Claude Sonnet 4.6)
# Part of the Dacia Recursive Agents team
# Cost: ~$0.02 per ad
# ============================================================
# Scores a single ad creative on:
#   1. Copy strength (40%) — headline hook, emotional pull, curiosity, CTA
#   2. Meta compliance (30%) — no flagged claims, policy violations
#   3. Overall effectiveness (20%) — would this stop the scroll?
#   4. Visual-copy alignment (10%) — does the image match the copy tone?
#
# Input: JSON ad object via stdin
# Output: JSON score object
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${SCRIPT_DIR}/config/filter.conf"

AD_JSON="$1"
TOP_PERFORMERS="$2"

# Extract ad details
HEADLINE=$(echo "$AD_JSON" | jq -r '.headline // ""')
PRIMARY_TEXT=$(echo "$AD_JSON" | jq -r '.body_copy // .primary_text // ""')
ANGLE=$(echo "$AD_JSON" | jq -r '.angle // ""')
AD_ID=$(echo "$AD_JSON" | jq -r '.externalId // ._id // "unknown"')

PROMPT="You are a senior direct response creative director evaluating ad creatives for Meta (Facebook/Instagram) advertising.

Score this ad creative. Be critical — only genuinely strong ads should score 7+.

AD CREATIVE:
Headline: ${HEADLINE}
Primary Text: ${PRIMARY_TEXT}
Angle: ${ANGLE}

TOP PERFORMING ADS FROM THIS BRAND (for reference — what's already working):
${TOP_PERFORMERS}

=== HARD REQUIREMENTS (auto-fail if ANY are violated) ===

These are non-negotiable. If ANY of these fail, the ad MUST score 0 and pass=false:

1. SPELLING & GRAMMAR: Every word must be spelled correctly. Grammar must be clean and professional. No typos, no awkward phrasing, no missing punctuation. One spelling error = auto-fail.

2. FIRST LINE HOOK: The very first line of the primary text MUST be a strong hook — a pattern interrupt, curiosity gap, bold claim, or emotional opener that stops the scroll. If the first line is weak, generic, or forgettable, auto-fail.

3. CTA AT END: The primary text MUST end with a clear call to action. The reader should know exactly what to do next (click, shop, learn more, etc.). If there's no CTA or it's buried in the middle, auto-fail.

4. HEADLINE-AD ALIGNMENT: The headline must directly relate to and reinforce the primary text and the ad's angle. If the headline feels disconnected from the primary text or could belong to a completely different ad, auto-fail.

=== SCORING CRITERIA (only score if hard requirements pass) ===

1. COPY STRENGTH (40% weight)
- Is the headline a pattern interrupt? Would it stop the scroll?
- Does it create genuine curiosity or emotional tension?
- Is the first-line hook genuinely compelling (not just present)?
- Is the CTA motivated and urgent (not just present)?
- Does the primary text build a coherent argument from hook to CTA?
- Does it use specific, concrete language (not vague/generic)?
- Does the headline work WITH the primary text as a unified message?

2. META COMPLIANCE (30% weight)
- Any income or earnings claims (explicit or implied)?
- Any before/after implications?
- Any health claims that guarantee outcomes (\"cure\", \"fix\", \"eliminate\")?
- Any \"this one trick\" / \"doctors hate this\" style claims?
- Any use of \"you\" in ways that imply personal attributes?
- Would this survive Meta's ad review without rejection?

3. OVERALL EFFECTIVENESS (20% weight)
- Would this actually convert? Is there a reason to click?
- Does it speak to a real pain point or desire?
- Is the value proposition clear?
- Does the hook → body → CTA flow create momentum?
- How does it compare to the top performers?

4. VISUAL-COPY ALIGNMENT (10% weight)
- Does the copy tone match what you'd expect from an ad image?
- Is there a clear visual hook implied by the copy?
- Would a viewer who sees the image first find the copy relevant?

Respond ONLY with this exact JSON format, nothing else:
{
  \"ad_id\": \"${AD_ID}\",
  \"hard_requirements\": {
    \"spelling_grammar\": <true/false>,
    \"first_line_hook\": <true/false>,
    \"cta_at_end\": <true/false>,
    \"headline_alignment\": <true/false>,
    \"all_passed\": <true only if ALL four are true>
  },
  \"copy_strength\": <1-10, or 0 if hard req failed>,
  \"compliance\": <1-10, or 0 if hard req failed>,
  \"effectiveness\": <1-10, or 0 if hard req failed>,
  \"visual_alignment\": <1-10, or 0 if hard req failed>,
  \"overall_score\": <1-10 weighted average, or 0 if hard req failed>,
  \"pass\": <true ONLY if all hard requirements passed AND overall_score >= ${SCORE_THRESHOLD}>,
  \"compliance_flags\": [\"list any specific issues\"],
  \"spelling_errors\": [\"list any misspellings or grammar issues found\"],
  \"strengths\": [\"top 2 strengths\"],
  \"weaknesses\": [\"top 2 weaknesses\"],
  \"angle_category\": \"brief label for the angle/theme (e.g. 'fear of chemicals', 'social proof', 'convenience')\"
}"

RESPONSE=$(curl -s "https://api.anthropic.com/v1/messages" \
  -H "Content-Type: application/json" \
  -H "x-api-key: ${ANTHROPIC_API_KEY}" \
  -H "anthropic-version: 2023-06-01" \
  -d "$(jq -n \
    --arg model "$SCORE_MODEL" \
    --arg prompt "$PROMPT" \
    '{
      "model": $model,
      "max_tokens": 1024,
      "temperature": 0,
      "messages": [{"role": "user", "content": $prompt}]
    }')")

# Extract and clean JSON
echo "$RESPONSE" | jq -r '.content[0].text // "{\"error\": \"No score generated\"}"' | \
  sed 's/```json//g; s/```//g' | tr -d '\n' | jq '.'

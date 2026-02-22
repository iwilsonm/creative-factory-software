#!/bin/bash
# ============================================================
# DACIA CREATIVE FILTER - Copy Validator (Claude Sonnet 4.6)
# Part of the Dacia Recursive Agents team
# Cost: ~$0.01 per call (small input/output)
# ============================================================
# Validates regenerated headlines or primary texts against
# the same hard requirements used in the main scoring agent.
#
# Input: JSON array of copy candidates + mode
# Output: JSON array with pass/fail per item
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${SCRIPT_DIR}/config/filter.conf"

MODE="$1"       # "headlines" or "primary_texts"
CANDIDATES="$2" # JSON array of candidates
ANGLE="$3"      # angle/theme for alignment check

if [[ "$MODE" == "headlines" ]]; then

PROMPT="You are a quality control editor for direct response ad headlines.

Check each headline against these HARD REQUIREMENTS. Be strict — one failure = reject.

ANGLE/THEME: ${ANGLE}

REQUIREMENTS:
1. SPELLING AND GRAMMAR: Perfect. Zero errors.
2. PATTERN INTERRUPT: Must stop the scroll. Creates curiosity or emotional tension.
3. ALIGNMENT: Must relate to the angle: ${ANGLE}
4. META COMPLIANT: No income claims, before/after, health guarantees, or 'you' implying attributes.

HEADLINES TO VALIDATE:
${CANDIDATES}

Respond ONLY with JSON:
{
  \"results\": [
    {
      \"text\": \"the headline\",
      \"spelling_clean\": true/false,
      \"is_pattern_interrupt\": true/false,
      \"aligned_to_angle\": true/false,
      \"meta_compliant\": true/false,
      \"pass\": true (only if ALL above are true),
      \"rejection_reason\": \"reason if failed, empty string if passed\"
    }
  ]
}"

elif [[ "$MODE" == "primary_texts" ]]; then

PROMPT="You are a quality control editor for direct response ad primary texts.

Check each primary text against these HARD REQUIREMENTS. Be strict — one failure = reject.

ANGLE/THEME: ${ANGLE}

REQUIREMENTS:
1. SPELLING AND GRAMMAR: Perfect. Zero errors.
2. FIRST LINE HOOK: First line must be a powerful pattern interrupt. Weak/generic = fail.
3. CTA AT END: Must end with a clear, motivated call to action.
4. ALIGNMENT: Must relate to the angle: ${ANGLE}
5. META COMPLIANT: No income claims, before/after, health guarantees, or 'you' implying attributes.

PRIMARY TEXTS TO VALIDATE:
${CANDIDATES}

Respond ONLY with JSON:
{
  \"results\": [
    {
      \"text\": \"the primary text\",
      \"spelling_clean\": true/false,
      \"first_line_hook_strong\": true/false,
      \"has_cta_at_end\": true/false,
      \"aligned_to_angle\": true/false,
      \"meta_compliant\": true/false,
      \"pass\": true (only if ALL above are true),
      \"rejection_reason\": \"reason if failed, empty string if passed\"
    }
  ]
}"

fi

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

echo "$RESPONSE" | jq -r '.content[0].text // "{\"error\": \"No validation\"}"' | \
  sed 's/```json//g; s/```//g' | tr -d '\n' | jq '.'

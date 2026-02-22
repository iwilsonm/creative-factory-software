#!/bin/bash
# ============================================================
# DACIA CREATIVE FILTER - Regenerate Agent (Claude Sonnet 4.6)
# Part of the Dacia Recursive Agents team
# Cost: ~$0.04 per call
# ============================================================
# Generates new headlines or primary texts when the batch output
# didn't produce enough quality copy for a flex ad.
#
# Modes: "headlines" or "primary_texts"
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${SCRIPT_DIR}/config/filter.conf"

MODE="$1"          # "headlines" or "primary_texts"
COUNT_NEEDED="$2"  # how many we still need
ANGLE="$3"         # the angle/theme for this flex ad
EXISTING="$4"      # JSON array of already-approved copy (for variety)
TOP_PERFORMERS="$5" # top performing ads from Meta for reference
PROJECT_NAME="$6"

if [[ "$MODE" == "headlines" ]]; then

PROMPT="You are a senior direct response copywriter writing headlines for Meta (Facebook/Instagram) ads.

BRAND: ${PROJECT_NAME}
ANGLE/THEME: ${ANGLE}

You need to write ${COUNT_NEEDED} new headlines for this angle. These headlines will be used in a flex ad (multi-image ad) where Meta rotates and tests them against 10 different images.

HEADLINES ALREADY APPROVED (do NOT duplicate these — write DIFFERENT approaches to the same angle):
${EXISTING}

TOP PERFORMING ADS FROM THIS BRAND (match this level of quality):
${TOP_PERFORMERS}

=== HARD REQUIREMENTS — every headline MUST meet ALL of these ===

1. SPELLING AND GRAMMAR: Perfect. Zero errors. Professional and clean.
2. PATTERN INTERRUPT: The headline must stop the scroll. It should create curiosity, emotional tension, or a bold claim that demands attention.
3. ALIGNMENT: Must clearly relate to the angle/theme: ${ANGLE}
4. BROAD ENOUGH: Must work with any of 10 different images on the same theme.
5. VARIETY: Each headline must take a DIFFERENT approach to the angle. Different hooks, different framings, different emotional levers. Do not write variations of the same sentence.
6. META COMPLIANT: No income claims, no before/after implications, no health guarantees, no 'you' implying personal attributes.

=== DIRECT RESPONSE PRINCIPLES ===
- Lead with the benefit or the pain point, not the product
- Use specific, concrete language — not vague/generic
- Create a curiosity gap or open loop when possible
- Keep it punchy — headlines should be scannable

Respond ONLY with this exact JSON format:
{
  \"headlines\": [
    {
      \"text\": \"headline text\",
      \"approach\": \"1-2 words describing the hook approach (e.g. 'curiosity gap', 'social proof', 'fear-based', 'contrarian')\"
    }
  ]
}"

elif [[ "$MODE" == "primary_texts" ]]; then

PROMPT="You are a senior direct response copywriter writing primary text (body copy) for Meta (Facebook/Instagram) ads.

BRAND: ${PROJECT_NAME}
ANGLE/THEME: ${ANGLE}

You need to write ${COUNT_NEEDED} new primary texts for this angle. These will be used in a flex ad where Meta rotates and tests them against multiple headlines and 10 different images.

PRIMARY TEXTS ALREADY APPROVED (do NOT duplicate these — write DIFFERENT approaches):
${EXISTING}

TOP PERFORMING ADS FROM THIS BRAND (match this level of quality):
${TOP_PERFORMERS}

=== HARD REQUIREMENTS — every primary text MUST meet ALL of these ===

1. SPELLING AND GRAMMAR: Perfect. Zero errors. Professional and clean.

2. FIRST LINE HOOK (CRITICAL): The very first line MUST be a powerful pattern interrupt. This is what people see in the feed before clicking 'see more'. It must create immediate curiosity, emotional tension, or a bold claim. Examples of strong first lines:
   - A shocking statistic or fact
   - A contrarian statement that challenges beliefs
   - A vivid emotional scene the reader recognizes
   - A direct question that hits a pain point
   Weak first lines that will be REJECTED: generic statements, 'Did you know...', 'Are you tired of...', product descriptions, anything forgettable.

3. CTA AT END (CRITICAL): The last 1-2 sentences MUST be a clear, motivated call to action. The reader should feel urgency or desire to click. Not just 'Click here' — give them a reason. Examples:
   - 'Tap the link to see why thousands are making the switch.'
   - 'Get yours before they sell out — shop now.'

4. ALIGNMENT: Must clearly speak to the angle/theme: ${ANGLE}

5. BROAD ENOUGH: Must work with any of 10 different images on the same theme. Do not reference a specific image.

6. VARIETY: Each primary text must take a DIFFERENT approach. Different hooks, different emotional journeys, different structures. Do not write variations of the same text.

7. META COMPLIANT: No income claims, no before/after implications, no health guarantees, no 'you' implying personal attributes.

=== STRUCTURE ===
Each primary text should follow: Hook (first line) → Build tension/desire → Proof/credibility → CTA
Keep them between 3-6 sentences. Punchy, not bloated.

Respond ONLY with this exact JSON format:
{
  \"primary_texts\": [
    {
      \"text\": \"full primary text with hook first line and CTA at end\",
      \"approach\": \"1-2 words describing the hook approach\"
    }
  ]
}"

else
  echo "{\"error\": \"Invalid mode: $MODE. Use 'headlines' or 'primary_texts'\"}"
  exit 1
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
      "max_tokens": 2048,
      "temperature": 0.7,
      "messages": [{"role": "user", "content": $prompt}]
    }')")

echo "$RESPONSE" | jq -r '.content[0].text // "{\"error\": \"No copy generated\"}"' | \
  sed 's/```json//g; s/```//g' | tr -d '\n' | jq '.'

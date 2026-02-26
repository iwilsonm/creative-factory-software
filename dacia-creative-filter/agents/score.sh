#!/bin/bash
# ============================================================
# DACIA CREATIVE FILTER - Score Agent (Claude Sonnet 4.6)
# Part of the Dacia Recursive Agents team
# Cost: ~$0.03 per ad (vision adds ~$0.01)
# ============================================================
# Scores a single ad creative on:
#   1. Copy strength (35%) — headline hook, emotional pull, curiosity, CTA
#   2. Meta compliance (25%) — no flagged claims, policy violations
#   3. Overall effectiveness (20%) — would this stop the scroll?
#   4. Image quality (20%) — missing product, blank spaces, visual defects
#
# Input: $1 = JSON ad object, $2 = top performers text
# Output: JSON score object
# ============================================================

set -euo pipefail

# Clean up temp files on exit (prevents /tmp accumulation on crash/interrupt)
trap 'rm -f /tmp/filter_img_$$.bin /tmp/filter_b64_$$.txt /tmp/filter_body_$$.json /tmp/filter_resp_$$.json 2>/dev/null' EXIT INT TERM

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${SCRIPT_DIR}/config/filter.conf"

AD_JSON="$1"
TOP_PERFORMERS="$2"

# Extract ad details
HEADLINE=$(echo "$AD_JSON" | jq -r '.headline // ""')
PRIMARY_TEXT=$(echo "$AD_JSON" | jq -r '.body_copy // .primary_text // ""')
ANGLE=$(echo "$AD_JSON" | jq -r '.angle // ""')
AD_ID=$(echo "$AD_JSON" | jq -r '.externalId // ._id // "unknown"')
STORAGE_ID=$(echo "$AD_JSON" | jq -r '.storageId // ""')

# ── Resolve image URL and download for vision ──────────────────────────
IMAGE_BASE64=""
IMAGE_MIME="image/png"
HAS_IMAGE=false

if [[ -n "$STORAGE_ID" ]]; then
  # Resolve storageId → Convex CDN URL
  IMAGE_URL=$(curl -s "${CONVEX_URL}/api/query" \
    -H "Content-Type: application/json" \
    -d "{
      \"path\": \"fileStorage:getUrl\",
      \"args\": {\"storageId\": \"${STORAGE_ID}\"}
    }" 2>/dev/null | jq -r '.value // ""') || true

  if [[ -n "$IMAGE_URL" && "$IMAGE_URL" != "null" ]]; then
    # Download image and base64-encode it
    TEMP_IMG="/tmp/filter_img_$$.bin"
    HTTP_CODE=$(curl -s -w "%{http_code}" -o "$TEMP_IMG" --max-time 15 "$IMAGE_URL" 2>/dev/null) || true

    if [[ "$HTTP_CODE" == "200" && -s "$TEMP_IMG" ]]; then
      IMAGE_BASE64=$(base64 -w 0 "$TEMP_IMG" 2>/dev/null || base64 "$TEMP_IMG" 2>/dev/null) || true
      # Detect MIME type from file header
      FILE_TYPE=$(file -b --mime-type "$TEMP_IMG" 2>/dev/null) || true
      if [[ "$FILE_TYPE" == "image/jpeg" || "$FILE_TYPE" == "image/png" || "$FILE_TYPE" == "image/webp" || "$FILE_TYPE" == "image/gif" ]]; then
        IMAGE_MIME="$FILE_TYPE"
      fi
      if [[ -n "$IMAGE_BASE64" ]]; then
        HAS_IMAGE=true
      fi
    fi
    rm -f "$TEMP_IMG"
  fi
fi

# ── Build prompt ───────────────────────────────────────────────────────

# Image-specific instructions only included when we have the image
IMAGE_INSTRUCTIONS=""
IMAGE_HARD_REQ=""
IMAGE_SCORING=""
IMAGE_JSON_FIELDS=""
if [[ "$HAS_IMAGE" == "true" ]]; then
  IMAGE_INSTRUCTIONS="
You are also looking at the actual generated ad image. Evaluate the IMAGE for quality issues."

  IMAGE_HARD_REQ="
5. IMAGE COMPLETENESS: Look at the ad image carefully. If there is a clearly visible blank/empty space where a product image should be (a white rectangle, an empty product placeholder, a gap in the layout where something is obviously missing), auto-fail. This does NOT mean the product must be in every ad — lifestyle shots, text-only designs, and abstract visuals are fine. Only fail if there is an obvious HOLE or BLANK AREA that looks like a broken image or missing product render."

  IMAGE_SCORING="
5. IMAGE QUALITY (20% weight)
- Is the image visually complete? No blank spaces, missing renders, or broken layouts?
- Does the image look professional? No obvious AI artifacts, distorted faces, mangled text?
- Does the image support the ad's message? Does it match the angle and copy tone?
- Would this image stop the scroll on a Facebook/Instagram feed?
- Are there any wrong products shown (competitor products, unrelated items)?
NOTE: You do NOT need the product to appear in every ad. Lifestyle scenes, testimonial-style layouts, and text-heavy designs are all valid. Only dock points for genuinely broken or low-quality visuals."

  IMAGE_JSON_FIELDS="
  \"image_quality\": <1-10, or 0 if hard req failed>,
  \"image_issues\": [\"list any visual issues: blank spaces, artifacts, wrong products, etc.\"],"
else
  IMAGE_SCORING="
5. VISUAL-COPY ALIGNMENT (10% weight — image not available for review)
- Does the copy tone match what you'd expect from an ad image?
- Is there a clear visual hook implied by the copy?"

  IMAGE_JSON_FIELDS="
  \"image_quality\": null,
  \"image_issues\": [],"
fi

PROMPT="You are a senior direct response creative director evaluating ad creatives for Meta (Facebook/Instagram) advertising. You specialize in health, wellness, and e-commerce brands.${IMAGE_INSTRUCTIONS}

Score this ad creative. Be critical but fair — only genuinely strong ads should score 7+.

AD CREATIVE:
Headline: ${HEADLINE}
Primary Text: ${PRIMARY_TEXT}
Angle: ${ANGLE}

TOP PERFORMING ADS FROM THIS BRAND (for reference — what's already working):
${TOP_PERFORMERS}

=== HARD REQUIREMENTS (auto-fail if ANY are violated) ===

These are non-negotiable. If ANY of these fail, the ad MUST score 0 and pass=false:

1. SPELLING & GRAMMAR: Actual misspelled words or broken grammar. This means REAL typos (e.g. \"teh\" instead of \"the\", \"recieve\" instead of \"receive\") and genuinely ungrammatical sentences. IMPORTANT: The following are NOT spelling or grammar errors — do NOT flag these:
   - Numbers without dollar signs or commas (e.g. \"4300\" or \"149\" are fine in ad copy — this is a common style choice)
   - Informal/conversational tone (sentence fragments, starting with \"And\" or \"But\", casual phrasing — this is direct response style)
   - Intentional stylistic choices like em dashes, ellipses, ALL CAPS for emphasis
   - Missing Oxford commas (style preference, not an error)
   Only flag ACTUAL misspellings and genuinely broken grammar that would make the ad look unprofessional.

2. FIRST LINE HOOK: The very first line of the primary text MUST be a strong hook — a pattern interrupt, curiosity gap, bold claim, or emotional opener that stops the scroll. If the first line is weak, generic, or forgettable, auto-fail.

3. CTA AT END: The primary text MUST end with a clear call to action. The reader should know exactly what to do next (click, shop, learn more, etc.). If there's no CTA or it's buried in the middle, auto-fail.

4. HEADLINE-AD ALIGNMENT: The headline must directly relate to and reinforce the primary text and the ad's angle. If the headline feels disconnected from the primary text or could belong to a completely different ad, auto-fail.
${IMAGE_HARD_REQ}
=== SCORING CRITERIA (only score if hard requirements pass) ===

1. COPY STRENGTH (35% weight)
- Is the headline a pattern interrupt? Would it stop the scroll?
- Does it create genuine curiosity or emotional tension?
- Is the first-line hook genuinely compelling (not just present)?
- Is the CTA motivated and urgent (not just present)?
- Does the primary text build a coherent argument from hook to CTA?
- Does it use specific, concrete language (not vague/generic)?
- Does the headline work WITH the primary text as a unified message?

2. META COMPLIANCE (25% weight)
- Any income or earnings claims (explicit or implied)?
- Any before/after implications?
- Any health claims that GUARANTEE specific outcomes (e.g. \"this will cure your...\" or \"eliminates pain 100%\")?
- IMPORTANT: General wellness claims are acceptable on Meta. Phrases like \"reduce inflammation\", \"support recovery\", \"improve sleep quality\", \"natural pain relief\" are compliant and commonly approved. Only flag claims that guarantee specific medical outcomes or diagnose/treat/cure diseases.
- Any \"this one trick\" / \"doctors hate this\" style clickbait?
- Any use of \"you\" in ways that call out personal attributes (e.g. \"Are you overweight?\", \"Is your credit score low?\")?
- Would this realistically survive Meta's ad review? (Meta approves most health/wellness product ads that don't make guarantee claims)

3. OVERALL EFFECTIVENESS (20% weight)
- Would this actually convert? Is there a reason to click?
- Does it speak to a real pain point or desire?
- Is the value proposition clear?
- Does the hook → body → CTA flow create momentum?
- How does it compare to the top performers?
${IMAGE_SCORING}
Respond ONLY with this exact JSON format, nothing else:
{
  \"ad_id\": \"${AD_ID}\",
  \"hard_requirements\": {
    \"spelling_grammar\": <true/false>,
    \"first_line_hook\": <true/false>,
    \"cta_at_end\": <true/false>,
    \"headline_alignment\": <true/false>,
    \"image_completeness\": <true/false or null if no image>,
    \"all_passed\": <true only if ALL requirements (including image if present) are true>
  },
  \"copy_strength\": <1-10, or 0 if hard req failed>,
  \"compliance\": <1-10, or 0 if hard req failed>,
  \"effectiveness\": <1-10, or 0 if hard req failed>,${IMAGE_JSON_FIELDS}
  \"overall_score\": <1-10 weighted average, or 0 if hard req failed>,
  \"pass\": <true ONLY if all hard requirements passed AND overall_score >= ${SCORE_THRESHOLD}>,
  \"compliance_flags\": [\"list any specific issues\"],
  \"spelling_errors\": [\"list any misspellings or grammar issues found\"],
  \"strengths\": [\"top 2 strengths\"],
  \"weaknesses\": [\"top 2 weaknesses\"],
  \"angle_category\": \"brief label for the angle/theme (e.g. 'fear of chemicals', 'social proof', 'convenience')\"
}"

# ── Build API request with or without image ────────────────────────────

if [[ "$HAS_IMAGE" == "true" ]]; then
  # Vision request: image + text in content array
  # Use --rawfile for base64 data to avoid "Argument list too long" on large images
  TEMP_B64="/tmp/filter_b64_$$.txt"
  echo -n "$IMAGE_BASE64" > "$TEMP_B64"
  API_BODY=$(jq -n \
    --arg model "$SCORE_MODEL" \
    --arg prompt "$PROMPT" \
    --rawfile img_data "$TEMP_B64" \
    --arg img_mime "$IMAGE_MIME" \
    '{
      "model": $model,
      "max_tokens": 1024,
      "temperature": 0,
      "messages": [{
        "role": "user",
        "content": [
          {
            "type": "image",
            "source": {
              "type": "base64",
              "media_type": $img_mime,
              "data": $img_data
            }
          },
          {
            "type": "text",
            "text": $prompt
          }
        ]
      }]
    }')
  rm -f "$TEMP_B64"
else
  # Text-only request (fallback if image unavailable)
  API_BODY=$(jq -n \
    --arg model "$SCORE_MODEL" \
    --arg prompt "$PROMPT" \
    '{
      "model": $model,
      "max_tokens": 1024,
      "temperature": 0,
      "messages": [{"role": "user", "content": $prompt}]
    }')
fi

TEMP_BODY="/tmp/filter_body_$$.json"
echo "$API_BODY" > "$TEMP_BODY"

# Retry loop for Anthropic API (handles 429, 529, transient failures)
MAX_RETRIES=3
RETRY_DELAY=15
RESPONSE=""
for attempt in $(seq 1 $MAX_RETRIES); do
  HTTP_CODE=$(curl -s -w "\n%{http_code}" --max-time 120 "https://api.anthropic.com/v1/messages" \
    -H "Content-Type: application/json" \
    -H "x-api-key: ${ANTHROPIC_API_KEY}" \
    -H "anthropic-version: 2023-06-01" \
    -d "@${TEMP_BODY}" -o /tmp/filter_resp_$$.json 2>/dev/null) || HTTP_CODE="000"
  HTTP_CODE=$(echo "$HTTP_CODE" | tail -1)
  RESPONSE=$(cat /tmp/filter_resp_$$.json 2>/dev/null || echo "")
  rm -f /tmp/filter_resp_$$.json

  if [[ "$HTTP_CODE" == "200" ]]; then
    break
  elif [[ "$HTTP_CODE" == "429" || "$HTTP_CODE" == "529" || "$HTTP_CODE" == "000" ]]; then
    if [[ "$attempt" -lt "$MAX_RETRIES" ]]; then
      sleep $((RETRY_DELAY * attempt))
    fi
  else
    break  # Non-retryable error
  fi
done
rm -f "$TEMP_BODY"

# Extract and clean JSON
echo "$RESPONSE" | jq -r '.content[0].text // "{\"error\": \"No score generated\"}"' | \
  sed 's/```json//g; s/```//g' | tr -d '\n' | jq '.'

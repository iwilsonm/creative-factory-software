#!/bin/bash
# ============================================================
# DACIA CREATIVE FILTER - Group Agent (Claude Sonnet 4.6)
# Part of the Dacia Recursive Agents team
# Cost: ~$0.04 per batch
# ============================================================
# Takes all passing ads and groups them into flex ads:
#   - Cluster by angle/theme
#   - Pick 2 strongest angle clusters
#   - Select best 10 images per cluster
#   - Choose 3-5 headlines + 3-5 primary texts per cluster
#   - Minimum 3 of each required to execute
#
# Input: JSON array of scored ads (passing only)
# Output: JSON flex ad definitions
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${SCRIPT_DIR}/config/filter.conf"

SCORED_ADS="$1"
PROJECT_NAME="$2"
FLEX_AD_COUNT="${3:-$FLEX_AD_COUNT}"  # Per-project override or config default

PROMPT="You are a media buyer assembling flex ads (multi-image ad groups) for Meta advertising.

You have a set of scored ad creatives that all passed quality filtering. You need to:

1. GROUP them by angle/theme into distinct clusters
2. SELECT the ${FLEX_AD_COUNT} strongest clusters (most coherent angle + highest avg scores)
3. PICK the best ${IMAGES_PER_FLEX} ads from each cluster (these will be the images)
4. SELECT 3-5 HEADLINES for each cluster (Meta will test combinations)
5. SELECT 3-5 PRIMARY TEXTS for each cluster (Meta will test combinations)

BRAND: ${PROJECT_NAME}

=== FLEX AD STRUCTURE ===

Each flex ad contains:
- 10 images
- 3-5 headlines (Meta rotates and tests which performs best)
- 3-5 primary texts (Meta rotates and tests which performs best)

Target 5 of each, but minimum 3 are required. If you cannot find at least 3 quality headlines or 3 quality primary texts for a cluster, DO NOT create that flex ad — skip it.

=== CRITICAL COPY QUALITY RULES ===

EVERY headline and primary text you select MUST meet ALL of these. Do not include ANY that violate even one rule:

1. SPELLING AND GRAMMAR: Every word must be spelled correctly. Grammar must be clean and professional. One error = do not include it.

2. FIRST LINE HOOK (primary texts only): Every primary text MUST have a strong, compelling first line — a pattern interrupt, curiosity gap, bold claim, or emotional opener. This is what people see before clicking 'see more'. Weak first line = do not include it.

3. CTA AT END (primary texts only): Every primary text MUST end with a clear call to action. No CTA = do not include it.

4. THEMATIC ALIGNMENT: Every headline and every primary text must fit the cluster's angle. They do not all need to come from the same ad, but they must all speak to the same core theme/pain point/desire.

5. BROAD ENOUGH FOR ALL IMAGES: Each headline and primary text needs to make sense with any of the 10 images in the group. Avoid copy that references something too specific to one image.

6. VARIETY: The 3-5 headlines should take different approaches to the same angle (different hooks, different framings). Same for primary texts. Do not pick 5 headlines that say basically the same thing.

SCORED ADS (all passing):
${SCORED_ADS}

RULES:
- Each flex ad must have exactly ${IMAGES_PER_FLEX} images
- Each flex ad gets 3-5 headlines AND 3-5 primary texts (target 5, minimum 3)
- If a cluster cannot produce at least 3 quality headlines AND 3 quality primary texts, skip it and try the next best cluster
- The ${FLEX_AD_COUNT} flex ads should target DIFFERENT angles for audience variety
- Prefer ads with higher overall_score within each cluster
- If two ads in the same cluster are nearly identical, prefer the one with higher copy_strength
- Do not include any copy from compliance-flagged ads

Respond ONLY with this exact JSON format:
{
  \"flex_ads\": [
    {
      \"flex_ad_number\": 1,
      \"angle_theme\": \"descriptive label for this flex ad's angle\",
      \"headlines\": [
        {
          \"text\": \"headline text\",
          \"source_ad_id\": \"ad_id it came from\",
          \"spelling_clean\": true
        }
      ],
      \"primary_texts\": [
        {
          \"text\": \"full primary text\",
          \"source_ad_id\": \"ad_id it came from\",
          \"first_line_hook_strong\": true,
          \"has_cta_at_end\": true,
          \"spelling_clean\": true
        }
      ],
      \"headline_count\": <3-5>,
      \"primary_text_count\": <3-5>,
      \"meets_minimum\": true,
      \"image_ad_ids\": [\"ad_id_1\", \"ad_id_2\", \"... 10 total\"],
      \"avg_score\": <average overall_score of selected ads>,
      \"reasoning\": \"1 sentence on why this grouping works\"
    },
    {
      \"flex_ad_number\": 2,
      ...same structure...
    }
  ],
  \"rejected_from_grouping\": [\"ad_ids that passed scoring but didn't fit a flex group\"],
  \"skipped_clusters\": [\"any angle clusters that were skipped because they couldn't meet the minimum 3 headlines + 3 primary texts requirement\"]
}"

RESPONSE=$(curl -s "https://api.anthropic.com/v1/messages" \
  -H "Content-Type: application/json" \
  -H "x-api-key: ${ANTHROPIC_API_KEY}" \
  -H "anthropic-version: 2023-06-01" \
  -d "$(jq -n \
    --arg model "$GROUP_MODEL" \
    --arg prompt "$PROMPT" \
    '{
      "model": $model,
      "max_tokens": 4096,
      "temperature": 0,
      "messages": [{"role": "user", "content": $prompt}]
    }')")

echo "$RESPONSE" | jq -r '.content[0].text // "{\"error\": \"No grouping generated\"}"' | \
  sed 's/```json//g; s/```//g' | tr -d '\n' | jq '.'

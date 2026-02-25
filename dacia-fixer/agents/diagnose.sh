#!/bin/bash
# ============================================================
# DACIA FIXER - Diagnosis Agent (Gemini Flash)
# Part of the Dacia Recursive Agents team
# Cost: ~$0.006 per call
# ============================================================
# Now includes the fix ledger — a record of every past fix.
# This makes diagnosis faster and more accurate over time because
# the agent can recognize recurring patterns and known root causes.
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${SCRIPT_DIR}/config/fixer.conf"

TEST_OUTPUT="${1:0:5000}"
CONTEXT="${2:0:20000}"
SUITE="$3"

# Load fix ledger if it exists
LEDGER_CONTEXT=""
if [[ -f "$FIX_LEDGER" ]]; then
  LEDGER_CONTEXT=$(tail -c 8000 "$FIX_LEDGER")
fi

PROMPT="You are a diagnosis agent for the Dacia Automation ad platform.

SUITE: ${SUITE}

=== SYSTEM ARCHITECTURE ===

This is an Express + Convex app with 3 automated agents:

1. CREATIVE DIRECTOR (conductorEngine.js) — Plans and creates batches
   - Runs on cron schedule (3x daily)
   - Selects angles, creates batch jobs, triggers batch processor
   - Config stored in conductor_config table

2. BATCH PROCESSOR (batchProcessor.js) — 4-stage pipeline
   - Stage 0: Brief extraction (Claude Opus)
   - Stage 1: Headlines (Claude Opus)
   - Stage 2: Body copy (Claude Sonnet, batches of 5)
   - Stage 3: Image prompts → Gemini Batch API → scheduler polls
   - Status flow: pending → generating_prompts → submitting → processing → completed
   - Key services: scheduler.js, gemini.js, headlineGenerator.js, bodyCopyGenerator.js

3. CREATIVE FILTER (filter.sh + agents/) — Scores and deploys ads
   - Runs every 30 min via cron (not in Express)
   - Scores each ad via Claude Sonnet (score.sh agent)
   - Groups winners into flex ads (group.sh agent)
   - Deploys flex ads to Ready to Post via backend API
   - Requires: filter_assigned=true on batch, session auth for API calls
   - Common failure: scoring too strict (all ads score 0/10)

Database: Convex (cloud-hosted). JSON arrays stored as strings (must JSON.parse/stringify).
Deployment status strings: \"selected\", \"ready_to_post\", \"posted\", \"analyzing\"

Important behaviors:
- Scheduler polls every 5 min
- Batches in generating_prompts/submitting status have no gemini_batch_job yet
- convexBatchToRow maps boolean scheduled to 1/0 integers
- Batch auto-retry up to 3 times on failure
- Filter reads ads via Convex API, deploys via Express API (needs session cookie)
- Soft-delete pattern on ad_deployments and flex_ads (filter by deleted_at)

=== FIX LEDGER (history of past fixes — USE THIS) ===

This is a record of every past bug and how it was fixed. Check if the current failure matches any known pattern FIRST. If it does, reference the previous fix — it will save time and the known fix is proven to work.

${LEDGER_CONTEXT}

=== END FIX LEDGER ===

TEST OUTPUT (failing):
${TEST_OUTPUT}

SOURCE CODE:
${CONTEXT}

Provide a concise diagnosis:
1. Does this match a known pattern from the fix ledger? If yes, reference it.
2. Which test(s) failed and why
3. Root cause (specific file, function, line)
4. What the fix should do (direction, not code)
5. Is this a RECURRING issue? If the ledger shows the same file/function breaking repeatedly, flag it as systemic and suggest a deeper fix (not just a patch).

Under 500 words. Be specific with file and function names."

RESPONSE=$(curl -s "https://generativelanguage.googleapis.com/v1beta/models/${DIAGNOSIS_MODEL}:generateContent?key=${GEMINI_API_KEY}" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg prompt "$PROMPT" '{
    "contents": [{"parts": [{"text": $prompt}]}],
    "generationConfig": {"maxOutputTokens": 1024, "temperature": 0.2}
  }')")

echo "$RESPONSE" | jq -r '.candidates[0].content.parts[0].text // "ERROR: No diagnosis generated"'

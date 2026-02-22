#!/bin/bash
# ============================================================
# DACIA FIXER - Diagnosis Agent (Gemini Flash)
# Part of the Dacia Recursive Agents team
# Cost: ~$0.006 per call
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${SCRIPT_DIR}/config/fixer.conf"

TEST_OUTPUT="${1:0:5000}"
CONTEXT="${2:0:20000}"
SUITE="$3"

PROMPT="You are a diagnosis agent for the Dacia Automation ad platform.

SUITE: ${SUITE}

This is a 4-stage batch pipeline: Brief → Headlines → Body Copy → Images.
Key services: batchProcessor.js, scheduler.js, gemini.js, headlineGenerator.js, bodyCopyGenerator.js
Database: Convex (cloud-hosted). Routes: batches.js. Scheduling: node-cron + Gemini Batch API.

Important behaviors:
- Scheduler polls every 5 min
- Batches in generating_prompts/submitting status have no gemini_batch_job yet
- convexBatchToRow maps boolean scheduled to 1/0 integers
- Batch auto-retry up to 3 times on failure

TEST OUTPUT (failing):
${TEST_OUTPUT}

SOURCE CODE:
${CONTEXT}

Provide a concise diagnosis:
1. Which test(s) failed and why
2. Root cause (specific file, function, line)
3. What the fix should do (direction, not code)

Under 500 words. Be specific with file and function names."

RESPONSE=$(curl -s "https://generativelanguage.googleapis.com/v1beta/models/${DIAGNOSIS_MODEL}:generateContent?key=${GEMINI_API_KEY}" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg prompt "$PROMPT" '{
    "contents": [{"parts": [{"text": $prompt}]}],
    "generationConfig": {"maxOutputTokens": 1024, "temperature": 0.2}
  }')")

echo "$RESPONSE" | jq -r '.candidates[0].content.parts[0].text // "ERROR: No diagnosis generated"'

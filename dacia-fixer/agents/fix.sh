#!/bin/bash
# ============================================================
# DACIA FIXER - Fix Agent (Claude Sonnet)
# Part of the Dacia Recursive Agents team
# Cost: ~$0.05 per call
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${SCRIPT_DIR}/config/fixer.conf"

DIAGNOSIS="$1"
CONTEXT="${2:0:20000}"
TEST_OUTPUT="${3:0:3000}"
SUITE="$4"

PROMPT="You are a senior developer fixing a bug in the Dacia Automation ad platform.
This is an Express + Convex app with a 4-stage batch pipeline (Brief → Headlines → Body Copy → Images).

DIAGNOSIS:
${DIAGNOSIS}

FAILING TESTS:
${TEST_OUTPUT}

CURRENT CODE:
${CONTEXT}

RULES:
- Fix the root cause from the diagnosis
- Only modify files that need changing
- Do NOT refactor or add unrelated changes
- Do NOT break the batch pipeline status flow: pending → generating_prompts → submitting → processing → completed
- Be careful with convexBatchToRow mapper (scheduled: boolean → 0/1)
- Preserve retry logic and error handling

Output EACH modified file as:
--- WRITE: path/to/file.js ---
(complete file contents)
--- END ---

Include COMPLETE file contents. No explanation outside WRITE blocks."

RESPONSE=$(curl -s "https://api.anthropic.com/v1/messages" \
  -H "Content-Type: application/json" \
  -H "x-api-key: ${ANTHROPIC_API_KEY}" \
  -H "anthropic-version: 2023-06-01" \
  -d "$(jq -n \
    --arg model "$FIX_MODEL" \
    --arg prompt "$PROMPT" \
    '{
      "model": $model,
      "max_tokens": 4096,
      "temperature": 0,
      "messages": [{"role": "user", "content": $prompt}]
    }')")

echo "$RESPONSE" | jq -r '.content[0].text // "ERROR: No fix generated"'

#!/bin/bash
# ============================================================
# DACIA FIXER
# ============================================================
# Part of the Dacia Recursive Agents team
# Role: Automated test, self-healing & batch resurrection
#
# Three-layer protection:
#   1. Test suite catches broken code
#   2. AI agents diagnose and fix the code
#   3. Batch resurrection re-triggers failed batches
#
# Usage:
#   ./fixer.sh                     # Run once (all suites)
#   ./fixer.sh batch_creation      # Run once (specific suite)
#   ./fixer.sh --daemon            # Run continuously
#   ./fixer.sh --status            # Show today's stats
#   ./fixer.sh --resurrect         # Only resurrect failed batches
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config/fixer.conf"

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# --- Logging ---
mkdir -p "$LOG_DIR"
TODAY=$(date +%Y-%m-%d)
LOG_FILE="${LOG_DIR}/fixer_${TODAY}.log"
SPEND_FILE="${LOG_DIR}/spend_${TODAY}.txt"

log() {
  local level="$1"; shift
  local msg="[$(date '+%H:%M:%S')] [FIXER] [$level] $*"
  echo -e "$msg" | tee -a "$LOG_FILE"
}
log_info()  { log "INFO"  "$@"; }
log_warn()  { log "WARN"  "${YELLOW}$*${NC}"; }
log_ok()    { log "OK"    "${GREEN}$*${NC}"; }
log_err()   { log "ERROR" "${RED}$*${NC}"; }
log_res()   { log "RESURRECT" "${CYAN}$*${NC}"; }

# --- Lock File (prevent concurrent execution) ---
LOCK_FILE="/tmp/dacia-fixer.lock"

acquire_lock() {
  if [[ -f "$LOCK_FILE" ]]; then
    local lock_pid; lock_pid=$(cat "$LOCK_FILE" 2>/dev/null)
    if [[ -n "$lock_pid" ]] && kill -0 "$lock_pid" 2>/dev/null; then
      log_warn "Another fixer instance is running (PID $lock_pid). Exiting."
      exit 0
    else
      log_info "Stale lock file found (PID $lock_pid not running). Removing."
      rm -f "$LOCK_FILE"
    fi
  fi
  echo $$ > "$LOCK_FILE"
  # Clean up lock file + spend lock on exit (prevents /tmp accumulation)
  trap 'rm -f "$LOCK_FILE" "${SPEND_FILE}.lock" 2>/dev/null' EXIT INT TERM
}

# --- Cost Tracking ---
init_spend_tracker() {
  if [[ ! -f "$SPEND_FILE" ]]; then
    echo "0" > "$SPEND_FILE"
  fi
}

get_daily_spend() {
  # Use flock for consistent reads (prevents reading mid-write)
  (
    flock -s -w 2 200 2>/dev/null || true
    cat "$SPEND_FILE" 2>/dev/null || echo "0"
  ) 200>"${SPEND_FILE}.lock"
}

add_spend() {
  local cost_cents="$1"
  local operation="${2:-unknown}"
  local model="${3:-}"
  local service="${4:-anthropic}"
  # Use flock to prevent race conditions on concurrent spend file writes
  (
    flock -w 5 200 2>/dev/null || true
    local current; current=$(cat "$SPEND_FILE" 2>/dev/null || echo "0")
    echo "$current + $cost_cents" | bc > "$SPEND_FILE"
  ) 200>"${SPEND_FILE}.lock"
  # Log to Convex api_costs via backend (fire-and-forget)
  curl -s -X POST "http://localhost:3001/api/agent-cost/log" \
    -H "Content-Type: application/json" \
    -d "{\"agent\":\"fixer\",\"operation\":\"${operation}\",\"cost_cents\":${cost_cents},\"service\":\"${service}\"}" \
    > /dev/null 2>&1 &
}

check_budget() {
  local current; current=$(get_daily_spend)
  if (( $(echo "$current >= $DAILY_BUDGET_CENTS" | bc -l) )); then
    log_warn "Daily budget reached (${current}¢ / ${DAILY_BUDGET_CENTS}¢). Skipping API calls."
    return 1
  fi
  return 0
}

# --- Notifications ---
send_notification() {
  local title="$1" message="$2"
  case "$NOTIFY_METHOD" in
    slack)
      [[ -n "$SLACK_WEBHOOK_URL" ]] && curl -s -X POST "$SLACK_WEBHOOK_URL" \
        -H 'Content-type: application/json' \
        -d "{\"text\": \"*${title}*\n${message}\"}" > /dev/null 2>&1
      ;;
    webhook)
      [[ -n "$WEBHOOK_URL" ]] && curl -s -X POST "$WEBHOOK_URL" \
        -H 'Content-type: application/json' \
        -d "{\"title\": \"${title}\", \"message\": \"${message}\"}" > /dev/null 2>&1
      ;;
    none) ;;
  esac
}

# ============================================================
# FIX LEDGER — Self-Improvement System
# ============================================================
# Every successful fix is logged here. Over time the ledger
# gives the diagnosis and fix agents memory of past issues,
# making them faster and more accurate. Recurring patterns
# are detected and flagged for deeper fixes.
# ============================================================

init_ledger() {
  if [[ ! -f "$FIX_LEDGER" ]]; then
    cat > "$FIX_LEDGER" << 'EOF'
# Dacia Fixer — Fix Ledger
# This file is automatically maintained. Each entry records a bug and its fix.
# The diagnosis and fix agents read this to recognize patterns and apply proven solutions.
# DO NOT DELETE — this is the Fixer's institutional memory.

EOF
    log_info "Initialized fix ledger: $FIX_LEDGER"
  fi
}

# Log a successful fix to the ledger
log_to_ledger() {
  local suite="$1"
  local diagnosis="$2"
  local files_changed="$3"
  local attempt="$4"
  local is_recurring="$5"

  local timestamp
  timestamp=$(date '+%Y-%m-%d %H:%M')

  # Extract key details from diagnosis (first 500 chars)
  local diag_summary
  diag_summary=$(echo "$diagnosis" | head -c 500 | tr '\n' ' ')

  local recurring_tag=""
  [[ "$is_recurring" == "true" ]] && recurring_tag=" [RECURRING — deeper fix applied]"

  cat >> "$FIX_LEDGER" << EOF

## ${timestamp} — ${suite}${recurring_tag}
**Attempt:** ${attempt}/${MAX_RETRIES}
**Files changed:** ${files_changed}
**Diagnosis:** ${diag_summary}
---
EOF

  # Trim ledger to MAX_LEDGER_ENTRIES
  local entry_count
  entry_count=$(grep -c "^## " "$FIX_LEDGER" 2>/dev/null || echo 0)
  if [[ "$entry_count" -gt "$MAX_LEDGER_ENTRIES" ]]; then
    local trim_count=$((entry_count - MAX_LEDGER_ENTRIES))
    # Remove oldest entries (everything between first ## and the Nth ##)
    local keep_from
    keep_from=$(grep -n "^## " "$FIX_LEDGER" | tail -n "$MAX_LEDGER_ENTRIES" | head -1 | cut -d: -f1)
    if [[ -n "$keep_from" ]]; then
      local header
      header=$(head -5 "$FIX_LEDGER")
      local body
      body=$(tail -n +"$keep_from" "$FIX_LEDGER")
      echo "$header" > "$FIX_LEDGER"
      echo "$body" >> "$FIX_LEDGER"
      log_info "Trimmed ledger to $MAX_LEDGER_ENTRIES entries (removed $trim_count oldest)"
    fi
  fi

  log_info "Fix logged to ledger"
}

# Check if a file has broken repeatedly (recurring pattern)
check_recurring_pattern() {
  local files_changed="$1"

  if [[ ! -f "$FIX_LEDGER" ]]; then
    echo "false"
    return
  fi

  # Check each changed file against the ledger
  for file in $files_changed; do
    local hit_count
    hit_count=$(grep -c "$file" "$FIX_LEDGER" 2>/dev/null || echo 0)
    if [[ "$hit_count" -ge "$PATTERN_ALERT_THRESHOLD" ]]; then
      log_warn "⚠ RECURRING PATTERN: $file has broken $hit_count times (threshold: $PATTERN_ALERT_THRESHOLD)"
      send_notification "🔁 Dacia Fixer: Recurring Bug Detected" \
        "File: $file\nBreakages: $hit_count times\nThe fixer is applying a deeper fix this round."
      echo "true"
      return
    fi
  done
  echo "false"
}

# ============================================================
# GIT BRANCH MANAGEMENT
# ============================================================
# All fixer commits go to a dedicated branch (fixer/auto-fixes).
# Main branch stays clean. Working directory keeps the fix so
# the running server is always healthy.
#
# To review:  git log fixer/auto-fixes
# To merge:   git checkout main && git merge fixer/auto-fixes
# To diff:    git diff main..fixer/auto-fixes
# ============================================================

commit_to_fixer_branch() {
  local suite="$1"
  local files_changed="$2"
  local commit_msg="fix(dacia-fixer): auto-fix ${suite} - $(date '+%Y-%m-%d %H:%M')"

  cd "$PROJECT_DIR"

  # Get current branch
  local current_branch
  current_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")

  log_info "Committing fix to branch: $FIXER_BRANCH"

  # Stash the fix
  git stash push -m "dacia-fixer-temp" -- . > /dev/null 2>&1 || {
    log_warn "Nothing to stash — files may not have changed"
    return 0
  }

  # Create or switch to fixer branch
  if git rev-parse --verify "$FIXER_BRANCH" > /dev/null 2>&1; then
    # Branch exists — switch to it and rebase on current branch
    git checkout "$FIXER_BRANCH" > /dev/null 2>&1
    git rebase "$current_branch" > /dev/null 2>&1 || {
      log_warn "Rebase conflict — aborting rebase (fixer branch history preserved)"
      git rebase --abort > /dev/null 2>&1
      # Merge instead of reset --hard to preserve fixer branch commit history
      git merge "$current_branch" --no-edit > /dev/null 2>&1 || {
        log_warn "Merge also conflicted — resetting fixer branch to $current_branch"
        git merge --abort > /dev/null 2>&1
        git reset --hard "$current_branch" > /dev/null 2>&1
      }
    }
  else
    # Create new fixer branch from current
    git checkout -b "$FIXER_BRANCH" > /dev/null 2>&1
  fi

  # Apply the stashed fix
  git stash pop > /dev/null 2>&1 || {
    log_err "Failed to pop stash on fixer branch"
    git checkout "$current_branch" > /dev/null 2>&1
    return 1
  }

  # Commit on fixer branch — only stage the specific files that were changed
  if [[ -n "$files_changed" ]]; then
    for f in $files_changed; do
      git add "$f" > /dev/null 2>&1 || true
    done
  else
    # Fallback: stage tracked changes only (no untracked files)
    git add -u > /dev/null 2>&1
  fi
  git commit -m "$commit_msg" > /dev/null 2>&1 || {
    log_warn "Nothing to commit"
  }

  local commit_hash
  commit_hash=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")

  # Push fixer branch if enabled
  if [[ "$AUTO_PUSH" == "true" ]]; then
    git push origin "$FIXER_BRANCH" > /dev/null 2>&1 && \
      log_info "Pushed to origin/$FIXER_BRANCH" || \
      log_warn "Failed to push to origin/$FIXER_BRANCH"
  fi

  # Switch back to original branch
  git checkout "$current_branch" > /dev/null 2>&1

  # Restore the fix to the working directory (so the server keeps running)
  git checkout "$FIXER_BRANCH" -- . > /dev/null 2>&1
  git reset HEAD > /dev/null 2>&1

  log_ok "Committed to $FIXER_BRANCH ($commit_hash): $commit_msg"
  log_info "Working directory has the fix. Main branch is clean."
  log_info "To merge: git merge $FIXER_BRANCH"
}

# --- Test Runner ---
run_tests() {
  local suite="$1"
  local test_cmd_var="${suite}_test_cmd"
  local test_cmd="${!test_cmd_var}"
  
  if [[ -z "$test_cmd" ]]; then
    log_err "No test command for suite: $suite"
    return 2
  fi
  
  log_info "Running tests: $suite"
  cd "$PROJECT_DIR"
  local exit_code=0
  local output; output=$(eval "$test_cmd" 2>&1) || exit_code=$?
  echo "$output"
  return "$exit_code"
}

# --- Context Builder ---
build_context() {
  local suite="$1"
  local context_var="${suite}_context[@]"
  local context_files=()
  if [[ -n "${!context_var+x}" ]]; then
    context_files=("${!context_var}")
  fi
  local context=""
  
  for file in "${context_files[@]}"; do
    local filepath="${PROJECT_DIR}/${file}"
    if [[ -f "$filepath" ]]; then
      context+="
--- FILE: ${file} ---
$(head -c 15000 "$filepath")
"
    fi
  done
  echo "$context"
}

# ============================================================
# BATCH RESURRECTION
# ============================================================

resurrect_failed_batches() {
  if [[ "$RESURRECT_BATCHES" != "true" ]]; then
    return 0
  fi
  
  log_res "Checking for failed batches to resurrect..."
  
  local cutoff_ms
  cutoff_ms=$(date -d "-${MAX_RESURRECT_AGE_HOURS} hours" +%s%3N 2>/dev/null || \
              date -v-${MAX_RESURRECT_AGE_HOURS}H +%s000 2>/dev/null || echo "0")
  
  # Query Convex for failed batch jobs
  local failed_batches
  failed_batches=$(curl -s "${CONVEX_URL}/api/query" \
    -H "Content-Type: application/json" \
    -d "{
      \"path\": \"batchJobs:getByStatus\",
      \"args\": {\"status\": \"failed\"}
    }" 2>/dev/null) || {
    log_warn "Could not query Convex for failed batches"
    return 0
  }
  
  if [[ -z "$failed_batches" ]] || ! echo "$failed_batches" | jq -e '.value' > /dev/null 2>&1; then
    failed_batches=$(curl -s "${CONVEX_URL}/api/query" \
      -H "Content-Type: application/json" \
      -d "{
        \"path\": \"batchJobs:list\",
        \"args\": {}
      }" 2>/dev/null) || {
      log_warn "Could not query Convex for batch jobs"
      return 0
    }
  fi
  
  local count=0
  local MAX_RESURRECT_RETRIES=3
  local batch_entries
  batch_entries=$(echo "$failed_batches" | jq -c '.value[]? | select(.status == "failed") | {id: (.externalId // ._id), retry_count: (.retry_count // 0)}' 2>/dev/null)

  if [[ -z "$batch_entries" ]]; then
    log_res "No failed batches found ✓"
    return 0
  fi

  while IFS= read -r entry; do
    [[ -z "$entry" ]] && continue

    local batch_id; batch_id=$(echo "$entry" | jq -r '.id')
    local retry_count; retry_count=$(echo "$entry" | jq -r '.retry_count // 0')
    [[ -z "$batch_id" || "$batch_id" == "null" ]] && continue

    # Skip batches that have already been retried too many times
    if [[ "$retry_count" -ge "$MAX_RESURRECT_RETRIES" ]]; then
      log_res "Skipping batch $batch_id — already retried $retry_count times (max $MAX_RESURRECT_RETRIES)"
      continue
    fi

    log_res "Resurrecting batch: $batch_id (retry $((retry_count + 1))/$MAX_RESURRECT_RETRIES)"

    local reset_response
    reset_response=$(curl -s -X POST "http://localhost:3001/api/batches/${batch_id}/retry" \
      -H "Content-Type: application/json" \
      -H "Cookie: $(get_session_cookie)" \
      2>/dev/null) || {

      reset_response=$(curl -s "${CONVEX_URL}/api/mutation" \
        -H "Content-Type: application/json" \
        -d "{
          \"path\": \"batchJobs:updateStatus\",
          \"args\": {
            \"externalId\": \"${batch_id}\",
            \"status\": \"pending\",
            \"error\": null,
            \"retry_count\": $((retry_count + 1))
          }
        }" 2>/dev/null) || {
        log_warn "Failed to resurrect batch $batch_id"
        continue
      }
    }

    count=$((count + 1))
    log_res "Batch $batch_id reset to pending (retry $((retry_count + 1)))"

  done <<< "$batch_entries"
  
  if [[ "$count" -gt 0 ]]; then
    log_ok "Resurrected $count failed batch(es)"
    send_notification "🔄 Dacia Fixer: Batches Resurrected" \
      "Resurrected $count failed batch(es) after code fix.\nThey will execute on the next scheduler poll (5 min)."
  fi
}

get_session_cookie() {
  if [[ -f "${FIXER_DIR}/config/.session_cookie" ]]; then
    cat "${FIXER_DIR}/config/.session_cookie"
    return
  fi
  
  local login_response
  login_response=$(curl -s -c - -X POST "http://localhost:3001/api/auth/login" \
    -H "Content-Type: application/json" \
    -d "{
      \"username\": \"${FIXER_USERNAME:-fixer}\",
      \"password\": \"${FIXER_PASSWORD:-}\"
    }" 2>/dev/null)
  
  echo "$login_response" | grep -oP 'connect\.sid\s+\K\S+' || echo ""
}

# ============================================================
# HEALTH CHECK
# ============================================================

check_stuck_batches() {
  log_info "Checking for stuck batches..."
  
  local all_batches
  all_batches=$(curl -s "${CONVEX_URL}/api/query" \
    -H "Content-Type: application/json" \
    -d "{
      \"path\": \"batchJobs:list\",
      \"args\": {}
    }" 2>/dev/null) || {
    log_warn "Could not query batch status"
    return 0
  }
  
  local stuck_count=0
  local processing_batches
  processing_batches=$(echo "$all_batches" | jq -r \
    ".value[]? | select(.status == \"processing\" or .status == \"generating_prompts\" or .status == \"submitting\") | .externalId // ._id" \
    2>/dev/null)
  
  if [[ -n "$processing_batches" ]]; then
    while IFS= read -r batch_id; do
      [[ -z "$batch_id" ]] && continue
      stuck_count=$((stuck_count + 1))
    done <<< "$processing_batches"
  fi
  
  if [[ "$stuck_count" -gt 0 ]]; then
    log_warn "Found $stuck_count potentially stuck batch(es)"
    send_notification "⚠️ Dacia Fixer: Stuck Batches" \
      "Found $stuck_count batch(es) in processing state."
  else
    log_info "No stuck batches ✓"
  fi
}

# ============================================================
# AGENT TEAM HEALTH MONITORING
# ============================================================
# Monitors the Creative Director and Creative Filter agents.
# Runs on each cycle to ensure the agent team is operational.

check_agent_health() {
  log_info "Checking agent team health..."

  local health_status="ok"
  local details=""

  # --- Check 1: Creative Director last run ---
  # Director should run at 7 AM, 7 PM, 1 AM ICT (0:00, 12:00, 18:00 UTC)
  local configs
  configs=$(curl -s "http://localhost:3001/api/conductor/configs" \
    -H "Cookie: $(get_session_cookie)" 2>/dev/null) || configs=""

  if [[ -n "$configs" ]] && echo "$configs" | jq -e '.configs' > /dev/null 2>&1; then
    local enabled_count
    enabled_count=$(echo "$configs" | jq '.configs | [.[] | select(.enabled == true)] | length' 2>/dev/null || echo 0)

    if [[ "$enabled_count" -gt 0 ]]; then
      # Check each enabled project's last run
      local now_ms
      now_ms=$(date +%s)000

      echo "$configs" | jq -c '.configs[] | select(.enabled == true)' 2>/dev/null | while IFS= read -r cfg; do
        local pid
        pid=$(echo "$cfg" | jq -r '.project_id // ""')
        local last_run
        last_run=$(echo "$cfg" | jq -r '.last_planning_run // 0')

        if [[ -n "$pid" && "$last_run" != "null" && "$last_run" != "0" ]]; then
          # Check if last run was more than 14 hours ago (should run every 12h minimum)
          local age_ms=$(( $(date +%s)000 - last_run ))
          local age_hours=$(( age_ms / 3600000 ))
          if [[ "$age_hours" -gt 14 ]]; then
            log_warn "Director: project ${pid:0:8} last ran ${age_hours}h ago (expected within 12h)"
            health_status="degraded"
            details="${details}Director late for ${pid:0:8}. "
          fi
        fi
      done

      details="${details}Director: ${enabled_count} project(s) enabled. "
    else
      details="${details}Director: no projects enabled. "
    fi
  else
    log_info "Director: no conductor configs found (not yet configured)"
  fi

  # --- Check 2: Creative Filter process liveness ---
  # Check if the filter log has recent activity (within 45 min during active window)
  local filter_log="/opt/ad-platform/dacia-creative-filter/logs/filter_$(date +%Y-%m-%d).log"
  if [[ -f "$filter_log" ]]; then
    local last_line_time
    last_line_time=$(tail -1 "$filter_log" 2>/dev/null | grep -oP '\d{2}:\d{2}:\d{2}' | head -1)
    if [[ -n "$last_line_time" ]]; then
      details="${details}Filter: last log at ${last_line_time}. "
    fi
  else
    details="${details}Filter: no log today (may not have run yet). "
  fi

  # --- Check 3: Batch pipeline health (stuck batches with timeout) ---
  local stuck_batches
  stuck_batches=$(curl -s "${CONVEX_URL}/api/query" \
    -H "Content-Type: application/json" \
    -d "{
      \"path\": \"batchJobs:list\",
      \"args\": {}
    }" 2>/dev/null) || stuck_batches=""

  if [[ -n "$stuck_batches" ]] && echo "$stuck_batches" | jq -e '.value' > /dev/null 2>&1; then
    local stuck_count=0
    local now_epoch=$(date +%s)

    # Find batches stuck in processing states for more than 60 minutes
    stuck_count=$(echo "$stuck_batches" | jq "[.value[]? | select(
      (.status == \"processing\" or .status == \"generating_prompts\" or .status == \"submitting\") and
      (.started_at != null)
    )] | length" 2>/dev/null || echo 0)

    if [[ "$stuck_count" -gt 0 ]]; then
      details="${details}Pipeline: ${stuck_count} batch(es) in processing. "
    else
      details="${details}Pipeline: healthy. "
    fi
  fi

  # --- Log health check result ---
  local check_id
  check_id=$(uuidv4 2>/dev/null || cat /proc/sys/kernel/random/uuid 2>/dev/null || echo "hc-$(date +%s)")

  # Log to conductor_health via API (fire-and-forget)
  curl -s -X POST "http://localhost:3001/api/conductor/health" \
    -H "Content-Type: application/json" \
    -H "Cookie: $(get_session_cookie)" \
    -d "$(jq -n \
      --arg eid "$check_id" \
      --arg status "$health_status" \
      --arg details "$details" \
      '{
        externalId: $eid,
        agent: "fixer",
        check_at: (now * 1000 | floor),
        status: $status,
        details: $details
      }')" > /dev/null 2>&1 || true

  if [[ "$health_status" == "ok" ]]; then
    log_ok "Agent team health: OK"
  else
    log_warn "Agent team health: $health_status — $details"
  fi
}

# UUID generator fallback for systems without uuidgen
uuidv4() {
  python3 -c 'import uuid; print(uuid.uuid4())' 2>/dev/null || \
  cat /proc/sys/kernel/random/uuid 2>/dev/null || \
  echo "$(date +%s)-$$-$(shuf -i 1000-9999 -n1)"
}

# ============================================================
# HEALTH PROBES — $0 cost, run every cycle
# ============================================================
# These detect data quality issues, pipeline stalls, and agent
# failures that unit tests can't catch. All probes use Convex
# queries and log file reads — no LLM calls.
# ============================================================

# Helper: Check if the Creative Filter's daily budget is exhausted
# Returns 0 (true) if budget is exhausted, 1 (false) if budget remains
is_filter_budget_exhausted() {
  local filter_spend_file="${FILTER_LOG_DIR}/spend_${TODAY}.txt"
  if [[ ! -f "$filter_spend_file" ]]; then
    return 1  # No spend file = no budget used
  fi
  local current_spend
  current_spend=$(cat "$filter_spend_file" 2>/dev/null | tr -d '[:space:]')
  current_spend=${current_spend:-0}

  # Read filter's budget from its config
  local filter_budget=400
  if [[ -f "${FILTER_DIR_PATH}/config/filter.conf" ]]; then
    local conf_budget
    conf_budget=$(grep -oP 'DAILY_BUDGET_CENTS=\K[0-9]+' "${FILTER_DIR_PATH}/config/filter.conf" 2>/dev/null || echo "")
    [[ -n "$conf_budget" ]] && filter_budget="$conf_budget"
  fi

  if (( $(echo "$current_spend >= $filter_budget" | bc -l 2>/dev/null || echo 0) )); then
    return 0  # Budget exhausted
  fi
  return 1  # Budget remains
}

# --- Probe A: Filter Scoring Quality ---
# Catches the exact scenario where all ads score 0/10 due to
# overly strict scoring criteria or broken scoring prompts.
# FIX: Resets batches for re-scoring + triggers AI diagnosis of score.sh
probe_filter_scoring() {
  [[ "$PROBE_FILTER_SCORING" != "true" ]] && return 0

  local filter_log="${FILTER_LOG_DIR}/filter_${TODAY}.log"
  if [[ ! -f "$filter_log" ]]; then
    log_info "Probe [filter_scoring]: No filter log today ✓"
    return 0
  fi

  # Count pass/fail from today's log (strip ANSI codes first)
  local clean_log
  clean_log=$(sed 's/\x1b\[[0-9;]*m//g' "$filter_log" 2>/dev/null)
  local pass_count fail_count
  pass_count=$(echo "$clean_log" | grep -c "PASS" 2>/dev/null || echo 0)
  fail_count=$(echo "$clean_log" | grep -c "FAIL" 2>/dev/null || echo 0)
  pass_count=$(echo "$pass_count" | tr -d '[:space:]')
  fail_count=$(echo "$fail_count" | tr -d '[:space:]')
  pass_count=${pass_count:-0}
  fail_count=${fail_count:-0}
  local total=$((pass_count + fail_count))

  if [[ "$total" -eq 0 ]]; then
    log_info "Probe [filter_scoring]: No ads scored today ✓"
    return 0
  fi

  local pass_rate=0
  if [[ "$total" -gt 0 ]]; then
    pass_rate=$(( (pass_count * 100) / total ))
  fi

  # === 0% PASS RATE — CHECK IF BUDGET-RELATED ===
  if [[ "$pass_count" -eq 0 && "$fail_count" -gt 0 ]]; then
    # Check if the filter log shows budget exhaustion (not a scoring bug)
    local budget_hits=0
    budget_hits=$(echo "$clean_log" | grep -c "Daily budget reached" 2>/dev/null || echo 0)
    budget_hits=$(echo "$budget_hits" | tr -d '[:space:]')

    if [[ "$budget_hits" -gt 0 ]] || is_filter_budget_exhausted; then
      log_warn "Probe [filter_scoring]: 0% pass rate caused by BUDGET EXHAUSTION, not scoring bug"
      log_info "  Filter budget is spent — batches will be re-scored tomorrow when budget resets"
      log_info "  NOT resetting batches (would cause infinite reset-score-budget loop)"
      return 0
    fi

    log_err "Probe [filter_scoring]: ALL $fail_count ads scored 0/10 — FIXING"

    # FIX 1: Reset all filter-processed batches so they get re-scored
    local recent_batches
    recent_batches=$(curl -s "${CONVEX_URL}/api/query" \
      -H "Content-Type: application/json" \
      -d "{\"path\": \"batchJobs:list\", \"args\": {}}" 2>/dev/null) || recent_batches=""

    if [[ -n "$recent_batches" ]]; then
      local processed_ids
      processed_ids=$(echo "$recent_batches" | jq -r \
        '.value[]? | select(.filter_processed == true and .filter_assigned == true) | .externalId // ._id' \
        2>/dev/null)
      if [[ -n "$processed_ids" ]]; then
        while IFS= read -r batch_id; do
          [[ -z "$batch_id" ]] && continue
          log_info "  Resetting batch $batch_id for re-scoring"
          curl -s "${CONVEX_URL}/api/mutation" \
            -H "Content-Type: application/json" \
            -d "{\"path\": \"batchJobs:patch\", \"args\": {\"externalId\": \"${batch_id}\", \"filter_processed\": false}}" \
            > /dev/null 2>&1 || true
        done <<< "$processed_ids"
        log_ok "  Reset batches for re-scoring"
      fi
    fi

    # FIX 2: Use AI to diagnose and fix the scoring prompt
    if check_budget; then
      # Ensure API keys are loaded (from env or Convex settings)
      if [[ -z "$GEMINI_API_KEY" || -z "$ANTHROPIC_API_KEY" ]]; then
        [[ -z "$GEMINI_API_KEY" ]] && \
          GEMINI_API_KEY=$(curl -s --max-time 5 "${CONVEX_URL}/api/query" \
            -H "Content-Type: application/json" \
            -d '{"path":"settings:get","args":{"key":"gemini_api_key"}}' 2>/dev/null | jq -r '.value // ""')
        [[ -z "$ANTHROPIC_API_KEY" ]] && \
          ANTHROPIC_API_KEY=$(curl -s --max-time 5 "${CONVEX_URL}/api/query" \
            -H "Content-Type: application/json" \
            -d '{"path":"settings:get","args":{"key":"anthropic_api_key"}}' 2>/dev/null | jq -r '.value // ""')
      fi

      if [[ -z "$GEMINI_API_KEY" || -z "$ANTHROPIC_API_KEY" ]]; then
        log_warn "  Cannot diagnose — API keys not available"
        send_notification "🚨 Dacia Fixer: Scoring Broken — No API Keys For Diagnosis" \
          "ALL $fail_count ads scored 0/10. Batches have been reset.\nFixer has no API keys to diagnose the issue. Please review score.sh manually."
        return 1
      fi

      log_info "  Diagnosing scoring issue with AI..."

      # Get a sample of the scoring errors from the filter log
      local scoring_errors
      scoring_errors=$(echo "$clean_log" | grep -A2 "FAIL" | head -30)

      # Read the scoring agent for context
      local score_sh_content=""
      if [[ -f "${FILTER_DIR_PATH}/agents/score.sh" ]]; then
        score_sh_content=$(cat "${FILTER_DIR_PATH}/agents/score.sh" 2>/dev/null | head -c 10000)
      fi

      # Diagnose with Gemini Flash
      local diag_prompt="You are diagnosing why all ads (${fail_count}/${total}) scored 0/10 in the Creative Filter.

FILTER LOG (scoring results):
${scoring_errors}

SCORING AGENT (score.sh):
${score_sh_content}

What is causing every ad to fail? Look at the hard requirements — one of them is likely too strict for the type of ad copy being generated. Identify the specific hard requirement that is auto-failing all ads and explain what change to score.sh would fix it. Be specific — name the exact section and what text to change."

      local diagnosis
      diagnosis=$(curl -s "https://generativelanguage.googleapis.com/v1beta/models/${DIAGNOSIS_MODEL}:generateContent?key=${GEMINI_API_KEY}" \
        -H 'Content-Type: application/json' \
        -d "$(jq -n --arg prompt "$diag_prompt" '{
          "contents": [{"parts": [{"text": $prompt}]}],
          "generationConfig": {"maxOutputTokens": 1024, "temperature": 0.2}
        }')" 2>/dev/null)
      add_spend 1 "scoring_diagnosis" "$DIAGNOSIS_MODEL" "$DIAGNOSIS_PROVIDER"

      local diag_text
      diag_text=$(echo "$diagnosis" | jq -r '.candidates[0].content.parts[0].text // "No diagnosis"' 2>/dev/null)
      log_info "  Diagnosis: $(echo "$diag_text" | head -c 200)"

      # Fix with Claude Sonnet
      log_info "  Generating fix for score.sh..."
      local fix_prompt="You are fixing the Creative Filter scoring agent. ALL ${fail_count} ads scored 0/10 — the scoring is broken.

DIAGNOSIS:
${diag_text}

CURRENT score.sh:
${score_sh_content}

The scoring prompt's hard requirements are too strict. Fix the prompt so legitimate direct response ad copy passes. Common issues:
- Spelling/grammar check flagging style choices (missing dollar signs, informal tone) as errors
- Compliance check flagging general wellness claims as violations
- Hook/CTA checks being too strict for the brand's style

Output the COMPLETE fixed file as:
--- WRITE: dacia-creative-filter/agents/score.sh ---
(complete file contents)
--- END ---

Only modify the prompt text. Do NOT change the curl call, jq commands, or script structure."

      local fix_output
      fix_output=$(curl -s "https://api.anthropic.com/v1/messages" \
        -H "Content-Type: application/json" \
        -H "x-api-key: ${ANTHROPIC_API_KEY}" \
        -H "anthropic-version: 2023-06-01" \
        -d "$(jq -n --arg model "$FIX_MODEL" --arg prompt "$fix_prompt" '{
          "model": $model, "max_tokens": 4096, "temperature": 0,
          "messages": [{"role": "user", "content": $prompt}]
        }')" 2>/dev/null)
      add_spend 5 "scoring_fix" "$FIX_MODEL" "anthropic"

      local fix_text
      fix_text=$(echo "$fix_output" | jq -r '.content[0].text // ""' 2>/dev/null)

      if echo "$fix_text" | grep -qF -- "--- WRITE:"; then
        apply_fix "$fix_text"
        log_ok "  Applied fix to score.sh — filter will re-score on next run"
        log_to_ledger "filter_scoring" "$diag_text" "dacia-creative-filter/agents/score.sh" "1" "false"
        if [[ "$AUTO_COMMIT" == "true" ]]; then
          commit_to_fixer_branch "filter_scoring" "dacia-creative-filter/agents/score.sh"
        fi
        send_notification "🔧 Dacia Fixer: Fixed Scoring + Reset Batches" \
          "ALL $fail_count ads were scoring 0/10.\nDiagnosis: $(echo "$diag_text" | head -c 200)\nFix applied to score.sh. Batches reset for re-scoring."
      else
        log_warn "  Could not generate a fix — alerting for manual intervention"
        send_notification "🚨 Dacia Fixer: Scoring Broken — Manual Fix Needed" \
          "ALL $fail_count ads scored 0/10. Batches have been reset.\nDiagnosis: $(echo "$diag_text" | head -c 300)\nThe Fixer could not auto-fix score.sh. Please review manually."
      fi
    else
      send_notification "🚨 Dacia Fixer: Scoring Broken (budget reached)" \
        "ALL $fail_count ads scored 0/10. Batches have been reset for re-scoring.\nFixer is out of budget to diagnose the issue today."
    fi

    return 1
  fi

  # === LOW PASS RATE — WARNING ===
  if [[ "$pass_rate" -lt "$PROBE_FILTER_PASS_RATE_MIN" ]]; then
    log_warn "Probe [filter_scoring]: Pass rate ${pass_rate}% (${pass_count}/${total}) — below ${PROBE_FILTER_PASS_RATE_MIN}%"
    send_notification "⚠️ Dacia Fixer: Low Filter Pass Rate (${pass_rate}%)" \
      "${pass_count} passed, ${fail_count} failed. Scoring may be too strict."
    return 0
  fi

  log_ok "Probe [filter_scoring]: Pass rate ${pass_rate}% (${pass_count}/${total}) ✓"
}

# --- Probe B: Filter Liveness ---
# Detects if the Creative Filter cron has stopped running.
# FIX: Re-adds cron entry if missing. Runs filter manually if stale.
probe_filter_liveness() {
  # Determine most recent filter log
  local filter_log="${FILTER_LOG_DIR}/filter_${TODAY}.log"
  local check_log="$filter_log"
  if [[ ! -f "$check_log" ]]; then
    local yesterday
    yesterday=$(date -d "yesterday" +%Y-%m-%d 2>/dev/null || date -v-1d +%Y-%m-%d 2>/dev/null || echo "")
    check_log="${FILTER_LOG_DIR}/filter_${yesterday}.log"
    [[ ! -f "$check_log" ]] && check_log=""
  fi

  # If filter is paused, that's intentional
  if [[ -f "${FILTER_DIR_PATH}/.paused" ]]; then
    log_info "Probe [filter_liveness]: Filter is PAUSED (intentional) ✓"
    return 0
  fi

  # Check staleness
  local age_hours=0
  if [[ -n "$check_log" && -f "$check_log" ]]; then
    local last_mod
    last_mod=$(stat -c %Y "$check_log" 2>/dev/null || stat -f %m "$check_log" 2>/dev/null || echo 0)
    local now_epoch
    now_epoch=$(date +%s)
    age_hours=$(( (now_epoch - last_mod) / 3600 ))
  else
    age_hours=999  # No log file at all
  fi

  if [[ "$age_hours" -le "$PROBE_FILTER_STALE_HOURS" ]]; then
    log_ok "Probe [filter_liveness]: Active (last entry ${age_hours}h ago) ✓"
    return 0
  fi

  # Filter is stale — diagnose and fix
  log_warn "Probe [filter_liveness]: Filter has not run in ${age_hours}h — FIXING"

  # FIX 1: Check if cron entry exists, re-add if missing
  local cron_exists
  cron_exists=$(crontab -l 2>/dev/null | grep -c "filter.sh" || echo 0)
  if [[ "$cron_exists" -eq 0 ]]; then
    log_err "  Filter cron is MISSING from crontab — re-adding"
    # Read current crontab, add filter entry
    local current_cron
    current_cron=$(crontab -l 2>/dev/null || echo "")
    local filter_cron_entry='*/30 * * * * ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY}" FILTER_USERNAME="filter" FILTER_PASSWORD="${FILTER_PASSWORD:-}" cd /opt/ad-platform && /bin/bash dacia-creative-filter/filter.sh >> /opt/ad-platform/dacia-creative-filter/logs/cron.log 2>&1'
    echo "${current_cron}
${filter_cron_entry}" | crontab - 2>/dev/null && \
      log_ok "  Re-added filter cron entry" || \
      log_err "  Failed to re-add filter cron entry"
    send_notification "🔧 Dacia Fixer: Restored Filter Cron" \
      "Creative Filter cron was missing. Re-added to crontab.\nFilter will run on the next 30-minute mark."
    return 0
  fi

  # FIX 2: Cron exists but filter isn't running — trigger a manual run
  log_info "  Cron exists but filter is stale. Triggering manual filter run..."
  # Use the agent monitor endpoint to trigger the filter
  curl -s -X POST "http://localhost:3001/api/agent-monitor/filter/run-live" \
    -H "Content-Type: application/json" \
    -H "Cookie: $(get_session_cookie)" \
    > /dev/null 2>&1 && \
    log_ok "  Triggered manual filter run via API" || {
    # Fallback: run filter directly
    log_info "  API trigger failed, running filter directly..."
    (cd "$PROJECT_DIR" && bash dacia-creative-filter/filter.sh >> "${FILTER_LOG_DIR}/cron.log" 2>&1 &)
    log_ok "  Triggered filter run directly (background)"
  }

  send_notification "🔧 Dacia Fixer: Restarted Creative Filter" \
    "Filter had not run in ${age_hours}h. Triggered manual run."
  return 0
}

# --- Probe C: Backend Health ---
# Checks that Express server, Convex, and scheduler are all running.
# FIX: Restarts PM2 if backend is down. Restarts if scheduler not initialized.
probe_backend_health() {
  [[ "$PROBE_BACKEND_HEALTH" != "true" ]] && return 0

  local health_response
  health_response=$(curl -s --max-time 5 "http://localhost:3001/api/health" 2>/dev/null) || health_response=""

  # Check if we got a response at all
  local status
  status=$(echo "$health_response" | jq -r '.status // "unreachable"' 2>/dev/null)

  if [[ "$status" == "unreachable" || -z "$health_response" ]]; then
    log_err "Probe [backend_health]: Backend is NOT responding — FIXING"

    # FIX: Restart PM2
    log_info "  Restarting PM2 process..."
    pm2 restart ad-platform 2>/dev/null && {
      log_ok "  PM2 restart issued"
      sleep 5  # Wait for server to come up

      # Verify it came back
      local verify
      verify=$(curl -s --max-time 5 "http://localhost:3001/api/health" 2>/dev/null)
      local verify_status
      verify_status=$(echo "$verify" | jq -r '.status // "unreachable"' 2>/dev/null)
      if [[ "$verify_status" == "ok" ]]; then
        log_ok "  Backend recovered after PM2 restart ✓"
        send_notification "🔧 Dacia Fixer: Restarted Backend" \
          "Backend was down. PM2 restart successful — server is healthy again."
        return 0
      else
        log_err "  Backend still unhealthy after restart (status: $verify_status)"
        send_notification "🚨 Dacia Fixer: Backend Won't Start" \
          "Backend was down. PM2 restart attempted but server status is: $verify_status\nManual intervention needed. Check: pm2 logs ad-platform"
        return 1
      fi
    } || {
      log_err "  PM2 restart failed"
      send_notification "🚨 Dacia Fixer: Backend Down — PM2 Restart Failed" \
        "Backend is not responding and PM2 restart failed.\nManual intervention needed."
      return 1
    }
  fi

  if [[ "$status" == "ok" ]]; then
    # Check Convex
    local convex_status
    convex_status=$(echo "$health_response" | jq -r '.checks.convex // "unknown"' 2>/dev/null)
    if [[ "$convex_status" != "ok" ]]; then
      log_warn "Probe [backend_health]: Convex is $convex_status — restarting backend to reconnect"
      pm2 restart ad-platform 2>/dev/null && \
        log_ok "  PM2 restart issued to reconnect Convex" || true
      send_notification "⚠️ Dacia Fixer: Convex Connection Issue — Restarting" \
        "Convex status: $convex_status. Restarted backend to attempt reconnection."
      return 1
    fi

    # Check scheduler
    local scheduler_init
    scheduler_init=$(echo "$health_response" | jq -r '.checks.scheduler.initialized // false' 2>/dev/null)
    if [[ "$scheduler_init" != "true" ]]; then
      log_warn "Probe [backend_health]: Scheduler not initialized — restarting backend"
      pm2 restart ad-platform 2>/dev/null && \
        log_ok "  PM2 restart issued to reinitialize scheduler" || true
      send_notification "🔧 Dacia Fixer: Restarted Backend (scheduler was down)" \
        "Scheduler was not initialized. Restarted backend to restore cron jobs."
      return 1
    fi

    # Check memory — warn only, PM2 handles the restart
    local heap_mb
    heap_mb=$(echo "$health_response" | jq -r '.checks.memory.heap_used_mb // 0' 2>/dev/null | cut -d. -f1)
    heap_mb=${heap_mb:-0}
    if [[ "$heap_mb" -gt 450 ]] 2>/dev/null; then
      log_warn "Probe [backend_health]: High memory (${heap_mb}MB) — PM2 will auto-restart at 512MB"
    fi

    log_ok "Probe [backend_health]: Backend healthy (Convex: ok, Scheduler: ok) ✓"
    return 0
  else
    log_warn "Probe [backend_health]: Backend degraded ($status) — restarting"
    pm2 restart ad-platform 2>/dev/null || true
    send_notification "⚠️ Dacia Fixer: Restarted Degraded Backend" \
      "Backend status was: $status. Restarted to attempt recovery."
    return 1
  fi
}

# --- Probe D: Deployment Pipeline ---
# Ensures ads are actually making it from completed batches to Ready to Post.
# FIX: Re-triggers filter if ads passed but no flex ads deployed.
#      Resets session cookie if auth is likely expired.
probe_deployment_pipeline() {
  [[ "$PROBE_DEPLOYMENT_PIPELINE" != "true" ]] && return 0

  local all_batches
  all_batches=$(curl -s "${CONVEX_URL}/api/query" \
    -H "Content-Type: application/json" \
    -d "{\"path\": \"batchJobs:list\", \"args\": {}}" 2>/dev/null) || {
    log_warn "Probe [deployment_pipeline]: Could not query batches"
    return 0
  }

  local processed_count
  processed_count=$(echo "$all_batches" | jq \
    '[.value[]? | select(.filter_assigned == true and .filter_processed == true and .status == "completed")] | length' \
    2>/dev/null || echo 0)

  if [[ "$processed_count" -eq 0 ]]; then
    log_info "Probe [deployment_pipeline]: No filter-processed batches yet ✓"
    return 0
  fi

  # Check filter logs for successful deployments (today + yesterday)
  local filter_log="${FILTER_LOG_DIR}/filter_${TODAY}.log"
  local clean_filter=""
  [[ -f "$filter_log" ]] && clean_filter=$(sed 's/\x1b\[[0-9;]*m//g' "$filter_log" 2>/dev/null)

  local deployed_count=0
  [[ -n "$clean_filter" ]] && deployed_count=$(echo "$clean_filter" | grep -c "Deployed:" 2>/dev/null || echo 0)

  local yesterday
  yesterday=$(date -d "yesterday" +%Y-%m-%d 2>/dev/null || date -v-1d +%Y-%m-%d 2>/dev/null || echo "")
  if [[ -n "$yesterday" && -f "${FILTER_LOG_DIR}/filter_${yesterday}.log" ]]; then
    local yd
    yd=$(sed 's/\x1b\[[0-9;]*m//g' "${FILTER_LOG_DIR}/filter_${yesterday}.log" 2>/dev/null | grep -c "Deployed:" 2>/dev/null || echo 0)
    deployed_count=$((deployed_count + yd))
  fi

  # Check pass count
  local pass_count=0
  [[ -n "$clean_filter" ]] && pass_count=$(echo "$clean_filter" | grep -c "PASS" 2>/dev/null || echo 0)
  pass_count=$(echo "$pass_count" | tr -d '[:space:]')
  pass_count=${pass_count:-0}

  # No passes, no deployments — check if budget-related before deferring
  if [[ "$pass_count" -eq 0 ]]; then
    if is_filter_budget_exhausted; then
      log_info "Probe [deployment_pipeline]: 0 ads passed (filter budget exhausted — not a pipeline issue)"
    else
      log_info "Probe [deployment_pipeline]: 0 ads passed scoring (handled by filter_scoring probe)"
    fi
    return 0
  fi

  # Ads PASSED but nothing deployed — deployment step is broken
  if [[ "$deployed_count" -eq 0 && "$pass_count" -gt 0 ]]; then
    log_err "Probe [deployment_pipeline]: ${pass_count} ads passed but 0 deployed — FIXING"

    # FIX 1: Clear stale session cookie (most common cause of deployment auth failure)
    local cookie_file="${FILTER_DIR_PATH}/config/.session_cookie"
    if [[ -f "$cookie_file" ]]; then
      rm -f "$cookie_file" 2>/dev/null
      log_info "  Cleared stale filter session cookie"
    fi

    # FIX 2: Reset the processed batches so filter can retry deployment
    local processed_ids
    processed_ids=$(echo "$all_batches" | jq -r \
      '.value[]? | select(.filter_assigned == true and .filter_processed == true and .status == "completed") | .externalId // ._id' \
      2>/dev/null)
    if [[ -n "$processed_ids" ]]; then
      while IFS= read -r batch_id; do
        [[ -z "$batch_id" ]] && continue
        log_info "  Resetting batch $batch_id for re-processing"
        curl -s "${CONVEX_URL}/api/mutation" \
          -H "Content-Type: application/json" \
          -d "{\"path\": \"batchJobs:patch\", \"args\": {\"externalId\": \"${batch_id}\", \"filter_processed\": false}}" \
          > /dev/null 2>&1 || true
      done <<< "$processed_ids"
    fi

    log_ok "  Reset session + batches — filter will retry on next run"
    send_notification "🔧 Dacia Fixer: Fixed Deployment Pipeline" \
      "${pass_count} ads passed scoring but deployment failed.\nCleared stale session cookie and reset batches.\nFilter will retry deployment on next 30-min cycle."
    return 1
  fi

  log_ok "Probe [deployment_pipeline]: ${deployed_count} flex ad(s) deployed from ${processed_count} batch(es) ✓"
}

# --- Probe E: Stuck Batch Detection + Force Recovery ---
# Finds batches stuck in processing states and force-fails + resurrects them.
probe_batch_completion() {
  local all_batches
  all_batches=$(curl -s "${CONVEX_URL}/api/query" \
    -H "Content-Type: application/json" \
    -d "{\"path\": \"batchJobs:list\", \"args\": {}}" 2>/dev/null) || {
    log_warn "Probe [batch_completion]: Could not query batches"
    return 0
  }

  local now_epoch
  now_epoch=$(date +%s)
  local stuck_threshold_s=$((PROBE_BATCH_STUCK_MINUTES * 60))

  local active_batches
  active_batches=$(echo "$all_batches" | jq -c \
    '[.value[]? | select(.status == "processing" or .status == "generating_prompts" or .status == "submitting")]' \
    2>/dev/null || echo "[]")
  local active_count
  active_count=$(echo "$active_batches" | jq 'length' 2>/dev/null || echo 0)

  if [[ "$active_count" -eq 0 ]]; then
    log_ok "Probe [batch_completion]: No active batches ✓"
    return 0
  fi

  local stuck_count=0
  local fixed_count=0

  for i in $(seq 0 $((active_count - 1))); do
    local batch
    batch=$(echo "$active_batches" | jq ".[$i]")
    local batch_id
    batch_id=$(echo "$batch" | jq -r '.externalId // ._id // "unknown"')
    local batch_status
    batch_status=$(echo "$batch" | jq -r '.status')
    local started_at
    started_at=$(echo "$batch" | jq -r '.started_at // .updated_at // ""')

    local started_epoch=0
    if [[ -n "$started_at" && "$started_at" != "null" ]]; then
      if [[ "$started_at" =~ ^[0-9]+$ ]]; then
        started_epoch=$((started_at / 1000))
      else
        started_epoch=$(date -d "$started_at" +%s 2>/dev/null || echo 0)
      fi
    fi

    if [[ "$started_epoch" -gt 0 ]]; then
      local age_s=$((now_epoch - started_epoch))
      local age_min=$((age_s / 60))

      if [[ "$age_s" -gt "$stuck_threshold_s" ]]; then
        stuck_count=$((stuck_count + 1))
        log_warn "Probe [batch_completion]: Batch ${batch_id:0:8} stuck in '$batch_status' for ${age_min}min — FIXING"

        # FIX: Force-fail the batch so resurrect_failed_batches can pick it up
        curl -s "${CONVEX_URL}/api/mutation" \
          -H "Content-Type: application/json" \
          -d "{
            \"path\": \"batchJobs:updateStatus\",
            \"args\": {
              \"externalId\": \"${batch_id}\",
              \"status\": \"failed\",
              \"error\": \"Force-failed by Dacia Fixer: stuck in ${batch_status} for ${age_min} minutes\"
            }
          }" > /dev/null 2>&1 && {
          fixed_count=$((fixed_count + 1))
          log_ok "  Force-failed batch ${batch_id:0:8} — will be resurrected"
        } || {
          log_warn "  Could not force-fail batch ${batch_id:0:8}"
        }
      fi
    fi
  done

  if [[ "$stuck_count" -gt 0 ]]; then
    send_notification "🔧 Dacia Fixer: Unstuck ${fixed_count}/${stuck_count} Batch(es)" \
      "Found ${stuck_count} stuck batch(es). Force-failed ${fixed_count} — they will be resurrected and retried automatically."
    return 1
  fi

  log_ok "Probe [batch_completion]: $active_count active batch(es), none stuck ✓"
}

# --- Probe F: Cost Sync Health ---
# Detects when the hourly OpenAI cost sync has stopped working.
# FIX: Triggers manual sync via POST /api/costs/sync.
probe_cost_sync() {
  [[ "$PROBE_COST_SYNC" != "true" ]] && return 0

  # Check for recent cost entries via Convex (no auth needed)
  local today_date
  today_date=$(date +%Y-%m-%d)
  local costs
  costs=$(curl -s --max-time 5 "${CONVEX_URL}/api/query" \
    -H "Content-Type: application/json" \
    -d "{\"path\":\"apiCosts:getDailyHistory\",\"args\":{\"startDate\":\"${today_date}\",\"endDate\":\"${today_date}\"}}" \
    2>/dev/null) || {
    log_warn "Probe [cost_sync]: Could not query cost history"
    return 0
  }

  local openai_costs
  openai_costs=$(echo "$costs" | jq '[.value[]? | select(.service == "openai")] | length' 2>/dev/null || echo 0)

  # Check if there are any active batches that would generate costs
  local active_batches
  active_batches=$(curl -s --max-time 5 "${CONVEX_URL}/api/query" \
    -H "Content-Type: application/json" \
    -d '{"path":"batchJobs:getActive","args":{}}' 2>/dev/null)
  local active_count
  active_count=$(echo "$active_batches" | jq '.value | length' 2>/dev/null || echo 0)

  if [[ "$active_count" -gt 0 && "$openai_costs" -eq 0 ]]; then
    log_warn "Probe [cost_sync]: ${active_count} active batches but 0 OpenAI costs today — FIXING"
    curl -s -X POST "http://localhost:3001/api/agent-cost/sync-openai" \
      -H "Content-Type: application/json" > /dev/null 2>&1 && \
      log_ok "  Triggered manual OpenAI cost sync" || \
      log_warn "  Failed to trigger cost sync"
    return 0
  fi

  log_ok "Probe [cost_sync]: Cost tracking healthy ✓"
}

# --- Probe G: Gemini Rate Refresh ---
# Detects when the daily Gemini rate scrape has failed.
# FIX: Triggers manual refresh via POST /api/settings/refresh-gemini-rates.
probe_gemini_rates() {
  [[ "$PROBE_GEMINI_RATES" != "true" ]] && return 0

  # Check Gemini rate settings directly from Convex
  local rate_setting
  rate_setting=$(curl -s --max-time 5 "${CONVEX_URL}/api/query" \
    -H "Content-Type: application/json" \
    -d '{"path":"settings:getSetting","args":{"key":"gemini_rates"}}' 2>/dev/null) || {
    log_warn "Probe [gemini_rates]: Could not query Convex"
    return 0
  }

  local rate_val
  rate_val=$(echo "$rate_setting" | jq -r '.value // ""' 2>/dev/null)

  if [[ -z "$rate_val" || "$rate_val" == "null" ]]; then
    log_info "Probe [gemini_rates]: No rate data yet ✓"
    return 0
  fi

  # Rates are stored as JSON string — parse to check last_updated
  local last_updated
  last_updated=$(echo "$rate_val" | jq -r '.last_updated // ""' 2>/dev/null)

  if [[ -z "$last_updated" || "$last_updated" == "null" ]]; then
    log_info "Probe [gemini_rates]: Rate data exists but no timestamp ✓"
    return 0
  fi

  local last_epoch
  last_epoch=$(date -d "$last_updated" +%s 2>/dev/null || echo 0)
  local now_epoch
  now_epoch=$(date +%s)
  local age_hours=$(( (now_epoch - last_epoch) / 3600 ))

  if [[ "$age_hours" -gt 25 ]]; then
    log_warn "Probe [gemini_rates]: Rates are ${age_hours}h old (expected <25h) — FIXING"
    curl -s -X POST "http://localhost:3001/api/agent-cost/refresh-gemini-rates" \
      -H "Content-Type: application/json" > /dev/null 2>&1 && \
      log_ok "  Triggered Gemini rate refresh" || \
      log_warn "  Failed to trigger rate refresh"
    return 0
  fi

  log_ok "Probe [gemini_rates]: Rates updated ${age_hours}h ago ✓"
}

# --- Probe H: Meta Health ---
# Checks Meta token expiry and performance sync status per project.
# FIX: Triggers manual sync if stale. ALERTs for expiring tokens.
probe_meta_health() {
  [[ "$PROBE_META_HEALTH" != "true" ]] && return 0

  # Query projects directly from Convex (no auth needed)
  local projects
  projects=$(curl -s --max-time 5 "${CONVEX_URL}/api/query" \
    -H "Content-Type: application/json" \
    -d '{"path":"projects:getAll","args":{}}' 2>/dev/null) || {
    log_warn "Probe [meta_health]: Could not query Convex for projects"
    return 0
  }

  # Find projects with Meta connected
  local meta_projects
  meta_projects=$(echo "$projects" | jq -c '[.value[]? | select(.meta_access_token != null and .meta_access_token != "")]' 2>/dev/null || echo "[]")
  local meta_count
  meta_count=$(echo "$meta_projects" | jq 'length' 2>/dev/null || echo 0)

  if [[ "$meta_count" -eq 0 ]]; then
    log_info "Probe [meta_health]: No Meta-connected projects ✓"
    return 0
  fi

  local now_epoch
  now_epoch=$(date +%s)
  local warn_threshold_s=$((PROBE_META_TOKEN_WARN_DAYS * 86400))
  local issues=0

  for i in $(seq 0 $((meta_count - 1))); do
    local project
    project=$(echo "$meta_projects" | jq ".[$i]")
    local pid
    pid=$(echo "$project" | jq -r '.externalId // "unknown"')
    local pname
    pname=$(echo "$project" | jq -r '.name // "unnamed"')

    # Check token expiry
    local expires_at
    expires_at=$(echo "$project" | jq -r '.meta_token_expires_at // ""' 2>/dev/null)
    if [[ -n "$expires_at" && "$expires_at" != "null" ]]; then
      local expires_epoch
      expires_epoch=$(date -d "$expires_at" +%s 2>/dev/null || echo 0)
      if [[ "$expires_epoch" -gt 0 ]]; then
        local remaining_s=$((expires_epoch - now_epoch))
        local remaining_days=$((remaining_s / 86400))
        if [[ "$remaining_s" -le 0 ]]; then
          log_err "Probe [meta_health]: Token EXPIRED for '$pname' — user must reconnect in Settings"
          send_notification "🚨 Dacia Fixer: Meta Token Expired" \
            "Project: $pname\nToken has expired. Reconnect Meta in project settings."
          issues=$((issues + 1))
        elif [[ "$remaining_s" -lt "$warn_threshold_s" ]]; then
          log_warn "Probe [meta_health]: Token expires in ${remaining_days}d for '$pname'"
          send_notification "⚠️ Dacia Fixer: Meta Token Expiring Soon" \
            "Project: $pname\nToken expires in ${remaining_days} days. Reconnect in project settings."
          issues=$((issues + 1))
        fi
      fi
    fi
  done

  if [[ "$issues" -eq 0 ]]; then
    log_ok "Probe [meta_health]: ${meta_count} project(s) healthy ✓"
  else
    log_warn "Probe [meta_health]: ${issues} issue(s) across ${meta_count} project(s)"
  fi
}

# --- Probe I: API Key Validation ---
# Tests LLM API keys directly (no backend auth needed).
# Throttled to run once per hour (uses timestamp file).
# ALERT only — user must update keys in Settings.
probe_api_keys() {
  [[ "$PROBE_API_KEYS" != "true" ]] && return 0

  # Throttle: only run once per PROBE_API_KEY_INTERVAL_MIN
  local throttle_file="${FIXER_DIR}/config/.probe_api_keys_last"
  if [[ -f "$throttle_file" ]]; then
    local last_run
    last_run=$(cat "$throttle_file" 2>/dev/null || echo 0)
    local now_epoch
    now_epoch=$(date +%s)
    local age_min=$(( (now_epoch - last_run) / 60 ))
    if [[ "$age_min" -lt "$PROBE_API_KEY_INTERVAL_MIN" ]]; then
      log_info "Probe [api_keys]: Skipped (last check ${age_min}m ago, interval ${PROBE_API_KEY_INTERVAL_MIN}m) ✓"
      return 0
    fi
  fi

  # Record this run
  date +%s > "$throttle_file"
  local failures=0
  local tested=0

  # Helper: fetch a single API key from Convex settings
  _get_key() {
    curl -s --max-time 5 "${CONVEX_URL}/api/query" \
      -H "Content-Type: application/json" \
      -d "{\"path\":\"settings:get\",\"args\":{\"key\":\"$1\"}}" 2>/dev/null | jq -r '.value // ""'
  }

  # Test Anthropic key
  local anthropic_key
  anthropic_key=$(_get_key "anthropic_api_key")
  if [[ -n "$anthropic_key" && "$anthropic_key" != "null" ]]; then
    tested=$((tested + 1))
    local anth_result
    anth_result=$(curl -s --max-time 10 "https://api.anthropic.com/v1/messages" \
      -H "x-api-key: $anthropic_key" \
      -H "anthropic-version: 2023-06-01" \
      -H "Content-Type: application/json" \
      -d '{"model":"claude-haiku-4-5-20251001","max_tokens":1,"messages":[{"role":"user","content":"hi"}]}' 2>/dev/null)
    local anth_type
    anth_type=$(echo "$anth_result" | jq -r '.type // "ok"' 2>/dev/null)
    if [[ "$anth_type" == "error" ]]; then
      local anth_err
      anth_err=$(echo "$anth_result" | jq -r '.error.message // "unknown"' 2>/dev/null)
      # 429 = rate limited but key is valid. Only flag auth errors.
      if echo "$anth_err" | grep -qi "invalid\|expired\|unauthorized\|denied"; then
        log_err "Probe [api_keys]: Anthropic key INVALID — $anth_err"
        send_notification "🚨 Dacia Fixer: Anthropic API Key Invalid" \
          "Key test failed: $anth_err\nUpdate in Settings → API Keys."
        failures=$((failures + 1))
      fi
    fi
  fi

  # Test OpenAI key
  local openai_key
  openai_key=$(_get_key "openai_api_key")
  if [[ -n "$openai_key" && "$openai_key" != "null" ]]; then
    tested=$((tested + 1))
    local oai_result
    oai_result=$(curl -s --max-time 10 "https://api.openai.com/v1/models" \
      -H "Authorization: Bearer $openai_key" 2>/dev/null)
    local oai_err
    oai_err=$(echo "$oai_result" | jq -r '.error.code // ""' 2>/dev/null)
    if [[ "$oai_err" == "invalid_api_key" || "$oai_err" == "insufficient_quota" ]]; then
      log_err "Probe [api_keys]: OpenAI key INVALID — $oai_err"
      send_notification "🚨 Dacia Fixer: OpenAI API Key Invalid" \
        "Key test failed: $oai_err\nUpdate in Settings → API Keys."
      failures=$((failures + 1))
    fi
  fi

  # Test Gemini key
  local gemini_key
  gemini_key=$(_get_key "gemini_api_key")
  if [[ -n "$gemini_key" && "$gemini_key" != "null" ]]; then
    tested=$((tested + 1))
    local gem_result
    gem_result=$(curl -s --max-time 10 "https://generativelanguage.googleapis.com/v1beta/models?key=${gemini_key}" 2>/dev/null)
    local gem_err
    gem_err=$(echo "$gem_result" | jq -r '.error.message // ""' 2>/dev/null)
    if [[ -n "$gem_err" ]] && echo "$gem_err" | grep -qi "invalid\|expired\|denied"; then
      log_err "Probe [api_keys]: Gemini key INVALID — $gem_err"
      send_notification "🚨 Dacia Fixer: Gemini API Key Invalid" \
        "Key test failed: $gem_err\nUpdate in Settings → API Keys."
      failures=$((failures + 1))
    fi
  fi

  if [[ "$failures" -eq 0 && "$tested" -gt 0 ]]; then
    log_ok "Probe [api_keys]: ${tested} API key(s) valid ✓"
  elif [[ "$tested" -eq 0 ]]; then
    log_warn "Probe [api_keys]: No API keys found in settings"
  else
    log_err "Probe [api_keys]: ${failures}/${tested} key(s) failed"
  fi
}

# --- Probe J: Nginx Health ---
# Checks that Nginx reverse proxy is serving HTTPS.
# FIX: Restarts nginx if it's down.
probe_nginx() {
  [[ "$PROBE_NGINX" != "true" ]] && return 0

  # Check if nginx process is running
  local nginx_running
  nginx_running=$(pgrep -c nginx 2>/dev/null || echo 0)

  if [[ "$nginx_running" -eq 0 ]]; then
    log_err "Probe [nginx]: Nginx is NOT running — FIXING"
    systemctl restart nginx 2>/dev/null && {
      sleep 2
      local verify
      verify=$(pgrep -c nginx 2>/dev/null || echo 0)
      if [[ "$verify" -gt 0 ]]; then
        log_ok "  Nginx restarted successfully"
        send_notification "🔧 Dacia Fixer: Restarted Nginx" \
          "Nginx was down. Restart successful — HTTPS is back online."
        return 0
      else
        log_err "  Nginx still not running after restart"
        send_notification "🚨 Dacia Fixer: Nginx Won't Start" \
          "Nginx is down and restart failed. Manual intervention needed.\nCheck: systemctl status nginx"
        return 1
      fi
    } || {
      log_err "  systemctl restart nginx failed"
      send_notification "🚨 Dacia Fixer: Nginx Down — Restart Failed" \
        "Nginx is not running and systemctl restart failed.\nManual intervention needed."
      return 1
    }
  fi

  # Nginx is running — verify it's serving correctly
  local http_code
  http_code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 3 "http://localhost:3001/api/health" 2>/dev/null || echo 0)

  if [[ "$http_code" -eq 0 ]]; then
    # Backend is down — probe_backend_health handles this
    log_info "Probe [nginx]: Nginx running, backend unreachable (handled by backend_health probe)"
    return 0
  fi

  log_ok "Probe [nginx]: Nginx running (${nginx_running} workers) ✓"
}

# --- Probe K: Disk Space ---
# Monitors disk usage and auto-cleans old logs and caches.
# FIX: Deletes old agent logs, PM2 logs, thumbnail cache.
probe_disk_space() {
  [[ "$PROBE_DISK_SPACE" != "true" ]] && return 0

  local usage_pct
  usage_pct=$(df "$PROJECT_DIR" 2>/dev/null | awk 'NR==2 {print $5}' | tr -d '%' || echo 0)
  usage_pct=${usage_pct:-0}

  if [[ "$usage_pct" -lt "$PROBE_DISK_WARN_PCT" ]]; then
    log_ok "Probe [disk_space]: ${usage_pct}% used ✓"
    return 0
  fi

  log_warn "Probe [disk_space]: ${usage_pct}% used (threshold: ${PROBE_DISK_WARN_PCT}%) — CLEANING"
  local cleaned=0

  # Clean old fixer logs
  local old_fixer
  old_fixer=$(find "$LOG_DIR" -name "fixer_*.log" -mtime "+${PROBE_LOG_RETENTION_DAYS}" 2>/dev/null | wc -l)
  if [[ "$old_fixer" -gt 0 ]]; then
    find "$LOG_DIR" -name "fixer_*.log" -mtime "+${PROBE_LOG_RETENTION_DAYS}" -delete 2>/dev/null
    find "$LOG_DIR" -name "spend_*.txt" -mtime "+${PROBE_LOG_RETENTION_DAYS}" -delete 2>/dev/null
    log_info "  Deleted $old_fixer old fixer log(s)"
    cleaned=$((cleaned + old_fixer))
  fi

  # Clean old filter logs
  if [[ -d "$FILTER_LOG_DIR" ]]; then
    local old_filter
    old_filter=$(find "$FILTER_LOG_DIR" -name "*.log" -mtime "+${PROBE_LOG_RETENTION_DAYS}" 2>/dev/null | wc -l)
    if [[ "$old_filter" -gt 0 ]]; then
      find "$FILTER_LOG_DIR" -name "*.log" -mtime "+${PROBE_LOG_RETENTION_DAYS}" -delete 2>/dev/null
      log_info "  Deleted $old_filter old filter log(s)"
      cleaned=$((cleaned + old_filter))
    fi
  fi

  # Clean old director logs
  if [[ -d "$DIRECTOR_LOG_DIR" ]]; then
    local old_director
    old_director=$(find "$DIRECTOR_LOG_DIR" -name "*.log" -mtime "+${PROBE_LOG_RETENTION_DAYS}" 2>/dev/null | wc -l)
    if [[ "$old_director" -gt 0 ]]; then
      find "$DIRECTOR_LOG_DIR" -name "*.log" -mtime "+${PROBE_LOG_RETENTION_DAYS}" -delete 2>/dev/null
      log_info "  Deleted $old_director old director log(s)"
      cleaned=$((cleaned + old_director))
    fi
  fi

  # Clean thumbnail cache
  local thumb_cache="${PROJECT_DIR}/backend/.thumb-cache"
  if [[ -d "$thumb_cache" ]]; then
    local thumb_size
    thumb_size=$(du -sm "$thumb_cache" 2>/dev/null | cut -f1 || echo 0)
    if [[ "$thumb_size" -gt 50 ]]; then
      rm -rf "$thumb_cache" 2>/dev/null
      mkdir -p "$thumb_cache" 2>/dev/null
      log_info "  Cleared thumbnail cache (${thumb_size}MB)"
      cleaned=$((cleaned + 1))
    fi
  fi

  # Clean PM2 logs older than 3 days
  local pm2_log_dir="$HOME/.pm2/logs"
  if [[ -d "$pm2_log_dir" ]]; then
    local old_pm2
    old_pm2=$(find "$pm2_log_dir" -name "*.log" -mtime +3 2>/dev/null | wc -l)
    if [[ "$old_pm2" -gt 0 ]]; then
      find "$pm2_log_dir" -name "*.log" -mtime +3 -delete 2>/dev/null
      log_info "  Deleted $old_pm2 old PM2 log(s)"
      cleaned=$((cleaned + old_pm2))
    fi
    # Truncate current PM2 logs if they're huge (>100MB)
    for logfile in "$pm2_log_dir"/*.log; do
      if [[ -f "$logfile" ]]; then
        local log_mb
        log_mb=$(du -m "$logfile" 2>/dev/null | cut -f1 || echo 0)
        if [[ "$log_mb" -gt 100 ]]; then
          tail -1000 "$logfile" > "${logfile}.tmp" && mv "${logfile}.tmp" "$logfile"
          log_info "  Truncated large PM2 log: $(basename "$logfile") (was ${log_mb}MB)"
          cleaned=$((cleaned + 1))
        fi
      fi
    done
  fi

  # Re-check disk usage after cleaning
  local new_usage
  new_usage=$(df "$PROJECT_DIR" 2>/dev/null | awk 'NR==2 {print $5}' | tr -d '%' || echo 0)
  new_usage=${new_usage:-0}

  if [[ "$new_usage" -ge "$PROBE_DISK_CRIT_PCT" ]]; then
    log_err "Probe [disk_space]: Still at ${new_usage}% after cleaning — manual cleanup needed"
    send_notification "🚨 Dacia Fixer: Disk Space Critical (${new_usage}%)" \
      "Cleaned ${cleaned} old files but disk is still at ${new_usage}%.\nManual cleanup needed on VPS."
    return 1
  fi

  log_ok "Probe [disk_space]: Cleaned ${cleaned} file(s), now at ${new_usage}% ✓"
}

# --- Probe L: Zombie Filter Process ---
# Detects filter.sh processes that have been running too long.
# FIX: Kills the hung process so the next cron cycle starts fresh.
probe_filter_process() {
  [[ "$PROBE_FILTER_PROCESS" != "true" ]] && return 0

  # Find filter.sh processes and their runtime
  local filter_pids
  filter_pids=$(pgrep -f "filter\.sh" 2>/dev/null || echo "")

  if [[ -z "$filter_pids" ]]; then
    log_info "Probe [filter_process]: No filter process running ✓"
    return 0
  fi

  local now_epoch
  now_epoch=$(date +%s)
  local zombie_threshold_s=$((PROBE_FILTER_ZOMBIE_MINUTES * 60))
  local killed=0

  while IFS= read -r pid; do
    [[ -z "$pid" ]] && continue

    # Get process start time
    local start_time
    start_time=$(ps -o lstart= -p "$pid" 2>/dev/null || echo "")
    if [[ -z "$start_time" ]]; then
      continue
    fi

    local start_epoch
    start_epoch=$(date -d "$start_time" +%s 2>/dev/null || \
                  date -jf "%c" "$start_time" +%s 2>/dev/null || echo 0)

    if [[ "$start_epoch" -gt 0 ]]; then
      local age_s=$((now_epoch - start_epoch))
      local age_min=$((age_s / 60))

      if [[ "$age_s" -gt "$zombie_threshold_s" ]]; then
        log_warn "Probe [filter_process]: Filter PID $pid running for ${age_min}min (>${PROBE_FILTER_ZOMBIE_MINUTES}min) — KILLING"
        kill "$pid" 2>/dev/null
        sleep 2
        # Force kill if still alive
        if kill -0 "$pid" 2>/dev/null; then
          kill -9 "$pid" 2>/dev/null
          log_info "  Force-killed PID $pid"
        fi
        killed=$((killed + 1))
      else
        log_info "Probe [filter_process]: Filter running (${age_min}min, under ${PROBE_FILTER_ZOMBIE_MINUTES}min limit) ✓"
      fi
    fi
  done <<< "$filter_pids"

  if [[ "$killed" -gt 0 ]]; then
    # Clean any lock files the filter may have left
    rm -f "${FILTER_DIR_PATH}/.lock" 2>/dev/null
    log_ok "Probe [filter_process]: Killed ${killed} zombie process(es) — next cron will start fresh"
    send_notification "🔧 Dacia Fixer: Killed Zombie Filter Process" \
      "Filter process was running for >${PROBE_FILTER_ZOMBIE_MINUTES}min. Killed it.\nNext cron cycle (every 30 min) will start a fresh run."
  fi
}

# ============================================================
# FIX PIPELINE
# ============================================================

apply_fix() {
  local fix_output="$1"
  local current_file="" in_code=false code_content=""
  
  while IFS= read -r line; do
    if [[ "$line" =~ ^---\ WRITE:\ (.+)\ --- ]]; then
      if [[ -n "$current_file" && -n "$code_content" ]]; then
        mkdir -p "$(dirname "${PROJECT_DIR}/${current_file}")"
        echo "$code_content" > "${PROJECT_DIR}/${current_file}"
        log_info "Wrote: $current_file"
      fi
      current_file="${BASH_REMATCH[1]}"
      code_content=""
      in_code=true
    elif [[ "$line" == "--- END ---" ]]; then
      if [[ -n "$current_file" && -n "$code_content" ]]; then
        mkdir -p "$(dirname "${PROJECT_DIR}/${current_file}")"
        echo "$code_content" > "${PROJECT_DIR}/${current_file}"
        log_info "Wrote: $current_file"
      fi
      current_file="" code_content="" in_code=false
    elif [[ "$in_code" == true ]]; then
      [[ -z "$code_content" ]] && code_content="$line" || code_content+=$'\n'"$line"
    fi
  done <<< "$fix_output"
}

run_fix_pipeline() {
  local suite="$1" test_output="$2" attempt="$3"
  
  log_info "Fix pipeline: '$suite' (attempt $attempt/$MAX_RETRIES)"
  check_budget || return 1
  
  local context; context=$(build_context "$suite")
  
  # Agent 1: Diagnose (Gemini Flash — ~$0.006)
  log_info "Agent 1/2: Diagnosing with $DIAGNOSIS_MODEL..."
  local diagnosis
  diagnosis=$(bash "${SCRIPT_DIR}/agents/diagnose.sh" "$test_output" "$context" "$suite")
  add_spend 1 "diagnosis" "$DIAGNOSIS_MODEL" "$DIAGNOSIS_PROVIDER"

  # Agent 2: Fix (Claude Sonnet — ~$0.05)
  log_info "Agent 2/2: Fixing with $FIX_MODEL..."
  local fix_output
  fix_output=$(bash "${SCRIPT_DIR}/agents/fix.sh" "$diagnosis" "$context" "$test_output" "$suite")
  add_spend 5 "fix" "$FIX_MODEL" "anthropic"
  
  # Track which files were changed
  local files_changed
  files_changed=$(echo "$fix_output" | grep -oP '(?<=--- WRITE: ).*(?= ---)' | tr '\n' ' ')
  
  # Check for recurring patterns BEFORE applying
  local is_recurring
  is_recurring=$(check_recurring_pattern "$files_changed")
  
  if [[ "$is_recurring" == "true" ]]; then
    log_warn "Recurring pattern detected — fix agent should apply deeper fix"
  fi
  
  # Apply fix
  apply_fix "$fix_output" || { log_err "Failed to apply fix"; return 1; }
  
  # Verify
  log_info "Verifying fix..."
  local verify_output verify_exit=0
  verify_output=$(run_tests "$suite") || verify_exit=$?
  
  if [[ "$verify_exit" -eq 0 ]]; then
    log_ok "Fix verified — all tests passing!"
    
    # === LOG TO LEDGER ===
    log_to_ledger "$suite" "$diagnosis" "$files_changed" "$attempt" "$is_recurring"
    
    # === COMMIT TO FIXER BRANCH ===
    if [[ "$AUTO_COMMIT" == "true" ]]; then
      commit_to_fixer_branch "$suite" "$files_changed"
    fi
    
    # === RESURRECTION ===
    resurrect_failed_batches
    
    send_notification "🟢 Dacia Fixer: Fix Applied + Batches Resurrected" \
      "Suite: $suite | Attempt: $attempt\nFiles: $files_changed\nRecurring: $is_recurring\nFailed batches have been re-queued."
    return 0
  else
    log_warn "Fix didn't resolve the issue"
    cd "$PROJECT_DIR"
    # Only revert the specific files that were changed, not the entire working tree
    if [[ -n "$files_changed" ]]; then
      for f in $files_changed; do
        git checkout -- "$f" 2>/dev/null || true
      done
      log_info "Reverted changed files: $files_changed"
    fi
    return 1
  fi
}

# --- Process Suite ---
process_suite() {
  local suite="$1"
  log_info "━━━ Checking: $suite ━━━"

  # --- Health Probes (free — no LLM cost) ---
  # Core system (A-E)
  probe_backend_health || true
  probe_filter_scoring || true
  probe_filter_liveness || true
  probe_deployment_pipeline || true
  probe_batch_completion || true
  # Extended system (F-L)
  probe_cost_sync || true
  probe_gemini_rates || true
  probe_meta_health || true
  probe_api_keys || true
  probe_nginx || true
  probe_disk_space || true
  probe_filter_process || true

  # --- Existing checks ---
  check_agent_health

  local test_output test_exit=0
  test_output=$(run_tests "$suite") || test_exit=$?
  
  if [[ "$test_exit" -eq 0 ]]; then
    log_ok "$suite: All tests passing ✓"
    resurrect_failed_batches
    return 0
  fi
  
  log_warn "$suite: Tests failing — starting fix pipeline"
  
  for attempt in $(seq 1 "$MAX_RETRIES"); do
    if run_fix_pipeline "$suite" "$test_output" "$attempt"; then
      return 0
    fi
    [[ "$attempt" -lt "$MAX_RETRIES" ]] && {
      log_info "Retrying ($((attempt + 1))/$MAX_RETRIES)..."
      test_output=$(run_tests "$suite" 2>&1) || true
    }
  done
  
  log_err "$suite: Failed after $MAX_RETRIES attempts"
  send_notification "🔴 Dacia Fixer: Fix Failed" \
    "Suite: $suite | Attempts: $MAX_RETRIES\nManual intervention needed.\n$(echo "$test_output" | tail -10)"
  return 1
}

# --- Status ---
show_status() {
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BLUE}  DACIA FIXER — Recursive Agent #1  ${NC}"
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo "Date:    $TODAY"
  echo "Budget:  ${DAILY_BUDGET_CENTS}¢/day (\$$(echo "scale=2; $DAILY_BUDGET_CENTS / 100" | bc)/day)"
  echo "Spent:   $(get_daily_spend)¢"
  echo "Log:     $LOG_FILE"
  echo ""
  if [[ -f "$LOG_FILE" ]]; then
    local fixes; fixes=$(grep -c "\[OK\]" "$LOG_FILE" 2>/dev/null || echo 0)
    local failures; failures=$(grep -c "Failed after" "$LOG_FILE" 2>/dev/null || echo 0)
    local runs; runs=$(grep -c "Checking:" "$LOG_FILE" 2>/dev/null || echo 0)
    local resurrections; resurrections=$(grep -c "Resurrected" "$LOG_FILE" 2>/dev/null || echo 0)
    echo "Runs:          $runs"
    echo -e "Fixes:         ${GREEN}$fixes${NC}"
    echo -e "Failures:      ${RED}$failures${NC}"
    echo -e "Resurrections: ${CYAN}$resurrections${NC}"
  fi
  echo ""
  echo -e "${BLUE}── Git Branch ──${NC}"
  if [[ -d "${PROJECT_DIR}/.git" ]]; then
    cd "$PROJECT_DIR"
    local current_branch
    current_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
    echo "Current branch:  $current_branch"
    echo "Fixer branch:    $FIXER_BRANCH"
    if git rev-parse --verify "$FIXER_BRANCH" > /dev/null 2>&1; then
      local fixer_commits
      fixer_commits=$(git log "$current_branch".."$FIXER_BRANCH" --oneline 2>/dev/null | wc -l)
      local last_fix
      last_fix=$(git log "$FIXER_BRANCH" -1 --format="%h %s" 2>/dev/null || echo "none")
      echo -e "Unmerged fixes:  ${YELLOW}$fixer_commits${NC}"
      echo "Last fix:        $last_fix"
      if [[ "$fixer_commits" -gt 0 ]]; then
        echo ""
        echo "To review:  git log main..${FIXER_BRANCH} --oneline"
        echo "To merge:   git checkout main && git merge ${FIXER_BRANCH}"
      fi
    else
      echo "Fixer branch:    not created yet (no fixes applied)"
    fi
  else
    echo "No git repo found at $PROJECT_DIR"
  fi
  echo ""
  echo -e "${BLUE}── Fix Ledger ──${NC}"
  if [[ -f "$FIX_LEDGER" ]]; then
    local total_fixes; total_fixes=$(grep -c "^## " "$FIX_LEDGER" 2>/dev/null || echo 0)
    local recurring; recurring=$(grep -c "RECURRING" "$FIX_LEDGER" 2>/dev/null || echo 0)
    echo "Total fixes logged:   $total_fixes"
    echo -e "Recurring patterns:   ${YELLOW}$recurring${NC}"
    
    # Show most frequently fixed files
    local top_files
    top_files=$(grep "Files changed:" "$FIX_LEDGER" 2>/dev/null | \
      sed 's/.*Files changed:\*\* //' | tr ' ' '\n' | \
      sort | uniq -c | sort -rn | head -5)
    if [[ -n "$top_files" ]]; then
      echo ""
      echo "Most fixed files:"
      echo "$top_files" | while read -r count file; do
        [[ -z "$file" ]] && continue
        local color="$NC"
        [[ "$count" -ge "$PATTERN_ALERT_THRESHOLD" ]] && color="$RED"
        echo -e "  ${color}${count}x ${file}${NC}"
      done
    fi
  else
    echo "No fixes logged yet"
  fi
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

# --- Entry Point ---
main() {
  acquire_lock
  init_spend_tracker
  init_ledger

  # Check pause file — if paused, skip execution (status/resurrect still work)
  local pause_file="${FIXER_DIR}/.paused"
  if [[ -f "$pause_file" ]] && [[ "${1:-}" != "--status" ]] && [[ "${1:-}" != "--resurrect" ]]; then
    log_info "Dacia Fixer is PAUSED (${pause_file} exists). Skipping run."
    exit 0
  fi

  case "${1:-}" in
    --status)    show_status; exit 0 ;;
    --resurrect) resurrect_failed_batches; exit 0 ;;
    --daemon)
      log_info "Dacia Fixer starting (interval: ${CHECK_INTERVAL}s)"
      while true; do
        for suite in "${SUITES[@]}"; do
          process_suite "$suite" || true
        done
        sleep "$CHECK_INTERVAL"
      done
      ;;
    "")
      for suite in "${SUITES[@]}"; do
        process_suite "$suite" || true
      done
      ;;
    *)  process_suite "$1" || true ;;
  esac
}

main "$@"

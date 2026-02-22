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

# --- Cost Tracking ---
init_spend_tracker() {
  [[ ! -f "$SPEND_FILE" ]] && echo "0" > "$SPEND_FILE"
}

get_daily_spend() {
  cat "$SPEND_FILE" 2>/dev/null || echo "0"
}

add_spend() {
  local cost_cents="$1"
  local current; current=$(get_daily_spend)
  echo "$current + $cost_cents" | bc > "$SPEND_FILE"
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
      log_warn "Rebase conflict — resetting fixer branch to $current_branch"
      git rebase --abort > /dev/null 2>&1
      git reset --hard "$current_branch" > /dev/null 2>&1
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

  # Commit on fixer branch
  git add -A > /dev/null 2>&1
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
  local output; output=$(eval "$test_cmd" 2>&1) || true
  local exit_code=${PIPESTATUS[0]:-$?}
  echo "$output"
  return "$exit_code"
}

# --- Context Builder ---
build_context() {
  local suite="$1"
  local context_var="${suite}_context[@]"
  local context_files=("${!context_var}" 2>/dev/null || true)
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
      \"path\": \"batch_jobs:getByStatus\",
      \"args\": {\"status\": \"failed\"}
    }" 2>/dev/null) || {
    log_warn "Could not query Convex for failed batches"
    return 0
  }
  
  if [[ -z "$failed_batches" ]] || ! echo "$failed_batches" | jq -e '.value' > /dev/null 2>&1; then
    failed_batches=$(curl -s "${CONVEX_URL}/api/query" \
      -H "Content-Type: application/json" \
      -d "{
        \"path\": \"batch_jobs:list\",
        \"args\": {}
      }" 2>/dev/null) || {
      log_warn "Could not query Convex for batch jobs"
      return 0
    }
  fi
  
  local count=0
  local batch_ids
  batch_ids=$(echo "$failed_batches" | jq -r '.value[]? | select(.status == "failed") | .externalId // ._id' 2>/dev/null)
  
  if [[ -z "$batch_ids" ]]; then
    log_res "No failed batches found ✓"
    return 0
  fi
  
  while IFS= read -r batch_id; do
    [[ -z "$batch_id" ]] && continue
    
    log_res "Resurrecting batch: $batch_id"
    
    local reset_response
    reset_response=$(curl -s -X POST "http://localhost:3001/api/batches/${batch_id}/retry" \
      -H "Content-Type: application/json" \
      -H "Cookie: $(get_session_cookie)" \
      2>/dev/null) || {
      
      reset_response=$(curl -s "${CONVEX_URL}/api/mutation" \
        -H "Content-Type: application/json" \
        -d "{
          \"path\": \"batch_jobs:updateStatus\",
          \"args\": {
            \"externalId\": \"${batch_id}\",
            \"status\": \"pending\",
            \"error\": null,
            \"retry_count\": 0
          }
        }" 2>/dev/null) || {
        log_warn "Failed to resurrect batch $batch_id"
        continue
      }
    }
    
    count=$((count + 1))
    log_res "Batch $batch_id reset to pending"
    
  done <<< "$batch_ids"
  
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
      \"path\": \"batch_jobs:list\",
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
  add_spend 1
  
  # Agent 2: Fix (Claude Sonnet — ~$0.05)
  log_info "Agent 2/2: Fixing with $FIX_MODEL..."
  local fix_output
  fix_output=$(bash "${SCRIPT_DIR}/agents/fix.sh" "$diagnosis" "$context" "$test_output" "$suite")
  add_spend 5
  
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
    git checkout -- . 2>/dev/null || true
    return 1
  fi
}

# --- Process Suite ---
process_suite() {
  local suite="$1"
  log_info "━━━ Checking: $suite ━━━"
  
  check_stuck_batches
  
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
  init_spend_tracker
  init_ledger
  
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
    *)  process_suite "$1" ;;
  esac
}

main "$@"

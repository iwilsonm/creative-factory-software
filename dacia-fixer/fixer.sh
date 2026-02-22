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
  if [[ ! -f "$SPEND_FILE" ]]; then
    echo "0" > "$SPEND_FILE"
  fi
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
  local context_files
  context_files=("${!context_var}") 2>/dev/null || true
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
  
  # Apply fix
  apply_fix "$fix_output" || { log_err "Failed to apply fix"; return 1; }
  
  # Verify
  log_info "Verifying fix..."
  local verify_output verify_exit=0
  verify_output=$(run_tests "$suite") || verify_exit=$?
  
  if [[ "$verify_exit" -eq 0 ]]; then
    log_ok "Fix verified — all tests passing!"
    
    if [[ "$AUTO_COMMIT" == "true" ]]; then
      cd "$PROJECT_DIR"
      git add -A
      git commit -m "fix(dacia-fixer): auto-fix $suite - $(date '+%Y-%m-%d %H:%M')"
    fi
    
    # === RESURRECTION ===
    resurrect_failed_batches
    
    send_notification "🟢 Dacia Fixer: Fix Applied + Batches Resurrected" \
      "Suite: $suite | Attempt: $attempt\nFailed batches have been re-queued."
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
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

# --- Entry Point ---
main() {
  init_spend_tracker
  
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

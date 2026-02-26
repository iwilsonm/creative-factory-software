#!/bin/bash
# ============================================================
# DACIA CREATIVE FILTER
# ============================================================
# Part of the Dacia Recursive Agents team — Agent #2
# Role: Score batch output, group into flex ads, deploy to Ready to Post
#
# Flow per completed batch:
#   1. Score each ad individually (Sonnet 4.6) — ~$0.02/ad
#   2. Filter: keep ads scoring >= threshold
#   3. Group passing ads into 2 flex ads of 10 images (Sonnet 4.6) — ~$0.04
#   4. Create ad set in Planner: "[Brand] Filter - YYYY-MM-DD"
#   5. Create 2 flex ad deployments with shared copy
#   6. Set status: Ready to Post
#
# Usage:
#   ./filter.sh                    # Process any unprocessed batches
#   ./filter.sh --daemon           # Run continuously
#   ./filter.sh --status           # Show today's stats
#   ./filter.sh --dry-run          # Score but don't deploy
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/config/filter.conf"

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
NC='\033[0m'

# --- Mode ---
DRY_RUN=false

# --- Logging ---
mkdir -p "$LOG_DIR"
TODAY=$(date +%Y-%m-%d)
LOG_FILE="${LOG_DIR}/filter_${TODAY}.log"
SPEND_FILE="${LOG_DIR}/spend_${TODAY}.txt"

log() {
  local level="$1"; shift
  local msg="[$(date '+%H:%M:%S')] [FILTER] [$level] $*"
  echo -e "$msg" >> "$LOG_FILE"
  echo -e "$msg" >&2
}
log_info()  { log "INFO"   "$@"; }
log_warn()  { log "WARN"   "${YELLOW}$*${NC}"; }
log_ok()    { log "OK"     "${GREEN}$*${NC}"; }
log_err()   { log "ERROR"  "${RED}$*${NC}"; }
log_score() { log "SCORE"  "${MAGENTA}$*${NC}"; }

# --- Lock File (prevent concurrent execution) ---
LOCK_FILE="/tmp/dacia-filter.lock"

acquire_lock() {
  if [[ -f "$LOCK_FILE" ]]; then
    local lock_pid; lock_pid=$(cat "$LOCK_FILE" 2>/dev/null)
    if [[ -n "$lock_pid" ]] && kill -0 "$lock_pid" 2>/dev/null; then
      log_warn "Another filter instance is running (PID $lock_pid). Exiting."
      exit 0
    else
      log_info "Stale lock file found (PID $lock_pid not running). Removing."
      rm -f "$LOCK_FILE"
    fi
  fi
  echo $$ > "$LOCK_FILE"
  # Clean up lock file + any temp files on exit (prevents /tmp accumulation)
  trap 'rm -f "$LOCK_FILE" /tmp/filter_cookies_$$.txt /tmp/filter_group_ads_$$.json "${SPEND_FILE}.lock" 2>/dev/null' EXIT INT TERM
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
  # Log to Convex api_costs via backend (fire-and-forget, safe JSON via jq)
  curl -s -X POST "${BACKEND_URL}/api/agent-cost/log" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg op "$operation" --argjson cost "$cost_cents" --arg svc "$service" \
      '{agent: "filter", operation: $op, cost_cents: $cost, service: $svc}')" \
    > /dev/null 2>&1 &
}

check_budget() {
  local current; current=$(get_daily_spend)
  if (( $(echo "$current >= $DAILY_BUDGET_CENTS" | bc -l) )); then
    log_warn "Daily budget reached (${current}¢ / ${DAILY_BUDGET_CENTS}¢). Skipping."
    return 1
  fi
  return 0
}

# --- Notifications ---
send_notification() {
  local title="$1" message="$2"
  case "$NOTIFY_METHOD" in
    slack)
      if [[ -n "${SLACK_WEBHOOK_URL:-}" ]]; then
        curl -s -X POST "$SLACK_WEBHOOK_URL" \
          -H 'Content-type: application/json' \
          -d "$(jq -n --arg t "$title" --arg m "$message" '{text: ("*" + $t + "*\n" + $m)}')" > /dev/null 2>&1 || true
      fi
      ;;
    webhook)
      if [[ -n "${WEBHOOK_URL:-}" ]]; then
        curl -s -X POST "$WEBHOOK_URL" \
          -H 'Content-type: application/json' \
          -d "$(jq -n --arg t "$title" --arg m "$message" '{title: $t, message: $m}')" > /dev/null 2>&1 || true
      fi
      ;;
    none) ;;
  esac
}

# --- Auth ---
SESSION_COOKIE_FILE="${FILTER_DIR}/config/.session_cookie"
SESSION_COOKIE_MAX_AGE=$((24 * 60 * 60))  # 24 hours — re-auth before 30-day server expiry

_do_login() {
  local cookie_jar="/tmp/filter_cookies_$$.txt"
  curl -s -c "$cookie_jar" -X POST "${BACKEND_URL}/api/auth/login" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg u "${FILTER_USERNAME:-filter}" --arg p "${FILTER_PASSWORD:-}" \
      '{username: $u, password: $p}')" > /dev/null 2>&1

  local sid
  sid=$(grep 'connect.sid' "$cookie_jar" 2>/dev/null | awk '{print $NF}') || true
  rm -f "$cookie_jar"

  if [[ -n "$sid" ]]; then
    local cookie_header="connect.sid=${sid}"
    echo "$cookie_header" > "$SESSION_COOKIE_FILE"
    # Write timestamp alongside cookie for expiry tracking
    date +%s > "${SESSION_COOKIE_FILE}.ts"
    echo "$cookie_header"
  else
    log_warn "Login failed — no session cookie returned"
    echo ""
  fi
}

get_session_cookie() {
  # Check if cached cookie exists and is not expired
  if [[ -f "$SESSION_COOKIE_FILE" ]]; then
    local ts_file="${SESSION_COOKIE_FILE}.ts"
    if [[ -f "$ts_file" ]]; then
      local created_at; created_at=$(cat "$ts_file" 2>/dev/null || echo "0")
      local now; now=$(date +%s)
      local age=$((now - created_at))
      if [[ "$age" -ge "$SESSION_COOKIE_MAX_AGE" ]]; then
        log_info "Session cookie expired ($age s old). Re-authenticating."
        rm -f "$SESSION_COOKIE_FILE" "$ts_file"
        _do_login
        return
      fi
    fi
    cat "$SESSION_COOKIE_FILE"
    return
  fi

  # No cached cookie — login fresh
  _do_login
}

# Re-authenticate and retry a curl command that returned 401
curl_with_auth_retry() {
  local url="$1"; shift
  # First attempt
  local http_code
  local response
  response=$(curl -s -w "\n%{http_code}" "$url" \
    -H "Cookie: $(get_session_cookie)" "$@" 2>/dev/null) || true
  http_code=$(echo "$response" | tail -1)
  local body; body=$(echo "$response" | sed '$d')

  if [[ "$http_code" == "401" ]]; then
    log_info "Got 401 — re-authenticating and retrying..."
    rm -f "$SESSION_COOKIE_FILE" "${SESSION_COOKIE_FILE}.ts"
    response=$(curl -s -w "\n%{http_code}" "$url" \
      -H "Cookie: $(get_session_cookie)" "$@" 2>/dev/null) || true
    http_code=$(echo "$response" | tail -1)
    body=$(echo "$response" | sed '$d')
  fi

  echo "$body"
}
}

# ============================================================
# STEP 1: Find unprocessed completed batches
# ============================================================

get_unprocessed_batches() {
  log_info "Checking for completed batches to process..."

  # Query Convex for completed batches
  local batches
  batches=$(curl -s "${CONVEX_URL}/api/query" \
    -H "Content-Type: application/json" \
    -d "{
      \"path\": \"batchJobs:list\",
      \"args\": {}
    }" 2>/dev/null) || {
    log_warn "Could not query Convex for batches"
    echo "[]"
    return
  }

  # Filter: completed + assigned to filter + not yet processed
  # Only batches explicitly assigned via filter_assigned=true are processed
  echo "$batches" | jq '[.value[]? | select(.status == "completed" and (.filter_processed == null or .filter_processed == false) and .filter_assigned == true)]' 2>/dev/null || echo "[]"
}

# ============================================================
# STEP 2: Get ads from a batch
# ============================================================

get_batch_ads() {
  local batch_id="$1"

  local ads
  ads=$(curl -s "${CONVEX_URL}/api/query" \
    -H "Content-Type: application/json" \
    -d "{
      \"path\": \"adCreatives:getByBatch\",
      \"args\": {\"batchId\": \"${batch_id}\"}
    }" 2>/dev/null) || {
    log_warn "Could not fetch ads for batch $batch_id"
    echo "[]"
    return
  }

  echo "$ads" | jq '.value // []' 2>/dev/null || echo "[]"
}

# ============================================================
# STEP 3: Get project config (defaults for deployment)
# ============================================================

get_project_config() {
  local project_id="$1"

  local project
  project=$(curl -s "${CONVEX_URL}/api/query" \
    -H "Content-Type: application/json" \
    -d "{
      \"path\": \"projects:getByExternalId\",
      \"args\": {\"externalId\": \"${project_id}\"}
    }" 2>/dev/null) || {
    log_warn "Could not fetch project $project_id"
    echo "{}"
    return
  }

  echo "$project" | jq '.value // {}' 2>/dev/null || echo "{}"
}

# ============================================================
# STEP 4: Get top performers for comparison context
# ============================================================

get_top_performers() {
  local project_id="$1"

  # Pull ads with best Meta performance data (lowest CPC, highest ROAS)
  local performers
  performers=$(curl -s "${BACKEND_URL}/api/projects/${project_id}/meta/top-performers" \
    -H "Cookie: $(get_session_cookie)" \
    2>/dev/null) || {
    # Fallback: return empty if endpoint doesn't exist yet
    echo "No historical performance data available yet."
    return
  }

  # Format top performers as context string
  echo "$performers" | jq -r '.[] | "Headline: \(.headline) | Primary: \(.primary_text) | CPC: $\(.cpc) | ROAS: \(.roas)"' 2>/dev/null || \
    echo "No historical performance data available yet."
}

# ============================================================
# STEP 5: Score all ads in a batch
# ============================================================

score_batch_ads() {
  local ads_json="$1"
  local top_performers="$2"
  local ad_count
  ad_count=$(echo "$ads_json" | jq 'length')

  log_info "Scoring $ad_count ads..."

  local scored_ads="[]"
  local pass_count=0
  local fail_count=0

  for i in $(seq 0 $((ad_count - 1))); do
    check_budget || {
      log_warn "Budget hit during scoring at ad $((i+1))/$ad_count"
      break
    }

    local ad
    ad=$(echo "$ads_json" | jq ".[$i]")
    local ad_id
    ad_id=$(echo "$ad" | jq -r '.externalId // ._id // "unknown"')

    log_score "Scoring ad $((i+1))/$ad_count: $ad_id"

    local score_result
    score_result=$(bash "${SCRIPT_DIR}/agents/score.sh" "$ad" "$top_performers")
    add_spend 2 "scoring" "$SCORE_MODEL" "anthropic"  # ~$0.02 per ad

    local passed
    passed=$(echo "$score_result" | jq -r '.pass // false')
    local overall
    overall=$(echo "$score_result" | jq -r '.overall_score // 0')

    if [[ "$passed" == "true" ]]; then
      pass_count=$((pass_count + 1))
      log_score "  ✓ PASS (${overall}/10) — $ad_id"
    else
      fail_count=$((fail_count + 1))
      log_score "  ✗ FAIL (${overall}/10) — $ad_id"
    fi

    # Merge score into ad object
    local merged
    merged=$(echo "$ad" | jq --argjson score "$score_result" '. + $score')
    scored_ads=$(echo "$scored_ads" | jq --argjson ad "$merged" '. + [$ad]')
  done

  log_info "Scoring complete: $pass_count passed, $fail_count failed"
  echo "$scored_ads"
}

# ============================================================
# STEP 6: Group passing ads into flex ads
# ============================================================

group_into_flex_ads() {
  local scored_ads="$1"
  local project_name="$2"
  local flex_count_target="${3:-$FLEX_AD_COUNT}"
  local total_needed=$((flex_count_target * IMAGES_PER_FLEX))

  # Filter to passing ads only
  local passing
  passing=$(echo "$scored_ads" | jq '[.[] | select(.pass == true)]')
  local pass_count
  pass_count=$(echo "$passing" | jq 'length')

  if [[ "$pass_count" -lt "$total_needed" ]]; then
    log_warn "Only $pass_count passing ads, need $total_needed for ${flex_count_target} flex ads"
    if [[ "$pass_count" -lt "$IMAGES_PER_FLEX" ]]; then
      log_err "Not enough passing ads for even 1 flex ad. Skipping grouping."
      echo "{\"flex_ads\": [], \"error\": \"insufficient_ads\"}"
      return
    fi
    log_info "Will create as many flex ads as possible with $pass_count ads"
  fi

  log_info "Grouping $pass_count passing ads into ${flex_count_target} flex ads..."

  # Write passing ads to temp file to avoid ARG_MAX limit on large payloads
  local temp_ads="/tmp/filter_group_ads_$$.json"
  echo "$passing" > "$temp_ads"

  local group_result
  group_result=$(bash "${SCRIPT_DIR}/agents/group.sh" "$temp_ads" "$project_name" "$flex_count_target" 2>&1) || {
    log_err "group.sh exited with error code $?"
    log_err "group.sh output: $(echo "$group_result" | head -c 300)"
    rm -f "$temp_ads"
    echo "{\"flex_ads\": [], \"error\": \"group_script_failed\"}"
    return
  }
  rm -f "$temp_ads"
  add_spend 4 "grouping" "$GROUP_MODEL" "anthropic"  # ~$0.04 per grouping call

  # Log grouping result summary
  local result_flex_count
  result_flex_count=$(echo "$group_result" | jq '.flex_ads | length' 2>/dev/null || echo "PARSE_FAIL")
  log_info "Grouping result: $result_flex_count flex ads returned"

  if [[ "$result_flex_count" == "0" || "$result_flex_count" == "PARSE_FAIL" ]]; then
    local group_error
    group_error=$(echo "$group_result" | jq -r '.error // empty' 2>/dev/null || true)
    [[ -n "$group_error" ]] && log_warn "Grouping error: $group_error"
    local skipped
    skipped=$(echo "$group_result" | jq -r '.skipped_clusters[]? // empty' 2>/dev/null || true)
    [[ -n "$skipped" ]] && log_warn "Skipped clusters: $skipped"
  fi

  echo "$group_result"
}

# ============================================================
# STEP 7: Deploy flex ads to Ready to Post
# ============================================================

deploy_flex_ads() {
  local flex_ads_json="$1"
  local project_id="$2"
  local project_config="$3"
  local batch_id="$4"
  local posting_day="${5:-}"
  local angle_name="${6:-}"

  local flex_count
  flex_count=$(echo "$flex_ads_json" | jq '.flex_ads | length')

  if [[ "$flex_count" -eq 0 ]]; then
    log_warn "No flex ads to deploy"
    return 1
  fi

  # Read project defaults
  local default_campaign
  default_campaign=$(echo "$project_config" | jq -r '.scout_default_campaign // ""')
  local cta
  cta=$(echo "$project_config" | jq -r '.scout_cta // "Shop Now"')
  local display_link
  display_link=$(echo "$project_config" | jq -r '.scout_display_link // ""')
  local facebook_page
  facebook_page=$(echo "$project_config" | jq -r '.scout_facebook_page // ""')
  local destination_url
  destination_url=$(echo "$project_config" | jq -r '.scout_destination_url // ""')
  local duplicate_adset_name
  duplicate_adset_name=$(echo "$project_config" | jq -r '.scout_duplicate_adset_name // ""')
  local project_name
  project_name=$(echo "$project_config" | jq -r '.name // "Unknown"')

  # Check conductor config for default_campaign_id (overrides scout_default_campaign)
  local conductor_config
  conductor_config=$(curl -s "${BACKEND_URL}/api/conductor/config?projectId=${project_id}" \
    -H "Cookie: $(get_session_cookie)" 2>/dev/null) || true
  local conductor_campaign
  conductor_campaign=$(echo "$conductor_config" | jq -r '.default_campaign_id // ""' 2>/dev/null) || true
  if [[ -n "$conductor_campaign" ]]; then
    default_campaign="$conductor_campaign"
  fi

  if [[ -z "$default_campaign" ]]; then
    log_err "No default campaign set for project. Cannot deploy."
    return 1
  fi

  # Deploy each flex ad (each gets its own ad set)
  for i in $(seq 0 $((flex_count - 1))); do
    local flex_ad
    flex_ad=$(echo "$flex_ads_json" | jq ".flex_ads[$i]")

    local angle
    angle=$(echo "$flex_ad" | jq -r '.angle_theme')
    local headlines
    headlines=$(echo "$flex_ad" | jq '[.headlines[].text]')
    local primary_texts
    primary_texts=$(echo "$flex_ad" | jq '[.primary_texts[].text]')
    local image_ids
    image_ids=$(echo "$flex_ad" | jq '.image_ad_ids')
    local image_count
    image_count=$(echo "$flex_ad" | jq '.image_ad_ids | length')
    local headline_count
    headline_count=$(echo "$flex_ad" | jq '.headline_count')
    local primary_text_count
    primary_text_count=$(echo "$flex_ad" | jq '.primary_text_count')
    local meets_minimum
    meets_minimum=$(echo "$flex_ad" | jq -r '.meets_minimum // false')

    # Skip flex ads that don't meet minimum requirements
    if [[ "$meets_minimum" != "true" ]]; then
      log_warn "Flex ad $((i+1)) ($angle) doesn't meet minimum 3 headlines + 3 primary texts. Skipping."
      continue
    fi

    # Use angle_name from batch if available, else use the scoring angle_theme
    local effective_angle="${angle_name:-$angle}"

    # Get the next flex ad number for this angle
    local flex_num=1
    local count_response
    count_response=$(curl -s "${BACKEND_URL}/api/deployments/flex-ads/count?projectId=${project_id}&angleName=$(echo "$effective_angle" | jq -sRr @uri)" \
      -H "Cookie: $(get_session_cookie)" 2>/dev/null) || true
    local existing_count
    existing_count=$(echo "$count_response" | jq -r '.count // 0' 2>/dev/null) || true
    flex_num=$((existing_count + 1))

    # Naming: Ad set = "{Angle} — Flex #{N}", Flex ad = "Flex — {Angle} #{N} (M images)"
    local ad_set_name
    ad_set_name=$(echo "${effective_angle} — Flex #${flex_num}" | tr -d '\n\r')
    local flex_ad_name
    flex_ad_name=$(echo "Flex — ${effective_angle} #${flex_num} (${image_count} images)" | tr -d '\n\r')

    log_info "Deploying: $flex_ad_name ($headline_count headlines, $primary_text_count primary texts)"

    if [[ "$DRY_RUN" == "true" ]]; then
      log_info "[DRY RUN] Would deploy flex ad: $flex_ad_name"
      log_info "  Ad set: $ad_set_name"
      log_info "  Headlines ($headline_count): $(echo "$headlines" | jq -r '.[0]') ..."
      log_info "  Primary texts ($primary_text_count): $(echo "$primary_texts" | jq -r '.[0][:60]') ..."
      log_info "  Images: $image_ids"
      continue
    fi

    # Create ad set for this flex ad
    local ad_set_response
    ad_set_response=$(curl -s -X POST "${BACKEND_URL}/api/deployments/adsets" \
      -H "Content-Type: application/json" \
      -H "Cookie: $(get_session_cookie)" \
      -d "{
        \"campaign_id\": \"${default_campaign}\",
        \"name\": $(echo "$ad_set_name" | jq -Rs .),
        \"project_id\": \"${project_id}\"
      }" 2>/dev/null) || {
      log_err "Failed to create ad set: $ad_set_name"
      continue
    }

    local ad_set_id
    ad_set_id=$(echo "$ad_set_response" | jq -r '.externalId // .id // ""')

    if [[ -z "$ad_set_id" ]]; then
      log_err "Failed to get ad set ID for: $ad_set_name"
      continue
    fi

    # Create flex ad deployment with all defaults
    local deploy_response
    deploy_response=$(curl -s -X POST "${BACKEND_URL}/api/deployments/flex" \
      -H "Content-Type: application/json" \
      -H "Cookie: $(get_session_cookie)" \
      -d "$(jq -n \
        --arg ad_set_id "$ad_set_id" \
        --argjson headlines "$headlines" \
        --argjson primary_texts "$primary_texts" \
        --arg cta "$cta" \
        --arg display_link "$display_link" \
        --arg facebook_page "$facebook_page" \
        --arg destination_url "$destination_url" \
        --arg duplicate_adset_name "$duplicate_adset_name" \
        --argjson image_ad_ids "$image_ids" \
        --arg project_id "$project_id" \
        --arg name "$flex_ad_name" \
        --arg posting_day "${posting_day:-}" \
        --arg angle_name "${effective_angle}" \
        '{
          "ad_set_id": $ad_set_id,
          "name": $name,
          "headlines": $headlines,
          "primary_texts": $primary_texts,
          "cta": $cta,
          "display_link": $display_link,
          "facebook_page": $facebook_page,
          "destination_url": $destination_url,
          "duplicate_adset_name": $duplicate_adset_name,
          "ad_ids": $image_ad_ids,
          "project_id": $project_id,
          "status": "ready",
          "posting_day": $posting_day,
          "angle_name": $angle_name
        }')" 2>/dev/null) || {
      log_err "Failed to deploy flex ad: $flex_ad_name"
      continue
    }

    log_ok "Deployed: $flex_ad_name → Ready to Post ($headline_count headlines × $primary_text_count texts × ${image_count} images)"
  done

  log_ok "All flex ads deployed for: $project_name"
}

# ============================================================
# STEP 8: Mark batch as processed + tag ads
# ============================================================

mark_processed() {
  local batch_id="$1"
  local scored_ads="$2"

  # Mark batch as processed by filter
  curl -s "${CONVEX_URL}/api/mutation" \
    -H "Content-Type: application/json" \
    -d "{
      \"path\": \"batchJobs:patch\",
      \"args\": {
        \"externalId\": \"${batch_id}\",
        \"filter_processed\": true,
        \"filter_processed_at\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"
      }
    }" > /dev/null 2>&1

  if [[ "$TAG_REJECTED" == "true" || "$TAG_WINNERS" == "true" ]]; then
    # Tag individual ads
    local ad_count
    ad_count=$(echo "$scored_ads" | jq 'length')

    for i in $(seq 0 $((ad_count - 1))); do
      local ad_id pass
      ad_id=$(echo "$scored_ads" | jq -r ".[$i].externalId // .[$i]._id // \"\"")
      pass=$(echo "$scored_ads" | jq -r ".[$i].pass // false")
      [[ -z "$ad_id" ]] && continue

      local tag
      if [[ "$pass" == "true" && "$TAG_WINNERS" == "true" ]]; then
        tag="Filter Approved"
      elif [[ "$pass" != "true" && "$TAG_REJECTED" == "true" ]]; then
        tag="Filter Rejected"
      else
        continue
      fi

      # Get current tags, add new tag, update via PATCH
      local current_tags
      current_tags=$(echo "$scored_ads" | jq -r ".[$i].tags // \"[]\"" 2>/dev/null)
      [[ "$current_tags" == "null" || -z "$current_tags" ]] && current_tags="[]"
      local new_tags
      new_tags=$(echo "$current_tags" | jq --arg t "$tag" '. + [$t] | unique' 2>/dev/null || echo "[\"$tag\"]")

      local project_id_for_tag
      project_id_for_tag=$(echo "$scored_ads" | jq -r ".[$i].project_id // \"\"")

      curl -s -X PATCH "${BACKEND_URL}/api/projects/${project_id_for_tag}/ads/${ad_id}/tags" \
        -H "Content-Type: application/json" \
        -H "Cookie: $(get_session_cookie)" \
        -d "{\"tags\": ${new_tags}}" > /dev/null 2>&1
    done
  fi

  log_info "Batch $batch_id marked as processed"
}

# ============================================================
# MAIN: Process a single batch
# ============================================================

process_batch() {
  local batch="$1"
  local batch_id
  batch_id=$(echo "$batch" | jq -r '.externalId // ._id')
  local project_id
  project_id=$(echo "$batch" | jq -r '.project_id')

  # Extract Director metadata (posting_day, angle_name) if present
  local posting_day
  posting_day=$(echo "$batch" | jq -r '.posting_day // ""')
  local angle_name
  angle_name=$(echo "$batch" | jq -r '.angle_name // ""')

  log_info "━━━ Processing batch: $batch_id ━━━"
  if [[ -n "$posting_day" ]]; then
    log_info "Director metadata: posting_day=$posting_day angle=$angle_name"
  fi

  # Get project config
  local project_config
  project_config=$(get_project_config "$project_id")
  local project_name
  project_name=$(echo "$project_config" | jq -r '.name // "Unknown"')

  # Check if Scout is enabled for this project
  local scout_enabled
  scout_enabled=$(echo "$project_config" | jq -r '.scout_enabled // "true"')
  if [[ "$scout_enabled" == "false" ]]; then
    log_info "Dacia Creative Filter disabled for project: $project_name. Skipping."
    mark_processed "$batch_id" "[]"
    return 0
  fi

  log_info "Project: $project_name"

  # Read per-project flex ad daily cap from the Filter's own setting (scout_daily_flex_ads)
  # The Director's daily_flex_target is a separate production goal and does not cap the Filter.
  local project_flex_cap
  project_flex_cap=$(echo "$project_config" | jq -r '.scout_daily_flex_ads // "'"$FLEX_AD_COUNT"'"')
  project_flex_cap=$((project_flex_cap + 0))
  if [[ "$project_flex_cap" -lt 1 ]]; then
    project_flex_cap=$FLEX_AD_COUNT
  fi
  log_info "Filter daily flex cap: $project_flex_cap (from scout_daily_flex_ads)"

  # Check daily cap — count flex ads deployed today for this project from log
  local today_flex_count=0
  if [[ -f "$LOG_FILE" ]]; then
    today_flex_count=$(grep -c "Deployed:.*$project_name\|Deployed flex ad.*$project_name" "$LOG_FILE" 2>/dev/null) || today_flex_count=0
  fi

  local remaining=$((project_flex_cap - today_flex_count))
  if [[ "$remaining" -le 0 ]]; then
    log_info "Daily flex ad cap reached for $project_name ($today_flex_count/$project_flex_cap). Skipping."
    mark_processed "$batch_id" "[]"
    return 0
  fi
  log_info "Flex ad budget: $today_flex_count/$project_flex_cap used today ($remaining remaining)"

  # Get ads from batch
  local ads
  ads=$(get_batch_ads "$batch_id")
  local ad_count
  ad_count=$(echo "$ads" | jq 'length')

  if [[ "$ad_count" -eq 0 ]]; then
    log_warn "No ads in batch $batch_id"
    mark_processed "$batch_id" "[]"
    return 0
  fi

  log_info "Found $ad_count ads to evaluate"

  # Get top performers for comparison
  local top_performers
  top_performers=$(get_top_performers "$project_id")

  # Score all ads
  local scored_ads
  scored_ads=$(score_batch_ads "$ads" "$top_performers")

  # Group into flex ads (use remaining count as cap)
  local flex_result
  flex_result=$(group_into_flex_ads "$scored_ads" "$project_name" "$remaining")

  local flex_count
  flex_count=$(echo "$flex_result" | jq '.flex_ads | length' 2>/dev/null || echo 0)
  log_info "Post-grouping flex_count: $flex_count"

  # === PLANNER-QUALITY COPY GENERATION ===
  # For each flex ad, generate fresh primary text + headlines using the same
  # system the Planner uses (Claude Sonnet 4.6 + foundational docs + exact prompts).
  # This replaces the old regeneration loop that had thin context.

  if [[ "$flex_count" -gt 0 ]]; then
    flex_result=$(generate_planner_copy "$flex_result" "$project_id" "$scored_ads")
    flex_count=$(echo "$flex_result" | jq '.flex_ads | length' 2>/dev/null || echo 0)
    log_info "Post-copy-generation flex_count: $flex_count"
  else
    log_warn "No flex ads from grouping — skipping copy generation and deployment"
  fi

  if [[ "$flex_count" -gt 0 && "$AUTO_DEPLOY" == "true" ]]; then
    deploy_flex_ads "$flex_result" "$project_id" "$project_config" "$batch_id" "$posting_day" "$angle_name"

    local total_deployed=$((flex_count * IMAGES_PER_FLEX))
    send_notification "🎯 Dacia Creative Filter: Flex Ads Deployed" \
      "Project: $project_name\n${flex_count} flex ads → Ready to Post\nReview and launch when ready."
  fi

  mark_processed "$batch_id" "$scored_ads"

  # Trigger learning step if this batch has an angle_name (Director-managed)
  if [[ -n "$angle_name" ]]; then
    log_info "Triggering learning step for angle: $angle_name"
    # Build scored ads payload for the learning endpoint
    local learn_payload
    learn_payload=$(echo "$scored_ads" | jq --arg pid "$project_id" --arg aname "$angle_name" \
      '{projectId: $pid, angleName: $aname, scoredAds: [.[] | {ad_id: .ad_id, score: (.score // 0), reasoning: (.reasoning // ""), headline: (.headline // ""), body: (.body // ""), image_prompt: (.image_prompt // "")}]}')
    curl -s -X POST "${BACKEND_URL}/api/conductor/learn" \
      -H "Content-Type: application/json" \
      -H "Cookie: $(get_session_cookie)" \
      -d "$learn_payload" > /dev/null 2>&1 && \
      log_ok "Learning step triggered for angle: $angle_name" || \
      log_warn "Learning step call failed (non-critical)"
  fi

  log_ok "Batch $batch_id processing complete"
}

# ============================================================
# PLANNER-QUALITY COPY GENERATION
# ============================================================
# Calls the backend API to generate primary texts and headlines
# using the exact same system as the Planner (Claude Sonnet 4.6
# + foundational docs + Planner prompts). Replaces group.sh's
# copy selections with freshly generated Planner-quality copy.
# ============================================================

generate_planner_copy() {
  local flex_result="$1"
  local project_id="$2"
  local scored_ads="$3"

  local flex_count
  flex_count=$(echo "$flex_result" | jq '.flex_ads | length')

  for i in $(seq 0 $((flex_count - 1))); do
    local flex_ad
    flex_ad=$(echo "$flex_result" | jq ".flex_ads[$i]")
    local angle
    angle=$(echo "$flex_ad" | jq -r '.angle_theme')
    local image_ids
    image_ids=$(echo "$flex_ad" | jq '.image_ad_ids')

    log_info "Generating Planner-quality copy for flex ad $((i+1)): $angle"

    # Build ad_creatives from the selected image ads
    local ad_creatives="[]"
    local ad_id
    for ad_id in $(echo "$image_ids" | jq -r '.[]'); do
      local ad
      ad=$(echo "$scored_ads" | jq --arg id "$ad_id" '[.[] | select(.externalId == $id or ._id == $id)] | .[0] // empty')
      if [[ -n "$ad" && "$ad" != "null" ]]; then
        local creative
        creative=$(echo "$ad" | jq '{headline: (.headline // ""), body_copy: (.body_copy // ""), angle: (.angle // "")}')
        ad_creatives=$(echo "$ad_creatives" | jq --argjson c "$creative" '. + [$c]')
      fi
    done

    # Call backend API to generate copy with Planner prompts + foundational docs
    local response
    response=$(curl -s --max-time 120 -X POST "${BACKEND_URL}/api/deployments/filter/generate-copy" \
      -H "Content-Type: application/json" \
      -H "Cookie: $(get_session_cookie)" \
      -d "$(jq -n \
        --arg project_id "$project_id" \
        --arg angle_theme "$angle" \
        --argjson ad_creatives "$ad_creatives" \
        '{project_id: $project_id, angle_theme: $angle_theme, ad_creatives: $ad_creatives}')" 2>/dev/null) || {
      log_warn "  API call failed for flex ad $((i+1)). Keeping original copy."
      continue
    }

    # Check for API error
    local api_error
    api_error=$(echo "$response" | jq -r '.error // empty' 2>/dev/null)
    if [[ -n "$api_error" ]]; then
      log_warn "  API error: $api_error. Keeping original copy."
      continue
    fi

    # Extract results
    local new_primary_texts
    new_primary_texts=$(echo "$response" | jq '.primary_texts // []' 2>/dev/null)
    local new_headlines
    new_headlines=$(echo "$response" | jq '.headlines // []' 2>/dev/null)
    local pt_count
    pt_count=$(echo "$new_primary_texts" | jq 'length' 2>/dev/null || echo 0)
    local hl_count
    hl_count=$(echo "$new_headlines" | jq 'length' 2>/dev/null || echo 0)

    if [[ "$pt_count" -ge 3 && "$hl_count" -ge 3 ]]; then
      # Replace copy in flex ad with Planner-generated copy
      flex_ad=$(echo "$flex_ad" | jq \
        --argjson pts "$new_primary_texts" \
        --argjson hls "$new_headlines" \
        --argjson ptc "$pt_count" \
        --argjson hlc "$hl_count" \
        '.primary_texts = [$pts[] | {text: ., source_ad_id: "planner-generated", first_line_hook_strong: true, has_cta_at_end: true, spelling_clean: true}] |
         .headlines = [$hls[] | {text: ., source_ad_id: "planner-generated", spelling_clean: true}] |
         .primary_text_count = $ptc |
         .headline_count = $hlc |
         .meets_minimum = true')

      add_spend 8 "planner_copy_generation" "claude-sonnet-4-6" "anthropic"  # ~$0.06-0.08 for 2 LLM calls

      log_ok "  Generated Planner-quality copy: $hl_count headlines, $pt_count primary texts"
    else
      log_warn "  Copy generation returned insufficient results ($hl_count headlines, $pt_count texts). Keeping original."
    fi

    flex_result=$(echo "$flex_result" | jq --argjson fa "$flex_ad" ".flex_ads[$i] = \$fa")
  done

  # Remove any flex ads that don't meet minimums (shouldn't happen with Planner generation, but safety check)
  local before_count
  before_count=$(echo "$flex_result" | jq '.flex_ads | length')
  flex_result=$(echo "$flex_result" | jq '.flex_ads = [.flex_ads[] | select(.meets_minimum == true)]')
  local after_count
  after_count=$(echo "$flex_result" | jq '.flex_ads | length')

  if [[ "$after_count" -lt "$before_count" ]]; then
    log_warn "Removed $((before_count - after_count)) flex ad(s) that couldn't meet copy minimums"
  fi

  echo "$flex_result"
}

# ============================================================
# REGENERATION LOOP (LEGACY — kept as backup, no longer called)
# ============================================================
# Ensures every flex ad has at least HEADLINES_MIN headlines
# and PRIMARY_TEXTS_MIN primary texts. Regenerates and validates
# copy until minimums are met or MAX_REGEN_ROUNDS is hit.
# ============================================================

MAX_REGEN_ROUNDS=3

regeneration_loop() {
  local flex_result="$1"
  local top_performers="$2"
  local project_name="$3"

  local flex_count
  flex_count=$(echo "$flex_result" | jq '.flex_ads | length')

  for i in $(seq 0 $((flex_count - 1))); do
    local flex_ad
    flex_ad=$(echo "$flex_result" | jq ".flex_ads[$i]")
    local angle
    angle=$(echo "$flex_ad" | jq -r '.angle_theme')

    log_info "Checking copy completeness for flex ad $((i+1)): $angle"

    # --- HEADLINE REGENERATION ---
    local headline_count
    headline_count=$(echo "$flex_ad" | jq '.headlines | length')

    local regen_round=0
    while [[ "$headline_count" -lt "$HEADLINES_MIN" && "$regen_round" -lt "$MAX_REGEN_ROUNDS" ]]; do
      check_budget || break
      regen_round=$((regen_round + 1))
      local needed=$((HEADLINES_TARGET - headline_count))
      [[ "$needed" -lt 1 ]] && needed=1

      log_info "  Headlines: $headline_count/${HEADLINES_MIN} min (${HEADLINES_TARGET} target). Regenerating $needed... (round $regen_round/$MAX_REGEN_ROUNDS)"

      local existing_headlines
      existing_headlines=$(echo "$flex_ad" | jq '[.headlines[].text]')

      # Generate new headlines
      local new_headlines
      new_headlines=$(bash "${SCRIPT_DIR}/agents/regenerate.sh" \
        "headlines" "$needed" "$angle" "$existing_headlines" "$top_performers" "$project_name")
      add_spend 4 "headline_regen" "$SCORE_MODEL" "anthropic"  # ~$0.04

      # Validate them
      local candidates
      candidates=$(echo "$new_headlines" | jq '[.headlines[].text]' 2>/dev/null || echo "[]")
      local candidate_count
      candidate_count=$(echo "$candidates" | jq 'length')

      if [[ "$candidate_count" -gt 0 ]]; then
        local validation
        validation=$(bash "${SCRIPT_DIR}/agents/validate.sh" "headlines" "$candidates" "$angle")
        add_spend 1 "headline_validation" "$SCORE_MODEL" "anthropic"  # ~$0.01

        # Add passing headlines to the flex ad
        local passing
        passing=$(echo "$validation" | jq '[.results[] | select(.pass == true)]' 2>/dev/null || echo "[]")
        local pass_count
        pass_count=$(echo "$passing" | jq 'length')

        if [[ "$pass_count" -gt 0 ]]; then
          # Merge new headlines into flex ad
          for j in $(seq 0 $((pass_count - 1))); do
            local new_hl_text
            new_hl_text=$(echo "$passing" | jq -r ".[$j].text")
            local new_hl_obj
            new_hl_obj=$(jq -n --arg text "$new_hl_text" '{text: $text, source_ad_id: "regenerated", spelling_clean: true}')
            flex_ad=$(echo "$flex_ad" | jq --argjson hl "$new_hl_obj" '.headlines += [$hl]')
          done
          log_info "  +$pass_count headlines passed validation"
        else
          log_warn "  Regenerated headlines all failed validation"
        fi
      fi

      headline_count=$(echo "$flex_ad" | jq '.headlines | length')
    done

    # --- PRIMARY TEXT REGENERATION ---
    local pt_count
    pt_count=$(echo "$flex_ad" | jq '.primary_texts | length')

    regen_round=0
    while [[ "$pt_count" -lt "$PRIMARY_TEXTS_MIN" && "$regen_round" -lt "$MAX_REGEN_ROUNDS" ]]; do
      check_budget || break
      regen_round=$((regen_round + 1))
      local needed=$((PRIMARY_TEXTS_TARGET - pt_count))
      [[ "$needed" -lt 1 ]] && needed=1

      log_info "  Primary texts: $pt_count/${PRIMARY_TEXTS_MIN} min (${PRIMARY_TEXTS_TARGET} target). Regenerating $needed... (round $regen_round/$MAX_REGEN_ROUNDS)"

      local existing_pts
      existing_pts=$(echo "$flex_ad" | jq '[.primary_texts[].text]')

      # Generate new primary texts
      local new_pts
      new_pts=$(bash "${SCRIPT_DIR}/agents/regenerate.sh" \
        "primary_texts" "$needed" "$angle" "$existing_pts" "$top_performers" "$project_name")
      add_spend 4 "text_regen" "$SCORE_MODEL" "anthropic"  # ~$0.04

      # Validate them
      local candidates
      candidates=$(echo "$new_pts" | jq '[.primary_texts[].text]' 2>/dev/null || echo "[]")
      local candidate_count
      candidate_count=$(echo "$candidates" | jq 'length')

      if [[ "$candidate_count" -gt 0 ]]; then
        local validation
        validation=$(bash "${SCRIPT_DIR}/agents/validate.sh" "primary_texts" "$candidates" "$angle")
        add_spend 1 "text_validation" "$SCORE_MODEL" "anthropic"  # ~$0.01

        local passing
        passing=$(echo "$validation" | jq '[.results[] | select(.pass == true)]' 2>/dev/null || echo "[]")
        local pass_count
        pass_count=$(echo "$passing" | jq 'length')

        if [[ "$pass_count" -gt 0 ]]; then
          for j in $(seq 0 $((pass_count - 1))); do
            local new_pt_text
            new_pt_text=$(echo "$passing" | jq -r ".[$j].text")
            local new_pt_obj
            new_pt_obj=$(jq -n --arg text "$new_pt_text" '{text: $text, source_ad_id: "regenerated", first_line_hook_strong: true, has_cta_at_end: true, spelling_clean: true}')
            flex_ad=$(echo "$flex_ad" | jq --argjson pt "$new_pt_obj" '.primary_texts += [$pt]')
          done
          log_info "  +$pass_count primary texts passed validation"
        else
          log_warn "  Regenerated primary texts all failed validation"
        fi
      fi

      pt_count=$(echo "$flex_ad" | jq '.primary_texts | length')
    done

    # --- UPDATE COUNTS AND CHECK MINIMUMS ---
    headline_count=$(echo "$flex_ad" | jq '.headlines | length')
    pt_count=$(echo "$flex_ad" | jq '.primary_texts | length')

    # Cap at target (trim extras, keep highest quality)
    if [[ "$headline_count" -gt "$HEADLINES_TARGET" ]]; then
      flex_ad=$(echo "$flex_ad" | jq ".headlines = .headlines[:${HEADLINES_TARGET}]")
      headline_count=$HEADLINES_TARGET
    fi
    if [[ "$pt_count" -gt "$PRIMARY_TEXTS_TARGET" ]]; then
      flex_ad=$(echo "$flex_ad" | jq ".primary_texts = .primary_texts[:${PRIMARY_TEXTS_TARGET}]")
      pt_count=$PRIMARY_TEXTS_TARGET
    fi

    # Update counts
    flex_ad=$(echo "$flex_ad" | jq \
      --argjson hc "$headline_count" \
      --argjson ptc "$pt_count" \
      '.headline_count = $hc | .primary_text_count = $ptc | .meets_minimum = ($hc >= 3 and $ptc >= 3)')

    local meets
    meets=$(echo "$flex_ad" | jq -r '.meets_minimum')

    if [[ "$meets" == "true" ]]; then
      log_ok "  Flex ad $((i+1)) complete: $headline_count headlines, $pt_count primary texts ✓"
    else
      log_err "  Flex ad $((i+1)) still short after $MAX_REGEN_ROUNDS rounds: $headline_count headlines, $pt_count primary texts"
    fi

    # Write updated flex ad back
    flex_result=$(echo "$flex_result" | jq --argjson fa "$flex_ad" ".flex_ads[$i] = \$fa")
  done

  # Remove any flex ads that still don't meet minimums
  local before_count
  before_count=$(echo "$flex_result" | jq '.flex_ads | length')
  flex_result=$(echo "$flex_result" | jq '.flex_ads = [.flex_ads[] | select(.meets_minimum == true)]')
  local after_count
  after_count=$(echo "$flex_result" | jq '.flex_ads | length')

  if [[ "$after_count" -lt "$before_count" ]]; then
    log_warn "Removed $((before_count - after_count)) flex ad(s) that couldn't meet copy minimums after regeneration"
  fi

  echo "$flex_result"
}

# ============================================================
# STATUS
# ============================================================

show_status() {
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BLUE}  DACIA CREATIVE FILTER — Recursive Agent #2  ${NC}"
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo "Date:    $TODAY"
  echo "Budget:  ${DAILY_BUDGET_CENTS}¢/day (\$$(echo "scale=2; $DAILY_BUDGET_CENTS / 100" | bc)/day)"
  echo "Spent:   $(get_daily_spend)¢"
  echo "Log:     $LOG_FILE"
  echo ""
  if [[ -f "$LOG_FILE" ]]; then
    local batches_processed; batches_processed=$(grep -c "processing complete" "$LOG_FILE" 2>/dev/null || echo 0)
    local ads_scored; ads_scored=$(grep -c "PASS\|FAIL" "$LOG_FILE" 2>/dev/null || echo 0)
    local ads_passed; ads_passed=$(grep -c "✓ PASS" "$LOG_FILE" 2>/dev/null || echo 0)
    local ads_failed; ads_failed=$(grep -c "✗ FAIL" "$LOG_FILE" 2>/dev/null || echo 0)
    local flex_deployed; flex_deployed=$(grep -c "Deployed flex ad" "$LOG_FILE" 2>/dev/null || echo 0)

    echo "Batches processed: $batches_processed"
    echo "Ads scored:        $ads_scored"
    echo -e "  Passed:          ${GREEN}$ads_passed${NC}"
    echo -e "  Failed:          ${RED}$ads_failed${NC}"
    echo -e "Flex ads deployed: ${MAGENTA}$flex_deployed${NC}"
  fi
  echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

# ============================================================
# ENTRY POINT
# ============================================================

main() {
  acquire_lock
  init_spend_tracker

  # Check pause file — if paused, skip execution (status still works)
  local pause_file="${FILTER_DIR}/.paused"
  if [[ -f "$pause_file" ]] && [[ "${1:-}" != "--status" ]]; then
    log_info "Dacia Creative Filter is PAUSED (${pause_file} exists). Skipping run."
    exit 0
  fi

  case "${1:-}" in
    --status)  show_status; exit 0 ;;
    --dry-run) DRY_RUN=true; log_info "DRY RUN MODE" ;;
    --daemon)
      log_info "Dacia Creative Filter starting (interval: ${CHECK_INTERVAL}s)"
      while true; do
        local batches
        batches=$(get_unprocessed_batches)
        local count
        count=$(echo "$batches" | jq 'length' 2>/dev/null || echo 0)

        if [[ "$count" -gt 0 ]]; then
          log_info "Found $count unprocessed batch(es)"
          for i in $(seq 0 $((count - 1))); do
            local batch
            batch=$(echo "$batches" | jq ".[$i]")
            process_batch "$batch" || true
          done
        else
          log_info "No unprocessed batches"
        fi

        sleep "$CHECK_INTERVAL"
      done
      ;;
    *)
      local batches
      batches=$(get_unprocessed_batches)
      local count
      count=$(echo "$batches" | jq 'length' 2>/dev/null || echo 0)

      if [[ "$count" -gt 0 ]]; then
        for i in $(seq 0 $((count - 1))); do
          local batch
          batch=$(echo "$batches" | jq ".[$i]")
          process_batch "$batch" || true
        done
      else
        log_info "No unprocessed batches to filter"
      fi
      ;;
  esac
}

main "$@"

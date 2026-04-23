import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  settings: defineTable({
    key: v.string(),
    value: v.string(),
  }).index("by_key", ["key"]),

  projects: defineTable({
    externalId: v.string(),
    name: v.string(),
    brand_name: v.optional(v.string()),
    niche: v.optional(v.string()),
    product_description: v.optional(v.string()),
    drive_folder_id: v.optional(v.string()),
    inspiration_folder_id: v.optional(v.string()),
    prompt_guidelines: v.optional(v.string()),
    product_image_storageId: v.optional(v.id("_storage")),
    docCount: v.optional(v.float64()),
    adCount: v.optional(v.float64()),
    lpCount: v.optional(v.float64()),
    lpPublishedCount: v.optional(v.float64()),
    status: v.optional(v.string()),
    // Dacia Creative Filter (Recursive Agent #2) — per-project config
    scout_enabled: v.optional(v.boolean()),
    scout_default_campaign: v.optional(v.string()),
    scout_cta: v.optional(v.string()),
    scout_display_link: v.optional(v.string()),
    scout_facebook_page: v.optional(v.string()),
    scout_score_threshold: v.optional(v.number()),
    scout_daily_flex_ads: v.optional(v.number()),  // Max flex ads/day from Creative Filter (default 2)
    scout_destination_url: v.optional(v.string()),        // Default website/landing page URL (legacy single)
    scout_destination_urls: v.optional(v.string()),       // JSON array of default LP URLs (overrides single)
    scout_duplicate_adset_name: v.optional(v.string()),   // Default "duplicate this ad set" name for Meta
    created_at: v.string(),
    updated_at: v.string(),
  }).index("by_externalId", ["externalId"]),

  foundational_docs: defineTable({
    externalId: v.string(),
    project_id: v.string(), // references projects.externalId
    doc_type: v.string(),
    content: v.optional(v.string()),
    version: v.number(),
    approved: v.boolean(),
    source: v.optional(v.string()),
    created_at: v.string(),
    updated_at: v.string(),
  })
    .index("by_externalId", ["externalId"])
    .index("by_project", ["project_id"])
    .index("by_project_and_type", ["project_id", "doc_type"]),

  template_images: defineTable({
    externalId: v.string(),
    project_id: v.string(),
    filename: v.string(),
    storageId: v.optional(v.id("_storage")),
    description: v.optional(v.string()),
    analysis: v.optional(v.string()),
    created_at: v.string(),
  })
    .index("by_externalId", ["externalId"])
    .index("by_project", ["project_id"]),

  ad_creatives: defineTable({
    externalId: v.string(),
    project_id: v.string(),
    generation_mode: v.string(),
    angle: v.optional(v.string()),
    angle_name: v.optional(v.string()),
    headline: v.optional(v.string()),
    body_copy: v.optional(v.string()),
    hook_lane: v.optional(v.string()),
    core_claim: v.optional(v.string()),
    target_symptom: v.optional(v.string()),
    emotional_entry: v.optional(v.string()),
    desired_belief_shift: v.optional(v.string()),
    opening_pattern: v.optional(v.string()),
    scoring_mode: v.optional(v.string()),
    copy_render_expectation: v.optional(v.string()),
    product_expectation: v.optional(v.string()),
    image_prompt: v.optional(v.string()),
    gpt_creative_output: v.optional(v.string()),
    template_image_id: v.optional(v.string()),
    inspiration_image_id: v.optional(v.string()),
    storageId: v.optional(v.id("_storage")),
    thumbnailStorageId: v.optional(v.id("_storage")),
    drive_file_id: v.optional(v.string()),
    drive_url: v.optional(v.string()),
    aspect_ratio: v.optional(v.string()),
    status: v.optional(v.string()),
    auto_generated: v.optional(v.boolean()),
    parent_ad_id: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    is_favorite: v.optional(v.boolean()),    // Heart/favorite toggle in gallery
    batch_job_id: v.optional(v.string()),    // → batch_jobs.externalId (batch that generated this ad)
    copy_framework: v.optional(v.string()),  // Legacy: from removed diversity features
    sub_angle: v.optional(v.string()),       // Secondary variation label within a hook lane
    text_model: v.optional(v.string()),      // LLM used for copy (e.g., "gpt-5.2")
    image_model: v.optional(v.string()),     // Model used for image (e.g., "gemini-3-pro")
    created_at: v.string(),
  })
    .index("by_externalId", ["externalId"])
    .index("by_project", ["project_id"])
    .index("by_batch_job", ["batch_job_id"])
    .index("by_project_and_angle_name", ["project_id", "angle_name"]),

  headline_history: defineTable({
    externalId: v.string(),
    project_id: v.string(),
    angle_name: v.string(),
    batch_job_id: v.optional(v.string()),
    conductor_run_id: v.optional(v.string()),
    ad_creative_id: v.optional(v.string()),
    headline_text: v.string(),
    normalized_headline: v.string(),
    hook_lane: v.optional(v.string()),
    sub_angle: v.optional(v.string()),
    core_claim: v.optional(v.string()),
    target_symptom: v.optional(v.string()),
    emotional_entry: v.optional(v.string()),
    desired_belief_shift: v.optional(v.string()),
    opening_pattern: v.optional(v.string()),
    created_at: v.string(),
  })
    .index("by_externalId", ["externalId"])
    .index("by_project_and_angle", ["project_id", "angle_name"])
    .index("by_project_angle_and_created_at", ["project_id", "angle_name", "created_at"])
    .index("by_batch_job", ["batch_job_id"])
    .index("by_run", ["conductor_run_id"]),

  batch_jobs: defineTable({
    externalId: v.string(),
    project_id: v.string(),
    generation_mode: v.string(),
    batch_size: v.number(),
    angle: v.optional(v.string()),
    angles: v.optional(v.string()),  // JSON array of angles for multi-angle batches
    aspect_ratio: v.optional(v.string()),
    template_image_id: v.optional(v.string()),
    template_image_ids: v.optional(v.string()),      // JSON array of uploaded template IDs (multi-select)
    inspiration_image_id: v.optional(v.string()),
    inspiration_image_ids: v.optional(v.string()),    // JSON array of drive template IDs (multi-select)
    product_image_storageId: v.optional(v.id("_storage")),
    gemini_batch_job: v.optional(v.nullable(v.string())),
    gpt_prompts: v.optional(v.nullable(v.string())),
    status: v.optional(v.string()),
    scheduled: v.optional(v.boolean()),
    schedule_cron: v.optional(v.string()),
    error_message: v.optional(v.nullable(v.string())),
    completed_count: v.optional(v.number()),
    failed_count: v.optional(v.number()),
    run_count: v.optional(v.number()),
    retry_count: v.optional(v.number()),
    stale_detected_at: v.optional(v.nullable(v.string())),
    used_template_ids: v.optional(v.string()),  // JSON array of template IDs used across runs
    batch_stats: v.optional(v.nullable(v.string())),
    pipeline_state: v.optional(v.string()),  // JSON: { stage, brief_packet, headlines, body_copies }
    filter_assigned: v.optional(v.boolean()),      // Opt-in: batch assigned to Creative Filter
    filter_processed: v.optional(v.boolean()),    // Dacia Creative Filter has evaluated this batch
    filter_processed_at: v.optional(v.string()),  // When filter processed it
    // Dacia Creative Director fields
    posting_day: v.optional(v.string()),           // YYYY-MM-DD posting day this batch produces ads for
    conductor_run_id: v.optional(v.string()),      // → conductor_runs.externalId that created this batch
    angle_name: v.optional(v.string()),            // Which angle this batch targets
    angle_prompt: v.optional(v.string()),          // Full angle prompt injected into generation
    angle_brief: v.optional(v.string()),           // JSON: structured angle brief for downstream use
    flex_ad_id: v.optional(v.string()),            // → flex_ads.externalId linked to this batch's winning output
    // LP auto-generation tracking
    lp_primary_id: v.optional(v.string()),           // → landing_pages.externalId
    lp_primary_url: v.optional(v.string()),          // Published URL
    lp_primary_status: v.optional(v.string()),       // generating | published | live | failed
    lp_primary_error: v.optional(v.string()),
    lp_primary_retry_count: v.optional(v.float64()),
    lp_secondary_id: v.optional(v.string()),         // → landing_pages.externalId
    lp_secondary_url: v.optional(v.string()),
    lp_secondary_status: v.optional(v.string()),
    lp_secondary_error: v.optional(v.string()),
    lp_secondary_retry_count: v.optional(v.float64()),
    lp_narrative_frames: v.optional(v.string()),     // JSON array of narrative frame IDs
    gauntlet_lp_urls: v.optional(v.string()),        // JSON: [{ frame, frameName, url, score }]
    created_at: v.string(),
    started_at: v.optional(v.string()),
    completed_at: v.optional(v.string()),
  })
    .index("by_externalId", ["externalId"])
    .index("by_project", ["project_id"])
    .index("by_status", ["status"])
    .index("by_scheduled", ["scheduled"]),

  api_costs: defineTable({
    externalId: v.string(),
    project_id: v.optional(v.string()),
    service: v.string(),
    operation: v.optional(v.string()),
    cost_usd: v.number(),
    rate_used: v.optional(v.number()),
    image_count: v.optional(v.number()),
    resolution: v.optional(v.string()),
    source: v.optional(v.string()),
    period_date: v.string(),
    created_at: v.string(),
  })
    .index("by_externalId", ["externalId"])
    .index("by_period", ["period_date"])
    .index("by_project_and_period", ["project_id", "period_date"])
    .index("by_source_and_period", ["source", "period_date"]),

  campaigns: defineTable({
    externalId: v.string(),
    project_id: v.string(),      // → projects.externalId
    name: v.string(),
    sort_order: v.number(),
    created_at: v.string(),
    updated_at: v.string(),
  })
    .index("by_externalId", ["externalId"])
    .index("by_project", ["project_id"]),

  ad_sets: defineTable({
    externalId: v.string(),
    campaign_id: v.string(),     // → campaigns.externalId
    project_id: v.string(),      // → projects.externalId (denormalized)
    name: v.string(),
    sort_order: v.number(),
    created_at: v.string(),
    updated_at: v.string(),
  })
    .index("by_externalId", ["externalId"])
    .index("by_campaign", ["campaign_id"])
    .index("by_project", ["project_id"]),

  flex_ads: defineTable({
    externalId: v.string(),
    project_id: v.string(),                     // → projects.externalId
    ad_set_id: v.optional(v.string()),          // → ad_sets.externalId (optional — CF fork has no pre-seeded ad sets)
    name: v.string(),
    child_deployment_ids: v.string(),            // JSON string array of deployment externalIds
    primary_texts: v.optional(v.string()),       // JSON string array (up to 5)
    headlines: v.optional(v.string()),           // JSON string array (up to 5)
    destination_url: v.optional(v.string()),
    display_link: v.optional(v.string()),        // Display link (shown instead of destination URL)
    cta_button: v.optional(v.string()),          // Meta CTA type
    facebook_page: v.optional(v.string()),       // Facebook Page name to post from
    planned_date: v.optional(v.string()),        // ISO datetime for scheduled posting
    posted_by: v.optional(v.string()),           // Who will post this ad (e.g. "Corinne", "Liz")
    duplicate_adset_name: v.optional(v.string()), // Name for the duplicated ad set in Ads Manager
    notes: v.optional(v.string()),               // Free-text notes for poster employees
    // Dacia Creative Director fields
    posting_day: v.optional(v.string()),           // YYYY-MM-DD posting day this flex ad is for
    angle_name: v.optional(v.string()),            // Inherited from batch that produced its ads
    // LP URLs for auto-generated landing pages
    lp_primary_url: v.optional(v.string()),
    lp_secondary_url: v.optional(v.string()),
    // Gauntlet LP URLs
    gauntlet_lp_urls: v.optional(v.string()),         // JSON: [{ frame, url, score }]
    destination_urls_used: v.optional(v.string()),     // JSON: [0, 2, 5] — indices of copied URLs
    created_at: v.string(),
    updated_at: v.string(),
    deleted_at: v.optional(v.string()),           // ISO timestamp for soft delete
  })
    .index("by_externalId", ["externalId"])
    .index("by_project", ["project_id"])
    .index("by_ad_set", ["ad_set_id"]),

  ad_deployments: defineTable({
    externalId: v.string(),
    ad_id: v.string(),           // → ad_creatives.externalId
    project_id: v.string(),      // → projects.externalId
    status: v.string(),          // selected | scheduled | posted | analyzing
    campaign_name: v.optional(v.string()),
    ad_set_name: v.optional(v.string()),
    ad_name: v.optional(v.string()),
    landing_page_url: v.optional(v.string()),
    notes: v.optional(v.string()),
    planned_date: v.optional(v.string()),
    posted_date: v.optional(v.string()),
    meta_campaign_id: v.optional(v.string()),
    meta_adset_id: v.optional(v.string()),
    meta_ad_id: v.optional(v.string()),
    local_campaign_id: v.optional(v.string()),  // → campaigns.externalId or "unplanned"
    local_adset_id: v.optional(v.string()),     // → ad_sets.externalId
    flex_ad_id: v.optional(v.string()),          // → flex_ads.externalId
    primary_texts: v.optional(v.string()),       // JSON array of primary text strings
    ad_headlines: v.optional(v.string()),         // JSON array of headline strings
    destination_url: v.optional(v.string()),      // Meta destination URL
    display_link: v.optional(v.string()),         // Display link (shown instead of destination URL)
    cta_button: v.optional(v.string()),           // Meta CTA type (SHOP_NOW, LEARN_MORE, etc.)
    facebook_page: v.optional(v.string()),        // Facebook Page name to post from
    posted_by: v.optional(v.string()),            // Who will post this ad (e.g. "Corinne", "Liz")
    duplicate_adset_name: v.optional(v.string()), // Name for the duplicated ad set in Ads Manager
    created_at: v.string(),
    deleted_at: v.optional(v.string()),           // ISO timestamp for soft delete
  })
    .index("by_externalId", ["externalId"])
    .index("by_ad_id", ["ad_id"])
    .index("by_status", ["status"])
    .index("by_project", ["project_id"]),

  inspiration_images: defineTable({
    project_id: v.string(),
    drive_file_id: v.string(),
    filename: v.string(),
    mimeType: v.optional(v.string()),
    storageId: v.optional(v.id("_storage")),
    thumbnailStorageId: v.optional(v.id("_storage")),
    modifiedTime: v.optional(v.string()),
    size: v.optional(v.number()),
  })
    .index("by_project", ["project_id"])
    .index("by_project_and_drive_id", ["project_id", "drive_file_id"]),

  correction_history: defineTable({
    externalId: v.string(),
    project_id: v.string(),        // → projects.externalId
    correction: v.string(),        // user instruction or "Manual edit to X"
    timestamp: v.string(),         // ISO 8601
    manual: v.optional(v.boolean()),
    changes: v.string(),           // JSON array of change objects
  })
    .index("by_externalId", ["externalId"])
    .index("by_project", ["project_id"]),

  dashboard_todos: defineTable({
    externalId: v.string(),
    text: v.string(),
    done: v.boolean(),
    author: v.optional(v.string()),
    notes: v.optional(v.string()),
    priority: v.optional(v.number()),
    sort_order: v.number(),
  })
    .index("by_externalId", ["externalId"]),


  // =============================================
  // Dacia Creative Director — Agent Team tables
  // =============================================

  conductor_config: defineTable({
    project_id: v.string(),              // → projects.externalId
    enabled: v.boolean(),
    daily_flex_target: v.number(),       // flex ads per day (1-20, default 5)
    ads_per_batch: v.number(),           // raw ads per batch (default 18)
    angle_mode: v.string(),             // "manual" | "auto" | "mixed"
    explore_ratio: v.number(),           // for mixed mode, % testing new angles (0.0-1.0)
    angle_rotation: v.string(),         // "round_robin" | "weighted" | "random"
    headline_style: v.optional(v.string()),      // freeform prompt guidance
    primary_text_style: v.optional(v.string()),  // freeform prompt guidance
    meta_campaign_name: v.optional(v.string()),  // default campaign name template
    meta_adset_defaults: v.optional(v.string()), // JSON: default adset settings
    default_campaign_id: v.optional(v.string()),  // → campaigns.externalId for auto-deployed flex ads
    run_schedule: v.string(),           // "daily" | "weekdays" | "weekly_monday" | "custom" | "manual_only"
    run_schedule_days: v.optional(v.string()),   // JSON array of day numbers (0=Sun...6=Sat) for custom schedule
    run_schedule_hour: v.optional(v.number()),   // Hour in ICT (0-23) for custom schedule, default 0
    last_planning_run: v.optional(v.number()),   // timestamp
    last_verify_run: v.optional(v.number()),     // timestamp
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_project", ["project_id"]),

  conductor_angles: defineTable({
    externalId: v.string(),
    project_id: v.string(),              // → projects.externalId
    name: v.string(),                    // short label
    description: v.string(),             // detailed angle for prompt injection (auto-computed from structured fields)
    prompt_hints: v.optional(v.string()), // specific creative direction
    source: v.string(),                  // "manual" | "imported" | "auto_generated"
    status: v.string(),                  // "active" | "testing" | "archived"
    focused: v.optional(v.boolean()),    // When true + active, Director only uses focused angles
    // Structured creative brief fields
    priority: v.optional(v.string()),    // "highest" | "high" | "medium" | "test"
    frame: v.optional(v.string()),       // "symptom-first" | "scam" | "objection-first" | "identity-first" | "MAHA" | "news-first" | "consequence-first"
    core_buyer: v.optional(v.string()),
    symptom_pattern: v.optional(v.string()),
    failed_solutions: v.optional(v.string()),
    current_belief: v.optional(v.string()),
    objection: v.optional(v.string()),
    emotional_state: v.optional(v.string()),
    scene: v.optional(v.string()),       // "Scene to Center the Ad On"
    desired_belief_shift: v.optional(v.string()),
    tone: v.optional(v.string()),
    avoid_list: v.optional(v.string()),  // "Avoid" — renamed to avoid JS keyword
    destination_urls: v.optional(v.string()), // JSON array of LP URLs for this angle (overrides project default)
    is_system_default: v.optional(v.boolean()), // True for auto-created system angles (e.g., BOF)
    // Operational fields
    times_used: v.number(),
    last_used_at: v.optional(v.number()),
    performance_note: v.optional(v.string()),
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_externalId", ["externalId"])
    .index("by_project", ["project_id"])
    .index("by_project_and_status", ["project_id", "status"]),

  conductor_runs: defineTable({
    externalId: v.string(),
    project_id: v.string(),              // → projects.externalId
    run_type: v.string(),                // "planning" | "verification" | "manual" | "emergency"
    run_at: v.number(),                  // timestamp
    posting_days: v.optional(v.string()), // JSON array of posting day objects checked
    batches_created: v.optional(v.string()), // JSON array of batch info
    angles_generated: v.optional(v.string()), // JSON array of new angles
    decisions: v.optional(v.string()),   // LLM reasoning
    status: v.string(),                  // "completed" | "partial" | "failed"
    error: v.optional(v.string()),
    duration_ms: v.optional(v.number()),
    terminal_status: v.optional(v.string()),
    failure_reason: v.optional(v.string()),
    required_passes: v.optional(v.number()),
    ads_per_round: v.optional(v.number()),
    max_rounds: v.optional(v.number()),
    total_rounds: v.optional(v.number()),
    total_ads_generated: v.optional(v.number()),
    total_ads_scored: v.optional(v.number()),
    total_ads_passed: v.optional(v.number()),
    ready_to_post_count: v.optional(v.number()),
    flex_ad_id: v.optional(v.string()),
    rounds_json: v.optional(v.string()),
    error_stage: v.optional(v.string()),
    created_at: v.number(),
  })
    .index("by_externalId", ["externalId"])
    .index("by_project", ["project_id"]),

  conductor_slots: defineTable({
    externalId: v.string(),
    project_id: v.string(),              // → projects.externalId
    posting_day: v.string(),             // YYYY-MM-DD
    slot_index: v.number(),              // 0-based slot within posting day
    angle_name: v.string(),
    angle_external_id: v.optional(v.string()),
    status: v.string(),                  // "reserved" | "in_progress" | "produced" | "failed" | "abandoned"
    batch_ids: v.optional(v.string()),   // JSON array of batch externalIds
    attempt_count: v.optional(v.number()),
    last_attempt_at: v.optional(v.number()),
    produced_flex_ad_id: v.optional(v.string()),
    failure_reason: v.optional(v.string()),
    diagnostics_summary: v.optional(v.string()), // compact JSON summary for overnight diagnosis
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index("by_externalId", ["externalId"])
    .index("by_project_and_posting_day", ["project_id", "posting_day"])
    .index("by_project_posting_day_and_slot", ["project_id", "posting_day", "slot_index"]),

  conductor_health: defineTable({
    externalId: v.string(),
    agent: v.string(),                   // "creative_director" | "creative_filter"
    check_at: v.number(),                // timestamp
    status: v.string(),                  // "healthy" | "stalled" | "failed" | "recovered"
    details: v.optional(v.string()),
    action_taken: v.optional(v.string()),
    batches_stuck: v.optional(v.number()),
    batches_recovered: v.optional(v.number()),
  })
    .index("by_externalId", ["externalId"])
    .index("by_agent", ["agent"]),

  conductor_playbooks: defineTable({
    project_id: v.string(),              // → projects.externalId
    angle_name: v.string(),              // matches conductor_angles.name
    version: v.number(),
    total_scored: v.number(),
    total_passed: v.number(),
    pass_rate: v.number(),               // 0.0-1.0
    visual_patterns: v.optional(v.string()),
    copy_patterns: v.optional(v.string()),
    avoid_patterns: v.optional(v.string()),
    generation_hints: v.optional(v.string()),
    raw_analysis: v.optional(v.string()),
    last_updated: v.number(),
    created_at: v.number(),
  })
    .index("by_project", ["project_id"])
    .index("by_project_and_angle", ["project_id", "angle_name"]),

  users: defineTable({
    externalId: v.string(),
    username: v.string(),
    display_name: v.string(),
    password_hash: v.string(),
    role: v.string(),              // 'admin' | 'manager' | 'poster'
    is_active: v.boolean(),
    created_by: v.optional(v.string()),
    created_at: v.string(),
    updated_at: v.string(),
  })
    .index("by_externalId", ["externalId"])
    .index("by_username", ["username"]),

  sessions: defineTable({
    sid: v.string(),
    session_data: v.string(),
    expires_at: v.number(),
  })
    .index("by_sid", ["sid"])
    .index("by_expires_at", ["expires_at"]),

  fixer_playbook: defineTable({
    issue_category: v.string(),          // "batch_stuck" | "filter_stalled" | etc.
    occurrences: v.number(),
    last_occurred: v.number(),
    root_causes: v.optional(v.string()),
    resolution_steps: v.optional(v.string()),
    prevention_hints: v.optional(v.string()),
    avg_resolution_ms: v.optional(v.number()),
    auto_resolved: v.number(),
    escalated: v.number(),
    last_updated: v.number(),
  })
    .index("by_category", ["issue_category"]),
});

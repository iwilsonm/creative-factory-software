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
    sales_page_content: v.optional(v.string()),
    drive_folder_id: v.optional(v.string()),
    inspiration_folder_id: v.optional(v.string()),
    prompt_guidelines: v.optional(v.string()),
    product_image_storageId: v.optional(v.id("_storage")),
    docCount: v.optional(v.float64()),
    adCount: v.optional(v.float64()),
    lpCount: v.optional(v.float64()),
    lpPublishedCount: v.optional(v.float64()),
    status: v.optional(v.string()),
    // Meta Ads (per-project — each project has its own Meta App + OAuth)
    meta_app_id: v.optional(v.string()),
    meta_app_secret: v.optional(v.string()),
    meta_access_token: v.optional(v.string()),
    meta_token_expires_at: v.optional(v.string()),
    meta_ad_account_id: v.optional(v.string()),
    meta_user_name: v.optional(v.string()),
    meta_user_id: v.optional(v.string()),
    meta_last_sync_at: v.optional(v.string()),
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
    source_quote_id: v.optional(v.string()), // → quote_bank.externalId (ad created from quote)
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

  lp_headline_history: defineTable({
    externalId: v.string(),
    project_id: v.string(),
    angle_name: v.string(),
    narrative_frame: v.string(),
    landing_page_id: v.optional(v.string()),
    gauntlet_batch_id: v.optional(v.string()),
    headline_text: v.string(),
    subheadline_text: v.optional(v.string()),
    normalized_headline: v.string(),
    headline_signature: v.optional(v.string()),
    created_at: v.string(),
  })
    .index("by_externalId", ["externalId"])
    .index("by_project_angle_frame_and_created_at", ["project_id", "angle_name", "narrative_frame", "created_at"])
    .index("by_project_angle_and_created_at", ["project_id", "angle_name", "created_at"])
    .index("by_landing_page", ["landing_page_id"])
    .index("by_gauntlet_batch", ["gauntlet_batch_id"]),

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
    ad_set_id: v.string(),                      // → ad_sets.externalId
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

  quote_mining_runs: defineTable({
    externalId: v.string(),
    project_id: v.string(),              // → projects.externalId
    status: v.string(),                  // running | completed | failed
    target_demographic: v.string(),
    problem: v.string(),
    root_cause: v.optional(v.string()),
    keywords: v.string(),               // JSON array of keyword strings
    subreddits: v.optional(v.string()), // JSON array of subreddit names
    forums: v.optional(v.string()),     // JSON array of forum URLs/names
    facebook_groups: v.optional(v.string()), // JSON array of Facebook group names
    num_quotes: v.optional(v.number()), // Target number of quotes (default 20)
    quotes: v.optional(v.string()),     // JSON array of quote objects
    perplexity_raw: v.optional(v.string()),
    claude_raw: v.optional(v.string()),
    sources_used: v.optional(v.string()),
    quote_count: v.optional(v.number()),
    error_message: v.optional(v.string()),
    duration_ms: v.optional(v.number()),
    headlines: v.optional(v.string()),              // JSON array of headline strings
    headlines_generated_at: v.optional(v.string()), // ISO timestamp
    created_at: v.string(),
    completed_at: v.optional(v.string()),
  })
    .index("by_externalId", ["externalId"])
    .index("by_project", ["project_id"]),

  quote_bank: defineTable({
    externalId: v.string(),
    project_id: v.string(),                        // → projects.externalId
    quote: v.string(),                             // Verbatim quote text
    source: v.optional(v.string()),                // e.g., "Reddit r/health"
    source_url: v.optional(v.string()),
    emotion: v.optional(v.string()),               // frustration, desperation, anger, etc.
    emotional_intensity: v.optional(v.string()),    // "high" or "medium"
    context: v.optional(v.string()),               // 1-sentence context
    run_id: v.string(),                            // → quote_mining_runs.externalId
    problem: v.optional(v.string()),               // Denormalized from run — the "angle"
    tags: v.optional(v.array(v.string())),         // User-applied custom tags
    is_favorite: v.optional(v.boolean()),
    headlines: v.optional(v.string()),             // JSON array of headline strings
    headlines_generated_at: v.optional(v.string()), // ISO timestamp
    created_at: v.string(),
  })
    .index("by_externalId", ["externalId"])
    .index("by_project", ["project_id"]),

  chat_threads: defineTable({
    externalId: v.string(),
    project_id: v.string(),              // → projects.externalId
    agent_id: v.optional(v.string()),    // agency agent id (null for copywriter chat)
    title: v.optional(v.string()),
    status: v.string(),                  // active | archived
    created_at: v.string(),
    updated_at: v.string(),
  })
    .index("by_externalId", ["externalId"])
    .index("by_project", ["project_id"])
    .index("by_project_and_status", ["project_id", "status"])
    .index("by_project_agent_status", ["project_id", "agent_id", "status"]),

  chat_messages: defineTable({
    externalId: v.string(),
    thread_id: v.string(),               // → chat_threads.externalId
    project_id: v.string(),              // denormalized for easy querying
    role: v.string(),                    // user | assistant
    content: v.string(),
    is_context_message: v.optional(v.boolean()), // hides priming message in UI
    created_at: v.string(),
  })
    .index("by_externalId", ["externalId"])
    .index("by_thread", ["thread_id"])
    .index("by_project", ["project_id"]),

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

  meta_performance: defineTable({
    externalId: v.string(),
    deployment_id: v.string(),       // → ad_deployments.externalId
    meta_ad_id: v.string(),          // Meta Ad ID
    date: v.string(),                // YYYY-MM-DD
    impressions: v.number(),
    clicks: v.number(),
    spend: v.number(),               // USD
    reach: v.number(),
    ctr: v.number(),                 // click-through rate %
    cpc: v.number(),                 // cost per click
    cpm: v.number(),                 // cost per 1000 impressions
    conversions: v.number(),
    conversion_value: v.number(),    // for ROAS calculation
    frequency: v.number(),
    updated_at: v.string(),
  })
    .index("by_externalId", ["externalId"])
    .index("by_deployment", ["deployment_id"])
    .index("by_meta_ad_id", ["meta_ad_id"])
    .index("by_meta_ad_and_date", ["meta_ad_id", "date"]),

  landing_pages: defineTable({
    externalId: v.string(),
    project_id: v.string(),              // → projects.externalId
    name: v.string(),                    // User-facing name (auto-generated or manual)
    angle: v.optional(v.string()),       // The angle/hook for this LP
    word_count: v.optional(v.number()),  // Optional target word count
    additional_direction: v.optional(v.string()), // Extra instructions from user
    swipe_text: v.optional(v.string()),  // Extracted text from swipe page
    swipe_filename: v.optional(v.string()), // Legacy: original swipe PDF filename
    swipe_url: v.optional(v.string()),               // URL of swipe page
    swipe_screenshot_storageId: v.optional(v.string()), // Convex storage ID for full-page screenshot
    status: v.string(),                  // draft | generating | completed | failed
    error_message: v.optional(v.string()),
    copy_sections: v.optional(v.string()), // JSON: generated copy sections
    // Phase 2 fields
    swipe_design_analysis: v.optional(v.string()),  // JSON: design spec from Claude vision analysis
    image_slots: v.optional(v.string()),             // JSON: array of image slot objects with storageId
    html_template: v.optional(v.string()),           // Raw HTML template with placeholders
    assembled_html: v.optional(v.string()),          // Final HTML with placeholders replaced
    slug: v.optional(v.string()),                    // URL slug for publishing
    cta_links: v.optional(v.string()),               // JSON: array of CTA link objects [{cta_id, text, url}]
    current_version: v.optional(v.number()),         // Current version number
    // Phase 4 publishing fields
    published_url: v.optional(v.string()),           // Live URL after publishing
    published_at: v.optional(v.string()),            // ISO timestamp of last publish
    final_html: v.optional(v.string()),              // Baked HTML sent to hosting
    hosting_metadata: v.optional(v.string()),        // JSON: hosting deployment info
    // Auto-generation fields (LP pipeline)
    auto_generated: v.optional(v.boolean()),         // True if created by automated pipeline
    batch_job_id: v.optional(v.string()),            // → batch_jobs.externalId
    narrative_frame: v.optional(v.string()),          // Which narrative frame was used
    template_id: v.optional(v.string()),             // → lp_templates.externalId
    shopify_page_id: v.optional(v.string()),         // Shopify page ID for updates/deletion
    shopify_handle: v.optional(v.string()),          // Shopify URL handle
    headline_text: v.optional(v.string()),
    subheadline_text: v.optional(v.string()),
    headline_frame_alignment_status: v.optional(v.string()),
    headline_frame_alignment_reason: v.optional(v.string()),
    headline_uniqueness_status: v.optional(v.string()),
    headline_uniqueness_reason: v.optional(v.string()),
    headline_duplicate_of_lp_id: v.optional(v.string()),
    title_family_uniqueness_status: v.optional(v.string()),
    title_family_uniqueness_reason: v.optional(v.string()),
    title_concept_separation_status: v.optional(v.string()),
    title_concept_separation_reason: v.optional(v.string()),
    title_concept_signature: v.optional(v.string()),
    title_concept_family: v.optional(v.string()),
    headline_history_status: v.optional(v.string()),
    headline_history_reason: v.optional(v.string()),
    headline_signature: v.optional(v.string()),
    frame_blueprint_status: v.optional(v.string()),
    frame_blueprint_reason: v.optional(v.string()),
    // Visual QA fields
    qa_status: v.optional(v.string()),               // pending | running | passed | failed | skipped
    qa_report: v.optional(v.string()),               // JSON: full QA report from Claude Opus vision
    qa_issues_count: v.optional(v.number()),         // Number of issues found
    qa_screenshot_storageId: v.optional(v.string()), // Convex storage ID for QA screenshot
    qa_score: v.optional(v.number()),                // 0-100 from visual QA
    generation_attempts: v.optional(v.number()),      // How many full generation attempts
    fix_attempts: v.optional(v.number()),             // How many auto-fix passes attempted
    // Smoke test fields
    smoke_test_status: v.optional(v.string()),        // passed | failed | pending
    smoke_test_report: v.optional(v.string()),        // JSON
    smoke_test_at: v.optional(v.string()),            // ISO timestamp
    // Audit trail fields
    audit_trail: v.optional(v.string()),              // JSON: generation audit trail entries
    editorial_plan: v.optional(v.string()),           // JSON: Opus editorial plan
    // Gauntlet fields
    gauntlet_batch_id: v.optional(v.string()),        // Groups LPs from same gauntlet run
    gauntlet_frame: v.optional(v.string()),           // Which narrative frame in this gauntlet run
    gauntlet_attempt: v.optional(v.float64()),        // Which attempt # for this frame
    gauntlet_retry_type: v.optional(v.string()),      // "image" | "full" | null
    gauntlet_score: v.optional(v.float64()),          // 0-10 score from Sonnet vision
    gauntlet_score_reasoning: v.optional(v.string()), // Full scoring reasoning
    gauntlet_status: v.optional(v.string()),          // "pending" | "scoring" | "passed" | "failed" | "retrying"
    gauntlet_image_prescore_attempts: v.optional(v.float64()), // Total image prescore retries
    gauntlet_batch_started_at: v.optional(v.string()),  // ISO timestamp when batch run began
    gauntlet_batch_completed_at: v.optional(v.string()), // ISO timestamp when batch run finished
    generation_duration_ms: v.optional(v.float64()),     // How long generation took in milliseconds
    created_at: v.string(),
    updated_at: v.string(),
  })
    .index("by_externalId", ["externalId"])
    .index("by_project", ["project_id"])
    .index("by_batch_job", ["batch_job_id"])
    .index("by_project_angle_and_created_at", ["project_id", "angle", "created_at"])
    .index("by_project_angle_frame_and_created_at", ["project_id", "angle", "narrative_frame", "created_at"]),

  lp_templates: defineTable({
    externalId: v.string(),
    project_id: v.string(),              // → projects.externalId
    source_url: v.string(),              // Original URL template was extracted from
    name: v.string(),                    // User-editable display name
    skeleton_html: v.string(),           // HTML template with placeholder slot markers
    design_brief: v.string(),            // JSON: styling patterns, colors, typography, spacing
    slot_definitions: v.string(),        // JSON: array of slot objects with id, type, position, content_type
    screenshot_storage_id: v.optional(v.string()), // Convex storage ID for captured screenshot
    status: v.string(),                  // extracting | ready | failed
    error_message: v.optional(v.string()),
    created_at: v.string(),
  })
    .index("by_externalId", ["externalId"])
    .index("by_project", ["project_id"]),

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

  landing_page_versions: defineTable({
    externalId: v.string(),
    landing_page_id: v.string(),         // → landing_pages.externalId
    version: v.number(),
    copy_sections: v.string(),           // JSON: copy sections snapshot
    source: v.string(),                  // generated | edited
    image_slots: v.optional(v.string()),           // JSON: image slot snapshot
    cta_links: v.optional(v.string()),             // JSON: CTA links snapshot
    html_template: v.optional(v.string()),         // HTML template snapshot
    assembled_html: v.optional(v.string()),        // Assembled HTML snapshot
    created_at: v.string(),
  })
    .index("by_externalId", ["externalId"])
    .index("by_landing_page", ["landing_page_id"]),

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
    run_schedule: v.string(),           // "auto" | "manual_only"
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
    lp_enabled: v.optional(v.boolean()), // Per-angle LP override: true=always, false=never, null=use project default
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
    skip_lp_gen: v.optional(v.boolean()),
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

  // =============================================
  // Landing Page Agent — Agent #3 config
  // =============================================

  lp_agent_config: defineTable({
    externalId: v.string(),
    project_id: v.string(),              // → projects.externalId
    enabled: v.optional(v.boolean()),
    // Shopify connection
    shopify_store_domain: v.optional(v.string()),
    shopify_access_token: v.optional(v.string()),
    shopify_client_id: v.optional(v.string()),
    shopify_connected: v.optional(v.boolean()),
    // Product page
    pdp_url: v.optional(v.string()),
    // Generation settings
    default_narrative_frames: v.optional(v.string()), // JSON array of enabled frame IDs
    template_selection_mode: v.optional(v.string()),   // "random" | "weighted"
    editorial_pass_enabled: v.optional(v.boolean()),
    lp_default_mode: v.optional(v.string()),             // "all" | "opt_in" — default "opt_in"
    auto_publish: v.optional(v.boolean()),
    // Budget
    daily_budget_cents: v.optional(v.number()),
    // Images
    use_product_reference_images: v.optional(v.boolean()),
    lifestyle_image_style: v.optional(v.string()),
    // Page metadata defaults
    default_author_name: v.optional(v.string()),
    default_author_title: v.optional(v.string()),
    default_warning_text: v.optional(v.string()),
    visual_qa_enabled: v.optional(v.boolean()),       // Toggle visual QA (default true)
    // Cached image context (LLM-extracted from foundational docs, JSON strings)
    cached_product_visual_context: v.optional(v.string()),  // JSON: { sourceHash, extractedAt, data }
    cached_avatar_visual_context: v.optional(v.string()),   // JSON: { sourceHash, extractedAt, data }
    // Generation pipeline config
    lp_frame_count: v.optional(v.float64()),                // DEPRECATED — replaced by default_narrative_frames
    gauntlet_score_threshold: v.optional(v.float64()),      // Min score to pass (default 6)
    gauntlet_max_image_retries: v.optional(v.float64()),    // Max image prescore retries (default 5)
    gauntlet_max_lp_retries: v.optional(v.float64()),       // Max full LP retries (default 2)
    // Word count
    default_word_count: v.optional(v.float64()),             // Optional global default word count
    frame_word_counts: v.optional(v.string()),               // JSON: { "testimonial": 1800, "listicle": 600 }
    // Canonical benchmark
    canonical_page_url: v.optional(v.string()),              // URL of canonical LP for structural benchmarking
    // Timestamps
    created_at: v.optional(v.string()),
    updated_at: v.optional(v.string()),
  })
    .index("by_project", ["project_id"])
    .index("by_externalId", ["externalId"]),

  // =============================================
  // CMO Agent — Ad Performance Management tables
  // =============================================

  cmo_config: defineTable({
    project_id: v.string(),              // → projects.externalId
    enabled: v.boolean(),
    review_schedule: v.string(),         // "weekly" | "manual_only"
    review_day_of_week: v.number(),      // 0=Sun, 1=Mon, ..., 6=Sat
    review_hour_utc: v.number(),         // 0-23
    target_cpa: v.optional(v.float64()), // Target CPA in USD
    target_roas: v.optional(v.float64()), // Target ROAS multiplier
    min_highest_angles: v.number(),      // Minimum angles at highest priority (default 8)
    evaluation_window_days: v.number(),  // Minimum days before judging (default 12)
    meta_campaign_id: v.optional(v.string()), // Meta campaign ID to monitor
    tracking_start_date: v.optional(v.string()), // YYYY-MM-DD
    tw_api_key: v.optional(v.string()),
    tw_shopify_domain: v.optional(v.string()),
    ga4_property_id: v.optional(v.string()),
    ga4_credentials_json: v.optional(v.string()), // JSON service account credentials
    notifications_enabled: v.boolean(),
    auto_execute: v.boolean(),           // false = dry-run by default
    created_at: v.string(),
    updated_at: v.string(),
  })
    .index("by_project", ["project_id"]),

  cmo_runs: defineTable({
    externalId: v.string(),
    project_id: v.string(),
    run_type: v.string(),                // "weekly" | "manual" | "dry_run"
    status: v.string(),                  // "running" | "completed" | "failed"
    run_at: v.string(),                  // ISO timestamp
    duration_ms: v.optional(v.float64()),
    tw_summary: v.optional(v.string()),  // JSON: Triple Whale blended metrics
    meta_ads_count: v.optional(v.float64()),
    ga4_pages_count: v.optional(v.float64()),
    angle_evaluations: v.optional(v.string()), // JSON: angle tier/spend evaluation results
    lp_diagnostics: v.optional(v.string()),    // JSON: LP diagnostic results
    decisions: v.optional(v.string()),         // JSON array of decision objects
    decisions_applied: v.optional(v.boolean()),
    decisions_count: v.optional(v.float64()),
    pipeline_health: v.optional(v.string()),   // JSON: pipeline health check results
    angles_written: v.optional(v.string()),    // JSON: new angles generated
    notifications_sent: v.optional(v.float64()),
    error: v.optional(v.string()),
    error_stage: v.optional(v.string()),
    created_at: v.string(),
  })
    .index("by_externalId", ["externalId"])
    .index("by_project", ["project_id"])
    .index("by_project_and_run_at", ["project_id", "run_at"]),

  cmo_angle_history: defineTable({
    externalId: v.string(),
    project_id: v.string(),
    angle_name: v.string(),
    snapshot_date: v.string(),           // YYYY-MM-DD
    cmo_run_id: v.string(),              // → cmo_runs.externalId
    spend: v.float64(),
    impressions: v.float64(),
    clicks: v.float64(),
    conversions: v.float64(),
    conversion_value: v.float64(),
    cpa: v.optional(v.float64()),
    roas: v.optional(v.float64()),
    ctr: v.optional(v.float64()),
    cpc: v.optional(v.float64()),
    tier: v.string(),                    // "T1" | "T2" | "T3" | "T4" | "too_early"
    spend_class: v.string(),             // "STRONG" | "MODERATE" | "WEAK" | "NEGLIGIBLE" | "ZERO"
    priority_at_snapshot: v.optional(v.string()),
    status_at_snapshot: v.optional(v.string()),
    ad_count: v.optional(v.float64()),
    days_active: v.optional(v.float64()),
    spend_trend: v.optional(v.string()), // "up" | "down" | "flat"
    cpa_trend: v.optional(v.string()),   // "up" | "down" | "flat"
    lp_bounce_rate: v.optional(v.float64()),
    lp_cvr: v.optional(v.float64()),
    lp_sessions: v.optional(v.float64()),
    created_at: v.string(),
  })
    .index("by_externalId", ["externalId"])
    .index("by_project_and_angle", ["project_id", "angle_name"])
    .index("by_project_angle_and_date", ["project_id", "angle_name", "snapshot_date"])
    .index("by_project_and_date", ["project_id", "snapshot_date"])
    .index("by_cmo_run", ["cmo_run_id"]),

  cmo_notifications: defineTable({
    externalId: v.string(),
    project_id: v.string(),
    cmo_run_id: v.string(),              // → cmo_runs.externalId
    rule: v.string(),                    // Which notification rule triggered
    severity: v.string(),               // "info" | "warning" | "critical"
    title: v.string(),
    message: v.string(),
    angle_name: v.optional(v.string()),
    data: v.optional(v.string()),        // JSON: extra structured data
    acknowledged: v.boolean(),
    acknowledged_at: v.optional(v.string()),
    created_at: v.string(),
  })
    .index("by_externalId", ["externalId"])
    .index("by_project", ["project_id"])
    .index("by_project_and_run", ["project_id", "cmo_run_id"]),

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

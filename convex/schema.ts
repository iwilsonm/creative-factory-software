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
    scout_destination_url: v.optional(v.string()),        // Default website/landing page URL
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
    headline: v.optional(v.string()),
    body_copy: v.optional(v.string()),
    image_prompt: v.optional(v.string()),
    gpt_creative_output: v.optional(v.string()),
    template_image_id: v.optional(v.string()),
    inspiration_image_id: v.optional(v.string()),
    storageId: v.optional(v.id("_storage")),
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
    sub_angle: v.optional(v.string()),       // Legacy: from removed diversity features
    created_at: v.string(),
  })
    .index("by_externalId", ["externalId"])
    .index("by_project", ["project_id"])
    .index("by_batch_job", ["batch_job_id"]),

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
    title: v.optional(v.string()),
    status: v.string(),                  // active | archived
    created_at: v.string(),
    updated_at: v.string(),
  })
    .index("by_externalId", ["externalId"])
    .index("by_project", ["project_id"])
    .index("by_project_and_status", ["project_id", "status"]),

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
    word_count: v.optional(v.number()),  // Target word count (default 1200)
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
    created_at: v.string(),
    updated_at: v.string(),
  })
    .index("by_externalId", ["externalId"])
    .index("by_project", ["project_id"]),

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
    // Shopify LP pipeline config
    shopify_store_domain: v.optional(v.string()),    // e.g., "heal-naturally.myshopify.com"
    shopify_access_token: v.optional(v.string()),    // Admin API token with write_content scope
    shopify_client_id: v.optional(v.string()),        // Client ID of connected Shopify app (reference only)
    shopify_lander_template: v.optional(v.string()), // Template suffix, default "lander"
    pdp_url: v.optional(v.string()),                 // Product detail page URL for CTA links
    lp_auto_enabled: v.optional(v.boolean()),        // Enable/disable auto LP generation
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
    description: v.string(),             // detailed angle for prompt injection
    prompt_hints: v.optional(v.string()), // specific creative direction
    source: v.string(),                  // "manual" | "auto_generated"
    status: v.string(),                  // "active" | "testing" | "retired"
    focused: v.optional(v.boolean()),    // When true + active, Director only uses focused angles
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
    created_at: v.number(),
  })
    .index("by_externalId", ["externalId"])
    .index("by_project", ["project_id"]),

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

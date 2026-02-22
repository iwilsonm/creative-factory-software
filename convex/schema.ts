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
    copy_framework: v.optional(v.string()),  // Legacy: from removed diversity features
    sub_angle: v.optional(v.string()),       // Legacy: from removed diversity features
    created_at: v.string(),
  })
    .index("by_externalId", ["externalId"])
    .index("by_project", ["project_id"]),

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
    cta_button: v.optional(v.string()),          // Meta CTA type
    facebook_page: v.optional(v.string()),       // Facebook Page name to post from
    planned_date: v.optional(v.string()),        // ISO datetime for scheduled posting
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
    cta_button: v.optional(v.string()),           // Meta CTA type (SHOP_NOW, LEARN_MORE, etc.)
    facebook_page: v.optional(v.string()),        // Facebook Page name to post from
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
    final_html: v.optional(v.string()),              // Baked HTML sent to Cloudflare
    hosting_metadata: v.optional(v.string()),        // JSON: Cloudflare deployment info
    created_at: v.string(),
    updated_at: v.string(),
  })
    .index("by_externalId", ["externalId"])
    .index("by_project", ["project_id"]),

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
});

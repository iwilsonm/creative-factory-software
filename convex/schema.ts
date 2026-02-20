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
    created_at: v.string(),
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
    created_at: v.string(),
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
});

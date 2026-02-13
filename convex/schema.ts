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
    aspect_ratio: v.optional(v.string()),
    template_image_id: v.optional(v.string()),
    inspiration_image_id: v.optional(v.string()),
    product_image_storageId: v.optional(v.id("_storage")),
    gemini_batch_job: v.optional(v.nullable(v.string())),
    gpt_prompts: v.optional(v.nullable(v.string())),
    status: v.optional(v.string()),
    scheduled: v.optional(v.boolean()),
    schedule_cron: v.optional(v.string()),
    error_message: v.optional(v.nullable(v.string())),
    completed_count: v.optional(v.number()),
    retry_count: v.optional(v.number()),
    batch_stats: v.optional(v.nullable(v.string())),
    created_at: v.string(),
    completed_at: v.optional(v.string()),
  })
    .index("by_externalId", ["externalId"])
    .index("by_project", ["project_id"])
    .index("by_status", ["status"]),

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
});

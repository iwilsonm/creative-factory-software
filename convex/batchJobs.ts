import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const create = mutation({
  args: {
    externalId: v.string(),
    project_id: v.string(),
    generation_mode: v.string(),
    batch_size: v.number(),
    angle: v.optional(v.string()),
    angles: v.optional(v.string()),
    aspect_ratio: v.optional(v.string()),
    template_image_id: v.optional(v.string()),
    template_image_ids: v.optional(v.string()),
    inspiration_image_id: v.optional(v.string()),
    inspiration_image_ids: v.optional(v.string()),
    product_image_storageId: v.optional(v.id("_storage")),
    scheduled: v.optional(v.boolean()),
    schedule_cron: v.optional(v.string()),
    filter_assigned: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    await ctx.db.insert("batch_jobs", {
      ...args,
      status: "pending",
      completed_count: 0,
      retry_count: 0,
      created_at: now,
    });
  },
});

export const getByExternalId = query({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("batch_jobs")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
  },
});

export const getByProject = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("batch_jobs")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .order("desc")
      .collect();
  },
});

export const getActive = query({
  args: {},
  handler: async (ctx) => {
    // Use by_status index — 3 small indexed queries instead of one full table scan
    const [a, b, c] = await Promise.all([
      ctx.db.query("batch_jobs").withIndex("by_status", (q) => q.eq("status", "generating_prompts")).collect(),
      ctx.db.query("batch_jobs").withIndex("by_status", (q) => q.eq("status", "submitting")).collect(),
      ctx.db.query("batch_jobs").withIndex("by_status", (q) => q.eq("status", "processing")).collect(),
    ]);
    return [...a, ...b, ...c];
  },
});

export const getScheduled = query({
  args: {},
  handler: async (ctx) => {
    const scheduled = await ctx.db
      .query("batch_jobs")
      .withIndex("by_scheduled", (q) => q.eq("scheduled", true))
      .collect();
    return scheduled.filter((b) => b.schedule_cron);
  },
});

export const getAllScheduledForCost = query({
  args: {},
  handler: async (ctx) => {
    const scheduled = await ctx.db
      .query("batch_jobs")
      .withIndex("by_scheduled", (q) => q.eq("scheduled", true))
      .collect();
    return scheduled
      .filter((b) => b.schedule_cron)
      .map((b) => ({
        batch_size: b.batch_size,
        schedule_cron: b.schedule_cron,
        aspect_ratio: b.aspect_ratio,
        project_id: b.project_id,
        angle: b.angle || null,
      }));
  },
});

export const update = mutation({
  args: {
    externalId: v.string(),
    status: v.optional(v.string()),
    gemini_batch_job: v.optional(v.nullable(v.string())),
    gpt_prompts: v.optional(v.nullable(v.string())),
    error_message: v.optional(v.nullable(v.string())),
    started_at: v.optional(v.string()),
    completed_at: v.optional(v.string()),
    completed_count: v.optional(v.number()),
    scheduled: v.optional(v.boolean()),
    schedule_cron: v.optional(v.string()),
    retry_count: v.optional(v.number()),
    batch_stats: v.optional(v.nullable(v.string())),
    angle: v.optional(v.string()),
    angles: v.optional(v.string()),
    batch_size: v.optional(v.number()),
    aspect_ratio: v.optional(v.string()),
    used_template_ids: v.optional(v.string()),
    pipeline_state: v.optional(v.string()),
    failed_count: v.optional(v.number()),
    run_count: v.optional(v.number()),
    filter_assigned: v.optional(v.boolean()),
    filter_processed: v.optional(v.boolean()),
    filter_processed_at: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const batch = await ctx.db
      .query("batch_jobs")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!batch) throw new Error("Batch job not found");

    const { externalId, ...updates } = args;
    const filtered: Record<string, any> = {};
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) filtered[key] = value;
    }
    await ctx.db.patch(batch._id, filtered);
  },
});

// Used by Dacia Fixer for batch resurrection
export const getByStatus = query({
  args: { status: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("batch_jobs")
      .withIndex("by_status", (q) => q.eq("status", args.status))
      .collect();
  },
});

// Used by Dacia Fixer — returns all batch jobs
export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("batch_jobs").order("desc").collect();
  },
});

// Used by Dacia Fixer for batch resurrection — reset a failed batch
export const updateStatus = mutation({
  args: {
    externalId: v.string(),
    status: v.string(),
    error_message: v.optional(v.nullable(v.string())),
    retry_count: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const batch = await ctx.db
      .query("batch_jobs")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!batch) throw new Error("Batch job not found");

    const updates: Record<string, any> = { status: args.status };
    if (args.error_message !== undefined) updates.error_message = args.error_message;
    if (args.retry_count !== undefined) updates.retry_count = args.retry_count;
    await ctx.db.patch(batch._id, updates);
  },
});

// Used by Dacia Creative Filter — patch arbitrary fields on a batch
export const patch = mutation({
  args: {
    externalId: v.string(),
    filter_assigned: v.optional(v.boolean()),
    filter_processed: v.optional(v.boolean()),
    filter_processed_at: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const batch = await ctx.db
      .query("batch_jobs")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!batch) throw new Error("Batch job not found");

    const { externalId, ...updates } = args;
    const filtered: Record<string, any> = {};
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) filtered[key] = value;
    }
    await ctx.db.patch(batch._id, filtered);
  },
});

export const remove = mutation({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const batch = await ctx.db
      .query("batch_jobs")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!batch) throw new Error("Batch job not found");
    if (batch.product_image_storageId) {
      await ctx.storage.delete(batch.product_image_storageId);
    }
    await ctx.db.delete(batch._id);
  },
});

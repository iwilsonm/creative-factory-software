import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const create = mutation({
  args: {
    externalId: v.string(),
    project_id: v.string(),
    generation_mode: v.string(),
    batch_size: v.number(),
    angle: v.optional(v.string()),
    aspect_ratio: v.optional(v.string()),
    template_image_id: v.optional(v.string()),
    inspiration_image_id: v.optional(v.string()),
    product_image_storageId: v.optional(v.id("_storage")),
    scheduled: v.optional(v.boolean()),
    schedule_cron: v.optional(v.string()),
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
    const all = await ctx.db.query("batch_jobs").collect();
    return all.filter((b) =>
      ["generating_prompts", "submitting", "processing"].includes(b.status || "")
    );
  },
});

export const getScheduled = query({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("batch_jobs").collect();
    return all.filter((b) => b.scheduled && b.schedule_cron);
  },
});

export const getAllScheduledForCost = query({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("batch_jobs").collect();
    return all
      .filter((b) => b.scheduled && b.schedule_cron)
      .map((b) => ({
        batch_size: b.batch_size,
        schedule_cron: b.schedule_cron,
        aspect_ratio: b.aspect_ratio,
        project_id: b.project_id,
      }));
  },
});

export const update = mutation({
  args: {
    externalId: v.string(),
    status: v.optional(v.string()),
    gemini_batch_job: v.optional(v.string()),
    gpt_prompts: v.optional(v.string()),
    error_message: v.optional(v.string()),
    completed_at: v.optional(v.string()),
    completed_count: v.optional(v.number()),
    scheduled: v.optional(v.boolean()),
    schedule_cron: v.optional(v.string()),
    retry_count: v.optional(v.number()),
    batch_stats: v.optional(v.string()),
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

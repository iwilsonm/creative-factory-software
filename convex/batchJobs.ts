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
    // Dacia Creative Director fields
    posting_day: v.optional(v.string()),
    conductor_run_id: v.optional(v.string()),
    angle_name: v.optional(v.string()),
    angle_prompt: v.optional(v.string()),
    angle_brief: v.optional(v.string()),    // JSON: structured angle brief
    flex_ad_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    await ctx.db.insert("batch_jobs", {
      ...args,
      status: "pending",
      completed_count: 0,
      failed_count: 0,
      run_count: 0,
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
    stale_detected_at: v.optional(v.nullable(v.string())),
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
    // Dacia Creative Director fields
    posting_day: v.optional(v.string()),
    conductor_run_id: v.optional(v.string()),
    angle_name: v.optional(v.string()),
    angle_prompt: v.optional(v.string()),
    angle_brief: v.optional(v.string()),    // JSON: structured angle brief
    flex_ad_id: v.optional(v.string()),
    // LP auto-generation tracking
    lp_primary_id: v.optional(v.string()),
    lp_primary_url: v.optional(v.string()),
    lp_primary_status: v.optional(v.string()),
    lp_primary_error: v.optional(v.string()),
    lp_primary_retry_count: v.optional(v.float64()),
    lp_secondary_id: v.optional(v.string()),
    lp_secondary_url: v.optional(v.string()),
    lp_secondary_status: v.optional(v.string()),
    lp_secondary_error: v.optional(v.string()),
    lp_secondary_retry_count: v.optional(v.float64()),
    lp_narrative_frames: v.optional(v.string()),
    gauntlet_lp_urls: v.optional(v.string()),
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

export const claimResultsProcessing = mutation({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const batch = await ctx.db
      .query("batch_jobs")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!batch) throw new Error("Batch job not found");

    const runCount = batch.run_count || 0;
    const completedCount = batch.completed_count || 0;
    const failedCount = batch.failed_count || 0;

    if (batch.status === "saving_results") {
      return {
        claimed: false,
        status: batch.status,
        completed_count: completedCount,
        failed_count: failedCount,
        run_count: runCount,
      };
    }

    if (batch.status === "completed" && runCount > 0) {
      return {
        claimed: false,
        status: batch.status,
        completed_count: completedCount,
        failed_count: failedCount,
        run_count: runCount,
      };
    }

    await ctx.db.patch(batch._id, { status: "saving_results" });
    return {
      claimed: true,
      status: "saving_results",
      completed_count: completedCount,
      failed_count: failedCount,
      run_count: runCount,
    };
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

// Used by Dacia Fixer — returns all batch jobs (limited to recent 100 to avoid response size limits)
export const list = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("batch_jobs").order("desc").take(100);
  },
});

// Used by Creative Filter — returns only completed batches eligible for scoring
export const getFilterable = query({
  args: {},
  handler: async (ctx) => {
    const completed = await ctx.db
      .query("batch_jobs")
      .withIndex("by_status", (q) => q.eq("status", "completed"))
      .order("desc")
      .take(200);
    return completed.filter(
      (b) => b.filter_assigned === true && !b.filter_processed
    );
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
    if (args.stale_detected_at !== undefined) updates.stale_detected_at = args.stale_detected_at;
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

// Returns completed Director batches in a date range for cost-per-ad calculations.
// Uses order("desc") to scan newest-first and stop early once we pass sinceDate.
export const getCompletedDirectorBatchStats = query({
  args: { sinceDate: v.string() },
  handler: async (ctx, args) => {
    // Scan recent batches (newest first) — most will be in the last 7 days
    const recent = await ctx.db
      .query("batch_jobs")
      .order("desc")
      .take(200);

    return recent
      .filter(
        (b) =>
          b.status === "completed" &&
          b.conductor_run_id &&
          b.completed_at &&
          b.completed_at >= args.sinceDate
      )
      .map((b) => ({
        project_id: b.project_id,
        batch_size: b.batch_size,
        completed_at: b.completed_at,
        used_template_ids: b.used_template_ids || null,
      }));
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
      try {
        await ctx.storage.delete(batch.product_image_storageId);
      } catch {
        // Storage blob may already be deleted or invalid — continue with batch deletion
      }
    }
    await ctx.db.delete(batch._id);
  },
});

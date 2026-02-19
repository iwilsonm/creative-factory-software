import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const getByProject = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("quote_mining_runs")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .collect();
  },
});

export const getByExternalId = query({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("quote_mining_runs")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
  },
});

export const create = mutation({
  args: {
    externalId: v.string(),
    project_id: v.string(),
    status: v.string(),
    target_demographic: v.string(),
    problem: v.string(),
    root_cause: v.optional(v.string()),
    keywords: v.string(),
    subreddits: v.optional(v.string()),
    forums: v.optional(v.string()),
    facebook_groups: v.optional(v.string()),
    num_quotes: v.optional(v.number()),
    created_at: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("quote_mining_runs", args);
  },
});

export const update = mutation({
  args: {
    externalId: v.string(),
    status: v.optional(v.string()),
    quotes: v.optional(v.string()),
    perplexity_raw: v.optional(v.string()),
    claude_raw: v.optional(v.string()),
    sources_used: v.optional(v.string()),
    quote_count: v.optional(v.number()),
    error_message: v.optional(v.string()),
    duration_ms: v.optional(v.number()),
    headlines: v.optional(v.string()),
    headlines_generated_at: v.optional(v.string()),
    completed_at: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("quote_mining_runs")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!doc) throw new Error("Quote mining run not found");
    const { externalId, ...fields } = args;
    // Remove undefined fields
    const updates: Record<string, any> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) updates[key] = value;
    }
    await ctx.db.patch(doc._id, updates);
  },
});

export const remove = mutation({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("quote_mining_runs")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!doc) throw new Error("Quote mining run not found");
    await ctx.db.delete(doc._id);
  },
});

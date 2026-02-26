import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const getByProject = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("quote_bank")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .collect();
  },
});

export const getByExternalId = query({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("quote_bank")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
  },
});

export const create = mutation({
  args: {
    externalId: v.string(),
    project_id: v.string(),
    quote: v.string(),
    source: v.optional(v.string()),
    source_url: v.optional(v.string()),
    emotion: v.optional(v.string()),
    emotional_intensity: v.optional(v.string()),
    context: v.optional(v.string()),
    run_id: v.string(),
    problem: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    is_favorite: v.optional(v.boolean()),
    headlines: v.optional(v.string()),
    headlines_generated_at: v.optional(v.string()),
    created_at: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("quote_bank", args);
  },
});

export const bulkCreate = mutation({
  args: {
    quotes: v.string(), // JSON array of quote objects
  },
  handler: async (ctx, args) => {
    const quotes = JSON.parse(args.quotes);
    const requiredFields = ["externalId", "project_id", "quote", "run_id", "created_at"];
    const allowedFields = [
      "externalId", "project_id", "quote", "source", "source_url",
      "emotion", "emotional_intensity", "context", "run_id", "problem",
      "tags", "is_favorite", "headlines", "headlines_generated_at", "created_at",
    ];
    let inserted = 0;
    for (const quote of quotes) {
      // Validate required fields exist
      const missing = requiredFields.filter(f => !quote[f]);
      if (missing.length > 0) continue; // skip invalid entries
      // Whitelist fields to prevent arbitrary data insertion
      const clean: Record<string, any> = {};
      for (const key of allowedFields) {
        if (quote[key] !== undefined) clean[key] = quote[key];
      }
      await ctx.db.insert("quote_bank", clean as any);
      inserted++;
    }
    return { inserted };
  },
});

export const update = mutation({
  args: {
    externalId: v.string(),
    is_favorite: v.optional(v.boolean()),
    headlines: v.optional(v.string()),
    headlines_generated_at: v.optional(v.string()),
    problem: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    emotion: v.optional(v.string()),
    quote: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("quote_bank")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!doc) throw new Error("Quote not found in bank");
    const { externalId, ...fields } = args;
    const updates: Record<string, any> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) updates[key] = value;
    }
    await ctx.db.patch(doc._id, updates);
  },
});

export const bulkUpdate = mutation({
  args: {
    updates: v.string(), // JSON array of { externalId, ...fields }
  },
  handler: async (ctx, args) => {
    const items = JSON.parse(args.updates);
    const allowedUpdateFields = [
      "is_favorite", "headlines", "headlines_generated_at",
      "problem", "tags", "emotion", "quote",
    ];
    let patched = 0;
    for (const item of items) {
      const { externalId } = item;
      if (!externalId) continue;
      const doc = await ctx.db
        .query("quote_bank")
        .withIndex("by_externalId", (q: any) => q.eq("externalId", externalId))
        .first();
      if (doc) {
        // Whitelist fields to prevent arbitrary data modification
        const clean: Record<string, any> = {};
        for (const key of allowedUpdateFields) {
          if (item[key] !== undefined) clean[key] = item[key];
        }
        if (Object.keys(clean).length > 0) {
          await ctx.db.patch(doc._id, clean);
          patched++;
        }
      }
    }
    return { patched };
  },
});

export const remove = mutation({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("quote_bank")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!doc) throw new Error("Quote not found in bank");
    await ctx.db.delete(doc._id);
  },
});

export const backfillProblems = mutation({
  args: {
    updates: v.string(), // JSON array of [{ externalId, problem }]
  },
  handler: async (ctx, args) => {
    const updates = JSON.parse(args.updates);
    let patched = 0;
    for (const { externalId, problem } of updates) {
      const doc = await ctx.db
        .query("quote_bank")
        .withIndex("by_externalId", (q) => q.eq("externalId", externalId))
        .first();
      if (doc && !doc.problem) {
        await ctx.db.patch(doc._id, { problem });
        patched++;
      }
    }
    return { patched };
  },
});

export const removeByRunId = mutation({
  args: { runId: v.string() },
  handler: async (ctx, args) => {
    const quotes = await ctx.db
      .query("quote_bank")
      .collect();
    const toDelete = quotes.filter(q => q.run_id === args.runId);
    for (const doc of toDelete) {
      await ctx.db.delete(doc._id);
    }
    return { deleted: toDelete.length };
  },
});

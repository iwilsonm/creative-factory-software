import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const getByProject = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("correction_history")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .collect();
    // Sort newest first (by _creationTime descending)
    rows.sort((a, b) => b._creationTime - a._creationTime);
    return rows;
  },
});

export const create = mutation({
  args: {
    externalId: v.string(),
    project_id: v.string(),
    correction: v.string(),
    timestamp: v.string(),
    manual: v.optional(v.boolean()),
    changes: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("correction_history", args);
  },
});

export const remove = mutation({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("correction_history")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!doc) throw new Error("Correction history entry not found");
    await ctx.db.delete(doc._id);
  },
});

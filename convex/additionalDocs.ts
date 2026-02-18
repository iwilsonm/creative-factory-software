import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const getByProject = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("additional_docs")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .collect();
  },
});

export const create = mutation({
  args: {
    externalId: v.string(),
    project_id: v.string(),
    name: v.string(),
    content: v.string(),
    filename: v.optional(v.string()),
    char_count: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("additional_docs", {
      externalId: args.externalId,
      project_id: args.project_id,
      name: args.name,
      content: args.content,
      filename: args.filename,
      char_count: args.char_count,
      created_at: new Date().toISOString(),
    });
  },
});

export const remove = mutation({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("additional_docs")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!doc) throw new Error("Additional document not found");
    await ctx.db.delete(doc._id);
  },
});

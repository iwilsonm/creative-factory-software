import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const getByProject = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("template_images")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .collect();
  },
});

// Returns all template images globally (shared across projects)
export const getAll = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("template_images")
      .order("desc")
      .take(500);
  },
});

export const getByExternalId = query({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("template_images")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
  },
});

export const create = mutation({
  args: {
    externalId: v.string(),
    project_id: v.string(),
    filename: v.string(),
    storageId: v.optional(v.id("_storage")),
    description: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    await ctx.db.insert("template_images", {
      ...args,
      created_at: now,
    });
  },
});

export const update = mutation({
  args: {
    externalId: v.string(),
    description: v.optional(v.string()),
    storageId: v.optional(v.id("_storage")),
    analysis: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const img = await ctx.db
      .query("template_images")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!img) throw new Error("Template image not found");

    const { externalId, ...updates } = args;
    const filtered: Record<string, any> = {};
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) filtered[key] = value;
    }
    await ctx.db.patch(img._id, filtered);
  },
});

export const remove = mutation({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const img = await ctx.db
      .query("template_images")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!img) throw new Error("Template image not found");
    if (img.storageId) {
      await ctx.storage.delete(img.storageId);
    }
    await ctx.db.delete(img._id);
  },
});

export const getImageUrl = query({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const img = await ctx.db
      .query("template_images")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!img || !img.storageId) return null;
    return await ctx.storage.getUrl(img.storageId);
  },
});

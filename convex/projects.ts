import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const create = mutation({
  args: {
    externalId: v.string(),
    name: v.string(),
    brand_name: v.optional(v.string()),
    niche: v.optional(v.string()),
    product_description: v.optional(v.string()),
    sales_page_content: v.optional(v.string()),
    drive_folder_id: v.optional(v.string()),
    inspiration_folder_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    await ctx.db.insert("projects", {
      ...args,
      status: "setup",
      created_at: now,
      updated_at: now,
    });
  },
});

export const getByExternalId = query({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("projects")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
  },
});

export const getAll = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("projects").order("desc").collect();
  },
});

export const update = mutation({
  args: {
    externalId: v.string(),
    name: v.optional(v.string()),
    brand_name: v.optional(v.string()),
    niche: v.optional(v.string()),
    product_description: v.optional(v.string()),
    sales_page_content: v.optional(v.string()),
    drive_folder_id: v.optional(v.string()),
    inspiration_folder_id: v.optional(v.string()),
    prompt_guidelines: v.optional(v.string()),
    status: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const project = await ctx.db
      .query("projects")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!project) throw new Error("Project not found");

    const { externalId, ...updates } = args;
    // Filter out undefined values
    const filtered: Record<string, any> = {};
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) filtered[key] = value;
    }
    filtered.updated_at = new Date().toISOString();
    await ctx.db.patch(project._id, filtered);
  },
});

export const remove = mutation({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const project = await ctx.db
      .query("projects")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!project) throw new Error("Project not found");
    await ctx.db.delete(project._id);
  },
});

export const getStats = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    const docs = await ctx.db
      .query("foundational_docs")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .collect();
    const ads = await ctx.db
      .query("ad_creatives")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .collect();
    return { docCount: docs.length, adCount: ads.length };
  },
});

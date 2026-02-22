import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const getByProject = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("flex_ads")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .collect();
  },
});

export const getByAdSet = query({
  args: { adSetId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("flex_ads")
      .withIndex("by_ad_set", (q) => q.eq("ad_set_id", args.adSetId))
      .collect();
  },
});

export const getByExternalId = query({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("flex_ads")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
  },
});

export const create = mutation({
  args: {
    externalId: v.string(),
    project_id: v.string(),
    ad_set_id: v.string(),
    name: v.string(),
    child_deployment_ids: v.string(),
    primary_texts: v.optional(v.string()),
    headlines: v.optional(v.string()),
    destination_url: v.optional(v.string()),
    cta_button: v.optional(v.string()),
    created_at: v.string(),
    updated_at: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("flex_ads", args);
  },
});

export const update = mutation({
  args: {
    externalId: v.string(),
    fields: v.object({
      name: v.optional(v.string()),
      child_deployment_ids: v.optional(v.string()),
      primary_texts: v.optional(v.string()),
      headlines: v.optional(v.string()),
      destination_url: v.optional(v.string()),
      cta_button: v.optional(v.string()),
    }),
  },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("flex_ads")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!doc) throw new Error("Flex ad not found");
    const updates: Record<string, any> = { ...args.fields, updated_at: new Date().toISOString() };
    await ctx.db.patch(doc._id, updates);
  },
});

export const remove = mutation({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("flex_ads")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!doc) throw new Error("Flex ad not found");
    await ctx.db.delete(doc._id);
  },
});

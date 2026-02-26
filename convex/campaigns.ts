import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const getByProject = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("campaigns")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .collect();
  },
});

export const getByExternalId = query({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("campaigns")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
  },
});

export const create = mutation({
  args: {
    externalId: v.string(),
    project_id: v.string(),
    name: v.string(),
    sort_order: v.number(),
    created_at: v.string(),
    updated_at: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("campaigns", args);
  },
});

export const update = mutation({
  args: {
    externalId: v.string(),
    fields: v.object({
      name: v.optional(v.string()),
      sort_order: v.optional(v.number()),
    }),
  },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("campaigns")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!doc) throw new Error("Campaign not found");
    const updates: Record<string, any> = { ...args.fields, updated_at: new Date().toISOString() };
    await ctx.db.patch(doc._id, updates);
  },
});

export const remove = mutation({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("campaigns")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!doc) throw new Error("Campaign not found");

    // Cascade: delete child ad sets and soft-delete their child flex ads
    const adSets = await ctx.db
      .query("ad_sets")
      .withIndex("by_campaign", (q) => q.eq("campaign_id", args.externalId))
      .collect();
    for (const adSet of adSets) {
      const flexAds = await ctx.db
        .query("flex_ads")
        .withIndex("by_ad_set", (q) => q.eq("ad_set_id", adSet.externalId))
        .collect();
      for (const fa of flexAds) {
        if (!fa.deleted_at) {
          await ctx.db.patch(fa._id, { deleted_at: new Date().toISOString() });
        }
      }
      await ctx.db.delete(adSet._id);
    }

    await ctx.db.delete(doc._id);
  },
});

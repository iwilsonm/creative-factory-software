import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const getAll = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("ad_deployments").collect();
  },
});

export const getByProject = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("ad_deployments")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .collect();
  },
});

export const getByStatus = query({
  args: { status: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("ad_deployments")
      .withIndex("by_status", (q) => q.eq("status", args.status))
      .collect();
  },
});

export const getByAdId = query({
  args: { adId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("ad_deployments")
      .withIndex("by_ad_id", (q) => q.eq("ad_id", args.adId))
      .first();
  },
});

export const create = mutation({
  args: {
    externalId: v.string(),
    ad_id: v.string(),
    project_id: v.string(),
    status: v.string(),
    campaign_name: v.optional(v.string()),
    ad_set_name: v.optional(v.string()),
    ad_name: v.optional(v.string()),
    landing_page_url: v.optional(v.string()),
    notes: v.optional(v.string()),
    planned_date: v.optional(v.string()),
    posted_date: v.optional(v.string()),
    created_at: v.string(),
  },
  handler: async (ctx, args) => {
    // Dedup guard: skip if this ad is already deployed
    const existing = await ctx.db
      .query("ad_deployments")
      .withIndex("by_ad_id", (q) => q.eq("ad_id", args.ad_id))
      .first();
    if (existing) return null;
    return await ctx.db.insert("ad_deployments", args);
  },
});

export const update = mutation({
  args: {
    externalId: v.string(),
    fields: v.object({
      campaign_name: v.optional(v.string()),
      ad_set_name: v.optional(v.string()),
      ad_name: v.optional(v.string()),
      landing_page_url: v.optional(v.string()),
      notes: v.optional(v.string()),
      planned_date: v.optional(v.string()),
      posted_date: v.optional(v.string()),
      status: v.optional(v.string()),
      meta_campaign_id: v.optional(v.string()),
      meta_adset_id: v.optional(v.string()),
      meta_ad_id: v.optional(v.string()),
    }),
  },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("ad_deployments")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!doc) throw new Error("Deployment not found");
    await ctx.db.patch(doc._id, args.fields);
  },
});

export const updateStatus = mutation({
  args: {
    externalId: v.string(),
    status: v.string(),
  },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("ad_deployments")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!doc) throw new Error("Deployment not found");
    const updates: Record<string, string> = { status: args.status };
    if (args.status === "posted" && !doc.posted_date) {
      updates.posted_date = new Date().toISOString();
    }
    await ctx.db.patch(doc._id, updates);
  },
});

export const remove = mutation({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("ad_deployments")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!doc) throw new Error("Deployment not found");
    await ctx.db.delete(doc._id);
  },
});

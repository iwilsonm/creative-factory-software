import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const getByCampaign = query({
  args: { campaignId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("ad_sets")
      .withIndex("by_campaign", (q) => q.eq("campaign_id", args.campaignId))
      .collect();
  },
});

export const getByProject = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("ad_sets")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .collect();
  },
});

export const getByExternalId = query({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("ad_sets")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
  },
});

export const create = mutation({
  args: {
    externalId: v.string(),
    campaign_id: v.string(),
    project_id: v.string(),
    name: v.string(),
    sort_order: v.number(),
    // Phase 1 — Staging Page + Director-driven angle testing (all optional on create)
    angle_id: v.optional(v.string()),
    lifecycle_status: v.optional(v.string()),
    meta_targeting: v.optional(v.string()),
    meta_budget_type: v.optional(v.string()),
    meta_budget_amount_cents: v.optional(v.number()),
    meta_schedule: v.optional(v.string()),
    meta_optimization_goal: v.optional(v.string()),
    meta_billing_event: v.optional(v.string()),
    created_at: v.string(),
    updated_at: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("ad_sets", args);
  },
});

export const update = mutation({
  args: {
    externalId: v.string(),
    fields: v.object({
      name: v.optional(v.string()),
      sort_order: v.optional(v.number()),
      campaign_id: v.optional(v.string()),
      // Phase 1 — Staging Page + Director-driven angle testing
      angle_id: v.optional(v.string()),
      lifecycle_status: v.optional(v.string()),
      meta_targeting: v.optional(v.string()),
      meta_budget_type: v.optional(v.string()),
      meta_budget_amount_cents: v.optional(v.number()),
      meta_schedule: v.optional(v.string()),
      meta_optimization_goal: v.optional(v.string()),
      meta_billing_event: v.optional(v.string()),
      posted_at: v.optional(v.string()),
      meta_adset_id: v.optional(v.string()),
      // Phase 2B
      meta_campaign_id: v.optional(v.string()),
      meta_post_error: v.optional(v.string()),
      meta_post_path: v.optional(v.string()),
    }),
  },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("ad_sets")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!doc) throw new Error("Ad set not found");
    const updates: Record<string, any> = { ...args.fields, updated_at: new Date().toISOString() };
    await ctx.db.patch(doc._id, updates);
  },
});

// Phase 1 — Staging Page queries

export const getByProjectAndLifecycle = query({
  args: { projectId: v.string(), lifecycle_status: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("ad_sets")
      .withIndex("by_project_and_lifecycle", (q) =>
        q.eq("project_id", args.projectId).eq("lifecycle_status", args.lifecycle_status)
      )
      .collect();
  },
});

export const getByAngle = query({
  args: { angle_id: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("ad_sets")
      .withIndex("by_angle", (q) => q.eq("angle_id", args.angle_id))
      .collect();
  },
});

export const remove = mutation({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("ad_sets")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!doc) throw new Error("Ad set not found");

    // Cascade: soft-delete child flex ads
    const flexAds = await ctx.db
      .query("flex_ads")
      .withIndex("by_ad_set", (q) => q.eq("ad_set_id", args.externalId))
      .collect();
    for (const fa of flexAds) {
      if (!fa.deleted_at) {
        await ctx.db.patch(fa._id, { deleted_at: new Date().toISOString() });
      }
    }

    await ctx.db.delete(doc._id);
  },
});

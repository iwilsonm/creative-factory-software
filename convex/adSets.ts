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
      // Phase 3 — observation pause/resume + window extension
      observation_paused_at: v.optional(v.string()),
      observation_paused_total_ms: v.optional(v.number()),
      extension_days: v.optional(v.number()),
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

// Phase 3 — atomic post-success transition
// Called by metaWriter after a successful Meta post: flips lifecycle to
// "observing", stamps posted_at, and stores the Meta-side ad set id all in
// one mutation so there's no ambiguous in-between state.
export const markObserving = mutation({
  args: {
    externalId: v.string(),
    posted_at: v.string(),
    meta_adset_id: v.string(),
    meta_campaign_id: v.optional(v.string()),
    meta_post_path: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("ad_sets")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!doc) throw new Error("Ad set not found");
    const updates: Record<string, any> = {
      lifecycle_status: "observing",
      posted_at: args.posted_at,
      meta_adset_id: args.meta_adset_id,
      updated_at: new Date().toISOString(),
    };
    if (args.meta_campaign_id !== undefined) updates.meta_campaign_id = args.meta_campaign_id;
    if (args.meta_post_path !== undefined) updates.meta_post_path = args.meta_post_path;
    await ctx.db.patch(doc._id, updates);
  },
});

// Phase 3 — set terminal lifecycle (passed | failed | failed_external | insufficient_data)
export const setLifecycleTerminal = mutation({
  args: {
    externalId: v.string(),
    verdict: v.string(),
  },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("ad_sets")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!doc) throw new Error("Ad set not found");
    const allowed = ["passed", "failed", "failed_external", "insufficient_data"];
    if (!allowed.includes(args.verdict)) {
      throw new Error(`Invalid terminal verdict: ${args.verdict}`);
    }
    await ctx.db.patch(doc._id, {
      lifecycle_status: args.verdict,
      updated_at: new Date().toISOString(),
    });
  },
});

// Phase 3 — pause observation (day counter halts).
export const pauseObservation = mutation({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("ad_sets")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!doc) throw new Error("Ad set not found");
    if (doc.observation_paused_at) return; // already paused
    await ctx.db.patch(doc._id, {
      observation_paused_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  },
});

// Phase 3 — resume observation. Adds the elapsed pause duration to total.
export const resumeObservation = mutation({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("ad_sets")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!doc) throw new Error("Ad set not found");
    if (!doc.observation_paused_at) return; // not paused
    const pausedAtMs = new Date(doc.observation_paused_at).getTime();
    const additional = Math.max(0, Date.now() - pausedAtMs);
    const total = (doc.observation_paused_total_ms || 0) + additional;
    await ctx.db.patch(doc._id, {
      observation_paused_at: undefined,
      observation_paused_total_ms: total,
      updated_at: new Date().toISOString(),
    });
  },
});

// Phase 3 — extend observation window by N additional days.
export const extendObservation = mutation({
  args: { externalId: v.string(), additional_days: v.number() },
  handler: async (ctx, args) => {
    if (args.additional_days <= 0 || args.additional_days > 60) {
      throw new Error("additional_days must be between 1 and 60");
    }
    const doc = await ctx.db
      .query("ad_sets")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!doc) throw new Error("Ad set not found");
    const current = doc.extension_days || 0;
    await ctx.db.patch(doc._id, {
      extension_days: current + args.additional_days,
      // Resurface from terminal if the user is asking for more time after a verdict
      lifecycle_status: doc.lifecycle_status === "observing" ? "observing" : "observing",
      updated_at: new Date().toISOString(),
    });
  },
});

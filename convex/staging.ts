// Phase 1 — Staging Page mutations + queries.
// Higher-level operations that span ad_sets + ad_creatives (promote, regroup, create-empty).
// Field-level updates on individual entities live in adSets.ts and adCreatives.ts.

import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

// List ad sets currently in "staging" lifecycle for a project, with their member ads.
export const getPendingByProject = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    const adSets = await ctx.db
      .query("ad_sets")
      .withIndex("by_project_and_lifecycle", (q) =>
        q.eq("project_id", args.projectId).eq("lifecycle_status", "staging")
      )
      .collect();

    // Pull member ads per set
    const result = [];
    for (const adSet of adSets) {
      const ads = await ctx.db
        .query("ad_creatives")
        .withIndex("by_ad_set", (q) => q.eq("ad_set_id", adSet.externalId))
        .collect();
      // Only include ads that are currently in "staging" status (passed Filter)
      const stagingAds = ads.filter((a) => a.status === "staging");
      result.push({ adSet, ads: stagingAds });
    }
    return result;
  },
});

// List ad sets visible in Ready-to-Post / posted history views.
// Phase 6 introduced the "ready" lifecycle for ad sets created directly by
// Creative Director. Keep "promoted" as a legacy alias and "posted" for history.
export const getPromotedByProject = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    const allSets = await ctx.db
      .query("ad_sets")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .collect();
    return allSets.filter(
      (s) => s.lifecycle_status === "ready" || s.lifecycle_status === "promoted" || s.lifecycle_status === "posted"
    );
  },
});

// Promote an ad set: staging → promoted. Moves it to Ready-to-Post.
export const promote = mutation({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const adSet = await ctx.db
      .query("ad_sets")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!adSet) throw new Error("Ad set not found");
    if (adSet.lifecycle_status !== "staging") {
      throw new Error(
        `Cannot promote ad set with lifecycle "${adSet.lifecycle_status}" — only "staging" is eligible`
      );
    }
    await ctx.db.patch(adSet._id, {
      lifecycle_status: "promoted",
      updated_at: new Date().toISOString(),
    });
  },
});

// Create an empty ad set on the Staging Page (for regroup-into-new flows).
// Inherits campaign + Meta settings from project defaults. Legacy API routes
// still require angle_id where Director/staging semantics need it.
export const createEmptyAdSet = mutation({
  args: {
    externalId: v.string(),
    project_id: v.string(),
    campaign_id: v.string(),
    angle_id: v.optional(v.string()),
    name: v.string(),
    sort_order: v.number(),
    // Meta defaults pulled from project at call site; passed through
    meta_targeting: v.optional(v.string()),
    meta_budget_type: v.optional(v.string()),
    meta_budget_amount_cents: v.optional(v.number()),
    meta_schedule: v.optional(v.string()),
    meta_optimization_goal: v.optional(v.string()),
    meta_billing_event: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    await ctx.db.insert("ad_sets", {
      externalId: args.externalId,
      project_id: args.project_id,
      campaign_id: args.campaign_id,
      ...(args.angle_id ? { angle_id: args.angle_id } : {}),
      name: args.name,
      sort_order: args.sort_order,
      lifecycle_status: "staging",
      meta_targeting: args.meta_targeting,
      meta_budget_type: args.meta_budget_type,
      meta_budget_amount_cents: args.meta_budget_amount_cents,
      meta_schedule: args.meta_schedule,
      meta_optimization_goal: args.meta_optimization_goal,
      meta_billing_event: args.meta_billing_event,
      created_at: now,
      updated_at: now,
    });
  },
});

// Regroup ads: move N ads to a target ad set (existing or new-id provided by caller).
// Caller is responsible for creating the target ad set first via createEmptyAdSet if new.
// Per the plan's regroup semantics: moved ads inherit the destination ad set's angle.
export const regroupAds = mutation({
  args: {
    adIds: v.array(v.string()),
    targetAdSetId: v.string(),
  },
  handler: async (ctx, args) => {
    const target = await ctx.db
      .query("ad_sets")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.targetAdSetId))
      .first();
    if (!target) throw new Error("Target ad set not found");
    if (target.lifecycle_status !== "staging") {
      throw new Error(
        `Cannot regroup into ad set with lifecycle "${target.lifecycle_status}" — only "staging" accepts new members`
      );
    }

    for (const adId of args.adIds) {
      const ad = await ctx.db
        .query("ad_creatives")
        .withIndex("by_externalId", (q) => q.eq("externalId", adId))
        .first();
      if (!ad) continue; // skip missing ads silently
      await ctx.db.patch(ad._id, {
        ad_set_id: args.targetAdSetId,
      });
    }
  },
});

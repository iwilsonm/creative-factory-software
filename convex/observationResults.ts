// Phase 3 — Terminal observation verdicts.
// One row per ad set's first terminal evaluation; manual overrides
// write a NEW row that points back via replaces_external_id.

import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const getByProject = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("observation_results")
      .withIndex("by_project_and_created", (q) => q.eq("project_id", args.projectId))
      .collect();
  },
});

// All results for a single ad set (most-recent first). UI shows the latest;
// overrides are visible via the replaces_external_id chain.
export const getByAdSet = query({
  args: { ad_set_id: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("observation_results")
      .withIndex("by_ad_set", (q) => q.eq("ad_set_id", args.ad_set_id))
      .collect();
    return rows.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  },
});

// All terminal results for an angle, ordered by observed_through ASC.
// Used by the angle archiver to compute consecutive failures.
export const getByAngle = query({
  args: { angle_id: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("observation_results")
      .withIndex("by_angle", (q) => q.eq("angle_id", args.angle_id))
      .collect();
    return rows.sort((a, b) => (a.observed_through < b.observed_through ? -1 : 1));
  },
});

// Returns the FIRST non-manual terminal verdict for this ad set, or null.
// Used as a uniqueness guard — cron should not write a duplicate terminal.
export const getTerminalByAdSet = query({
  args: { ad_set_id: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("observation_results")
      .withIndex("by_ad_set", (q) => q.eq("ad_set_id", args.ad_set_id))
      .collect();
    return rows.find((r) => !r.verdict.startsWith("manual_")) || null;
  },
});

// Cron writes the initial terminal verdict. Idempotent — if a non-manual
// result already exists for this ad set, returns the existing externalId
// and does NOT insert.
export const create = mutation({
  args: {
    externalId: v.string(),
    project_id: v.string(),
    ad_set_id: v.string(),
    angle_id: v.optional(v.string()),
    posted_at: v.string(),
    observed_through: v.string(),
    days_observed: v.number(),
    verdict: v.string(),
    fail_reason_code: v.optional(v.string()),
    spend: v.number(),
    impressions: v.number(),
    clicks: v.number(),
    ctr: v.number(),
    roas: v.optional(v.number()),
    cpa: v.optional(v.number()),
    conversions: v.optional(v.number()),
    benchmark_used: v.string(),
    benchmark_version: v.number(),
    reason: v.string(),
    evaluated_by: v.string(),
    account_currency: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("observation_results")
      .withIndex("by_ad_set", (q) => q.eq("ad_set_id", args.ad_set_id))
      .collect();
    const nonManual = existing.find((r) => !r.verdict.startsWith("manual_"));
    if (nonManual) return nonManual.externalId; // idempotent
    await ctx.db.insert("observation_results", {
      ...args,
      created_at: new Date().toISOString(),
    });
    return args.externalId;
  },
});

// Manual override — always writes a new row, optionally pointing to the
// row it replaces. Verdicts must be "manual_passed" or "manual_failed".
export const createManualOverride = mutation({
  args: {
    externalId: v.string(),
    project_id: v.string(),
    ad_set_id: v.string(),
    angle_id: v.optional(v.string()),
    posted_at: v.string(),
    observed_through: v.string(),
    days_observed: v.number(),
    verdict: v.string(),
    spend: v.number(),
    impressions: v.number(),
    clicks: v.number(),
    ctr: v.number(),
    roas: v.optional(v.number()),
    cpa: v.optional(v.number()),
    conversions: v.optional(v.number()),
    benchmark_used: v.string(),
    benchmark_version: v.number(),
    reason: v.string(),
    evaluated_by: v.string(),
    account_currency: v.string(),
    replaces_external_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.verdict !== "manual_passed" && args.verdict !== "manual_failed") {
      throw new Error("verdict must be 'manual_passed' or 'manual_failed'");
    }
    await ctx.db.insert("observation_results", {
      ...args,
      created_at: new Date().toISOString(),
    });
  },
});

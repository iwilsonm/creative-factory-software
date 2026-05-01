// Phase 3 — Daily metric snapshots per observing ad set.
// Cron upserts one row per (ad_set_id, day_index). Idempotent.

import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const getByAdSet = query({
  args: { ad_set_id: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("observation_snapshots")
      .withIndex("by_ad_set", (q) => q.eq("ad_set_id", args.ad_set_id))
      .collect();
  },
});

// Upsert a single day's snapshot. If a row already exists for
// (ad_set_id, day_index), patch it; otherwise insert. Cron-safe.
export const upsertByAdSetAndDay = mutation({
  args: {
    externalId: v.string(),
    project_id: v.string(),
    ad_set_id: v.string(),
    meta_adset_id: v.string(),
    day_index: v.number(),
    snapshot_at: v.string(),
    spend: v.number(),
    impressions: v.number(),
    clicks: v.number(),
    ctr: v.number(),
    cpm: v.number(),
    cpc: v.number(),
    roas: v.optional(v.number()),
    cpa: v.optional(v.number()),
    conversions: v.optional(v.number()),
    raw_insights: v.optional(v.string()),
    account_currency: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("observation_snapshots")
      .withIndex("by_ad_set_and_day", (q) =>
        q.eq("ad_set_id", args.ad_set_id).eq("day_index", args.day_index)
      )
      .first();
    if (existing) {
      const { externalId, ...patch } = args;
      await ctx.db.patch(existing._id, patch);
    } else {
      await ctx.db.insert("observation_snapshots", args);
    }
  },
});

// Cleanup phase — delete snapshots older than the given ISO timestamp
// for ad sets whose lifecycle is terminal. Returns count purged.
export const purgeOlderThan = mutation({
  args: { cutoff_iso: v.string() },
  handler: async (ctx, args) => {
    const stale = await ctx.db
      .query("observation_snapshots")
      .filter((q) => q.lt(q.field("snapshot_at"), args.cutoff_iso))
      .collect();
    let count = 0;
    for (const row of stale) {
      // Only purge if the parent ad set is in a terminal lifecycle.
      const adSet = await ctx.db
        .query("ad_sets")
        .withIndex("by_externalId", (q) => q.eq("externalId", row.ad_set_id))
        .first();
      const terminal = ["passed", "failed", "failed_external", "insufficient_data"].includes(
        adSet?.lifecycle_status || ""
      );
      if (terminal) {
        await ctx.db.delete(row._id);
        count += 1;
      }
    }
    return count;
  },
});

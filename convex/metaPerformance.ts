import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

// ── Queries ─────────────────────────────────────────────────────────────────

export const getByDeployment = query({
  args: { deploymentId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("meta_performance")
      .withIndex("by_deployment", (q) => q.eq("deployment_id", args.deploymentId))
      .collect();
    rows.sort((a, b) => a.date.localeCompare(b.date));
    return rows;
  },
});

export const getByMetaAdId = query({
  args: { metaAdId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("meta_performance")
      .withIndex("by_meta_ad_id", (q) => q.eq("meta_ad_id", args.metaAdId))
      .collect();
    rows.sort((a, b) => a.date.localeCompare(b.date));
    return rows;
  },
});

// ── Mutations ───────────────────────────────────────────────────────────────

export const upsert = mutation({
  args: {
    externalId: v.string(),
    deployment_id: v.string(),
    meta_ad_id: v.string(),
    date: v.string(),
    impressions: v.number(),
    clicks: v.number(),
    spend: v.number(),
    reach: v.number(),
    ctr: v.number(),
    cpc: v.number(),
    cpm: v.number(),
    conversions: v.number(),
    conversion_value: v.number(),
    frequency: v.number(),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();

    // Check if row already exists for this meta_ad_id + date
    const existing = await ctx.db
      .query("meta_performance")
      .withIndex("by_meta_ad_and_date", (q) =>
        q.eq("meta_ad_id", args.meta_ad_id).eq("date", args.date)
      )
      .first();

    if (existing) {
      // Update existing row
      await ctx.db.patch(existing._id, {
        deployment_id: args.deployment_id,
        impressions: args.impressions,
        clicks: args.clicks,
        spend: args.spend,
        reach: args.reach,
        ctr: args.ctr,
        cpc: args.cpc,
        cpm: args.cpm,
        conversions: args.conversions,
        conversion_value: args.conversion_value,
        frequency: args.frequency,
        updated_at: now,
      });
    } else {
      // Insert new row
      await ctx.db.insert("meta_performance", {
        externalId: args.externalId,
        deployment_id: args.deployment_id,
        meta_ad_id: args.meta_ad_id,
        date: args.date,
        impressions: args.impressions,
        clicks: args.clicks,
        spend: args.spend,
        reach: args.reach,
        ctr: args.ctr,
        cpc: args.cpc,
        cpm: args.cpm,
        conversions: args.conversions,
        conversion_value: args.conversion_value,
        frequency: args.frequency,
        updated_at: now,
      });
    }
  },
});

export const removeByDeployment = mutation({
  args: { deploymentId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("meta_performance")
      .withIndex("by_deployment", (q) => q.eq("deployment_id", args.deploymentId))
      .collect();
    for (const row of rows) {
      await ctx.db.delete(row._id);
    }
    return rows.length;
  },
});

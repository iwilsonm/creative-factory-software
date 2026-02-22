import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const getAll = query({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("ad_deployments").collect();
    return all.filter((d) => !d.deleted_at);
  },
});

export const getByProject = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    const all = await ctx.db
      .query("ad_deployments")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .collect();
    return all.filter((d) => !d.deleted_at);
  },
});

export const getByStatus = query({
  args: { status: v.string() },
  handler: async (ctx, args) => {
    const all = await ctx.db
      .query("ad_deployments")
      .withIndex("by_status", (q) => q.eq("status", args.status))
      .collect();
    return all.filter((d) => !d.deleted_at);
  },
});

export const getByAdId = query({
  args: { adId: v.string() },
  handler: async (ctx, args) => {
    const all = await ctx.db
      .query("ad_deployments")
      .withIndex("by_ad_id", (q) => q.eq("ad_id", args.adId))
      .collect();
    // Only return active (non-deleted) deployments for dedup checks
    const active = all.filter((d) => !d.deleted_at);
    return active[0] || null;
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
    local_campaign_id: v.optional(v.string()),
    created_at: v.string(),
  },
  handler: async (ctx, args) => {
    // Dedup guard: skip if this ad is already deployed (ignore soft-deleted)
    const existing = await ctx.db
      .query("ad_deployments")
      .withIndex("by_ad_id", (q) => q.eq("ad_id", args.ad_id))
      .collect();
    const active = existing.filter((d) => !d.deleted_at);
    if (active.length > 0) return null;
    return await ctx.db.insert("ad_deployments", args);
  },
});

export const createWithoutDedup = mutation({
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
    local_campaign_id: v.optional(v.string()),
    local_adset_id: v.optional(v.string()),
    flex_ad_id: v.optional(v.string()),
    destination_url: v.optional(v.string()),
    cta_button: v.optional(v.string()),
    primary_texts: v.optional(v.string()),
    ad_headlines: v.optional(v.string()),
    created_at: v.string(),
  },
  handler: async (ctx, args) => {
    // No dedup guard — allows duplicating same ad_id
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
      local_campaign_id: v.optional(v.string()),
      local_adset_id: v.optional(v.string()),
      flex_ad_id: v.optional(v.string()),
      primary_texts: v.optional(v.string()),
      ad_headlines: v.optional(v.string()),
      destination_url: v.optional(v.string()),
      cta_button: v.optional(v.string()),
      facebook_page: v.optional(v.string()),
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

// Soft delete — sets deleted_at instead of removing
export const remove = mutation({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("ad_deployments")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!doc) return; // Already deleted — no-op
    await ctx.db.patch(doc._id, { deleted_at: new Date().toISOString() });
  },
});

// Restore a soft-deleted deployment
export const restore = mutation({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("ad_deployments")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!doc) throw new Error("Deployment not found");
    await ctx.db.patch(doc._id, { deleted_at: "" });
  },
});

// Get soft-deleted deployments (for recovery UI)
export const getDeleted = query({
  args: { projectId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    let results;
    if (args.projectId) {
      results = await ctx.db
        .query("ad_deployments")
        .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
        .collect();
    } else {
      results = await ctx.db.query("ad_deployments").collect();
    }
    return results.filter((d) => !!d.deleted_at);
  },
});

// Hard delete records soft-deleted more than N days ago
export const purgeDeleted = mutation({
  args: { olderThanDays: v.number() },
  handler: async (ctx, args) => {
    const cutoff = new Date(
      Date.now() - args.olderThanDays * 24 * 60 * 60 * 1000
    ).toISOString();
    const all = await ctx.db.query("ad_deployments").collect();
    const toPurge = all.filter((d) => d.deleted_at && d.deleted_at < cutoff);
    let purged = 0;
    for (const doc of toPurge) {
      await ctx.db.delete(doc._id);
      purged++;
    }
    return purged;
  },
});

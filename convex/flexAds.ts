import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const getByProject = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    const all = await ctx.db
      .query("flex_ads")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .collect();
    return all.filter((f) => !f.deleted_at);
  },
});

export const getByAdSet = query({
  args: { adSetId: v.string() },
  handler: async (ctx, args) => {
    const all = await ctx.db
      .query("flex_ads")
      .withIndex("by_ad_set", (q) => q.eq("ad_set_id", args.adSetId))
      .collect();
    return all.filter((f) => !f.deleted_at);
  },
});

export const getByExternalId = query({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("flex_ads")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!doc || doc.deleted_at) return null;
    return doc;
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
    display_link: v.optional(v.string()),
    cta_button: v.optional(v.string()),
    planned_date: v.optional(v.string()),
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
      display_link: v.optional(v.string()),
      cta_button: v.optional(v.string()),
      facebook_page: v.optional(v.string()),
      planned_date: v.optional(v.string()),
      posted_by: v.optional(v.string()),
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

// Soft delete — sets deleted_at instead of removing
export const remove = mutation({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("flex_ads")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!doc) return; // Already deleted — no-op
    await ctx.db.patch(doc._id, { deleted_at: new Date().toISOString() });
  },
});

// Restore a soft-deleted flex ad
export const restore = mutation({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("flex_ads")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!doc) throw new Error("Flex ad not found");
    await ctx.db.patch(doc._id, { deleted_at: "" });
  },
});

// Hard delete records soft-deleted more than N days ago
export const purgeDeleted = mutation({
  args: { olderThanDays: v.number() },
  handler: async (ctx, args) => {
    const cutoff = new Date(
      Date.now() - args.olderThanDays * 24 * 60 * 60 * 1000
    ).toISOString();
    const all = await ctx.db.query("flex_ads").collect();
    const toPurge = all.filter((f) => f.deleted_at && f.deleted_at < cutoff);
    let purged = 0;
    for (const doc of toPurge) {
      await ctx.db.delete(doc._id);
      purged++;
    }
    return purged;
  },
});

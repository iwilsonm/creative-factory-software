import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const getByProject = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("ad_creatives")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .order("desc")
      .collect();
  },
});

export const getByProjectWithUrls = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    const ads = await ctx.db
      .query("ad_creatives")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .order("desc")
      .collect();
    return Promise.all(
      ads.map(async (ad) => ({
        ...ad,
        resolvedImageUrl: ad.storageId
          ? await ctx.storage.getUrl(ad.storageId)
          : null,
      }))
    );
  },
});

export const getByExternalId = query({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("ad_creatives")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
  },
});

export const create = mutation({
  args: {
    externalId: v.string(),
    project_id: v.string(),
    generation_mode: v.string(),
    angle: v.optional(v.string()),
    headline: v.optional(v.string()),
    body_copy: v.optional(v.string()),
    image_prompt: v.optional(v.string()),
    gpt_creative_output: v.optional(v.string()),
    template_image_id: v.optional(v.string()),
    inspiration_image_id: v.optional(v.string()),
    storageId: v.optional(v.id("_storage")),
    drive_file_id: v.optional(v.string()),
    drive_url: v.optional(v.string()),
    aspect_ratio: v.optional(v.string()),
    status: v.optional(v.string()),
    auto_generated: v.optional(v.boolean()),
    parent_ad_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    await ctx.db.insert("ad_creatives", {
      ...args,
      created_at: now,
    });
  },
});

export const update = mutation({
  args: {
    externalId: v.string(),
    status: v.optional(v.string()),
    image_prompt: v.optional(v.string()),
    gpt_creative_output: v.optional(v.string()),
    headline: v.optional(v.string()),
    body_copy: v.optional(v.string()),
    storageId: v.optional(v.id("_storage")),
    drive_file_id: v.optional(v.string()),
    drive_url: v.optional(v.string()),
    inspiration_image_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const ad = await ctx.db
      .query("ad_creatives")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!ad) throw new Error("Ad creative not found");

    const { externalId, ...updates } = args;
    const filtered: Record<string, any> = {};
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) filtered[key] = value;
    }
    await ctx.db.patch(ad._id, filtered);
  },
});

export const remove = mutation({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const ad = await ctx.db
      .query("ad_creatives")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!ad) throw new Error("Ad creative not found");
    // If has a storageId, delete the stored file too
    if (ad.storageId) {
      await ctx.storage.delete(ad.storageId);
    }
    await ctx.db.delete(ad._id);
  },
});

// Lightweight query for "already used" context — returns only text fields, no storage URLs.
// Uses .take() instead of .collect() to avoid loading the entire table into memory.
export const getRecentByProjectAndAngle = query({
  args: {
    projectId: v.string(),
    angle: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit || 10;
    // Fetch a generous window of recent ads (most will be completed).
    // We fetch 5x the limit to account for non-completed/non-matching entries.
    const ads = await ctx.db
      .query("ad_creatives")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .order("desc")
      .take(limit * 5);

    const result: { image_prompt: string | null; headline: string | null; angle: string | null; body_copy: string | null }[] = [];
    for (const ad of ads) {
      if (result.length >= limit) break;
      if (ad.status !== "completed") continue;
      if (args.angle && ad.angle !== args.angle) continue;
      result.push({
        image_prompt: ad.image_prompt || null,
        headline: ad.headline || null,
        angle: ad.angle || null,
        body_copy: ad.body_copy || null,
      });
    }
    return result;
  },
});

export const getImageUrl = query({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const ad = await ctx.db
      .query("ad_creatives")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!ad || !ad.storageId) return null;
    return await ctx.storage.getUrl(ad.storageId);
  },
});

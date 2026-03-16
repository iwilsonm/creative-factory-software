import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { adjustProjectCounters } from "./projects";

export const getAll = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("ad_creatives").collect();
  },
});

export const getByProject = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("ad_creatives")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .order("desc")
      .take(1000);
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

export const getGalleryByProject = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    const ads = await ctx.db
      .query("ad_creatives")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .order("desc")
      .take(500);

    return ads.map((ad) => ({
      externalId: ad.externalId,
      project_id: ad.project_id,
      generation_mode: ad.generation_mode,
      angle: ad.angle,
      angle_name: ad.angle_name,
      headline: ad.headline,
      body_copy: ad.body_copy,
      hook_lane: ad.hook_lane,
      core_claim: ad.core_claim,
      target_symptom: ad.target_symptom,
      emotional_entry: ad.emotional_entry,
      desired_belief_shift: ad.desired_belief_shift,
      opening_pattern: ad.opening_pattern,
      scoring_mode: ad.scoring_mode,
      copy_render_expectation: ad.copy_render_expectation,
      product_expectation: ad.product_expectation,
      sub_angle: ad.sub_angle,
      template_image_id: ad.template_image_id,
      storageId: ad.storageId,
      aspect_ratio: ad.aspect_ratio,
      status: ad.status,
      auto_generated: ad.auto_generated,
      parent_ad_id: ad.parent_ad_id,
      tags: ad.tags,
      is_favorite: ad.is_favorite,
      source_quote_id: ad.source_quote_id,
      drive_file_id: ad.drive_file_id,
      drive_url: ad.drive_url,
      has_image_prompt: !!ad.image_prompt,
      batch_job_id: ad.batch_job_id,
      created_at: ad.created_at,
    }));
  },
});

export const getInProgressByProject = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    const ads = await ctx.db
      .query("ad_creatives")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .take(500);
    return ads.filter(
      (ad) => ad.status === "generating_copy" || ad.status === "generating_image"
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

export const getSummariesByExternalIds = query({
  args: { externalIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    const uniqueExternalIds = [...new Set(args.externalIds)].slice(0, 500);

    const ads = await Promise.all(
      uniqueExternalIds.map((externalId) =>
        ctx.db
          .query("ad_creatives")
          .withIndex("by_externalId", (q) => q.eq("externalId", externalId))
          .first()
      )
    );

    return ads.filter(Boolean).map((ad) => ({
      externalId: ad!.externalId,
      project_id: ad!.project_id,
      angle: ad!.angle,
      angle_name: ad!.angle_name,
      headline: ad!.headline,
      body_copy: ad!.body_copy,
      hook_lane: ad!.hook_lane,
      core_claim: ad!.core_claim,
      tags: ad!.tags || [],
      has_image: !!ad!.storageId,
    }));
  },
});

export const create = mutation({
  args: {
    externalId: v.string(),
    project_id: v.string(),
    generation_mode: v.string(),
    angle: v.optional(v.string()),
    angle_name: v.optional(v.string()),
    headline: v.optional(v.string()),
    body_copy: v.optional(v.string()),
    hook_lane: v.optional(v.string()),
    core_claim: v.optional(v.string()),
    target_symptom: v.optional(v.string()),
    emotional_entry: v.optional(v.string()),
    desired_belief_shift: v.optional(v.string()),
    opening_pattern: v.optional(v.string()),
    scoring_mode: v.optional(v.string()),
    copy_render_expectation: v.optional(v.string()),
    product_expectation: v.optional(v.string()),
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
    source_quote_id: v.optional(v.string()),
    batch_job_id: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    sub_angle: v.optional(v.string()),
    text_model: v.optional(v.string()),
    image_model: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    await ctx.db.insert("ad_creatives", {
      ...args,
      created_at: now,
    });
    await adjustProjectCounters(ctx, args.project_id, { adCount: 1 });
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
    angle_name: v.optional(v.string()),
    hook_lane: v.optional(v.string()),
    core_claim: v.optional(v.string()),
    target_symptom: v.optional(v.string()),
    emotional_entry: v.optional(v.string()),
    desired_belief_shift: v.optional(v.string()),
    opening_pattern: v.optional(v.string()),
    scoring_mode: v.optional(v.string()),
    copy_render_expectation: v.optional(v.string()),
    product_expectation: v.optional(v.string()),
    sub_angle: v.optional(v.string()),
    storageId: v.optional(v.id("_storage")),
    drive_file_id: v.optional(v.string()),
    drive_url: v.optional(v.string()),
    inspiration_image_id: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    is_favorite: v.optional(v.boolean()),
    text_model: v.optional(v.string()),
    image_model: v.optional(v.string()),
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
    await adjustProjectCounters(ctx, ad.project_id, { adCount: -1 });
  },
});

// Get ads that have a source_quote_id (linked to quote bank)
export const getByProjectWithSourceQuote = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    const ads = await ctx.db
      .query("ad_creatives")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .collect();
    return ads.filter((ad) => ad.source_quote_id);
  },
});

// Get all ads generated by a specific batch job
export const getByBatch = query({
  args: { batchId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("ad_creatives")
      .withIndex("by_batch_job", (q) => q.eq("batch_job_id", args.batchId))
      .collect();
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

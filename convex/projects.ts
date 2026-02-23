import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const create = mutation({
  args: {
    externalId: v.string(),
    name: v.string(),
    brand_name: v.optional(v.string()),
    niche: v.optional(v.string()),
    product_description: v.optional(v.string()),
    sales_page_content: v.optional(v.string()),
    drive_folder_id: v.optional(v.string()),
    inspiration_folder_id: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    await ctx.db.insert("projects", {
      ...args,
      status: "setup",
      created_at: now,
      updated_at: now,
    });
  },
});

export const getByExternalId = query({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("projects")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
  },
});

export const getAll = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("projects").order("desc").collect();
  },
});

export const update = mutation({
  args: {
    externalId: v.string(),
    name: v.optional(v.string()),
    brand_name: v.optional(v.string()),
    niche: v.optional(v.string()),
    product_description: v.optional(v.string()),
    sales_page_content: v.optional(v.string()),
    drive_folder_id: v.optional(v.string()),
    inspiration_folder_id: v.optional(v.string()),
    prompt_guidelines: v.optional(v.string()),
    status: v.optional(v.string()),
    // Meta Ads (per-project — each project has its own Meta App + OAuth)
    meta_app_id: v.optional(v.string()),
    meta_app_secret: v.optional(v.string()),
    meta_access_token: v.optional(v.string()),
    meta_token_expires_at: v.optional(v.string()),
    meta_ad_account_id: v.optional(v.string()),
    meta_user_name: v.optional(v.string()),
    meta_user_id: v.optional(v.string()),
    meta_last_sync_at: v.optional(v.string()),
    // Dacia Creative Filter (Recursive Agent #2)
    scout_enabled: v.optional(v.boolean()),
    scout_default_campaign: v.optional(v.string()),
    scout_cta: v.optional(v.string()),
    scout_display_link: v.optional(v.string()),
    scout_facebook_page: v.optional(v.string()),
    scout_score_threshold: v.optional(v.number()),
    scout_daily_flex_ads: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const project = await ctx.db
      .query("projects")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!project) throw new Error("Project not found");

    const { externalId, ...updates } = args;
    // Filter out undefined values
    const filtered: Record<string, any> = {};
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) filtered[key] = value;
    }
    filtered.updated_at = new Date().toISOString();
    await ctx.db.patch(project._id, filtered);
  },
});

export const remove = mutation({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const project = await ctx.db
      .query("projects")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!project) throw new Error("Project not found");
    await ctx.db.delete(project._id);
  },
});

export const setProductImage = mutation({
  args: {
    externalId: v.string(),
    storageId: v.optional(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    const project = await ctx.db
      .query("projects")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!project) throw new Error("Project not found");

    // Delete old image from storage if replacing
    if (project.product_image_storageId && project.product_image_storageId !== args.storageId) {
      try {
        await ctx.storage.delete(project.product_image_storageId);
      } catch {
        // Ignore if already deleted
      }
    }

    await ctx.db.patch(project._id, {
      product_image_storageId: args.storageId,
      updated_at: new Date().toISOString(),
    });
  },
});

export const getStats = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    const docs = await ctx.db
      .query("foundational_docs")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .collect();
    const ads = await ctx.db
      .query("ad_creatives")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .collect();
    const lps = await ctx.db
      .query("landing_pages")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .collect();
    return {
      docCount: docs.length,
      adCount: ads.length,
      lpCount: lps.length,
      lpPublishedCount: lps.filter((lp) => lp.status === "published").length,
    };
  },
});

// Combined query: get all projects with their stats in a single Convex execution
// Eliminates N+1 round-trips from VPS → Convex Cloud
export const getAllWithStats = query({
  args: {},
  handler: async (ctx) => {
    const projects = await ctx.db.query("projects").order("desc").collect();
    return Promise.all(
      projects.map(async (project) => {
        const docs = await ctx.db
          .query("foundational_docs")
          .withIndex("by_project", (q) => q.eq("project_id", project.externalId))
          .collect();
        const ads = await ctx.db
          .query("ad_creatives")
          .withIndex("by_project", (q) => q.eq("project_id", project.externalId))
          .collect();
        const lps = await ctx.db
          .query("landing_pages")
          .withIndex("by_project", (q) => q.eq("project_id", project.externalId))
          .collect();
        return {
          ...project,
          docCount: docs.length,
          adCount: ads.length,
          lpCount: lps.length,
          lpPublishedCount: lps.filter((lp) => lp.status === "published").length,
        };
      })
    );
  },
});

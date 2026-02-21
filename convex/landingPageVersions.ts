import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const getByLandingPage = query({
  args: { landingPageId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("landing_page_versions")
      .withIndex("by_landing_page", (q) => q.eq("landing_page_id", args.landingPageId))
      .collect();
  },
});

export const getByExternalId = query({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("landing_page_versions")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
  },
});

export const create = mutation({
  args: {
    externalId: v.string(),
    landing_page_id: v.string(),
    version: v.number(),
    copy_sections: v.string(),
    source: v.string(),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    await ctx.db.insert("landing_page_versions", {
      externalId: args.externalId,
      landing_page_id: args.landing_page_id,
      version: args.version,
      copy_sections: args.copy_sections,
      source: args.source,
      created_at: now,
    });
  },
});

export const remove = mutation({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("landing_page_versions")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!doc) throw new Error("Landing page version not found");
    await ctx.db.delete(doc._id);
  },
});

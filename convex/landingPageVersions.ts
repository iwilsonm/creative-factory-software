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
    image_slots: v.optional(v.string()),
    cta_links: v.optional(v.string()),
    html_template: v.optional(v.string()),
    assembled_html: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    const record: Record<string, any> = {
      externalId: args.externalId,
      landing_page_id: args.landing_page_id,
      version: args.version,
      copy_sections: args.copy_sections,
      source: args.source,
      created_at: now,
    };
    if (args.image_slots !== undefined) record.image_slots = args.image_slots;
    if (args.cta_links !== undefined) record.cta_links = args.cta_links;
    if (args.html_template !== undefined) record.html_template = args.html_template;
    if (args.assembled_html !== undefined) record.assembled_html = args.assembled_html;
    await ctx.db.insert("landing_page_versions", record);
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

import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const getByProject = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("landing_pages")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .collect();
  },
});

export const getByExternalId = query({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("landing_pages")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
  },
});

export const create = mutation({
  args: {
    externalId: v.string(),
    project_id: v.string(),
    name: v.string(),
    angle: v.optional(v.string()),
    word_count: v.optional(v.number()),
    additional_direction: v.optional(v.string()),
    swipe_text: v.optional(v.string()),
    swipe_filename: v.optional(v.string()),
    status: v.string(),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    await ctx.db.insert("landing_pages", {
      externalId: args.externalId,
      project_id: args.project_id,
      name: args.name,
      angle: args.angle,
      word_count: args.word_count,
      additional_direction: args.additional_direction,
      swipe_text: args.swipe_text,
      swipe_filename: args.swipe_filename,
      status: args.status,
      created_at: now,
      updated_at: now,
    });
  },
});

export const update = mutation({
  args: {
    externalId: v.string(),
    name: v.optional(v.string()),
    angle: v.optional(v.string()),
    word_count: v.optional(v.number()),
    additional_direction: v.optional(v.string()),
    swipe_text: v.optional(v.string()),
    swipe_filename: v.optional(v.string()),
    status: v.optional(v.string()),
    error_message: v.optional(v.string()),
    copy_sections: v.optional(v.string()),
    // Phase 2 fields
    swipe_design_analysis: v.optional(v.string()),
    image_slots: v.optional(v.string()),
    html_template: v.optional(v.string()),
    assembled_html: v.optional(v.string()),
    slug: v.optional(v.string()),
    cta_links: v.optional(v.string()),
    current_version: v.optional(v.number()),
    // Phase 4 publishing
    published_url: v.optional(v.string()),
    published_at: v.optional(v.string()),
    final_html: v.optional(v.string()),
    hosting_metadata: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("landing_pages")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!doc) throw new Error("Landing page not found");

    const updates: Record<string, any> = { updated_at: new Date().toISOString() };
    if (args.name !== undefined) updates.name = args.name;
    if (args.angle !== undefined) updates.angle = args.angle;
    if (args.word_count !== undefined) updates.word_count = args.word_count;
    if (args.additional_direction !== undefined) updates.additional_direction = args.additional_direction;
    if (args.swipe_text !== undefined) updates.swipe_text = args.swipe_text;
    if (args.swipe_filename !== undefined) updates.swipe_filename = args.swipe_filename;
    if (args.status !== undefined) updates.status = args.status;
    if (args.error_message !== undefined) updates.error_message = args.error_message;
    if (args.copy_sections !== undefined) updates.copy_sections = args.copy_sections;
    if (args.swipe_design_analysis !== undefined) updates.swipe_design_analysis = args.swipe_design_analysis;
    if (args.image_slots !== undefined) updates.image_slots = args.image_slots;
    if (args.html_template !== undefined) updates.html_template = args.html_template;
    if (args.assembled_html !== undefined) updates.assembled_html = args.assembled_html;
    if (args.slug !== undefined) updates.slug = args.slug;
    if (args.cta_links !== undefined) updates.cta_links = args.cta_links;
    if (args.current_version !== undefined) updates.current_version = args.current_version;
    if (args.published_url !== undefined) updates.published_url = args.published_url;
    if (args.published_at !== undefined) updates.published_at = args.published_at;
    if (args.final_html !== undefined) updates.final_html = args.final_html;
    if (args.hosting_metadata !== undefined) updates.hosting_metadata = args.hosting_metadata;
    await ctx.db.patch(doc._id, updates);
  },
});

export const remove = mutation({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("landing_pages")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!doc) throw new Error("Landing page not found");
    await ctx.db.delete(doc._id);
  },
});

import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const getByProject = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("sales_pages")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .collect();
  },
});

export const getByExternalId = query({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("sales_pages")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
  },
});

export const create = mutation({
  args: {
    externalId: v.string(),
    project_id: v.string(),
    name: v.string(),
    status: v.string(),
    product_brief: v.optional(v.string()),
    section_data: v.optional(v.string()),
    editorial_notes: v.optional(v.string()),
    generation_model: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    await ctx.db.insert("sales_pages", {
      externalId: args.externalId,
      project_id: args.project_id,
      name: args.name,
      status: args.status,
      product_brief: args.product_brief,
      section_data: args.section_data,
      editorial_notes: args.editorial_notes,
      generation_model: args.generation_model,
      created_at: now,
      updated_at: now,
    });
  },
});

export const update = mutation({
  args: {
    externalId: v.string(),
    name: v.optional(v.string()),
    status: v.optional(v.string()),
    product_brief: v.optional(v.string()),
    section_data: v.optional(v.string()),
    editorial_notes: v.optional(v.string()),
    published_url: v.optional(v.string()),
    published_at: v.optional(v.string()),
    shopify_page_id: v.optional(v.string()),
    shopify_theme_id: v.optional(v.string()),
    template_key: v.optional(v.string()),
    current_version: v.optional(v.number()),
    error_message: v.optional(v.string()),
    generation_model: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("sales_pages")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!doc) throw new Error("Sales page not found");

    const updates: Record<string, any> = {
      updated_at: new Date().toISOString(),
    };

    if (args.name !== undefined) updates.name = args.name;
    if (args.status !== undefined) updates.status = args.status;
    if (args.product_brief !== undefined) updates.product_brief = args.product_brief;
    if (args.section_data !== undefined) updates.section_data = args.section_data;
    if (args.editorial_notes !== undefined) updates.editorial_notes = args.editorial_notes;
    if (args.published_url !== undefined) updates.published_url = args.published_url;
    if (args.published_at !== undefined) updates.published_at = args.published_at;
    if (args.shopify_page_id !== undefined) updates.shopify_page_id = args.shopify_page_id;
    if (args.shopify_theme_id !== undefined) updates.shopify_theme_id = args.shopify_theme_id;
    if (args.template_key !== undefined) updates.template_key = args.template_key;
    if (args.current_version !== undefined) updates.current_version = args.current_version;
    if (args.error_message !== undefined) updates.error_message = args.error_message;
    if (args.generation_model !== undefined) updates.generation_model = args.generation_model;

    await ctx.db.patch(doc._id, updates);
  },
});

export const remove = mutation({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("sales_pages")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!doc) throw new Error("Sales page not found");

    // Cascade-delete all versions
    const versions = await ctx.db
      .query("sales_page_versions")
      .withIndex("by_sales_page", (q) => q.eq("sales_page_id", args.externalId))
      .collect();
    for (const version of versions) {
      await ctx.db.delete(version._id);
    }

    await ctx.db.delete(doc._id);
  },
});

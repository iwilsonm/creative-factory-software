import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const getBySalesPage = query({
  args: { salesPageId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("sales_page_versions")
      .withIndex("by_sales_page", (q) => q.eq("sales_page_id", args.salesPageId))
      .collect();
  },
});

export const getByExternalId = query({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("sales_page_versions")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
  },
});

export const create = mutation({
  args: {
    externalId: v.string(),
    sales_page_id: v.string(),
    version: v.number(),
    section_data: v.optional(v.string()),
    source: v.string(),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    const record: Record<string, any> = {
      externalId: args.externalId,
      sales_page_id: args.sales_page_id,
      version: args.version,
      source: args.source,
      created_at: now,
    };
    if (args.section_data !== undefined) record.section_data = args.section_data;
    await ctx.db.insert("sales_page_versions", record);
  },
});

export const removeByPage = mutation({
  args: { salesPageId: v.string() },
  handler: async (ctx, args) => {
    const versions = await ctx.db
      .query("sales_page_versions")
      .withIndex("by_sales_page", (q) => q.eq("sales_page_id", args.salesPageId))
      .collect();
    for (const version of versions) {
      await ctx.db.delete(version._id);
    }
  },
});

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

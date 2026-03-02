import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const getByProject = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("lp_templates")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .collect();
  },
});

export const getByExternalId = query({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("lp_templates")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
  },
});

export const create = mutation({
  args: {
    externalId: v.string(),
    project_id: v.string(),
    source_url: v.string(),
    name: v.string(),
    skeleton_html: v.string(),
    design_brief: v.string(),
    slot_definitions: v.string(),
    screenshot_storage_id: v.optional(v.string()),
    status: v.string(),
    error_message: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("lp_templates", {
      externalId: args.externalId,
      project_id: args.project_id,
      source_url: args.source_url,
      name: args.name,
      skeleton_html: args.skeleton_html,
      design_brief: args.design_brief,
      slot_definitions: args.slot_definitions,
      screenshot_storage_id: args.screenshot_storage_id,
      status: args.status,
      error_message: args.error_message,
      created_at: new Date().toISOString(),
    });
  },
});

export const update = mutation({
  args: {
    externalId: v.string(),
    name: v.optional(v.string()),
    skeleton_html: v.optional(v.string()),
    design_brief: v.optional(v.string()),
    slot_definitions: v.optional(v.string()),
    screenshot_storage_id: v.optional(v.string()),
    status: v.optional(v.string()),
    error_message: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("lp_templates")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!doc) throw new Error("LP template not found");

    const { externalId, ...updates } = args;
    const filtered: Record<string, any> = {};
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) filtered[key] = value;
    }
    await ctx.db.patch(doc._id, filtered);
  },
});

export const remove = mutation({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("lp_templates")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!doc) throw new Error("LP template not found");
    await ctx.db.delete(doc._id);
  },
});

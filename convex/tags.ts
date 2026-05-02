// Phase 5 — Project-scoped tags. Flat (no hierarchy). Color stored as hex.

import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const getByProject = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("tags")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .collect();
  },
});

export const create = mutation({
  args: {
    externalId: v.string(),
    project_id: v.string(),
    name: v.string(),
    color: v.string(),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    await ctx.db.insert("tags", { ...args, created_at: now, updated_at: now });
  },
});

export const update = mutation({
  args: {
    externalId: v.string(),
    name: v.optional(v.string()),
    color: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const tag = await ctx.db
      .query("tags")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!tag) throw new Error("Tag not found");
    const updates: Record<string, any> = { updated_at: new Date().toISOString() };
    if (args.name !== undefined) updates.name = args.name;
    if (args.color !== undefined) updates.color = args.color;
    await ctx.db.patch(tag._id, updates);
  },
});

// Removing a tag cascades — also delete every tag_assignment that references it.
export const remove = mutation({
  args: {
    externalId: v.string(),
    projectId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const tag = await ctx.db
      .query("tags")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!tag) return { deleted: false };
    if (args.projectId !== undefined && tag.project_id !== args.projectId) {
      throw new Error("Tag does not belong to this project");
    }
    const assignments = await ctx.db
      .query("tag_assignments")
      .withIndex("by_tag", (q) => q.eq("tag_id", args.externalId))
      .collect();
    for (const a of assignments) {
      await ctx.db.delete(a._id);
    }
    await ctx.db.delete(tag._id);
    return { deleted: true, assignmentsDeleted: assignments.length };
  },
});

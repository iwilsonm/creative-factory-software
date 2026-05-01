// Phase 5 — Saved Views for the Analytics tab.
// Scope = "private" (only owner sees) or "project" (all teammates see).

import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

// Returns views the given user can see: their own private views + all
// project-scoped views in the project.
export const getVisibleToUser = query({
  args: { projectId: v.string(), userId: v.string() },
  handler: async (ctx, args) => {
    const all = await ctx.db
      .query("analytics_saved_views")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .collect();
    return all.filter(
      (v) => v.scope === "project" || v.owner_user_id === args.userId
    );
  },
});

export const create = mutation({
  args: {
    externalId: v.string(),
    project_id: v.string(),
    owner_user_id: v.string(),
    scope: v.string(),
    name: v.string(),
    level: v.string(),
    config: v.string(),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    await ctx.db.insert("analytics_saved_views", {
      ...args,
      created_at: now,
      updated_at: now,
    });
  },
});

export const update = mutation({
  args: {
    externalId: v.string(),
    name: v.optional(v.string()),
    scope: v.optional(v.string()),
    level: v.optional(v.string()),
    config: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const view = await ctx.db
      .query("analytics_saved_views")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!view) throw new Error("View not found");
    const updates: Record<string, any> = { updated_at: new Date().toISOString() };
    if (args.name !== undefined) updates.name = args.name;
    if (args.scope !== undefined) updates.scope = args.scope;
    if (args.level !== undefined) updates.level = args.level;
    if (args.config !== undefined) updates.config = args.config;
    await ctx.db.patch(view._id, updates);
  },
});

export const remove = mutation({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const view = await ctx.db
      .query("analytics_saved_views")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!view) return;
    await ctx.db.delete(view._id);
  },
});

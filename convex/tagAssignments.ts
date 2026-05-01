// Phase 5 — Tag → entity associations (many-to-many).

import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const getByProjectAndEntityType = query({
  args: { projectId: v.string(), entity_type: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("tag_assignments")
      .withIndex("by_project_and_entity", (q) =>
        q.eq("project_id", args.projectId).eq("entity_type", args.entity_type)
      )
      .collect();
  },
});

export const getByEntity = query({
  args: { entity_id: v.string(), entity_type: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("tag_assignments")
      .withIndex("by_entity", (q) =>
        q.eq("entity_id", args.entity_id).eq("entity_type", args.entity_type)
      )
      .collect();
  },
});

// Upsert: skip create if the same (tag_id, entity_id, entity_type) tuple exists.
export const create = mutation({
  args: {
    externalId: v.string(),
    project_id: v.string(),
    tag_id: v.string(),
    entity_type: v.string(),
    entity_id: v.string(),
    entity_id_kind: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("tag_assignments")
      .withIndex("by_entity", (q) =>
        q.eq("entity_id", args.entity_id).eq("entity_type", args.entity_type)
      )
      .filter((q) => q.eq(q.field("tag_id"), args.tag_id))
      .first();
    if (existing) return; // idempotent
    await ctx.db.insert("tag_assignments", {
      ...args,
      created_at: new Date().toISOString(),
    });
  },
});

export const remove = mutation({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const assignment = await ctx.db
      .query("tag_assignments")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!assignment) return; // idempotent — no-op if already gone
    await ctx.db.delete(assignment._id);
  },
});

// Remove by composite (tag_id, entity_id, entity_type) — used by frontend
// when it has the tag + entity but not the assignment ID.
export const removeByEntityAndTag = mutation({
  args: {
    tag_id: v.string(),
    entity_id: v.string(),
    entity_type: v.string(),
  },
  handler: async (ctx, args) => {
    const assignment = await ctx.db
      .query("tag_assignments")
      .withIndex("by_entity", (q) =>
        q.eq("entity_id", args.entity_id).eq("entity_type", args.entity_type)
      )
      .filter((q) => q.eq(q.field("tag_id"), args.tag_id))
      .first();
    if (!assignment) return;
    await ctx.db.delete(assignment._id);
  },
});

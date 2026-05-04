import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const getByProjectAndEntityType = query({
  args: { projectId: v.string(), entity_type: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("entity_notes")
      .withIndex("by_project_and_entity", (q) =>
        q.eq("project_id", args.projectId).eq("entity_type", args.entity_type)
      )
      .collect();
  },
});

export const upsert = mutation({
  args: {
    externalId: v.string(),
    project_id: v.string(),
    entity_type: v.string(),
    entity_id: v.string(),
    entity_id_kind: v.string(),
    note: v.string(),
    updated_by: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    const existing = await ctx.db
      .query("entity_notes")
      .withIndex("by_entity", (q) =>
        q.eq("entity_id", args.entity_id).eq("entity_type", args.entity_type)
      )
      .filter((q) => q.eq(q.field("project_id"), args.project_id))
      .filter((q) => q.eq(q.field("entity_id_kind"), args.entity_id_kind))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        note: args.note,
        updated_by: args.updated_by,
        updated_at: now,
      });
      return existing.externalId;
    }

    await ctx.db.insert("entity_notes", {
      ...args,
      created_at: now,
      updated_at: now,
    });
    return args.externalId;
  },
});

export const appendMany = mutation({
  args: {
    externalIds: v.array(v.string()),
    project_id: v.string(),
    entity_type: v.string(),
    entity_ids: v.array(v.string()),
    entity_id_kind: v.string(),
    entry: v.string(),
    mode: v.optional(v.union(v.literal("append"), v.literal("replace"), v.literal("clear"))),
    updated_by: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    const changed: string[] = [];
    const mode = args.mode || "append";

    for (let i = 0; i < args.entity_ids.length; i += 1) {
      const entityId = args.entity_ids[i];
      const existing = await ctx.db
        .query("entity_notes")
        .withIndex("by_entity", (q) =>
          q.eq("entity_id", entityId).eq("entity_type", args.entity_type)
        )
        .filter((q) => q.eq(q.field("project_id"), args.project_id))
        .filter((q) => q.eq(q.field("entity_id_kind"), args.entity_id_kind))
        .first();

      if (existing) {
        const nextNote = mode === "append"
          ? (existing.note?.trim() ? `${existing.note.trim()}\n\n${args.entry}` : args.entry)
          : (mode === "clear" ? "" : args.entry);
        await ctx.db.patch(existing._id, {
          note: nextNote,
          updated_by: args.updated_by,
          updated_at: now,
        });
        changed.push(existing.externalId);
      } else if (mode !== "clear") {
        const externalId = args.externalIds[i];
        await ctx.db.insert("entity_notes", {
          externalId,
          project_id: args.project_id,
          entity_type: args.entity_type,
          entity_id: entityId,
          entity_id_kind: args.entity_id_kind,
          note: args.entry,
          updated_by: args.updated_by,
          created_at: now,
          updated_at: now,
        });
        changed.push(externalId);
      }
    }

    return { changed };
  },
});

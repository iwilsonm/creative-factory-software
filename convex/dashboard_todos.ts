import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const getAll = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("dashboard_todos").collect();
  },
});

export const replaceAll = mutation({
  args: { todos: v.string() },
  handler: async (ctx, args) => {
    // Delete all existing todos
    const existing = await ctx.db.query("dashboard_todos").collect();
    for (const row of existing) {
      await ctx.db.delete(row._id);
    }

    // Insert new todos
    const todos = JSON.parse(args.todos);
    for (const todo of todos) {
      await ctx.db.insert("dashboard_todos", {
        externalId: todo.id?.toString() || todo.externalId || String(Date.now()),
        text: todo.text || "",
        done: !!todo.done,
        author: todo.author || undefined,
        notes: todo.notes || undefined,
        priority: typeof todo.priority === "number" ? todo.priority : undefined,
        sort_order: typeof todo.sort_order === "number" ? todo.sort_order : todos.indexOf(todo),
      });
    }

    return { replaced: todos.length };
  },
});

/**
 * Non-destructive single-row upsert keyed on externalId. Used by the LP
 * Chief Checkpoint flow to post a dashboard reminder when an LP lands in
 * pending_review (and refresh it if the title or deep-link changes on
 * regen). Does not touch any other todos.
 */
export const upsertByExternalId = mutation({
  args: {
    externalId: v.string(),
    text: v.string(),
    notes: v.optional(v.string()),
    author: v.optional(v.string()),
    priority: v.optional(v.number()),
    sort_order: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("dashboard_todos")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    const patch: Record<string, any> = {
      text: args.text,
      done: false,
    };
    if (args.notes !== undefined) patch.notes = args.notes;
    if (args.author !== undefined) patch.author = args.author;
    if (args.priority !== undefined) patch.priority = args.priority;
    if (args.sort_order !== undefined) patch.sort_order = args.sort_order;

    if (existing) {
      await ctx.db.patch(existing._id, patch);
      return { created: false, externalId: args.externalId };
    }
    await ctx.db.insert("dashboard_todos", {
      externalId: args.externalId,
      text: args.text,
      done: false,
      author: args.author,
      notes: args.notes,
      priority: args.priority,
      sort_order: typeof args.sort_order === "number" ? args.sort_order : 0,
    });
    return { created: true, externalId: args.externalId };
  },
});

/**
 * Non-destructive delete by externalId. No-op if the row doesn't exist.
 * Used to clear a pending-review reminder when the LP is approved /
 * rejected / expires.
 */
export const removeByExternalId = mutation({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("dashboard_todos")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!existing) return { removed: false };
    await ctx.db.delete(existing._id);
    return { removed: true };
  },
});

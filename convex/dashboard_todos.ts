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

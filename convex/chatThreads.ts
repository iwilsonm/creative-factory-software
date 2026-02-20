import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

// ── Queries ─────────────────────────────────────────────────────────────────

export const getActiveByProject = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("chat_threads")
      .withIndex("by_project_and_status", (q) =>
        q.eq("project_id", args.projectId).eq("status", "active")
      )
      .first();
  },
});

export const getMessagesByThread = query({
  args: { threadId: v.string() },
  handler: async (ctx, args) => {
    const messages = await ctx.db
      .query("chat_messages")
      .withIndex("by_thread", (q) => q.eq("thread_id", args.threadId))
      .collect();
    // Sort by created_at ascending
    messages.sort((a, b) => a.created_at.localeCompare(b.created_at));
    return messages;
  },
});

// ── Mutations ───────────────────────────────────────────────────────────────

export const create = mutation({
  args: {
    externalId: v.string(),
    project_id: v.string(),
    title: v.optional(v.string()),
    status: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    await ctx.db.insert("chat_threads", {
      externalId: args.externalId,
      project_id: args.project_id,
      title: args.title,
      status: args.status ?? "active",
      created_at: now,
      updated_at: now,
    });
  },
});

export const archive = mutation({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const thread = await ctx.db
      .query("chat_threads")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!thread) throw new Error("Thread not found");
    await ctx.db.patch(thread._id, {
      status: "archived",
      updated_at: new Date().toISOString(),
    });
  },
});

export const createMessage = mutation({
  args: {
    externalId: v.string(),
    thread_id: v.string(),
    project_id: v.string(),
    role: v.string(),
    content: v.string(),
    is_context_message: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("chat_messages", {
      externalId: args.externalId,
      thread_id: args.thread_id,
      project_id: args.project_id,
      role: args.role,
      content: args.content,
      is_context_message: args.is_context_message,
      created_at: new Date().toISOString(),
    });
  },
});

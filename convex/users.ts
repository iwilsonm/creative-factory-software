import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const getByUsername = query({
  args: { username: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", args.username))
      .first();
  },
});

export const getByExternalId = query({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("users")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
  },
});

export const getAll = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("users").collect();
  },
});

export const count = query({
  args: {},
  handler: async (ctx) => {
    const users = await ctx.db.query("users").collect();
    return users.length;
  },
});

export const create = mutation({
  args: {
    externalId: v.string(),
    username: v.string(),
    display_name: v.string(),
    password_hash: v.string(),
    role: v.string(),
    is_active: v.boolean(),
    created_by: v.optional(v.string()),
    created_at: v.string(),
    updated_at: v.string(),
  },
  handler: async (ctx, args) => {
    // Check for duplicate username
    const existing = await ctx.db
      .query("users")
      .withIndex("by_username", (q) => q.eq("username", args.username))
      .first();
    if (existing) {
      throw new Error("Username already exists");
    }
    await ctx.db.insert("users", args);
  },
});

export const update = mutation({
  args: {
    externalId: v.string(),
    display_name: v.optional(v.string()),
    role: v.optional(v.string()),
    is_active: v.optional(v.boolean()),
    updated_at: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!user) throw new Error("User not found");

    const updates: Record<string, any> = { updated_at: args.updated_at };
    if (args.display_name !== undefined) updates.display_name = args.display_name;
    if (args.role !== undefined) updates.role = args.role;
    if (args.is_active !== undefined) updates.is_active = args.is_active;

    await ctx.db.patch(user._id, updates);
  },
});

export const updatePassword = mutation({
  args: {
    externalId: v.string(),
    password_hash: v.string(),
    updated_at: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!user) throw new Error("User not found");
    await ctx.db.patch(user._id, {
      password_hash: args.password_hash,
      updated_at: args.updated_at,
    });
  },
});

export const remove = mutation({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const user = await ctx.db
      .query("users")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!user) throw new Error("User not found");
    await ctx.db.delete(user._id);
  },
});

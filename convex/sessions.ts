import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const get = query({
  args: { sid: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("sessions")
      .withIndex("by_sid", (q) => q.eq("sid", args.sid))
      .first();
    return row ? row.session_data : null;
  },
});

export const set = mutation({
  args: {
    sid: v.string(),
    session_data: v.string(),
    expires_at: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("sessions")
      .withIndex("by_sid", (q) => q.eq("sid", args.sid))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, {
        session_data: args.session_data,
        expires_at: args.expires_at,
      });
    } else {
      await ctx.db.insert("sessions", {
        sid: args.sid,
        session_data: args.session_data,
        expires_at: args.expires_at,
      });
    }
  },
});

export const destroy = mutation({
  args: { sid: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("sessions")
      .withIndex("by_sid", (q) => q.eq("sid", args.sid))
      .first();
    if (existing) {
      await ctx.db.delete(existing._id);
    }
  },
});

export const cleanupExpired = mutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const expired = await ctx.db
      .query("sessions")
      .withIndex("by_expires_at")
      .collect();
    let count = 0;
    for (const session of expired) {
      if (session.expires_at < now) {
        await ctx.db.delete(session._id);
        count++;
      }
    }
    return count;
  },
});

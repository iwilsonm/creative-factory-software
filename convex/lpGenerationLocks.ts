import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

/**
 * Per-project LP generation lock.
 *
 * Why: prevents concurrent /generate calls (e.g. Ian with two browser tabs
 * clicking Generate within 1 second) from racing through the pipeline and
 * burning Gemini quota twice. PEF plan 2026-04-21 invariant #9.
 *
 * Lifecycle:
 *   tryAcquire → succeeds (returns { acquired: true }) if no lock exists OR
 *                if existing lock is past its ttl (auto-expired).
 *              → fails (returns { acquired: false, holder_label, ms_until_expiry })
 *                if a fresh lock is held.
 *   release → deletes the lock (idempotent — no-op if already released).
 *   purgeStale → deletes locks past their ttl. Run by scheduler cron daily.
 */

export const tryAcquire = mutation({
  args: {
    project_id: v.string(),
    ttl_ms: v.optional(v.float64()),
    holder_label: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const ttlMs = args.ttl_ms ?? 600_000; // default 10 min — generous, releases on completion

    const existing = await ctx.db
      .query("lp_generation_locks")
      .withIndex("by_project", (q) => q.eq("project_id", args.project_id))
      .first();

    if (existing) {
      const expiresAt = existing.acquired_at + existing.ttl_ms;
      if (now < expiresAt) {
        return {
          acquired: false,
          holder_label: existing.holder_label || null,
          ms_until_expiry: expiresAt - now,
        };
      }
      // Stale lock — overwrite.
      await ctx.db.patch(existing._id, {
        acquired_at: now,
        ttl_ms: ttlMs,
        holder_label: args.holder_label || null,
      });
      return { acquired: true, refreshed_stale: true };
    }

    await ctx.db.insert("lp_generation_locks", {
      project_id: args.project_id,
      acquired_at: now,
      ttl_ms: ttlMs,
      holder_label: args.holder_label || undefined,
    });
    return { acquired: true };
  },
});

export const release = mutation({
  args: { project_id: v.string() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("lp_generation_locks")
      .withIndex("by_project", (q) => q.eq("project_id", args.project_id))
      .first();
    if (existing) {
      await ctx.db.delete(existing._id);
      return { released: true };
    }
    return { released: false };
  },
});

export const get = query({
  args: { project_id: v.string() },
  handler: async (ctx, args) => {
    const lock = await ctx.db
      .query("lp_generation_locks")
      .withIndex("by_project", (q) => q.eq("project_id", args.project_id))
      .first();
    if (!lock) return null;
    const expiresAt = lock.acquired_at + lock.ttl_ms;
    const now = Date.now();
    return {
      project_id: lock.project_id,
      acquired_at: lock.acquired_at,
      ttl_ms: lock.ttl_ms,
      expires_at: expiresAt,
      is_stale: now >= expiresAt,
      holder_label: lock.holder_label || null,
    };
  },
});

/**
 * Delete all locks past their ttl. Called by scheduler cron daily.
 * Returns count of locks purged.
 */
export const purgeStale = mutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const all = await ctx.db.query("lp_generation_locks").collect();
    let purged = 0;
    for (const lock of all) {
      const expiresAt = lock.acquired_at + lock.ttl_ms;
      if (now >= expiresAt) {
        await ctx.db.delete(lock._id);
        purged += 1;
      }
    }
    return { purged };
  },
});

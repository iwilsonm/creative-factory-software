import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

const lpHeadlineHistoryEntry = v.object({
  externalId: v.string(),
  project_id: v.string(),
  angle_name: v.string(),
  narrative_frame: v.string(),
  landing_page_id: v.optional(v.string()),
  gauntlet_batch_id: v.optional(v.string()),
  headline_text: v.string(),
  subheadline_text: v.optional(v.string()),
  normalized_headline: v.string(),
  headline_signature: v.optional(v.string()),
  created_at: v.string(),
});

export const getRecentByAngle = query({
  args: {
    projectId: v.string(),
    angleName: v.string(),
    limit: v.optional(v.number()),
    since: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("lp_headline_history")
      .withIndex("by_project_angle_and_created_at", (q) =>
        q.eq("project_id", args.projectId).eq("angle_name", args.angleName)
      )
      .order("desc")
      .take(Math.min(args.limit ?? 200, 500));

    if (!args.since) return rows;
    return rows.filter((row) => row.created_at >= args.since);
  },
});

export const getRecentByAngleAndFrame = query({
  args: {
    projectId: v.string(),
    angleName: v.string(),
    narrativeFrame: v.string(),
    limit: v.optional(v.number()),
    since: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("lp_headline_history")
      .withIndex("by_project_angle_frame_and_created_at", (q) =>
        q.eq("project_id", args.projectId)
          .eq("angle_name", args.angleName)
          .eq("narrative_frame", args.narrativeFrame)
      )
      .order("desc")
      .take(Math.min(args.limit ?? 100, 300));

    if (!args.since) return rows;
    return rows.filter((row) => row.created_at >= args.since);
  },
});

export const recordMany = mutation({
  args: { entries: v.array(lpHeadlineHistoryEntry) },
  handler: async (ctx, args) => {
    for (const entry of args.entries.slice(0, 500)) {
      const existing = await ctx.db
        .query("lp_headline_history")
        .withIndex("by_externalId", (q) => q.eq("externalId", entry.externalId))
        .first();

      if (existing) {
        await ctx.db.patch(existing._id, entry);
      } else {
        await ctx.db.insert("lp_headline_history", entry);
      }
    }
  },
});

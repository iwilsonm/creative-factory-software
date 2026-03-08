import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

const headlineHistoryEntry = v.object({
  externalId: v.string(),
  project_id: v.string(),
  angle_name: v.string(),
  batch_job_id: v.optional(v.string()),
  conductor_run_id: v.optional(v.string()),
  ad_creative_id: v.optional(v.string()),
  headline_text: v.string(),
  normalized_headline: v.string(),
  hook_lane: v.optional(v.string()),
  sub_angle: v.optional(v.string()),
  core_claim: v.optional(v.string()),
  target_symptom: v.optional(v.string()),
  emotional_entry: v.optional(v.string()),
  desired_belief_shift: v.optional(v.string()),
  opening_pattern: v.optional(v.string()),
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
      .query("headline_history")
      .withIndex("by_project_angle_and_created_at", (q) =>
        q.eq("project_id", args.projectId).eq("angle_name", args.angleName)
      )
      .order("desc")
      .take(Math.min(args.limit ?? 200, 500));

    if (!args.since) return rows;
    return rows.filter((row) => row.created_at >= args.since);
  },
});

export const recordMany = mutation({
  args: { entries: v.array(headlineHistoryEntry) },
  handler: async (ctx, args) => {
    for (const entry of args.entries.slice(0, 500)) {
      const existing = await ctx.db
        .query("headline_history")
        .withIndex("by_externalId", (q) => q.eq("externalId", entry.externalId))
        .first();

      if (existing) {
        await ctx.db.patch(existing._id, entry);
      } else {
        await ctx.db.insert("headline_history", entry);
      }
    }
  },
});

export const clearByAngle = mutation({
  args: {
    projectId: v.string(),
    angleName: v.string(),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("headline_history")
      .withIndex("by_project_and_angle", (q) =>
        q.eq("project_id", args.projectId).eq("angle_name", args.angleName)
      )
      .collect();

    for (const row of rows) {
      await ctx.db.delete(row._id);
    }

    return { deleted: rows.length };
  },
});

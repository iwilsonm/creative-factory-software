import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const log = mutation({
  args: {
    externalId: v.string(),
    project_id: v.optional(v.string()),
    service: v.string(),
    operation: v.optional(v.string()),
    cost_usd: v.number(),
    rate_used: v.optional(v.number()),
    image_count: v.optional(v.number()),
    resolution: v.optional(v.string()),
    source: v.optional(v.string()),
    period_date: v.string(),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    await ctx.db.insert("api_costs", {
      ...args,
      source: args.source ?? "calculated",
      created_at: now,
    });
  },
});

export const getAggregates = query({
  args: {
    startDate: v.string(),
    endDate: v.string(),
    projectId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    let costs;
    if (args.projectId) {
      costs = await ctx.db
        .query("api_costs")
        .withIndex("by_project_and_period", (q) =>
          q.eq("project_id", args.projectId)
        )
        .collect();
      // Filter by date range in JS since compound index doesn't support range on second field
      costs = costs.filter(
        (c) => c.period_date >= args.startDate && c.period_date <= args.endDate
      );
    } else {
      costs = await ctx.db.query("api_costs").collect();
      costs = costs.filter(
        (c) => c.period_date >= args.startDate && c.period_date <= args.endDate
      );
    }

    let total = 0;
    const byService: Record<string, number> = {};
    const byOperation: Record<string, number> = {};

    for (const c of costs) {
      total += c.cost_usd;
      byService[c.service] = (byService[c.service] || 0) + c.cost_usd;
      const op = c.operation || "unknown";
      byOperation[op] = (byOperation[op] || 0) + c.cost_usd;
    }

    return { total, byService, byOperation };
  },
});

export const getDailyHistory = query({
  args: { startDate: v.string(), projectId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    let costs;
    if (args.projectId) {
      costs = await ctx.db
        .query("api_costs")
        .withIndex("by_project_and_period", (q) =>
          q.eq("project_id", args.projectId)
        )
        .collect();
    } else {
      costs = await ctx.db.query("api_costs").collect();
    }

    costs = costs.filter((c) => c.period_date >= args.startDate);

    // Group by date
    const byDate: Record<string, { openai: number; gemini: number; total: number }> = {};
    for (const c of costs) {
      if (!byDate[c.period_date]) {
        byDate[c.period_date] = { openai: 0, gemini: 0, total: 0 };
      }
      byDate[c.period_date].total += c.cost_usd;
      if (c.service === "openai") byDate[c.period_date].openai += c.cost_usd;
      if (c.service === "gemini") byDate[c.period_date].gemini += c.cost_usd;
    }

    return Object.entries(byDate)
      .map(([date, data]) => ({ date, ...data }))
      .sort((a, b) => a.date.localeCompare(b.date));
  },
});

export const deleteBySourceAndDate = mutation({
  args: { source: v.string(), startDate: v.string() },
  handler: async (ctx, args) => {
    const costs = await ctx.db
      .query("api_costs")
      .withIndex("by_source_and_period", (q) => q.eq("source", args.source))
      .collect();

    const toDelete = costs.filter((c) => c.period_date >= args.startDate);
    for (const c of toDelete) {
      await ctx.db.delete(c._id);
    }
    return { deleted: toDelete.length };
  },
});

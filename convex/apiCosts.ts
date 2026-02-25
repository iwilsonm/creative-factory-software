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
          q.eq("project_id", args.projectId).gte("period_date", args.startDate).lte("period_date", args.endDate)
        )
        .collect();
    } else {
      costs = await ctx.db
        .query("api_costs")
        .withIndex("by_period", (q) =>
          q.gte("period_date", args.startDate).lte("period_date", args.endDate)
        )
        .collect();
    }

    let total = 0;
    let imageCount = 0;
    let batchImageCount = 0;
    const byService: Record<string, number> = {};
    const byOperation: Record<string, { cost: number; imageCount: number }> = {};

    for (const c of costs) {
      total += c.cost_usd;
      byService[c.service] = (byService[c.service] || 0) + c.cost_usd;
      const op = c.operation || "unknown";
      if (!byOperation[op]) byOperation[op] = { cost: 0, imageCount: 0 };
      byOperation[op].cost += c.cost_usd;
      const imgs = c.image_count || 0;
      byOperation[op].imageCount += imgs;
      if (op === "image_generation") imageCount += imgs;
      if (op === "image_generation_batch") batchImageCount += imgs;
    }

    return { total, byService, byOperation, imageCount, batchImageCount };
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
          q.eq("project_id", args.projectId).gte("period_date", args.startDate)
        )
        .collect();
    } else {
      costs = await ctx.db
        .query("api_costs")
        .withIndex("by_period", (q) =>
          q.gte("period_date", args.startDate)
        )
        .collect();
    }

    // Group by date
    const byDate: Record<string, { openai: number; gemini: number; anthropic: number; perplexity: number; total: number }> = {};
    for (const c of costs) {
      if (!byDate[c.period_date]) {
        byDate[c.period_date] = { openai: 0, gemini: 0, anthropic: 0, perplexity: 0, total: 0 };
      }
      byDate[c.period_date].total += c.cost_usd;
      if (c.service === "openai") byDate[c.period_date].openai += c.cost_usd;
      else if (c.service === "gemini") byDate[c.period_date].gemini += c.cost_usd;
      else if (c.service === "anthropic") byDate[c.period_date].anthropic += c.cost_usd;
      else if (c.service === "perplexity") byDate[c.period_date].perplexity += c.cost_usd;
    }

    return Object.entries(byDate)
      .map(([date, data]) => ({ date, ...data }))
      .sort((a, b) => a.date.localeCompare(b.date));
  },
});

// Agent-grouped cost aggregation for the Agent Dashboard.
// Groups costs by agent based on operation prefix.
export const getAgentCosts = query({
  args: {
    startDate: v.string(),
    endDate: v.string(),
  },
  handler: async (ctx, args) => {
    const costs = await ctx.db
      .query("api_costs")
      .withIndex("by_period", (q) =>
        q.gte("period_date", args.startDate).lte("period_date", args.endDate)
      )
      .collect();

    const agents: Record<string, { total: number; operations: Record<string, number> }> = {
      director: { total: 0, operations: {} },
      filter: { total: 0, operations: {} },
      fixer: { total: 0, operations: {} },
      pipeline: { total: 0, operations: {} },
      other: { total: 0, operations: {} },
    };

    for (const c of costs) {
      const op = c.operation || "unknown";
      let agent = "other";

      if (op.startsWith("conductor_")) agent = "director";
      else if (op.startsWith("filter_")) agent = "filter";
      else if (op.startsWith("fixer_")) agent = "fixer";
      else if (op.startsWith("batch_") || op === "image_generation_batch") agent = "pipeline";

      agents[agent].total += c.cost_usd;
      agents[agent].operations[op] = (agents[agent].operations[op] || 0) + c.cost_usd;
    }

    // Also compute daily breakdown by agent for the bar chart
    const daily: Record<string, Record<string, number>> = {};
    for (const c of costs) {
      if (!daily[c.period_date]) daily[c.period_date] = { director: 0, filter: 0, fixer: 0, pipeline: 0, other: 0 };
      const op = c.operation || "unknown";
      let agent = "other";
      if (op.startsWith("conductor_")) agent = "director";
      else if (op.startsWith("filter_")) agent = "filter";
      else if (op.startsWith("fixer_")) agent = "fixer";
      else if (op.startsWith("batch_") || op === "image_generation_batch") agent = "pipeline";
      daily[c.period_date][agent] += c.cost_usd;
    }

    const dailyHistory = Object.entries(daily)
      .map(([date, data]) => ({ date, ...data }))
      .sort((a, b) => a.date.localeCompare(b.date));

    return { agents, dailyHistory };
  },
});

/**
 * One-time migration: recalculate cost_usd for all Gemini records that used
 * incorrect rates (e.g. $18/image instead of $0.134). For each Gemini record,
 * recalculates cost based on image_count and the correct rate for its resolution.
 */
export const recalcGeminiCosts = mutation({
  args: {
    rate1k: v.number(),
    rate2k: v.number(),
    rate4k: v.number(),
    batchDiscount: v.number(), // e.g. 0.5
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const allCosts = await ctx.db.query("api_costs").collect();
    const geminiCosts = allCosts.filter((c) => c.service === "gemini");

    let updated = 0;
    let skipped = 0;
    const changes: Array<{
      id: string;
      date: string;
      op: string;
      oldCost: number;
      newCost: number;
      oldRate: number;
      newRate: number;
      images: number;
    }> = [];

    for (const c of geminiCosts) {
      const images = c.image_count || 1;
      const resolution = (c.resolution || "2K").toUpperCase();
      const isBatch = c.operation === "image_generation_batch";

      // Determine correct base rate
      let baseRate = args.rate2k; // default
      if (resolution === "1K") baseRate = args.rate1k;
      else if (resolution === "4K") baseRate = args.rate4k;

      const correctRate = isBatch ? baseRate * args.batchDiscount : baseRate;
      const correctCost =
        Math.round(images * correctRate * 1000000) / 1000000;

      // Only update if cost differs meaningfully
      if (Math.abs(c.cost_usd - correctCost) < 0.000001) {
        skipped++;
        continue;
      }

      changes.push({
        id: c.externalId,
        date: c.period_date,
        op: c.operation || "unknown",
        oldCost: c.cost_usd,
        newCost: correctCost,
        oldRate: c.rate_used || 0,
        newRate: correctRate,
        images,
      });

      if (!args.dryRun) {
        await ctx.db.patch(c._id, {
          cost_usd: correctCost,
          rate_used: correctRate,
        });
      }
      updated++;
    }

    return { updated, skipped, total: geminiCosts.length, changes };
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

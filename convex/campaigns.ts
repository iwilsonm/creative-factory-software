import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const getByProject = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("campaigns")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .collect();
  },
});

export const getByExternalId = query({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("campaigns")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
  },
});

export const create = mutation({
  args: {
    externalId: v.string(),
    project_id: v.string(),
    name: v.string(),
    sort_order: v.number(),
    created_at: v.string(),
    updated_at: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db.insert("campaigns", args);
  },
});

// Phase 6 — find-or-create a campaign by (project_id, name). Used by Director's
// auto-campaign path to prevent duplicate "[Auto] X" campaigns across runs.
export const upsertByProjectAndName = mutation({
  args: {
    project_id: v.string(),
    name: v.string(),
  },
  handler: async (ctx, args) => {
    const all = await ctx.db
      .query("campaigns")
      .withIndex("by_project", (q) => q.eq("project_id", args.project_id))
      .collect();
    const match = all.find((c) => c.name === args.name);
    if (match) return match.externalId;
    const externalId = crypto.randomUUID();
    const now = new Date().toISOString();
    await ctx.db.insert("campaigns", {
      externalId,
      project_id: args.project_id,
      name: args.name,
      sort_order: all.length,
      created_at: now,
      updated_at: now,
    });
    return externalId;
  },
});

export const update = mutation({
  args: {
    externalId: v.string(),
    fields: v.object({
      name: v.optional(v.string()),
      sort_order: v.optional(v.number()),
      // Phase 5
      meta_campaign_id: v.optional(v.string()),
    }),
  },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("campaigns")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!doc) throw new Error("Campaign not found");
    const updates: Record<string, any> = { ...args.fields, updated_at: new Date().toISOString() };
    await ctx.db.patch(doc._id, updates);
  },
});

export const remove = mutation({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("campaigns")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!doc) throw new Error("Campaign not found");

    // Phase 6 — block deletion if any non-terminal child ad sets exist.
    // Non-terminal: 'draft' (Planner), 'ready' (Ready to Post), 'observing'
    // (Phase 3 active observation), and legacy 'staging'/'promoted' for
    // pre-migration safety.
    const adSets = await ctx.db
      .query("ad_sets")
      .withIndex("by_campaign", (q) => q.eq("campaign_id", args.externalId))
      .collect();
    const NON_TERMINAL = new Set(["draft", "ready", "observing", "staging", "promoted"]);
    const blockers = adSets.filter((a) => NON_TERMINAL.has(a.lifecycle_status || ""));
    if (blockers.length > 0) {
      throw new Error(
        `Cannot delete campaign "${doc.name}" — has ${blockers.length} active ad set(s). ` +
        `Move or archive them first.`
      );
    }

    // Cascade: delete terminal-state ad sets (passed/failed/etc.) and soft-delete
    // their child flex_ads (legacy — Phase 6.1 will drop the table).
    for (const adSet of adSets) {
      const flexAds = await ctx.db
        .query("flex_ads")
        .withIndex("by_ad_set", (q) => q.eq("ad_set_id", adSet.externalId))
        .collect();
      for (const fa of flexAds) {
        if (!fa.deleted_at) {
          await ctx.db.patch(fa._id, { deleted_at: new Date().toISOString() });
        }
      }
      await ctx.db.delete(adSet._id);
    }

    await ctx.db.delete(doc._id);
  },
});

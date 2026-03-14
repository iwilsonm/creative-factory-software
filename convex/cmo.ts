import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

// =============================================
// cmo_config — per-project CMO Agent settings
// =============================================

export const getConfig = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("cmo_config")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .first();
  },
});

export const upsertConfig = mutation({
  args: {
    project_id: v.string(),
    enabled: v.optional(v.boolean()),
    review_schedule: v.optional(v.string()),
    review_day_of_week: v.optional(v.number()),
    review_hour_utc: v.optional(v.number()),
    target_cpa: v.optional(v.float64()),
    target_roas: v.optional(v.float64()),
    min_highest_angles: v.optional(v.number()),
    evaluation_window_days: v.optional(v.number()),
    meta_campaign_id: v.optional(v.string()),
    tracking_start_date: v.optional(v.string()),
    tw_api_key: v.optional(v.string()),
    tw_shopify_domain: v.optional(v.string()),
    ga4_property_id: v.optional(v.string()),
    ga4_credentials_json: v.optional(v.string()),
    notifications_enabled: v.optional(v.boolean()),
    auto_execute: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("cmo_config")
      .withIndex("by_project", (q) => q.eq("project_id", args.project_id))
      .first();

    const now = new Date().toISOString();
    if (existing) {
      const { project_id, ...updates } = args;
      const filtered: Record<string, any> = { updated_at: now };
      for (const [key, value] of Object.entries(updates)) {
        if (value !== undefined) filtered[key] = value;
      }
      await ctx.db.patch(existing._id, filtered);
    } else {
      await ctx.db.insert("cmo_config", {
        project_id: args.project_id,
        enabled: args.enabled ?? false,
        review_schedule: args.review_schedule ?? "weekly",
        review_day_of_week: args.review_day_of_week ?? 1, // Monday
        review_hour_utc: args.review_hour_utc ?? 3,       // 3 AM UTC
        target_cpa: args.target_cpa,
        target_roas: args.target_roas,
        min_highest_angles: args.min_highest_angles ?? 8,
        evaluation_window_days: args.evaluation_window_days ?? 12,
        meta_campaign_id: args.meta_campaign_id,
        tracking_start_date: args.tracking_start_date,
        tw_api_key: args.tw_api_key,
        tw_shopify_domain: args.tw_shopify_domain,
        ga4_property_id: args.ga4_property_id,
        ga4_credentials_json: args.ga4_credentials_json,
        notifications_enabled: args.notifications_enabled ?? true,
        auto_execute: args.auto_execute ?? false,
        created_at: now,
        updated_at: now,
      });
    }
  },
});

export const getAllConfigs = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("cmo_config").collect();
  },
});

// =============================================
// cmo_runs — run history log
// =============================================

export const getRuns = query({
  args: { projectId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const runs = await ctx.db
      .query("cmo_runs")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .order("desc")
      .collect();
    return runs.slice(0, args.limit ?? 50);
  },
});

export const getRun = query({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("cmo_runs")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
  },
});

export const createRun = mutation({
  args: {
    externalId: v.string(),
    project_id: v.string(),
    run_type: v.string(),
    status: v.string(),
    run_at: v.string(),
    duration_ms: v.optional(v.float64()),
    tw_summary: v.optional(v.string()),
    meta_ads_count: v.optional(v.float64()),
    ga4_pages_count: v.optional(v.float64()),
    angle_evaluations: v.optional(v.string()),
    lp_diagnostics: v.optional(v.string()),
    decisions: v.optional(v.string()),
    decisions_applied: v.optional(v.boolean()),
    decisions_count: v.optional(v.float64()),
    pipeline_health: v.optional(v.string()),
    angles_written: v.optional(v.string()),
    notifications_sent: v.optional(v.float64()),
    error: v.optional(v.string()),
    error_stage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("cmo_runs", {
      ...args,
      created_at: new Date().toISOString(),
    });
  },
});

export const updateRun = mutation({
  args: {
    externalId: v.string(),
    status: v.optional(v.string()),
    duration_ms: v.optional(v.float64()),
    tw_summary: v.optional(v.string()),
    meta_ads_count: v.optional(v.float64()),
    ga4_pages_count: v.optional(v.float64()),
    angle_evaluations: v.optional(v.string()),
    lp_diagnostics: v.optional(v.string()),
    decisions: v.optional(v.string()),
    decisions_applied: v.optional(v.boolean()),
    decisions_count: v.optional(v.float64()),
    pipeline_health: v.optional(v.string()),
    angles_written: v.optional(v.string()),
    notifications_sent: v.optional(v.float64()),
    error: v.optional(v.string()),
    error_stage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db
      .query("cmo_runs")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!run) throw new Error("CMO run not found");

    const { externalId, ...updates } = args;
    const filtered: Record<string, any> = {};
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) filtered[key] = value;
    }
    await ctx.db.patch(run._id, filtered);
  },
});

// =============================================
// cmo_angle_history — append-only weekly ledger
// =============================================

export const getAngleHistory = query({
  args: { projectId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const records = await ctx.db
      .query("cmo_angle_history")
      .withIndex("by_project_and_date", (q) => q.eq("project_id", args.projectId))
      .order("desc")
      .collect();
    return records.slice(0, args.limit ?? 500);
  },
});

export const getAngleHistoryByAngle = query({
  args: { projectId: v.string(), angleName: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("cmo_angle_history")
      .withIndex("by_project_and_angle", (q) =>
        q.eq("project_id", args.projectId).eq("angle_name", args.angleName)
      )
      .order("desc")
      .collect();
  },
});

export const getAngleHistoryByRun = query({
  args: { cmoRunId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("cmo_angle_history")
      .withIndex("by_cmo_run", (q) => q.eq("cmo_run_id", args.cmoRunId))
      .collect();
  },
});

export const createAngleHistory = mutation({
  args: {
    externalId: v.string(),
    project_id: v.string(),
    angle_name: v.string(),
    snapshot_date: v.string(),
    cmo_run_id: v.string(),
    spend: v.float64(),
    impressions: v.float64(),
    clicks: v.float64(),
    conversions: v.float64(),
    conversion_value: v.float64(),
    cpa: v.optional(v.float64()),
    roas: v.optional(v.float64()),
    ctr: v.optional(v.float64()),
    cpc: v.optional(v.float64()),
    tier: v.string(),
    spend_class: v.string(),
    priority_at_snapshot: v.optional(v.string()),
    status_at_snapshot: v.optional(v.string()),
    ad_count: v.optional(v.float64()),
    days_active: v.optional(v.float64()),
    spend_trend: v.optional(v.string()),
    cpa_trend: v.optional(v.string()),
    lp_bounce_rate: v.optional(v.float64()),
    lp_cvr: v.optional(v.float64()),
    lp_sessions: v.optional(v.float64()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("cmo_angle_history", {
      ...args,
      created_at: new Date().toISOString(),
    });
  },
});

// =============================================
// cmo_notifications — notification log
// =============================================

export const getNotifications = query({
  args: { projectId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const all = await ctx.db
      .query("cmo_notifications")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .order("desc")
      .collect();
    return all.slice(0, args.limit ?? 100);
  },
});

export const getNotificationsByRun = query({
  args: { projectId: v.string(), cmoRunId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("cmo_notifications")
      .withIndex("by_project_and_run", (q) =>
        q.eq("project_id", args.projectId).eq("cmo_run_id", args.cmoRunId)
      )
      .collect();
  },
});

export const createNotification = mutation({
  args: {
    externalId: v.string(),
    project_id: v.string(),
    cmo_run_id: v.string(),
    rule: v.string(),
    severity: v.string(),
    title: v.string(),
    message: v.string(),
    angle_name: v.optional(v.string()),
    data: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("cmo_notifications", {
      ...args,
      acknowledged: false,
      created_at: new Date().toISOString(),
    });
  },
});

export const acknowledgeNotification = mutation({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const notif = await ctx.db
      .query("cmo_notifications")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!notif) throw new Error("Notification not found");
    await ctx.db.patch(notif._id, {
      acknowledged: true,
      acknowledged_at: new Date().toISOString(),
    });
  },
});

export const acknowledgeAllNotifications = mutation({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    const unacked = await ctx.db
      .query("cmo_notifications")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .collect();
    const now = new Date().toISOString();
    for (const notif of unacked) {
      if (!notif.acknowledged) {
        await ctx.db.patch(notif._id, {
          acknowledged: true,
          acknowledged_at: now,
        });
      }
    }
  },
});

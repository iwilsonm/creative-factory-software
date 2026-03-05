import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

// =============================================
// conductor_config — per-project Director settings
// =============================================

export const getConfig = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("conductor_config")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .first();
  },
});

export const upsertConfig = mutation({
  args: {
    project_id: v.string(),
    enabled: v.optional(v.boolean()),
    daily_flex_target: v.optional(v.number()),
    ads_per_batch: v.optional(v.number()),
    angle_mode: v.optional(v.string()),
    explore_ratio: v.optional(v.number()),
    angle_rotation: v.optional(v.string()),
    headline_style: v.optional(v.string()),
    primary_text_style: v.optional(v.string()),
    meta_campaign_name: v.optional(v.string()),
    meta_adset_defaults: v.optional(v.string()),
    default_campaign_id: v.optional(v.string()),
    run_schedule: v.optional(v.string()),
    last_planning_run: v.optional(v.number()),
    last_verify_run: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("conductor_config")
      .withIndex("by_project", (q) => q.eq("project_id", args.project_id))
      .first();

    const now = Date.now();
    if (existing) {
      const { project_id, ...updates } = args;
      const filtered: Record<string, any> = { updated_at: now };
      for (const [key, value] of Object.entries(updates)) {
        if (value !== undefined) filtered[key] = value;
      }
      await ctx.db.patch(existing._id, filtered);
    } else {
      await ctx.db.insert("conductor_config", {
        project_id: args.project_id,
        enabled: args.enabled ?? false,
        daily_flex_target: args.daily_flex_target ?? 5,
        ads_per_batch: args.ads_per_batch ?? 18,
        angle_mode: args.angle_mode ?? "manual",
        explore_ratio: args.explore_ratio ?? 0.2,
        angle_rotation: args.angle_rotation ?? "round_robin",
        headline_style: args.headline_style,
        primary_text_style: args.primary_text_style,
        meta_campaign_name: args.meta_campaign_name,
        meta_adset_defaults: args.meta_adset_defaults,
        default_campaign_id: args.default_campaign_id,
        run_schedule: args.run_schedule ?? "auto",
        last_planning_run: args.last_planning_run,
        last_verify_run: args.last_verify_run,
        created_at: now,
        updated_at: now,
      });
    }
  },
});

export const getAllConfigs = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("conductor_config").collect();
  },
});

// =============================================
// conductor_angles — angle library per project
// =============================================

export const getAngles = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("conductor_angles")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .collect();
  },
});

export const getActiveAngles = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("conductor_angles")
      .withIndex("by_project_and_status", (q) =>
        q.eq("project_id", args.projectId).eq("status", "active")
      )
      .collect();
  },
});

export const createAngle = mutation({
  args: {
    externalId: v.string(),
    project_id: v.string(),
    name: v.string(),
    description: v.string(),
    prompt_hints: v.optional(v.string()),
    source: v.string(),
    status: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.insert("conductor_angles", {
      ...args,
      times_used: 0,
      created_at: now,
      updated_at: now,
    });
  },
});

export const updateAngle = mutation({
  args: {
    externalId: v.string(),
    name: v.optional(v.string()),
    description: v.optional(v.string()),
    prompt_hints: v.optional(v.string()),
    status: v.optional(v.string()),
    focused: v.optional(v.boolean()),
    lp_enabled: v.optional(v.boolean()),
    times_used: v.optional(v.number()),
    last_used_at: v.optional(v.number()),
    performance_note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const angle = await ctx.db
      .query("conductor_angles")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!angle) throw new Error("Angle not found");

    const { externalId, ...updates } = args;
    const filtered: Record<string, any> = { updated_at: Date.now() };
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) filtered[key] = value;
    }
    await ctx.db.patch(angle._id, filtered);
  },
});

export const deleteAngle = mutation({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const angle = await ctx.db
      .query("conductor_angles")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!angle) return;
    await ctx.db.delete(angle._id);
  },
});

// =============================================
// conductor_runs — audit log
// =============================================

export const getRuns = query({
  args: { projectId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const runs = await ctx.db
      .query("conductor_runs")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .order("desc")
      .collect();
    return runs.slice(0, args.limit ?? 50);
  },
});

export const createRun = mutation({
  args: {
    externalId: v.string(),
    project_id: v.string(),
    run_type: v.string(),
    run_at: v.number(),
    posting_days: v.optional(v.string()),
    batches_created: v.optional(v.string()),
    angles_generated: v.optional(v.string()),
    decisions: v.optional(v.string()),
    status: v.string(),
    error: v.optional(v.string()),
    duration_ms: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("conductor_runs", {
      ...args,
      created_at: Date.now(),
    });
  },
});

export const updateRun = mutation({
  args: {
    externalId: v.string(),
    status: v.optional(v.string()),
    error: v.optional(v.string()),
    batches_created: v.optional(v.string()),
    angles_generated: v.optional(v.string()),
    decisions: v.optional(v.string()),
    duration_ms: v.optional(v.number()),
    posting_days: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const run = await ctx.db
      .query("conductor_runs")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!run) throw new Error("Run not found");

    const { externalId, ...updates } = args;
    const filtered: Record<string, any> = {};
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) filtered[key] = value;
    }
    await ctx.db.patch(run._id, filtered);
  },
});

// =============================================
// conductor_health — Fixer monitoring
// =============================================

export const getHealth = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const records = await ctx.db
      .query("conductor_health")
      .order("desc")
      .collect();
    return records.slice(0, args.limit ?? 50);
  },
});

export const getHealthByAgent = query({
  args: { agent: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const records = await ctx.db
      .query("conductor_health")
      .withIndex("by_agent", (q) => q.eq("agent", args.agent))
      .order("desc")
      .collect();
    return records.slice(0, args.limit ?? 20);
  },
});

export const createHealth = mutation({
  args: {
    externalId: v.string(),
    agent: v.string(),
    check_at: v.number(),
    status: v.string(),
    details: v.optional(v.string()),
    action_taken: v.optional(v.string()),
    batches_stuck: v.optional(v.number()),
    batches_recovered: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("conductor_health", args);
  },
});

// =============================================
// conductor_playbooks — per-angle learning memory
// =============================================

export const getPlaybooks = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("conductor_playbooks")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .collect();
  },
});

export const getPlaybook = query({
  args: { projectId: v.string(), angleName: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("conductor_playbooks")
      .withIndex("by_project_and_angle", (q) =>
        q.eq("project_id", args.projectId).eq("angle_name", args.angleName)
      )
      .first();
  },
});

export const upsertPlaybook = mutation({
  args: {
    project_id: v.string(),
    angle_name: v.string(),
    version: v.number(),
    total_scored: v.number(),
    total_passed: v.number(),
    pass_rate: v.number(),
    visual_patterns: v.optional(v.string()),
    copy_patterns: v.optional(v.string()),
    avoid_patterns: v.optional(v.string()),
    generation_hints: v.optional(v.string()),
    raw_analysis: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("conductor_playbooks")
      .withIndex("by_project_and_angle", (q) =>
        q.eq("project_id", args.project_id).eq("angle_name", args.angle_name)
      )
      .first();

    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        ...args,
        last_updated: now,
      });
    } else {
      await ctx.db.insert("conductor_playbooks", {
        ...args,
        last_updated: now,
        created_at: now,
      });
    }
  },
});

// =============================================
// fixer_playbook — Fixer learning memory
// =============================================

export const getFixerPlaybooks = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("fixer_playbook").collect();
  },
});

export const getFixerPlaybook = query({
  args: { issueCategory: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("fixer_playbook")
      .withIndex("by_category", (q) => q.eq("issue_category", args.issueCategory))
      .first();
  },
});

export const upsertFixerPlaybook = mutation({
  args: {
    issue_category: v.string(),
    occurrences: v.number(),
    last_occurred: v.number(),
    root_causes: v.optional(v.string()),
    resolution_steps: v.optional(v.string()),
    prevention_hints: v.optional(v.string()),
    avg_resolution_ms: v.optional(v.number()),
    auto_resolved: v.number(),
    escalated: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("fixer_playbook")
      .withIndex("by_category", (q) => q.eq("issue_category", args.issue_category))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        ...args,
        last_updated: Date.now(),
      });
    } else {
      await ctx.db.insert("fixer_playbook", {
        ...args,
        last_updated: Date.now(),
      });
    }
  },
});

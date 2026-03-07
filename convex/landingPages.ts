import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { adjustProjectCounters } from "./projects";

function countWords(text?: string) {
  if (!text) return 0;
  return text
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .length;
}

function summarizeLandingPage(page: any) {
  let sectionCount = 0;
  let totalWords = 0;

  if (page.copy_sections) {
    try {
      const sections = JSON.parse(page.copy_sections);
      if (Array.isArray(sections)) {
        sectionCount = sections.length;
        totalWords = sections.reduce(
          (sum: number, section: any) => sum + countWords(section?.content),
          0
        );
      }
    } catch {
      sectionCount = 0;
      totalWords = 0;
    }
  }

  return {
    externalId: page.externalId,
    project_id: page.project_id,
    name: page.name,
    angle: page.angle,
    status: page.status,
    swipe_url: page.swipe_url,
    auto_generated: page.auto_generated,
    batch_job_id: page.batch_job_id,
    narrative_frame: page.narrative_frame,
    gauntlet_batch_id: page.gauntlet_batch_id,
    gauntlet_frame: page.gauntlet_frame,
    gauntlet_score: page.gauntlet_score,
    gauntlet_status: page.gauntlet_status,
    gauntlet_batch_started_at: page.gauntlet_batch_started_at,
    gauntlet_batch_completed_at: page.gauntlet_batch_completed_at,
    published_url: page.published_url,
    error_message: page.error_message,
    qa_status: page.qa_status,
    qa_issues_count: page.qa_issues_count,
    generation_duration_ms: page.generation_duration_ms,
    created_at: page.created_at,
    updated_at: page.updated_at,
    has_html: !!page.assembled_html,
    has_design: !!page.swipe_design_analysis,
    section_count: sectionCount,
    total_words: totalWords,
  };
}

function isPublishedStatus(status?: string) {
  return status === "published";
}

export const getByProject = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("landing_pages")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .collect();
  },
});

export const getListByProject = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    const pages = await ctx.db
      .query("landing_pages")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .collect();

    return pages.map(summarizeLandingPage);
  },
});

export const getByExternalId = query({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("landing_pages")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
  },
});

export const getByBatchJob = query({
  args: { batchJobId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("landing_pages")
      .withIndex("by_batch_job", (q) => q.eq("batch_job_id", args.batchJobId))
      .collect();
  },
});

export const getGauntletStatsByProject = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    const allPages = await ctx.db
      .query("landing_pages")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .collect();

    const gauntletPages = allPages.filter((page) => page.gauntlet_batch_id);
    if (gauntletPages.length === 0) {
      return null;
    }

    const batchIds = [...new Set(gauntletPages.map((page) => page.gauntlet_batch_id))];
    const passed = gauntletPages.filter(
      (page) => page.gauntlet_status === "passed" || page.status === "published"
    );
    const failed = gauntletPages.filter((page) => page.gauntlet_status === "failed");
    const scored = gauntletPages.filter((page) => page.gauntlet_score != null);
    const scores = scored.map((page) => page.gauntlet_score);
    const avgScore =
      scores.length > 0
        ? Math.round((scores.reduce((sum, score) => sum + score, 0) / scores.length) * 10) / 10
        : null;
    const minScore = scores.length > 0 ? Math.min(...scores) : null;
    const maxScore = scores.length > 0 ? Math.max(...scores) : null;

    const prescoreAttempts = gauntletPages
      .filter((page) => page.gauntlet_image_prescore_attempts != null)
      .map((page) => page.gauntlet_image_prescore_attempts);
    const avgPrescoreAttempts =
      prescoreAttempts.length > 0
        ? Math.round(
            (prescoreAttempts.reduce((sum, attempts) => sum + attempts, 0) /
              prescoreAttempts.length) *
              10
          ) / 10
        : null;
    const firstPassRate =
      prescoreAttempts.length > 0
        ? Math.round(
            (prescoreAttempts.filter((attempts) => attempts <= 1).length /
              prescoreAttempts.length) *
              100
          )
        : null;

    const retried = gauntletPages.filter((page) => (page.gauntlet_attempt ?? 0) > 1);
    const retryRate =
      gauntletPages.length > 0
        ? Math.round((retried.length / gauntletPages.length) * 100)
        : 0;

    const frameScores: Record<string, number[]> = {};
    for (const page of scored) {
      const frame = page.gauntlet_frame || page.narrative_frame || "unknown";
      if (!frameScores[frame]) frameScores[frame] = [];
      frameScores[frame].push(page.gauntlet_score);
    }

    const scoreByFrame: Record<string, number> = {};
    for (const [frame, values] of Object.entries(frameScores)) {
      scoreByFrame[frame] =
        Math.round((values.reduce((sum, score) => sum + score, 0) / values.length) * 10) / 10;
    }

    return {
      gauntletRuns: batchIds.length,
      totalLPs: gauntletPages.length,
      passed: passed.length,
      failed: failed.length,
      passRate:
        gauntletPages.length > 0
          ? Math.round((passed.length / gauntletPages.length) * 100)
          : 0,
      avgScore,
      minScore,
      maxScore,
      avgPrescoreAttempts,
      firstPassRate,
      retryRate,
      scoreByFrame,
    };
  },
});

export const create = mutation({
  args: {
    externalId: v.string(),
    project_id: v.string(),
    name: v.string(),
    angle: v.optional(v.string()),
    word_count: v.optional(v.number()),
    additional_direction: v.optional(v.string()),
    swipe_text: v.optional(v.string()),
    swipe_filename: v.optional(v.string()),
    swipe_url: v.optional(v.string()),
    swipe_screenshot_storageId: v.optional(v.string()),
    status: v.string(),
    // Auto-generation fields
    auto_generated: v.optional(v.boolean()),
    batch_job_id: v.optional(v.string()),
    narrative_frame: v.optional(v.string()),
    template_id: v.optional(v.string()),
    // Gauntlet fields
    gauntlet_batch_id: v.optional(v.string()),
    gauntlet_frame: v.optional(v.string()),
    gauntlet_attempt: v.optional(v.float64()),
    gauntlet_status: v.optional(v.string()),
    gauntlet_batch_started_at: v.optional(v.string()),
    gauntlet_batch_completed_at: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    await ctx.db.insert("landing_pages", {
      externalId: args.externalId,
      project_id: args.project_id,
      name: args.name,
      angle: args.angle,
      word_count: args.word_count,
      additional_direction: args.additional_direction,
      swipe_text: args.swipe_text,
      swipe_filename: args.swipe_filename,
      swipe_url: args.swipe_url,
      swipe_screenshot_storageId: args.swipe_screenshot_storageId,
      status: args.status,
      auto_generated: args.auto_generated,
      batch_job_id: args.batch_job_id,
      narrative_frame: args.narrative_frame,
      template_id: args.template_id,
      gauntlet_batch_id: args.gauntlet_batch_id,
      gauntlet_frame: args.gauntlet_frame,
      gauntlet_attempt: args.gauntlet_attempt,
      gauntlet_status: args.gauntlet_status,
      gauntlet_batch_started_at: args.gauntlet_batch_started_at,
      gauntlet_batch_completed_at: args.gauntlet_batch_completed_at,
      created_at: now,
      updated_at: now,
    });
    await adjustProjectCounters(ctx, args.project_id, {
      lpCount: 1,
      lpPublishedCount: isPublishedStatus(args.status) ? 1 : 0,
    });
  },
});

export const update = mutation({
  args: {
    externalId: v.string(),
    name: v.optional(v.string()),
    angle: v.optional(v.string()),
    word_count: v.optional(v.number()),
    additional_direction: v.optional(v.string()),
    swipe_text: v.optional(v.string()),
    swipe_filename: v.optional(v.string()),
    swipe_url: v.optional(v.string()),
    swipe_screenshot_storageId: v.optional(v.string()),
    status: v.optional(v.string()),
    error_message: v.optional(v.string()),
    copy_sections: v.optional(v.string()),
    // Phase 2 fields
    swipe_design_analysis: v.optional(v.string()),
    image_slots: v.optional(v.string()),
    html_template: v.optional(v.string()),
    assembled_html: v.optional(v.string()),
    slug: v.optional(v.string()),
    cta_links: v.optional(v.string()),
    current_version: v.optional(v.number()),
    // Phase 4 publishing
    published_url: v.optional(v.string()),
    published_at: v.optional(v.string()),
    final_html: v.optional(v.string()),
    hosting_metadata: v.optional(v.string()),
    // Auto-generation fields
    auto_generated: v.optional(v.boolean()),
    batch_job_id: v.optional(v.string()),
    narrative_frame: v.optional(v.string()),
    template_id: v.optional(v.string()),
    shopify_page_id: v.optional(v.string()),
    shopify_handle: v.optional(v.string()),
    // Visual QA fields
    qa_status: v.optional(v.string()),
    qa_report: v.optional(v.string()),
    qa_issues_count: v.optional(v.number()),
    qa_screenshot_storageId: v.optional(v.string()),
    qa_score: v.optional(v.number()),
    generation_attempts: v.optional(v.number()),
    fix_attempts: v.optional(v.number()),
    // Smoke test fields
    smoke_test_status: v.optional(v.string()),
    smoke_test_report: v.optional(v.string()),
    smoke_test_at: v.optional(v.string()),
    // Audit trail fields
    audit_trail: v.optional(v.string()),
    editorial_plan: v.optional(v.string()),
    // Gauntlet fields
    gauntlet_batch_id: v.optional(v.string()),
    gauntlet_frame: v.optional(v.string()),
    gauntlet_attempt: v.optional(v.float64()),
    gauntlet_retry_type: v.optional(v.string()),
    gauntlet_score: v.optional(v.float64()),
    gauntlet_score_reasoning: v.optional(v.string()),
    gauntlet_status: v.optional(v.string()),
    gauntlet_image_prescore_attempts: v.optional(v.float64()),
    gauntlet_batch_started_at: v.optional(v.string()),
    gauntlet_batch_completed_at: v.optional(v.string()),
    generation_duration_ms: v.optional(v.float64()),
  },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("landing_pages")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!doc) throw new Error("Landing page not found");

    const wasPublished = isPublishedStatus(doc.status);
    const willBePublished =
      args.status === undefined ? wasPublished : isPublishedStatus(args.status);

    const updates: Record<string, any> = { updated_at: new Date().toISOString() };
    if (args.name !== undefined) updates.name = args.name;
    if (args.angle !== undefined) updates.angle = args.angle;
    if (args.word_count !== undefined) updates.word_count = args.word_count;
    if (args.additional_direction !== undefined) updates.additional_direction = args.additional_direction;
    if (args.swipe_text !== undefined) updates.swipe_text = args.swipe_text;
    if (args.swipe_filename !== undefined) updates.swipe_filename = args.swipe_filename;
    if (args.swipe_url !== undefined) updates.swipe_url = args.swipe_url;
    if (args.swipe_screenshot_storageId !== undefined) updates.swipe_screenshot_storageId = args.swipe_screenshot_storageId;
    if (args.status !== undefined) updates.status = args.status;
    if (args.error_message !== undefined) updates.error_message = args.error_message;
    if (args.copy_sections !== undefined) updates.copy_sections = args.copy_sections;
    if (args.swipe_design_analysis !== undefined) updates.swipe_design_analysis = args.swipe_design_analysis;
    if (args.image_slots !== undefined) updates.image_slots = args.image_slots;
    if (args.html_template !== undefined) updates.html_template = args.html_template;
    if (args.assembled_html !== undefined) updates.assembled_html = args.assembled_html;
    if (args.slug !== undefined) updates.slug = args.slug;
    if (args.cta_links !== undefined) updates.cta_links = args.cta_links;
    if (args.current_version !== undefined) updates.current_version = args.current_version;
    if (args.published_url !== undefined) updates.published_url = args.published_url;
    if (args.published_at !== undefined) updates.published_at = args.published_at;
    if (args.final_html !== undefined) updates.final_html = args.final_html;
    if (args.hosting_metadata !== undefined) updates.hosting_metadata = args.hosting_metadata;
    if (args.auto_generated !== undefined) updates.auto_generated = args.auto_generated;
    if (args.batch_job_id !== undefined) updates.batch_job_id = args.batch_job_id;
    if (args.narrative_frame !== undefined) updates.narrative_frame = args.narrative_frame;
    if (args.template_id !== undefined) updates.template_id = args.template_id;
    if (args.shopify_page_id !== undefined) updates.shopify_page_id = args.shopify_page_id;
    if (args.shopify_handle !== undefined) updates.shopify_handle = args.shopify_handle;
    if (args.qa_status !== undefined) updates.qa_status = args.qa_status;
    if (args.qa_report !== undefined) updates.qa_report = args.qa_report;
    if (args.qa_issues_count !== undefined) updates.qa_issues_count = args.qa_issues_count;
    if (args.qa_screenshot_storageId !== undefined) updates.qa_screenshot_storageId = args.qa_screenshot_storageId;
    if (args.qa_score !== undefined) updates.qa_score = args.qa_score;
    if (args.generation_attempts !== undefined) updates.generation_attempts = args.generation_attempts;
    if (args.fix_attempts !== undefined) updates.fix_attempts = args.fix_attempts;
    if (args.smoke_test_status !== undefined) updates.smoke_test_status = args.smoke_test_status;
    if (args.smoke_test_report !== undefined) updates.smoke_test_report = args.smoke_test_report;
    if (args.smoke_test_at !== undefined) updates.smoke_test_at = args.smoke_test_at;
    if (args.audit_trail !== undefined) updates.audit_trail = args.audit_trail;
    if (args.editorial_plan !== undefined) updates.editorial_plan = args.editorial_plan;
    if (args.gauntlet_batch_id !== undefined) updates.gauntlet_batch_id = args.gauntlet_batch_id;
    if (args.gauntlet_frame !== undefined) updates.gauntlet_frame = args.gauntlet_frame;
    if (args.gauntlet_attempt !== undefined) updates.gauntlet_attempt = args.gauntlet_attempt;
    if (args.gauntlet_retry_type !== undefined) updates.gauntlet_retry_type = args.gauntlet_retry_type;
    if (args.gauntlet_score !== undefined) updates.gauntlet_score = args.gauntlet_score;
    if (args.gauntlet_score_reasoning !== undefined) updates.gauntlet_score_reasoning = args.gauntlet_score_reasoning;
    if (args.gauntlet_status !== undefined) updates.gauntlet_status = args.gauntlet_status;
    if (args.gauntlet_image_prescore_attempts !== undefined) updates.gauntlet_image_prescore_attempts = args.gauntlet_image_prescore_attempts;
    if (args.gauntlet_batch_started_at !== undefined) updates.gauntlet_batch_started_at = args.gauntlet_batch_started_at;
    if (args.gauntlet_batch_completed_at !== undefined) updates.gauntlet_batch_completed_at = args.gauntlet_batch_completed_at;
    if (args.generation_duration_ms !== undefined) updates.generation_duration_ms = args.generation_duration_ms;
    await ctx.db.patch(doc._id, updates);

    if (wasPublished !== willBePublished) {
      await adjustProjectCounters(ctx, doc.project_id, {
        lpPublishedCount: willBePublished ? 1 : -1,
      });
    }
  },
});

export const remove = mutation({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("landing_pages")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!doc) throw new Error("Landing page not found");
    await ctx.db.delete(doc._id);
    await adjustProjectCounters(ctx, doc.project_id, {
      lpCount: -1,
      lpPublishedCount: isPublishedStatus(doc.status) ? -1 : 0,
    });
  },
});

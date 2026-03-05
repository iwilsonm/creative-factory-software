import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

// =============================================
// lp_agent_config — per-project Landing Page Agent settings
// =============================================

export const getByProject = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("lp_agent_config")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .first();
  },
});

export const upsertConfig = mutation({
  args: {
    project_id: v.string(),
    externalId: v.optional(v.string()),
    enabled: v.optional(v.boolean()),
    // Shopify
    shopify_store_domain: v.optional(v.string()),
    shopify_access_token: v.optional(v.string()),
    shopify_client_id: v.optional(v.string()),
    shopify_connected: v.optional(v.boolean()),
    // Product page
    pdp_url: v.optional(v.string()),
    // Generation settings
    default_narrative_frames: v.optional(v.string()),
    template_selection_mode: v.optional(v.string()),
    editorial_pass_enabled: v.optional(v.boolean()),
    auto_publish: v.optional(v.boolean()),
    // Budget
    daily_budget_cents: v.optional(v.number()),
    // Images
    use_product_reference_images: v.optional(v.boolean()),
    lifestyle_image_style: v.optional(v.string()),
    // Page metadata defaults
    default_author_name: v.optional(v.string()),
    default_author_title: v.optional(v.string()),
    default_warning_text: v.optional(v.string()),
    visual_qa_enabled: v.optional(v.boolean()),
    // Cached image context
    cached_product_visual_context: v.optional(v.string()),
    cached_avatar_visual_context: v.optional(v.string()),
    // Gauntlet config
    gauntlet_enabled: v.optional(v.boolean()),
    gauntlet_score_threshold: v.optional(v.float64()),
    gauntlet_max_image_retries: v.optional(v.float64()),
    gauntlet_max_lp_retries: v.optional(v.float64()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("lp_agent_config")
      .withIndex("by_project", (q) => q.eq("project_id", args.project_id))
      .first();

    const now = new Date().toISOString();
    if (existing) {
      const { project_id, externalId, ...updates } = args;
      const filtered: Record<string, any> = { updated_at: now };
      for (const [key, value] of Object.entries(updates)) {
        if (value !== undefined) filtered[key] = value;
      }
      await ctx.db.patch(existing._id, filtered);
    } else {
      await ctx.db.insert("lp_agent_config", {
        externalId: args.externalId || crypto.randomUUID(),
        project_id: args.project_id,
        enabled: args.enabled ?? false,
        shopify_store_domain: args.shopify_store_domain,
        shopify_access_token: args.shopify_access_token,
        shopify_client_id: args.shopify_client_id,
        shopify_connected: args.shopify_connected ?? false,
        pdp_url: args.pdp_url,
        default_narrative_frames: args.default_narrative_frames ?? JSON.stringify(["testimonial", "mechanism", "problem_agitation", "myth_busting", "listicle"]),
        template_selection_mode: args.template_selection_mode ?? "random",
        editorial_pass_enabled: args.editorial_pass_enabled ?? true,
        auto_publish: args.auto_publish ?? true,
        daily_budget_cents: args.daily_budget_cents,
        use_product_reference_images: args.use_product_reference_images ?? true,
        lifestyle_image_style: args.lifestyle_image_style,
        default_author_name: args.default_author_name,
        default_author_title: args.default_author_title,
        default_warning_text: args.default_warning_text,
        visual_qa_enabled: args.visual_qa_enabled ?? true,
        created_at: now,
        updated_at: now,
      });
    }
  },
});

export const getAllConfigs = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("lp_agent_config").collect();
  },
});

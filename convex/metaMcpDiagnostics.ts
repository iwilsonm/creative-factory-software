import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const getByProjectAccount = query({
  args: {
    projectId: v.string(),
    metaAccountId: v.string(),
  },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("meta_mcp_diagnostics")
      .withIndex("by_project_account", (q) =>
        q.eq("project_id", args.projectId).eq("meta_account_id", args.metaAccountId)
      )
      .first();
  },
});

export const upsert = mutation({
  args: {
    externalId: v.string(),
    project_id: v.string(),
    meta_account_id: v.string(),
    status: v.string(),
    read_access: v.string(),
    posting_access: v.string(),
    reason_code: v.string(),
    read_reason_code: v.optional(v.string()),
    posting_reason_code: v.optional(v.string()),
    user_message: v.string(),
    technical_details: v.optional(v.string()),
    checked_at: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("meta_mcp_diagnostics")
      .withIndex("by_project_account", (q) =>
        q.eq("project_id", args.project_id).eq("meta_account_id", args.meta_account_id)
      )
      .first();
    const now = new Date().toISOString();
    if (existing) {
      const { externalId, project_id, meta_account_id, ...updates } = args;
      await ctx.db.patch(existing._id, {
        ...updates,
        updated_at: now,
      });
      return existing.externalId;
    }
    await ctx.db.insert("meta_mcp_diagnostics", {
      ...args,
      created_at: now,
      updated_at: now,
    });
    return args.externalId;
  },
});

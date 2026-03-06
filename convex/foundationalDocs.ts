import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { adjustProjectCounters } from "./projects";

export const getByProject = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("foundational_docs")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .collect();
  },
});

export const getLatest = query({
  args: { projectId: v.string(), docType: v.string() },
  handler: async (ctx, args) => {
    const docs = await ctx.db
      .query("foundational_docs")
      .withIndex("by_project_and_type", (q) =>
        q.eq("project_id", args.projectId).eq("doc_type", args.docType)
      )
      .collect();
    // Sort by version descending, return first
    docs.sort((a, b) => b.version - a.version);
    return docs[0] || null;
  },
});

export const create = mutation({
  args: {
    externalId: v.string(),
    project_id: v.string(),
    doc_type: v.string(),
    content: v.optional(v.string()),
    version: v.number(),
    source: v.optional(v.string()),
    approved: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const now = new Date().toISOString();
    await ctx.db.insert("foundational_docs", {
      externalId: args.externalId,
      project_id: args.project_id,
      doc_type: args.doc_type,
      content: args.content,
      version: args.version,
      approved: args.approved ?? false,
      source: args.source ?? "generated",
      created_at: now,
      updated_at: now,
    });
    await adjustProjectCounters(ctx, args.project_id, { docCount: 1 });
  },
});

export const update = mutation({
  args: {
    externalId: v.string(),
    content: v.optional(v.string()),
    approved: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("foundational_docs")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!doc) throw new Error("Document not found");

    const updates: Record<string, any> = { updated_at: new Date().toISOString() };
    if (args.content !== undefined) updates.content = args.content;
    if (args.approved !== undefined) updates.approved = args.approved;
    await ctx.db.patch(doc._id, updates);
  },
});

export const remove = mutation({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("foundational_docs")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
    if (!doc) throw new Error("Document not found");
    await ctx.db.delete(doc._id);
    await adjustProjectCounters(ctx, doc.project_id, { docCount: -1 });
  },
});

export const getByExternalId = query({
  args: { externalId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("foundational_docs")
      .withIndex("by_externalId", (q) => q.eq("externalId", args.externalId))
      .first();
  },
});

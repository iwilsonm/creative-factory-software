import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

export const getByProject = query({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("inspiration_images")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .collect();
  },
});

export const getByDriveFileId = query({
  args: { projectId: v.string(), driveFileId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("inspiration_images")
      .withIndex("by_project_and_drive_id", (q) =>
        q.eq("project_id", args.projectId).eq("drive_file_id", args.driveFileId)
      )
      .first();
  },
});

export const create = mutation({
  args: {
    project_id: v.string(),
    drive_file_id: v.string(),
    filename: v.string(),
    mimeType: v.optional(v.string()),
    storageId: v.optional(v.id("_storage")),
    modifiedTime: v.optional(v.string()),
    size: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    // Guard: skip if this drive_file_id already exists for this project
    const existing = await ctx.db
      .query("inspiration_images")
      .withIndex("by_project_and_drive_id", (q) =>
        q.eq("project_id", args.project_id).eq("drive_file_id", args.drive_file_id)
      )
      .first();
    if (existing) return;
    await ctx.db.insert("inspiration_images", args);
  },
});

export const updateStorageId = mutation({
  args: {
    projectId: v.string(),
    driveFileId: v.string(),
    storageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    const img = await ctx.db
      .query("inspiration_images")
      .withIndex("by_project_and_drive_id", (q) =>
        q
          .eq("project_id", args.projectId)
          .eq("drive_file_id", args.driveFileId)
      )
      .first();
    if (!img) throw new Error("Inspiration image not found");
    await ctx.db.patch(img._id, { storageId: args.storageId });
  },
});

export const removeByProject = mutation({
  args: { projectId: v.string(), driveFileIds: v.array(v.string()) },
  handler: async (ctx, args) => {
    // Remove images whose drive_file_id is NOT in the provided list
    const all = await ctx.db
      .query("inspiration_images")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .collect();

    const keepSet = new Set(args.driveFileIds);
    let removed = 0;
    for (const img of all) {
      if (!keepSet.has(img.drive_file_id)) {
        if (img.storageId) {
          await ctx.storage.delete(img.storageId);
        }
        await ctx.db.delete(img._id);
        removed++;
      }
    }
    return { removed };
  },
});

export const dedup = mutation({
  args: { projectId: v.string() },
  handler: async (ctx, args) => {
    const all = await ctx.db
      .query("inspiration_images")
      .withIndex("by_project", (q) => q.eq("project_id", args.projectId))
      .collect();

    // Group by drive_file_id, keep the first record, delete the rest
    const seen = new Map<string, boolean>();
    let removed = 0;
    for (const img of all) {
      if (seen.has(img.drive_file_id)) {
        // Duplicate — delete the storage file and the record
        if (img.storageId) {
          try { await ctx.storage.delete(img.storageId); } catch (_) { /* already deleted */ }
        }
        await ctx.db.delete(img._id);
        removed++;
      } else {
        seen.set(img.drive_file_id, true);
      }
    }
    return { removed, remaining: all.length - removed };
  },
});

export const getImageUrl = query({
  args: { projectId: v.string(), driveFileId: v.string() },
  handler: async (ctx, args) => {
    const img = await ctx.db
      .query("inspiration_images")
      .withIndex("by_project_and_drive_id", (q) =>
        q
          .eq("project_id", args.projectId)
          .eq("drive_file_id", args.driveFileId)
      )
      .first();
    if (!img || !img.storageId) return null;
    return await ctx.storage.getUrl(img.storageId);
  },
});

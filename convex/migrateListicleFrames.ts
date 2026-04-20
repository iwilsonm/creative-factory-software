import { mutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * One-time data migration: narrow every project's `default_narrative_frames`
 * to a listicle-only list as part of the Mark Builds Brands SOP refactor.
 *
 * Idempotent: running twice produces the same result as running once.
 * Pass `dry_run: true` to log intended writes without actually committing.
 *
 * Runner script: `node scripts/migrate-listicle-frames.js [--dry-run]`.
 */
export const migrateToListicleOnly = mutation({
  args: {
    dry_run: v.boolean(),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("lp_agent_config").collect();
    let rowsScanned = 0;
    let rowsUpdated = 0;
    const updates: Array<{ project_id: string; before: string | null; after: string }> = [];

    for (const row of rows) {
      rowsScanned += 1;
      const current = typeof row.default_narrative_frames === "string"
        ? row.default_narrative_frames
        : null;

      let parsed: unknown = null;
      if (current && current.length > 0) {
        try {
          parsed = JSON.parse(current);
        } catch {
          parsed = null;
        }
      }

      let desired: string[];
      if (Array.isArray(parsed)) {
        const coerced = parsed.filter((id) => id === "listicle");
        desired = coerced.length > 0 ? ["listicle"] : ["listicle"];
      } else {
        desired = ["listicle"];
      }
      const desiredJSON = JSON.stringify(desired);

      if (desiredJSON !== current) {
        updates.push({ project_id: row.project_id, before: current, after: desiredJSON });
        rowsUpdated += 1;
        if (!args.dry_run) {
          await ctx.db.patch(row._id, {
            default_narrative_frames: desiredJSON,
            updated_at: new Date().toISOString(),
          });
        }
      }
    }

    return {
      rows_scanned: rowsScanned,
      rows_updated: rowsUpdated,
      dry_run: args.dry_run,
      updates,
    };
  },
});

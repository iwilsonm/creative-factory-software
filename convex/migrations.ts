// One-shot migration mutations. Run via `npx convex run migrations:<name>`.
// Each is idempotent (safe to re-run). Each is scoped to the deployment it runs against.
// Distinct CF-specific naming (e.g., wipeCFFlexAds) is intentional — discourages running
// these against the Dacia Automation Software deployment, which is a different Convex env.

import { mutation } from "./_generated/server";

// Phase 1 — wipe all flex_ads rows from the Creative Factory deployment.
// Marco confirmed CF has no live flex ads to lose; the legacy Planner/Flex Ad UI is
// being removed in CF in favor of the new Staging Page. DA Software runs on a separate
// Convex deployment so this migration cannot accidentally touch their data.
export const wipeCFFlexAds = mutation({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("flex_ads").collect();
    let deleted = 0;
    for (const fa of all) {
      await ctx.db.delete(fa._id);
      deleted++;
    }
    return { deleted };
  },
});

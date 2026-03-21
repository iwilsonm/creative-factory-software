const { ConvexHttpClient } = require("convex/browser");
const c = new ConvexHttpClient("https://energized-hare-760.convex.cloud");

(async () => {
  // Check deployments created after the batch was created (07:22 UTC)
  const deps = await c.query("ad_deployments:getByProject", { projectId: "5f90d728-4404-430a-991c-bc882ce02e08" });
  const batchCreatedAt = new Date("2026-03-06T07:22:14.496Z").getTime();
  const recentDeps = deps.filter(d => d._creationTime > batchCreatedAt);
  console.log("Deployments created after batch ce215ad0:", recentDeps.length);
  for (const d of recentDeps) {
    console.log("  " + (d.ad_name || d.externalId.slice(0,8)) + " | status: " + d.status + " | deleted: " + (d.deleted_at || "no") + " | created: " + new Date(d._creationTime).toISOString());
  }

  // Check flex ads created after batch
  const flexAds = await c.query("flexAds:getByProject", { projectId: "5f90d728-4404-430a-991c-bc882ce02e08" });
  const recentFlex = flexAds.filter(f => f._creationTime > batchCreatedAt);
  console.log("\nFlex ads created after batch ce215ad0:", recentFlex.length);
  for (const f of recentFlex) {
    console.log("  " + f.name + " | deleted: " + (f.deleted_at || "no") + " | created: " + new Date(f._creationTime).toISOString());
  }

  // Check backend logs - look at the batch more carefully
  const batches = await c.query("batchJobs:getByProject", { projectId: "5f90d728-4404-430a-991c-bc882ce02e08" });
  const batch = batches.find(b => b.externalId.startsWith("ce215ad0"));
  console.log("\nBatch details:");
  console.log("  batch_stats:", batch.batch_stats);
  console.log("  completed_at:", batch.completed_at);
  console.log("  error_message:", batch.error_message || "none");
  console.log("  filter_processed:", batch.filter_processed);
  console.log("  filter_processed_at:", batch.filter_processed_at);
  console.log("  pipeline_state:", batch.pipeline_state);

  // Check if project has scout_default_campaign set
  const projects = await c.query("projects:getAllWithStats");
  const project = projects.find(p => p.externalId === "5f90d728-4404-430a-991c-bc882ce02e08");
  console.log("\nProject scout settings:");
  console.log("  scout_enabled:", project.scout_enabled);
  console.log("  scout_default_campaign:", project.scout_default_campaign || "NOT SET");
  console.log("  scout_cta:", project.scout_cta || "NOT SET");
  console.log("  scout_display_link:", project.scout_display_link || "NOT SET");
})();

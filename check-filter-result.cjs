const { ConvexHttpClient } = require("convex/browser");
const c = new ConvexHttpClient("https://energized-hare-760.convex.cloud");

(async () => {
  // Get the full batch ID
  const batches = await c.query("batchJobs:getByProject", { projectId: "5f90d728-4404-430a-991c-bc882ce02e08" });
  const batch = batches.find(b => b.externalId.startsWith("ce215ad0"));
  if (!batch) { console.log("Batch not found"); return; }
  console.log("Full batch ID:", batch.externalId);
  console.log("Status:", batch.status);
  console.log("Filter processed:", batch.filter_processed);
  console.log("Batch stats:", batch.batch_stats);

  // Check ads for this batch
  const ads = await c.query("adCreatives:getByBatch", { batchId: batch.externalId });
  console.log("\nAds in batch:", ads.length);
  if (ads.length > 0) {
    console.log("Sample ad:", {
      id: ads[0].externalId.slice(0,8),
      status: ads[0].status,
      hasImage: !!ads[0].storageId,
      headline: (ads[0].headline || "").slice(0, 50),
    });
    const withImages = ads.filter(a => a.storageId);
    console.log("Ads with images:", withImages.length);
  }

  // Check flex ads
  const flexAds = await c.query("flexAds:getByProject", { projectId: "5f90d728-4404-430a-991c-bc882ce02e08" });
  flexAds.sort((a, b) => b._creationTime - a._creationTime);
  console.log("\nAll flex ads for project:", flexAds.length);
  for (const f of flexAds.slice(0, 5)) {
    const deleted = f.deleted_at ? "DELETED" : "active";
    console.log("  " + f.name + " | " + deleted + " | created: " + new Date(f._creationTime).toISOString());
  }

  // Check ready_to_post deployments (most recent)
  const deps = await c.query("ad_deployments:getByProject", { projectId: "5f90d728-4404-430a-991c-bc882ce02e08" });
  const nonDeleted = deps.filter(d => !d.deleted_at);
  const ready = nonDeleted.filter(d => d.status === "ready_to_post");
  console.log("\nNon-deleted deployments:", nonDeleted.length);
  console.log("Ready to post:", ready.length);
  ready.sort((a, b) => b._creationTime - a._creationTime);
  for (const d of ready.slice(0, 5)) {
    console.log("  " + (d.ad_name || d.externalId.slice(0,8)) + " | flex_ad_id: " + (d.flex_ad_id || "none") + " | created: " + new Date(d._creationTime).toISOString());
  }

  // Check backend logs for clues
  console.log("\n--- Checking for filter-related errors ---");
  // Look at batch error message if any
  if (batch.error_message) {
    console.log("Batch error:", batch.error_message);
  }
})();

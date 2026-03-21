const { ConvexHttpClient } = require("convex/browser");
const c = new ConvexHttpClient("https://energized-hare-760.convex.cloud");

(async () => {
  // Check all projects
  const projects = await c.query("projects:getAllWithStats");
  console.log("=== PROJECTS ===");
  projects.forEach(p => console.log(p.externalId, "-", p.name));

  // Check all deployments by project
  for (const proj of projects) {
    const deps = await c.query("ad_deployments:getByProject", { projectId: proj.externalId });
    const byStatus = {};
    deps.forEach(d => {
      byStatus[d.status] = (byStatus[d.status] || 0) + 1;
    });
    console.log(`\n=== ${proj.name} (${proj.externalId}) ===`);
    console.log("Deployments by status:", JSON.stringify(byStatus));

    // Show ready_to_post details
    const ready = deps.filter(d => d.status === "ready_to_post");
    if (ready.length > 0) {
      console.log("Ready to post:");
      ready.forEach(d => console.log("  ", d.externalId, "| ad_id:", d.ad_id, "| ad_name:", d.ad_name || "(none)"));
    }
  }

  // Also check flex ads
  const flexes = await c.query("flexAds:getAll");
  console.log("\n=== ALL FLEX ADS ===");
  flexes.forEach(f => {
    let childCount = 0;
    try { childCount = JSON.parse(f.child_deployment_ids || "[]").length; } catch {}
    console.log(f.externalId, "| project:", f.project_id, "| ad_set:", f.ad_set_id || "(none)", "| children:", childCount, "| deleted:", f.deleted_at ? "YES" : "no");
  });
})();

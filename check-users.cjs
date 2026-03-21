const { ConvexHttpClient } = require("convex/browser");
const c = new ConvexHttpClient("https://energized-hare-760.convex.cloud");

(async () => {
  // Check users
  const users = await c.query("users:getAll");
  console.log("=== USERS ===");
  users.forEach(u => console.log(u.username, "|", u.role, "|", u.is_active ? "active" : "INACTIVE", "|", u.display_name || ""));

  // Check all deployments
  const deps = await c.query("ad_deployments:getAll");
  const nonDeleted = deps.filter(d => d.deleted_at === undefined || d.deleted_at === null);
  console.log("\n=== ALL DEPLOYMENTS (non-deleted) ===");
  console.log("Total:", nonDeleted.length);

  // Group by status
  const byStatus = {};
  nonDeleted.forEach(d => {
    byStatus[d.status] = (byStatus[d.status] || 0) + 1;
  });
  console.log("By status:", JSON.stringify(byStatus, null, 2));

  // Group ready_to_post by project_id
  const readyDeps = nonDeleted.filter(d => d.status === "ready_to_post");
  console.log("\n=== READY TO POST ===");
  console.log("Total:", readyDeps.length);
  const byProject = {};
  readyDeps.forEach(d => {
    byProject[d.project_id] = (byProject[d.project_id] || 0) + 1;
  });
  console.log("By project:", JSON.stringify(byProject, null, 2));

  // Check projects
  const projects = await c.query("projects:getAllWithStats");
  console.log("\n=== PROJECTS ===");
  projects.forEach(p => console.log(p.externalId, "-", p.name));
})();

const { ConvexHttpClient } = require("convex/browser");
const c = new ConvexHttpClient("https://energized-hare-760.convex.cloud");

async function check() {
  const batches = await c.query("batchJobs:getByProject", { projectId: "5f90d728-4404-430a-991c-bc882ce02e08" });
  batches.sort((a, b) => b._creationTime - a._creationTime);
  const recent = batches.slice(0, 3);

  console.log("[" + new Date().toLocaleTimeString() + "] Batch status:");
  for (const b of recent) {
    const ps = b.pipeline_state ? JSON.parse(b.pipeline_state) : {};
    const label = ps.stage_label || ps.stage || b.status;
    const stats = b.batch_stats || "";
    console.log("  " + b.externalId.slice(0,8) + " | " + b.status.padEnd(20) + " | " + (label + " " + stats).slice(0,60));
  }

  const completed = recent.filter(b => b.status === "completed" && b.filter_assigned === true && b.filter_processed !== true);
  if (completed.length > 0) {
    console.log("\n  >>> " + completed.length + " batch(es) READY for Creative Filter!");
  }
}

check();

const { ConvexHttpClient } = require("convex/browser");
const { api } = require("./convex/_generated/api.js");
const c = new ConvexHttpClient("https://energized-hare-760.convex.cloud");

async function run() {
  var now = new Date();
  var start = new Date(now.getTime() - 3*24*60*60*1000);
  var costs = await c.query(api.apiCosts.getAggregates, {
    startDate: start.toISOString().split("T")[0],
    endDate: now.toISOString().split("T")[0],
  });

  // byOperation is a Record<string, {cost, imageCount}>, not an array
  var lpOps = [];
  var allOps = [];
  for (var op in costs.byOperation) {
    var entry = { operation: op, totalCost: costs.byOperation[op].cost, count: costs.byOperation[op].imageCount };
    allOps.push(entry);
    if (op.includes("lp_") || op.includes("landing")) {
      lpOps.push(entry);
    }
  }

  // We need call count not image count. Let me get raw records instead.
  var rawCosts = await c.query(api.apiCosts.getAggregates, {
    startDate: start.toISOString().split("T")[0],
    endDate: now.toISOString().split("T")[0],
  });

  console.log("=== LP-Related Costs (Last 3 Days) ===");
  var lpTotal = lpOps.reduce(function(s,o) { return s + o.totalCost; }, 0);
  console.log("Total LP cost: $" + lpTotal.toFixed(2));
  console.log("");
  lpOps.sort(function(a,b) { return b.totalCost - a.totalCost; });
  lpOps.forEach(function(op) {
    console.log("  " + op.operation + ": $" + op.totalCost.toFixed(4));
  });

  console.log("\n=== All Costs by Service (3 days) ===");
  for (var svc in costs.byService) {
    console.log("  " + svc + ": $" + costs.byService[svc].toFixed(2));
  }
  console.log("  Total: $" + costs.total.toFixed(2));

  console.log("\n=== Top 15 Operations by Cost ===");
  allOps.sort(function(a,b) { return b.totalCost - a.totalCost; });
  allOps.slice(0,15).forEach(function(op) {
    console.log("  " + op.operation + ": $" + op.totalCost.toFixed(4));
  });
}
run().catch(function(e) { console.error(e); });

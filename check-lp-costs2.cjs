const { ConvexHttpClient } = require("convex/browser");
const { api } = require("./convex/_generated/api.js");
const c = new ConvexHttpClient("https://energized-hare-760.convex.cloud");

async function run() {
  // Get raw cost records for the last 3 days to count calls
  var now = new Date();
  var start = new Date(now.getTime() - 3*24*60*60*1000);
  var startStr = start.toISOString().split("T")[0];
  var endStr = now.toISOString().split("T")[0];

  // Use getDailyHistory to get all records - actually we need raw records
  // Let's query directly
  var agg = await c.query(api.apiCosts.getAggregates, {
    startDate: startStr,
    endDate: endStr,
  });

  // Show LP image generation costs (Gemini)
  console.log("=== LP Image Costs (Gemini) - from byOperation ===");
  var ops = ["lp_image_generation", "lp_image_prescore_retry", "lp_gauntlet_image_regen", "lp_autofix_image"];
  ops.forEach(function(op) {
    if (agg.byOperation[op]) {
      console.log("  " + op + ": $" + agg.byOperation[op].cost.toFixed(4) + " (" + agg.byOperation[op].imageCount + " images)");
    } else {
      console.log("  " + op + ": $0 (0 calls)");
    }
  });

  // Also check for lp_image_context_extraction (Sonnet)
  var contextOps = ["lp_image_context_extraction", "lp_visual_qa", "lp_autofix_css"];
  contextOps.forEach(function(op) {
    if (agg.byOperation[op]) {
      console.log("  " + op + ": $" + agg.byOperation[op].cost.toFixed(4));
    }
  });

  // Now build a complete LP pipeline cost summary
  console.log("\n=== COMPLETE LP PIPELINE COST BREAKDOWN (3 days) ===");
  var lpOperations = [
    "lp_image_context_extraction",
    "lp_generation",
    "lp_generation_retry",
    "lp_editorial_pass",
    "lp_quality_gate",
    "lp_headline_repair",
    "lp_content_alignment_repair",
    "lp_html_generation",
    "lp_image_generation",
    "lp_image_prescore",
    "lp_image_prescore_retry",
    "lp_gauntlet_score",
    "lp_gauntlet_image_regen",
    "lp_visual_qa",
    "lp_autofix_css",
    "lp_autofix_image",
    "lp_title_only_generation",
  ];

  var grandTotal = 0;
  lpOperations.forEach(function(op) {
    var data = agg.byOperation[op];
    if (data && data.cost > 0) {
      grandTotal += data.cost;
      console.log("  " + op + ": $" + data.cost.toFixed(4));
    }
  });
  console.log("  ---");
  console.log("  LP GRAND TOTAL: $" + grandTotal.toFixed(2));

  // Per-day breakdown
  var daily = await c.query(api.apiCosts.getDailyHistory, { startDate: startStr });
  console.log("\n=== Daily Totals ===");
  daily.forEach(function(d) {
    console.log("  " + d.date + ": $" + d.total.toFixed(2) + " (anthropic: $" + d.anthropic.toFixed(2) + ", gemini: $" + d.gemini.toFixed(2) + ")");
  });
}
run().catch(function(e) { console.error(e); });

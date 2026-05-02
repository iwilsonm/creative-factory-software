import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

const convexUrl = process.env.CONVEX_URL || process.argv[2];
if (!convexUrl) {
  console.error("Missing CONVEX_URL. Set CONVEX_URL or pass it as the first argument.");
  process.exit(1);
}

let host;
try {
  host = new URL(convexUrl).hostname;
} catch {
  console.error(`Invalid CONVEX_URL: ${convexUrl}`);
  process.exit(1);
}

const expectedHost = process.env.EXPECTED_CONVEX_HOST;
if (expectedHost && host !== expectedHost) {
  console.error(`Convex host mismatch. Expected ${expectedHost}, got ${host}.`);
  process.exit(1);
}

const client = new ConvexHttpClient(convexUrl);
try {
  const system = await client.query(api.system.getCapabilities, {});
  const capabilities = system?.capabilities || {};
  if (capabilities.adSetAtomicCombine !== true) {
    console.error("Convex capability check failed: adSetAtomicCombine is not true.");
    process.exit(1);
  }
  if (capabilities.batchCronWorker !== true) {
    console.error("Convex capability check failed: batchCronWorker is not true.");
    process.exit(1);
  }
  console.log(JSON.stringify({
    ok: true,
    convexHost: host,
    capabilities,
  }));
} catch (err) {
  console.error(`Convex capability check failed on ${host}: ${err.message}`);
  process.exit(1);
}

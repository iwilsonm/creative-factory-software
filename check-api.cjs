// Simulate poster user login and fetch ready-to-post deployments
const http = require("http");
const https = require("https");

const BASE_URL = "https://daciaautomation.com";

async function fetchJSON(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const isHttps = parsedUrl.protocol === "https:";
    const mod = isHttps ? https : http;

    const reqOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: options.method || "GET",
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    };

    const req = mod.request(reqOptions, (res) => {
      let data = "";
      // Capture cookies
      const setCookies = res.headers["set-cookie"] || [];
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data), cookies: setCookies });
        } catch {
          resolve({ status: res.statusCode, data: data, cookies: setCookies });
        }
      });
    });
    req.on("error", reject);
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

(async () => {
  // Login as Corinne (poster user)
  console.log("=== Logging in as corinne070716@gmail.com ===");
  const loginResp = await fetchJSON(`${BASE_URL}/api/auth/login`, {
    method: "POST",
    body: { username: "corinne070716@gmail.com", password: "test123" },
  });
  console.log("Login status:", loginResp.status);
  console.log("Login response:", typeof loginResp.data === "object" ? JSON.stringify(loginResp.data) : loginResp.data);

  if (loginResp.status !== 200) {
    console.log("Login failed. Trying to check session without login...");
  }

  // Extract session cookie
  const cookieHeader = loginResp.cookies
    .map(c => c.split(";")[0])
    .join("; ");
  console.log("Session cookie:", cookieHeader || "(none)");

  // Check session
  const sessionResp = await fetchJSON(`${BASE_URL}/api/auth/session`, {
    headers: { Cookie: cookieHeader },
  });
  console.log("\n=== Session check ===");
  console.log("Status:", sessionResp.status);
  console.log("Session data:", JSON.stringify(sessionResp.data));

  // Fetch deployments for Grounding Bedsheet project
  const depsResp = await fetchJSON(`${BASE_URL}/api/deployments?projectId=5f90d728-4404-430a-991c-bc882ce02e08`, {
    headers: { Cookie: cookieHeader },
  });
  console.log("\n=== Deployments for Grounding Bedsheet ===");
  console.log("Status:", depsResp.status);
  if (depsResp.status === 200 && depsResp.data.deployments) {
    const deps = depsResp.data.deployments;
    console.log("Total deployments:", deps.length);
    const byStatus = {};
    deps.forEach(d => { byStatus[d.status] = (byStatus[d.status] || 0) + 1; });
    console.log("By status:", JSON.stringify(byStatus));
    const readyDeps = deps.filter(d => d.status === "ready_to_post");
    console.log("Ready to post:", readyDeps.length);
    readyDeps.forEach(d => console.log("  ", d.id, d.ad_name || "(no name)"));
  } else {
    console.log("Response:", JSON.stringify(depsResp.data).substring(0, 500));
  }
})();

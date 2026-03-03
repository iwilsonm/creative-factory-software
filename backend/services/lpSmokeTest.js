/**
 * LP Smoke Test — automated post-publish checks on a live Shopify LP.
 *
 * All checks are automated — no LLM calls needed.
 * Uses Puppeteer for rendering checks + fetch for HTTP checks.
 */

/**
 * Run a post-publish smoke test on a live LP URL.
 *
 * @param {string} url - Published LP URL (Shopify)
 * @param {object} [options]
 * @param {string} [options.expectedHeadline] - Headline text to verify
 * @param {string} [options.pdpUrl] - Expected PDP URL for CTA validation
 * @returns {Promise<{ passed: boolean, checks: Array<{name: string, passed: boolean, detail: string}>, failedCount: number }>}
 */
export async function runSmokeTest(url, options = {}) {
  const { expectedHeadline, pdpUrl } = options;
  const checks = [];

  console.log(`[LP SmokeTest] Testing: ${url}`);

  let browser;
  try {
    // ─── Check 1: HTTP 200 + Load time ───
    const startTime = Date.now();
    let response;
    try {
      response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
    } catch (fetchErr) {
      checks.push({
        name: 'http_status',
        passed: false,
        detail: `Fetch failed: ${fetchErr.message}`,
      });
      return { passed: false, checks, failedCount: 1 };
    }

    const loadTime = Date.now() - startTime;
    checks.push({
      name: 'http_status',
      passed: response.ok,
      detail: response.ok ? `HTTP ${response.status}` : `HTTP ${response.status} — ${response.statusText}`,
    });

    // ─── Check 2: Load time < 15s ───
    checks.push({
      name: 'load_time',
      passed: loadTime < 15000,
      detail: `${(loadTime / 1000).toFixed(1)}s`,
    });

    if (!response.ok) {
      return { passed: false, checks, failedCount: checks.filter(c => !c.passed).length };
    }

    const htmlContent = await response.text();

    // ─── Check 3: No raw {{...}} placeholders ───
    const rawPlaceholders = htmlContent.match(/\{\{[^}]+\}\}/g) || [];
    checks.push({
      name: 'no_placeholders',
      passed: rawPlaceholders.length === 0,
      detail: rawPlaceholders.length === 0
        ? 'No placeholders found'
        : `Found ${rawPlaceholders.length}: ${rawPlaceholders.slice(0, 3).join(', ')}`,
    });

    // ─── Puppeteer-based checks ───
    const puppeteer = (await import('puppeteer')).default;
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
      ],
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2000));

    // ─── Check 4: Headline present ───
    if (expectedHeadline) {
      const headlineFound = await page.evaluate((headline) => {
        return document.body.innerText.includes(headline);
      }, expectedHeadline);
      checks.push({
        name: 'headline_present',
        passed: headlineFound,
        detail: headlineFound ? 'Headline found' : 'Headline not found in page text',
      });
    }

    // ─── Check 5: Images load (>50% must load) ───
    const imageStats = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img'));
      const total = imgs.length;
      const loaded = imgs.filter(img => img.complete && img.naturalWidth > 0).length;
      return { total, loaded };
    });
    const imgPassRate = imageStats.total > 0 ? imageStats.loaded / imageStats.total : 1;
    checks.push({
      name: 'images_load',
      passed: imgPassRate >= 0.5,
      detail: `${imageStats.loaded}/${imageStats.total} images loaded (${Math.round(imgPassRate * 100)}%)`,
    });

    // ─── Check 6: CTA links valid ───
    if (pdpUrl) {
      const ctaInfo = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a[href]'));
        return links
          .filter(a => a.innerText.match(/order|buy|shop|get|claim|try/i))
          .map(a => a.href);
      });
      const validCTAs = ctaInfo.filter(href =>
        href && !href.endsWith('#') && !href.includes('example.com') && !href.includes('placeholder')
      );
      checks.push({
        name: 'cta_links',
        passed: ctaInfo.length === 0 || validCTAs.length > 0,
        detail: `${validCTAs.length}/${ctaInfo.length} CTA links valid`,
      });
    }

    // ─── Check 7: Mobile rendering (no horizontal overflow at 375px) ───
    await page.setViewport({ width: 375, height: 812 });
    await new Promise(r => setTimeout(r, 1000));
    const mobileOverflow = await page.evaluate(() => {
      return document.documentElement.scrollWidth > window.innerWidth + 5; // 5px tolerance
    });
    checks.push({
      name: 'mobile_rendering',
      passed: !mobileOverflow,
      detail: mobileOverflow ? 'Horizontal overflow detected at 375px' : 'No horizontal overflow',
    });

    await browser.close();
    browser = null;
  } catch (err) {
    if (browser) {
      try { await browser.close(); } catch {}
    }
    checks.push({
      name: 'smoke_test_error',
      passed: false,
      detail: `Error: ${err.message}`,
    });
  }

  const failedCount = checks.filter(c => !c.passed).length;
  const result = { passed: failedCount === 0, checks, failedCount };

  console.log(`[LP SmokeTest] ${result.passed ? 'PASSED' : 'FAILED'} (${failedCount} failed): ${url}`);
  for (const check of checks) {
    if (!check.passed) {
      console.log(`[LP SmokeTest]   ✗ ${check.name}: ${check.detail}`);
    }
  }

  return result;
}

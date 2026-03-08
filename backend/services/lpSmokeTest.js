/**
 * LP Smoke Test — automated post-publish checks on a live Shopify LP.
 *
 * All checks are automated — no LLM calls needed.
 * Uses Puppeteer for rendering checks + fetch for HTTP checks.
 */

const RAW_PLACEHOLDER_REGEX = /\{\{[^}]+\}\}/g;
const VISIBLE_PLACEHOLDER_PATTERNS = [
  /\{\{[^}]+\}\}/gi,
  /\[[A-Z][A-Z0-9 _-]{2,}\]/g,
  /lorem ipsum/gi,
];

function dedupeMatches(matches = []) {
  return [...new Set(matches.map((value) => String(value || '').trim()).filter(Boolean))];
}

async function withBrowserPage(fn) {
  const puppeteer = (await import('puppeteer')).default;
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
    ],
  });

  try {
    const page = await browser.newPage();
    return await fn(page);
  } finally {
    try { await browser.close(); } catch {}
  }
}

async function collectVisiblePlaceholderMatches(page) {
  return await page.evaluate(() => {
    const patterns = [
      /\{\{[^}]+\}\}/gi,
      /\[[A-Z][A-Z0-9 _-]{2,}\]/g,
      /lorem ipsum/gi,
    ];
    const blockedTags = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
    const matches = new Set();

    function isVisible(node) {
      if (!node || !node.parentElement) return false;
      if (blockedTags.has(node.parentElement.tagName)) return false;

      let current = node.parentElement;
      while (current) {
        if (blockedTags.has(current.tagName)) return false;
        const style = window.getComputedStyle(current);
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          style.opacity === '0'
        ) {
          return false;
        }
        current = current.parentElement;
      }

      const rect = node.parentElement.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let currentNode = walker.nextNode();
    while (currentNode) {
      const text = currentNode.textContent || '';
      if (text.trim() && isVisible(currentNode)) {
        for (const pattern of patterns) {
          const found = text.match(pattern) || [];
          for (const match of found) {
            matches.add(match.trim());
          }
        }
      }
      currentNode = walker.nextNode();
    }

    return Array.from(matches);
  });
}

export async function inspectVisiblePlaceholdersInHtml(html) {
  return await withBrowserPage(async (page) => {
    await page.setViewport({ width: 1280, height: 800 });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    return dedupeMatches(await collectVisiblePlaceholderMatches(page));
  });
}

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

  try {
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

    checks.push({
      name: 'load_time',
      passed: loadTime < 15000,
      detail: `${(loadTime / 1000).toFixed(1)}s`,
    });

    if (!response.ok) {
      return { passed: false, checks, failedCount: checks.filter((check) => !check.passed).length };
    }

    const htmlContent = await response.text();
    const rawHtmlPlaceholderMatches = dedupeMatches(htmlContent.match(RAW_PLACEHOLDER_REGEX) || []);
    checks.push({
      name: 'raw_html_placeholders',
      passed: true,
      detail: rawHtmlPlaceholderMatches.length === 0
        ? 'No raw HTML placeholder tokens found'
        : `Diagnostic only — found ${rawHtmlPlaceholderMatches.length}: ${rawHtmlPlaceholderMatches.slice(0, 5).join(', ')}`,
    });

    const pageData = await withBrowserPage(async (page) => {
      await page.setViewport({ width: 1280, height: 800 });
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const visiblePlaceholderMatches = dedupeMatches(await collectVisiblePlaceholderMatches(page));

      let headlineFound = null;
      if (expectedHeadline) {
        headlineFound = await page.evaluate((headline) => {
          return document.body.innerText.includes(headline);
        }, expectedHeadline);
      }

      const imageStats = await page.evaluate(() => {
        const imgs = Array.from(document.querySelectorAll('img'));
        const total = imgs.length;
        const loaded = imgs.filter((img) => img.complete && img.naturalWidth > 0).length;
        return { total, loaded };
      });

      let ctaInfo = [];
      if (pdpUrl) {
        ctaInfo = await page.evaluate(() => {
          const links = Array.from(document.querySelectorAll('a[href]'));
          return links
            .filter((anchor) => anchor.innerText.match(/order|buy|shop|get|claim|try/i))
            .map((anchor) => anchor.href);
        });
      }

      await page.setViewport({ width: 375, height: 812 });
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const mobileOverflow = await page.evaluate(() => {
        return document.documentElement.scrollWidth > window.innerWidth + 5;
      });

      return {
        visiblePlaceholderMatches,
        headlineFound,
        imageStats,
        ctaInfo,
        mobileOverflow,
      };
    });

    checks.push({
      name: 'no_placeholders',
      passed: pageData.visiblePlaceholderMatches.length === 0,
      detail: pageData.visiblePlaceholderMatches.length === 0
        ? 'No visible placeholders found'
        : `Visible placeholders: ${pageData.visiblePlaceholderMatches.slice(0, 5).join(', ')}`,
    });

    if (expectedHeadline) {
      checks.push({
        name: 'headline_present',
        passed: !!pageData.headlineFound,
        detail: pageData.headlineFound ? 'Headline found' : 'Headline not found in page text',
      });
    }

    const imgPassRate = pageData.imageStats.total > 0
      ? pageData.imageStats.loaded / pageData.imageStats.total
      : 1;
    checks.push({
      name: 'images_load',
      passed: imgPassRate >= 0.5,
      detail: `${pageData.imageStats.loaded}/${pageData.imageStats.total} images loaded (${Math.round(imgPassRate * 100)}%)`,
    });

    if (pdpUrl) {
      const validCTAs = pageData.ctaInfo.filter((href) =>
        href && !href.endsWith('#') && !href.includes('example.com') && !href.includes('placeholder')
      );
      checks.push({
        name: 'cta_links',
        passed: pageData.ctaInfo.length === 0 || validCTAs.length > 0,
        detail: `${validCTAs.length}/${pageData.ctaInfo.length} CTA links valid`,
      });
    }

    checks.push({
      name: 'mobile_rendering',
      passed: !pageData.mobileOverflow,
      detail: pageData.mobileOverflow ? 'Horizontal overflow detected at 375px' : 'No horizontal overflow',
    });

    const failedCount = checks.filter((check) => !check.passed).length;
    const result = {
      passed: failedCount === 0,
      checks,
      failedCount,
      visiblePlaceholderMatches: pageData.visiblePlaceholderMatches,
      visiblePlaceholderCount: pageData.visiblePlaceholderMatches.length,
      rawHtmlPlaceholderMatches,
      rawHtmlPlaceholderCount: rawHtmlPlaceholderMatches.length,
    };

    console.log(`[LP SmokeTest] ${result.passed ? 'PASSED' : 'FAILED'} (${failedCount} failed): ${url}`);
    for (const check of checks) {
      if (!check.passed) {
        console.log(`[LP SmokeTest]   ✗ ${check.name}: ${check.detail}`);
      }
    }

    return result;
  } catch (err) {
    checks.push({
      name: 'smoke_test_error',
      passed: false,
      detail: `Error: ${err.message}`,
    });
    return {
      passed: false,
      checks,
      failedCount: checks.filter((check) => !check.passed).length,
      visiblePlaceholderMatches: [],
      visiblePlaceholderCount: 0,
      rawHtmlPlaceholderMatches: [],
      rawHtmlPlaceholderCount: 0,
    };
  }
}

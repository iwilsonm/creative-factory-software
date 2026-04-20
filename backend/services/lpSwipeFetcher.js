/**
 * LP Swipe Fetcher — Headless browser page capture
 *
 * Replaces the old PDF upload flow. Given a URL, this service:
 * 1. Launches headless Chromium via Puppeteer
 * 2. Navigates to the page with a realistic user-agent
 * 3. Takes a full-page JPEG screenshot (capped at 10000px height)
 * 4. Extracts all visible text via document.body.innerText
 * 5. Uploads the screenshot to Convex storage
 * 6. Returns { screenshotStorageId, textContent }
 *
 * Memory note: Chromium uses ~100-200MB RAM. We launch and close per fetch —
 * no persistent browser instance. VPS runs PM2 with 512MB max.
 */

import puppeteer from 'puppeteer';
import { uploadBuffer } from '../convexClient.js';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const MAX_SCREENSHOT_HEIGHT = 7900; // Claude API rejects images >8000px in any dimension
const NAVIGATION_TIMEOUT = 45000;

// Transient Chromium navigation errors — the remote edge briefly dropped us,
// usually Cloudflare/anti-bot flap or a momentary TCP reset. Retrying after
// a short wait almost always works on the second try.
const TRANSIENT_NAV_ERROR_CODES = [
  'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_CLOSED',
  'ERR_CONNECTION_ABORTED',
  'ERR_ABORTED',
  'ERR_NETWORK_CHANGED',
  'ERR_HTTP2_PROTOCOL_ERROR',
  'ERR_EMPTY_RESPONSE',
];
const MAX_TRANSIENT_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 1500;

function isTransientNavError(message = '') {
  return TRANSIENT_NAV_ERROR_CODES.some((code) => message.includes(code));
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch a swipe page URL using a headless browser.
 *
 * @param {string} url - The URL to fetch
 * @param {(event: object) => void} sendEvent - SSE event callback
 * @returns {Promise<{ screenshotStorageId: string, textContent: string }>}
 */
export async function fetchSwipePage(url, sendEvent) {
  // Validate URL
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error('Only HTTP and HTTPS URLs are supported.');
    }
  } catch (err) {
    if (err.message.includes('Only HTTP')) throw err;
    throw new Error(`Invalid URL: "${url}". Please enter a valid web address.`);
  }

  // Block private/internal IPs to prevent SSRF
  const { hostname } = parsedUrl;
  const blockedPatterns = [
    /^localhost$/i,
    /^127\./,
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^169\.254\./,
    /^0\./,
    /^\[?::1\]?$/,
    /^\[?fe80:/i,
    /^\[?fc00:/i,
    /^\[?fd/i,
  ];
  if (blockedPatterns.some(p => p.test(hostname))) {
    throw new Error('URLs pointing to internal/private addresses are not allowed.');
  }

  sendEvent({ type: 'progress', step: 'fetch_loading', message: 'Loading swipe page...' });

  let browser;
  try {
    // Launch headless Chromium — use 'new' headless mode for better compatibility.
    // --single-process was dropped: it saved ~50MB of RAM but caused sporadic
    // ERR_CONNECTION_RESET against sites behind Cloudflare/anti-bot (the
    // single-process fingerprint is unusual enough to trip edge flap).
    // --disable-blink-features=AutomationControlled suppresses the
    // `navigator.webdriver` flag so basic bot checks pass.
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',     // Use /tmp instead of /dev/shm (limited on VPS)
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-blink-features=AutomationControlled',
      ],
    });

    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1440, height: 900 });

    // Navigate to URL — try networkidle2 first (allows 2 outstanding connections),
    // fall back to domcontentloaded + manual wait if that times out.
    // networkidle0 is too strict — modern sites with analytics/tracking never reach zero connections.
    // Transient Chromium errors (ERR_CONNECTION_RESET etc. — typically a
    // Cloudflare/anti-bot flap) get retried up to MAX_TRANSIENT_RETRIES times
    // with a short backoff before we surface them to the user.
    let usedFallback = false;
    let transientAttempts = 0;
    let lastTransientMessage = '';
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        await page.goto(url, {
          waitUntil: 'networkidle2',
          timeout: NAVIGATION_TIMEOUT,
        });
        break;
      } catch (navErr) {
        const msg = navErr.message || '';

        // Permanent errors — rethrow immediately with friendly messages.
        if (msg.includes('net::ERR_NAME_NOT_RESOLVED')) {
          throw new Error(`Could not resolve domain "${parsedUrl.hostname}". Check the URL and try again.`);
        }
        if (msg.includes('net::ERR_CONNECTION_REFUSED')) {
          throw new Error(`Connection refused by "${parsedUrl.hostname}". The site may be down.`);
        }
        if (msg.includes('net::ERR_SSL')) {
          throw new Error(`SSL error connecting to "${parsedUrl.hostname}". The site may have certificate issues.`);
        }

        // Transient network error — retry a couple of times with backoff.
        if (isTransientNavError(msg) && transientAttempts < MAX_TRANSIENT_RETRIES) {
          transientAttempts += 1;
          lastTransientMessage = msg;
          const delay = RETRY_BASE_DELAY_MS * transientAttempts;
          sendEvent({
            type: 'progress',
            step: 'fetch_loading',
            message: `Connection dropped by "${parsedUrl.hostname}" — retrying (${transientAttempts}/${MAX_TRANSIENT_RETRIES}) in ${Math.round(delay / 1000)}s...`,
          });
          await sleep(delay);
          continue;
        }

        if (isTransientNavError(msg)) {
          throw new Error(`"${parsedUrl.hostname}" kept dropping the connection after ${MAX_TRANSIENT_RETRIES} retries (${msg.split('\n')[0]}). Try again in a minute, or pick a different URL.`);
        }

        // Timeout — fall back to domcontentloaded + manual wait.
        if (msg.includes('timeout') || msg.includes('TimeoutError')) {
          sendEvent({ type: 'progress', step: 'fetch_loading', message: 'Page loading slowly, retrying with fallback...' });
          try {
            await page.goto(url, {
              waitUntil: 'domcontentloaded',
              timeout: NAVIGATION_TIMEOUT,
            });
            usedFallback = true;
            break;
          } catch (fallbackErr) {
            const fbMsg = fallbackErr.message || '';
            if (fbMsg.includes('timeout') || fbMsg.includes('TimeoutError')) {
              throw new Error(`Page took too long to load (>${NAVIGATION_TIMEOUT / 1000}s). The site may be slow or blocking automated access. Try a different URL.`);
            }
            throw new Error(`Failed to load page: ${fbMsg}`);
          }
        }

        throw new Error(`Failed to load page: ${msg}`);
      }
    }
    // Reference lastTransientMessage so lint stays quiet when MAX_TRANSIENT_RETRIES is 0.
    void lastTransientMessage;

    // Wait for lazy-loaded content — longer wait if we used the fallback strategy
    const contentWaitMs = usedFallback ? 5000 : 2000;
    await page.evaluate((ms) => new Promise(r => setTimeout(r, ms)), contentWaitMs);

    sendEvent({ type: 'progress', step: 'fetch_capturing', message: 'Taking screenshot and extracting text...' });

    // Get page dimensions for screenshot height cap
    const bodyHeight = await page.evaluate(() => document.body.scrollHeight);
    const cappedHeight = Math.min(bodyHeight, MAX_SCREENSHOT_HEIGHT);

    // Resize viewport to capped height — screenshot captures only the viewport (no fullPage)
    await page.setViewport({ width: 1440, height: cappedHeight });

    // Take viewport-only screenshot as JPEG (NOT fullPage — that ignores the height cap)
    const screenshotBuffer = await page.screenshot({
      type: 'jpeg',
      quality: 90,
      clip: { x: 0, y: 0, width: 1440, height: cappedHeight },
    });

    // Extract visible text
    const textContent = await page.evaluate(() => {
      // Remove script and style elements to get clean text
      const clone = document.body.cloneNode(true);
      const scripts = clone.querySelectorAll('script, style, noscript');
      scripts.forEach(el => el.remove());
      return (clone.innerText || clone.textContent || '').trim();
    });

    // Close browser before uploading (free memory ASAP)
    await browser.close();
    browser = null;

    // Upload screenshot to Convex storage
    const screenshotStorageId = await uploadBuffer(
      Buffer.from(screenshotBuffer),
      'image/jpeg'
    );

    sendEvent({
      type: 'fetch_complete',
      text_length: textContent.length,
      screenshot_saved: true,
    });

    return {
      screenshotStorageId,
      textContent,
      screenshotBuffer: Buffer.from(screenshotBuffer), // Keep in memory for design analysis
    };
  } catch (err) {
    // Ensure browser is closed on any error
    if (browser) {
      try { await browser.close(); } catch {}
    }
    throw err;
  }
}

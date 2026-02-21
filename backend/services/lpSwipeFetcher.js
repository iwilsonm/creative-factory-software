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

const MAX_SCREENSHOT_HEIGHT = 10000;
const NAVIGATION_TIMEOUT = 30000;

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

  sendEvent({ type: 'progress', step: 'fetch_loading', message: 'Loading swipe page...' });

  let browser;
  try {
    // Launch headless Chromium — use 'new' headless mode for better compatibility
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',     // Use /tmp instead of /dev/shm (limited on VPS)
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--single-process',             // Reduce memory on constrained VPS
      ],
    });

    const page = await browser.newPage();
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1440, height: 900 });

    // Navigate to URL
    try {
      await page.goto(url, {
        waitUntil: 'networkidle0',
        timeout: NAVIGATION_TIMEOUT,
      });
    } catch (navErr) {
      const msg = navErr.message || '';
      if (msg.includes('timeout') || msg.includes('TimeoutError')) {
        throw new Error(`Page took too long to load (>${NAVIGATION_TIMEOUT / 1000}s). The site may be slow or blocking automated access. Try a different URL.`);
      }
      if (msg.includes('net::ERR_NAME_NOT_RESOLVED')) {
        throw new Error(`Could not resolve domain "${parsedUrl.hostname}". Check the URL and try again.`);
      }
      if (msg.includes('net::ERR_CONNECTION_REFUSED')) {
        throw new Error(`Connection refused by "${parsedUrl.hostname}". The site may be down.`);
      }
      if (msg.includes('net::ERR_SSL')) {
        throw new Error(`SSL error connecting to "${parsedUrl.hostname}". The site may have certificate issues.`);
      }
      throw new Error(`Failed to load page: ${msg}`);
    }

    // Wait a bit for any lazy-loaded content
    await page.evaluate(() => new Promise(r => setTimeout(r, 1500)));

    sendEvent({ type: 'progress', step: 'fetch_capturing', message: 'Taking screenshot and extracting text...' });

    // Get page dimensions for screenshot height cap
    const bodyHeight = await page.evaluate(() => document.body.scrollHeight);
    const cappedHeight = Math.min(bodyHeight, MAX_SCREENSHOT_HEIGHT);

    // Resize viewport to full width at capped height so fullPage screenshot works
    await page.setViewport({ width: 1440, height: cappedHeight });

    // Take full-page screenshot as JPEG
    const screenshotBuffer = await page.screenshot({
      fullPage: true,
      type: 'jpeg',
      quality: 90,
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

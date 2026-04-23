/**
 * Ad image utilities — product image loading, ad enrichment, and thumbnail generation.
 *
 * Extracted from routes/ads.js to keep route handlers thin.
 */

import { downloadToBuffer, getAdImageUrl } from '../convexClient.js';
import { withRetry } from '../services/retry.js';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

/**
 * Load project-level product image as base64 if available.
 * @param {object} project - The project record (needs product_image_storageId)
 * @returns {Promise<{ base64: string, mimeType: string } | null>}
 */
export async function getProjectProductImage(project) {
  if (!project.product_image_storageId) return null;
  try {
    const buffer = await downloadToBuffer(project.product_image_storageId);
    return { base64: buffer.toString('base64'), mimeType: 'image/png' };
  } catch (err) {
    console.warn('[Ads] Could not load project product image:', err.message);
    return null;
  }
}

/**
 * Generate (or serve from cache) a 400px JPEG thumbnail for an ad.
 * @param {string} adId - The ad creative's externalId
 * @param {string} thumbCacheDir - Absolute path to the thumbnail cache directory
 * @returns {Promise<{ cached: true, path: string } | { cached: false, buffer: Buffer }>}
 */
export async function generateThumbnail(adId, thumbCacheDir) {
  const thumbPath = path.join(thumbCacheDir, `${adId}.jpg`);

  // Serve from disk cache if available
  if (fs.existsSync(thumbPath)) {
    return { cached: true, path: thumbPath };
  }

  const url = await getAdImageUrl(adId);
  if (!url) throw new Error('Image not found');

  const buffer = await withRetry(async () => {
    const imgRes = await fetch(url);
    if (!imgRes.ok) {
      throw new Error(`Failed to fetch original image: ${imgRes.status}`);
    }
    const ab = await imgRes.arrayBuffer();
    return Buffer.from(ab);
  }, { maxRetries: 3, label: 'Thumbnail fetch' });

  const thumb = await sharp(buffer)
    .resize({ width: 400, withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();

  // Write to disk cache (fire-and-forget)
  fs.writeFile(thumbPath, thumb, () => {});

  return { cached: false, buffer: thumb };
}

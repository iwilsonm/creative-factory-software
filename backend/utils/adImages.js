/**
 * Ad image utilities — product image loading, ad enrichment, and thumbnail generation.
 *
 * Extracted from routes/ads.js to keep route handlers thin.
 */

import { downloadToBuffer, uploadBuffer, getAdImageUrl } from '../convexClient.js';
import { withRetry } from '../services/retry.js';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

/**
 * Copy a Convex storage blob to a NEW storage ID with independent ownership.
 * Used when a child record (e.g., a batch) needs its own copy of a parent's
 * (e.g., project's) product image so deleting the child doesn't wipe the parent's blob.
 * @param {string} sourceStorageId - The blob to copy
 * @param {string} contentType - Defaults to 'image/png'
 * @returns {Promise<string>} - The new storage ID
 */
export async function copyStorageBlob(sourceStorageId, contentType = 'image/png') {
  const buf = await downloadToBuffer(sourceStorageId);
  return await uploadBuffer(buf, contentType);
}

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
    // Throw with a tagged code so the route can emit a user-visible SSE warning
    // instead of silently generating without the product image.
    const wrapped = new Error(`Project product image could not be loaded: ${err.message}`);
    wrapped.code = 'product_image_fetch_failed';
    throw wrapped;
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

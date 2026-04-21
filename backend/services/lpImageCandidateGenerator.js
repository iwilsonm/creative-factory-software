/**
 * LP Image Candidate Generator — fans out the GPT-5.4 image concepts into
 * actual Nano Banana 2 (Gemini 3.1 Flash Image Preview) image candidates.
 *
 * Per PEF plan 2026-04-21:
 *   - Concurrency 3 (shared with the existing Gemini rate limiter).
 *   - Upload-and-release: each image uploads to Convex blob storage and the
 *     buffer is released BEFORE the next candidate starts. Never holds more
 *     than 1 image buffer at a time → safe for the 2GB PM2 cap.
 *   - Failed candidates are NOT silently dropped. They append with
 *     generation_status='failed_permanent' (or 'failed_transient' if retries
 *     exhausted) so the frontend can show a Retry button.
 */

import { v4 as uuidv4 } from 'uuid';
import { generateImage } from './gemini.js';
import { uploadBuffer, getStorageUrl } from '../convexClient.js';

const NANO_BANANA_2_MODEL_KEY = 'nano-banana-2'; // Resolves to 'gemini-3.1-flash-image-preview' in gemini.js

const SUPPORTED_ASPECT_RATIOS = ['16:9', '1:1', '3:2', '4:5', '9:16'];

/**
 * Normalize a concept's aspect_ratio to the supported set.
 * Falls back to '16:9' for unrecognized ratios.
 */
function normalizeAspectRatio(ratio) {
  const cleaned = String(ratio || '').trim();
  if (SUPPORTED_ASPECT_RATIOS.includes(cleaned)) return cleaned;
  // Common variants
  if (/^16:\s*9$/i.test(cleaned)) return '16:9';
  if (/^1:\s*1$/i.test(cleaned)) return '1:1';
  if (/^3:\s*2$/i.test(cleaned)) return '3:2';
  if (/^4:\s*5$/i.test(cleaned)) return '4:5';
  if (/^9:\s*16$/i.test(cleaned)) return '9:16';
  return '16:9';
}

/**
 * Generate one image for a single concept. Returns a candidate object.
 * On error: returns a candidate with generation_status indicating the failure type.
 */
async function generateOneCandidate(concept, projectId) {
  const candidateId = uuidv4();
  const aspectRatio = normalizeAspectRatio(concept.aspect_ratio);
  const baseRecord = {
    candidate_id: candidateId,
    concept_label: concept.concept_label,
    nano_banana_prompt: concept.nano_banana_prompt,
    aspect_ratio: aspectRatio,
    suggested_slot_role: concept.suggested_slot_role || 'general',
    generated_at: new Date().toISOString(),
  };

  try {
    const { imageBuffer, mimeType } = await generateImage(
      concept.nano_banana_prompt,
      aspectRatio,
      null, // no productImage reference
      {
        projectId,
        operation: 'lp_image_candidate',
        imageModel: NANO_BANANA_2_MODEL_KEY,
      }
    );

    if (!imageBuffer) {
      return {
        ...baseRecord,
        storageId: null,
        storageUrl: null,
        generation_status: 'failed_permanent',
        generation_error: 'Nano Banana 2 returned no image buffer',
      };
    }

    // Upload-and-release: write to Convex storage immediately, then drop the buffer.
    const storageId = await uploadBuffer(imageBuffer, mimeType || 'image/png');
    let storageUrl = null;
    try {
      storageUrl = await getStorageUrl(storageId);
    } catch (urlErr) {
      console.warn(`[lpImageCandidateGenerator] getStorageUrl failed for ${storageId}: ${urlErr.message}`);
    }
    return {
      ...baseRecord,
      storageId,
      storageUrl,
      generation_status: 'succeeded',
      generation_error: null,
    };
  } catch (err) {
    // Classify failure: rate-limit / capacity = transient (Retry can succeed),
    // anything else (refused prompt, invalid input) = permanent.
    const msg = String(err?.message || '');
    const isTransient = /rate limit|RESOURCE_EXHAUSTED|429|capacity|temporarily/i.test(msg);
    return {
      ...baseRecord,
      storageId: null,
      storageUrl: null,
      generation_status: isTransient ? 'failed_transient' : 'failed_permanent',
      generation_error: msg.slice(0, 500),
    };
  }
}

/**
 * Generate all image candidates for an LP. Concurrency is capped by the
 * Gemini wrapper's rate limiter (concurrency 3). Each candidate uploads
 * immediately so we never hold more than ~3 image buffers in memory.
 *
 * @param {object} params
 * @param {string} params.projectId
 * @param {string} params.lpId - external LP id (for SSE labeling)
 * @param {Array<{concept_label, nano_banana_prompt, aspect_ratio, suggested_slot_role}>} params.concepts
 * @param {(event: object) => void} sendEvent - SSE event callback
 * @returns {Promise<Array<object>>} Candidate records (succeeded + failed mixed)
 */
export async function generateImageCandidates({
  projectId,
  lpId,
  concepts = [],
}, sendEvent = () => {}) {
  if (!Array.isArray(concepts) || concepts.length === 0) {
    return [];
  }

  const total = concepts.length;
  const candidates = new Array(total);
  let completed = 0;
  let succeeded = 0;
  let failed = 0;

  sendEvent({
    type: 'progress',
    step: 'image_candidates',
    message: `Generating ${total} image candidates with Nano Banana 2...`,
    total,
    completed: 0,
  });

  // Fire all in parallel; the Gemini rate limiter (concurrency 3) gates them.
  // Each promise writes its result into candidates[i] in-place to preserve order.
  const tasks = concepts.map((concept, idx) =>
    generateOneCandidate(concept, projectId).then((record) => {
      candidates[idx] = record;
      completed += 1;
      if (record.generation_status === 'succeeded') succeeded += 1;
      else failed += 1;
      sendEvent({
        type: 'progress',
        step: 'image_candidates',
        message: `Image candidate ${completed}/${total}: ${record.concept_label} (${record.generation_status})`,
        total,
        completed,
        succeeded,
        failed,
        last_concept: record.concept_label,
        last_status: record.generation_status,
      });
      return record;
    })
  );

  await Promise.all(tasks);

  sendEvent({
    type: 'progress',
    step: 'image_candidates_complete',
    message: `Generated ${succeeded}/${total} image candidates (${failed} failed).`,
    total,
    succeeded,
    failed,
    lpId,
  });

  return candidates;
}

// Exported helpers for unit testing.
export const __test__ = {
  generateOneCandidate,
  normalizeAspectRatio,
};

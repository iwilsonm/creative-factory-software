import { v4 as uuidv4 } from 'uuid';
import { chat, chatWithImage, chatWithImages } from './openai.js';
import { chat as claudeChat, chatWithImage as claudeChatWithImage } from './anthropic.js';
import { generateImage } from './gemini.js';
import { withHeavyLLMLimit } from './rateLimiter.js';
import {
  getProject, getLatestDoc, uploadBuffer, downloadToBuffer,
  getInspirationImages, getInspirationImageUrl,
  getAdImageUrl, getSetting, convexClient, api
} from '../convexClient.js';
import sharp from 'sharp';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
// Drive upload removed — ads are stored in Convex only

// Pre-generate thumbnail cache for newly created ads
const __adgen_dirname = path.dirname(fileURLToPath(import.meta.url));
const THUMB_CACHE_DIR = path.join(__adgen_dirname, '..', '.thumb-cache');
if (!fs.existsSync(THUMB_CACHE_DIR)) {
  fs.mkdirSync(THUMB_CACHE_DIR, { recursive: true });
}
async function precacheThumb(adId, imageBuffer) {
  try {
    const thumb = await sharp(imageBuffer)
      .resize({ width: 400, withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    fs.writeFile(path.join(THUMB_CACHE_DIR, `${adId}.jpg`), thumb, () => {});
  } catch (e) { /* non-critical */ }
}

const EXT_TO_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml'
};

/**
 * Extract headline and body copy from a freeform image generation prompt.
 * Uses GPT-4.1-mini with JSON response format for reliable parsing.
 * Non-blocking — returns nulls if extraction fails.
 */
export async function extractHeadlineAndBody(imagePrompt) {
  if (!imagePrompt || !imagePrompt.trim()) return { headline: null, body_copy: null };
  try {
    const result = await chat([
      {
        role: 'system',
        content: `You extract the headline and body copy from image generation prompts. Return JSON with exactly two fields:
- "headline": The main headline text that appears on the ad (the large, prominent text). Extract ONLY the text itself, not formatting instructions.
- "body_copy": The supporting body copy / subheadline text (smaller text below the headline). Extract ONLY the text itself.

If the prompt doesn't contain a clear headline, set headline to null.
If the prompt doesn't contain body copy, set body_copy to null.
Return ONLY valid JSON, no markdown.`
      },
      {
        role: 'user',
        content: imagePrompt
      }
    ], 'gpt-4.1-mini', { response_format: { type: 'json_object' }, operation: 'ad_headline_extraction' });

    const parsed = JSON.parse(result);
    return {
      headline: parsed.headline || null,
      body_copy: parsed.body_copy || null,
    };
  } catch (err) {
    console.warn('[AdGenerator] Headline extraction failed:', err.message);
    return { headline: null, body_copy: null };
  }
}

/**
 * Review and revise an image prompt against project-level prompt guidelines.
 * Uses a fast GPT model to check the prompt for violations and fix them.
 * Returns the original prompt unchanged if no guidelines are set or no changes needed.
 */
export async function reviewPromptWithGuidelines(imagePrompt, guidelines) {
  if (!guidelines || !guidelines.trim()) return imagePrompt;

  try {
    const reviewMessages = [
      {
        role: 'system',
        content: `You are a prompt reviewer. You will receive an image generation prompt and a set of rules/guidelines. Your job is to revise the prompt so it complies with ALL the guidelines while preserving the original creative intent, style, and detail level.

Rules:
- If the prompt already complies with all guidelines, return it EXACTLY as-is.
- If changes are needed, make minimal targeted edits to fix violations.
- Do NOT add disclaimers, explanations, or commentary — return ONLY the revised prompt text.
- Do NOT shorten or simplify the prompt — keep the same level of detail.
- Preserve the artistic direction, brand elements, and layout instructions.`
      },
      {
        role: 'user',
        content: `GUIDELINES:\n${guidelines.trim()}\n\n---\n\nIMAGE PROMPT:\n${imagePrompt}`
      }
    ];

    const revisedPrompt = await chat(reviewMessages, 'gpt-4.1-mini', { operation: 'prompt_guideline_review' });
    return revisedPrompt.trim();
  } catch (err) {
    console.warn('[AdGenerator] Prompt guidelines review failed, using original prompt:', err.message);
    return imagePrompt;
  }
}

/**
 * Apply a natural-language edit instruction to an existing image prompt.
 * Uses GPT to interpret the user's edit description and modify the prompt accordingly.
 * Returns the modified prompt text.
 */
export async function applyPromptEdit(originalPrompt, editInstruction, referenceImage = null) {
  if (!editInstruction || !editInstruction.trim()) return originalPrompt;
  if (!originalPrompt || !originalPrompt.trim()) throw new Error('Original prompt is required.');

  const systemContent = `You are an expert image prompt editor. You will receive an existing image generation prompt and a user's edit instruction describing what they want to change.${referenceImage ? ' The user may also attach a reference image — use it to understand what they are describing (e.g., the correct product, a color reference, a style example). Describe what you see in the image and incorporate that into the revised prompt accurately.' : ''}

Your job:
- Interpret the user's edit instruction and apply it to the existing prompt.
- Make targeted modifications to the prompt that accomplish the requested change.
- Preserve everything else in the prompt that is NOT related to the edit instruction — keep all other creative details, style, layout, brand elements, colors, typography, and composition.
- If the edit is about adding something, integrate it naturally into the prompt.
- If the edit is about removing something, remove it cleanly.
- If the edit is about changing something, swap it out while keeping the surrounding context intact.
- Return ONLY the revised prompt text. No explanations, no commentary, no markdown formatting.
- Keep the same level of detail and length as the original prompt.`;

  // Build user message — if a reference image is attached, use multipart content format for vision
  let userContent;
  if (referenceImage) {
    userContent = [
      { type: 'text', text: `CURRENT PROMPT:\n${originalPrompt.trim()}\n\n---\n\nEDIT INSTRUCTION:\n${editInstruction.trim()}\n\n---\n\nI have attached a reference image below. Use it to understand what I'm describing in my edit instruction.` },
      { type: 'image_url', image_url: { url: `data:${referenceImage.mimeType};base64,${referenceImage.base64}` } }
    ];
  } else {
    userContent = `CURRENT PROMPT:\n${originalPrompt.trim()}\n\n---\n\nEDIT INSTRUCTION:\n${editInstruction.trim()}`;
  }

  const messages = [
    { role: 'system', content: systemContent },
    { role: 'user', content: userContent }
  ];

  try {
    const revisedPrompt = await chat(messages, 'gpt-4.1-mini', { operation: 'prompt_edit' });
    return revisedPrompt.trim();
  } catch (err) {
    console.error('[AdGenerator] Prompt edit failed:', err.message);
    throw new Error('Failed to apply edit to prompt. Please try again.');
  }
}

/**
 * Build the creative director prompt (Message 1) for GPT-5.2.
 * Includes brand context + all 4 foundational documents.
 * @param {object} project - The project record
 * @param {object} docs - { research, avatar, offer_brief, necessary_beliefs }
 */
export function buildCreativeDirectorPrompt(project, docs) {
  const researchContent = docs.research?.content || '[No research document available]';
  const avatarContent = docs.avatar?.content || '[No avatar sheet available]';
  const offerContent = docs.offer_brief?.content || '[No offer brief available]';
  const beliefsContent = docs.necessary_beliefs?.content || '[No necessary beliefs document available]';

  let prompt = `You are a world-class creative director and image generation expert working exclusively for ${project.brand_name}, a ${project.niche} brand that ${project.product_description}.

🎯 Your Role:
Your sole job is to analyze creative inputs and generate prompts for text-to-image softwares for the brand, including:
Static ads
Comparison ads
Product-in-hand visuals
Before/after transformations
Lifestyle or user-experience visuals
And more

📄 Workflow:
I will upload four foundational documents containing important brand strategy, copywriting, audience insights, and creative direction.
I will then upload example image ads (from competitors or previous tests).
You must:
Analyze the documents and image examples carefully.
Recreate the image concepts—but styled, branded, and tailored for my brand mentioned above.
Ensure the design, layout, and mood matches my brands audience and brand aesthetic.
Ask for clarification only if absolutely necessary—default to action.

✅ Creative Requirements:
All image generations must use 1:1 aspect ratio unless otherwise specified.
Include product mockups, realistic models, and visual results.
Avoid generic stock photo vibes—aim for realism, emotion, and DTC ad performance.
Prioritize scroll-stopping contrast and clean, conversion-focused design.

📣 Tone & Audience:
Please match the tone of the ads according to the research doc attached to this message.
Please begin by simply acknowledging your role.

---

FOUNDATIONAL DOCUMENTS:

RESEARCH DOCUMENT:
${researchContent}

AVATAR SHEET:
${avatarContent}

OFFER BRIEF:
${offerContent}

NECESSARY BELIEFS:
${beliefsContent}`;

  return prompt;
}

/**
 * Build the image prompt request (Message 2) text.
 * Per the SOP, the core instruction is exactly "make a prompt for an image like this".
 * Angle, aspect ratio, product image, headline, and body copy are appended as additional direction.
 */
export function buildImageRequestText(angle, aspectRatio, hasProductImage = false, headline = null, bodyCopy = null) {
  let text = 'make a prompt for an image like this';

  const extras = [];
  if (hasProductImage) {
    extras.push('I have attached an image of the product — reference this product image in your prompt, as it will also be attached when the prompt is used for image generation');
  }
  if (headline) {
    const cleanHeadline = headline.replace(/^["'""\u201C\u201D]+|["'""\u201C\u201D]+$/g, '');
    extras.push(`The ad must include this headline text exactly as written (do NOT add quotation marks around it): ${cleanHeadline}`);
  }
  if (bodyCopy) {
    const cleanBody = bodyCopy.replace(/^["'""\u201C\u201D]+|["'""\u201C\u201D]+$/g, '');
    extras.push(`The ad must include this body copy text exactly as written (do NOT add quotation marks around it): ${cleanBody}`);
  }
  if (angle) {
    extras.push(`The ad should focus on this angle/topic: ${angle}`);
  }
  if (aspectRatio && aspectRatio !== '1:1') {
    extras.push(`Use ${aspectRatio} aspect ratio instead of 1:1`);
  }

  if (extras.length > 0) {
    text += '. ' + extras.join('. ');
  }

  return text;
}

/**
 * Select an inspiration image from Convex storage.
 * @param {string} projectId
 * @param {string|null} inspirationImageId - Specific Drive file ID to use, or null for random
 * @returns {{ base64: string, mimeType: string, fileId: string }}
 */
export async function selectInspirationImage(projectId, inspirationImageId, excludeIds = []) {
  const images = await getInspirationImages(projectId);
  if (!images || images.length === 0) {
    throw new Error('No inspiration images cached. Sync your inspiration folder first.');
  }

  let selected;
  if (inspirationImageId) {
    selected = images.find(img => img.drive_file_id === inspirationImageId);
    if (!selected) {
      throw new Error(`Inspiration image ${inspirationImageId} not found in cache.`);
    }
  } else {
    // Random selection, excluding previously used IDs
    let pool = images;
    if (excludeIds.length > 0) {
      const excludeSet = new Set(excludeIds);
      const filtered = images.filter(img => !excludeSet.has(img.drive_file_id));
      // Only use filtered pool if it has enough images; otherwise reset
      if (filtered.length > 0) {
        pool = filtered;
      }
      // If all images are excluded, use the full pool (reset)
    }
    selected = pool[Math.floor(Math.random() * pool.length)];
  }

  if (!selected.storageId) {
    throw new Error('Inspiration image has no stored file. Re-sync your inspiration folder.');
  }

  // Download from Convex storage
  const buffer = await downloadToBuffer(selected.storageId);
  const mimeType = selected.mimeType || 'image/jpeg';

  // Write to temp file to avoid holding large base64 strings in memory
  const ext = mimeType.includes('png') ? '.png' : mimeType.includes('webp') ? '.webp' : '.jpg';
  const tmpPath = path.join(os.tmpdir(), `insp_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
  fs.writeFileSync(tmpPath, buffer);

  return { tmpPath, mimeType, fileId: selected.drive_file_id };
}

/**
 * Read base64 from imageData — supports both temp file (batch mode) and inline base64 (single ad mode).
 * After reading from a temp file, the file is deleted to free disk space.
 * @param {{ tmpPath?: string, base64?: string }} imageData
 * @returns {string} base64-encoded image data
 */
export function readImageBase64(imageData) {
  if (imageData.base64) return imageData.base64;
  if (imageData.tmpPath) {
    const buffer = fs.readFileSync(imageData.tmpPath);
    return buffer.toString('base64');
  }
  throw new Error('imageData has no base64 or tmpPath');
}

/**
 * Clean up temp file from imageData if it exists. Called after image is no longer needed.
 * @param {{ tmpPath?: string }} imageData
 */
export function cleanupImageData(imageData) {
  if (imageData?.tmpPath) {
    try { fs.unlinkSync(imageData.tmpPath); } catch { /* already deleted */ }
  }
}

/**
 * Generate a slug from angle text for Drive file naming.
 */
function slugify(text) {
  if (!text) return 'NoAngle';
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30);
}

/**
 * Select a template image from Convex storage.
 * @param {string} templateImageId - The template_images external ID
 * @returns {{ base64: string, mimeType: string, fileId: string }}
 */
export async function selectTemplateImage(templateImageId) {
  const template = await convexClient.query(api.templateImages.getByExternalId, { externalId: templateImageId });
  if (!template) {
    throw new Error(`Template image ${templateImageId} not found.`);
  }
  if (!template.storageId) {
    throw new Error(`Template image has no stored file. Re-upload the template.`);
  }

  // Download from Convex storage
  const buffer = await downloadToBuffer(template.storageId);
  const mimeType = template.mimeType || 'image/jpeg';

  // Write to temp file to avoid holding large base64 strings in memory
  const ext = mimeType.includes('png') ? '.png' : mimeType.includes('webp') ? '.webp' : '.jpg';
  const tmpPath = path.join(os.tmpdir(), `tmpl_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
  fs.writeFileSync(tmpPath, buffer);

  return { tmpPath, mimeType, fileId: template.externalId };
}

/**
 * Generate a single ad creative (Mode 1 — Inspiration Folder).
 *
 * @param {string} projectId
 * @param {object} options
 * @param {string} [options.angle] - Optional angle/hook
 * @param {string} [options.aspectRatio='1:1'] - Aspect ratio
 * @param {string} [options.inspirationImageId] - Specific inspiration image ID (null = random from folder)
 * @param {string} [options.uploadedImageBase64] - Base64-encoded uploaded image (overrides folder selection)
 * @param {string} [options.uploadedImageMimeType] - MIME type of the uploaded image
 * @param {string} [options.productImageBase64] - Base64-encoded product image to reference
 * @param {string} [options.productImageMimeType] - MIME type of the product image
 * @param {string} [options.headline] - Optional headline text for the ad
 * @param {string} [options.bodyCopy] - Optional body copy text for the ad
 * @param {(event: object) => void} [options.onEvent] - SSE event callback
 * @returns {Promise<object>} The completed ad creative record
 */
export async function generateAd(projectId, options = {}) {
  const { angle, aspectRatio = '1:1', inspirationImageId, uploadedImageBase64, uploadedImageMimeType, productImageBase64, productImageMimeType, headline, bodyCopy, sourceQuoteId, onEvent } = options;

  const emit = (event) => {
    if (onEvent) {
      try { onEvent(event); } catch {}
    }
  };

  // Create ad record at the start
  const adId = uuidv4();
  emit({ type: 'status', status: 'generating_copy', message: 'Loading project data...', progress: 2, adId });
  await convexClient.mutation(api.adCreatives.create, {
    externalId: adId,
    project_id: projectId,
    generation_mode: 'mode1',
    angle: angle || undefined,
    headline: headline || undefined,
    body_copy: bodyCopy || undefined,
    aspect_ratio: aspectRatio,
    status: 'generating_copy',
    inspiration_image_id: inspirationImageId || undefined,
    source_quote_id: sourceQuoteId || undefined,
  });

  try {
    // 1. Load project + foundational docs + inspiration image in parallel
    const useUploadedImage = !!(uploadedImageBase64 && uploadedImageMimeType);
    const [project, research, avatar, offer_brief, necessary_beliefs, inspiration] = await Promise.all([
      getProject(projectId),
      getLatestDoc(projectId, 'research'),
      getLatestDoc(projectId, 'avatar'),
      getLatestDoc(projectId, 'offer_brief'),
      getLatestDoc(projectId, 'necessary_beliefs'),
      useUploadedImage
        ? Promise.resolve({ base64: uploadedImageBase64, mimeType: uploadedImageMimeType, fileId: 'uploaded' })
        : selectInspirationImage(projectId, inspirationImageId),
    ]);
    if (!project) throw new Error('Project not found');

    const docs = { research, avatar, offer_brief, necessary_beliefs };

    // Ensure at least some docs exist
    const docCount = Object.values(docs).filter(d => d && d.content).length;
    if (docCount === 0) {
      throw new Error('No foundational documents found. Generate or upload documents first.');
    }

    // Update the inspiration_image_id in the record (fire-and-forget, don't block)
    if (!useUploadedImage && inspiration.fileId) {
      convexClient.mutation(api.adCreatives.update, {
        externalId: adId,
        inspiration_image_id: inspiration.fileId,
      }).catch(() => {});
    }

    // GPT-5.2 Messages 1-2: Rate-limited to prevent TPM overload
    const hasProductImage = !!(productImageBase64 && productImageMimeType);

    let imagePrompt = await withHeavyLLMLimit(async () => {
      // Message 1: Creative director prompt + foundational docs
      emit({ type: 'status', status: 'generating_copy', message: 'Sending creative brief to GPT-5.2...', progress: 15 });

      const creativeDirectorPrompt_inner = buildCreativeDirectorPrompt(project, docs);
      const acknowledgment = await chat(
        [{ role: 'user', content: creativeDirectorPrompt_inner }],
        'gpt-5.2',
        { operation: 'ad_creative_director', projectId }
      );

      // Message 2: Inspiration image + optional product image + instructions
      emit({ type: 'status', status: 'generating_copy', message: hasProductImage
        ? 'GPT-5.2 analyzing inspiration image + product image...'
        : 'GPT-5.2 analyzing inspiration image...', progress: 35 });

      const imageRequestText_inner = buildImageRequestText(angle, aspectRatio, hasProductImage, headline, bodyCopy);
      const conversationSoFar = [
        { role: 'user', content: creativeDirectorPrompt_inner },
        { role: 'assistant', content: acknowledgment }
      ];

      const inspirationBase64 = readImageBase64(inspiration);
      let prompt;
      if (hasProductImage) {
        prompt = await chatWithImages(
          conversationSoFar,
          imageRequestText_inner,
          [
            { base64: inspirationBase64, mimeType: inspiration.mimeType },
            { base64: productImageBase64, mimeType: productImageMimeType }
          ],
          'gpt-5.2',
          { operation: 'ad_generation_mode1', projectId }
        );
      } else {
        prompt = await chatWithImage(
          conversationSoFar,
          imageRequestText_inner,
          inspirationBase64,
          inspiration.mimeType,
          'gpt-5.2',
          { operation: 'ad_generation_mode1', projectId }
        );
      }

      // Clean up temp file — no longer needed after GPT call
      cleanupImageData(inspiration);

      return prompt;
    }, `[Mode1 Ad ${adId.slice(0, 8)}]`);

    // Apply prompt guidelines if set (uses gpt-4.1-mini, not rate-limited)
    if (project.prompt_guidelines) {
      emit({ type: 'status', status: 'generating_copy', message: 'Reviewing prompt against guidelines...', progress: 55 });
      imagePrompt = await reviewPromptWithGuidelines(imagePrompt, project.prompt_guidelines);
    }

    // Extract headline & body copy from GPT output (non-blocking, runs in parallel)
    const extractionPromise = extractHeadlineAndBody(imagePrompt);

    // Update record with GPT output
    await convexClient.mutation(api.adCreatives.update, {
      externalId: adId,
      gpt_creative_output: imagePrompt,
      image_prompt: imagePrompt,
      status: 'generating_image',
    });

    // Save extracted headline/body (don't block image generation)
    extractionPromise.then(({ headline: extractedHeadline, body_copy: extractedBody }) => {
      if (extractedHeadline || extractedBody) {
        const updates = { externalId: adId };
        if (extractedHeadline && !headline) updates.headline = extractedHeadline;
        if (extractedBody && !bodyCopy) updates.body_copy = extractedBody;
        if (updates.headline || updates.body_copy) {
          convexClient.mutation(api.adCreatives.update, updates).catch(() => {});
        }
      }
    }).catch(() => {});

    // Generate image, save, upload to Drive (shared helper)
    const productImage = hasProductImage
      ? { base64: productImageBase64, mimeType: productImageMimeType }
      : null;
    const ad = await generateAndSaveImage({
      adId, projectId, project, imagePrompt, aspectRatio, angle,
      productImage, emit
    });

    return ad;

  } catch (err) {
    // Mark as failed
    await convexClient.mutation(api.adCreatives.update, {
      externalId: adId,
      status: 'failed',
    });
    emit({ type: 'error', error: err.message });
    throw err;
  }
}

/**
 * Shared helper: Gemini image generation → upload to Convex storage → upload to Drive → finalize record.
 * Used by both generateAd() (full pipeline) and regenerateImageOnly() (prompt-only).
 */
async function generateAndSaveImage({ adId, projectId, project, imagePrompt, aspectRatio, angle, productImage, emit, modeLabel = 'Mode1' }) {
  // Nano Banana Pro: Generate image
  emit({ type: 'status', status: 'generating_image', message: productImage
    ? 'Generating image with Nano Banana Pro (with product reference)...'
    : 'Generating image with Nano Banana Pro...', progress: 70 });

  const { imageBuffer, mimeType: imgMime } = await generateImage(imagePrompt, aspectRatio, productImage, {
    projectId, operation: 'ad_image_generation',
  });

  emit({ type: 'status', status: 'generating_image', message: 'Uploading image...', progress: 90 });

  // Upload image to Convex storage
  const storageId = await uploadBuffer(imageBuffer, imgMime);

  // Pre-generate thumbnail cache (fire-and-forget)
  precacheThumb(adId, imageBuffer);

  // Update final record
  await convexClient.mutation(api.adCreatives.update, {
    externalId: adId,
    storageId,
    status: 'completed',
  });

  // Return the completed ad record with direct CDN URL for fast loading
  const ad = await convexClient.query(api.adCreatives.getByExternalId, { externalId: adId });
  let resolvedUrl = null;
  try { resolvedUrl = await getAdImageUrl(adId); } catch {}

  const adRow = {
    id: ad.externalId,
    project_id: ad.project_id,
    generation_mode: ad.generation_mode,
    angle: ad.angle || null,
    headline: ad.headline || null,
    body_copy: ad.body_copy || null,
    image_prompt: ad.image_prompt || null,
    gpt_creative_output: ad.gpt_creative_output || null,
    storageId: ad.storageId || null,
    aspect_ratio: ad.aspect_ratio || '1:1',
    status: ad.status,
    imageUrl: resolvedUrl || `/api/projects/${projectId}/ads/${adId}/image`,
    thumbnailUrl: `/api/projects/${projectId}/ads/${adId}/thumbnail`,
  };

  emit({ type: 'complete', ad: adRow });
  return adRow;
}

/**
 * Generate a single ad creative (Mode 2 — Template-Based).
 * Same GPT-5.2 creative director flow as Mode 1, but uses a user-uploaded
 * template image instead of a random inspiration folder image.
 *
 * @param {string} projectId
 * @param {object} options
 * @param {string} options.templateImageId - Template image ID to use
 * @param {string} [options.angle] - Optional angle/hook
 * @param {string} [options.aspectRatio='1:1'] - Aspect ratio
 * @param {string} [options.productImageBase64] - Base64-encoded product image
 * @param {string} [options.productImageMimeType] - MIME type of the product image
 * @param {string} [options.headline] - Optional headline text
 * @param {string} [options.bodyCopy] - Optional body copy text
 * @param {(event: object) => void} [options.onEvent] - SSE event callback
 * @returns {Promise<object>} The completed ad creative record
 */
export async function generateAdMode2(projectId, options = {}) {
  const { templateImageId, angle, aspectRatio = '1:1', productImageBase64, productImageMimeType, headline, bodyCopy, sourceQuoteId, onEvent } = options;

  const emit = (event) => {
    if (onEvent) {
      try { onEvent(event); } catch {}
    }
  };

  if (!templateImageId) {
    throw new Error('A template image is required for Mode 2 generation.');
  }

  // Create ad record
  const adId = uuidv4();
  emit({ type: 'status', status: 'generating_copy', message: 'Loading project data...', progress: 2, adId });
  await convexClient.mutation(api.adCreatives.create, {
    externalId: adId,
    project_id: projectId,
    generation_mode: 'mode2',
    angle: angle || undefined,
    headline: headline || undefined,
    body_copy: bodyCopy || undefined,
    aspect_ratio: aspectRatio,
    status: 'generating_copy',
    template_image_id: templateImageId,
    source_quote_id: sourceQuoteId || undefined,
  });

  try {
    // 1. Load project + foundational docs + template image (+ optional headline ref) in parallel
    const [project, research, avatar, offer_brief, necessary_beliefs, template] = await Promise.all([
      getProject(projectId),
      getLatestDoc(projectId, 'research'),
      getLatestDoc(projectId, 'avatar'),
      getLatestDoc(projectId, 'offer_brief'),
      getLatestDoc(projectId, 'necessary_beliefs'),
      selectTemplateImage(templateImageId),
    ]);
    if (!project) throw new Error('Project not found');

    const docs = { research, avatar, offer_brief, necessary_beliefs };

    const docCount = Object.values(docs).filter(d => d && d.content).length;
    if (docCount === 0) {
      throw new Error('No foundational documents found. Generate or upload documents first.');
    }

    // GPT-5.2 Messages 1-2: Rate-limited to prevent TPM overload
    const hasProductImage = !!(productImageBase64 && productImageMimeType);

    let imagePrompt = await withHeavyLLMLimit(async () => {
      // Message 1: Creative director prompt + foundational docs
      emit({ type: 'status', status: 'generating_copy', message: 'Sending creative brief to GPT-5.2...', progress: 15 });

      const creativeDirectorPrompt_inner = buildCreativeDirectorPrompt(project, docs);
      const acknowledgment = await chat(
        [{ role: 'user', content: creativeDirectorPrompt_inner }],
        'gpt-5.2',
        { operation: 'ad_creative_director', projectId }
      );

      // Message 2: Template image + optional product image + instructions
      emit({ type: 'status', status: 'generating_copy', message: hasProductImage
        ? 'GPT-5.2 analyzing template image + product image...'
        : 'GPT-5.2 analyzing template image...', progress: 35 });

      const imageRequestText_inner = buildImageRequestText(angle, aspectRatio, hasProductImage, headline, bodyCopy);
      const conversationSoFar = [
        { role: 'user', content: creativeDirectorPrompt_inner },
        { role: 'assistant', content: acknowledgment }
      ];

      const templateBase64 = readImageBase64(template);
      let prompt;
      if (hasProductImage) {
        prompt = await chatWithImages(
          conversationSoFar,
          imageRequestText_inner,
          [
            { base64: templateBase64, mimeType: template.mimeType },
            { base64: productImageBase64, mimeType: productImageMimeType }
          ],
          'gpt-5.2',
          { operation: 'ad_generation_mode2', projectId }
        );
      } else {
        prompt = await chatWithImage(
          conversationSoFar,
          imageRequestText_inner,
          templateBase64,
          template.mimeType,
          'gpt-5.2',
          { operation: 'ad_generation_mode2', projectId }
        );
      }

      // Clean up temp file — no longer needed after GPT call
      cleanupImageData(template);

      return prompt;
    }, `[Mode2 Ad ${adId.slice(0, 8)}]`);

    // Apply prompt guidelines if set (uses gpt-4.1-mini, not rate-limited)
    if (project.prompt_guidelines) {
      emit({ type: 'status', status: 'generating_copy', message: 'Reviewing prompt against guidelines...', progress: 55 });
      imagePrompt = await reviewPromptWithGuidelines(imagePrompt, project.prompt_guidelines);
    }

    // Extract headline & body copy from GPT output (non-blocking, runs in parallel)
    const extractionPromise = extractHeadlineAndBody(imagePrompt);

    // Update record with GPT output
    await convexClient.mutation(api.adCreatives.update, {
      externalId: adId,
      gpt_creative_output: imagePrompt,
      image_prompt: imagePrompt,
      status: 'generating_image',
    });

    // Save extracted headline/body (don't block image generation)
    extractionPromise.then(({ headline: extractedHeadline, body_copy: extractedBody }) => {
      if (extractedHeadline || extractedBody) {
        const updates = { externalId: adId };
        if (extractedHeadline && !headline) updates.headline = extractedHeadline;
        if (extractedBody && !bodyCopy) updates.body_copy = extractedBody;
        if (updates.headline || updates.body_copy) {
          convexClient.mutation(api.adCreatives.update, updates).catch(() => {});
        }
      }
    }).catch(() => {});

    // Generate image, save, upload to Drive (shared helper)
    const productImage = hasProductImage
      ? { base64: productImageBase64, mimeType: productImageMimeType }
      : null;
    const ad = await generateAndSaveImage({
      adId, projectId, project, imagePrompt, aspectRatio, angle,
      productImage, emit, modeLabel: 'Mode2'
    });

    return ad;

  } catch (err) {
    await convexClient.mutation(api.adCreatives.update, {
      externalId: adId,
      status: 'failed',
    });
    emit({ type: 'error', error: err.message });
    throw err;
  }
}

/**
 * Regenerate an image using a user-provided prompt (skip GPT entirely).
 * Creates a new ad record linked to the parent ad.
 */
// =============================================
// 4-Stage Batch Pipeline Functions
// =============================================

/**
 * Attempt to repair malformed JSON from LLM responses.
 * Strips markdown code fences, fixes trailing commas, then parses.
 */
export function repairJSON(text) {
  if (!text || !text.trim()) throw new Error('Empty JSON response');
  let cleaned = text.trim();

  // Strip markdown code fences (```json ... ``` or ``` ... ```)
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');

  // Fix trailing commas before } or ]
  cleaned = cleaned.replace(/,(\s*[}\]])/g, '$1');

  return JSON.parse(cleaned);
}

/**
 * Extract a named section from the brief_packet markdown.
 * Returns the text between the section heading and the next ## heading (or end).
 */
function extractBriefSection(briefPacket, sectionName) {
  const regex = new RegExp(`## ${sectionName}[^\n]*\n([\\s\\S]*?)(?=\n## |$)`, 'i');
  const match = briefPacket.match(regex);
  return match ? match[1].trim() : '';
}

/**
 * Stage 0: Brief Extraction — condenses 4 foundational docs into angle-specific ~1 page brief.
 * Runs once per batch. 1 API call.
 *
 * @param {object} project - Project record
 * @param {object} docs - { research, avatar, offer_brief, necessary_beliefs }
 * @param {string} angle - The advertising angle for this batch
 * @returns {string} brief_packet (markdown)
 */
export async function extractBrief(project, docs, angle) {
  const researchContent = docs.research?.content || '[No research document available]';
  const avatarContent = docs.avatar?.content || '[No avatar sheet available]';
  const offerContent = docs.offer_brief?.content || '[No offer brief available]';
  const beliefsContent = docs.necessary_beliefs?.content || '[No necessary beliefs document available]';

  // Extract first paragraph of avatar sheet for target demographic summary
  const targetDemographic = avatarContent.split('\n\n')[0] || avatarContent.slice(0, 500);

  const prompt = `You are a direct response research analyst. Your job is to extract the most relevant raw material from brand foundational documents for a specific advertising angle.

BRAND: ${project.brand_name || project.name}
PRODUCT: ${project.product_description || ''}
TARGET DEMOGRAPHIC: ${targetDemographic}

THE ANGLE FOR THIS BATCH: "${angle || 'general'}"

I will provide you with four foundational documents. From these documents, extract ONLY the material directly relevant to this specific angle. Ignore everything else — do not try to be comprehensive.

Your output must contain exactly these sections:

## AVATAR IN THIS MOMENT
3-4 sentences describing who this woman is specifically when she encounters an ad using this angle. What is she feeling right now? What would make her stop scrolling?

## RELEVANT PAIN POINTS (max 5)
Only the pain points from the research/avatar docs that this angle activates. Not all pain points — just the ones this angle touches.

## RELEVANT QUOTES FROM LANGUAGE BANK (max 8)
Exact raw quotes from the deep research doc's language bank that a copywriter would use for THIS angle. Emotional, specific phrases only.

## RELEVANT BELIEFS (max 3)
From the necessary beliefs document, which 3 beliefs are most critical for this angle?

## RELEVANT OBJECTIONS (max 4)
Which objections does this angle need to preempt or address?

## EMOTIONAL ENTRY POINT
One sentence: what is the single dominant emotion this angle enters through?

## SPECIFICITY ANCHORS (max 6)
Concrete details from the research that make ads feel real: specific times of night, body parts, failed solutions, social moments. Only ones relevant to this angle.

FOUNDATIONAL DOCUMENTS:

=== DEEP RESEARCH ===
${researchContent}

=== AVATAR SHEET ===
${avatarContent}

=== OFFER BRIEF ===
${offerContent}

=== NECESSARY BELIEFS ===
${beliefsContent}`;

  // Attempt with retry — fall back to raw docs if both attempts fail
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const briefPacket = await withHeavyLLMLimit(async () => {
        return await claudeChat([{ role: 'user', content: prompt }], 'claude-opus-4-6', {
          operation: 'batch_brief_extraction',
          projectId: project?.id || null,
        });
      }, `[Stage 0 Brief Extraction attempt ${attempt}]`);

      console.log(`[Pipeline Stage 0] Brief extracted (${briefPacket.length} chars) for angle: "${(angle || 'general').slice(0, 40)}"`);
      return briefPacket;
    } catch (err) {
      console.error(`[Pipeline Stage 0] Attempt ${attempt}/2 failed:`, err.message);
      console.error(`[Pipeline Stage 0] Error status: ${err.status || 'none'}, type: ${err.type || 'none'}`);
      if (attempt === 2) {
        // Fallback: concatenate raw docs
        console.warn('[Pipeline Stage 0] Falling back to raw foundational docs');
        return `## AVATAR IN THIS MOMENT\n${targetDemographic}\n\n## RELEVANT PAIN POINTS\n(Full docs — brief extraction failed)\n\n## RELEVANT QUOTES FROM LANGUAGE BANK\n(See research document)\n\n## RELEVANT BELIEFS\n(See necessary beliefs document)\n\n## RELEVANT OBJECTIONS\n(See offer brief)\n\n## EMOTIONAL ENTRY POINT\n(Brief extraction failed — using full docs)\n\n## SPECIFICITY ANCHORS\n(See research document)\n\nFULL FOUNDATIONAL DOCUMENTS:\n\n${researchContent}\n\n${avatarContent}\n\n${offerContent}\n\n${beliefsContent}`;
      }
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

/**
 * Stage 1: Headline + Sub-Angle Generation — generates scored/ranked headlines with sub-angle diversity.
 * Runs once per batch. 1 API call.
 *
 * @param {object} project - Project record
 * @param {string} briefPacket - Output of Stage 0
 * @param {string} angle - The advertising angle
 * @param {number} count - headlines_to_generate count
 * @returns {{ sub_angles: Array, headlines: Array }}
 */
export async function generateHeadlines(project, briefPacket, angle, count) {
  const avatarSection = extractBriefSection(briefPacket, 'AVATAR IN THIS MOMENT');
  const emotionalEntry = extractBriefSection(briefPacket, 'EMOTIONAL ENTRY POINT');
  const painPoints = extractBriefSection(briefPacket, 'RELEVANT PAIN POINTS');
  const quotes = extractBriefSection(briefPacket, 'RELEVANT QUOTES');
  const anchors = extractBriefSection(briefPacket, 'SPECIFICITY ANCHORS');

  const prompt = `You are a world-class direct response copywriter who writes Facebook ad headlines for health and wellness products targeting women 55-75. These women are skeptical, have been disappointed by other products, and need to feel safe and understood before they'll engage.

Your headlines stop the scroll. They are specific, emotional, and impossible to ignore. They sound like something a real person would say or think — not like marketing copy.

BRAND: ${project.brand_name || project.name}
PRODUCT: ${project.product_description || ''}

TARGET AUDIENCE IN THIS MOMENT:
${avatarSection || '(Not available)'}

THE ANGLE FOR THIS BATCH: "${angle || 'general'}"

EMOTIONAL ENTRY POINT:
${emotionalEntry || '(Not available)'}

RELEVANT PAIN POINTS:
${painPoints || '(Not available)'}

LANGUAGE TO DRAW FROM (for tone and specificity — do not copy verbatim):
${quotes || '(Not available)'}

CONCRETE DETAILS TO WEAVE IN:
${anchors || '(Not available)'}

---

STEP 1: GENERATE SUB-ANGLES

Before writing any headlines, create exactly 4 sub-angles within the main angle "${angle || 'general'}". Each sub-angle is a distinct emotional or strategic variation that will force different types of headlines.

Rules for sub-angles:
- Each must target a different emotional entry point (e.g., betrayal, outrage, quiet determination, surprise)
- Each must suggest a different speaker perspective (e.g., first-person skeptic, editorial exposé, reluctant convert, defiant grandma)
- They must be specific enough that headlines from one sub-angle could not be confused with another

STEP 2: GENERATE HEADLINES

Write exactly ${count} headlines total, distributed roughly evenly across your 4 sub-angles.

Every headline must follow ALL of these rules:

1. MAXIMUM 12 WORDS. Shorter is better. Under 8 is ideal for scroll-stopping power.

2. THE ANGLE NEVER BECOMES THE HEADLINE. The angle "${angle || 'general'}" is a strategic lens that informs the headline — it must NEVER be the headline text itself. If the angle is "American small business," the headline must still hit a pain point or create curiosity. "American Small Business" as a headline = failure. "We're the small US company your neighbor told you about after she finally slept through the night" = success.

3. Every headline must trigger one clear emotion: curiosity, recognition ("that's me"), outrage, vindication, relief, or surprise.

4. At least 25% must use first-person voice ("I tried...", "I felt...", "My knees...")
5. At least 25% must lead with a concrete physical sensation or specific symptom
6. At least 25% must create an open loop or unanswered question
7. At least 15% must use a pattern interrupt (contradiction, confession, counterintuitive framing)

8. NO TWO HEADLINES may start with the same word.

9. NO TWO HEADLINES may use the same sentence structure.

10. NONE may use these phrases: "game-changer", "what if I told you", "here's the thing", "discover the secret", "unlock", "revolutionize", "transform your", "the ultimate", "you won't believe", "this changes everything", "finally revealed", "the truth about", "doctors don't want you to know", "one weird trick", "miracle", "breakthrough", "ancient secret"

11. These are HEADLINES, not taglines or slogans. A headline makes someone stop and want to read more. A tagline is a brand statement. Write headlines.

CALIBRATION — headlines at the quality level I expect:
GOOD:
- "I Felt Cheated After Every Grounding Product I Tried — Until I Discovered Why."
- "The Grounding Sheet Ripoff: When You've Run Out of 'New Things to Try'"
- "Wake up less stiff tomorrow. Seriously."
- "I Stopped Waking Up at 3am. My Husband Noticed Before I Did."

BAD (do NOT produce anything like these):
- "2026 Sleep Wins" (meaningless, no hook)
- "American Small Business" (angle as headline)
- "Natural Sleep Solution for Better Rest" (generic, any product)
- "Discover the Power of Grounding" (vague hype)

STEP 3: SCORE YOUR OWN HEADLINES

After generating all headlines, score each one yourself on these criteria (1-10):
- SCROLL STOP: Would a 65-year-old woman stop her thumb mid-scroll?
- SPECIFICITY: Does it trigger one clear emotion, or is it vague?
- UNIQUENESS: Does it stand out from the other headlines in this batch?
- REAL HUMAN: Would a real person say, think, or react to this exact phrasing?

Compute an average score for each. Then rank all headlines from highest to lowest average score.

OUTPUT FORMAT — respond as JSON only:

{
  "angle": "${angle || 'general'}",
  "sub_angles": [
    {
      "id": "A",
      "name": "short label",
      "emotional_entry": "dominant emotion",
      "speaker_perspective": "who is speaking"
    }
  ],
  "headlines": [
    {
      "rank": 1,
      "headline": "the headline text",
      "sub_angle": "A",
      "primary_emotion": "curiosity",
      "category": "first_person | pain_point | open_loop | pattern_interrupt",
      "word_count": 8,
      "scores": {
        "scroll_stop": 9,
        "specificity": 8,
        "uniqueness": 9,
        "real_human": 8
      },
      "average_score": 8.5
    }
  ]
}`;

  let lastResult = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await withHeavyLLMLimit(async () => {
        return await claudeChat(
          [{ role: 'user', content: attempt > 1
            ? prompt + `\n\nIMPORTANT: Your previous attempt did not succeed. Please ensure you generate exactly ${count} headlines and return valid JSON.`
            : prompt }],
          'claude-opus-4-6',
          {
            response_format: { type: 'json_object' },
            operation: 'batch_headline_generation',
            projectId: project?.id || null,
          }
        );
      }, `[Stage 1 Headlines attempt ${attempt}]`);

      let result;
      try {
        result = JSON.parse(response);
      } catch {
        result = repairJSON(response);
      }

      if (!result.headlines || !Array.isArray(result.headlines)) {
        throw new Error('Response missing headlines array');
      }

      // Sort by rank (should already be sorted, but ensure)
      result.headlines.sort((a, b) => (a.rank || 999) - (b.rank || 999));
      lastResult = result;

      console.log(`[Pipeline Stage 1] Generated ${result.headlines.length} headlines, ${(result.sub_angles || []).length} sub-angles for angle: "${(angle || 'general').slice(0, 40)}"`);

      // If we got fewer than needed on first attempt, retry with note
      if (attempt < 3 && result.headlines.length < count) {
        console.warn(`[Pipeline Stage 1] Got ${result.headlines.length}/${count} headlines, retrying...`);
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }

      return result;

    } catch (err) {
      console.error(`[Pipeline Stage 1] Attempt ${attempt}/3 failed:`, err.message);
      if (attempt < 3) {
        await new Promise(r => setTimeout(r, 5000 * attempt)); // 5s, 10s backoff
      }
    }
  }

  // If we got partial results, return them rather than throwing
  if (lastResult && lastResult.headlines && lastResult.headlines.length > 0) {
    console.warn(`[Pipeline Stage 1] Returning partial results: ${lastResult.headlines.length} headlines`);
    return lastResult;
  }

  throw new Error('[Stage 1] All headline generation attempts failed. OpenAI may be experiencing issues — try again in a few minutes.');
}

/**
 * Stage 2: Body Copy Generation — writes body copy in batches of 5 headlines.
 * Multiple API calls (N/5).
 *
 * @param {object} project - Project record
 * @param {string} briefPacket - Output of Stage 0
 * @param {Array} headlines - Array of headline objects from Stage 1
 * @returns {Array} Array of { headline, body_copy, structure, word_count, specific_detail_used, closing_cta, primary_emotion }
 */
export async function generateBodyCopies(project, briefPacket, headlines) {
  const quotes = extractBriefSection(briefPacket, 'RELEVANT QUOTES');
  const anchors = extractBriefSection(briefPacket, 'SPECIFICITY ANCHORS');
  const beliefs = extractBriefSection(briefPacket, 'RELEVANT BELIEFS');

  const allCopies = [];

  // Process in batches of 5
  for (let i = 0; i < headlines.length; i += 5) {
    const batch = headlines.slice(i, i + 5);
    const batchNum = Math.floor(i / 5) + 1;
    const totalBatches = Math.ceil(headlines.length / 5);

    const headlineList = batch.map((h, idx) => `${idx + 1}. "${h.headline}"`).join('\n');

    const prompt = `You are a direct response copywriter writing Facebook ad primary text for a health/wellness brand. You write for women 55-75 dealing with chronic pain, broken sleep, and morning stiffness. Your copy is warm, specific, honest, and sounds like a real person — not a brand.

BRAND: ${project.brand_name || project.name}
PRODUCT: ${project.product_description || ''}

TONE RULES:
- Never use hype language or miracle framing
- Lead with relief, not claims
- Show skepticism openly — don't fight it
- Emphasize safety and reversibility
- Sound like a trusted friend who found something that helped, not a salesperson

REFERENCE MATERIAL (use for specificity and emotional tone — do not copy verbatim):
${quotes || '(Not available)'}
${anchors || '(Not available)'}

BELIEFS TO ACTIVATE (weave in naturally, never state as bullet points):
${beliefs || '(Not available)'}

---

For each headline below, write Facebook ad primary text (the body copy that appears below the headline in the ad).

RULES FOR EVERY BODY COPY:

1. ANCHOR TO THE HEADLINE. Your first sentence must continue the emotional thread the headline started. Do not restart. Do not introduce a new idea. Do not repeat the headline. If the headline opens a loop, partially close it — enough to satisfy, not enough to remove the need to click.

2. MAXIMUM 90 WORDS. Every word earns its place.

3. INCLUDE ONE SPECIFIC, CONCRETE DETAIL: a time of night (2-4am), a body part (hips, knees, shoulders), a failed solution (melatonin, expensive mattress), or a life moment (playing with grandkids, dreading bedtime). "Better sleep" or "less pain" do NOT count as specific.

4. DO NOT REPEAT THE HEADLINE TEXT in the body copy.

5. END WITH A REASON TO CLICK that connects to the headline's emotion — not a generic "Learn more" or "Shop now." If the headline was about feeling cheated, the closer should be about finding out why. If the headline was about stiffness, the closer should be about what changed.

6. NONE of these phrases: "game-changer", "revolutionize", "transform your life", "the ultimate solution", "miracle", "breakthrough discovery", "you won't believe what happened next"

---

HEADLINES TO WRITE BODY COPY FOR:

${headlineList}

For each headline, write ONE body copy. Vary the structural approach across the five:
- At least 1 should use STORY CONTINUATION (extend the narrative voice of the headline)
- At least 1 should use PROBLEM-AGITATE (hit the pain with specific detail, then pivot to product)
- At least 1 should use SOCIAL PROOF (open with what another woman experienced — a name, an age, a specific result)
- The remaining can use whichever approach fits the headline best

OUTPUT FORMAT — respond as JSON only:

{
  "body_copies": [
    {
      "headline": "...",
      "body_copy": "...",
      "structure": "story_continuation | problem_agitate | social_proof",
      "word_count": 78,
      "specific_detail_used": "2-4am wakeups",
      "closing_cta": "the last sentence / CTA text"
    }
  ]
}`;

    // Retry each batch up to 2 times
    let batchSuccess = false;
    for (let attempt = 1; attempt <= 2 && !batchSuccess; attempt++) {
      try {
        const response = await withHeavyLLMLimit(async () => {
          return await claudeChat(
            [{ role: 'user', content: prompt }],
            'claude-sonnet-4-6',
            {
              response_format: { type: 'json_object' },
              operation: 'batch_body_copy',
              projectId: project?.id || null,
            }
          );
        }, `[Stage 2 Body Copy batch ${batchNum}/${totalBatches} attempt ${attempt}]`);

        let result;
        try {
          result = JSON.parse(response);
        } catch {
          result = repairJSON(response);
        }

        if (!result.body_copies || !Array.isArray(result.body_copies)) {
          throw new Error('Response missing body_copies array');
        }

        // Match body copies back to original headline objects to preserve primary_emotion
        for (const copy of result.body_copies) {
          const matchingHeadline = batch.find(h => h.headline === copy.headline);
          allCopies.push({
            ...copy,
            primary_emotion: matchingHeadline?.primary_emotion || 'curiosity',
            sub_angle: matchingHeadline?.sub_angle || null,
          });
        }

        batchSuccess = true;
        console.log(`[Pipeline Stage 2] Body copy batch ${batchNum}/${totalBatches}: ${result.body_copies.length} copies generated`);

      } catch (err) {
        console.error(`[Pipeline Stage 2] Batch ${batchNum} attempt ${attempt} failed:`, err.message);
        if (attempt === 2) {
          console.warn(`[Pipeline Stage 2] Skipping batch ${batchNum} (${batch.length} headlines lost)`);
        } else {
          await new Promise(r => setTimeout(r, 3000));
        }
      }
    }

    // Small delay between batches
    if (i + 5 < headlines.length) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  console.log(`[Pipeline Stage 2] Total body copies generated: ${allCopies.length}/${headlines.length}`);
  return allCopies;
}

/**
 * Stage 3: Image Prompt Generation — generates image prompt for a single ad with locked copy.
 * Runs once per ad. Uses vision API with template image.
 *
 * @param {object} project - Project record
 * @param {string} headline - Locked headline text
 * @param {string} bodyCopy - Locked body copy text
 * @param {string} primaryEmotion - Primary emotion from Stage 1
 * @param {{ base64: string, mimeType: string }} imageData - Template image data
 * @param {string} aspectRatio - User-selected aspect ratio
 * @returns {string} Image generation prompt
 */
export async function generateImagePrompt(project, headline, bodyCopy, primaryEmotion, imageData, aspectRatio) {
  const promptText = `You are a creative director generating prompts for text-to-image AI software. You create Facebook ad visuals for DTC health/wellness brands targeting women 55-75.

BRAND: ${project.brand_name || project.name}
PRODUCT APPEARANCE: ${project.product_description || ''}

ASPECT RATIO: ${aspectRatio || '1:1'}

THE APPROVED AD COPY (DO NOT MODIFY — render exactly as written):
HEADLINE: "${headline}"
BODY COPY: "${bodyCopy}"

PRIMARY EMOTION OF THIS AD: ${primaryEmotion || 'curiosity'}

TEMPLATE TO MATCH:
(See attached image — analyze its visual structure, layout, color palette, typography, and composition)

---

Analyze the template's visual structure:
- Layout (where text sits, where product sits, visual hierarchy)
- Color palette and mood
- Typography style (serif vs sans-serif, weight, contrast)
- Use of badges, callouts, trust elements, or decorative frames
- Overall composition and whitespace

Generate an image prompt that:

1. Recreates the template's layout and composition style — adapted for ${project.brand_name || project.name}
2. Features the product (${project.product_description || ''}) as the primary product visual, positioned where the template places its product. The product image will be composited in separately — so describe where it should go and at what scale, but focus the image prompt on the background, layout, and design elements.
3. Places the EXACT headline text in the primary/dominant text position matching the template's hierarchy
4. Places a key supporting line from the body copy (or the closing CTA) in the secondary text position if the template has one
5. Places the brand name (${project.brand_name || project.name}) in a subtle position (footer, corner) matching the template
6. Supports the emotional tone of the headline — the visual mood (colors, lighting, texture) should reinforce what the headline makes the reader feel. Skepticism angles get editorial/news-style treatments. Pain point angles get warm, empathetic tones. Relief angles get bright, calm aesthetics.
7. Uses the specified aspect ratio: ${aspectRatio || '1:1'}
8. Avoids generic stock photo aesthetics — aim for authentic, warm, realistic DTC ad quality that resonates with women 60-70
9. Prioritizes scroll-stopping contrast and clean, conversion-focused design
10. Includes realistic product representation — not cartoonish or overly polished

CRITICAL: The headline and body copy are FINAL. Do not rewrite, shorten, improve, or paraphrase them. Your job is visual execution only. Render the text exactly as provided.

Output the image generation prompt as a single text block ready to paste into the image generation tool.`;

  const imageBase64 = readImageBase64(imageData);
  const imagePrompt = await withHeavyLLMLimit(async () => {
    return await claudeChatWithImage(
      [],
      promptText,
      imageBase64,
      imageData.mimeType,
      'claude-sonnet-4-6',
      { operation: 'batch_image_prompt', projectId: project?.id || null }
    );
  }, `[Stage 3 Image Prompt]`);

  return imagePrompt;
}

export async function regenerateImageOnly(projectId, options = {}) {
  const { imagePrompt, aspectRatio = '1:1', parentAdId, productImageBase64, productImageMimeType, angle, headline, bodyCopy, onEvent } = options;

  const emit = (event) => {
    if (onEvent) {
      try { onEvent(event); } catch {}
    }
  };

  if (!imagePrompt || !imagePrompt.trim()) {
    throw new Error('Image prompt is required for image-only regeneration.');
  }

  // Create new ad record
  const adId = uuidv4();
  await convexClient.mutation(api.adCreatives.create, {
    externalId: adId,
    project_id: projectId,
    generation_mode: 'image_only',
    angle: angle || undefined,
    headline: headline || undefined,
    body_copy: bodyCopy || undefined,
    aspect_ratio: aspectRatio,
    status: 'generating_image',
    image_prompt: imagePrompt.trim(),
    gpt_creative_output: imagePrompt.trim(),
    parent_ad_id: parentAdId || undefined,
  });

  emit({ type: 'status', status: 'generating_image', message: 'Preparing image generation...', progress: 5, adId });

  try {
    const project = await getProject(projectId);
    if (!project) throw new Error('Project not found');

    // Apply prompt guidelines if set
    let finalPrompt = imagePrompt.trim();
    if (project.prompt_guidelines) {
      emit({ type: 'status', status: 'generating_image', message: 'Reviewing prompt against guidelines...', progress: 20 });
      finalPrompt = await reviewPromptWithGuidelines(finalPrompt, project.prompt_guidelines);
      // Update the stored prompt if it changed
      if (finalPrompt !== imagePrompt.trim()) {
        await convexClient.mutation(api.adCreatives.update, {
          externalId: adId,
          image_prompt: finalPrompt,
          gpt_creative_output: finalPrompt,
        });
      }
    }

    const hasProductImage = !!(productImageBase64 && productImageMimeType);
    const productImage = hasProductImage
      ? { base64: productImageBase64, mimeType: productImageMimeType }
      : null;

    const ad = await generateAndSaveImage({
      adId, projectId, project,
      imagePrompt: finalPrompt,
      aspectRatio, angle, productImage, emit,
      modeLabel: 'Regen'
    });

    return ad;

  } catch (err) {
    await convexClient.mutation(api.adCreatives.update, {
      externalId: adId,
      status: 'failed',
    });
    emit({ type: 'error', error: err.message });
    throw err;
  }
}

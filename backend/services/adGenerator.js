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
export function buildImageRequestText(angle, aspectRatio, hasProductImage = false, headline = null, bodyCopy = null, angleBrief = null) {
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
  if (angleBrief && (angleBrief.scene || angleBrief.tone)) {
    // Use structured angle context when available
    const briefParts = [];
    if (angleBrief.scene) briefParts.push(`scene: ${angleBrief.scene}`);
    if (angleBrief.tone) briefParts.push(`tone: ${angleBrief.tone}`);
    if (angleBrief.avoid_list) briefParts.push(`avoid: ${angleBrief.avoid_list}`);
    extras.push(`The ad should focus on this angle: ${angle || angleBrief.name || 'general'} (${briefParts.join('; ')})`);
  } else if (angle) {
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
  const { angle, aspectRatio = '1:1', imageModel, inspirationImageId, uploadedImageBase64, uploadedImageMimeType, productImageBase64, productImageMimeType, headline, bodyCopy, sourceQuoteId, onEvent } = options;

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
      productImage, imageModel, emit
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
async function generateAndSaveImage({ adId, projectId, project, imagePrompt, aspectRatio, angle, productImage, imageModel, emit, modeLabel = 'Mode1' }) {
  // Gemini image generation
  const modelLabel = imageModel === 'nano-banana-2' ? 'Nano Banana 2' : 'Nano Banana Pro';
  emit({ type: 'status', status: 'generating_image', message: productImage
    ? `Generating image with ${modelLabel} (with product reference)...`
    : `Generating image with ${modelLabel}...`, progress: 70 });

  const { imageBuffer, mimeType: imgMime } = await generateImage(imagePrompt, aspectRatio, productImage, {
    projectId, operation: 'ad_image_generation', imageModel, imageSize: '2K',
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
  const { templateImageId, angle, aspectRatio = '1:1', imageModel, productImageBase64, productImageMimeType, headline, bodyCopy, sourceQuoteId, onEvent } = options;

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
      productImage, imageModel, emit, modeLabel: 'Mode2'
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

export const HEADLINE_LANES = {
  symptom_recognition: 'Open with a specific physical symptom the reader recognizes instantly.',
  oddly_specific_moment: 'Describe a hyper-specific moment, time, or sensation that feels uncannily real.',
  failed_solutions: 'Lead with the remedies, purchases, or routines they already tried without success.',
  consequence_led: 'Focus on the cost of leaving the problem unresolved.',
  skeptical_confession: 'Use the voice of someone who doubted it would work and admits that honestly.',
  objection_reversal: 'Name the objection directly, then flip it in a grounded way.',
  review_like: 'Sound like a real recommendation, testimonial, or product review from a trusted person.',
  comparison: 'Compare against a familiar alternative, habit, or failed solution.',
  mechanism_curiosity: 'Create curiosity around how or why something works without fully explaining it.',
  identity_trust: 'Appeal to identity, values, trust, origin, or buyer-protection logic.',
};

export const FRAME_LANE_MAP = {
  'symptom-first': ['symptom_recognition', 'oddly_specific_moment', 'failed_solutions', 'consequence_led', 'skeptical_confession', 'mechanism_curiosity'],
  scam: ['skeptical_confession', 'objection_reversal', 'failed_solutions', 'comparison', 'review_like', 'mechanism_curiosity'],
  'objection-first': ['objection_reversal', 'skeptical_confession', 'comparison', 'review_like', 'identity_trust', 'mechanism_curiosity'],
  'identity-first': ['identity_trust', 'review_like', 'oddly_specific_moment', 'comparison', 'skeptical_confession', 'failed_solutions'],
  MAHA: ['identity_trust', 'comparison', 'objection_reversal', 'mechanism_curiosity', 'consequence_led', 'review_like'],
  'news-first': ['mechanism_curiosity', 'comparison', 'symptom_recognition', 'skeptical_confession', 'consequence_led', 'review_like'],
  'consequence-first': ['consequence_led', 'symptom_recognition', 'oddly_specific_moment', 'failed_solutions', 'skeptical_confession', 'mechanism_curiosity'],
};

export const DEFAULT_LANES = ['symptom_recognition', 'oddly_specific_moment', 'failed_solutions', 'skeptical_confession', 'mechanism_curiosity', 'review_like'];

function safeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function inferOpeningPattern(headline) {
  const raw = safeString(headline);
  const normalized = raw
    ? raw.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
    : '';
  if (!normalized) return 'statement';
  if (raw.endsWith('?')) return 'question_open';
  if (/^(i|my)\b/.test(normalized)) return 'first_person_open';
  if (/^(still|after|before|when|why|what|how)\b/.test(normalized)) return 'pattern_interrupt_open';
  if (/^\d/.test(normalized)) return 'number_open';
  if (/^(review|heres|here|try|tap|stop)\b/.test(normalized)) return 'directive_open';
  return 'statement_open';
}

function selectHeadlineLanes(angleBrief, count) {
  const frame = angleBrief?.frame && FRAME_LANE_MAP[angleBrief.frame]
    ? angleBrief.frame
    : null;
  const lanePool = frame ? FRAME_LANE_MAP[frame] : DEFAULT_LANES;
  const desiredLaneCount = Math.max(4, Math.min(6, count >= 24 ? 6 : count >= 16 ? 5 : 4));
  return lanePool.slice(0, desiredLaneCount);
}

function buildLaneAllocation(lanes, count) {
  const allocation = [];
  const base = Math.floor(count / Math.max(1, lanes.length));
  let remainder = count % Math.max(1, lanes.length);
  for (const lane of lanes) {
    allocation.push({
      lane,
      count: base + (remainder > 0 ? 1 : 0),
    });
    if (remainder > 0) remainder -= 1;
  }
  return allocation;
}

function formatPriorHeadlineHistory(priorHeadlines) {
  if (!Array.isArray(priorHeadlines) || priorHeadlines.length === 0) return '';
  const lines = priorHeadlines
    .slice(0, 30)
    .map((entry) => {
      const lane = entry.hook_lane ? ` | lane: ${entry.hook_lane}` : '';
      const claim = entry.core_claim ? ` | claim: ${entry.core_claim}` : '';
      const symptom = entry.target_symptom ? ` | symptom: ${entry.target_symptom}` : '';
      return `- "${entry.headline || entry.headline_text}"${lane}${claim}${symptom}`;
    })
    .join('\n');
  return `\n\nRECENT HEADLINES ALREADY USED FOR THIS ANGLE:\n${lines}\nDo NOT recycle these headline families, hook moves, or central claims.`;
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
export async function extractBrief(project, docs, angle, angleBrief = null) {
  const researchContent = docs.research?.content || '[No research document available]';
  const avatarContent = docs.avatar?.content || '[No avatar sheet available]';
  const offerContent = docs.offer_brief?.content || '[No offer brief available]';
  const beliefsContent = docs.necessary_beliefs?.content || '[No necessary beliefs document available]';

  // Extract first paragraph of avatar sheet for target demographic summary
  const targetDemographic = avatarContent.split('\n\n')[0] || avatarContent.slice(0, 500);

  // Build angle context — structured brief when available, flat name otherwise
  let angleContext;
  if (angleBrief && (angleBrief.core_buyer || angleBrief.symptom_pattern || angleBrief.scene)) {
    const parts = [`ANGLE NAME: "${angle || angleBrief.name || 'general'}"`];
    if (angleBrief.frame) parts.push(`FRAME: ${angleBrief.frame}`);
    if (angleBrief.core_buyer) parts.push(`CORE BUYER: ${angleBrief.core_buyer}`);
    if (angleBrief.symptom_pattern) parts.push(`SYMPTOM PATTERN: ${angleBrief.symptom_pattern}`);
    if (angleBrief.failed_solutions) parts.push(`FAILED SOLUTIONS: ${angleBrief.failed_solutions}`);
    if (angleBrief.current_belief) parts.push(`CURRENT BELIEF: ${angleBrief.current_belief}`);
    if (angleBrief.objection) parts.push(`OBJECTION TO ADDRESS: ${angleBrief.objection}`);
    if (angleBrief.emotional_state) parts.push(`EMOTIONAL STATE: ${angleBrief.emotional_state}`);
    if (angleBrief.scene) parts.push(`SCENE TO CENTER THE AD ON: ${angleBrief.scene}`);
    if (angleBrief.desired_belief_shift) parts.push(`DESIRED BELIEF SHIFT: ${angleBrief.desired_belief_shift}`);
    angleContext = parts.join('\n');
  } else {
    angleContext = `THE ANGLE FOR THIS BATCH: "${angle || 'general'}"`;
  }

  const prompt = `You are a direct response research analyst. Your job is to extract the most relevant raw material from brand foundational documents for a specific advertising angle.

BRAND: ${project.brand_name || project.name}
PRODUCT: ${project.product_description || ''}
TARGET DEMOGRAPHIC: ${targetDemographic}

${angleContext}

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
 * Stage 1: Headline generation — creates a structured pool of headline candidates
 * distributed across fixed hook lanes, with recent angle history supplied as an avoid list.
 *
 * @param {object} project - Project record
 * @param {string} briefPacket - Output of Stage 0
 * @param {string} angle - The advertising angle
 * @param {number} count - Total number of candidates to generate
 * @param {object|null} angleBrief - Structured angle brief when available
 * @param {Array} priorHeadlines - Recent headline history for the same angle
 * @returns {{ lanes_used: Array, sub_angles: Array, headlines: Array }}
 */
export async function generateHeadlines(project, briefPacket, angle, count, angleBrief = null, priorHeadlines = []) {
  const avatarSection = extractBriefSection(briefPacket, 'AVATAR IN THIS MOMENT');
  const emotionalEntry = extractBriefSection(briefPacket, 'EMOTIONAL ENTRY POINT');
  const painPoints = extractBriefSection(briefPacket, 'RELEVANT PAIN POINTS');
  const quotes = extractBriefSection(briefPacket, 'RELEVANT QUOTES');
  const anchors = extractBriefSection(briefPacket, 'SPECIFICITY ANCHORS');
  const selectedLanes = selectHeadlineLanes(angleBrief, count);
  const laneAllocation = buildLaneAllocation(selectedLanes, count);
  const priorHeadlineBlock = formatPriorHeadlineHistory(priorHeadlines);

  let structuredAngleBlock = '';
  if (angleBrief && (angleBrief.core_buyer || angleBrief.scene || angleBrief.objection)) {
    const parts = [];
    if (angleBrief.frame) parts.push(`FRAME: ${angleBrief.frame} — use this as the dominant structural lens.`);
    if (angleBrief.core_buyer) parts.push(`CORE BUYER: ${angleBrief.core_buyer}`);
    if (angleBrief.symptom_pattern) parts.push(`TARGET SYMPTOM PATTERN: ${angleBrief.symptom_pattern}`);
    if (angleBrief.scene) parts.push(`SCENE: ${angleBrief.scene} — center the headlines around this lived moment when useful.`);
    if (angleBrief.objection) parts.push(`OBJECTION TO ADDRESS: ${angleBrief.objection}`);
    if (angleBrief.failed_solutions) parts.push(`FAILED SOLUTIONS: ${angleBrief.failed_solutions}`);
    if (angleBrief.desired_belief_shift) parts.push(`DESIRED BELIEF SHIFT: ${angleBrief.desired_belief_shift} — headlines should move the reader toward this belief.`);
    if (angleBrief.tone) parts.push(`TONE: ${angleBrief.tone}`);
    if (angleBrief.avoid_list) parts.push(`AVOID: ${angleBrief.avoid_list}`);
    structuredAngleBlock = '\n\nSTRUCTURED ANGLE BRIEF:\n' + parts.join('\n');
  }

  const laneInstructions = laneAllocation
    .map(({ lane, count: laneCount }) => `- ${lane}: generate exactly ${laneCount} headline${laneCount === 1 ? '' : 's'}\n  ${HEADLINE_LANES[lane]}`)
    .join('\n');

  const prompt = `You are a world-class direct response copywriter writing Facebook ad headlines for health and wellness products targeting women 55-75. These women are skeptical, have been disappointed by other products, and need to feel safe, understood, and intrigued before they will engage.

Your job is NOT to produce loosely varied headlines. Your job is to produce a diverse headline set where each hook feels meaningfully different in persuasion style, emotional entry point, and central claim.

BRAND: ${project.brand_name || project.name}
PRODUCT: ${project.product_description || ''}

TARGET AUDIENCE IN THIS MOMENT:
${avatarSection || '(Not available)'}

THE ANGLE FOR THIS BATCH: "${angle || 'general'}"${structuredAngleBlock}

EMOTIONAL ENTRY POINT:
${emotionalEntry || '(Not available)'}

RELEVANT PAIN POINTS:
${painPoints || '(Not available)'}

LANGUAGE TO DRAW FROM (for tone and specificity — do not copy verbatim):
${quotes || '(Not available)'}

CONCRETE DETAILS TO WEAVE IN:
${anchors || '(Not available)'}${priorHeadlineBlock}

---

HEADLINE LANES TO USE FOR THIS BATCH:
${laneInstructions}

IMPORTANT DIVERSITY RULES:
- Write exactly ${count} headlines total.
- Every headline must belong to one of the allowed hook lanes above.
- No two headlines may share the same hook lane AND the same core claim.
- No two headlines may start with the same opening phrase.
- Do not recycle the same persuasion move with slightly different wording.
- The angle "${angle || 'general'}" is a strategic lens, not the headline text itself.
- Headlines must be short. Maximum 12 words. Under 8 words is ideal when it still feels natural.
- Avoid hype cliches, fake authority, miracle language, and anything that sounds like generic ad copy.

KEEP A SECONDARY "SUB-ANGLE" LABEL:
- For each headline, include a short sub_angle label that captures the micro-angle or speaker perspective for that exact line.
- This is a secondary variation layer inside the hook lane. Keep it short and concrete.

STRUCTURED METADATA REQUIREMENTS:
- hook_lane: one of the allowed lanes above
- core_claim: short phrase describing the central promise, problem, or idea
- target_symptom: the specific symptom or moment this headline is speaking to
- emotional_entry: the dominant emotional doorway for this line
- desired_belief_shift: the belief this line is trying to move the reader toward
- opening_pattern: classify the opening as one of these:
  direct_symptom | specific_moment | failed_solution | confession | objection_flip | review_statement | comparison | mechanism_hint | trust_signal | question_open | statement_open

SCORING:
After writing the headlines, score each one on:
- scroll_stop
- specificity
- uniqueness
- real_human

UNIQUENESS MUST PENALIZE:
- same hook lane + same core claim as another line
- same opening pattern with nearly the same meaning
- recycling ideas from the recent headline history above

Return ONLY valid JSON:
{
  "angle": "${angle || 'general'}",
  "lanes_used": ["symptom_recognition", "oddly_specific_moment"],
  "headlines": [
    {
      "rank": 1,
      "headline": "the headline text",
      "hook_lane": "symptom_recognition",
      "sub_angle": "late-night stiffness",
      "core_claim": "morning stiffness may come from sleep setup",
      "target_symptom": "waking up stiff and sore",
      "emotional_entry": "recognition",
      "desired_belief_shift": "this problem has a specific, fixable cause",
      "opening_pattern": "direct_symptom",
      "primary_emotion": "recognition",
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
          [{
            role: 'user',
            content: attempt > 1
              ? prompt + `\n\nIMPORTANT: Your previous attempt did not succeed. Generate exactly ${count} headlines, use only the allowed lanes, and return valid JSON.`
              : prompt
          }],
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

      const allowedLanes = new Set(selectedLanes);
      result.headlines = result.headlines
        .map((headline, index) => {
          const hookLane = allowedLanes.has(headline.hook_lane)
            ? headline.hook_lane
            : selectedLanes[index % selectedLanes.length];
          const primaryEmotion = headline.primary_emotion || headline.emotional_entry || 'curiosity';
          const emotionalEntryValue = headline.emotional_entry || primaryEmotion;
          return {
            rank: Number(headline.rank) || index + 1,
            headline: safeString(headline.headline),
            hook_lane: hookLane,
            sub_angle: safeString(headline.sub_angle) || hookLane,
            core_claim: safeString(headline.core_claim),
            target_symptom: safeString(headline.target_symptom),
            emotional_entry: safeString(emotionalEntryValue) || 'curiosity',
            desired_belief_shift: safeString(headline.desired_belief_shift) || angleBrief?.desired_belief_shift || '',
            opening_pattern: safeString(headline.opening_pattern) || inferOpeningPattern(headline.headline),
            primary_emotion: safeString(primaryEmotion) || 'curiosity',
            word_count: Number(headline.word_count) || safeString(headline.headline).split(/\s+/).filter(Boolean).length,
            scores: headline.scores && typeof headline.scores === 'object' ? headline.scores : {},
            average_score: Number(headline.average_score) || 0,
          };
        })
        .filter((headline) => headline.headline);

      result.headlines.sort((a, b) => {
        const scoreDiff = (b.average_score || 0) - (a.average_score || 0);
        if (Math.abs(scoreDiff) > 0.0001) return scoreDiff;
        return (a.rank || 999) - (b.rank || 999);
      });

      const uniqueSubAngles = Array.from(
        new Map(
          result.headlines.map((headline) => [
            `${headline.hook_lane}:${headline.sub_angle}`,
            {
              id: `${headline.hook_lane}:${headline.sub_angle}`,
              name: headline.sub_angle,
              hook_lane: headline.hook_lane,
              emotional_entry: headline.emotional_entry,
            }
          ])
        ).values()
      );

      result.sub_angles = Array.isArray(result.sub_angles) && result.sub_angles.length > 0
        ? result.sub_angles
        : uniqueSubAngles;
      result.lanes_used = Array.isArray(result.lanes_used) && result.lanes_used.length > 0
        ? result.lanes_used.filter((lane) => allowedLanes.has(lane))
        : selectedLanes;

      lastResult = result;
      console.log(`[Pipeline Stage 1] Generated ${result.headlines.length} structured headline candidates across ${result.lanes_used.length} lanes for angle: "${(angle || 'general').slice(0, 40)}"`);

      if (attempt < 3 && result.headlines.length < count) {
        console.warn(`[Pipeline Stage 1] Got ${result.headlines.length}/${count} headlines, retrying...`);
        await new Promise((resolve) => setTimeout(resolve, 3000));
        continue;
      }

      return result;
    } catch (err) {
      console.error(`[Pipeline Stage 1] Attempt ${attempt}/3 failed:`, err.message);
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 5000 * attempt));
      }
    }
  }

  if (lastResult && lastResult.headlines && lastResult.headlines.length > 0) {
    console.warn(`[Pipeline Stage 1] Returning partial results: ${lastResult.headlines.length} headlines`);
    return lastResult;
  }

  throw new Error('[Stage 1] All headline generation attempts failed. Claude may be experiencing issues — try again in a few minutes.');
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
export async function generateBodyCopies(project, briefPacket, headlines, angleBrief = null) {
  const quotes = extractBriefSection(briefPacket, 'RELEVANT QUOTES');
  const anchors = extractBriefSection(briefPacket, 'SPECIFICITY ANCHORS');
  const beliefs = extractBriefSection(briefPacket, 'RELEVANT BELIEFS');

  // Build tone/avoid directives from structured brief
  let briefToneBlock = '';
  if (angleBrief) {
    const parts = [];
    if (angleBrief.tone) parts.push(`TONE DIRECTIVE FROM ANGLE BRIEF: ${angleBrief.tone}`);
    if (angleBrief.avoid_list) parts.push(`AVOID (from angle brief): ${angleBrief.avoid_list}`);
    if (angleBrief.emotional_state) parts.push(`READER'S EMOTIONAL STATE: ${angleBrief.emotional_state}`);
    if (angleBrief.failed_solutions) parts.push(`FAILED SOLUTIONS TO REFERENCE: ${angleBrief.failed_solutions}`);
    if (angleBrief.desired_belief_shift) parts.push(`BELIEF SHIFT GOAL: ${angleBrief.desired_belief_shift}`);
    if (parts.length > 0) briefToneBlock = '\n\n' + parts.join('\n');
  }

  const allCopies = [];

  // Process in batches of 5
  for (let i = 0; i < headlines.length; i += 5) {
    const batch = headlines.slice(i, i + 5);
    const batchNum = Math.floor(i / 5) + 1;
    const totalBatches = Math.ceil(headlines.length / 5);

    const headlineList = batch.map((headlineObj, idx) => {
      const metadata = [
        headlineObj.hook_lane ? `lane: ${headlineObj.hook_lane}` : null,
        headlineObj.sub_angle ? `sub-angle: ${headlineObj.sub_angle}` : null,
        headlineObj.core_claim ? `core claim: ${headlineObj.core_claim}` : null,
        headlineObj.target_symptom ? `symptom: ${headlineObj.target_symptom}` : null,
        headlineObj.emotional_entry ? `emotional entry: ${headlineObj.emotional_entry}` : null,
        headlineObj.desired_belief_shift ? `belief shift: ${headlineObj.desired_belief_shift}` : null,
      ].filter(Boolean).join(' | ');
      return `${idx + 1}. "${headlineObj.headline}"${metadata ? `\n   ${metadata}` : ''}`;
    }).join('\n');

    const prompt = `You are a direct response copywriter writing Facebook ad primary text for a health/wellness brand. You write for women 55-75 dealing with chronic pain, broken sleep, and morning stiffness. Your copy is warm, specific, honest, and sounds like a real person — not a brand.

BRAND: ${project.brand_name || project.name}
PRODUCT: ${project.product_description || ''}

TONE RULES:
- Never use hype language or miracle framing
- Lead with relief, not claims
- Show skepticism openly — don't fight it
- Emphasize safety and reversibility
- Sound like a trusted friend who found something that helped, not a salesperson${briefToneBlock}

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
            hook_lane: matchingHeadline?.hook_lane || null,
            core_claim: matchingHeadline?.core_claim || null,
            target_symptom: matchingHeadline?.target_symptom || null,
            emotional_entry: matchingHeadline?.emotional_entry || matchingHeadline?.primary_emotion || null,
            desired_belief_shift: matchingHeadline?.desired_belief_shift || null,
            opening_pattern: matchingHeadline?.opening_pattern || null,
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
 * @param {object|null} headlineMeta - Selected headline metadata carried through the pipeline
 * @returns {string} Image generation prompt
 */
export async function generateImagePrompt(project, headline, bodyCopy, primaryEmotion, imageData, aspectRatio, angleBrief = null, headlineMeta = null) {
  // Build visual direction from structured angle brief
  let visualDirectionBlock = '';
  if (angleBrief && (angleBrief.scene || angleBrief.frame || angleBrief.tone)) {
    const parts = [];
    if (angleBrief.scene) parts.push(`SCENE/SETTING: ${angleBrief.scene} — the visual should evoke this moment`);
    if (angleBrief.frame) parts.push(`AD FRAME: ${angleBrief.frame} — inform the visual treatment accordingly`);
    if (angleBrief.core_buyer) parts.push(`CORE BUYER: ${angleBrief.core_buyer} — the person in the image should feel like this woman`);
    if (angleBrief.emotional_state) parts.push(`EMOTIONAL STATE TO CONVEY: ${angleBrief.emotional_state}`);
    if (angleBrief.tone) parts.push(`TONE: ${angleBrief.tone}`);
    if (angleBrief.avoid_list) parts.push(`VISUAL ELEMENTS TO AVOID: ${angleBrief.avoid_list}`);
    visualDirectionBlock = '\n\nSTRUCTURED VISUAL DIRECTION:\n' + parts.join('\n') + '\n';
  }

  let headlineStrategyBlock = '';
  if (headlineMeta && (headlineMeta.hook_lane || headlineMeta.core_claim || headlineMeta.target_symptom || headlineMeta.desired_belief_shift)) {
    const parts = [];
    if (headlineMeta.hook_lane) parts.push(`HOOK LANE: ${headlineMeta.hook_lane}`);
    if (headlineMeta.sub_angle) parts.push(`SUB-ANGLE: ${headlineMeta.sub_angle}`);
    if (headlineMeta.core_claim) parts.push(`CORE CLAIM: ${headlineMeta.core_claim}`);
    if (headlineMeta.target_symptom) parts.push(`TARGET SYMPTOM: ${headlineMeta.target_symptom}`);
    if (headlineMeta.emotional_entry) parts.push(`EMOTIONAL ENTRY: ${headlineMeta.emotional_entry}`);
    if (headlineMeta.desired_belief_shift) parts.push(`DESIRED BELIEF SHIFT: ${headlineMeta.desired_belief_shift}`);
    if (headlineMeta.opening_pattern) parts.push(`OPENING PATTERN: ${headlineMeta.opening_pattern}`);
    headlineStrategyBlock = '\nHEADLINE STRATEGY:\n' + parts.join('\n') + '\n';
  }

  const promptText = `You are a creative director generating prompts for text-to-image AI software. You create Facebook ad visuals for DTC health/wellness brands targeting women 55-75.

BRAND: ${project.brand_name || project.name}
PRODUCT APPEARANCE: ${project.product_description || ''}

ASPECT RATIO: ${aspectRatio || '1:1'}

THE APPROVED AD COPY (DO NOT MODIFY — render exactly as written):
HEADLINE: "${headline}"
BODY COPY: "${bodyCopy}"

PRIMARY EMOTION OF THIS AD: ${primaryEmotion || 'curiosity'}
${headlineStrategyBlock}
${visualDirectionBlock}
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
6. Supports the emotional tone of the headline — the visual mood (colors, lighting, texture, casting, composition) should reinforce what the headline makes the reader feel and what belief shift it is trying to create. Skepticism angles get editorial/news-style treatments. Pain point angles get warm, empathetic tones. Relief angles get bright, calm aesthetics.
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
  const { imagePrompt, aspectRatio = '1:1', imageModel, parentAdId, productImageBase64, productImageMimeType, angle, headline, bodyCopy, onEvent } = options;

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
      aspectRatio, angle, productImage, imageModel, emit,
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

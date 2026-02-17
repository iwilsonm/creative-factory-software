import { v4 as uuidv4 } from 'uuid';
import { chat, chatWithImage, chatWithImages } from './openai.js';
import { generateImage } from './gemini.js';
import { logGeminiCost } from './costTracker.js';
import {
  getProject, getLatestDoc, uploadBuffer, downloadToBuffer,
  getInspirationImages, getInspirationImageUrl,
  getRecentAdsForContext,
  convexClient, api
} from '../convexClient.js';
// Drive upload removed — ads are stored in Convex only

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

    const revisedPrompt = await chat(reviewMessages, 'gpt-4.1-mini');
    return revisedPrompt.trim();
  } catch (err) {
    console.warn('[AdGenerator] Prompt guidelines review failed, using original prompt:', err.message);
    return imagePrompt;
  }
}

/**
 * Build "already used" context text from recent ads + batch-so-far prompts.
 * Injected into the GPT request so it avoids repeating previous concepts.
 * Returns empty string if no history exists (first-ever generation works as-is).
 *
 * @param {Array} recentAds - From getRecentAdsForContext (DB history)
 * @param {Array} batchSoFar - Prompts generated earlier in the current batch run
 * @returns {string}
 */
export function buildAlreadyUsedContext(recentAds = [], batchSoFar = []) {
  const items = [];

  // Add DB history
  for (const ad of recentAds) {
    const parts = [];
    if (ad.headline) parts.push(`Headline: "${ad.headline}"`);
    if (ad.image_prompt) parts.push(`Concept: ${ad.image_prompt.slice(0, 150)}`);
    if (ad.angle) parts.push(`Angle: ${ad.angle}`);
    if (parts.length > 0) items.push(parts.join(' | '));
  }

  // Add prompts from earlier in the current batch
  for (const prompt of batchSoFar) {
    if (prompt) items.push(`Concept: ${prompt.slice(0, 150)}`);
  }

  if (items.length === 0) return '';

  return `\n\nIMPORTANT — AVOID REPEATING THESE PREVIOUS CONCEPTS (these were already generated):\n${items.map((item, i) => `${i + 1}. ${item}`).join('\n')}\n\nInstead, find a FRESH and COMPLETELY DIFFERENT visual concept, layout, color palette, headline approach, and sub-angle. Do NOT reuse similar compositions, metaphors, or visual themes from the above. Be creatively bold and explore an entirely new direction.`;
}

/**
 * Generate N distinct sub-angles from a parent angle using GPT-4.1-mini.
 * Used by batch processor to assign each ad a unique creative direction.
 * Falls back to repeating the original angle if parsing fails.
 *
 * @param {string} angle - The parent angle/topic
 * @param {number} count - How many sub-angles to generate
 * @param {object} project - Project object for brand context
 * @returns {Promise<string[]>}
 */
export async function generateSubAngles(angle, count, project) {
  if (!angle || count <= 1) return [angle];

  try {
    const messages = [
      {
        role: 'system',
        content: `You are a creative strategist for ${project.brand_name || 'a brand'}, a ${project.niche || ''} brand. Generate distinct sub-angles for advertising.`
      },
      {
        role: 'user',
        content: `I need ${count} distinct sub-angles for the ad angle: "${angle}"

Each sub-angle should be a specific, unique interpretation or facet of the main angle. They should be different enough that ads based on them would look and feel completely different from each other.

For example, if the main angle is "health benefits", sub-angles might be:
- "Morning energy boost ritual"
- "Immune defense for busy parents"
- "Mental clarity and focus at work"
- "Athletic recovery and performance"
- "Deep sleep and overnight renewal"

Return ONLY a JSON array of ${count} strings. No explanations.`
      }
    ];

    const response = await chat(messages, 'gpt-4.1-mini');

    // Parse the JSON array from the response
    const jsonMatch = response.match(/\[[\s\S]*?\]/);
    if (jsonMatch) {
      const subAngles = JSON.parse(jsonMatch[0]);
      if (Array.isArray(subAngles) && subAngles.length >= count) {
        console.log(`[AdGenerator] Generated ${subAngles.length} sub-angles for "${angle}": ${subAngles.join(', ')}`);
        return subAngles.slice(0, count);
      }
    }

    // Partial parse — pad with original angle
    console.warn(`[AdGenerator] Sub-angle parsing returned fewer than ${count} results, padding with original angle`);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
    while (parsed.length < count) parsed.push(angle);
    return parsed;

  } catch (err) {
    console.warn(`[AdGenerator] Sub-angle generation failed, using original angle for all: ${err.message}`);
    return Array(count).fill(angle);
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
    const revisedPrompt = await chat(messages, 'gpt-4.1-mini');
    return revisedPrompt.trim();
  } catch (err) {
    console.error('[AdGenerator] Prompt edit failed:', err.message);
    throw new Error('Failed to apply edit to prompt. Please try again.');
  }
}

/**
 * Build the creative director prompt (Message 1) for GPT-5.2.
 * Includes brand context + all 4 foundational documents.
 */
export function buildCreativeDirectorPrompt(project, docs) {
  const researchContent = docs.research?.content || '[No research document available]';
  const avatarContent = docs.avatar?.content || '[No avatar sheet available]';
  const offerContent = docs.offer_brief?.content || '[No offer brief available]';
  const beliefsContent = docs.necessary_beliefs?.content || '[No necessary beliefs document available]';

  return `You are a world-class creative director and image generation expert working exclusively for ${project.brand_name}, a ${project.niche} brand that ${project.product_description}.

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
}

/**
 * Build the image prompt request (Message 2) text.
 * Per the SOP, the core instruction is exactly "make a prompt for an image like this".
 * Angle, aspect ratio, product image, headline, and body copy are appended as additional direction.
 */
export function buildImageRequestText(angle, aspectRatio, hasProductImage = false, headline = null, bodyCopy = null, alreadyUsedContext = '') {
  let text = 'make a prompt for an image like this';

  const extras = [];
  if (hasProductImage) {
    extras.push('I have attached an image of the product — reference this product image in your prompt, as it will also be attached when the prompt is used for image generation');
  }
  if (headline) {
    extras.push(`The ad must include this headline text: "${headline}"`);
  }
  if (bodyCopy) {
    extras.push(`The ad must include this body copy text: "${bodyCopy}"`);
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

  // Append "already used" context for diversity (empty string = no-op for first-ever generation)
  if (alreadyUsedContext) {
    text += alreadyUsedContext;
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

  // Download from Convex storage to get base64
  const buffer = await downloadToBuffer(selected.storageId);
  const mimeType = selected.mimeType || 'image/jpeg';
  const base64 = buffer.toString('base64');

  return { base64, mimeType, fileId: selected.drive_file_id };
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
  const base64 = buffer.toString('base64');

  return { base64, mimeType, fileId: template.externalId };
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
  const { angle, aspectRatio = '1:1', inspirationImageId, uploadedImageBase64, uploadedImageMimeType, productImageBase64, productImageMimeType, headline, bodyCopy, onEvent } = options;

  const emit = (event) => {
    if (onEvent) {
      try { onEvent(event); } catch {}
    }
  };

  // Create ad record at the start
  const adId = uuidv4();
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
  });

  try {
    // 1. Load project
    const project = await getProject(projectId);
    if (!project) throw new Error('Project not found');

    // 2. Load foundational docs
    const docs = {
      research: await getLatestDoc(projectId, 'research'),
      avatar: await getLatestDoc(projectId, 'avatar'),
      offer_brief: await getLatestDoc(projectId, 'offer_brief'),
      necessary_beliefs: await getLatestDoc(projectId, 'necessary_beliefs')
    };

    // Ensure at least some docs exist
    const docCount = Object.values(docs).filter(d => d && d.content).length;
    if (docCount === 0) {
      throw new Error('No foundational documents found. Generate or upload documents first.');
    }

    // 3. Select inspiration image (uploaded image takes priority, then specific ID, then random from folder)
    emit({ type: 'status', status: 'generating_copy', message: 'Selecting inspiration image...' });

    let inspiration;
    if (uploadedImageBase64 && uploadedImageMimeType) {
      // Use the directly uploaded image
      inspiration = {
        base64: uploadedImageBase64,
        mimeType: uploadedImageMimeType,
        fileId: 'uploaded'
      };
    } else {
      // Select from inspiration folder (specific ID or random)
      inspiration = await selectInspirationImage(projectId, inspirationImageId);
      // Update the inspiration_image_id in the record
      await convexClient.mutation(api.adCreatives.update, {
        externalId: adId,
        inspiration_image_id: inspiration.fileId,
      });
    }

    // 4. Fetch "already used" context for diversity (one fast DB query, no extra GPT calls)
    let alreadyUsedContext = '';
    try {
      const recentAds = await getRecentAdsForContext(projectId, angle, 10);
      alreadyUsedContext = buildAlreadyUsedContext(recentAds);
    } catch (err) {
      console.warn('[AdGenerator] Could not fetch recent ads for context:', err.message);
    }

    // 5. GPT-5.2 Message 1: Creative director prompt + foundational docs
    emit({ type: 'status', status: 'generating_copy', message: 'Sending creative brief to GPT-5.2...' });

    const creativeDirectorPrompt = buildCreativeDirectorPrompt(project, docs);
    const messages = [
      { role: 'user', content: creativeDirectorPrompt }
    ];

    // Get GPT-5.2's acknowledgment
    const acknowledgment = await chat(messages, 'gpt-5.2');

    // 6. GPT-5.2 Message 2: Inspiration image + optional product image + instructions
    const hasProductImage = !!(productImageBase64 && productImageMimeType);
    emit({ type: 'status', status: 'generating_copy', message: hasProductImage
      ? 'GPT-5.2 analyzing inspiration image + product image...'
      : 'GPT-5.2 analyzing inspiration image...' });

    const imageRequestText = buildImageRequestText(angle, aspectRatio, hasProductImage, headline, bodyCopy, alreadyUsedContext);
    const conversationSoFar = [
      { role: 'user', content: creativeDirectorPrompt },
      { role: 'assistant', content: acknowledgment }
    ];

    let imagePrompt;
    if (hasProductImage) {
      // Send both inspiration and product images using multi-image function
      imagePrompt = await chatWithImages(
        conversationSoFar,
        imageRequestText,
        [
          { base64: inspiration.base64, mimeType: inspiration.mimeType },
          { base64: productImageBase64, mimeType: productImageMimeType }
        ],
        'gpt-5.2'
      );
    } else {
      // Send only the inspiration image
      imagePrompt = await chatWithImage(
        conversationSoFar,
        imageRequestText,
        inspiration.base64,
        inspiration.mimeType,
        'gpt-5.2'
      );
    }

    // Apply prompt guidelines if set
    if (project.prompt_guidelines) {
      emit({ type: 'status', status: 'generating_copy', message: 'Reviewing prompt against guidelines...' });
      imagePrompt = await reviewPromptWithGuidelines(imagePrompt, project.prompt_guidelines);
    }

    // Update record with GPT output
    await convexClient.mutation(api.adCreatives.update, {
      externalId: adId,
      gpt_creative_output: imagePrompt,
      image_prompt: imagePrompt,
      status: 'generating_image',
    });

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
    : 'Generating image with Nano Banana Pro...' });

  const { imageBuffer, mimeType: imgMime } = await generateImage(imagePrompt, aspectRatio, productImage);

  // Log Gemini cost (fire-and-forget)
  try { await logGeminiCost(projectId, 1, '2K', false); } catch {}

  // Upload image to Convex storage
  const storageId = await uploadBuffer(imageBuffer, imgMime);

  // Update final record
  await convexClient.mutation(api.adCreatives.update, {
    externalId: adId,
    storageId,
    status: 'completed',
  });

  // Return the completed ad record
  const ad = await convexClient.query(api.adCreatives.getByExternalId, { externalId: adId });
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
    imageUrl: `/api/projects/${projectId}/ads/${adId}/image`,
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
  const { templateImageId, angle, aspectRatio = '1:1', productImageBase64, productImageMimeType, headline, bodyCopy, onEvent } = options;

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
  });

  try {
    // 1. Load project
    const project = await getProject(projectId);
    if (!project) throw new Error('Project not found');

    // 2. Load foundational docs
    const docs = {
      research: await getLatestDoc(projectId, 'research'),
      avatar: await getLatestDoc(projectId, 'avatar'),
      offer_brief: await getLatestDoc(projectId, 'offer_brief'),
      necessary_beliefs: await getLatestDoc(projectId, 'necessary_beliefs')
    };

    const docCount = Object.values(docs).filter(d => d && d.content).length;
    if (docCount === 0) {
      throw new Error('No foundational documents found. Generate or upload documents first.');
    }

    // 3. Select template image
    emit({ type: 'status', status: 'generating_copy', message: 'Loading template image...' });
    const template = await selectTemplateImage(templateImageId);

    // 4. Fetch "already used" context for diversity
    let alreadyUsedContext = '';
    try {
      const recentAds = await getRecentAdsForContext(projectId, angle, 10);
      alreadyUsedContext = buildAlreadyUsedContext(recentAds);
    } catch (err) {
      console.warn('[AdGenerator] Could not fetch recent ads for context:', err.message);
    }

    // 5. GPT-5.2 Message 1: Creative director prompt + foundational docs
    emit({ type: 'status', status: 'generating_copy', message: 'Sending creative brief to GPT-5.2...' });

    const creativeDirectorPrompt = buildCreativeDirectorPrompt(project, docs);
    const messages = [
      { role: 'user', content: creativeDirectorPrompt }
    ];

    const acknowledgment = await chat(messages, 'gpt-5.2');

    // 6. GPT-5.2 Message 2: Template image + optional product image + instructions
    const hasProductImage = !!(productImageBase64 && productImageMimeType);
    emit({ type: 'status', status: 'generating_copy', message: hasProductImage
      ? 'GPT-5.2 analyzing template image + product image...'
      : 'GPT-5.2 analyzing template image...' });

    const imageRequestText = buildImageRequestText(angle, aspectRatio, hasProductImage, headline, bodyCopy, alreadyUsedContext);
    const conversationSoFar = [
      { role: 'user', content: creativeDirectorPrompt },
      { role: 'assistant', content: acknowledgment }
    ];

    let imagePrompt;
    if (hasProductImage) {
      imagePrompt = await chatWithImages(
        conversationSoFar,
        imageRequestText,
        [
          { base64: template.base64, mimeType: template.mimeType },
          { base64: productImageBase64, mimeType: productImageMimeType }
        ],
        'gpt-5.2'
      );
    } else {
      imagePrompt = await chatWithImage(
        conversationSoFar,
        imageRequestText,
        template.base64,
        template.mimeType,
        'gpt-5.2'
      );
    }

    // Apply prompt guidelines if set
    if (project.prompt_guidelines) {
      emit({ type: 'status', status: 'generating_copy', message: 'Reviewing prompt against guidelines...' });
      imagePrompt = await reviewPromptWithGuidelines(imagePrompt, project.prompt_guidelines);
    }

    // Update record with GPT output
    await convexClient.mutation(api.adCreatives.update, {
      externalId: adId,
      gpt_creative_output: imagePrompt,
      image_prompt: imagePrompt,
      status: 'generating_image',
    });

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

  try {
    const project = await getProject(projectId);
    if (!project) throw new Error('Project not found');

    // Apply prompt guidelines if set
    let finalPrompt = imagePrompt.trim();
    if (project.prompt_guidelines) {
      emit({ type: 'status', status: 'generating_image', message: 'Reviewing prompt against guidelines...' });
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

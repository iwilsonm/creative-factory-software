import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chat, chatWithImage, chatWithImages } from './openai.js';
import { generateImage } from './gemini.js';
import { logGeminiCost } from './costTracker.js';
import { getProject, getLatestDoc } from '../db.js';
import { uploadFileToDrive } from '../routes/drive.js';
import db from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GENERATED_DIR = path.join(__dirname, '..', '..', 'data', 'generated-images');
const INSPIRATION_DIR = path.join(__dirname, '..', '..', 'data', 'inspiration');

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

// Ensure generated images directory exists
if (!fs.existsSync(GENERATED_DIR)) fs.mkdirSync(GENERATED_DIR, { recursive: true });

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
export function buildImageRequestText(angle, aspectRatio, hasProductImage = false, headline = null, bodyCopy = null) {
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

  return text;
}

/**
 * Select an inspiration image from the local cache.
 * @param {string} projectId
 * @param {string|null} inspirationImageId - Specific file ID to use, or null for random
 * @returns {{ filePath: string, base64: string, mimeType: string, fileId: string }}
 */
export function selectInspirationImage(projectId, inspirationImageId) {
  const localDir = path.join(INSPIRATION_DIR, projectId);
  if (!fs.existsSync(localDir)) {
    throw new Error('No inspiration images cached. Sync your inspiration folder first.');
  }

  const files = fs.readdirSync(localDir).filter(f => !f.startsWith('.'));
  if (files.length === 0) {
    throw new Error('No inspiration images found. Add images to your Drive inspiration folder and sync.');
  }

  let selectedFile;
  if (inspirationImageId) {
    // Find the specific file by ID prefix
    selectedFile = files.find(f => f.startsWith(inspirationImageId + '.'));
    if (!selectedFile) {
      throw new Error(`Inspiration image ${inspirationImageId} not found in local cache.`);
    }
  } else {
    // Random selection
    selectedFile = files[Math.floor(Math.random() * files.length)];
  }

  const filePath = path.join(localDir, selectedFile);
  const ext = path.extname(selectedFile).toLowerCase();
  const mimeType = EXT_TO_MIME[ext] || 'image/jpeg';
  const base64 = fs.readFileSync(filePath).toString('base64');
  const fileId = selectedFile.split('.')[0];

  return { filePath, base64, mimeType, fileId };
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
  db.prepare(`
    INSERT INTO ad_creatives (id, project_id, generation_mode, angle, headline, body_copy, aspect_ratio, status, inspiration_image_id)
    VALUES (?, ?, 'mode1', ?, ?, ?, ?, 'generating_copy', ?)
  `).run(adId, projectId, angle || null, headline || null, bodyCopy || null, aspectRatio, inspirationImageId || null);

  try {
    // 1. Load project
    const project = getProject(projectId);
    if (!project) throw new Error('Project not found');

    // 2. Load foundational docs
    const docs = {
      research: getLatestDoc(projectId, 'research'),
      avatar: getLatestDoc(projectId, 'avatar'),
      offer_brief: getLatestDoc(projectId, 'offer_brief'),
      necessary_beliefs: getLatestDoc(projectId, 'necessary_beliefs')
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
      inspiration = selectInspirationImage(projectId, inspirationImageId);
      // Update the inspiration_image_id in the record
      db.prepare('UPDATE ad_creatives SET inspiration_image_id = ? WHERE id = ?')
        .run(inspiration.fileId, adId);
    }

    // 4. GPT-5.2 Message 1: Creative director prompt + foundational docs
    emit({ type: 'status', status: 'generating_copy', message: 'Sending creative brief to GPT-5.2...' });

    const creativeDirectorPrompt = buildCreativeDirectorPrompt(project, docs);
    const messages = [
      { role: 'user', content: creativeDirectorPrompt }
    ];

    // Get GPT-5.2's acknowledgment
    const acknowledgment = await chat(messages, 'gpt-5.2');

    // 5. GPT-5.2 Message 2: Inspiration image + optional product image + instructions
    const hasProductImage = !!(productImageBase64 && productImageMimeType);
    emit({ type: 'status', status: 'generating_copy', message: hasProductImage
      ? 'GPT-5.2 analyzing inspiration image + product image...'
      : 'GPT-5.2 analyzing inspiration image...' });

    const imageRequestText = buildImageRequestText(angle, aspectRatio, hasProductImage, headline, bodyCopy);
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
    db.prepare('UPDATE ad_creatives SET gpt_creative_output = ?, image_prompt = ?, status = ? WHERE id = ?')
      .run(imagePrompt, imagePrompt, 'generating_image', adId);

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
    db.prepare("UPDATE ad_creatives SET status = 'failed' WHERE id = ?").run(adId);
    emit({ type: 'error', error: err.message });
    throw err;
  }
}

/**
 * Shared helper: Gemini image generation → save locally → upload to Drive → finalize record.
 * Used by both generateAd() (full pipeline) and regenerateImageOnly() (prompt-only).
 */
async function generateAndSaveImage({ adId, projectId, project, imagePrompt, aspectRatio, angle, productImage, emit, modeLabel = 'Mode1' }) {
  // Nano Banana Pro: Generate image
  emit({ type: 'status', status: 'generating_image', message: productImage
    ? 'Generating image with Nano Banana Pro (with product reference)...'
    : 'Generating image with Nano Banana Pro...' });

  const { imageBuffer, mimeType: imgMime } = await generateImage(imagePrompt, aspectRatio, productImage);

  // Log Gemini cost (fire-and-forget)
  try { logGeminiCost(projectId, 1, '2K', false); } catch {}

  // Save image locally
  const projectImageDir = path.join(GENERATED_DIR, projectId);
  fs.mkdirSync(projectImageDir, { recursive: true });

  const ext = imgMime === 'image/jpeg' ? '.jpg' : '.png';
  const imageFileName = `${adId}${ext}`;
  const imagePath = path.join(projectImageDir, imageFileName);
  fs.writeFileSync(imagePath, imageBuffer);

  db.prepare('UPDATE ad_creatives SET image_path = ?, status = ? WHERE id = ?')
    .run(imagePath, 'uploading_drive', adId);

  // Upload to Google Drive (if configured)
  let driveFileId = null;
  let driveUrl = null;

  if (project.drive_folder_id) {
    emit({ type: 'status', status: 'uploading_drive', message: 'Uploading to Google Drive...' });

    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
      const angleSlug = slugify(angle);
      const driveName = `${project.name}_${modeLabel}_${angleSlug}_${timestamp}${ext}`;
      const driveResult = await uploadFileToDrive(imagePath, driveName, project.drive_folder_id, imgMime);
      driveFileId = driveResult.fileId;
      driveUrl = driveResult.webViewLink;
    } catch (driveErr) {
      console.error('Drive upload failed:', driveErr.message);
      const hint = driveErr.message.includes('storage quota') || driveErr.message.includes('storageQuotaExceeded')
        ? 'Service accounts need a Shared Drive to upload files. Create a Shared Drive, add the service account as a member, and use a folder inside it as your output folder.'
        : driveErr.message;
      emit({ type: 'warning', message: `Drive upload failed: ${hint}` });
    }
  }

  // Update final record
  db.prepare(`
    UPDATE ad_creatives
    SET drive_file_id = ?, drive_url = ?, status = 'completed'
    WHERE id = ?
  `).run(driveFileId, driveUrl, adId);

  // Return the completed ad record
  const ad = db.prepare('SELECT * FROM ad_creatives WHERE id = ?').get(adId);
  ad.imageUrl = `/api/projects/${projectId}/ads/${adId}/image`;

  emit({ type: 'complete', ad });
  return ad;
}

/**
 * Regenerate an image using a user-provided prompt (skip GPT entirely).
 * Creates a new ad record linked to the parent ad.
 *
 * @param {string} projectId
 * @param {object} options
 * @param {string} options.imagePrompt - The edited/custom prompt text
 * @param {string} [options.aspectRatio='1:1']
 * @param {string} [options.parentAdId] - The ad this was derived from
 * @param {string} [options.productImageBase64]
 * @param {string} [options.productImageMimeType]
 * @param {string} [options.angle] - Carry forward from parent
 * @param {string} [options.headline] - Carry forward from parent
 * @param {string} [options.bodyCopy] - Carry forward from parent
 * @param {(event: object) => void} [options.onEvent]
 * @returns {Promise<object>}
 */
/**
 * Select a template image from local storage.
 * @param {string} templateImageId - The template_images.id to load
 * @returns {{ base64: string, mimeType: string, fileId: string }}
 */
export function selectTemplateImage(templateImageId) {
  const template = db.prepare('SELECT * FROM template_images WHERE id = ?').get(templateImageId);
  if (!template) {
    throw new Error(`Template image ${templateImageId} not found.`);
  }
  if (!template.file_path || !fs.existsSync(template.file_path)) {
    throw new Error(`Template image file not found on disk. Re-upload the template.`);
  }

  const ext = path.extname(template.file_path).toLowerCase();
  const mimeType = EXT_TO_MIME[ext] || 'image/jpeg';
  const base64 = fs.readFileSync(template.file_path).toString('base64');

  return { base64, mimeType, fileId: template.id };
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
  db.prepare(`
    INSERT INTO ad_creatives (id, project_id, generation_mode, angle, headline, body_copy, aspect_ratio, status, template_image_id)
    VALUES (?, ?, 'mode2', ?, ?, ?, ?, 'generating_copy', ?)
  `).run(adId, projectId, angle || null, headline || null, bodyCopy || null, aspectRatio, templateImageId);

  try {
    // 1. Load project
    const project = getProject(projectId);
    if (!project) throw new Error('Project not found');

    // 2. Load foundational docs
    const docs = {
      research: getLatestDoc(projectId, 'research'),
      avatar: getLatestDoc(projectId, 'avatar'),
      offer_brief: getLatestDoc(projectId, 'offer_brief'),
      necessary_beliefs: getLatestDoc(projectId, 'necessary_beliefs')
    };

    const docCount = Object.values(docs).filter(d => d && d.content).length;
    if (docCount === 0) {
      throw new Error('No foundational documents found. Generate or upload documents first.');
    }

    // 3. Select template image
    emit({ type: 'status', status: 'generating_copy', message: 'Loading template image...' });
    const template = selectTemplateImage(templateImageId);

    // 4. GPT-5.2 Message 1: Creative director prompt + foundational docs
    emit({ type: 'status', status: 'generating_copy', message: 'Sending creative brief to GPT-5.2...' });

    const creativeDirectorPrompt = buildCreativeDirectorPrompt(project, docs);
    const messages = [
      { role: 'user', content: creativeDirectorPrompt }
    ];

    const acknowledgment = await chat(messages, 'gpt-5.2');

    // 5. GPT-5.2 Message 2: Template image + optional product image + instructions
    const hasProductImage = !!(productImageBase64 && productImageMimeType);
    emit({ type: 'status', status: 'generating_copy', message: hasProductImage
      ? 'GPT-5.2 analyzing template image + product image...'
      : 'GPT-5.2 analyzing template image...' });

    const imageRequestText = buildImageRequestText(angle, aspectRatio, hasProductImage, headline, bodyCopy);
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
    db.prepare('UPDATE ad_creatives SET gpt_creative_output = ?, image_prompt = ?, status = ? WHERE id = ?')
      .run(imagePrompt, imagePrompt, 'generating_image', adId);

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
    db.prepare("UPDATE ad_creatives SET status = 'failed' WHERE id = ?").run(adId);
    emit({ type: 'error', error: err.message });
    throw err;
  }
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
  db.prepare(`
    INSERT INTO ad_creatives (id, project_id, generation_mode, angle, headline, body_copy, aspect_ratio, status, image_prompt, gpt_creative_output, parent_ad_id)
    VALUES (?, ?, 'image_only', ?, ?, ?, ?, 'generating_image', ?, ?, ?)
  `).run(adId, projectId, angle || null, headline || null, bodyCopy || null, aspectRatio, imagePrompt.trim(), imagePrompt.trim(), parentAdId || null);

  try {
    const project = getProject(projectId);
    if (!project) throw new Error('Project not found');

    // Apply prompt guidelines if set
    let finalPrompt = imagePrompt.trim();
    if (project.prompt_guidelines) {
      emit({ type: 'status', status: 'generating_image', message: 'Reviewing prompt against guidelines...' });
      finalPrompt = await reviewPromptWithGuidelines(finalPrompt, project.prompt_guidelines);
      // Update the stored prompt if it changed
      if (finalPrompt !== imagePrompt.trim()) {
        db.prepare('UPDATE ad_creatives SET image_prompt = ?, gpt_creative_output = ? WHERE id = ?')
          .run(finalPrompt, finalPrompt, adId);
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
    db.prepare("UPDATE ad_creatives SET status = 'failed' WHERE id = ?").run(adId);
    emit({ type: 'error', error: err.message });
    throw err;
  }
}

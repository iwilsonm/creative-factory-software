/**
 * LP Publisher — Publish/unpublish landing pages to Cloudflare Pages.
 *
 * Uses the Cloudflare Pages Direct Upload API to deploy self-contained HTML
 * landing pages with optimized images.
 *
 * Flows:
 *   publish(page, slug, projectId)   — Validate, bake HTML, optimize images, deploy
 *   unpublish(page)                  — Delete deployment from Cloudflare
 */

import { getSetting } from '../convexClient.js';
import {
  getLandingPage,
  getLandingPagesByProject,
  updateLandingPage,
  createLandingPageVersion,
  getStorageUrl,
  downloadToBuffer,
} from '../convexClient.js';
import { v4 as uuidv4 } from 'uuid';
import { assembleLandingPage } from './lpGenerator.js';

/**
 * Get Cloudflare credentials from settings.
 */
async function getCloudflareConfig() {
  const accountId = await getSetting('cloudflare_account_id');
  const apiToken = await getSetting('cloudflare_api_token');
  const projectsJson = await getSetting('cloudflare_pages_projects');

  if (!accountId || !apiToken) {
    throw new Error('Cloudflare credentials not configured. Set Account ID and API Token in Settings.');
  }

  let projects = [];
  if (projectsJson) {
    try { projects = JSON.parse(projectsJson); } catch {}
  }

  return { accountId, apiToken, projects };
}

/**
 * Find the Cloudflare Pages project name for a given project.
 */
async function getCfProjectName(projectId, cfConfig) {
  // Look for a project mapping
  const mapping = cfConfig.projects.find(p => p.projectId === projectId);
  if (mapping?.cfProjectName) return mapping.cfProjectName;

  // If only one project configured, use it
  if (cfConfig.projects.length === 1) return cfConfig.projects[0].cfProjectName;

  // Fall back to first project
  if (cfConfig.projects.length > 0) return cfConfig.projects[0].cfProjectName;

  throw new Error('No Cloudflare Pages project configured. Add one in Settings.');
}

/**
 * Validate a landing page is ready for publishing.
 */
function validateForPublish(page, slug) {
  const errors = [];

  if (!slug || !slug.trim()) {
    errors.push('Slug is required for publishing.');
  }

  if (!page.html_template) {
    errors.push('No HTML template generated. Regenerate the landing page first.');
  }

  if (!page.copy_sections) {
    errors.push('No copy sections generated.');
  }

  // Validate CTA links
  const ctaLinks = page.cta_links ? JSON.parse(page.cta_links) : [];
  const missingUrls = ctaLinks.filter(c => !c.url || c.url === '#order' || c.url === '#');
  if (missingUrls.length > 0) {
    errors.push(`${missingUrls.length} CTA link(s) missing URLs: ${missingUrls.map((_, i) => `CTA ${i + 1}`).join(', ')}`);
  }

  return errors;
}

/**
 * Check if a slug conflicts with another published LP in the same CF project.
 */
async function checkSlugConflict(slug, pageId, projectId) {
  const allPages = await getLandingPagesByProject(projectId);
  const conflict = allPages.find(p =>
    p.slug === slug &&
    p.externalId !== pageId &&
    (p.status === 'published')
  );
  return conflict ? conflict.name : null;
}

/**
 * Bake the final HTML — replace all placeholders with actual content.
 * This is similar to assembleLandingPage but produces the final published version
 * with local image paths (images will be co-deployed).
 */
function bakeFinalHtml(page, slug, imageFiles) {
  const htmlTemplate = page.html_template || '';
  const copySections = page.copy_sections ? JSON.parse(page.copy_sections) : [];
  const ctaLinks = page.cta_links ? JSON.parse(page.cta_links) : [];
  const imageSlots = page.image_slots ? JSON.parse(page.image_slots) : [];

  let html = htmlTemplate;

  // Replace copy section placeholders
  for (const section of copySections) {
    const placeholder = `{{${section.type}}}`;
    const htmlContent = section.content
      .split(/\n\n+/)
      .map(para => para.trim())
      .filter(para => para.length > 0)
      .map(para => {
        if (para.length < 100 && !para.includes('.')) return para;
        return `<p>${para.replace(/\n/g, '<br>')}</p>`;
      })
      .join('\n');
    html = html.replaceAll(placeholder, htmlContent);
  }

  // Replace image placeholders with local paths
  for (let i = 0; i < imageSlots.length; i++) {
    const placeholder = `{{image_${i + 1}}}`;
    const imageFile = imageFiles.find(f => f.slotIndex === i);
    if (imageFile) {
      // Use relative path within the deployment
      html = html.replaceAll(placeholder, `images/${imageFile.filename}`);
    } else {
      // Fallback to storage URL or placeholder
      const slot = imageSlots[i];
      const url = slot.storageUrl || `https://placehold.co/${slot.suggested_size || '800x400'}/e2e8f0/64748b?text=Image+${i + 1}`;
      html = html.replaceAll(placeholder, url);
    }

    // Replace alt text placeholder if it exists
    const altPlaceholder = `{{image_${i + 1}_alt}}`;
    const slot = imageSlots[i];
    html = html.replaceAll(altPlaceholder, slot.description || `Image ${i + 1}`);
  }

  // Replace CTA placeholders
  for (let i = 0; i < ctaLinks.length; i++) {
    const urlPlaceholder = `{{cta_${i + 1}_url}}`;
    const textPlaceholder = `{{cta_${i + 1}_text}}`;
    const cta = ctaLinks[i];
    html = html.replaceAll(urlPlaceholder, cta.url || '#');
    html = html.replaceAll(textPlaceholder, cta.text || cta.text_suggestion || 'Order Now');
  }

  return html;
}

/**
 * Download and optionally optimize images from Convex storage.
 * Returns array of { slotIndex, filename, buffer, mimeType }.
 */
async function prepareImages(imageSlots, sendEvent) {
  const imageFiles = [];
  let sharp = null;

  // Try to load sharp for image optimization
  try {
    sharp = (await import('sharp')).default;
  } catch {
    console.log('[LPPublish] sharp not available, using original images');
  }

  for (let i = 0; i < imageSlots.length; i++) {
    const slot = imageSlots[i];
    if (!slot.storageId) continue;

    if (sendEvent) {
      sendEvent({ type: 'progress', message: `Processing image ${i + 1} of ${imageSlots.length}...` });
    }

    try {
      let buffer = await downloadToBuffer(slot.storageId);
      let mimeType = 'image/jpeg';
      let filename = `image-${i + 1}.jpg`;

      if (sharp) {
        // Resize and compress with sharp
        const metadata = await sharp(buffer).metadata();
        let sharpInstance = sharp(buffer);

        // Resize if image is larger than needed
        const maxWidth = parseInt(slot.suggested_size?.split('x')[0]) || 1200;
        if (metadata.width > maxWidth) {
          sharpInstance = sharpInstance.resize(maxWidth, null, { withoutEnlargement: true });
        }

        buffer = await sharpInstance.jpeg({ quality: 85 }).toBuffer();
      }

      imageFiles.push({
        slotIndex: i,
        filename,
        buffer,
        mimeType,
      });
    } catch (err) {
      console.error(`[LPPublish] Failed to process image ${i + 1}:`, err.message);
      // Continue without this image
    }
  }

  return imageFiles;
}

/**
 * Deploy files to Cloudflare Pages using Direct Upload API.
 *
 * Steps:
 * 1. Create a new deployment with form data containing all files
 * 2. Each file is added as a form field with the path as the key
 */
async function deployToCloudflare(accountId, apiToken, cfProjectName, slug, htmlContent, imageFiles, sendEvent) {
  if (sendEvent) {
    sendEvent({ type: 'progress', message: 'Uploading to Cloudflare Pages...' });
  }

  // Build multipart form data with all files
  // Cloudflare Pages Direct Upload expects files as form fields
  const FormData = (await import('form-data')).default;
  const form = new FormData();

  // Add HTML file
  const htmlBuffer = Buffer.from(htmlContent, 'utf-8');
  form.append(`/${slug}/index.html`, htmlBuffer, {
    filename: 'index.html',
    contentType: 'text/html',
  });

  // Add image files
  for (const img of imageFiles) {
    form.append(`/${slug}/images/${img.filename}`, img.buffer, {
      filename: img.filename,
      contentType: img.mimeType,
    });
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${cfProjectName}/deployments`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      ...form.getHeaders(),
    },
    body: form,
  });

  const result = await response.json();

  if (!result.success) {
    const errors = result.errors || [];
    const errorMsg = errors.map(e => e.message).join(', ') || 'Unknown Cloudflare error';
    const errorCode = errors[0]?.code;

    // Map known error codes to user-friendly messages
    if (errorCode === 8000000 || errorMsg.includes('authentication') || errorMsg.includes('Authorization')) {
      throw new Error('Cloudflare authentication failed. Check your API token in Settings.');
    }
    if (errorCode === 8000007 || errorMsg.includes('not found')) {
      throw new Error(`Cloudflare Pages project "${cfProjectName}" not found. Verify the project name in Settings.`);
    }
    if (errorMsg.includes('quota') || errorMsg.includes('limit') || errorMsg.includes('rate')) {
      throw new Error(`Cloudflare deployment quota or rate limit exceeded. ${errorMsg}`);
    }

    throw new Error(`Cloudflare deployment failed: ${errorMsg}`);
  }

  return {
    deploymentId: result.result?.id,
    url: result.result?.url,
    projectName: cfProjectName,
    environment: result.result?.environment || 'production',
    createdOn: result.result?.created_on,
  };
}

/**
 * Delete a deployment from Cloudflare Pages.
 */
async function deleteFromCloudflare(accountId, apiToken, cfProjectName, deploymentId) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/pages/projects/${cfProjectName}/deployments/${deploymentId}`;

  const response = await fetch(url, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${apiToken}`,
    },
    body: JSON.stringify({ force: true }),
  });

  const result = await response.json();

  if (!result.success) {
    // Don't throw on 404 — deployment may already be gone
    const is404 = result.errors?.some(e => e.code === 8000007 || e.message?.includes('not found'));
    if (!is404) {
      const errorMsg = result.errors?.map(e => e.message).join(', ') || 'Unknown error';
      throw new Error(`Cloudflare delete failed: ${errorMsg}`);
    }
  }

  return true;
}

/**
 * Publish a landing page to Cloudflare Pages.
 *
 * @param {string} pageId - Landing page externalId
 * @param {string} slug - URL slug for the deployment
 * @param {string} projectId - Project externalId (for CF project mapping)
 * @param {Function} sendEvent - SSE event sender
 * @returns {object} - { published_url, deployment }
 */
export async function publishLandingPage(pageId, slug, projectId, sendEvent) {
  // Get page data
  const page = await getLandingPage(pageId);
  if (!page) throw new Error('Landing page not found');

  // Validate
  const validationErrors = validateForPublish(page, slug);
  if (validationErrors.length > 0) {
    throw new Error(`Validation failed: ${validationErrors.join(' ')}`);
  }

  // Check slug conflict
  const conflict = await checkSlugConflict(slug, pageId, projectId);
  if (conflict) {
    throw new Error(`Slug "${slug}" is already used by "${conflict}". Choose a different slug.`);
  }

  // Get Cloudflare config
  const cfConfig = await getCloudflareConfig();
  const cfProjectName = await getCfProjectName(projectId, cfConfig);

  if (sendEvent) {
    sendEvent({ type: 'phase', phase: 'version_save', message: 'Saving version snapshot...' });
  }

  // Save current state as a version
  const currentVersion = page.current_version || 1;
  const newVersion = currentVersion + 1;
  const versionId = uuidv4();
  await createLandingPageVersion({
    id: versionId,
    landing_page_id: pageId,
    version: newVersion,
    copy_sections: page.copy_sections || '[]',
    source: 'pre-publish',
    image_slots: page.image_slots || undefined,
    cta_links: page.cta_links || undefined,
    html_template: page.html_template || undefined,
    assembled_html: page.assembled_html || undefined,
  });
  await updateLandingPage(pageId, { current_version: newVersion });

  // Prepare images
  if (sendEvent) {
    sendEvent({ type: 'phase', phase: 'images', message: 'Processing images...' });
  }
  const imageSlots = page.image_slots ? JSON.parse(page.image_slots) : [];
  const imageFiles = await prepareImages(imageSlots, sendEvent);

  // Bake final HTML
  if (sendEvent) {
    sendEvent({ type: 'phase', phase: 'baking', message: 'Baking final HTML...' });
  }
  const finalHtml = bakeFinalHtml(page, slug, imageFiles);

  // Deploy to Cloudflare
  if (sendEvent) {
    sendEvent({ type: 'phase', phase: 'deploying', message: 'Deploying to Cloudflare Pages...' });
  }
  const deployment = await deployToCloudflare(
    cfConfig.accountId,
    cfConfig.apiToken,
    cfProjectName,
    slug,
    finalHtml,
    imageFiles,
    sendEvent
  );

  // Build the published URL
  // Cloudflare Pages projects get a *.pages.dev domain
  // The custom domain mapping is handled in Cloudflare dashboard
  const publishedUrl = deployment.url
    ? `${deployment.url}/${slug}/`
    : `https://${cfProjectName}.pages.dev/${slug}/`;

  // Update landing page record
  await updateLandingPage(pageId, {
    status: 'published',
    slug,
    published_url: publishedUrl,
    published_at: new Date().toISOString(),
    final_html: finalHtml,
    hosting_metadata: JSON.stringify({
      deploymentId: deployment.deploymentId,
      cfProjectName,
      environment: deployment.environment,
      deploymentUrl: deployment.url,
      createdOn: deployment.createdOn,
    }),
  });

  return {
    published_url: publishedUrl,
    deployment,
    versionId,
    version: newVersion,
  };
}

/**
 * Unpublish a landing page — remove from Cloudflare.
 *
 * @param {string} pageId - Landing page externalId
 * @returns {boolean}
 */
export async function unpublishLandingPage(pageId) {
  const page = await getLandingPage(pageId);
  if (!page) throw new Error('Landing page not found');

  if (page.status !== 'published') {
    throw new Error('Landing page is not currently published.');
  }

  // Get hosting metadata
  let metadata = {};
  try {
    metadata = page.hosting_metadata ? JSON.parse(page.hosting_metadata) : {};
  } catch {}

  if (metadata.deploymentId && metadata.cfProjectName) {
    const cfConfig = await getCloudflareConfig();
    await deleteFromCloudflare(
      cfConfig.accountId,
      cfConfig.apiToken,
      metadata.cfProjectName,
      metadata.deploymentId
    );
  }

  // Update status
  await updateLandingPage(pageId, {
    status: 'unpublished',
  });

  return true;
}

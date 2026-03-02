/**
 * LP Template Extractor — Extract reusable templates from landing page URLs.
 *
 * Pipeline:
 * 1. Capture page via lpSwipeFetcher (Puppeteer screenshot + text extraction)
 * 2. Send screenshot to Claude Sonnet vision for structural analysis
 * 3. Parse Claude's response into skeleton_html, design_brief, slot_definitions
 * 4. Store template in lp_templates via convexClient
 *
 * The skeleton_html is a clean HTML template with {{placeholder}} slots
 * that can be filled with angle-specific copy and images.
 */

import { fetchSwipePage } from './lpSwipeFetcher.js';
import { chatWithMultipleImages } from './anthropic.js';
import { createLPTemplate, updateLPTemplate } from '../convexClient.js';
import { v4 as uuidv4 } from 'uuid';

const EXTRACTION_PROMPT = `You are a landing page template extraction expert. Analyze this landing page screenshot and text content to create a reusable template.

Your task is to produce THREE outputs:

1. **skeleton_html**: A complete, self-contained HTML page that replicates the visual layout, styling, and structure of this landing page. Replace all angle-specific content (headlines, body copy, testimonials, CTAs, product claims) with named placeholder tokens using the format {{placeholder_name}}. Keep the CSS, fonts, colors, spacing, and layout structure intact. Include these standard placeholders:
   - {{headline}} — main headline
   - {{subheadline}} — subheadline if present
   - {{body_copy}} — main body text sections
   - {{testimonial}} — testimonial blocks
   - {{cta_1_url}}, {{cta_1_text}} — CTA buttons (number sequentially)
   - {{image_1}}, {{image_1_alt}} — image slots (number sequentially)
   - Any other section-specific placeholders as needed (e.g., {{feature_list}}, {{guarantee}}, {{price}})

   The HTML must be fully self-contained with inline <style> tags. Use modern CSS (flexbox/grid). Target a max-width of 800px centered layout.

2. **design_brief**: A JSON object describing the visual design system:
   {
     "primary_color": "#hex",
     "secondary_color": "#hex",
     "background_color": "#hex",
     "text_color": "#hex",
     "accent_color": "#hex",
     "font_family": "font name",
     "heading_font": "font name",
     "overall_style": "description of visual style",
     "layout_type": "long-form | short-form | listicle | hybrid",
     "sections_order": ["hero", "problem", "solution", "features", "testimonials", "cta", ...]
   }

3. **slot_definitions**: A JSON array describing each content slot in the template:
   [
     {
       "name": "headline",
       "type": "text",
       "description": "Main attention-grabbing headline, typically 5-15 words",
       "required": true
     },
     {
       "name": "image_1",
       "type": "image",
       "description": "Hero product image",
       "suggested_size": "800x600",
       "required": true
     },
     ...
   ]

Respond with ONLY a valid JSON object in this exact format:
{
  "skeleton_html": "<!DOCTYPE html>...",
  "design_brief": { ... },
  "slot_definitions": [ ... ]
}`;

/**
 * Extract a reusable template from a landing page URL.
 *
 * @param {string} url - URL to extract template from
 * @param {string} projectId - Project externalId
 * @param {(event: object) => void} sendEvent - SSE event callback
 * @returns {object} - { templateId, name, status }
 */
export async function extractTemplate(url, projectId, sendEvent) {
  const templateId = uuidv4();

  // Create the template record in "extracting" state
  const templateName = new URL(url).hostname.replace(/^www\./, '') + ' Template';
  await createLPTemplate({
    id: templateId,
    project_id: projectId,
    source_url: url,
    name: templateName,
    skeleton_html: '',
    design_brief: '{}',
    slot_definitions: '[]',
    status: 'extracting',
  });

  try {
    // Step 1: Capture the page
    sendEvent({ type: 'progress', step: 'capture', message: 'Capturing page with headless browser...' });
    const { screenshotStorageId, textContent, screenshotBuffer } = await fetchSwipePage(url, sendEvent);

    // Step 2: Send to Claude for structural analysis
    sendEvent({ type: 'progress', step: 'analysis', message: 'Analyzing page structure with Claude...' });

    const images = [{
      base64: screenshotBuffer.toString('base64'),
      mimeType: 'image/jpeg',
    }];

    const contextText = `${EXTRACTION_PROMPT}\n\nHere is the extracted text content from the page for reference:\n\n${textContent.slice(0, 8000)}`;

    const result = await chatWithMultipleImages(
      [], // no prior messages
      contextText,
      images,
      'claude-sonnet-4-6',
      {
        response_format: { type: 'json_object' },
        costTracking: { operation: 'lp_template_extraction', projectId },
        max_tokens: 16000,
      }
    );

    // Step 3: Parse response
    sendEvent({ type: 'progress', step: 'parsing', message: 'Processing extracted template...' });

    let parsed;
    try {
      parsed = typeof result === 'string' ? JSON.parse(result) : result;
    } catch (parseErr) {
      // Try to extract JSON from the response
      const jsonMatch = (typeof result === 'string' ? result : '').match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        parsed = JSON.parse(jsonMatch[0]);
      } else {
        throw new Error('Failed to parse Claude response as JSON');
      }
    }

    const { skeleton_html, design_brief, slot_definitions } = parsed;

    if (!skeleton_html) {
      throw new Error('Claude did not return a skeleton_html');
    }

    // Step 4: Update template record with extracted data
    await updateLPTemplate(templateId, {
      skeleton_html: skeleton_html,
      design_brief: typeof design_brief === 'string' ? design_brief : JSON.stringify(design_brief || {}),
      slot_definitions: typeof slot_definitions === 'string' ? slot_definitions : JSON.stringify(slot_definitions || []),
      screenshot_storage_id: screenshotStorageId,
      status: 'ready',
    });

    sendEvent({ type: 'complete', templateId, name: templateName, status: 'ready' });

    return { templateId, name: templateName, status: 'ready' };
  } catch (err) {
    // Update template with error
    await updateLPTemplate(templateId, {
      status: 'failed',
      error_message: err.message,
    });

    sendEvent({ type: 'error', error: err.message });
    throw err;
  }
}

/**
 * LP Auto-Fixer — deterministic + LLM-powered fixes for Visual QA issues.
 *
 * Takes a QA report and the current HTML, applies targeted fixes, returns fixed HTML.
 * Execution order: deterministic fixes first (free), then LLM fixes (costs tokens).
 */

import { chat } from './anthropic.js';
import { generateImage } from './gemini.js';
import { uploadBuffer, getStorageUrl } from '../convexClient.js';
import { postProcessLP, injectContrastSafetyCSS } from './lpGenerator.js';

/**
 * Attempt to auto-fix issues identified by Visual QA.
 *
 * @param {string} html - Current assembled HTML
 * @param {object} qaReport - { issues[], autoFixable, score }
 * @param {object} context - { project, agentConfig, angle, editorialPlan, imageSlots, copySections, projectId }
 * @returns {Promise<{ html: string, fixes: Array<{type: string, method: string, description: string}> }>}
 */
export async function autoFixLP(html, qaReport, context) {
  const allFixes = [];
  let fixedHtml = html;

  const criticalIssues = (qaReport.issues || []).filter(i => i.severity === 'critical');
  const warningIssues = (qaReport.issues || []).filter(i => i.severity === 'warning');
  const allIssues = [...criticalIssues, ...warningIssues];

  if (allIssues.length === 0) {
    return { html: fixedHtml, fixes: [] };
  }

  console.log(`[LP AutoFixer] Fixing ${criticalIssues.length} critical + ${warningIssues.length} warning issues`);

  // =============================================
  // PHASE 1: DETERMINISTIC FIXES (no LLM cost)
  // =============================================

  // Fix 1: Re-run postProcessLP for placeholders + attribution issues
  const hasPlaceholderIssues = allIssues.some(i => i.type === 'placeholder_text');
  const hasAttributionIssues = allIssues.some(i => i.type === 'generic_attribution');

  if (hasPlaceholderIssues || hasAttributionIssues) {
    console.log('[LP AutoFixer] Re-running postProcessLP for placeholder/attribution fixes');
    const reprocessed = postProcessLP(fixedHtml, {
      project: context.project,
      agentConfig: context.agentConfig,
      angle: context.angle || '',
      editorialPlan: context.editorialPlan,
    });
    fixedHtml = reprocessed.html;
    if (hasPlaceholderIssues) {
      allFixes.push({ type: 'placeholder_text', method: 'deterministic_reprocess', description: 'Re-ran postProcessLP to fill/strip placeholders' });
    }
    if (hasAttributionIssues) {
      allFixes.push({ type: 'generic_attribution', method: 'deterministic_reprocess', description: 'Re-ran postProcessLP to fix generic testimonial names' });
    }
  }

  // Fix 2: Deterministic contrast scan — always runs, regardless of QA findings
  const deterministicResult = deterministicContrastFix(fixedHtml);
  fixedHtml = deterministicResult.html;
  allFixes.push(...deterministicResult.fixes);

  // Fix 3: Contrast issues from QA findings — inject CSS overrides + re-run safety CSS
  const contrastResult = fixContrast(fixedHtml, allIssues);
  fixedHtml = contrastResult.html;
  allFixes.push(...contrastResult.fixes);

  // =============================================
  // PHASE 2: LLM-POWERED FIXES (costs tokens)
  // =============================================

  // Fix 4: Broken/gray-box images — regenerate via Gemini
  try {
    const imageResult = await fixBrokenImages(fixedHtml, allIssues, context);
    fixedHtml = imageResult.html;
    allFixes.push(...imageResult.fixes);
  } catch (err) {
    console.warn('[LP AutoFixer] Image fix failed (non-fatal):', err.message);
  }

  // Fix 5: Layout/CSS issues — targeted CSS fix via Claude Sonnet
  try {
    const layoutResult = await fixLayoutCSS(fixedHtml, allIssues, context);
    fixedHtml = layoutResult.html;
    allFixes.push(...layoutResult.fixes);
  } catch (err) {
    console.warn('[LP AutoFixer] Layout CSS fix failed (non-fatal):', err.message);
  }

  console.log(`[LP AutoFixer] Applied ${allFixes.length} fixes: ${allFixes.map(f => f.type).join(', ')}`);
  return { html: fixedHtml, fixes: allFixes };
}

// ─────────────────────────────────────────────
// Fix handlers
// ─────────────────────────────────────────────

/**
 * Deterministic contrast fix — always runs, zero LLM cost.
 * Re-applies the full contrast safety CSS pipeline (injectContrastSafetyCSS)
 * which now handles inline styles, background: shorthand, AND class-based backgrounds.
 * This catches contrast issues that the initial postProcessLP pass may have missed
 * (e.g., if HTML was modified after postProcessLP ran).
 */
function deterministicContrastFix(html) {
  // Strip existing contrast safety CSS so injectContrastSafetyCSS re-evaluates from scratch
  let cleaned = html.replace(/<style[^>]*data-safety="contrast"[^>]*>[\s\S]*?<\/style>/gi, '');

  // Re-inject with the enhanced contrast safety CSS (now includes <style> block parsing)
  const fixed = injectContrastSafetyCSS(cleaned);

  const wasChanged = fixed !== html;
  const fixes = wasChanged ? [{
    type: 'contrast_failure',
    method: 'deterministic_contrast_reinject',
    description: 'Re-applied enhanced contrast safety CSS (inline + class-based backgrounds)',
  }] : [];

  if (wasChanged) {
    console.log('[LP AutoFixer] Deterministic contrast fix applied (re-injected enhanced safety CSS)');
  }

  return { html: fixed, fixes };
}

/**
 * Inject CSS overrides for contrast failures identified by Visual QA.
 * Uses selector hints from the QA report for targeted fixes,
 * plus a comprehensive safety net covering all dark background patterns.
 */
function fixContrast(html, issues) {
  const contrastIssues = issues.filter(i => i.type === 'contrast_failure');
  if (contrastIssues.length === 0) return { html, fixes: [] };

  console.log(`[LP AutoFixer] Fixing ${contrastIssues.length} contrast issue(s) from QA findings`);

  // Build targeted CSS rules from QA selector hints
  const rules = [];

  for (const issue of contrastIssues) {
    if (issue.css_selector_hint) {
      rules.push(`${issue.css_selector_hint} { color: #FFFFFF !important; text-shadow: 0 1px 2px rgba(0,0,0,0.3) !important; }`);
      rules.push(`${issue.css_selector_hint} * { color: #FFFFFF !important; }`);
      rules.push(`${issue.css_selector_hint} a { color: #FFD700 !important; }`);
    }
  }

  // Comprehensive safety net — covers all dark background patterns
  // Both background-color: and background: shorthand
  const darkHexPrefixes = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b'];
  const bgProps = ['background-color', 'background'];
  const safetySelectors = [];
  const safetyChildSelectors = [];

  for (const prop of bgProps) {
    for (const p of darkHexPrefixes) {
      safetySelectors.push(`[style*="${prop}: #${p}"]`);
      safetyChildSelectors.push(`[style*="${prop}: #${p}"] *`);
    }
  }

  rules.push(`/* Comprehensive dark background safety net */`);
  rules.push(`${safetySelectors.join(', ')} { color: #FFFFFF !important; }`);
  rules.push(`${safetyChildSelectors.join(', ')} { color: #FFFFFF !important; }`);

  const styleBlock = `<style data-autofix="contrast">\n${rules.join('\n')}\n</style>`;
  let fixed;
  if (html.includes('</head>')) {
    fixed = html.replace('</head>', `${styleBlock}\n</head>`);
  } else {
    fixed = styleBlock + html;
  }

  return {
    html: fixed,
    fixes: contrastIssues.map(i => ({
      type: 'contrast_failure',
      method: 'css_injection',
      description: `Fixed contrast at ${i.css_selector_hint || i.location || 'unknown'}`,
    })),
  };
}

/**
 * Regenerate broken/gray-box images via Gemini.
 */
async function fixBrokenImages(html, issues, context) {
  const imageIssues = issues.filter(i =>
    i.type === 'gray_box_image' || i.type === 'broken_image'
  );
  if (imageIssues.length === 0) return { html, fixes: [] };

  console.log(`[LP AutoFixer] Regenerating ${imageIssues.length} broken image(s)`);

  let fixedHtml = html;
  const fixes = [];
  const imageSlots = context.imageSlots || [];

  for (const issue of imageIssues) {
    // Try to find which image slot corresponds to this issue
    const slotIndex = findMatchingSlot(issue, imageSlots);
    if (slotIndex === -1) {
      console.warn(`[LP AutoFixer] Could not match image issue to slot: ${issue.location}`);
      continue;
    }

    const slot = imageSlots[slotIndex];
    const prompt = `Create a professional, high-quality photograph: ${slot.description || issue.fix_suggestion || issue.location}. ${context.angle ? `Marketing context: ${context.angle}.` : ''} Style: photorealistic, commercial photography, well-lit, clean composition.`;

    try {
      const { imageBuffer, mimeType } = await generateImage(prompt, '16:9', null, {
        projectId: context.projectId,
        operation: 'lp_autofix_image',
      });

      const storageId = await uploadBuffer(imageBuffer, mimeType);
      const storageUrl = await getStorageUrl(storageId);

      // Replace old URL in HTML
      if (slot.storageUrl && storageUrl) {
        fixedHtml = fixedHtml.replaceAll(slot.storageUrl, storageUrl);
        // Update the slot reference for future passes
        slot.storageUrl = storageUrl;
        slot.storageId = storageId;
        fixes.push({
          type: issue.type,
          method: 'image_regeneration',
          description: `Regenerated image for ${issue.location || slot.slot_id}`,
        });
      }
    } catch (err) {
      console.warn(`[LP AutoFixer] Image regen failed for slot ${slot.slot_id}: ${err.message}`);
    }
  }

  return { html: fixedHtml, fixes };
}

/**
 * Match an image issue to an image slot by location hint.
 */
function findMatchingSlot(issue, imageSlots) {
  if (!imageSlots || imageSlots.length === 0) return -1;

  const loc = (issue.location || '').toLowerCase();
  const hint = (issue.css_selector_hint || '').toLowerCase();

  // Try to match by slot number from CSS hint (e.g., "image_1", "img:nth-child(2)")
  const numMatch = hint.match(/image[_-]?(\d+)/) || hint.match(/nth-child\((\d+)\)/) || loc.match(/image\s*(\d+)/i);
  if (numMatch) {
    const num = parseInt(numMatch[1], 10);
    const idx = imageSlots.findIndex(s => s.slot_id === `image_${num}`);
    if (idx !== -1) return idx;
    // Fall back to index
    if (num - 1 < imageSlots.length) return num - 1;
  }

  // Match by location keywords
  if (loc.includes('hero') || loc.includes('top') || loc.includes('first')) {
    return 0;
  }
  if (loc.includes('second') || loc.includes('middle')) {
    return Math.min(1, imageSlots.length - 1);
  }
  if (loc.includes('third') || loc.includes('bottom') || loc.includes('last')) {
    return imageSlots.length - 1;
  }

  // Default to first slot if we can't determine
  return imageSlots.length > 0 ? 0 : -1;
}

/**
 * Fix layout/CSS issues via Claude Sonnet.
 * Generates a targeted <style> block, not a full HTML rewrite.
 */
async function fixLayoutCSS(html, issues, context) {
  const layoutIssues = issues.filter(i =>
    i.type === 'layout_overlap' || i.type === 'empty_section' ||
    i.type === 'typography_mismatch' || i.type === 'cta_broken'
  );
  if (layoutIssues.length === 0) return { html, fixes: [] };

  console.log(`[LP AutoFixer] Fixing ${layoutIssues.length} layout/CSS issue(s) via Claude Sonnet`);

  const issueDescriptions = layoutIssues.map(i =>
    `- ${i.type}: ${i.description} (at: ${i.location || 'unknown'}, selector: ${i.css_selector_hint || 'unknown'}). Fix: ${i.fix_suggestion || 'Fix the issue'}`
  ).join('\n');

  const response = await chat([
    {
      role: 'user',
      content: `Fix the following CSS/layout issues in a landing page. Output ONLY a <style data-autofix="layout">...</style> block with CSS rules. No explanation, no other HTML.

ISSUES TO FIX:
${issueDescriptions}

RULES:
- Only output a single <style data-autofix="layout">...</style> tag
- Use !important on all rules to override inline styles
- Ensure all text is readable (minimum 14px body text)
- Ensure adequate spacing between sections
- If text is on a dark background, make it white. If on light, make it dark.
- Do NOT output any HTML elements, only CSS rules inside a style tag`
    }
  ], 'claude-sonnet-4-6', {
    operation: 'lp_autofix_css',
    projectId: context.projectId,
  });

  // Extract <style> block from response
  const styleMatch = response.match(/<style[^>]*data-autofix[^>]*>[\s\S]*?<\/style>/i);
  if (!styleMatch) {
    console.warn('[LP AutoFixer] Claude did not return a valid <style> block');
    return { html, fixes: [] };
  }

  let fixed;
  if (html.includes('</head>')) {
    fixed = html.replace('</head>', `${styleMatch[0]}\n</head>`);
  } else {
    fixed = styleMatch[0] + html;
  }

  return {
    html: fixed,
    fixes: layoutIssues.map(i => ({
      type: i.type,
      method: 'llm_css_fix',
      description: `CSS fix for ${i.description}`,
    })),
  };
}

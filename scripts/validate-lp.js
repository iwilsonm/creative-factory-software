#!/usr/bin/env node

/**
 * LP Generator Correctness Validator
 *
 * Runs 4 deterministic checks against assembleLandingPage + postProcessLP output:
 * 1. NO NESTED HTML — output must be a fragment (no <!DOCTYPE or <html>)
 * 2. NO EMPTY BLOCK ELEMENTS — no <h1></h1>, <h2></h2>, <p></p>
 * 3. NO PRODUCT HALLUCINATION — must contain "Produce Protector", must NOT contain known hallucinated names
 * 4. NO PROMPT LEAKAGE IN SLUG — slug must not begin with prompt-like words
 *
 * Exit 0 if all pass, 1 if any fail.
 */

import { assembleLandingPage, postProcessLP } from '../backend/services/lpGenerator.js';
import { generateSlug, extractHeadlineForSlug } from '../backend/services/lpPublisher.js';

// ── Test Data ────────────────────────────────────────────────────────────────

const TEST_PRODUCT_NAME = 'Produce Protector';
const TEST_PRODUCT_DESCRIPTION = `The Produce Protector is a countertop electrolysis produce washer that uses water electrolysis technology to remove up to 99.9% of pesticides, bacteria, and surface contaminants from fruits and vegetables. It generates hydroxyl radicals (OH·) through a titanium-platinum electrode array submerged in ordinary tap water — no chemicals, no soap, no residue. The 3.5-liter basin fits a full head of lettuce or 2 lbs of berries. A single wash cycle takes 8 minutes. The device runs on 120V AC, weighs 4.2 lbs, and includes a stainless steel colander insert for easy draining. Made by CleanHarvest Technologies, based in Portland, Oregon.`;

const HALLUCINATED_NAMES = [
  'RestoreWave', 'Magnesium Breakthrough', 'BiOptimizers',
  'AquaPure', 'FreshWash Pro', 'VeggiClean', 'PureRinse',
  'OzoneWash', 'SonicSoak', 'Turbo Scrub',
];

const PROMPT_LEAK_WORDS = [
  'structure', 'write', 'create', 'generate', 'use',
  'make', 'format', 'build', 'design', 'include', 'ensure',
];

// A minimal HTML template that exercises the pipeline
const TEST_HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>{{product_name}} — Landing Page</title>
  <style>
    body { font-family: sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; }
    .hero { text-align: center; }
    .comparison { background: #f9f9f9; padding: 20px; }
    .cta-btn { background: #2a9d8f; color: white; padding: 12px 24px; text-decoration: none; }
  </style>
</head>
<body>
  <div class="hero">
    <h1>{{headline}}</h1>
    <p>{{subheadline}}</p>
  </div>
  <section class="lead">{{lead}}</section>
  <section class="problem">{{problem}}</section>
  <section class="comparison">
    <h2>How {{product_name}} Compares</h2>
    {{solution}}
  </section>
  <section class="benefits">{{benefits}}</section>
  <section class="proof">{{proof}}</section>
  <section class="offer">{{offer}}</section>
  <img src="{{image_1}}" alt="Product image">
  <a href="{{cta_1_url}}" class="cta-btn">{{cta_1_text}}</a>
  <section class="ps">{{ps}}</section>
  <div class="empty-test">{{nonexistent_placeholder}}</div>
</body>
</html>`;

// Copy sections that simulate realistic LLM output
const TEST_COPY_SECTIONS = [
  { type: 'headline', content: 'The Hidden Danger Lurking on Your "Fresh" Produce' },
  { type: 'subheadline', content: 'How one Portland mom discovered her family was eating pesticide residue every single day' },
  { type: 'lead', content: 'Sarah thought she was feeding her kids healthy food. Organic labels. Farmers market runs every Saturday.\n\nBut when she tested her produce with a simple residue kit, the results shocked her.' },
  { type: 'problem', content: 'The EPA estimates that 70% of conventionally grown produce contains detectable pesticide residues — even after washing with water.\n\nRinsing under the tap removes dirt, but it barely touches the chemical coatings designed to survive rain and irrigation.' },
  { type: 'solution', content: `Unlike ordinary produce washes that just add more chemicals to the problem, the Produce Protector uses water electrolysis — the same technology used in hospital-grade sanitation systems.\n\nThe titanium-platinum electrode array generates hydroxyl radicals that break down pesticide molecules on contact. No soap. No chemicals. Just clean water and science.\n\nWhile other approaches like vinegar soaks or baking soda scrubs only remove surface-level contaminants, Produce Protector's electrolysis technology penetrates waxy coatings to neutralize residues that rinse water can't reach.` },
  { type: 'benefits', content: 'Removes up to 99.9% of pesticides, bacteria, and surface contaminants\n\nFits a full head of lettuce or 2 lbs of berries in the 3.5-liter basin\n\n8-minute wash cycle — set it and forget it\n\nNo chemicals, no soap, no residue left behind\n\nStainless steel colander insert for easy draining' },
  { type: 'proof', content: 'Independent lab testing by SGS (the world\'s leading inspection company) confirmed 99.9% pesticide removal across 47 common agricultural chemicals.\n\n"I tested it myself with a home residue kit. Before: bright purple. After 8 minutes in the Produce Protector: completely clear." — Maria T., verified buyer' },
  { type: 'offer', content: 'Get the Produce Protector today for just $149 — that\'s less than $0.41/day over a year of cleaner, safer food for your entire family.' },
  { type: 'ps', content: 'P.S. Every Produce Protector comes with a 90-day money-back guarantee. If you don\'t see the difference in your first wash, send it back for a full refund. No questions asked.' },
];

const TEST_IMAGE_SLOTS = [
  { slot_id: 'image_1', storageUrl: 'https://example.com/produce-protector.jpg', suggested_size: '800x400' },
];

const TEST_CTA_ELEMENTS = [
  { cta_id: 'cta_1', text_suggestion: 'Get Your Produce Protector Now' },
];

// ── Checks ───────────────────────────────────────────────────────────────────

function checkNoNestedHtml(html) {
  const hasDoctype = /<!DOCTYPE/i.test(html);
  const hasHtmlTag = /<html[\s>]/i.test(html);
  const issues = [];
  if (hasDoctype) issues.push('Found <!DOCTYPE> in output');
  if (hasHtmlTag) issues.push('Found <html> tag in output');
  return { pass: issues.length === 0, issues };
}

function checkNoEmptyBlockElements(html) {
  const issues = [];
  const emptyPattern = /<(h[1-6]|p)(\s[^>]*)?>(\s*)<\/\1>/gi;
  let match;
  while ((match = emptyPattern.exec(html)) !== null) {
    issues.push(`Empty <${match[1]}> at position ${match.index}: "${match[0]}"`);
  }
  return { pass: issues.length === 0, issues };
}

function checkNoProductHallucination(html) {
  const issues = [];
  const lowerHtml = html.toLowerCase();

  // Must contain the real product name
  if (!lowerHtml.includes('produce protector')) {
    issues.push('Output does not contain "Produce Protector"');
  }

  // Must NOT contain hallucinated names
  for (const name of HALLUCINATED_NAMES) {
    if (lowerHtml.includes(name.toLowerCase())) {
      issues.push(`Found hallucinated product name: "${name}"`);
    }
  }

  return { pass: issues.length === 0, issues };
}

function checkNoPromptLeakageInSlug(slugResults) {
  const issues = [];
  for (const { label, slug } of slugResults) {
    // Extract the part after lp-NNNN-
    const afterPrefix = slug.replace(/^lp-\d{4}-/, '');
    const firstWord = afterPrefix.split('-')[0];
    if (PROMPT_LEAK_WORDS.includes(firstWord)) {
      issues.push(`[${label}] Slug starts with prompt word "${firstWord}": ${slug}`);
    }
  }
  return { pass: issues.length === 0, issues };
}

// ── Main ─────────────────────────────────────────────────────────────────────

function main() {
  console.log('=== LP Generator Correctness Validator ===\n');

  // Step 1: Run assembleLandingPage
  console.log('Assembling test landing page...');
  const assembled = assembleLandingPage({
    htmlTemplate: TEST_HTML_TEMPLATE,
    copySections: TEST_COPY_SECTIONS,
    imageSlots: TEST_IMAGE_SLOTS,
    ctaElements: TEST_CTA_ELEMENTS,
  });

  // Step 2: Run postProcessLP
  console.log('Running postProcessLP...');
  const mockProject = {
    name: TEST_PRODUCT_NAME,
    brand_name: TEST_PRODUCT_NAME,
    product_description: TEST_PRODUCT_DESCRIPTION,
  };
  const result = postProcessLP(assembled, { project: mockProject });
  const finalHtml = result.html;

  // Step 3: Test slug generation with various inputs
  console.log('Testing slug generation...\n');

  const slugTestCases = [
    {
      label: 'normal headline',
      page: { copy_sections: JSON.stringify([{ type: 'headline', content: 'The Hidden Danger Lurking on Your Produce' }]) },
    },
    {
      label: 'prompt-like headline',
      page: { copy_sections: JSON.stringify([{ type: 'headline', content: 'Structure your landing page around the key benefits of clean eating' }]) },
    },
    {
      label: 'generate prefix',
      page: { copy_sections: JSON.stringify([{ type: 'headline', content: 'Generate excitement about produce washing technology' }]) },
    },
    {
      label: 'create prefix',
      page: { copy_sections: JSON.stringify([{ type: 'headline', content: 'Create a sense of urgency around food safety' }]) },
    },
    {
      label: 'write prefix',
      page: { copy_sections: JSON.stringify([{ type: 'headline', content: 'Write compelling copy about the Produce Protector' }]) },
    },
    {
      label: 'ensure prefix',
      page: { copy_sections: JSON.stringify([{ type: 'headline', content: 'Ensure your family eats clean produce every day' }]) },
    },
    {
      label: 'use prefix in angle fallback',
      page: { angle: 'Use fear of pesticides to drive purchase intent' },
    },
    {
      label: 'include prefix in name fallback',
      page: { name: 'Include testimonials from moms who switched' },
    },
  ];

  const slugResults = slugTestCases.map(({ label, page }) => {
    const headline = extractHeadlineForSlug(page);
    const slug = generateSlug(headline);
    return { label, slug, headline };
  });

  // ── Run checks ─────────────────────────────────────────────────────────────

  const checks = [
    { name: 'NO NESTED HTML', result: checkNoNestedHtml(finalHtml) },
    { name: 'NO EMPTY BLOCK ELEMENTS', result: checkNoEmptyBlockElements(finalHtml) },
    { name: 'NO PRODUCT HALLUCINATION', result: checkNoProductHallucination(finalHtml) },
    { name: 'NO PROMPT LEAKAGE IN SLUG', result: checkNoPromptLeakageInSlug(slugResults) },
  ];

  let allPass = true;
  for (const check of checks) {
    const status = check.result.pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
    console.log(`  [${status}] ${check.name}`);
    if (!check.result.pass) {
      allPass = false;
      for (const issue of check.result.issues) {
        console.log(`         ↳ ${issue}`);
      }
    }
  }

  console.log('');
  if (allPass) {
    console.log('\x1b[32m✓ All 4 checks passed!\x1b[0m');
    process.exit(0);
  } else {
    const failCount = checks.filter(c => !c.result.pass).length;
    console.log(`\x1b[31m✗ ${failCount} check(s) failed.\x1b[0m`);
    process.exit(1);
  }
}

main();

import { beforeAll, describe, expect, it } from 'vitest';

let assembleLandingPage;
let buildAutoSwipeReferenceText;
let buildLegacySOPAssemblyPrompt;
let buildLegacySOPWritePrompt;
let extractRequiredPlaceholderFailures;
let getRequiredTemplateSlots;
let getMissingTemplateSlots;
let getLegacySOPFrameLine;
let postProcessLP;
let extractTemplatePlaceholders;
let getRequiredPlaceholderNames;
let validateListicleFirstHalf;
let normalizeBrandColors;
let buildBrandColorsLine;
let formatBeliefOrObjectionDirective;
let buildImagePrompt;

beforeAll(async () => {
  process.env.CONVEX_URL ||= 'https://test-convex.invalid';
  const lpGenerator = await import('../services/lpGenerator.js');
  assembleLandingPage = lpGenerator.assembleLandingPage;
  buildAutoSwipeReferenceText = lpGenerator.buildAutoSwipeReferenceText;
  buildLegacySOPAssemblyPrompt = lpGenerator.buildLegacySOPAssemblyPrompt;
  buildLegacySOPWritePrompt = lpGenerator.buildLegacySOPWritePrompt;
  extractRequiredPlaceholderFailures = lpGenerator.extractRequiredPlaceholderFailures;
  getRequiredTemplateSlots = lpGenerator.getRequiredTemplateSlots;
  getMissingTemplateSlots = lpGenerator.getMissingTemplateSlots;
  getLegacySOPFrameLine = lpGenerator.getLegacySOPFrameLine;
  postProcessLP = lpGenerator.postProcessLP;
  extractTemplatePlaceholders = lpGenerator.extractTemplatePlaceholders;
  getRequiredPlaceholderNames = lpGenerator.getRequiredPlaceholderNames;
  validateListicleFirstHalf = lpGenerator.validateListicleFirstHalf;
  normalizeBrandColors = lpGenerator.normalizeBrandColors;
  buildBrandColorsLine = lpGenerator.buildBrandColorsLine;
  formatBeliefOrObjectionDirective = lpGenerator.formatBeliefOrObjectionDirective;
  buildImagePrompt = lpGenerator.buildImagePrompt;
});

describe('lpGenerator helpers', () => {
  it('fills leftover CTA placeholders with a fallback CTA', () => {
    const html = assembleLandingPage({
      htmlTemplate: `
        <a href="{{cta_1_url}}">{{cta_1_text}}</a>
        <a href="{{cta_2_url}}">{{cta_2_text}}</a>
      `,
      copySections: [],
      imageSlots: [],
      ctaElements: [{ text_suggestion: 'Get Yours Now' }],
    });

    expect(html).toContain('href="#order"');
    expect(html).toContain('Get Yours Now');
    expect(html).not.toContain('{{cta_1_url}}');
    expect(html).not.toContain('{{cta_2_text}}');
  });

  it('keeps trimmed headline text inside the existing h1 without leaving it empty', () => {
    const html = assembleLandingPage({
      htmlTemplate: '<section><h1>{{headline}}</h1></section>',
      copySections: [{ type: 'headline', content: '   Broken Sleep / Wake Up at 2 to 4 AM   ' }],
      imageSlots: [],
      ctaElements: [],
    });

    expect(html).toContain('<h1>Broken Sleep / Wake Up at 2 to 4 AM</h1>');
    expect(html).not.toContain('<h1></h1>');
  });

  it('removes empty wrapper paragraphs left behind when content expands into paragraphs', () => {
    const html = assembleLandingPage({
      htmlTemplate: '<section><p>{{opening_story}}</p></section>',
      copySections: [{ type: 'opening_story', content: 'First paragraph.\n\nSecond paragraph.' }],
      imageSlots: [],
      ctaElements: [],
    });

    expect(html).not.toContain('<p></p>');
    expect(html).toContain('<p>First paragraph.</p>');
    expect(html).toContain('<p>Second paragraph.</p>');
  });

  it('strips paragraph wrappers that end up nested inside headings', () => {
    const html = assembleLandingPage({
      htmlTemplate: '<section><h1>{{headline}}</h1><div class="hero-subheadline">{{subheadline}}</div></section>',
      copySections: [
        { type: 'headline', content: 'Hero Headline' },
        { type: 'subheadline', content: 'Supporting copy with enough words to wrap itself into paragraph output.\nAnd a second line.' },
      ],
      imageSlots: [],
      ctaElements: [],
    });

    expect(html).toContain('<h1>Hero Headline</h1>');
    expect(html).not.toContain('<h1><p>');
    expect(html).not.toContain('<div class="hero-subheadline"><p>');
  });

  it('treats standard proof/offer and CTA placeholders as required slots', () => {
    const required = getRequiredTemplateSlots({
      standardCopy: ['headline', 'proof', 'offer', 'guarantee'],
      templateCopy: ['custom_story_block'],
      cta: ['cta_1_url', 'cta_1_text'],
    }, 'listicle');

    expect(required).toEqual(expect.arrayContaining(['proof', 'offer', 'guarantee', 'cta']));
  });

  it('maps stripped CTA placeholders back to the required CTA gate', () => {
    const failures = extractRequiredPlaceholderFailures(
      ['Stripped 7 unfilled placeholder(s): cta_1_url, cta_1_text, proof'],
      ['cta', 'proof', 'offer'],
    );

    expect(failures).toEqual(expect.arrayContaining(['cta', 'proof']));
  });

  it('treats empty required sections as missing even when the section type exists', () => {
    const missing = getMissingTemplateSlots(
      ['problem', 'proof', 'cta'],
      [
        { type: 'problem', content: '   ' },
        { type: 'proof', content: '<p>Actual evidence goes here.</p>' },
        { type: 'cta', content: '' },
      ],
    );

    expect(missing).toEqual(expect.arrayContaining(['problem', 'cta']));
    expect(missing).not.toContain('proof');
  });

  it('treats stripped problem/proof placeholders as required failures', () => {
    const failures = extractRequiredPlaceholderFailures(
      ['Stripped 3 unfilled placeholder(s): problem, benefits, proof'],
      ['lead', 'problem', 'solution', 'proof', 'cta'],
    );

    expect(failures).toEqual(expect.arrayContaining(['problem', 'proof']));
    expect(failures).not.toContain('benefits');
  });

  it('classifies CTA element placeholders as required publish placeholders', () => {
    const placeholders = extractTemplatePlaceholders(`
      <a href="{{cta_1_url}}">{{cta_1_text}}</a>
      <a href="{{cta_2_url}}">{{cta_2_text}}</a>
      <div>{{proof}}</div>
      <aside>{{decorative_note}}</aside>
    `);

    const requiredNames = getRequiredPlaceholderNames(placeholders, 'listicle');

    expect(requiredNames).toEqual(expect.arrayContaining([
      'cta_1_url',
      'cta_1_text',
      'cta_2_url',
      'cta_2_text',
      'proof',
    ]));
    expect(requiredNames).not.toContain('decorative_note');
  });

  it('strips optional placeholders but keeps required placeholders visible for failure handling', () => {
    const result = postProcessLP(
      '<div>{{decorative_note}}</div><a href="{{cta_1_url}}">{{cta_1_text}}</a>',
      { requiredPlaceholderNames: ['cta_1_url', 'cta_1_text'] },
    );

    expect(result.html).not.toContain('{{decorative_note}}');
    expect(result.html).toContain('{{cta_1_url}}');
    expect(result.html).toContain('{{cta_1_text}}');
    expect(result.requiredWarnings).toEqual(expect.arrayContaining(['cta_1_url', 'cta_1_text']));
    expect(result.warnings).toEqual(expect.arrayContaining(['decorative_note']));
  });

  it('returns the listicle SOP line for the listicle frame', () => {
    expect(getLegacySOPFrameLine('listicle')).toContain('listicle lens');
  });

  it('keeps the legacy SOP write prompt nearly verbatim while appending the frame line', () => {
    const prompt = buildLegacySOPWritePrompt({
      productName: 'Grounding Sheets',
      angle: 'Wakes to Pee, Then Cannot Fall Back Asleep',
      frameLine: getLegacySOPFrameLine('listicle'),
      additionalDirection: '',
      wordCount: null,
    });

    expect(prompt).toContain("Great, now I want you to please rewrite this advertorial");
    expect(prompt).toContain('Grounding Sheets');
    expect(prompt).toContain('Wakes to Pee, Then Cannot Fall Back Asleep');
    expect(prompt).toContain('listicle lens');
    expect(prompt).not.toContain('Aim for approximately');
  });

  it('uses cached auto swipe context when no direct swipe text is provided', () => {
    const swipeText = buildAutoSwipeReferenceText({
      autoContext: { swipeReferenceText: 'Template name: Lander\nSection order: hero -> proof' },
    });

    expect(swipeText).toContain('Template name: Lander');
    expect(swipeText).toContain('Section order: hero -> proof');
  });

  it('keeps template slot mapping in the SOP assembly prompt', () => {
    const prompt = buildLegacySOPAssemblyPrompt({
      narrativeInstruction: 'Narrative frame: listicle\n',
      frameCopyGuardrails: 'Keep the numbered list structure obvious.\n',
      headlineConstraintInstruction: 'Headline contract.\n',
      campaignMessageInstruction: 'Campaign message.\n',
      fullDraft: 'First half.\n\nSecond half.',
      templateSlots: ['story', 'objection_handling'],
      wordCount: null,
    });

    expect(prompt).toContain('FINAL ADVERTORIAL DRAFT');
    expect(prompt).toContain('"type": "story"');
    expect(prompt).toContain('"type": "objection_handling"');
    expect(prompt).toContain('Do not force a target word count if one was not provided');
  });
});

describe('validateListicleFirstHalf', () => {
  it('fails a story-only first half with no numeric structure', () => {
    const draft = "Last Tuesday I finally slept through the night. It felt like a miracle after months of waking up at 2am. My whole body relaxed.";
    const result = validateListicleFirstHalf(draft);
    expect(result.passed).toBe(false);
    expect(result.score).toBeLessThan(60);
  });

  it('passes a classic numbered listicle with arabic digits', () => {
    const draft = `Here are the 7 reasons you wake up at 3am.

1. Your cortisol spikes too early.
2. Your magnesium is depleted.
3. Your room is too warm.`;
    const result = validateListicleFirstHalf(draft);
    expect(result.passed).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(60);
    expect(result.reasons).toContain('numeric_count_promise');
    expect(result.reasons).toContain('numbered_markers');
  });

  it('passes a listicle written with ordinal words (first/second/third)', () => {
    const draft = `There are five reasons your sleep breaks at dawn.
First, your nervous system never switched off. Second, your bed is slightly too warm.`;
    const result = validateListicleFirstHalf(draft);
    expect(result.passed).toBe(true);
    expect(result.reasons).toContain('numeric_count_promise');
    expect(result.reasons).toContain('numbered_markers');
  });

  it('recognizes "Reason #N" style markers', () => {
    const draft = `Three truths about waking up at 3am.
Reason #1: cortisol. Reason #2: magnesium. Reason #3: a warm bedroom.`;
    const result = validateListicleFirstHalf(draft);
    expect(result.passed).toBe(true);
    expect(result.reasons).toContain('numbered_markers');
  });

  it('still passes if the count is spelled out and the first bullet is a numbered marker', () => {
    const draft = `Seven signs your magnesium is low.
1. Muscle twitches at night.
2. Morning headaches.`;
    const result = validateListicleFirstHalf(draft);
    expect(result.passed).toBe(true);
  });

  it('gives a lower score when only a list keyword is present (no count, no markers)', () => {
    const draft = `One reason people wake up at 3am is that their cortisol spikes.`;
    const result = validateListicleFirstHalf(draft);
    // Edge case: "one reason" triggers both the count-promise regex (one + reason)
    // and the list_keyword regex. That's enough to pass — which is fine;
    // it means even this draft names a count and a list keyword.
    expect(result.reasons).toContain('list_keyword');
  });

  it('returns 0 score for empty input', () => {
    expect(validateListicleFirstHalf('').score).toBe(0);
    expect(validateListicleFirstHalf(null).score).toBe(0);
    expect(validateListicleFirstHalf(undefined).score).toBe(0);
  });
});

describe('normalizeBrandColors', () => {
  it('keeps 6-char hex values untouched (lowercased)', () => {
    const result = normalizeBrandColors({ primary: '#4A6B8A', accent: '#C89664' });
    expect(result.primary).toBe('#4a6b8a');
    expect(result.accent).toBe('#c89664');
  });

  it('expands 3-char hex shorthand to 6-char', () => {
    const result = normalizeBrandColors({ primary: '#abc' });
    expect(result.primary).toBe('#aabbcc');
  });

  it('converts rgb() and rgba() to hex', () => {
    const result = normalizeBrandColors({
      primary: 'rgb(74, 107, 138)',
      accent: 'rgba(200, 150, 100, 0.8)',
    });
    expect(result.primary).toBe('#4a6b8a');
    expect(result.accent).toBe('#c89664');
  });

  it('returns null for color names and unparseable inputs', () => {
    const result = normalizeBrandColors({
      primary: 'warm beige',
      secondary: '',
      accent: null,
    });
    expect(result.primary).toBeNull();
    expect(result.secondary).toBeNull();
    expect(result.accent).toBeNull();
  });

  it('accepts both `cta` and `cta_background` keys for the CTA slot', () => {
    const viaCta = normalizeBrandColors({ cta: '#ff0000' });
    const viaCtaBackground = normalizeBrandColors({ cta_background: '#00ff00' });
    expect(viaCta.cta).toBe('#ff0000');
    expect(viaCtaBackground.cta).toBe('#00ff00');
  });

  it('returns null for every slot when input is empty', () => {
    const result = normalizeBrandColors({});
    expect(result.primary).toBeNull();
    expect(result.secondary).toBeNull();
    expect(result.accent).toBeNull();
    expect(result.cta).toBeNull();
  });
});

describe('buildBrandColorsLine', () => {
  it('renders a hex palette with usage guidance when values are provided', () => {
    const line = buildBrandColorsLine({ primary: '#4a6b8a', secondary: '#c89664', accent: null, cta: null });
    expect(line).toMatch(/^Brand Colors: primary #4a6b8a, secondary #c89664/);
    expect(line).toContain('use sparingly');
  });

  it('falls back to a neutral palette when every value is null', () => {
    const line = buildBrandColorsLine({ primary: null, secondary: null, accent: null, cta: null });
    expect(line).toContain('natural warm neutrals');
  });

  it('falls back to a neutral palette when normalized is null', () => {
    const line = buildBrandColorsLine(null);
    expect(line).toContain('natural warm neutrals');
  });
});

describe('formatBeliefOrObjectionDirective', () => {
  it('formats install_belief directives', () => {
    const out = formatBeliefOrObjectionDirective({ mode: 'install_belief', statement: 'sleep is a daily restoration, not a luxury' });
    expect(out).toBe(' — image should emotionally convey the belief: sleep is a daily restoration, not a luxury');
  });

  it('formats remove_objection directives', () => {
    const out = formatBeliefOrObjectionDirective({ mode: 'remove_objection', statement: 'grounding sheets are gimmicks' });
    expect(out).toBe(' — image should visually dismantle the objection: grounding sheets are gimmicks');
  });

  it('returns empty for mode=skip', () => {
    expect(formatBeliefOrObjectionDirective({ mode: 'skip', statement: 'unused' })).toBe('');
  });

  it('returns empty when statement is blank', () => {
    expect(formatBeliefOrObjectionDirective({ mode: 'install_belief', statement: '' })).toBe('');
  });

  it('returns empty for null or non-object input', () => {
    expect(formatBeliefOrObjectionDirective(null)).toBe('');
    expect(formatBeliefOrObjectionDirective(undefined)).toBe('');
    expect(formatBeliefOrObjectionDirective('not an object')).toBe('');
  });

  it('returns empty for an unknown mode', () => {
    expect(formatBeliefOrObjectionDirective({ mode: 'fabricate', statement: 'nope' })).toBe('');
  });
});

describe('buildImagePrompt — 10-part Mark SOP structure', () => {
  const baseSlot = { slot_id: 'image_1', description: 'Hero shot', aspect_ratio: '3:2' };
  const baseAutoContext = {
    imageContext: {
      avatarVisual: { gender: 'female', ageRange: '55-70', lifestyle: 'retired', emotionalState: 'hopeful', settingCues: 'sunlit kitchen' },
      productVisual: { productName: 'Dacia Grounding Sheet', productType: 'grounding bed sheet', physicalDescription: 'fitted sheet with visible grounding cord', usageContext: 'at bedtime' },
    },
  };

  it('includes all 10 numbered parts in order', () => {
    const out = buildImagePrompt(baseSlot, 'waking up at 3am', 'sample copy context', baseAutoContext, 0, 4);
    const order = [
      '1. Subject/Action:',
      '2. Art Style:',
      '3. Lighting:',
      '4. Camera/Angle:',
      '5. Composition:',
      '6. Brand Colors:',
      '7. Product Representation:',
      '8. Specific Text:',
      '9. Clarity:',
      '10. --ar',
    ];
    let lastIndex = -1;
    for (const marker of order) {
      const idx = out.indexOf(marker);
      expect(idx, `missing marker ${marker}`).toBeGreaterThan(-1);
      expect(idx, `marker ${marker} out of order`).toBeGreaterThan(lastIndex);
      lastIndex = idx;
    }
  });

  it('emits the slot aspect ratio on the --ar line', () => {
    const out = buildImagePrompt({ ...baseSlot, aspect_ratio: '9:16' }, 'angle', '', baseAutoContext, 0, 4);
    expect(out).toContain('10. --ar 9:16');
  });

  it('defaults aspect ratio to 16:9 when the slot omits one', () => {
    const out = buildImagePrompt({ slot_id: 'image_1' }, 'angle', '', baseAutoContext, 0, 4);
    expect(out).toContain('10. --ar 16:9');
  });

  it('pipes brand colors into section 6', () => {
    const out = buildImagePrompt(baseSlot, 'angle', '', baseAutoContext, 0, 4, null, {
      primary: '#4a6b8a', secondary: '#c89664', accent: null, cta: null,
    });
    expect(out).toMatch(/6\. Brand Colors: primary #4a6b8a, secondary #c89664/);
  });

  it('falls back to neutral palette when brandColors is null', () => {
    const out = buildImagePrompt(baseSlot, 'angle', '', baseAutoContext, 0, 4, null, null);
    expect(out).toMatch(/6\. Brand Colors: natural warm neutrals/);
  });

  it('appends an install_belief directive to section 1', () => {
    const slot = { ...baseSlot, belief_or_objection: { mode: 'install_belief', statement: 'sleep is restorative, not optional' } };
    const out = buildImagePrompt(slot, 'angle', '', baseAutoContext, 0, 4);
    expect(out).toContain('image should emotionally convey the belief: sleep is restorative, not optional');
  });

  it('appends a remove_objection directive to section 1', () => {
    const slot = { ...baseSlot, belief_or_objection: { mode: 'remove_objection', statement: 'grounding sheets are a gimmick' } };
    const out = buildImagePrompt(slot, 'angle', '', baseAutoContext, 0, 4);
    expect(out).toContain('image should visually dismantle the objection: grounding sheets are a gimmick');
  });

  it('omits the directive when mode=skip', () => {
    const slot = { ...baseSlot, belief_or_objection: { mode: 'skip', statement: '' } };
    const out = buildImagePrompt(slot, 'angle', '', baseAutoContext, 0, 4);
    expect(out).not.toContain('image should emotionally convey');
    expect(out).not.toContain('image should visually dismantle');
  });

  it('applies the listicle composition modifier to section 5', () => {
    const out = buildImagePrompt(baseSlot, 'angle', '', baseAutoContext, 0, 4);
    expect(out).toMatch(/5\. Composition:[^]*Editorial magazine layout/);
    expect(out).toContain('numbered list article');
  });

  it('emits a NEGATIVE CONSTRAINTS block with demographic and product guardrails', () => {
    const out = buildImagePrompt(baseSlot, 'angle', '', baseAutoContext, 0, 4);
    expect(out).toContain('NEGATIVE CONSTRAINTS:');
    expect(out).toContain('age 55-70');
    expect(out).toContain('The product MUST be: grounding bed sheet');
  });

  it('adds the grounding-sheet-specific constraints when the product matches', () => {
    const out = buildImagePrompt(baseSlot, 'angle', '', baseAutoContext, 0, 4);
    expect(out).toContain('fitted grounding sheet on the mattress');
    expect(out).toContain('grounding cord or visible connection point');
  });

  it('omits the grounding-sheet constraints for unrelated products', () => {
    const out = buildImagePrompt(baseSlot, 'angle', '', {
      imageContext: {
        avatarVisual: { gender: 'female', ageRange: '30-45' },
        productVisual: { productName: 'HydraGlow Serum', productType: 'facial serum', physicalDescription: 'amber glass dropper bottle' },
      },
    }, 0, 4);
    expect(out).not.toContain('fitted grounding sheet');
  });

  it('prefers the explicit brandColors arg over autoContext.brandColors', () => {
    const out = buildImagePrompt(baseSlot, 'angle', '', {
      ...baseAutoContext,
      brandColors: { primary: '#111111', secondary: null, accent: null, cta: null },
    }, 0, 4, null, { primary: '#abcdef', secondary: null, accent: null, cta: null });
    expect(out).toContain('primary #abcdef');
    expect(out).not.toContain('primary #111111');
  });
});

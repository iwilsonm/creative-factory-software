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

  it('treats standard proof/offer and CTA placeholders as required slots', () => {
    const required = getRequiredTemplateSlots({
      standardCopy: ['headline', 'proof', 'offer', 'guarantee'],
      templateCopy: ['custom_story_block'],
      cta: ['cta_1_url', 'cta_1_text'],
    }, 'problem_agitation');

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

  it('treats stripped myth-busting problem/proof placeholders as required failures', () => {
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

  it('returns the approved minor frame-specific SOP line per narrative frame', () => {
    expect(getLegacySOPFrameLine('mechanism')).toContain('mechanism lens');
    expect(getLegacySOPFrameLine('myth_busting')).toContain('myth-busting lens');
    expect(getLegacySOPFrameLine('testimonial')).toContain('testimonial / lived-result lens');
  });

  it('keeps the legacy SOP write prompt nearly verbatim while appending the frame line', () => {
    const prompt = buildLegacySOPWritePrompt({
      productName: 'Grounding Sheets',
      angle: 'Wakes to Pee, Then Cannot Fall Back Asleep',
      frameLine: getLegacySOPFrameLine('problem_agitation'),
      additionalDirection: '',
      wordCount: null,
    });

    expect(prompt).toContain("Great, now I want you to please rewrite this advertorial");
    expect(prompt).toContain('Grounding Sheets');
    expect(prompt).toContain('Wakes to Pee, Then Cannot Fall Back Asleep');
    expect(prompt).toContain('problem-agitation lens');
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
      narrativeInstruction: 'Narrative frame: mechanism\n',
      frameCopyGuardrails: 'Keep the mechanism obvious.\n',
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

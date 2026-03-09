import { beforeAll, describe, expect, it } from 'vitest';

let assembleLandingPage;
let extractRequiredPlaceholderFailures;
let getRequiredTemplateSlots;
let getMissingTemplateSlots;

beforeAll(async () => {
  process.env.CONVEX_URL ||= 'https://test-convex.invalid';
  const lpGenerator = await import('../services/lpGenerator.js');
  assembleLandingPage = lpGenerator.assembleLandingPage;
  extractRequiredPlaceholderFailures = lpGenerator.extractRequiredPlaceholderFailures;
  getRequiredTemplateSlots = lpGenerator.getRequiredTemplateSlots;
  getMissingTemplateSlots = lpGenerator.getMissingTemplateSlots;
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
});

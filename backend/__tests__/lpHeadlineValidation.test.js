import { describe, expect, it } from 'vitest';

import {
  buildLPHeadlineHistoryEntry,
  buildLPHeadlineSignature,
  evaluateHistoryHeadlineUniqueness,
  evaluateSameRunHeadlineUniqueness,
  validateLPContentAlignment,
  validateLPHeadlineFrameAlignment,
  validateLPHeadlineSourceAlignment,
} from '../services/lpHeadlineValidation.js';

describe('lpHeadlineValidation', () => {
  it('accepts a testimonial-style headline for the testimonial frame', () => {
    const result = validateLPHeadlineFrameAlignment({
      headline: 'I stopped waking at 3:12 after one change to my bed setup',
      narrativeFrame: 'testimonial',
      angle: 'Wakes to Pee, Then Cannot Fall Back Asleep',
    });

    expect(result.passed).toBe(true);
    expect(result.classifier).toBe('testimonial');
  });

  it('rejects a mechanism-style headline for the testimonial frame', () => {
    const result = validateLPHeadlineFrameAlignment({
      headline: 'Why your 2 AM bathroom wake-up can keep your body in alert mode',
      narrativeFrame: 'testimonial',
      angle: 'Wakes to Pee, Then Cannot Fall Back Asleep',
    });

    expect(result.passed).toBe(false);
    expect(result.reason).toContain('testimonial');
  });

  it('requires listicle headlines to use a real numbered/list structure', () => {
    const passResult = validateLPHeadlineFrameAlignment({
      headline: '5 reasons you wake to pee and stay awake after 2 AM',
      narrativeFrame: 'listicle',
      angle: 'Wakes to Pee, Then Cannot Fall Back Asleep',
    });
    const failResult = validateLPHeadlineFrameAlignment({
      headline: 'Why you wake to pee and cannot fall back asleep',
      narrativeFrame: 'listicle',
      angle: 'Wakes to Pee, Then Cannot Fall Back Asleep',
    });

    expect(passResult.passed).toBe(true);
    expect(failResult.passed).toBe(false);
  });

  it('accepts a pain-led problem agitation headline', () => {
    const result = validateLPHeadlineFrameAlignment({
      headline: 'You wake up to use the bathroom and then the worst part of the night begins',
      narrativeFrame: 'problem_agitation',
      angle: 'Wakes to Pee, Then Cannot Fall Back Asleep',
    });

    expect(result.passed).toBe(true);
    expect(result.classifier).toBe('problem_agitation');
  });

  it('rejects same-run near-duplicate LP headlines', () => {
    const existingHeadline = 'Why your 2 AM bathroom trip keeps you alert until sunrise every night';
    const result = evaluateSameRunHeadlineUniqueness({
      headline: 'Why your 2 AM bathroom trip keeps you alert until sunrise',
      narrativeFrame: 'mechanism',
      signature: buildLPHeadlineSignature({
        headline: 'Why your 2 AM bathroom trip keeps you alert until sunrise',
        narrativeFrame: 'mechanism',
      }),
      acceptedHeadlines: [
        {
          landing_page_id: 'lp-1',
          narrative_frame: 'mechanism',
          headline_text: existingHeadline,
          headline_signature: buildLPHeadlineSignature({
            headline: existingHeadline,
            narrativeFrame: 'mechanism',
          }),
        },
      ],
    });

    expect(result.passed).toBe(false);
    expect(result.duplicateOf).toBe('lp-1');
  });

  it('rejects recent same-angle history reuse', () => {
    const historyEntry = buildLPHeadlineHistoryEntry({
      projectId: 'proj-1',
      angleName: 'Wakes to Pee, Then Cannot Fall Back Asleep',
      narrativeFrame: 'mechanism',
      landingPageId: 'lp-old',
      gauntletBatchId: 'gauntlet-1',
      headlineText: 'Why your 2 AM bathroom trip can keep your nervous system switched on',
      subheadlineText: 'A mechanism explanation',
    });

    const result = evaluateHistoryHeadlineUniqueness({
      headline: 'Why your 2 AM bathroom trip keeps your nervous system switched on',
      narrativeFrame: 'mechanism',
      signature: buildLPHeadlineSignature({
        headline: 'Why your 2 AM bathroom trip keeps your nervous system switched on',
        narrativeFrame: 'mechanism',
      }),
      sameFrameHistory: [historyEntry],
      angleHistory: [historyEntry],
    });

    expect(result.passed).toBe(false);
    expect(result.reason).toContain('prior mechanism');
  });

  it('rejects headlines that drift away from the Director ad message', () => {
    const result = validateLPHeadlineSourceAlignment({
      headline: 'How to sleep deeper after 60 without changing your bedtime routine',
      subheadline: '',
      angle: 'Wakes to Pee, Then Cannot Fall Back Asleep',
      messageBrief: {
        sourceMode: 'director_ads',
        angleSummary: 'Wakes to Pee, Then Cannot Fall Back Asleep',
        coreScene: 'You wake in the night, use the bathroom, climb back into bed, and cannot fall asleep again.',
        desiredBeliefShift: 'The bathroom trip is not the end of the story; the problem is what happens when you get back into bed.',
        headlineExamples: ['You wake to pee and then lie there wide awake for an hour.'],
        openingExamples: ['The bathroom trip is not the worst part. The worst part starts when you get back into bed.'],
        messageKeywords: ['bathroom', 'pee', 'back', 'bed', 'wide', 'awake'],
      },
    });

    expect(result.passed).toBe(false);
    expect(result.reason).toContain('winning ad message');
  });

  it('accepts copy that stays aligned with the angle and frame', () => {
    const result = validateLPContentAlignment({
      narrativeFrame: 'problem_agitation',
      angle: 'Wakes to Pee, Then Cannot Fall Back Asleep',
      headline: 'You wake to pee and then the worst part of the night begins',
      subheadline: 'Getting back into bed is when the real problem starts.',
      messageBrief: {
        sourceMode: 'director_ads',
        angleSummary: 'Wakes to Pee, Then Cannot Fall Back Asleep',
        coreScene: 'You wake in the night, use the bathroom, climb back into bed, and cannot fall asleep again.',
        desiredBeliefShift: 'The bathroom trip is not the end of the story; the problem is what happens when you get back into bed.',
        headlineExamples: ['You wake to pee and then lie there wide awake for an hour.'],
        openingExamples: ['The bathroom trip is not the worst part. The worst part starts when you get back into bed.'],
        messageKeywords: ['bathroom', 'pee', 'back', 'bed', 'wide', 'awake'],
      },
      copySections: [
        { type: 'headline', content: 'You wake to pee and then the worst part of the night begins' },
        { type: 'lead', content: 'You shuffle to the bathroom half asleep, crawl back under the covers, and then stare at the ceiling wide awake. Night after night, the worst part starts after you get back into bed.' },
        { type: 'problem', content: 'It is exhausting, frustrating, and specific to that exact middle-of-the-night bathroom trip.' },
      ],
    });

    expect(result.passed).toBe(true);
  });
});

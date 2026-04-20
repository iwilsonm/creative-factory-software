import { describe, expect, it } from 'vitest';

import {
  buildLPHeadlineHistoryEntry,
  buildLPHeadlineSignature,
  evaluateTitleConceptSeparation,
  evaluateHistoryHeadlineUniqueness,
  evaluateSameRunHeadlineUniqueness,
  evaluateTitleFamilyUniqueness,
  validateLPHeadlineFrameAlignment,
  validateLPHeadlineSourceAlignment,
} from '../services/lpHeadlineValidation.js';

describe('lpHeadlineValidation', () => {
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

  it('rejects same-run titles that are still in the same family', () => {
    const result = evaluateTitleFamilyUniqueness({
      headline: 'The real reason your 2 AM bathroom trip keeps you alert until sunrise',
      narrativeFrame: 'myth_busting',
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
      acceptedHeadlines: [
        {
          landing_page_id: 'lp-1',
          narrative_frame: 'mechanism',
          headline_text: 'Why your 2 AM bathroom trip keeps you alert until sunrise every night',
          title_family: 'mechanism_explainer',
        },
      ],
    });

    expect(result.passed).toBe(false);
    expect(result.reason).toContain('same family');
  });

  it('rejects titles that are still the same concept with different wording', () => {
    const result = evaluateTitleConceptSeparation({
      headline: 'What most people get wrong about why your 2 AM bathroom trip keeps you alert until sunrise',
      narrativeFrame: 'myth_busting',
      angle: 'Wakes to Pee, Then Cannot Fall Back Asleep',
      messageBrief: {
        sourceMode: 'director_ads',
        angleSummary: 'Wakes to Pee, Then Cannot Fall Back Asleep',
        coreScene: 'You wake in the night, use the bathroom, climb back into bed, and cannot fall asleep again.',
        desiredBeliefShift: 'The bathroom trip is not the end of the story; the problem is what happens when you get back into bed.',
        headlineExamples: ['Why your 2 AM bathroom trip keeps you alert until sunrise.'],
        openingExamples: ['The bathroom trip is not the whole problem.'],
        messageKeywords: ['bathroom', 'pee', 'back', 'bed', 'wide', 'awake'],
      },
      acceptedHeadlines: [
        {
          landing_page_id: 'lp-1',
          narrative_frame: 'mechanism',
          headline_text: 'Why your 2 AM bathroom trip keeps you alert until sunrise',
          title_concept_family: 'hidden_cause',
          title_concept_signature: 'hidden_cause:why_explainer:hidden_cause:explicit_scene_anchor:2|am|bathroom|trip',
        },
      ],
    });

    expect(result.passed).toBe(false);
    expect(result.reason).toContain('conceptually');
  });

  it('accepts titles that stay on-angle but separate by frame concept', () => {
    const accepted = [
      {
        landing_page_id: 'lp-1',
        narrative_frame: 'testimonial',
        headline_text: 'For three years I got back into bed at 2 a.m. and never once fell back asleep',
        title_concept_family: 'story_result',
      },
      {
        landing_page_id: 'lp-2',
        narrative_frame: 'mechanism',
        headline_text: 'Why your bathroom trip at 2 a.m. flips the wrong switch in your body',
        title_concept_family: 'hidden_cause',
      },
    ];

    const result = evaluateTitleConceptSeparation({
      headline: '5 reasons you wake up to pee and stay awake for hours afterward',
      narrativeFrame: 'listicle',
      angle: 'Wakes to Pee, Then Cannot Fall Back Asleep',
      messageBrief: {
        sourceMode: 'director_ads',
        angleSummary: 'Wakes to Pee, Then Cannot Fall Back Asleep',
        coreScene: 'You wake in the night, use the bathroom, climb back into bed, and cannot fall asleep again.',
        desiredBeliefShift: 'The bathroom trip is not the end of the story; the problem is what happens when you get back into bed.',
        headlineExamples: [],
        openingExamples: [],
        messageKeywords: ['bathroom', 'pee', 'back', 'bed', 'wide', 'awake'],
      },
      acceptedHeadlines: accepted,
    });

    expect(result.passed).toBe(true);
    expect(result.titleConceptFamily).toBe('numbered_promise');
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

  it('accepts mechanism headlines that stay on the bathroom-trip to back-to-sleep scene using synonyms', () => {
    const result = validateLPHeadlineSourceAlignment({
      headline: "How a Two-Minute Bathroom Trip Hijacks Your Nervous System — And Why Your Body Can't Find Its Way Back to Sleep Without This One Missing Reset",
      subheadline: "The problem isn't that you woke up. It's that the moment your feet hit the floor, an electrical discharge cycle breaks — and without a way to restore it, your nervous system stays locked in alert mode until morning.",
      angle: 'Wakes to Pee, Then Cannot Fall Back Asleep',
    });

    expect(result.passed).toBe(true);
    expect(result.hits.scene).toContain('bathroom trip');
    expect(result.hits.scene).toContain('return to sleep');
  });

});

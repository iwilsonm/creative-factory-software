import { describe, expect, it } from 'vitest';

import {
  buildLPHeadlineHistoryEntry,
  buildLPHeadlineSignature,
  evaluateHistoryHeadlineUniqueness,
  evaluateSameRunHeadlineUniqueness,
  validateLPHeadlineFrameAlignment,
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
});

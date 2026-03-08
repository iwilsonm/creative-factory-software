import { describe, expect, it } from 'vitest';

import {
  buildSceneLockProfile,
  filterSceneAlignedHeadlines,
} from '../services/headlineDiversity.js';

const angleBrief = {
  frame: 'symptom-first',
  symptom_pattern: 'Wakes once or twice a night to use the bathroom, gets back in bed, then her body stays alert and sleep is gone.',
  scene: 'She gets back into bed after using the bathroom and can tell within 30 seconds that she is now awake for real.',
};

describe('headline scene alignment', () => {
  it('locks the wake-to-pee angle to its required concepts', () => {
    const profile = buildSceneLockProfile(angleBrief);
    expect(profile?.locked).toBe(true);
    expect(profile?.requiredConcepts).toContain('bathroom_trip');
    expect(profile?.requiredConcepts).toContain('back_to_sleep_failure');
  });

  it('keeps headlines anchored to the exact bathroom-trip scene', () => {
    const result = filterSceneAlignedHeadlines([
      {
        headline: 'Why your 3 AM bathroom trip can leave you wide awake',
        hook_lane: 'mechanism_curiosity',
        target_symptom: 'wake to pee and cannot fall back asleep',
        core_claim: 'bathroom wake-ups can keep your body alert',
        scene_anchor: 'back in bed after a bathroom trip and suddenly awake',
      },
      {
        headline: 'Drives slower now. Does not trust her reaction time.',
        hook_lane: 'consequence_led',
        target_symptom: 'next-day fatigue',
        core_claim: 'broken sleep hurts daytime confidence',
      },
      {
        headline: 'Prescription worked three nights. Then her body outsmarted it.',
        hook_lane: 'failed_solutions',
        target_symptom: 'sleep frustration',
        core_claim: 'sleep aids stop working',
      },
    ], angleBrief);

    expect(result.sceneLocked).toBe(true);
    expect(result.survivors).toHaveLength(1);
    expect(result.survivors[0].headline).toContain('bathroom trip');
    expect(result.rejected).toHaveLength(2);
    expect(result.reasonCounts.missing_bathroom_trip).toBeGreaterThan(0);
  });

  it('allows metadata to keep a headline on-scene even when the wording is shorter', () => {
    const result = filterSceneAlignedHeadlines([
      {
        headline: 'Back in bed. Wide awake again.',
        hook_lane: 'oddly_specific_moment',
        target_symptom: 'wake to pee and cannot fall back asleep',
        core_claim: 'the bathroom trip is not the end of the problem',
        scene_anchor: 'back in bed after the bathroom and awake for real',
      },
    ], angleBrief);

    expect(result.survivors).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });
});

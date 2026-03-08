import crypto from 'crypto';

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'back', 'be', 'because', 'been', 'but',
  'by', 'for', 'from', 'had', 'has', 'have', 'how', 'i', 'if', 'in', 'into',
  'is', 'it', 'its', 'like', 'my', 'of', 'on', 'or', 'our', 'that', 'the',
  'their', 'them', 'then', 'there', 'they', 'this', 'to', 'up', 'was', 'we',
  'what', 'when', 'why', 'with', 'you', 'your',
]);

const LOW_SIGNAL_ALIGNMENT_TOKENS = new Set([
  'again', 'back', 'bed', 'body', 'cant', 'cannot', 'feel', 'health', 'night',
  'problem', 'sleep', 'solution', 'still', 'wake', 'wakes', 'waking',
]);

const FRAME_CONTRACTS = {
  testimonial: 'Headline must read like a lived story, a personal result, or a journey moment.',
  mechanism: 'Headline must lead with how, why, hidden cause, or explanatory curiosity.',
  problem_agitation: 'Headline must open on the recurring pain pattern, symptom, or frustration.',
  myth_busting: 'Headline must challenge a mistaken belief or common assumption.',
  listicle: 'Headline must use an explicit numbered or list-driven structure.',
};

function stripHtml(text = '') {
  return String(text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function normalizeLPHeadlineText(text = '') {
  return stripHtml(text)
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeHeadline(text = '') {
  return normalizeLPHeadlineText(text)
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

function uniqueTokens(text = '') {
  return [...new Set(tokenizeHeadline(text))];
}

function jaccardSimilarity(left = '', right = '') {
  const leftTokens = new Set(uniqueTokens(left));
  const rightTokens = new Set(uniqueTokens(right));
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) overlap += 1;
  }
  return overlap / (leftTokens.size + rightTokens.size - overlap);
}

function firstContentTokens(text = '', count = 4) {
  return uniqueTokens(text).slice(0, count);
}

function hasAny(text = '', patterns = []) {
  return patterns.some((pattern) => pattern.test(text));
}

function extractAngleKeywords(angle = '') {
  return uniqueTokens(angle).slice(0, 8);
}

function extractAlignmentKeywords(text = '', limit = 18) {
  return uniqueTokens(text)
    .filter((token) => !LOW_SIGNAL_ALIGNMENT_TOKENS.has(token))
    .slice(0, limit);
}

function countKeywordHits(text = '', keywords = []) {
  const normalized = normalizeLPHeadlineText(text);
  if (!normalized || !Array.isArray(keywords) || keywords.length === 0) return [];
  return keywords.filter((keyword) => normalized.includes(keyword));
}

function hasAnyKeyword(text = '', keywords = []) {
  return countKeywordHits(text, keywords).length > 0;
}

export function getNarrativeFrameHeadlineContract(frameId) {
  return FRAME_CONTRACTS[frameId] || 'Headline must be clearly specific to this narrative frame.';
}

function detectHeadlineShape(headline = '') {
  const normalized = normalizeLPHeadlineText(headline);

  if (/^\s*(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i.test(headline) ||
      /\b(reasons?|signs?|ways?|things?|myths?|mistakes?)\b/i.test(normalized)) {
    return 'listicle';
  }
  if (hasAny(normalized, [
    /\bmyth\b/i,
    /\bmistake\b/i,
    /\bwrong\b/i,
    /\btruth\b/i,
    /\bnot the reason\b/i,
    /\bisnt\b/i,
    /\bdoesnt\b/i,
    /\bpeople think\b/i,
  ])) {
    return 'myth_busting';
  }
  if (hasAny(normalized, [
    /^(i|my|she|he|we)\b/i,
    /\bfor years\b/i,
    /\bfinally\b/i,
    /\bone night\b/i,
    /\bi spent\b/i,
    /\bi woke\b/i,
  ])) {
    return 'testimonial';
  }
  if (hasAny(normalized, [
    /^(how|why|what)\b/i,
    /\bhidden cause\b/i,
    /\breal reason\b/i,
    /\btrigger\b/i,
    /\bbehind\b/i,
    /\bcauses?\b/i,
    /\bmechanism\b/i,
  ])) {
    return 'mechanism';
  }
  return 'problem_agitation';
}

export function buildLPHeadlineSignature({ headline = '', narrativeFrame = '' }) {
  const normalized = normalizeLPHeadlineText(headline);
  const shape = detectHeadlineShape(headline);
  const contentTokens = firstContentTokens(headline, 5).join('|');
  return [narrativeFrame || 'general', shape, contentTokens || normalized.slice(0, 60)].join(':');
}

export function extractLPHeadlineParts(copySections = [], editorialPlan = null) {
  const sections = Array.isArray(copySections) ? copySections : [];
  const findSection = (type) => sections.find((section) => section?.type === type)?.content || '';
  const headline = stripHtml(editorialPlan?.headline || findSection('headline'));
  const subheadline = stripHtml(editorialPlan?.subheadline || findSection('subheadline'));
  return {
    headline,
    subheadline,
    normalized_headline: normalizeLPHeadlineText(headline),
    headline_signature: buildLPHeadlineSignature({
      headline,
      narrativeFrame: editorialPlan?.narrativeFrame || '',
    }),
  };
}

export function applyLPHeadlineParts(copySections = [], { headline, subheadline }) {
  const sections = Array.isArray(copySections)
    ? copySections.map((section) => ({ ...section }))
    : [];
  const upsertSection = (type, content) => {
    if (!content) return;
    const existing = sections.find((section) => section.type === type);
    if (existing) {
      existing.content = content;
    } else {
      sections.unshift({ type, content });
    }
  };
  upsertSection('headline', headline);
  upsertSection('subheadline', subheadline);
  return sections;
}

export function validateLPHeadlineFrameAlignment({ headline, narrativeFrame, angle = '' }) {
  const normalized = normalizeLPHeadlineText(headline);
  const shape = detectHeadlineShape(headline);
  const angleKeywords = extractAngleKeywords(angle);
  const keywordHitCount = angleKeywords.filter((token) => normalized.includes(token)).length;

  const testimonialSignals = Number(/^(i|my|she|he|we)\b/i.test(headline))
    + Number(/\b(for years|finally|one night|i spent|i woke|my doctor|stopped|changed|after one change)\b/i.test(normalized));
  const mechanismSignals = Number(/^(how|why|what)\b/i.test(headline))
    + Number(/\b(hidden cause|real reason|trigger|behind|causes?|mechanism)\b/i.test(normalized));
  const mythSignals = Number(/\b(myth|mistake|wrong|truth|people think|not the reason|isnt|doesnt)\b/i.test(normalized))
    + Number(/\b(actually|really)\b/i.test(normalized));
  const listicleSignals = Number(/^\s*(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i.test(headline))
    + Number(/\b(reasons?|signs?|ways?|things?|myths?|mistakes?)\b/i.test(normalized));
  const problemSignals = Number(/\b(cant|cannot|wake|wakes|waking|asleep|pain|problem|again|frustrat|drained|tired|pee|bathroom)\b/i.test(normalized))
    + Number(/\b(worst part|back in bed|wide awake|bathroom trip|fall back asleep|cant get back to sleep)\b/i.test(normalized))
    + Number(keywordHitCount > 0);

  const results = {
    testimonial: testimonialSignals >= 2 && !['mechanism', 'myth_busting', 'listicle'].includes(shape),
    mechanism: mechanismSignals >= 1 && !['testimonial', 'listicle'].includes(shape),
    problem_agitation: problemSignals >= 2 && !['mechanism', 'myth_busting', 'listicle'].includes(shape),
    myth_busting: mythSignals >= 1 && !['testimonial', 'listicle'].includes(shape),
    listicle: listicleSignals >= 2,
  };

  const passed = !!results[narrativeFrame];
  const classifier = shape;
  if (passed) {
    return {
      passed: true,
      classifier,
      reason: `${narrativeFrame} contract satisfied.`,
    };
  }

  return {
    passed: false,
    classifier,
    reason: `Headline reads more like ${shape.replace(/_/g, ' ')} than ${narrativeFrame.replace(/_/g, ' ')}.`,
  };
}

function buildSourceKeywordSets({ angle = '', messageBrief = null }) {
  const angleKeywords = [
    ...extractAlignmentKeywords(angle || ''),
    ...extractAlignmentKeywords(messageBrief?.coreScene || ''),
    ...extractAlignmentKeywords(messageBrief?.desiredBeliefShift || ''),
  ];
  const adKeywords = [
    ...ensureArray(messageBrief?.headlineExamples).flatMap((text) => extractAlignmentKeywords(text || '', 10)),
    ...ensureArray(messageBrief?.openingExamples).flatMap((text) => extractAlignmentKeywords(text || '', 10)),
    ...ensureArray(messageBrief?.messageKeywords),
  ];
  const uniqueAngle = [...new Set(angleKeywords)].slice(0, 20);
  const uniqueAd = [...new Set(adKeywords)].slice(0, 20);
  const specificKeywords = [...new Set([
    ...uniqueAngle,
    ...uniqueAd,
  ])].filter((token) => !LOW_SIGNAL_ALIGNMENT_TOKENS.has(token)).slice(0, 16);

  return {
    angleKeywords: uniqueAngle,
    adKeywords: uniqueAd,
    specificKeywords,
  };
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

export function validateLPHeadlineSourceAlignment({
  headline,
  subheadline = '',
  angle = '',
  messageBrief = null,
}) {
  const combined = `${headline || ''} ${subheadline || ''}`.trim();
  const { angleKeywords, adKeywords, specificKeywords } = buildSourceKeywordSets({ angle, messageBrief });
  const angleHits = countKeywordHits(combined, angleKeywords);
  const adHits = countKeywordHits(combined, adKeywords);
  const specificHits = countKeywordHits(combined, specificKeywords);
  const sourceMode = messageBrief?.sourceMode || 'angle_only';

  const passed = sourceMode === 'director_ads'
    ? ((specificHits.length >= 1 || angleHits.length >= 2) && (angleHits.length >= 1 || adHits.length >= 2))
    : (specificHits.length >= 1 || angleHits.length >= 2);

  if (passed) {
    return {
      passed: true,
      reason: sourceMode === 'director_ads'
        ? 'Headline stays aligned with the angle and winning ad message.'
        : 'Headline stays aligned with the angle.',
      hits: {
        angle: angleHits,
        message: adHits,
        specific: specificHits,
      },
    };
  }

  return {
    passed: false,
    reason: sourceMode === 'director_ads'
      ? 'Headline drifts away from the angle or the winning ad message.'
      : 'Headline drifts away from the angle.',
    hits: {
      angle: angleHits,
      message: adHits,
      specific: specificHits,
    },
  };
}

function getPrimaryCopyText(copySections = []) {
  const sections = Array.isArray(copySections) ? copySections : [];
  const preferredTypes = new Set(['lead', 'problem', 'solution', 'story', 'benefits', 'proof']);
  const preferred = sections.filter((section) => preferredTypes.has(section?.type));
  const chosen = preferred.length > 0 ? preferred : sections;
  return chosen
    .slice(0, 6)
    .map((section) => stripHtml(section?.content || ''))
    .join(' ');
}

function validateLPContentFrameAlignment({ copyText = '', narrativeFrame = '' }) {
  const normalized = normalizeLPHeadlineText(copyText);
  const testimonialSignals = Number(/\b(i|my|we)\b/i.test(normalized))
    + Number(/\b(after|finally|for years|one night|at first)\b/i.test(normalized));
  const mechanismSignals = Number(/\b(how|why|because|reason|trigger|cause|mechanism|nervous system)\b/i.test(normalized))
    + Number(/\b(keeps?|stays?|signals?|explains?)\b/i.test(normalized));
  const mythSignals = Number(/\b(wrong|myth|youve been told|people think|not the real reason|truth)\b/i.test(normalized))
    + Number(/\b(actually|really)\b/i.test(normalized));
  const problemSignals = Number(/\b(wake|wakes|bathroom|pee|asleep|again|frustrat|drained|worst part|back in bed)\b/i.test(normalized))
    + Number(/\b(cannot|cant|get back to sleep|wide awake)\b/i.test(normalized));
  const listicleSignals = Number(/\b(first|second|third|another reason|reason one|reason two)\b/i.test(normalized))
    + Number(/(^|\n)\s*(\d+[\).\s]|[-*]\s)/m.test(copyText));

  const frameSignals = {
    testimonial: testimonialSignals,
    mechanism: mechanismSignals,
    problem_agitation: problemSignals,
    myth_busting: mythSignals,
    listicle: listicleSignals,
  };
  const requiredSignals = {
    testimonial: 1,
    mechanism: 1,
    problem_agitation: 1,
    myth_busting: 1,
    listicle: 1,
  };
  const passed = (frameSignals[narrativeFrame] || 0) >= (requiredSignals[narrativeFrame] || 1);
  return {
    passed,
    reason: passed
      ? 'Body copy stays on the assigned narrative frame.'
      : `Body copy drifts away from the ${narrativeFrame.replace(/_/g, ' ')} frame.`,
  };
}

export function validateLPContentAlignment({
  copySections = [],
  narrativeFrame = '',
  angle = '',
  headline = '',
  subheadline = '',
  messageBrief = null,
}) {
  const copyText = getPrimaryCopyText(copySections);
  const sourceAlignment = validateLPHeadlineSourceAlignment({
    headline: `${headline || ''} ${subheadline || ''} ${copyText || ''}`.trim(),
    angle,
    messageBrief,
  });
  const frameAlignment = validateLPContentFrameAlignment({
    copyText,
    narrativeFrame,
  });
  return {
    passed: sourceAlignment.passed && frameAlignment.passed,
    sourceAlignment,
    frameAlignment,
    reason: !frameAlignment.passed
      ? frameAlignment.reason
      : !sourceAlignment.passed
        ? sourceAlignment.reason
        : 'Body copy stays aligned with the frame and source message.',
  };
}

export function compareLPHeadlines(leftHeadline, rightHeadline) {
  const left = normalizeLPHeadlineText(leftHeadline);
  const right = normalizeLPHeadlineText(rightHeadline);
  if (!left || !right) return { exact: false, containment: false, similarity: 0 };
  return {
    exact: left === right,
    containment: left.includes(right) || right.includes(left),
    similarity: jaccardSimilarity(left, right),
  };
}

function sameSignature(left = '', right = '') {
  return left && right && left === right;
}

export function evaluateSameRunHeadlineUniqueness({ headline, narrativeFrame, signature, acceptedHeadlines = [] }) {
  for (const existing of acceptedHeadlines) {
    const comparison = compareLPHeadlines(headline, existing.headline_text || existing.headline || '');
    const duplicateBySimilarity =
      comparison.exact ||
      comparison.containment ||
      comparison.similarity >= 0.72 ||
      (sameSignature(signature, existing.headline_signature) && comparison.similarity >= 0.45);

    if (duplicateBySimilarity) {
      return {
        passed: false,
        duplicateOf: existing.landing_page_id || existing.lpId || existing.externalId || null,
        reason: `Too similar to accepted ${existing.narrative_frame || 'gauntlet'} headline "${existing.headline_text || existing.headline}".`,
      };
    }
  }

  return {
    passed: true,
    duplicateOf: null,
    reason: 'Headline is distinct within the current gauntlet.',
  };
}

export function evaluateHistoryHeadlineUniqueness({
  headline,
  narrativeFrame,
  signature,
  sameFrameHistory = [],
  angleHistory = [],
}) {
  for (const existing of sameFrameHistory) {
    const comparison = compareLPHeadlines(headline, existing.headline_text || existing.headline || '');
    if (
      comparison.exact ||
      comparison.containment ||
      comparison.similarity >= 0.65 ||
      (sameSignature(signature, existing.headline_signature) && comparison.similarity >= 0.45)
    ) {
      return {
        passed: false,
        reason: `Too similar to prior ${narrativeFrame.replace(/_/g, ' ')} headline "${existing.headline_text}".`,
      };
    }
  }

  const currentTokens = firstContentTokens(headline, 4).join('|');
  for (const existing of angleHistory) {
    const comparison = compareLPHeadlines(headline, existing.headline_text || existing.headline || '');
    const existingTokens = firstContentTokens(existing.headline_text || existing.headline || '', 4).join('|');
    if (
      comparison.exact ||
      comparison.containment ||
      comparison.similarity >= 0.78 ||
      (sameSignature(signature, existing.headline_signature) && comparison.similarity >= 0.4) ||
      (currentTokens && currentTokens === existingTokens)
    ) {
      return {
        passed: false,
        reason: `Too similar to prior same-angle headline "${existing.headline_text}".`,
      };
    }
  }

  return {
    passed: true,
    reason: 'Headline is distinct from recent same-angle history.',
  };
}

export function buildLPHeadlineHistoryEntry({
  projectId,
  angleName,
  narrativeFrame,
  landingPageId,
  gauntletBatchId,
  headlineText,
  subheadlineText,
}) {
  const createdAt = new Date().toISOString();
  const normalizedHeadline = normalizeLPHeadlineText(headlineText);
  return {
    externalId: crypto.randomUUID(),
    project_id: projectId,
    angle_name: angleName,
    narrative_frame: narrativeFrame,
    landing_page_id: landingPageId || undefined,
    gauntlet_batch_id: gauntletBatchId || undefined,
    headline_text: headlineText,
    subheadline_text: subheadlineText || undefined,
    normalized_headline: normalizedHeadline,
    headline_signature: buildLPHeadlineSignature({
      headline: headlineText,
      narrativeFrame,
    }),
    created_at: createdAt,
  };
}

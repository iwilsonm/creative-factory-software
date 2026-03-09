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

const TITLE_FAMILY_STOPWORDS = new Set([
  ...LOW_SIGNAL_ALIGNMENT_TOKENS,
  '2', '2am', '3', '3am', 'bathroom', 'bathrooms', 'clock', 'dawn', 'fall', 'falls',
  'finally', 'fix', 'fixes', 'hour', 'hours', 'pee', 'peeing', 'reason', 'reasons',
  'trip', 'trips', 'use', 'using', 'worst',
]);

const FRAME_BLUEPRINTS = {
  testimonial: {
    contract: 'Headline must read like a lived story, a personal result, or a journey moment.',
    titleFamily: 'testimonial_journey',
    titleShape: 'lived-result story',
    openingMove: 'Lead with a lived moment, dread, relief, or before/after result.',
    sectionEmphasis: ['lead', 'story', 'proof', 'offer'],
    proofStyle: 'personal before/after specifics and named customer proof',
    persuasionPattern: 'struggle -> turning point -> result',
    ctaStyle: 'personal invitation tied to the result',
    forbiddenStructuralPatterns: ['mechanism explainer opener', 'myth/truth opener', 'numbered list opener'],
    requiredHeadlineGroups: [
      { label: 'lived perspective', patterns: [/^(i|my|we)\b/i, /\b(i|my|we)\b/i] },
      { label: 'story/result movement', patterns: [/\b(for years|finally|one night|after|dreaded|spent|woke|changed|stopped)\b/i] },
    ],
    requiredCopyGroups: [
      { label: 'first-person story voice', patterns: [/\b(i|my|we)\b/i, /\bone night\b/i, /\bfor years\b/i] },
      { label: 'journey progression', patterns: [/\b(before|after|finally|then|until)\b/i, /\b(struggl|changed|stopped|relief)\b/i] },
    ],
    requiredSectionTypes: ['lead', 'proof'],
    forbiddenHeadlinePatterns: [/^\s*(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i, /\b(myth|wrong|truth|people think)\b/i, /^(how|why|what)\b/i],
    forbiddenCopyPatterns: [/\b(myth|people think|the real reason|reason one|reason two)\b/i],
  },
  mechanism: {
    contract: 'Headline must lead with how, why, hidden cause, or explanatory curiosity.',
    titleFamily: 'mechanism_explainer',
    titleShape: 'explanatory curiosity',
    openingMove: 'Lead with how/why or the hidden cause that explains the problem.',
    sectionEmphasis: ['lead', 'solution', 'benefits', 'proof'],
    proofStyle: 'cause-and-effect explanation supported by practical proof',
    persuasionPattern: 'curiosity -> cause -> explanation -> solution',
    ctaStyle: 'resolve the hidden cause',
    forbiddenStructuralPatterns: ['first-person testimonial opener', 'generic myth framing', 'numbered list opener'],
    requiredHeadlineGroups: [
      { label: 'mechanism opener', patterns: [/^(how|why|what)\b/i, /\b(real reason|hidden cause|blocking|trigger|behind|keeps)\b/i] },
    ],
    requiredCopyGroups: [
      { label: 'causal explanation', patterns: [/\b(because|reason|trigger|cause|mechanism|signals?|switch|nervous system|stays on)\b/i] },
      { label: 'why alternatives fail', patterns: [/\b(traditional|usual|common|nothing else|doesnt work|fails?|root cause|doesnt address|doesn't address|only helps|misses what happens|surface level|surface-level)\b/i] },
    ],
    requiredSectionTypes: ['lead', 'solution'],
    forbiddenHeadlinePatterns: [/^\s*(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i, /\b(myth|wrong|truth|people think)\b/i, /^(i|my|we)\b/i],
    forbiddenCopyPatterns: [/\b(reason one|reason two|myth)\b/i],
  },
  problem_agitation: {
    contract: 'Headline must open on the recurring pain pattern, symptom, or frustration.',
    titleFamily: 'pain_pattern_agitation',
    titleShape: 'pain-led symptom moment',
    openingMove: 'Lead with the painful recurring moment the reader instantly recognizes.',
    sectionEmphasis: ['lead', 'problem', 'solution', 'offer'],
    proofStyle: 'pain recognition followed by relief-oriented proof',
    persuasionPattern: 'pain pattern -> frustration -> escalation -> relief transition',
    ctaStyle: 'urgent relief from the recurring problem',
    forbiddenStructuralPatterns: ['first-person testimonial opener', 'pure mechanism explainer opener', 'numbered list opener'],
    requiredHeadlineGroups: [
      { label: 'pain or symptom moment', patterns: [/\b(wake|wakes|bathroom|pee|back in bed|wide awake|worst part|cannot fall back asleep|cant fall back asleep)\b/i] },
      { label: 'friction or distress', patterns: [/\b(exhausted|frustrat|dawn|clock|again|night after night|lie there)\b/i, /\byou\b/i] },
    ],
    requiredCopyGroups: [
      { label: 'reader-focused pain voice', patterns: [/\byou\b/i, /\b(your|night after night|again)\b/i] },
      { label: 'specific symptom friction', patterns: [/\b(bathroom|pee|back in bed|wide awake|ceiling|clock|dawn|worst part)\b/i] },
    ],
    requiredSectionTypes: ['lead', 'problem'],
    forbiddenHeadlinePatterns: [/^\s*(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i, /\b(myth|wrong|truth|people think)\b/i],
    forbiddenCopyPatterns: [/\b(reason one|reason two|myth|people think)\b/i],
  },
  myth_busting: {
    contract: 'Headline must challenge a mistaken belief or common assumption.',
    titleFamily: 'belief_reversal',
    titleShape: 'belief challenge',
    openingMove: 'Lead by challenging a mistaken belief, false explanation, or conventional wisdom.',
    sectionEmphasis: ['lead', 'problem', 'solution', 'proof'],
    proofStyle: 'belief reversal supported by corrective explanation and evidence',
    persuasionPattern: 'common belief -> why it feels true -> what is actually true',
    ctaStyle: 'act on the corrected truth',
    forbiddenStructuralPatterns: ['first-person testimonial opener', 'generic why/how mechanism opener without belief reversal', 'numbered list opener'],
    requiredHeadlineGroups: [
      { label: 'belief-challenge language', patterns: [/\b(myth|mistake|wrong|truth|people think|youve been told|not the real reason|isnt|doesnt)\b/i] },
    ],
    requiredCopyGroups: [
      { label: 'belief reversal copy', patterns: [/\b(people think|youve been told|most people|actually|truth|wrong|myth)\b/i] },
      { label: 'correction language', patterns: [/\b(instead|real reason|what is actually happening|not the real reason)\b/i] },
    ],
    requiredSectionTypes: ['lead', 'solution'],
    forbiddenHeadlinePatterns: [/^\s*(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i, /^(i|my|we)\b/i],
    forbiddenCopyPatterns: [/\b(reason one|reason two)\b/i],
  },
  listicle: {
    contract: 'Headline must use an explicit numbered or list-driven structure.',
    titleFamily: 'numbered_list',
    titleShape: 'numbered list',
    openingMove: 'Lead with an explicit count and a list promise.',
    sectionEmphasis: ['lead', 'benefits', 'proof', 'offer'],
    proofStyle: 'itemized proof or reasons that escalate toward the offer',
    persuasionPattern: 'numbered reasons -> build momentum -> strongest point near the end',
    ctaStyle: 'cta tied to the list conclusion',
    forbiddenStructuralPatterns: ['first-person testimonial opener', 'generic mechanism opener', 'myth-only opener'],
    requiredHeadlineGroups: [
      { label: 'numbered opener', patterns: [/^\s*(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i] },
      { label: 'list promise', patterns: [/\b(reasons?|signs?|ways?|things?|myths?|mistakes?)\b/i] },
    ],
    requiredCopyGroups: [
      { label: 'list structure', patterns: [/\b(first|second|third|reason one|reason two|reason three)\b/i, /(^|\n)\s*(\d+[\).\s]|[-*]\s)/m] },
    ],
    requiredSectionTypes: ['lead'],
    forbiddenHeadlinePatterns: [/^(i|my|we)\b/i],
    forbiddenCopyPatterns: [/\bpeople think\b/i],
  },
};

const FRAME_CONTRACTS = Object.fromEntries(
  Object.entries(FRAME_BLUEPRINTS).map(([frameId, blueprint]) => [frameId, blueprint.contract])
);

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

function uniqueLowerArray(values = []) {
  return [...new Set(values.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean))];
}

const SECTION_TYPE_ALIASES = {
  lead: ['headline', 'subheadline', 'page_title', 'category_label', 'opening_paragraph', 'body_copy_1', 'byline'],
  story: ['opening_paragraph', 'body_copy_1', 'turning_point_heading', 'turning_point_copy_1', 'turning_point_copy_2', 'letter_body', 'letter_signature'],
  problem: ['problem_heading', 'problem_copy_1', 'problem_copy_2', 'body_copy_1', 'opening_paragraph'],
  solution: ['discovery_heading', 'discovery_copy_1', 'discovery_copy_2', 'company_heading', 'company_copy_1', 'company_copy_2', 'results_heading', 'results_copy_1', 'results_copy_2'],
  proof: ['results_heading', 'results_copy_1', 'results_copy_2', 'comparison_heading', 'callout_text', 'letter_body'],
  offer: ['good_card_title', 'good_card_price', 'cta_1_label', 'cta_2_label', 'post_letter_copy'],
  benefits: ['good_feature_1', 'good_feature_2', 'good_feature_3', 'good_feature_4', 'discovery_copy_1', 'discovery_copy_2'],
};

function expandSectionTypeAliases(types = []) {
  const normalized = uniqueLowerArray(types);
  const expanded = new Set(normalized);
  for (const type of normalized) {
    for (const [semanticType, aliases] of Object.entries(SECTION_TYPE_ALIASES)) {
      if (aliases.includes(type)) {
        expanded.add(semanticType);
      }
    }
  }
  return [...expanded];
}

function sectionTypesFromCopy(copySections = []) {
  return expandSectionTypeAliases(
    ensureArray(copySections).map((section) => section?.type)
  );
}

function getSectionText(copySections = [], preferredTypes = []) {
  const preferred = new Set(expandSectionTypeAliases(preferredTypes));
  const sections = ensureArray(copySections)
    .filter((section) => section?.type && section?.content)
    .filter((section) => {
      if (preferred.size === 0) return true;
      const candidates = expandSectionTypeAliases([section.type]);
      return candidates.some((candidate) => preferred.has(candidate));
    });
  return sections.map((section) => stripHtml(section.content || '')).join(' ');
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

export function getNarrativeFrameBlueprint(frameId) {
  return FRAME_BLUEPRINTS[frameId] || {
    contract: getNarrativeFrameHeadlineContract(frameId),
    titleFamily: frameId || 'general',
    titleShape: 'frame-specific headline',
    openingMove: 'Lead in the voice of the assigned narrative frame.',
    sectionEmphasis: ['lead', 'offer'],
    proofStyle: 'proof that matches the frame',
    persuasionPattern: 'frame-specific persuasion sequence',
    ctaStyle: 'cta that follows the frame',
    forbiddenStructuralPatterns: [],
    requiredHeadlineGroups: [],
    requiredCopyGroups: [],
    requiredSectionTypes: ['lead'],
    forbiddenHeadlinePatterns: [],
    forbiddenCopyPatterns: [],
  };
}

export function buildNarrativeFrameBlueprintSummary(frameId) {
  const blueprint = getNarrativeFrameBlueprint(frameId);
  return {
    contract: blueprint.contract,
    title_family: blueprint.titleFamily,
    title_shape: blueprint.titleShape,
    opening_move: blueprint.openingMove,
    section_emphasis: blueprint.sectionEmphasis,
    proof_style: blueprint.proofStyle,
    persuasion_pattern: blueprint.persuasionPattern,
    cta_style: blueprint.ctaStyle,
    forbidden_structural_patterns: blueprint.forbiddenStructuralPatterns,
  };
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
  const blueprint = getNarrativeFrameBlueprint(narrativeFrame);
  const headlineText = stripHtml(headline);
  const missingGroups = ensureArray(blueprint.requiredHeadlineGroups)
    .filter((group) => !ensureArray(group?.patterns).some((pattern) => pattern.test(headlineText)));
  const forbiddenPattern = ensureArray(blueprint.forbiddenHeadlinePatterns)
    .find((pattern) => pattern.test(headlineText) || pattern.test(normalized));
  const passed = missingGroups.length === 0 && !forbiddenPattern;
  const classifier = shape;
  if (passed) {
    return {
      passed: true,
      classifier,
      reason: `${narrativeFrame} contract satisfied.`,
    };
  }

  if (forbiddenPattern) {
    return {
      passed: false,
      classifier,
      reason: `Headline uses a ${shape.replace(/_/g, ' ')} structure that conflicts with the ${narrativeFrame.replace(/_/g, ' ')} frame.`,
    };
  }

  return {
    passed: false,
    classifier,
    reason: `Headline is missing the ${missingGroups.map((group) => group.label).join(' and ')} needed for ${narrativeFrame.replace(/_/g, ' ')}.`,
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

function buildSourceSceneCueGroups({ angle = '', messageBrief = null }) {
  const sourceText = normalizeLPHeadlineText([
    angle,
    messageBrief?.angleSummary,
    messageBrief?.coreScene,
    messageBrief?.desiredBeliefShift,
    ...(ensureArray(messageBrief?.headlineExamples)),
    ...(ensureArray(messageBrief?.openingExamples)),
  ].filter(Boolean).join(' '));

  const groups = [];
  if (/\b(pee|bathroom|restroom|urinat)\b/i.test(sourceText)) {
    groups.push({
      label: 'bathroom trip',
      patterns: [/\b(pee|bathroom|restroom|urinat|bathroom trip)\b/i],
    });
  }
  if (/\b(fall back asleep|back to sleep|return to sleep|sleep again|back asleep)\b/i.test(sourceText)) {
    groups.push({
      label: 'return to sleep',
      patterns: [/\b(fall back asleep|back to sleep|return to sleep|sleep again|back asleep)\b/i],
    });
  }
  if (/\b(back into bed|back in bed|return to bed|get back into bed|get back to bed)\b/i.test(sourceText)) {
    groups.push({
      label: 'back in bed',
      patterns: [/\b(back into bed|back in bed|return to bed|get back into bed|get back to bed)\b/i],
    });
  }
  if (/\b(wake|wakes|woke|waking|night|nighttime|middle of the night|2 am|2am|3 am|3am)\b/i.test(sourceText)) {
    groups.push({
      label: 'night wake moment',
      patterns: [/\b(wake|wakes|woke|waking|night|nighttime|middle of the night|2 am|2am|3 am|3am)\b/i],
    });
  }
  return groups;
}

function matchSceneCueGroups(text = '', groups = []) {
  const normalized = normalizeLPHeadlineText(text);
  return ensureArray(groups)
    .filter((group) => ensureArray(group.patterns).some((pattern) => pattern.test(normalized)))
    .map((group) => group.label);
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
  const sceneCueGroups = buildSourceSceneCueGroups({ angle, messageBrief });
  const angleHits = countKeywordHits(combined, angleKeywords);
  const adHits = countKeywordHits(combined, adKeywords);
  const specificHits = countKeywordHits(combined, specificKeywords);
  const sceneCueHits = matchSceneCueGroups(combined, sceneCueGroups);
  const sourceMode = messageBrief?.sourceMode || 'angle_only';
  const sceneCuePass = sceneCueGroups.length > 0 && sceneCueHits.length >= Math.min(2, sceneCueGroups.length);

  const passed = sourceMode === 'director_ads'
    ? sceneCuePass || ((specificHits.length >= 2 || angleHits.length >= 2) && (adHits.length >= 1 || specificHits.length >= 1))
    : sceneCuePass || (specificHits.length >= 1 || angleHits.length >= 2);

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
        scene: sceneCueHits,
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
      scene: sceneCueHits,
    },
  };
}

function getPrimaryCopyText(copySections = [], preferredTypes = []) {
  const sections = Array.isArray(copySections)
    ? copySections.filter((section) => section?.content)
    : [];
  if (sections.length === 0) return '';

  const preferred = new Set(expandSectionTypeAliases(preferredTypes));
  if (preferred.size === 0) {
    return sections.map((section) => stripHtml(section?.content || '')).join(' ');
  }

  const prioritized = [];
  const remainder = [];
  for (const section of sections) {
    const aliases = expandSectionTypeAliases([section?.type]);
    if (aliases.some((alias) => preferred.has(alias))) {
      prioritized.push(section);
    } else {
      remainder.push(section);
    }
  }

  return [...prioritized, ...remainder]
    .map((section) => stripHtml(section?.content || ''))
    .join(' ');
}

function validateLPContentFrameAlignment({ copySections = [], narrativeFrame = '' }) {
  const blueprint = getNarrativeFrameBlueprint(narrativeFrame);
  const copyText = getPrimaryCopyText(copySections, [
    ...ensureArray(blueprint.sectionEmphasis),
    ...ensureArray(blueprint.requiredSectionTypes),
  ]);
  const rawText = stripHtml(copyText);
  const normalized = normalizeLPHeadlineText(copyText);
  const missingGroups = ensureArray(blueprint.requiredCopyGroups)
    .filter((group) => !ensureArray(group?.patterns).some((pattern) => pattern.test(rawText) || pattern.test(normalized)));
  const forbiddenPattern = ensureArray(blueprint.forbiddenCopyPatterns)
    .find((pattern) => pattern.test(rawText) || pattern.test(normalized));
  const passed = missingGroups.length === 0 && !forbiddenPattern;
  return {
    passed,
    reason: passed
      ? 'Body copy stays on the assigned narrative frame.'
      : forbiddenPattern
        ? `Body copy uses a pattern that conflicts with the ${narrativeFrame.replace(/_/g, ' ')} frame.`
        : `Body copy is missing the ${missingGroups.map((group) => group.label).join(' and ')} needed for the ${narrativeFrame.replace(/_/g, ' ')} frame.`,
  };
}

export function validateLPFrameBlueprint({
  headline = '',
  narrativeFrame = '',
  copySections = [],
  angle = '',
}) {
  const blueprint = getNarrativeFrameBlueprint(narrativeFrame);
  const headlineAlignment = validateLPHeadlineFrameAlignment({
    headline,
    narrativeFrame,
    angle,
  });
  const contentAlignment = validateLPContentFrameAlignment({
    copySections,
    narrativeFrame,
  });
  const sectionTypes = sectionTypesFromCopy(copySections);
  const missingSectionTypes = ensureArray(blueprint.requiredSectionTypes)
    .filter((sectionType) => !sectionTypes.includes(String(sectionType).toLowerCase()));
  const passed = headlineAlignment.passed && contentAlignment.passed && missingSectionTypes.length === 0;

  return {
    passed,
    titleFamily: blueprint.titleFamily,
    headlineAlignment,
    contentAlignment,
    missingSectionTypes,
    reason: !headlineAlignment.passed
      ? headlineAlignment.reason
      : !contentAlignment.passed
        ? contentAlignment.reason
        : missingSectionTypes.length > 0
          ? `Page is missing the ${missingSectionTypes.join(', ')} structure required for ${narrativeFrame.replace(/_/g, ' ')}.`
          : `${narrativeFrame} blueprint satisfied.`,
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
  const blueprint = getNarrativeFrameBlueprint(narrativeFrame);
  const copyText = getPrimaryCopyText(copySections, [
    ...ensureArray(blueprint.sectionEmphasis),
    ...ensureArray(blueprint.requiredSectionTypes),
  ]);
  const frameBlueprint = validateLPFrameBlueprint({
    headline,
    narrativeFrame,
    copySections,
    angle,
  });
  const sourceAlignment = validateLPHeadlineSourceAlignment({
    headline: `${headline || ''} ${subheadline || ''} ${copyText || ''}`.trim(),
    angle,
    messageBrief,
  });
  return {
    passed: sourceAlignment.passed && frameBlueprint.passed,
    sourceAlignment,
    frameAlignment: frameBlueprint,
    frameBlueprint,
    reason: !frameBlueprint.passed
      ? frameBlueprint.reason
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

function buildTitleFamilyFocus({ headline = '', angle = '', messageBrief = null }) {
  const { angleKeywords, adKeywords, specificKeywords } = buildSourceKeywordSets({ angle, messageBrief });
  const ignore = new Set([
    ...TITLE_FAMILY_STOPWORDS,
    ...angleKeywords,
    ...adKeywords,
    ...specificKeywords,
  ]);
  return uniqueTokens(headline)
    .filter((token) => !ignore.has(token))
    .slice(0, 4);
}

function sameFocus(leftTokens = [], rightTokens = []) {
  if (!leftTokens.length || !rightTokens.length) return false;
  const left = leftTokens.slice(0, 2).join('|');
  const right = rightTokens.slice(0, 2).join('|');
  if (left && right && left === right) return true;
  const overlap = leftTokens.filter((token) => rightTokens.includes(token));
  return overlap.length >= 2;
}

export function evaluateTitleFamilyUniqueness({
  headline,
  narrativeFrame,
  acceptedHeadlines = [],
  angle = '',
  messageBrief = null,
}) {
  const blueprint = getNarrativeFrameBlueprint(narrativeFrame);
  const titleFamily = blueprint.titleFamily;
  const titleFocus = buildTitleFamilyFocus({ headline, angle, messageBrief });

  for (const existing of acceptedHeadlines) {
    const existingHeadline = existing.headline_text || existing.headline || '';
    const comparison = compareLPHeadlines(headline, existingHeadline);
    const existingFamily = existing.title_family || getNarrativeFrameBlueprint(existing.narrative_frame || '').titleFamily;
    const existingFocus = Array.isArray(existing.title_focus_tokens)
      ? existing.title_focus_tokens
      : buildTitleFamilyFocus({
          headline: existingHeadline,
          angle,
          messageBrief,
        });

    if (existingFamily && existingFamily === titleFamily) {
      return {
        passed: false,
        duplicateOf: existing.landing_page_id || existing.lpId || existing.externalId || null,
        titleFamily,
        titleFocus,
        reason: `Title reuses the ${titleFamily.replace(/_/g, ' ')} family already used by "${existingHeadline}".`,
      };
    }

    if (
      comparison.exact ||
      comparison.containment ||
      comparison.similarity >= 0.58 ||
      (comparison.similarity >= 0.42 && sameFocus(titleFocus, existingFocus))
    ) {
      return {
        passed: false,
        duplicateOf: existing.landing_page_id || existing.lpId || existing.externalId || null,
        titleFamily,
        titleFocus,
        reason: `Title is still too close to the same family as "${existingHeadline}".`,
      };
    }
  }

  return {
    passed: true,
    duplicateOf: null,
    titleFamily,
    titleFocus,
    reason: 'Title is materially different from the other frame titles in this gauntlet.',
  };
}

export function evaluateHistoryHeadlineUniqueness({
  headline,
  narrativeFrame,
  signature,
  sameFrameHistory = [],
  angleHistory = [],
  angle = '',
  messageBrief = null,
}) {
  const currentFocusTokens = buildTitleFamilyFocus({ headline, angle, messageBrief });
  for (const existing of sameFrameHistory) {
    const comparison = compareLPHeadlines(headline, existing.headline_text || existing.headline || '');
    const existingFocusTokens = buildTitleFamilyFocus({
      headline: existing.headline_text || existing.headline || '',
      angle,
      messageBrief,
    });
    if (
      comparison.exact ||
      comparison.containment ||
      comparison.similarity >= 0.65 ||
      (sameSignature(signature, existing.headline_signature) && comparison.similarity >= 0.45) ||
      (comparison.similarity >= 0.4 && sameFocus(currentFocusTokens, existingFocusTokens))
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
    const existingFocusTokens = buildTitleFamilyFocus({
      headline: existing.headline_text || existing.headline || '',
      angle,
      messageBrief,
    });
    if (
      comparison.exact ||
      comparison.containment ||
      comparison.similarity >= 0.78 ||
      (sameSignature(signature, existing.headline_signature) && comparison.similarity >= 0.4) ||
      (currentTokens && currentTokens === existingTokens) ||
      sameFocus(currentFocusTokens, existingFocusTokens)
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

# AD System Context

Technical context document for strategic review. Written from codebase inspection. Last updated March 2026.

---

## 1. System Purpose

**What it does**: An end-to-end ad creative automation platform that generates Facebook/Meta static image ads for DTC health and wellness brands targeting women 55-75. It handles the full pipeline from market research through ad generation, quality scoring, landing page creation, and deployment staging for Meta Ads.

**What it outputs**:
- Foundational research documents (customer avatar, offer brief, necessary beliefs)
- Mined emotional quotes from Reddit, forums, and Facebook groups
- Headlines + body copy for Facebook ads
- AI-generated static ad images (text overlays, product shots, lifestyle visuals)
- Flex ads (multi-variant ad packages: 10 images + 3-5 headlines + 3-5 primary texts)
- Landing pages (advertorial-style, published to Shopify)
- Campaign/ad set/deployment structures ready for Meta Ads Manager

**Who uses it**: Direct response copywriters, media buyers, and e-commerce brand operators. Three user roles: Admin (full access), Manager (project-level work), Poster (only sees Ready to Post and Posted views).

**Where it fits**: Replaces the creative production team. Humans still post to Meta Ads Manager and review performance. The system generates the creative, scores it, packages it, and stages it. A human operator clicks "Mark as Posted" to confirm it went live.

---

## 2. End-to-End Flow

### A. Foundation Building (one-time per project)

1. **Project Creation** — operator enters brand name, niche, product description, sales page content (`backend/routes/projects.js`)
2. **Foundational Doc Generation** (SSE stream, ~45 min) — 8-step pipeline through GPT-4.1 + o3-deep-research (`backend/services/docGenerator.js`)
   - Steps 1-3: GPT-4.1 analyzes sales page, learns research methodology, generates research prompt
   - Step 4: o3-deep-research performs 30-minute web research (forums, Reddit, reviews, communities)
   - Steps 5-6: GPT-4.1 synthesizes research into Avatar Sheet + Offer Brief
   - Steps 7-8: GPT-4.1 learns direct response methodology, generates Necessary Beliefs (max 6)
   - Output: 4 documents stored in `foundational_docs` table
3. **Quote Mining** (SSE stream) — dual-engine search: Perplexity Sonar Pro + Claude Opus 4.6 (`backend/services/quoteMiner.js`)
   - Searches Reddit, forums, Facebook groups for emotionally charged first-person quotes
   - Merged, ranked by emotional intensity, deduplicated against existing bank (GPT-4.1-mini)
   - Per-quote headline generation via Claude Sonnet 4.6
   - Output: `quote_bank` table entries with tags, emotions, headlines
4. **Template/Inspiration Upload** — operator uploads reference ad images or syncs from Google Drive (`backend/routes/templates.js`, `backend/routes/drive.js`)
5. **Angle Creation** — operator defines advertising angles with name, description, and prompt hints (`conductor_angles` table, managed via `backend/routes/conductor.js`)

### B. Ad Generation (automated, recurring)

6. **Director Plans Batches** — runs 3x daily at 7 AM, 7 PM, 1 AM ICT (`backend/services/conductorEngine.js`)
   - Calculates deficit: `daily_flex_target - existing_flex_ads - batches_in_progress`
   - Selects angles (round-robin, or focused mode)
   - Injects playbook learnings into angle prompt
   - Creates batch jobs with `filter_assigned=true`
   - Fires batch pipeline + triggers LP auto-generation

7. **4-Stage Batch Pipeline** (`backend/services/batchProcessor.js` + `backend/services/adGenerator.js`)
   - **Stage 0**: Brief extraction — Claude Opus 4.6 condenses 4 foundational docs into angle-specific brief
   - **Stage 1**: Headline generation — Claude Opus 4.6 generates ~20% more headlines than batch size, self-scores, ranks
   - **Stage 2**: Body copy — Claude Sonnet 4.6 generates body copy for top N headlines (batches of 5)
   - **Stage 3**: Image prompt generation — Claude Sonnet 4.6 creates image prompts per ad (with template image vision)
   - **Image generation**: All prompts submitted to Gemini Batch API (Gemini 3 Pro, 2K resolution)
   - **Polling**: Scheduler polls Gemini every 5 minutes for batch completion
   - **Result processing**: Images uploaded to Convex blob storage, `ad_creatives` records created

8. **Creative Filter Scores Ads** — runs every 30 min via VPS cron (`dacia-creative-filter/filter.sh`)
   - Vision-based scoring via Claude Sonnet 4.6 (`agents/score.sh`): 4 criteria, weighted:
     - Copy Strength (35%), Meta Compliance (25%), Overall Effectiveness (20%), Image Quality (20%)
   - Hard requirements: spelling/grammar, first-line hook, CTA at end, headline-ad alignment, image completeness
   - Passing threshold: score >= 7/10
   - Groups winners into flex ads (`agents/group.sh`): best 10 images, 3-5 headlines, 3-5 primary texts
   - Creates ad set + flex ad, sets status to "ready"
   - **Human review point**: operator sees flex ads in Ready to Post view

9. **LP Auto-Generation** (`backend/services/lpAutoGenerator.js`)
   - Waits for Creative Filter to finish (polls every 30s, max 2h)
   - Generates 2 landing pages per batch with different narrative frames
   - Each LP: copy gen (Claude Sonnet) → Opus editorial pass → image gen (Gemini) → HTML template → assembly → Visual QA loop (up to 3 attempts) → publish to Shopify → smoke test (7 checks)
   - LP URLs stored on batch record and flex ad

10. **Learning Step** (`backend/services/conductorLearning.js`)
    - Filter triggers after scoring: identifies top 3 winners + bottom 3 losers
    - Updates playbook per angle: visual patterns, copy patterns, avoid patterns
    - Adjusts adaptive batch sizing based on pass rate
    - **Known bug**: `messages.filter is not a function` — learning step may fail silently

### C. Deployment (manual)

11. **Ready to Post View** — operator reviews flex ad packages (images, headlines, primary texts, LP URLs)
12. **Mark as Posted** — operator clicks to confirm ad is live in Meta Ads Manager
13. **Meta Performance Sync** — scheduler syncs every 30 min: impressions, clicks, spend, CTR, CPC, CPM, conversions (`backend/services/metaAds.js`)
14. **Posted View** — operator monitors performance data

### D. Self-Healing (automated)

15. **Fixer Agent** — runs every 5 min (`dacia-fixer/fixer.sh`)
    - Tests batch pipeline, diagnoses failures (Gemini Flash), generates fixes (Claude Sonnet)
    - Health probes: backend health, filter liveness, director staleness, batch stuck >90 min, disk space
    - Resurrects stuck batches (re-triggers after 90 min, max 3 retries)

---

## 3. Main Code Locations

| Area | File Path | Key Functions | What It Does | Notes |
|------|-----------|---------------|-------------|-------|
| **Ad generation orchestrator** | `backend/services/adGenerator.js` | `generateAd()`, `generateAdMode2()`, `extractBrief()`, `generateHeadlines()`, `generateBodyCopies()`, `generateImagePrompt()`, `buildCreativeDirectorPrompt()` | All prompt construction + pipeline stages 0-3 | ~1300 lines. Central to creative quality. |
| **Batch processor** | `backend/services/batchProcessor.js` | `runBatch()`, `pollBatchJob()`, `processBatchResults()`, `submitGeminiBatch()` | Runs 4-stage pipeline, submits to Gemini Batch API, processes results | Handles retry, image upload, cost tracking |
| **Image generation** | `backend/services/gemini.js` | `generateImage()`, `getClient()` | Gemini 3 Pro / 3.1 Flash image generation with product image compositing | Concurrency=3 rate limit |
| **Foundational docs** | `backend/services/docGenerator.js` | `generateDocs()` | 8-step research pipeline (GPT-4.1 + o3-deep-research) | 30-min deep research timeout |
| **Quote mining** | `backend/services/quoteMiner.js` | `runQuoteMining()`, `generateSuggestions()` | Dual-engine (Perplexity + Claude) quote search | Dedup via `quoteDedup.js` |
| **Headline generation (quotes)** | `backend/services/headlineGenerator.js` | `generateHeadlinesForQuotes()` | Per-quote headline generation from quote bank | Uses 3 reference copywriting docs |
| **Body copy generation** | `backend/services/bodyCopyGenerator.js` | `generateBodyCopy()` | Legacy standalone body copy from headline + quote context | May not be actively used for batch pipeline |
| **Creative Filter** | `dacia-creative-filter/filter.sh` | `score_batch_ads()`, `group_into_flex_ads()`, `deploy_flex_ads()` | Scores ads via vision, groups winners, creates flex ads | Bash script, ~1170 lines |
| **Filter scoring** | `dacia-creative-filter/agents/score.sh` | Main scoring logic | Claude Sonnet vision scoring (4 weighted criteria) | ~$0.03/ad |
| **Filter grouping** | `dacia-creative-filter/agents/group.sh` | Main grouping logic | Clusters passing ads into flex ad packages | Selects best 10 images + copy |
| **Director/Conductor** | `backend/services/conductorEngine.js` | `runDirector()`, `runDirectorForProject()`, `calculateDeficit()`, `selectAngles()` | Plans batches, selects angles, injects playbook | Deficit-based: `target - existing - in_progress` |
| **Learning** | `backend/services/conductorLearning.js` | `runLearningStep()`, `getAdaptiveBatchSize()` | Updates playbooks from scored ads, adjusts batch sizes | Has known bug |
| **Fixer** | `dacia-fixer/fixer.sh` | `acquire_lock()`, health probes, batch resurrection | Auto-test, diagnose, fix, resurrect batches | Bash script, ~1200 lines |
| **LP generation** | `backend/services/lpGenerator.js` | `generateLandingPageCopy()`, `generateHtmlTemplate()`, `assembleLandingPage()`, `postProcessLP()`, `runVisualQA()`, `autoFixLP()` | Full LP pipeline: copy + design + HTML + QA | ~2500 lines |
| **LP auto-generation** | `backend/services/lpAutoGenerator.js` | `triggerLPGeneration()` | Director-triggered, waits for Filter, generates 2 LPs per batch | Fire-and-forget |
| **LP publisher** | `backend/services/lpPublisher.js` | `publishToShopify()`, `unpublishFromShopify()` | Shopify Pages API integration | Includes `lpSmokeTest.js` (7 checks) |
| **LP template extraction** | `backend/services/lpTemplateExtractor.js` | `extractTemplate()` | Puppeteer capture + Claude vision → skeleton HTML + design brief | Extracts reusable templates from any URL |
| **Meta integration** | `backend/services/metaAds.js` | `syncPerformance()`, `getAdInsights()`, `getAuthUrl()`, `exchangeCodeForToken()` | Per-project OAuth, token refresh, performance data sync | 30-min sync interval |
| **Central data layer** | `backend/convexClient.js` | 140+ helper functions, mapper functions, field whitelists | All Convex CRUD operations | ~1400 lines. Bottleneck for all data access. |
| **Cost tracking** | `backend/services/costTracker.js` | `logAnthropicCost()`, `logOpenAICost()`, `logGeminiCost()` | Auto-tracks all LLM spend per operation + project | Fire-and-forget |
| **Database schema** | `convex/schema.ts` | 29 table definitions | Full data model with indexes | Schema changes require separate deploy |
| **Frontend API** | `frontend/src/api.js` | 164 API methods | All frontend-to-backend communication | `streamSSE()` for long-running ops |
| **Ad Studio UI** | `frontend/src/components/AdStudio.jsx` | Single ad generation UI | Mode 1 (inspiration) + Mode 2 (template) | ~2500 lines |
| **Batch Manager UI** | `frontend/src/components/BatchManager.jsx` | Batch creation/monitoring UI | Schedule, angle, template selection | ~2500 lines |
| **Dead code** | `backend/services/conductorAngles.js` | `generateAngles()` | Was meant to auto-generate angles — never imported by any production file | Zero callers |

---

## 4. Inputs That Shape Creative Output

### Brand & Product Inputs

| Input | Source | Where Used | Control Over Output |
|-------|--------|-----------|-------------------|
| `brand_name` | Project creation form | Injected into every prompt (creative director, brief extraction, headline gen, body copy, image prompt, LP copy) | High — appears in all generated copy |
| `niche` | Project creation form | Creative director prompt: "a {niche} brand that..." | Medium — sets category context |
| `product_description` | Project creation form | Every prompt stage | High — grounds all copy in product reality |
| `sales_page_content` | Pasted or uploaded at project setup | Foundational doc generation (Step 1 input) | High — raw material for all downstream research |
| `product_image` (storageId) | Uploaded per project | Sent to GPT (vision) during image prompt gen + sent to Gemini for image generation | Medium — Gemini uses it as compositing reference |
| `prompt_guidelines` | Per-project text field | Applied after image prompt generation via `reviewPromptWithGuidelines()` (GPT-4.1-mini) | Medium — post-hoc correction of prompts |

### Research & Avatar Inputs

| Input | Source | Where Used | Control Over Output |
|-------|--------|-----------|-------------------|
| `research` doc | o3-deep-research (Step 4) | Brief extraction, creative director prompt, LP copy generation | Very high — raw language, quotes, pain points |
| `avatar` sheet | GPT-4.1 synthesis (Step 5) | Brief extraction, LP copy, image prompt context | High — defines who ads speak to |
| `offer_brief` | GPT-4.1 synthesis (Step 6) | Brief extraction, objection handling, LP copy | Medium — positioning and mechanism |
| `necessary_beliefs` | GPT-4.1 synthesis (Step 8) | Brief extraction, LP editorial pass | Medium — max 6 beliefs to activate |

### Quote & Language Inputs

| Input | Source | Where Used | Control Over Output |
|-------|--------|-----------|-------------------|
| `quote_bank` entries | Perplexity + Claude mining | Brief extraction selects "RELEVANT QUOTES FROM LANGUAGE BANK" (max 8) per angle. Also used for per-quote headline generation. | Medium — provides tone/specificity anchors but copy doesn't copy verbatim |
| `headline_ref_1/2/3` | 3 reference copywriting docs (stored in settings) | Quote-based headline generation (`headlineGenerator.js`) | Medium — provides exemplar style (not used in batch pipeline) |

### Angle & Strategy Inputs

| Input | Source | Where Used | Control Over Output |
|-------|--------|-----------|-------------------|
| `conductor_angles.name` | Manually created by operator | Injected into brief extraction prompt, batch angle field, flex ad grouping | Very high — determines what the ad is about |
| `conductor_angles.prompt` | Manually written by operator | Full text injected as `angle_prompt` on batch, used in generation | Very high — direct LLM instruction |
| `conductor_playbooks` | Auto-generated from learning step | Injected into angle prompt as "CREATIVE DIRECTION FROM PREVIOUS ROUNDS" | Medium — guides visual/copy patterns, avoid patterns |
| `focused` flag on angle | Operator toggle | If any angle is focused, Director only uses focused angles | High — controls angle selection |

### Visual Inputs

| Input | Source | Where Used | Control Over Output |
|-------|--------|-----------|-------------------|
| Template images | User-uploaded reference ads | Sent to GPT-5.2 (vision) or Claude Sonnet (vision) for style analysis during image prompt generation | High — defines visual layout, composition, style |
| Inspiration images | Google Drive sync | Same role as template images but from Drive folder | High — same as template images |
| Aspect ratio | Selected per batch or per ad | Passed to Gemini image generation config | Low — changes dimensions only |
| Image model | `nano-banana-pro` or `nano-banana-2` | Gemini model selection | Medium — quality/speed tradeoff |

### LP-Specific Inputs

| Input | Source | Where Used | Control Over Output |
|-------|--------|-----------|-------------------|
| Swipe URL | Operator-provided URL for design reference | Puppeteer capture → Claude vision design analysis | High — defines LP layout, colors, typography |
| LP templates | Extracted from URLs via `lpTemplateExtractor.js` | Skeleton HTML + design brief for LP generation | High — structural constraint |
| Narrative frames | System-defined: testimonial, mechanism, problem_agitation, myth_busting, listicle | Selected per LP, drives copy structure | High — determines LP storytelling approach |
| `lp_agent_config` | Per-project config | Controls LP auto-generation: enabled, templates, Shopify credentials | High — on/off switch + publishing target |

### Config Inputs

| Input | Source | Where Used | Control Over Output |
|-------|--------|-----------|-------------------|
| `conductor_config.daily_flex_target` | Per-project config (default 5) | Director deficit calculation | Controls volume, not quality |
| `conductor_config.ads_per_batch` | Per-project config (default 18) | Batch size | Controls volume, not quality |
| `scout_score_threshold` | Per-project (default 7) | Filter pass/fail threshold | High — directly controls quality floor |
| `scout_daily_flex_ads` | Per-project (default 2) | Max flex ads per day from Filter | Controls volume |

### Randomness / Seed Logic

- **Template/inspiration image selection**: Random selection from available pool when not specified (`adGenerator.js` picks random inspiration image if none specified)
- **Sub-angle generation**: LLM generates 4 sub-angles per batch — different each run, no seed
- **Headline ranking**: Self-scored by the LLM (no external ground truth)
- **No explicit random seeds**: All variation comes from LLM temperature (default) and input permutation

---

## 5. Prompt Architecture

### Single Ad Flow (Mode 1/Mode 2)

```
Step 1: Creative Director Init (GPT-5.2)
  System: "World-class creative director and image generation expert"
  Input: brand_name, niche, product_description + 4 full foundational docs verbatim
  Output: GPT acknowledges role

Step 2: Image Request (GPT-5.2, same conversation)
  Input: "make a prompt for an image like this" + inspiration/template image (vision)
         + optional: angle, headline, body_copy, product_image, aspect_ratio
  Output: Full image generation prompt with layout/composition/text instructions

Step 3 (optional): Prompt Guidelines Review (GPT-4.1-mini)
  Input: image prompt + project-level guidelines
  Output: Revised prompt (minimal edits for compliance)

Step 4: Image Generation (Gemini 3 Pro or 3.1 Flash)
  Input: image prompt text + optional product image (inline data)
  Output: Generated image (2K resolution)

Step 5 (parallel, non-blocking): Headline/Body Extraction (GPT-4.1-mini)
  Input: image prompt text
  Output: JSON { headline, body_copy } extracted from prompt
```

### Batch Pipeline Flow (Stages 0-3 + Image Gen)

```
Stage 0: Brief Extraction (Claude Opus 4.6)
  System: "Direct response research analyst"
  Input: 4 foundational docs + angle name
  Output: Angle-specific brief with 7 sections:
    - Avatar in this moment (3-4 sentences)
    - Relevant pain points (max 5)
    - Relevant quotes from language bank (max 8)
    - Relevant beliefs (max 3)
    - Relevant objections (max 4)
    - Emotional entry point (1 sentence)
    - Specificity anchors (max 6)

Stage 1: Headline Generation (Claude Opus 4.6)
  System: "World-class direct response copywriter for women 55-75"
  Input: Brief sections (avatar, emotional entry, pain points, quotes, anchors)
         + angle name + brand/product info
  Process: 3-step prompt:
    1. Generate 4 sub-angles (different emotional entries + speaker perspectives)
    2. Generate N headlines (12-word max, distributed across sub-angles)
    3. Self-score on 4 criteria (scroll stop, specificity, uniqueness, real human)
  Constraints:
    - 25% first-person, 25% concrete sensation, 25% open loop, 15% pattern interrupt
    - No repeated opening words or structures
    - 17 banned phrases
    - Good/bad calibration examples included
  Output: JSON with sub_angles array + scored/ranked headlines array

Stage 2: Body Copy Generation (Claude Sonnet 4.6)
  System: "Direct response copywriter for women 55-75 with chronic pain, broken sleep..."
  Input: Headlines (batches of 5) + reference quotes + beliefs to activate
  Constraints:
    - Max 90 words per body copy
    - Must include 1 specific detail (time, body part, failed solution)
    - Must not repeat headline text
    - End with reason to click (not generic CTA)
    - Structure variation: >= 1 story continuation, >= 1 problem-agitate, >= 1 social proof
    - 7 banned phrases
  Output: JSON with body_copies array (headline, body_copy, structure, word_count, specific_detail)

Stage 3: Image Prompt Generation (Claude Sonnet 4.6, with vision)
  System: "Creative director generating prompts for text-to-image AI"
  Input: Brand info + aspect ratio + headline + body copy + primary emotion + template image (vision)
  Process:
    - Analyze template: layout, color palette, typography, badges, composition
    - Generate prompt recreating template style for brand
    - EXACT headline text must be placed in dominant position
    - Support emotional tone with visual mood
  Critical rule: "The headline and body copy are FINAL. Do not rewrite, shorten, improve, or paraphrase them."
  Output: Single text block image generation prompt

Image Generation: Gemini Batch API (Gemini 3 Pro)
  Input: All image prompts + optional product images
  Config: 2K resolution, specified aspect ratio
  Output: Generated images (processed individually, retried once if batch entry fails)
```

### Director Playbook Injection

When the Director creates a batch, it appends to the angle prompt:
```
CREATIVE DIRECTION FROM PREVIOUS ROUNDS:
- Visual approach: {visual_patterns from playbook}
- Copy approach: {copy_patterns from playbook}
- AVOID: {avoid_patterns from playbook}
- Current pass rate: {pass_rate}%
```

### Current Prompt Weaknesses

1. **Creative director prompt dumps all 4 foundational docs verbatim** into a single context window. These documents can be very long (research doc alone can be 6+ pages). This dilutes attention — the LLM gets everything but focuses on nothing specific. The brief extraction (Stage 0) partially addresses this for batch mode, but single-ad mode still sends everything.

2. **"Make a prompt for an image like this"** is the core instruction for image generation. It's extremely terse and relies entirely on GPT's vision interpretation of the reference image. No structured decomposition of what to replicate vs what to change.

3. **Self-scoring is not calibrated**. Headlines are scored 1-10 by the same LLM that wrote them. There's no external benchmark, no comparison to actual winners, no human-validated scoring rubric. LLMs tend to rate their own output favorably.

4. **Body copy constraint is word-count-based, not impact-based**. The 90-word max is useful but doesn't enforce emotional arc, hook strength, or conversion persuasion structure. A 90-word block of filler would pass.

5. **Image prompts are one-shot from a single template reference**. There's no mechanism to say "use the layout of template A but the color palette of template B and the typography approach of template C." It's always one reference image → one prompt.

6. **No negative examples in batch prompts**. The headline prompt includes "BAD" examples, but the body copy and image prompt stages do not include any examples of what to avoid (beyond banned phrases).

7. **Playbook injection is free-text, not structured**. Visual/copy/avoid patterns are natural language strings from the learning step. If the learning step produces vague advice ("use warmer colors"), the next batch gets vague guidance.

8. **No persona consistency across headline + body + image**. Each stage generates independently. A first-person confessional headline might get paired with a clinical third-person body copy and a stock-photo-style image because there's no explicit threading of voice/persona across stages.

---

## 6. Variant Generation Logic

### What is being varied?

| Element | How It Varies | Controlled or Random |
|---------|--------------|---------------------|
| **Angle** | Selected by Director from `conductor_angles` (operator-defined) | Controlled — round-robin or focused mode |
| **Sub-angles** | 4 generated per batch by LLM (emotional entry + speaker perspective) | Semi-random — LLM chooses, different each run |
| **Headlines** | N generated per batch (distributed across sub-angles), ranked by self-score | Semi-random — top N selected by self-score |
| **Body copy** | 1 per headline, structure type varied (story/agitate/proof) | Controlled — minimum 1 of each structure type per batch of 5 |
| **Template/inspiration image** | Selected per batch (single or multi-select from uploaded pool) | Operator-controlled (or random from pool) |
| **Image prompt** | 1 per ad, derived from template vision analysis | Semi-random — same template can produce different prompts each call |
| **Generated image** | 1 per prompt, from Gemini | Random — no seed control |
| **LP narrative frame** | Selected from 5 predefined frames (testimonial, mechanism, problem_agitation, myth_busting, listicle) | Controlled — system selects different frames per batch |

### What is fixed per batch?

- Angle (1 per batch)
- Aspect ratio
- Product image reference
- Template image(s) or inspiration image(s)
- Foundational docs (same 4 docs for all ads in batch)
- Brief packet (same for all headlines in batch)

### Variant Families

Ads are grouped by angle, not by concept. A batch of 18 ads for angle "Fear of Chemicals" will have:
- 4 sub-angles (each a different emotional take on the same angle)
- ~5 headlines per sub-angle
- 1 body copy per headline
- 1 image per ad (each from potentially the same template)

The Filter then groups the top-scoring ~10 ads from the batch into 1 flex ad. This flex ad is the "variant family" that goes to Meta.

### Is there deduplication?

- **Template IDs**: Batch tracks `used_template_ids` across runs to avoid reusing the same template image in consecutive batches.
- **Headlines**: No dedup. Two batches for the same angle can produce similar headlines.
- **Body copy**: No dedup.
- **Images**: No dedup. Similar prompts will produce similar-looking images.
- **Flex ads**: No dedup. Can create multiple flex ads with overlapping copy.

### Is there a "creative hypothesis"?

No explicit hypothesis tracking. The angle is the closest thing to a hypothesis, but angles are static labels (e.g., "Fear of Chemicals", "Grounding Sleep Science") without measurable predictions. The playbook system tracks what worked per angle, but doesn't frame it as "we're testing hypothesis X."

### Is there logic to prevent low-signal randomness?

Partially:
- Sub-angle generation forces emotional/perspective diversity within a batch
- Headline distribution rules (25% first-person, 25% sensation, 25% open loop, 15% pattern interrupt) prevent monoculture
- Self-scoring with ranking means worst headlines get dropped (overgenerate 20%, take top N)
- But there's no mechanism to say "this batch is specifically testing short vs. long headlines" or "this batch is testing social proof vs. fear" — variation is organic, not experimental

---

## 7. Quality Control and Filtering

### Pre-Generation Quality Controls

| Check | Where | What It Does |
|-------|-------|-------------|
| Headline word count | `adGenerator.js` Stage 1 prompt | "MAXIMUM 12 WORDS" instruction (not enforced programmatically — relies on LLM compliance) |
| Banned phrases | `adGenerator.js` Stage 1 prompt | 17 phrases listed in prompt (not enforced programmatically) |
| Body copy word count | `adGenerator.js` Stage 2 prompt | "MAXIMUM 90 WORDS" instruction (not enforced programmatically) |
| Structure variation | `adGenerator.js` Stage 2 prompt | Requires min 1 of each type per batch of 5 (not verified post-generation) |
| Headline self-scoring | `adGenerator.js` Stage 1 | LLM scores own headlines 1-10 on 4 criteria, ranks them |
| Prompt guidelines review | `adGenerator.js` | Optional GPT-4.1-mini pass to enforce project-level rules |

### Post-Generation Quality Controls (Creative Filter)

| Check | Where | Threshold | Enforced? |
|-------|-------|-----------|-----------|
| Vision scoring | `agents/score.sh` | >= 7/10 (4 weighted criteria) | Yes — ads below threshold are tagged "Filter Rejected" |
| Spelling & grammar | `agents/score.sh` hard requirements | Zero errors (conversational tone/styling exempt) | Yes — auto-fail |
| First-line hook | `agents/score.sh` hard requirements | Primary text must start with pattern interrupt | Yes — auto-fail |
| CTA at end | `agents/score.sh` hard requirements | Clear action statement required | Yes — auto-fail |
| Headline-ad alignment | `agents/score.sh` hard requirements | Headline must reinforce angle | Yes — auto-fail |
| Image completeness | `agents/score.sh` hard requirements | No blank spaces (product not required in every image) | Yes — auto-fail |
| Copy quality for flex ads | `agents/group.sh` | Thematic alignment, broad enough for all images, variety | Yes — copy that fails is excluded from flex ad |

### LP Quality Controls

| Check | Where | What It Does |
|-------|-------|-------------|
| Visual QA | `lpGenerator.js:runVisualQA()` | Puppeteer screenshot + Claude vision scoring (0-100), up to 3 attempts |
| Auto-fix | `lpAutoFixer.js` | Deterministic fixes (contrast CSS, placeholders) + LLM fixes (broken images, layout) |
| Smoke test | `lpSmokeTest.js` | 7 post-publish checks: HTTP 200, load <15s, no placeholders, headline present, 50%+ images load, valid CTAs, no mobile overflow |
| Post-processing | `lpGenerator.js:postProcessLP()` | Placeholder strip, contrast CSS, testimonial dedup, empty element cleanup |
| Opus editorial pass | `lpGenerator.js` | Claude Opus 4.6 reviews LP copy for strategic content decisions |

### Human Approval Steps

| Step | Where | Required? |
|------|-------|-----------|
| Review flex ads in Ready to Post | `ReadyToPostView.jsx` | Yes — operator must click "Mark as Posted" |
| Angle creation | `AgentMonitor.jsx` / conductor config | Yes — operator defines angles manually |
| Foundational doc approval | `FoundationalDocs.jsx` | Optional — docs have `approved` flag but generation proceeds regardless |
| Quote bank review | `QuoteMiner.jsx` | Optional — quotes can be deleted but no formal approval gate |

### Likely QC Gaps

1. **No programmatic enforcement of prompt constraints**. The 12-word headline max, 90-word body max, banned phrases, and structure variation rules are all in the LLM prompt — none are verified after generation. An LLM that ignores a constraint produces output that enters the pipeline unchecked.

2. **Self-scoring is the only headline ranking mechanism**. The same LLM that wrote the headlines also scores them. No external calibration, no comparison to known winners, no human-in-the-loop scoring.

3. **No image quality check beyond "completeness"**. The Filter checks for blank spaces but does not detect: AI artifacts (distorted faces, extra fingers), wrong product shown, illegible text overlays, poor contrast between text and background, or images that look obviously AI-generated.

4. **No copy-to-image coherence check**. A headline about "2 AM sleeplessness" could be paired with a bright sunny lifestyle image. Nothing enforces that the generated image matches the emotional register of the copy.

5. **No competitive uniqueness check**. Ads are not compared against competitor ads or the brand's own recent ads. The same visual concept could be regenerated across batches.

6. **Meta compliance check relies entirely on LLM judgment**. The 25%-weighted "Meta Compliance" score is Claude's opinion — not validated against Meta's actual ad review policies or API.

7. **Filter vision scoring degrades gracefully but silently**. If image download fails, scoring falls back to text-only (loses 20% of evaluation). The operator is not alerted.

8. **LP Opus editorial pass has no rejection path**. It reviews and suggests improvements, but there's no mechanism for it to say "this LP is too weak to publish — regenerate."

---

## 8. Meta and Campaign Integration

### Campaign Structure (In-App)

The system maintains its own campaign hierarchy in Convex:
```
campaigns (project-scoped)
  → ad_sets (within campaign)
    → flex_ads (within ad set, the actual ad packages)
      → ad_deployments (individual image-to-ad mappings)
```

This hierarchy is created within the app — it does NOT automatically create campaigns/ad sets in Meta Ads Manager. The operator must manually replicate this structure in Meta.

### What Gets Posted

A flex ad package contains:
- Up to 10 images (from scored ads)
- 3-5 headlines
- 3-5 primary texts
- Destination URL (landing page or product page)
- Display link, CTA button, Facebook page name
- LP URLs (primary + secondary from gauntlet)

The operator takes this package and manually creates the ad in Meta Ads Manager. The system does not use the Meta Marketing API to create or push ads.

### Meta Performance Sync

**Yes, performance data is synced.** Every 30 minutes per project, `scheduler.js` calls `metaAds.syncPerformance()`:

- Fetches from Meta Ads API v21.0: `getAdInsights(projectId, adId, sinceDays=30)`
- Metrics: impressions, clicks, spend, reach, CTR, CPC, CPM, frequency, conversions, conversionValue
- Stored in `meta_performance` table, upserted by `(meta_ad_id, date)` composite key
- Displayed in PostedView.jsx

### What's NOT Integrated

- **No automatic ad creation in Meta** — ads are not pushed via API
- **No bid cap, budget, or targeting management** — all done manually in Meta
- **No A/B test setup** — operator creates ad sets manually
- **Performance data is NOT fed back into the learning loop** (see Section 9)
- **No automatic pausing of underperforming ads**
- **No ROAS-based angle prioritization**

### Ad ID Storage

- `ad_deployments.meta_ad_id` — stores Meta's native ad ID (set manually or via sync)
- `ad_deployments.meta_campaign_id`, `meta_adset_id` — Meta's native IDs
- `meta_performance.meta_ad_id` — links performance data to Meta's ad

---

## 9. Performance Feedback Loop

### Is there a feedback loop?

**Partial — but the most important signal (Meta performance) is disconnected.**

The system has two feedback paths:

**Path A: Filter → Playbook → Director (ACTIVE)**
```
Creative Filter scores batch ads (vision-based, 7/10 threshold)
  → Learning step identifies winners (≥7) and losers (<7)
  → Updates conductor_playbooks per angle:
      visual_patterns: "what worked visually"
      copy_patterns: "what headlines/copy themes worked"
      avoid_patterns: "what didn't work"
  → Director injects playbook into next batch's angle prompt
  → Next batch is influenced by what previously scored well
```

This loop uses **Filter scores** (Claude Sonnet's opinion of creative quality) as the signal. It does NOT use actual Meta performance.

**Path B: Meta Performance → Display Only (DEAD END)**
```
Meta API synced every 30 min → meta_performance table → PostedView.jsx
```

Performance data is collected and displayed, but never read by:
- `conductorEngine.js` (does not query `meta_performance`)
- `conductorLearning.js` (only reads Filter scores, not Meta metrics)
- `adGenerator.js` (no performance awareness)
- `filter.sh` (scores based on creative quality, not actual results)

### What metrics are available in code?

Available (synced from Meta): impressions, clicks, spend, reach, CTR, CPC, CPM, frequency, conversions, conversionValue

### What metrics are missing?

- **ROAS** (return on ad spend) — not computed
- **Cost per acquisition (CPA)** — not computed
- **Landing page conversion rate** — not tracked
- **Thumb-stop ratio** — not available from Meta API
- **Hold rate** (video) — N/A (static images only)
- **Ad fatigue signals** — not computed (would need frequency + CTR decay)
- **LP-to-purchase attribution** — not tracked

### Is there any winner classification logic?

**No.** There is no code that classifies an ad as a "winner" or "loser" based on Meta performance. The only classification is the Filter's vision-based score (≥7 = pass, <7 = fail). An ad that the Filter calls a winner might get $0.01 CPC or $10.00 CPC — the system doesn't know or react.

### Bottom Line

**This is a generator plus exporter with an internal quality filter, but no true learning from real-world results.**

The system generates high volumes of creative, uses an AI-based quality filter to select the best candidates, packages them for deployment, and syncs performance data for human review. But the learning loop is closed only within the AI's own quality assessments — not from actual market signals. The playbook system is a genuine attempt at learning, but it learns from what Claude thinks is good, not from what Meta users actually respond to.

---

## 10. Data Model and Storage

### Database

**Convex** (cloud-hosted, schema-enforced) — 29 tables. Schema: `convex/schema.ts`.

### Key Tables

| Table | Purpose | Key Fields |
|-------|---------|-----------|
| `projects` | Brand + product info, Meta OAuth, Filter config | `brand_name`, `niche`, `product_description`, `sales_page_content`, `product_image_storageId`, `meta_*`, `scout_*` |
| `foundational_docs` | Research, avatar, offer brief, beliefs | `project_id`, `doc_type` (research/avatar/offer_brief/necessary_beliefs), `content`, `version`, `approved` |
| `quote_bank` | Mined emotional quotes + per-quote headlines | `project_id`, `run_id`, `quote`, `source`, `emotion`, `emotional_intensity`, `headlines` (JSON string array), `tags` |
| `ad_creatives` | Generated ad records | `project_id`, `headline`, `body_copy`, `image_prompt`, `storageId`, `angle`, `batch_job_id`, `tags`, `generation_mode` |
| `batch_jobs` | Batch pipeline state + tracking | `project_id`, `batch_size`, `angle`, `pipeline_state` (JSON), `status`, `filter_assigned`, `filter_processed`, `posting_day`, `angle_name`, `lp_*` fields |
| `campaigns` | Campaign hierarchy | `project_id`, `name`, `sort_order` |
| `ad_sets` | Ad set within campaign | `campaign_id`, `project_id`, `name` |
| `flex_ads` | Multi-variant ad packages | `ad_set_id`, `child_deployment_ids` (JSON), `primary_texts` (JSON), `headlines` (JSON), `destination_url`, `angle_name`, `posting_day`, `lp_*_url`, `gauntlet_lp_urls` (JSON) |
| `ad_deployments` | Individual ad → deployment mapping | `ad_id`, `project_id`, `status` (selected/ready_to_post/posted/analyzing), `flex_ad_id`, `meta_ad_id`, `posted_by` |
| `meta_performance` | Synced Meta metrics per ad per day | `deployment_id`, `meta_ad_id`, `date`, `impressions`, `clicks`, `spend`, `ctr`, `cpc`, `cpm`, `conversions` |
| `conductor_config` | Per-project Director settings | `project_id` (PK), `daily_flex_target`, `ads_per_batch`, `angle_mode`, `run_schedule` |
| `conductor_angles` | Operator-defined advertising angles | `project_id`, `name`, `prompt`, `status` (active/paused), `focused` |
| `conductor_runs` | Director run history | `project_id`, `batches_created` (JSON), `angles_generated` (JSON) |
| `conductor_playbooks` | Learned patterns per angle | `project_id`, `angle_name`, `visual_patterns`, `copy_patterns`, `avoid_patterns`, `pass_rate` |
| `landing_pages` | Generated LP records (40+ fields) | `project_id`, `copy_sections` (JSON), `image_slots` (JSON), `html_template`, `assembled_html`, `qa_score`, `hosting_metadata` (JSON) |
| `lp_templates` | Extracted LP templates | `project_id`, `skeleton_html`, `design_brief` (JSON), `slot_definitions` (JSON) |
| `api_costs` | All LLM spend tracking | `service`, `operation`, `cost_usd`, `project_id`, `period_date` |
| `settings` | Global config (API keys, rates, references) | Key-value pairs |

### File Storage

- **Convex blob storage** — all generated images, product images, template images, LP screenshots
- **No local filesystem storage** for generated assets (thumbnail cache at `backend/.thumb-cache/` only)
- **Shopify Pages** — published landing pages hosted on Shopify

### JSON-Encoded Fields

Many array/object fields are stored as `v.string()` and require `JSON.parse()`/`JSON.stringify()`:
- `batch_jobs`: `angles`, `gpt_prompts`, `pipeline_state`, `template_image_ids`, `inspiration_image_ids`, `gauntlet_lp_urls`
- `flex_ads`: `child_deployment_ids`, `primary_texts`, `headlines`, `gauntlet_lp_urls`, `destination_urls_used`
- `ad_deployments`: `primary_texts`, `ad_headlines`
- `quote_bank`: `headlines`, `tags`
- `landing_pages`: `copy_sections`, `image_slots`, `cta_links`, `editorial_plan`, `audit_trail`

### Config Files

| File | Purpose |
|------|---------|
| `dacia-creative-filter/config/filter.conf` | Filter budget ($20/day), models, score threshold (7), intervals |
| `dacia-fixer/config/fixer.conf` | Fixer budget ($1.33/day), models, check interval (5 min) |
| `deploy/ecosystem.config.cjs` | PM2 config (port 3001, 2GB max, single instance) |
| `deploy/nginx.conf` | Reverse proxy, SSL, 300s timeout, SSE support |
| `config/service-account.json` | Google Drive API service account (gitignored) |

### Naming Conventions

- Ad creatives: UUID `externalId` (no human-readable naming)
- Batch jobs: UUID `externalId`, display name `{projectName}_batch_{id_prefix}_{timestamp}` (for Gemini Batch API)
- Flex ads: `"Flex — {Angle} #{N} ({M} images)"`
- Ad sets: `"{Angle} — Flex #{N}"`
- LP URLs: determined by Shopify (handle-based)

---

## 11. Human Workflow

### What the system automates

| Step | Automated? | Notes |
|------|-----------|-------|
| Market research (deep research) | Yes | o3-deep-research + GPT-4.1 synthesis |
| Quote mining | Yes | Perplexity + Claude dual search |
| Batch scheduling | Yes | Director runs 3x daily |
| Angle selection per batch | Yes | Round-robin or focused mode |
| Headline generation | Yes | Claude Opus 4.6 with self-scoring |
| Body copy generation | Yes | Claude Sonnet 4.6 |
| Image prompt generation | Yes | Claude Sonnet 4.6 with vision |
| Image generation | Yes | Gemini Batch API |
| Quality scoring | Yes | Creative Filter (Claude Sonnet vision) |
| Flex ad assembly | Yes | Filter groups winners |
| LP generation + publishing | Yes | Auto-gen pipeline with Shopify publish |
| Meta performance sync | Yes | 30-min polling |
| Batch resurrection | Yes | Fixer re-triggers stuck batches |
| Self-healing (test + fix) | Partially | Fixer diagnoses but doesn't auto-deploy fixes |

### What the operator still does manually

| Step | Why Manual | Impact |
|------|-----------|--------|
| **Create projects** | One-time brand setup | Must enter brand info, product description, sales page content |
| **Define angles** | Strategic decision — what to advertise about | Angles are the most important creative input. Weak angles = weak ads regardless of pipeline quality. |
| **Upload template/inspiration images** | Curated reference material | Quality of reference images directly shapes generated ad style |
| **Review and approve foundational docs** | Optional but important | Bad research = bad everything downstream |
| **Review flex ads in Ready to Post** | Human approval gate | Only chance to catch bad creative before it goes to Meta |
| **Create ads in Meta Ads Manager** | No Meta API integration for ad creation | Operator must manually create campaign, ad set, upload images, paste copy |
| **Mark ads as "Posted"** | Confirms ad is live | Required for performance tracking to work |
| **Monitor performance in Posted view** | Human judgment on what's working | System collects data but doesn't act on it |
| **Adjust angles based on results** | No automated angle learning from Meta | Operator must manually pause weak angles, create new ones |
| **Manage Meta OAuth tokens** | Per-project setup | Must complete OAuth flow for each project |
| **Review LP quality** | Optional — auto-published to Shopify | Operator may not see LPs before they go live |

### Key Bottleneck

The biggest manual bottleneck is **angle management**. The system generates ads based on angles, but deciding which angles to create, which to pause, and which to double down on is entirely manual. The playbook system learns what visual/copy patterns work within an angle, but it doesn't suggest new angles or retire failing ones based on actual Meta performance.

---

## 12. Bottlenecks and Likely Causes of Mediocre Creative

### 1. Learning loop is closed within AI opinion, not market reality

**Where**: `conductorLearning.js` reads Filter scores (Claude's opinion); `meta_performance` table exists but is never queried by any generation or learning code.

**Impact**: The system optimizes for what Claude thinks is a good ad. An ad that scores 9/10 from the Filter might get terrible CTR. An ad that scores 6/10 might crush. The system has no way to know and can't course-correct.

### 2. Angle quality is entirely dependent on operator expertise

**Where**: `conductor_angles` table — `name` and `prompt` are manually written by the operator.

**Impact**: A vague angle like "Sleep Quality" will produce generic ads. A specific angle like "The 2 AM Betrayal — When Your Body Wakes You Up And Won't Let You Go Back" will produce focused ads. The system amplifies angle quality but can't improve it.

### 3. Template images are the only visual anchor — and they may be stale

**Where**: `adGenerator.js:buildImageRequestText()` — "make a prompt for an image like this" with a single reference image.

**Impact**: If the same 10 template images are used for months, generated ads will converge on the same visual patterns. No mechanism to inject fresh visual directions or test new styles. Template fatigue is invisible to the system.

### 4. Headline self-scoring has no calibration to real performance

**Where**: `adGenerator.js:generateHeadlines()` Step 3 — "Score your own headlines" with 4 criteria.

**Impact**: Self-scoring creates the illusion of quality ranking without actual quality signal. The best-ranked headline by Claude's self-assessment may not be the best headline for the audience. Over time, this could create a systematic bias toward headlines that LLMs prefer (clever, literary) vs. what real users respond to (simple, direct, ugly).

### 5. Copy and image are generated independently with weak coherence

**Where**: Stage 2 (body copy) runs without knowledge of what the image will look like. Stage 3 (image prompt) tries to incorporate headline/body, but image generation is a separate Gemini call that may not perfectly execute the prompt.

**Impact**: An ad is copy + image working together. When they're generated as separate artifacts, the emotional alignment between what the text says and what the image shows is coincidental, not intentional. The Filter's vision scoring catches gross misalignment but can't assess subtle coherence.

### 6. No concept-level testing — only unit-level generation

**Where**: The system generates individual ads, not ad concepts. There's no mechanism to define "concept: a 65-year-old woman holding the product while looking skeptical" and then generate 5 variations of that concept.

**Impact**: High volume of unrelated ads rather than systematic exploration of promising concepts. When a concept works, the system can't automatically generate more variants of it.

### 7. Flex ad grouping is per-batch, not cross-batch

**Where**: `agents/group.sh` clusters ads within a single batch into 1 flex ad.

**Impact**: The best image from batch A and the best headline from batch B can't be combined. Each flex ad is constrained to the ads from its batch. Cross-pollination of winning elements doesn't happen.

### 8. Brief extraction may be too aggressive in filtering

**Where**: `adGenerator.js:extractBrief()` — "extract ONLY the material directly relevant to this specific angle. Ignore everything else."

**Impact**: The brief extraction produces a focused but potentially narrow view. If the research document contains a powerful quote or insight that's tangentially related to the angle, it gets filtered out. This could cause the system to miss creative opportunities.

### 9. No image quality detection beyond "completeness"

**Where**: `agents/score.sh` Image Quality criterion (20% weight) — checks for blank spaces, professionalism, alignment with copy.

**Impact**: AI-generated images frequently have subtle quality issues (distorted hands, impossible text rendering, uncanny faces, wrong product depiction) that aren't caught. These ads enter the flex ad pipeline and get posted to Meta, where they hurt brand credibility and ad performance.

### 10. Overproduction with fixed quality floor, not rising quality ceiling

**Where**: `conductor_config.daily_flex_target` (default 5 flex ads/day × ~10 images each = 50 images/day minimum production).

**Impact**: The system is optimized for throughput (fill the daily flex ad quota) not for quality maximization (find the single best ad concept and iterate on it). The 7/10 Filter threshold is a floor, not a ceiling. An ad scoring 7.1/10 gets the same treatment as one scoring 9.5/10.

### 11. Playbook advice may be too generic to improve prompts

**Where**: `conductorLearning.js` generates natural language patterns like `visual_patterns: "warm lifestyle scenes with product in focus"`.

**Impact**: These patterns are injected into prompts as free text. If the advice is generic (which LLM-generated pattern descriptions often are), it adds tokens without adding precision. The next batch gets "use warm lifestyle scenes" — which is what it was already doing.

### 12. No A/B testing structure

**Where**: The system generates many variants but doesn't structure them as controlled experiments.

**Impact**: When 5 flex ads go live on the same day, there's no way to attribute performance differences to specific creative variables. Was it the headline? The image? The angle? The LP? The audience? Without structured testing, learning is anecdotal.

---

## 13. Highest-Leverage Improvements

| # | Improvement | Why It Matters | Where It Plugs In | Difficulty | Impact |
|---|------------|---------------|-------------------|------------|--------|
| 1 | **Connect Meta performance to learning loop** | The system collects CTR/CPC/ROAS data but never uses it. Closing this loop means the system learns from reality, not from AI self-assessment. | `conductorLearning.js` → query `meta_performance` table, weight playbook updates by actual performance, not just Filter scores | Medium | Very High |
| 2 | **Add winner replication** | When an ad gets exceptional Meta metrics, the system should automatically generate 5-10 variants of the same concept (same angle, similar headline structure, similar visual style). | New function in `conductorEngine.js` that detects high-performing ads via `meta_performance`, creates targeted "replication batches" with tighter prompts | Medium | High |
| 3 | **Structured visual direction instead of "make an image like this"** | Current approach sends a single reference image with a terse instruction. Decomposing the reference into structured elements (layout grid, color palette, typography, element placement) would give Gemini more precise guidance. | `adGenerator.js:buildImageRequestText()` → add structured vision analysis step before image prompt generation, similar to LP's `analyzeSwipeDesign()` | Medium | High |
| 4 | **Cross-batch element recombination** | Allow the system to combine the best headline from batch A with the best image from batch B. Currently flex ads are batch-scoped. | `agents/group.sh` or new service → query top-performing elements across recent batches for the same angle, create "best-of" flex ads | Medium | High |
| 5 | **External headline scoring against known winners** | Replace or augment self-scoring with comparison scoring: "Rate this headline against these 5 known winners for this angle." Feed actual Meta performance data to calibrate what "good" means. | `adGenerator.js:generateHeadlines()` Step 3 → add reference headlines from top-performing ads in `meta_performance` + `ad_creatives` join | Low | High |
| 6 | **Copy-image coherence scoring** | Add a post-generation check that evaluates whether the generated image matches the emotional register and content of the headline + body copy. | New step after image generation in `batchProcessor.js:processBatchResults()` — Claude vision scores coherence, flags mismatches | Low | Medium |
| 7 | **Image quality detection (artifacts, text legibility)** | Add specific checks for common AI image failures: distorted body parts, illegible text overlays, wrong product, uncanny faces. | `agents/score.sh` — add specific prompts for artifact detection, or add a separate pre-scoring image QA step | Low | Medium |
| 8 | **Automatic angle performance ranking** | Use Meta performance data to automatically rank angles by ROAS/CPC, flag underperformers, suggest pausing or adjusting. Surface this in the UI. | New function in `conductorEngine.js` or `conductorLearning.js` → query `meta_performance` grouped by `angle_name` via flex_ad → deployment → performance join | Medium | High |
| 9 | **Concept-level generation** | Instead of generating N independent ads, define "concepts" (a visual scene + emotional tone + copy approach) and generate N variants of each concept. This creates testable creative families. | Restructure Stage 1 to output concepts before headlines. Each concept = (sub-angle + visual direction + copy structure). Then generate 3-5 headlines per concept. | High | High |
| 10 | **Template freshness and diversity tracking** | Track how many times each template image has been used, its average pass rate, and its average Meta performance. Auto-retire underperforming templates, surface a "need new templates" alert. | Add `usage_count`, `avg_pass_rate`, `avg_cpc` fields to `template_images` or a new join table. Dashboard widget in `AgentMonitor.jsx`. | Low | Medium |

---

## 14. Open Questions / Unclear Areas

1. **How are ads actually created in Meta Ads Manager?** The system stages everything but doesn't push via API. Is there a documented SOP for the poster role? Is there a Chrome extension, a copy-paste workflow, or bulk upload via Meta Business Suite? Not found in codebase.

2. **What happens to `posted_by` and `posted_date` fields?** These are set when an operator clicks "Mark as Posted" but it's unclear how `meta_ad_id` gets linked back. Is the operator pasting Meta's ad ID into the system manually? Not clearly documented.

3. **How does the Fixer deploy its fixes?** `fixer.sh` can generate code fixes and commit to `fixer/auto-fixes` branch, but `AUTO_PUSH=false` by default. Who reviews and merges these fixes? Is there a PR workflow? Not found in codebase.

4. **What reference copywriting docs are used for headline generation?** `headline_ref_1/2/3` are stored in settings, used by `headlineGenerator.js` for quote-based headline generation. These are presumably uploaded by the operator, but their content and quality are unknown from the codebase alone.

5. **How is `conductorLearning.js`'s known bug affecting production?** The `messages.filter is not a function` bug is documented but unclear if it causes the entire learning step to fail silently or just one sub-step. If learning is broken, playbooks are stale.

6. **What Shopify store(s) are LP pages published to?** `lp_agent_config` has Shopify credentials per project, but the actual store URLs and how they integrate with the main brand's website are not clear from code alone.

7. **Is there monitoring/alerting beyond what Fixer provides?** Fixer runs health probes, but are there PagerDuty/Slack alerts for critical failures? Not found in codebase (no Slack/webhook integrations visible).

8. **What is the actual daily ad volume in production?** `daily_flex_target=5` with `ads_per_batch=18` suggests ~90 ads generated per day per project, with ~50 making it through the Filter. Actual production numbers would determine whether throughput or quality is the binding constraint.

9. **How are Meta ad accounts structured?** Per-project OAuth is clear, but whether each project maps to one ad account, one campaign, or multiple campaigns is operator-dependent and not enforced by the system.

10. **Is the `bodyCopyGenerator.js` service actively used?** It exists as a standalone service but the batch pipeline uses `adGenerator.js:generateBodyCopies()` directly. The standalone service may be legacy from a pre-batch-pipeline era.

11. **What is the `dacia-fixer/fix_ledger.md` institutional memory?** Described as "DO NOT DELETE" but its content and how it's used by the Fixer are unclear from the codebase structure alone.

12. **Are there any external dashboards or reporting tools?** The system has a built-in dashboard (`Dashboard.jsx`) with cost tracking, but whether operators use external tools (Google Sheets, Looker, etc.) to track creative performance is unknown.

---

## 15. Appendix: Key Files Worth Reading First

1. **`backend/services/adGenerator.js`** — The most important file. Contains all prompt construction for the batch pipeline (Stages 0-3), creative director prompts, and the logic that determines what ads look like. ~1300 lines.

2. **`dacia-creative-filter/filter.sh`** — The quality gate. Understanding how ads are scored and grouped into flex ads reveals what the system considers "good." ~1170 lines.

3. **`dacia-creative-filter/agents/score.sh`** — The actual scoring criteria and hard requirements. This is where the quality floor is defined.

4. **`dacia-creative-filter/agents/group.sh`** — How winning ads are clustered into flex ad packages. Controls what the operator actually sees in Ready to Post.

5. **`backend/services/conductorEngine.js`** — The Director/planner. Shows how batches are planned, angles selected, and playbooks injected. Controls the automation loop.

6. **`backend/services/conductorLearning.js`** — The learning mechanism. Shows what the system learns from and how it applies learnings. Has known bug.

7. **`backend/services/docGenerator.js`** — The foundational research pipeline. Quality of these docs determines quality of everything downstream.

8. **`backend/services/batchProcessor.js`** — Batch execution orchestration. Shows how pipeline stages are sequenced and how Gemini Batch API is called.

9. **`backend/services/lpGenerator.js`** — Landing page generation. ~2500 lines covering copy gen, HTML template, Visual QA, and post-processing.

10. **`backend/services/metaAds.js`** — Meta integration. Shows exactly what performance data is available and how it's synced (spoiler: it's synced but not used for learning).

11. **`convex/schema.ts`** — Full data model. 29 tables. Understanding the schema reveals what data exists and what relationships are tracked.

12. **`dacia-creative-filter/config/filter.conf`** — Filter configuration. Budget, models, thresholds, intervals.

13. **`backend/services/lpAutoGenerator.js`** — LP auto-generation flow. Shows how LPs are triggered by Director, wait for Filter, and publish to Shopify.

14. **`backend/services/quoteMiner.js`** — Quote mining pipeline. Shows how raw language is harvested from forums/Reddit for use in ad copy.

15. **`backend/convexClient.js`** — Central data layer. 140+ helper functions. If you need to understand how data is read/written, start here. ~1400 lines.

# Creative Factory — Changelog

## 2026-04-30 — Fix `max_tokens` 400 on GPT-5.2; body-copy Generate button matches sibling buttons exactly

**Bug A — Headline + Angle Generate buttons returned 400 from OpenAI**
- Marco saw: `400 Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.`
- Cause: commit `0976d83` migrated angle + headline routes to `gpt-5.2` while keeping the legacy `max_tokens` parameter. Reasoning-class models (gpt-5.x, o1, o3) reject `max_tokens` and require `max_completion_tokens`. The wrapper at `backend/services/openai.js:chat()` was passing options through verbatim with no normalization.

**Fix A — wrapper-level normalization (universal future-proofing)**
- `backend/services/openai.js` — `chat()` now normalizes `max_tokens` → `max_completion_tokens` before spreading apiOptions into the API call. Same upper-bound semantics; works on every OpenAI chat-completion model. Existing callers (`routes/upload.js`, `routes/settings.js`, `routes/ads.js`) keep working without changes; future callers using gpt-5.x are auto-fixed.
- Guard: `apiOptions.max_completion_tokens == null` check protects callers that already use the new param name.

**Bug B — body-copy Generate button visually mismatched the sibling buttons**
- The button used a refresh-arrow icon, `gap-1.5`, label-flipping (`Generate` / `Regenerate`), an input pre-condition gate (grayed out when no headline/angle), a `title` tooltip, and `disabled:cursor-not-allowed`. The angle/headline siblings use the sparkles icon, `gap-1`, static `Generate` label, and disable only while generating.

**Fix B — match the sibling pattern exactly**
- `frontend/src/components/AdStudio.jsx` — body-copy button now uses the sparkles icon, `gap-1`, `disabled={generatingBody}` only, no `title`, no extra cursor class, label always `Generate`. `handleRegenerateBody` drops the input pre-condition; backend handles the empty-input case via the project-context fallback.
- `backend/routes/ads.js` — `generate-body-copy` route falls back to `project.product_description → project.brand_name → project.name` when both headline and angle are empty. Only 400s when there's truly no usable text on the project record.

**Antipattern note for future devs**
- For OpenAI calls, prefer `max_completion_tokens` over `max_tokens`. The wrapper in `backend/services/openai.js:chat()` normalizes either to the new param name, but new code should write `max_completion_tokens` directly for clarity.

**Files modified**
- `backend/services/openai.js`
- `backend/routes/ads.js`
- `frontend/src/components/AdStudio.jsx`

**Out of scope**
- Migrating other Anthropic-using endpoints. They legitimately use Claude.
- Streaming the angle/headline/body-copy responses.
- Removing `max_tokens` references everywhere in favor of `max_completion_tokens`. Wrapper handles it transparently; future PR can refactor.
- `temperature` normalization for reasoning models (some restrict temperature). Not currently a problem.

---

## 2026-04-30 — Auto-collapse the Pick Template grid after a template is selected

**Request (Marco)**
- "When I use the Pick Template tab and I select a template, I have to scroll through all the templates to now get to the bottom. It would be nice if there's a way to collapse that menu so I could continue on there and make more adjustments and generate that."

**What changed**
- `frontend/src/components/AdStudio.jsx` — added `pickerCollapsed` state and an effect that mirrors it to `selectedTemplate`: selection present → grid auto-hides, compact pill shows; selection absent → grid auto-expands. The compact pill renders the selected template thumbnail, name, source label, and two buttons: **Change** (re-expand the grid without losing the selection) and **Clear** (deselect).
- The existing text indicator ("Selected: <name> (source) [Clear]") is gated to render only in expanded mode (it's redundant with the pill).
- The template-analysis card was hoisted out of the original `{selectedTemplate && (...)}` wrapper and now renders whenever there's a selection, regardless of collapsed/expanded state — the analysis info (layout, recommended style, product-image-needed flag) stays useful below the pill.
- Pill thumbnail has a fallback placeholder div if the underlying template was deleted between selection and render.

**Behavior**
- Click a template → grid disappears, pill appears, downstream form is immediately reachable. ✓
- Click Change → grid re-renders. Click a different template → auto-collapse to new pill. ✓
- Click Clear → selection cleared, grid expands. ✓
- Tab-leave (Manual Upload / Random Template) → prior fix clears `selectedTemplate`, this effect resets `pickerCollapsed` to false → next visit to Pick Template shows the grid. ✓
- handleRedo (Redo on a gallery ad) → sets `templateSource = SELECT` then `selectedTemplate`; effect fires → pill renders for the redo target. ✓

**Files modified**
- `frontend/src/components/AdStudio.jsx`

**Out of scope**
- Manual collapse before selection (no UX benefit when browsing).
- Per-section collapse (Drive vs Uploaded). One selection at a time.
- Slide/fade animation on collapse/expand. Future polish.
- Persisting `pickerCollapsed` across reloads. Selection is ephemeral.

---

## 2026-04-30 — Migrate Ad Studio's angle + headline generators off Anthropic; surface body-copy Generate button without requiring a headline

**Bug**
- Marco reported the Generate buttons above "Ad Topic / Angle" and "Headline" weren't working — they "still attached to the Anthropic key." Confirmed: `backend/routes/ads.js:165` and `:211` still called `claudeChat` with `claude-sonnet-4-6`. These were missed when commit `76c8109` migrated the *batch* pipeline off Anthropic. Marco's project doesn't have an Anthropic key set (intentionally — we removed that requirement for batches), so those single-ad helpers failed.

**Feature**
- Marco asked for a Generate button on the body-copy section. The button existed but was hidden behind a `headline.trim()` gate, AND the backend rejected missing-headline requests with 400.

**Fix (single commit, three logical changes)**
- `backend/routes/ads.js` — migrated `POST /generate-angle` and `POST /generate-headline` from `claudeChat` (`claude-sonnet-4-6`) to OpenAI's `chat` (`gpt-5.2`), matching the batch-pipeline pattern. Added `SINGLE_AD_TEXT_MODEL = 'gpt-5.2'` constant. Operation labels (`ad_angle_generation`, `ad_headline_generation`) and prompts are byte-identical so cost-tracking history is continuous (provider field flips Anthropic → OpenAI, operation field unchanged). Dropped the `claudeChat` import (no remaining call sites).
- `backend/routes/ads.js` — relaxed `POST /generate-body-copy` to accept either a headline OR an angle. When no headline is provided, the angle is used as the topic anchor passed into `generateBodyCopy`. Both must be empty for a 400; otherwise the existing `bodyCopyGenerator.js` (which already uses OpenAI / GPT-4.1-mini) handles generation.
- `frontend/src/components/AdStudio.jsx` — ungated the body-copy Generate button. It now always renders, and is `disabled={generatingBody || (!headline.trim() && !angle.trim())}` with a `title` tooltip for the disabled hint. `handleRegenerateBody` accepts angle-only input. Most discoverable UX: button is always visible, greys out until there's input to anchor copy generation.

**Antipattern note for future devs**
- Routes in `backend/routes/ads.js` are now OpenAI-only by design. Anthropic is retained ONLY for: LP generator, copywriter chat, conductor (Director) learning, quote miner, foundational doc generator, creative filter agent. Marco needs an Anthropic key for those features specifically.

**Pre-flight verification**
- `grep -n "claudeChat" backend/routes/ads.js` → zero matches after fix.
- `grep -n "generateAdBodyCopy" frontend/src/` → only AdStudio.jsx call site (no other consumers of the relaxed validator).

**Out of scope**
- Migrating LP generator / copywriter chat / conductor / quote miner / doc generator / filter agent off Anthropic — they legitimately use Claude.
- Streaming the angle / headline / body-copy responses (today: synchronous one-shot, ~5–10s spinner).
- Prompt-tuning for the angle-only body-copy path. Functional today; tighter results when a real headline is provided. Future polish if quality drops.

---

## 2026-04-30 — Fix product-image toggle silently flipping OFF when navigating template-source tabs

**Bug**
- Marco reported: "I went to the Pick Template tab — product image was turned ON. I clicked Manual Upload, then Random Template — and somehow the product image got switched OFF. It seems to happen when I click Manual Upload and then go back to Random Template."

**Root cause**
- In `AdStudio.jsx`, the template-analysis useEffect (deps: `[selectedTemplate?.id]`) calls `setSkipProductImage(!analysis.needs_product_image)` when an uploaded template is selected — sometimes synchronously (cached), sometimes asynchronously (API call).
- When the user clicked Pick Template and selected an uploaded template (`T1`), the API analyze call started in the background.
- When the user then clicked Manual Upload or Random Template, `selectedTemplate` was NOT cleared. The async `analyzeTemplate` call eventually returned, fired `setSkipProductImage(true)` AFTER the user had moved tabs — so the toggle visibly flipped OFF on whichever tab the user was now viewing. To Marco it looked like the act of switching tabs caused the flip.
- Additionally, the early-return path in the analysis useEffect (when no uploaded template is selected) reset `templateAnalysis` to null but left `skipProductImage` at its prior value — so any "off" decision made by a previous analysis lingered after deselect, switching to a Drive template, or other state changes.

**Fix (single commit, two surgical changes in `AdStudio.jsx`)**
- **Change A**: New `useEffect` on `[templateSource]`. When `templateSource` is no longer `TEMPLATE_SELECT` and `selectedTemplate` is set, clear `selectedTemplate`. This causes the analysis useEffect to re-run with a null selection — its existing `cancelled = true` cleanup blocks the in-flight API callback, and the early-return path runs.
- **Change B**: In the analysis useEffect's early-return path, also call `setSkipProductImage(false)`. The toggle returns to its default ON state whenever no analyzable template is selected (deselect, Drive template, tab leave via Change A).

**Coordination with handleRedo**
- `handleRedo` does `setTemplateSource(TEMPLATE_SELECT)` BEFORE `setSelectedTemplate(...)`. Change A's effect only fires when leaving SELECT, so it doesn't interfere — the redo flow correctly enters Pick Template with the right template selected and analysis fires.

**Antipattern note for future devs**
- Side effects that mutate state X based on state Y must clean up X when Y is no longer applicable. Otherwise stale X values linger and look like bugs to users.

**Files modified**
- `frontend/src/components/AdStudio.jsx` (~7 lines added)

**Out of scope**
- Manual-toggle persistence across template selections (existing UX inconsistency: an analysis still overrides a manually-set toggle when an uploaded template is selected). User did not report this as a bug.
- Visual feedback for in-flight analysis (greyed toggle / spinner). Future polish.

---

## 2026-04-30 — Fix two bugs: ad-detail modal opens off-screen + Heal Naturally product image disappears

**Bug A — Ad-detail modal opens far up the page**

Symptom: clicking an ad in the gallery opened the modal way above the current viewport; user had to scroll up to find it.

Root cause: `Layout.jsx` wraps every page in `<main className="... animate-fade-in-up">`. The `fade-in-up` keyframe in `tailwind.config.js` ended on `transform: 'translateY(0)'` with `forwards` fill mode, so `<main>` retained a non-`none` transform indefinitely. Per CSS spec, any element with a non-`none` `transform` becomes a containing block for fixed-positioned descendants — so the modal's `position: fixed; inset: 0` was calculated relative to `<main>`'s bounding box (which extends from below the navbar to the bottom of all rendered content), not the viewport. After scrolling, `<main>`'s top is way above the viewport, so the modal opened way above too.

Same antipattern existed in three CSS keyframes in `index.css` (`fadeIn`, `slideUp`, `slideInRight`).

Fix: change the final keyframe from `transform: translateY(0)` / `translateX(0)` / `scale(1)` to `transform: none`. Visually identical (translateY(0) and none look the same) but `none` does NOT create a containing block. Modal now opens dead-center in the viewport.

**Bug B — Heal Naturally product image disappeared on its own; ads now generate without it**

Symptom: Marco uploaded a product image, then it disappeared; subsequent ad generations no longer included the product image.

Root cause: storage-ID double-ownership between `projects.product_image_storageId` and `batch_jobs.product_image_storageId`. When a batch was created without uploading a separate image, `routes/batches.js:59` and `services/conductorEngine.js:227, 1065` set the batch's `product_image_storageId` field to the *exact same Convex storage ID* the project was using. Later, when ANY batch sharing that ID was deleted, `convex/batchJobs.ts:remove` unconditionally called `ctx.storage.delete(batch.product_image_storageId)`, which wiped the underlying blob. The project's field still pointed to the now-dead storage ID. Convex returned no URL for it; the UI showed no product image; ad-generation paths gracefully fell through to "no product image" because `downloadToBuffer` returns nothing for a dead storage ID. Hence "now it's making ads without it."

Fix (clean ownership):
- New helper `copyStorageBlob(sourceStorageId, contentType)` in `backend/utils/adImages.js` — downloads the source blob and re-uploads it to a new storage ID.
- `routes/batches.js`: when re-using project's image, copy buffer to new storage ID (with try/catch — if the project's source is already dead, log + proceed without).
- `services/conductorEngine.js`: same pattern at the two Director batch-creation sites, via local `copyProjectProductImageForBatch(project)` helper.
- `routes/projects.js`: GET project now self-heals — if `getStorageUrl` returns null for a set `product_image_storageId`, fire-and-forget call to `setProjectProductImage(undefined)` clears the dead pointer. Race-safe (idempotent patch). User sees "no image set" on next reload and can re-upload cleanly.

Storage cost of the copy: ~50–200 KB per batch, <$0.05/year at Marco's scale. Negligible.

**Antipattern note for future devs (animation keyframes)**
- NEVER end a CSS animation on `transform: translateY(0)` / `translateX(0)` / `scale(1)` with `animation-fill-mode: forwards`. Use `transform: none`. The two are visually identical but only `none` avoids creating a containing block for fixed-positioned descendants.

**Antipattern note for future devs (storage IDs)**
- NEVER share a Convex storage ID across two records (e.g., `project.product_image_storageId` and `batch.product_image_storageId`) without an explicit shared-ownership flag. The `remove` mutation of either record will unconditionally delete the blob. Always copy buffer to a new storage ID per record, even if it costs a small download/re-upload.

**Pre-flight verification**
- Grepped `frontend/src/index.css` and `frontend/tailwind.config.js` for `@keyframes` / `animation: ... forwards` — confirmed all four animation final-states updated.
- Grepped `backend/` for `project.product_image_storageId` direct assignments to a child record — found exactly the three sites fixed (routes/batches.js + 2x conductorEngine.js).

**Files modified**
- `frontend/tailwind.config.js`
- `frontend/src/index.css`
- `backend/utils/adImages.js` (added `copyStorageBlob` helper)
- `backend/routes/batches.js`
- `backend/services/conductorEngine.js`
- `backend/routes/projects.js`

**Out of scope**
- Backfill stale `product_image_storageId` on all projects (Layer 2 self-heals on read; one-shot Convex script overkill for hotfix).
- React portal refactor for modals (Layer 1 keyframe fix avoids the issue without portals).
- Auditing every other Convex storage-deletion path (focused grep confirmed only the project↔batch pair is affected; templateImages, adCreatives, inspirationImages own their storage IDs distinctly).
- `prefers-reduced-motion` support (future PR).

---

## 2026-04-30 — Fix dark "flash on scroll" caused by `:hover { translateY }` antipattern on cards

**Bug**
- Marco reported that scrolling down past the Generate Ad button toward the Ad Gallery caused a dark flash, repeatedly, in the area "right underneath the Generate Ad button" — a 600ms-cycle pulse of dark navy shadow on whatever card was crossing the cursor's screen Y position during scroll.

**Root cause**
- `.card:hover` defined `transform: translateY(-2px)` PLUS a heavier shadow + `bg-white/70`, all transitioned via `transition-all duration-300`. When the cursor was stationary and the page scrolled, every card whose top edge crossed the cursor's Y position would: (1) trigger `:hover`, (2) lift up by 2px (moving the card edge above the cursor), (3) end `:hover` (cursor no longer on it), (4) drop back to neutral position (cursor over it again), (5) restart at step 1. Visible 300ms transitions made it a slow, obvious dark/light pulse. The "dark" is the heavier navy shadow appearing on each cycle.
- Same antipattern existed at three Tailwind callsites: `hover:-translate-y-0.5` on the gallery grid cards in `AdStudio.jsx`, the template grid cards in `TemplateImages.jsx`, and the project list cards in `Projects.jsx` — all of which would flicker as the user scrolled past them.

**Fix (single commit, ~10 lines across 4 files)**
- `frontend/src/index.css` — removed `transform: translateY(-2px)` from `.card:hover`. Kept the heavier shadow + brighter background so cards still respond to mouse hover. Tightened `.card`'s transition from `transition-all` to specific properties (`box-shadow, background-color`) so any future Tailwind transform class on a `.card` won't reintroduce the flicker. Added inline comment explaining the antipattern.
- `frontend/src/components/AdStudio.jsx`, `frontend/src/components/TemplateImages.jsx`, `frontend/src/pages/Projects.jsx` — removed `hover:-translate-y-0.5` from the three card grid call sites.

**Carve-outs (intentionally unchanged)**
- `.btn-primary:hover { transform: translateY(-2px) scale(1.02) }` — buttons are smaller targets and clicked-not-scrolled-past, so the flicker risk is much lower. Left as-is. If a button-flicker is reported later, the follow-up will switch to scale-only.
- `group-hover:scale-[1.02]` on `<img>` elements inside cards — the image is a child of an `overflow-hidden` card; the image scales WITHIN a fixed frame, so the card outer geometry doesn't move. No flicker risk. Provides per-card hover delight without touching the card's hit area.
- Other `transition-all` callsites across the codebase — out of scope for this hotfix; CLAUDE.md guardrail covers them as a future migration.

**Pre-flight verification**
- `grep -rEn "hover:.?-?translate-y|translateY\(-?[0-9]" frontend/src/` confirmed only the four sites above. After fix, the same grep on `frontend/src/components/` and `frontend/src/pages/` returns zero `hover:-translate-y` matches. Remaining `translateY` references in `index.css` are: `.btn-primary` (intentional carve-out), `@keyframes fadeIn`/`slideUp` (one-shot mount animations), and `.info-tooltip` positioning (not on hover-on-card surfaces).

**Antipattern note for future devs**
- DO NOT add `:hover { transform: translate(...) }` (or Tailwind `hover:-translate-*`) to elements that the user typically scrolls past, especially elements taller than ~50px. The translate moves the element out from under the cursor, ending hover, restarting the loop. Use shadow / background / border-color / opacity for hover affordance instead. If a lift is essential, scope it to `@media (hover: hover) and (pointer: fine)` AND add a meaningful `transition-delay` (~100ms) so quick crossings don't trigger.

---

## 2026-04-30 — Fix `drive_folder_id` ArgumentValidationError on project save

**Bug**
- Marco tried to add a product image to the Heal Naturally project and got `ArgumentValidationError: Path: .drive_folder_id Value: null Validator: v.string()`. The error did not come from the product image upload itself — `setProductImage` only patches `product_image_storageId` + `updated_at`. It came from a `PUT /api/projects/:id` (project save) round-trip.

**Root cause chain**
1. `convex/schema.ts` and `convex/projects.ts` declare `drive_folder_id: v.optional(v.string())` — accepts undefined or string, rejects null.
2. Heal Naturally has no `drive_folder_id` set (legitimately optional).
3. `backend/convexClient.js:convexProjectToRow` was coercing missing optional strings to `null` for the API response (`p.drive_folder_id || null`).
4. The frontend `loadProject()` set `form.drive_folder_id = null`; `handleSave()` round-tripped the form (including the null) back via `api.updateProject`.
5. `backend/convexClient.js:updateProject` filtered with `if (fields[key] !== undefined)` — null passed through, hit the validator, rejected.

**Fix (single commit, two-layer defense)**
- **Layer 1** (`backend/convexClient.js:updateProject`) — filter drops both `undefined` AND `null`. Boundary defense; protects every future call site without per-component discipline. Inline comment locks in the lesson for future devs.
- **Layer 2** (`backend/convexClient.js:convexProjectToRow`) — optional simple-string fields now emit `''` instead of `null`. Contract going OUT matches contract going BACK. Frontend already uses `value={form.x || ''}` patterns, so no UI regression.

**Carve-outs (intentionally unchanged)**
- `product_image_storageId` — Convex storage ID; frontend null-checks for image rendering.
- `scout_destination_urls` — JSON-array-as-string per Critical Invariant #2; `''` would break `JSON.parse`.
- `scout_enabled` / `scout_score_threshold` / `scout_daily_flex_ads` — nullable boolean/number; Layer 1 filter handles them at the boundary.

**Pre-flight verification (run before edits)**
- Grepped `(===|!==|==|!=) *null` across `backend/`, `frontend/src/` for the affected fields. Zero matches — no consumer relies on `null` specifically.
- Confirmed working tree clean for `convexClient.js`. HEAD at `6e7e65f` (favicon commit), 0 commits ahead of origin/main.

**Out of scope**
- Auditing other mappers (`convexAdToRow`, `convexBatchToRow`, etc.) for the same null-coercion pattern. Deferred — fix when (if) they bite.
- Schema-level change to `v.optional(v.union(v.string(), v.null()))`. Would require Convex deploy (auth-mismatch risk per prior session) and codifies a less clean contract.
- Cleanup of any legacy stored nulls in other projects. Layer 1 makes them safe to save going forward.

---

## 2026-04-30 — Refactor batch pipeline off Anthropic onto OpenAI (no Anthropic key required for batches)

**Diagnostic findings**
- User Marco reported "I tried a batch job and it failed at headline generation." Direct Convex query confirmed the Anthropic API key was NULL in the settings table while OpenAI was set, and zero `batch_headline_generation` / `batch_brief_extraction` cost rows existed for that day. Root cause: Stage 1 calls Claude, but no Anthropic key was configured.
- The single-ad flow (Ad Studio "Generate Ad") already used GPT-5.2 + Gemini with no Anthropic dependency. The batch pipeline used Claude for all 4 copy stages (brief extraction, headlines, body copy, image prompts) plus OCR — a model-preference choice baked into the code, not an architectural requirement.

**What changed**
- `backend/services/adGenerator.js` — defined `BATCH_TEXT_MODEL = 'gpt-5.2'` and `BATCH_VISION_MODEL = 'gpt-4.1'` constants. Migrated 9 Claude call sites to OpenAI: Stage 0 brief extraction, Stage 1 headlines (with `response_format: { type: 'json_object' }`), Stage 2 body copy + repair, Stage 3 image prompts (with vision via `chatWithImage` + non-vision via `chat`), repair fallback. Dropped the Anthropic imports. Generalized the `lastError → leadingDiagnostic` mapping (originally added in commit `617eada`) to handle BOTH Anthropic and OpenAI error shapes — uses `err.error?.code` / `err.code` in addition to `err.error?.type`. Labels switched from "Anthropic xxx" to "LLM xxx" since the same diagnostic now serves both providers. Added explicit OpenAI content-policy violation case ("Prompt was rejected by OpenAI content policy — try rephrasing.").
- `backend/services/batchProcessor.js` — defined `BATCH_OCR_MODEL = 'gpt-4.1-mini'` and migrated the OCR text-extraction call (was Claude Haiku). Updated stored `text_model` label on ad_creatives from `'claude-sonnet-4-6'` to `'gpt-5.2'`. Swapped the pre-flight key check from Anthropic to OpenAI: error message now reads `[Stage 1] OpenAI API key not configured. Set it in Settings → API Keys.` Removed the `claudeChatWithImage` import (replaced with `chatWithImage` from openai.js).
- `backend/services/openai.js` — extended `OPENAI_FALLBACK_CHAIN` with `'gpt-5.2': 'gpt-4.1'`. If Marco's OpenAI tier doesn't grant 5.2, the existing fallback machinery at line 127 engages and uses GPT-4.1 instead.

**Why**
- Marco's primary use case (batch ad generation) shouldn't require him to manage three LLM providers when only OpenAI + Gemini are needed structurally. Eliminating the Anthropic dependency for batches removes a setup hurdle and makes the failure mode easier to debug (only 2 keys can be missing; not 3).
- The pre-flight error from commit `617eada` would have caught his original failure cleanly ("[Stage 1] Anthropic API key not configured"), but the better fix is to remove the dependency entirely.

**Cost note**
- Cost-per-batch may shift after this change (GPT-5.2 vs Claude Sonnet pricing varies by stage and token volume). Monitor for the first week. If costs jump materially or quality drops, the migration is a clean single-PR `git revert` away.

**Anthropic still required for non-batch features**
- LP generator (`lpGenerator.js`), copywriter chat, conductor learning (`conductorLearning.js`), quote miner, creative filter (`creativeFilterService.js`), foundational doc generator (`docGenerator.js`) all still call Claude. Marco needs to keep the Anthropic key set if he uses any of those features. Only the batch pipeline is migrated by this PR.

**Out of scope (explicit)**
- Prompt tuning for GPT-5.2. v1 keeps prompts byte-identical to the Claude versions. If quality drops materially in production, separate PR for tuning.
- Hybrid mode (use Claude when Anthropic key set, fall back to OpenAI otherwise). Defer; revisit only if needed.
- Removing Anthropic from the codebase entirely. Out of scope.

**Dashboard banner for missing keys** — separate follow-up PR after this lands and Marco's batch is verified working. Will surface missing OpenAI/Gemini keys at app load.

## 2026-04-30 — Fix stuck `generating_copy` / `generating_image` ads (zombie ad-creatives)

**Diagnostic findings**
- User Marco reported a generated ad "disappeared" from his Wedding System project. Direct Convex query showed: ad records exist in the database with `status: generating_copy` from 24+ hours ago. Not deleted — hidden by the gallery filter at `AdStudio.jsx:1428` which assumes those statuses mean "actively in progress."
- Most plausible root cause: Vercel function `maxDuration: 60`. Ad generation typically takes ~50s; OpenAI 429 retries can push past 60s; Vercel kills the function mid-stream; orchestrator's catch block never runs; ad's status stays at `generating_copy` forever. Other plausible causes (backend crash, SSE drop) leave the same fingerprint.

**What changed**
- `backend/convexClient.js` — new `markStaleAdsAsFailed(projectId, opts)` helper. Reads ads via existing `getByProject` query, filters to `generating_copy`/`generating_image` status with `created_at` older than threshold (default 5 min), calls existing `adCreatives.update` mutation per stuck ad to flip status to `failed`. Idempotent (status precondition checked); bounded by `maxRepairs` (default 100) to avoid Convex rate-limit blowups. No Convex schema changes — uses the existing `update` mutation's whitelisted `status` field.
- `backend/routes/ads.js` — fire-and-forget auto-cleanup in the `GET /:projectId/ads` handler (runs every gallery load). Errors logged via `console.warn`, not silently swallowed. New admin/manager-only `POST /:projectId/ads/cleanup-stuck` endpoint accepting optional `olderThanMinutes` (default 5, validated > 0) for forced cleanup. Single source-of-truth constant `STUCK_ADS_THRESHOLD_MIN = 5`.
- `frontend/src/components/AdStudio.jsx` — gallery filter at line 1428 now distinguishes "fresh" from "stuck": ads in `generating_copy`/`generating_image` are hidden ONLY if `created_at` is within the 5-minute window (matches backend threshold). Older zombies fall through and surface in the gallery, where the existing failed-ad treatment (red icon, red badge) renders + the existing per-card Delete button lets Marco dismiss them. Stale-detection runs BEFORE the type filter (`galleryFilter === 'individual'/'batch'`) so stuck batch ads also surface.

**Why**
- Marco's specific case: 2 zombie ads in the Wedding System project from 2026-04-29 will auto-resolve on his next gallery load — no manual intervention. Future zombies surface within 5 minutes instead of vanishing silently for 24+ hours.
- 5-min threshold tied to Vercel's 60s `maxDuration` + 4-min buffer for cold starts and clock skew. After 5 minutes, the function is definitively dead — no race risk with a legitimately long-running generation.

**Out of scope (future work)**
- Fixing the underlying Vercel timeout. Requires Pro tier upgrade (allows 300s `maxDuration`), splitting the orchestrator into shorter stages, or queue-based architecture. Cleanup approach surfaces the symptom; root-cause fix is a separate decision.
- Retry-from-stuck-state UI button. v1 marks zombies failed; user re-generates manually via the existing Generate button. Existing per-card Delete button is the dismiss path.
- Adding `error_message` / `pipeline_state` / `updated_at` fields to `ad_creatives` schema. Would require Convex deploy and schema migration. Not blocking the fix; status alone is sufficient signal.

## 2026-04-29 — Stage 1 batch failure: surface root cause + harden pre-flight

**What changed**
- `backend/services/adGenerator.js` — captures `lastError` in the headline-generation retry loop (lines ~1204-1311). Replaced the generic "Claude may be experiencing issues" fallback throw with a structured, length-capped message that puts the most actionable diagnostic FIRST so it survives the History panel's 50-char inline truncation. Examples: "[Stage 1] Anthropic auth error (401) after 3 attempts...", "[Stage 1] Anthropic rate-limited (429) after 3 attempts...". Uses defensive existence checks on Anthropic SDK error fields (`err.status`, `err.error?.type`).
- `backend/services/batchProcessor.js` — added API-key pre-flight check inside `runBatch` (right after the project-found check). Throws "[Stage 1] Anthropic API key not configured. Set it in Settings → API Keys." with the actionable message in the first 50 chars. Updated the existing zero-foundational-docs throw to follow the same `[Stage 1]` prefix convention. Replaced the generic diversity-filter throw at ~line 343 with a context-rich message that includes the actual filter rejection counts (`sceneAlignedPool.rejected.length`, `dedupedPool.rejectedInBatch.length`, `dedupedPool.rejectedByHistory.length` — verified field names from `headlineDiversity.js`). Catch block now also writes a structured `pipeline_state` JSON diagnostic (stage, failed_at, error_message, error_status, error_type) for post-mortem inspection in Convex when Vercel logs aren't available. Imported `getSetting` from `convexClient.js`.

**Why**
- User ran a batch of 5 ads and got the History row "Pipeline failed: [Stage 1] All headline generation". The generic message didn't tell us which of 5 plausible failure modes actually fired (API key issue, rate limit, scene-locked angle, missing docs, bad JSON). With Vercel Hobby not persisting historical logs, the next debugger had nothing to go on.
- The fix doesn't try to guess the root cause — it makes the next failure self-diagnosing. Once we see the actual diagnostic in the History panel, the targeted root-cause fix becomes a separate (small) PR.

**Out of scope (future work)**
- Actual root-cause fix for whatever the diagnostic reveals (separate PR once we have signal).
- Loosening the diversity filter — it exists for valid reasons; if it's rejecting everything, we want to know.
- Persistent log aggregation (Sentry / Logtail) — error-message-as-diagnostic gets us 80% at 0% cost.
- Live Anthropic key validation in pre-flight — diagnostic now correctly surfaces the 401 if a non-empty-but-revoked key is set.

## 2026-04-29 — Fix HTTP 413 in Ad Studio generation (client-side image resize + DRY error handling)

**What changed**
- `frontend/src/utils/imageResize.js` — **new shared utility**. `resizeImageForUpload(file)` downscales any image >1.5 MB via canvas to JPEG (max 2048×2048, iterative quality 0.92 → 0.85 → 0.75 → 0.6 → 0.45). Skips already-small files entirely (preserves PNG transparency, GIF animation). Refuses HEIC/HEIF (detected by both extension and content signature) with a clear "Convert to JPEG or PNG first" message. Refuses files >20 MB (prevents browser OOM). Uses `createImageBitmap` with an Image-element fallback for older Safari quirks. Also exports `estimateBase64BodyBytes(files)` and `MAX_COMBINED_BODY_BYTES = 4 MB` for pre-flight checks.
- `frontend/src/api.js` — added `throwForResponseError(res)` helper that handles HTTP 413 specifically with the message "Request body too large. Please reduce image size." instead of leaking a JSON.parse SyntaxError. Applied in `request()`, `streamSSE`, and `streamSSEWithBody` (the three shared fetch paths). `uploadTemplate` keeps its own pre-existing 413 handler with template-specific wording.
- `frontend/src/components/AdStudio.jsx` — added `resizeAndBase64(file)` helper that resizes then base64-encodes (with a `console.info` diagnostic on every actual resize). Wrapped all four `fileToBase64` callsites (productFile, uploadedFile, editReferenceFile in custom-prompt mode, referenceImage in edit-prompt flow) to resize-first. Added a pre-flight combined-size check via `exceedsCombinedSizeLimit()` that runs before `api.generateAd` / `api.regenerateImage` and aborts with "Combined image data is too large. Try fewer or smaller images." if the JSON body would exceed 4 MB. Added race-condition guards (capture file ref at start of resize, abandon if the source field changed mid-resize).

**Why**
- User reported two errors while generating an ad: a cryptic `Unexpected token 'R', "Request En"... is not valid JSON` toast and a `1:1 HTTP 413` line in the Ad Queue. Same root cause: per-generation image attachments (productFile / uploadedFile / editReferenceFile) were base64-encoded inline into the JSON body. With multiple attachments or one moderate-size attachment, the body crossed Vercel Hobby's 4.5 MB inbound gateway limit and was rejected before reaching the backend. The frontend then tried to JSON.parse Vercel's plain-text 413 body, leaking a SyntaxError to the toast.
- Client-side resize closes the user-facing bug at lower cost than a backend refactor (no new endpoints, no Convex changes). For typical ad inputs (product photos, lifestyle shots), 2048×2048 JPEG q=0.92 is visually indistinguishable from full-res at viewing size.

**Out of scope (future work)**
- Architectural refactor to upload-then-reference (image IDs in body instead of base64).
- Server-side body-size validation (Vercel's gateway is the de facto enforcer; not defensible if we move to a tier with higher limits).
- Applying the same resize utility to `uploadProductImage` (project-level) — same Vercel limit applies; small follow-up.

## 2026-04-28 — Templates flow: drop Drive sync, add multi-file direct upload (up to 500 at a time)

**What changed**
- `frontend/src/components/TemplateImages.jsx`: removed the Drive Templates section entirely. Replaced single-file upload with multi-file batch upload — `<input multiple>`, drag-drop accepts multiple files. Added sliding-window concurrency (5 in flight at a time, not chunked rounds). Progress UI: bar + "X of Y" + failure counter. Cancel button via AbortController. Per-file failure summary with reasons (unsupported format / exceeds 20 MB / too large for upload (server limit) / network error). Hard cap of 1000 files per session. Incremental gallery append on each successful upload (no full reload at end). Dropped the now-unused `inspirationFolderId` prop.
- `frontend/src/api.js`: `uploadTemplate` extended with optional `signal` for AbortController support. Backwards-compatible with existing string-`description` callers (BatchManager). Treats Vercel HTTP 413 (gateway-rejected) specifically as "too large for upload (server limit)" rather than a generic JSON-parse error.
- `frontend/src/components/AdStudio.jsx`: empty-state message and "Random from Templates Folder" copy no longer mention Google Drive — both now reference uploaded templates.
- `frontend/src/components/BatchManager.jsx`: same template-messaging update in two locations (random-template hint + no-templates empty state).
- `frontend/src/pages/ProjectDetail.jsx`: dropped the `inspirationFolderId` prop passed to `<TemplateImages />`.

**Why**
- Marco couldn't connect Google Drive in the UI to sync templates — the Drive UI never existed (only backend routes + an unused `DriveFolderPicker` component). The original Drive integration assumed a service-account JSON on disk, which doesn't fit Vercel's read-only serverless filesystem. Rather than build out a full Convex-backed service-account flow, the user opted to drop Drive from the templates flow entirely and use direct multi-file upload (up to 500 at a time, the practical ceiling for a single user session).
- Concurrency = 5 is a starting heuristic — tunable in `UPLOAD_CONCURRENCY` constant. Drop to 3 if Vercel rate-limits or Convex throttles; raise if uploads feel slow and there's headroom.

**Out of scope (deliberate v1 choices)**
- Client-side image resize for files >4 MB (Vercel Hobby gateway limit). v1 surfaces 413s clearly so the user can resize externally.
- In-place "Retry failed" button. v1 reports failures; user re-selects files manually to retry.
- Pre-upload review modal ("X selected, Y will be skipped, proceed?"). Goes straight to upload.
- ETA display, gallery virtualization, backend hash dedup, full Drive UI revival.

**Inspiration sync left intact**
- The separate `InspirationFolder.jsx` flow (uses `drive_folder_id` per project) still references Drive sync. Not touched in this change. The unused `DriveFolderPicker.jsx` component and `api.driveStatus`/`api.driveFolders` methods are kept since `DriveFolderPicker` may be reachable from `InspirationFolder` setup.

## 2026-04-28 — Vercel function bundling fix + production topology lock-in

**What changed**
- `vercel.json`: added `"includeFiles": "backend/services/prompts/**"` to the `api/index.js` function config so Vercel's NFT bundler always ships the prompt text files with the serverless function.
- Locked the topology fact: **Vercel is the only production deployment for Creative Factory.** The VPS deploy script (`deploy/deploy.sh`, target `daciaautomation.com`) is not used by any actual user for this project. Future work should target Vercel only.

**Why**
- Marco was still seeing the OLD Step 2 prompt because (a) my prior two commits (Step 1 fix + Step 2 swap) were deployed only to the unused VPS, and (b) Vercel auto-deploy from GitHub had silently stopped triggering ~4 days prior — last successful Vercel deployment was 2026-04-24, and the new `fs.readFileSync` for the .txt file would not have been bundled by NFT anyway because the path is dynamic. The `includeFiles` glob makes the bundling explicit and future-proofs any new file added to `backend/services/prompts/`.
- Recorded the Vercel-only fact in this changelog so future debugging doesn't waste cycles on the VPS deployment.

**What was tried that didn't work**
- Two prior `deploy.sh` runs to the VPS (commits f547a2e, 621f3d0) — code is live on the VPS but no user sees it.
- Relying on Vercel auto-deploy from git push — broken since 2026-04-24, separate concern from this fix.

**Auto-deploy verification**
- Vercel git integration confirmed connected via API (`link.type: github`, `link.repo: iwilsonm/creative-factory-software`, `productionBranch: main`).
- Pushing this commit to test whether GitHub webhook fires a `via GIT` deployment.

## 2026-04-27 — Step 2 prompt replaced with deep-research teaching transcript

**What changed**
- Created `backend/services/prompts/research-methodology.txt` (~80,000 chars) containing Marco's existing deep-research teaching transcript: "Research Part 1" (framework walkthrough — demographic / existing solutions / curiosity / corruption) and "Research Part 2" (a fully worked weight-loss research example).
- `backend/services/docGenerator.js`: `prompt2_ResearchMethodology()` now reads the prompt body from the .txt file once at module load instead of inlining a JS template literal. Added `fs` / `path` / `fileURLToPath` imports per the pattern in `adGenerator.js`.
- `backend/routes/documents.js`: Updated Step 2 `instruction` to "...deep research methodology with a fully worked example" (was "...4-layer research framework") to match the new transcript content.

**Why**
- Ian wanted the Step 2 prompt to be Marco's research methodology training transcript rather than the previous condensed 4-layer framework. The transcript walks the model through the methodology with a complete real-world example, which produces a richer Step 2 response in the manual flow and feeds more grounded context into the auto-gen flow's downstream steps.
- Loading from a .txt file avoids embedding ~80k characters of dialogue-heavy text as a JS template literal (which would be a quote-escaping nightmare) and makes future prompt edits trivial — just edit the .txt file.

**What was tried that didn't work**
- N/A — single-pass change.

## 2026-04-27 — Step 1 prompt: PDF-attach instruction + remove fallback string

**What changed**
- `backend/services/docGenerator.js`: `prompt1_AnalyzeSalesPage` now omits the trailing content block entirely when `salesPageContent` is empty/null instead of inserting placeholder text. Removed the `|| 'No sales page content provided.'` fallback at the 3 internal call sites (auto-gen step 1, re-run deep research, manual research synthesis).
- `backend/routes/documents.js`: `/research-prompts` Step 1 — removed the same fallback at the call site, rewrote the `instruction` text to tell the user to create a PDF of their PDP and attach it alongside the prompt, and added an optional `tip` field `{ text, linkLabel, linkUrl }` pointing to https://webtopdf.com/.
- `frontend/src/components/FoundationalDocs.jsx`: renders the optional `tip` as an italic line beneath the instruction with a clickable gold link. `e.stopPropagation()` prevents the link click from collapsing the expanded card.

**Why**
- Users picking "Generate with Prompts" with no `sales_page_content` saw a literal "No sales page content provided." inside the copyable Step 1 prompt — confusing and made the system look unfinished.
- The new flow is clearer: the user attaches a PDP PDF in their ChatGPT/Claude conversation alongside the prompt, which matches the prompt's existing wording ("I'm going to send you a PDF screenshot..."). The webtopdf.com tip gives them a concrete way to produce the PDF.

**What was tried that didn't work**
- N/A — single-pass change.

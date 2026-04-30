# Creative Factory — Changelog

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

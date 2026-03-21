# Automated Landing Page Pipeline — PRD

**Version 1.0 | March 2026**
**System**: daciaautomation.com
**Prepared for**: Luke / Dacia Ventures

---

## 1. Executive Summary

This PRD defines how the **existing Landing Page system** is extended to support fully automated, angle-specific advertorial generation tied to the ad pipeline. This is not a new system — it builds directly on the existing `lpGenerator.js`, `lpPublisher.js`, `lpSwipeFetcher.js`, `LPGen.jsx`, `landing_pages` table, and `landing_page_versions` table.

**What exists today**: A manual-trigger LP pipeline where a user initiates generation from `LPGen.jsx`, Claude Sonnet generates copy + design + HTML, images are generated via Gemini, and the page publishes to Cloudflare Pages. The user can edit via a split-panel editor before publishing.

**What this PRD changes**:

- **Auto-generation mode** in `lpGenerator.js` — the Director triggers LP generation alongside batch creation, producing two advertorials per batch using different narrative frames.
- **Template extraction** — a new layer on top of the existing `lpSwipeFetcher.js` that turns swiped URLs into reusable template skeletons stored in a new `lp_templates` table.
- **Shopify publishing replaces Cloudflare** — `lpPublisher.js` is rewritten to publish to the brand's Shopify store via the Admin API. Cloudflare Pages integration is removed entirely. All landing pages publish to Shopify for Meta pixel attribution and cookie continuity.
- **LP gate in the Filter** — `filter.sh` checks that both landing pages are verified live before deploying a flex ad to Ready to Post.
- **Manual editing preserved** — all auto-generated LPs appear in `LPGen.jsx` and remain fully editable through the existing split-panel editor.

---

## 2. Goals and Success Criteria

### 2.1 Primary Goals

1. Every flex ad in Ready to Post has two verified-live, angle-specific advertorial landing pages attached.
2. Landing pages are hosted on the brand's Shopify domain for seamless Meta pixel attribution and cookie continuity.
3. No flex ad reaches Ready to Post without both landing pages verified live. This is a hard gate, not a soft preference.
4. LP creation runs in parallel with batch processing, adding no wait time under normal conditions.
5. Templates are sourced from URLs of existing high-performing landers, extracted into reusable skeletons via the existing `lpSwipeFetcher.js`.
6. All auto-generated landing pages remain manually editable through the existing `LPGen.jsx` split-panel editor at any time.

### 2.2 Success Criteria

- 100% of Director-created batches trigger parallel LP generation for two advertorials.
- Both LPs pass automated verification (HTTP 200 + content markers) before the Filter deploys to Ready to Post.
- Failed LP generation triggers automatic retry (up to 5 attempts with escalation) without stalling the ad pipeline.
- Template extraction from a URL produces a reusable skeleton that generates structurally distinct landers when populated with different content.
- CTA links on all generated landing pages correctly point to the project's PDP URL.
- Employees see no broken or missing landing page URLs in Ready to Post.

---

## 3. How This Builds on the Existing LP System

This section maps every existing component to its specific modification. Nothing is replaced — everything is extended.

### 3.1 Existing Components Being Modified

| Existing Component | What It Does Today | What Changes |
|---|---|---|
| **`lpGenerator.js`** (service, used by `routes/landingPages.js` + `lpPublisher.js`) | 4-step Claude Sonnet pipeline: (1) design analysis of swiped page, (2) copy generation from analysis, (3) image slot generation, (4) HTML assembly. Stores results as `swipe_design_analysis`, `copy_sections`, `image_slots` on `landing_pages` record. | **Prompt chain is adapted, not replaced.** Step 1 (design analysis) becomes the fork point — in the manual flow it analyzes a swiped URL as it does today; in the auto flow it loads a pre-extracted template's design brief + slot definitions from `lp_templates`. The output shape of step 1 is normalized so that steps 2–4 (copy gen, image gen, HTML assembly) receive the same data structure regardless of which input path was used. Steps 2–4 are enhanced with angle + narrative frame + foundational docs context for the auto path, but the core prompt logic and output structure remain the same for both flows. New exported function `generateAutoLP()` handles the auto entry point. |
| **`lpPublisher.js`** (service, used by `routes/landingPages.js`) | Publishes to Cloudflare Pages via Direct Upload API. Uses `sharp` for image optimization. | **Rewritten.** Cloudflare publishing is removed entirely. Replaced with Shopify Admin API publishing. New exports: `publishToShopify()`, `unpublishFromShopify()`, `updateOnShopify()`, `verifyLive()`. The `sharp` image optimization can be retained for optimizing images before uploading to Shopify/Convex storage. |
| **`lpSwipeFetcher.js`** (service, used by `routes/landingPages.js` + `lpGenerator.js`) | Puppeteer page capture with SSRF protection. Fetches URL content for LP generation. | **No changes.** Reused as-is by the new template extraction service. The existing SSRF protection and Puppeteer capture work exactly as needed. |
| **`LPGen.jsx`** (component, ~1200 lines) | Split-panel editor for LP generation, editing, and publishing. Lists all LPs for a project. | Add an "Auto" badge on auto-generated LPs in the list view. Replace "Publish to Cloudflare" button with "Publish to Shopify." Add batch association display. All existing editing, versioning, and CTA management functionality remains identical. |
| **`routes/landingPages.js`** (route, uses `lpGenerator.js`, `lpPublisher.js`, `lpSwipeFetcher.js`, `gemini.js`) | CRUD for landing pages, SSE generation endpoint, publish/unpublish endpoints. | Replace Cloudflare publish/unpublish endpoints with Shopify equivalents. Add template CRUD endpoints (or mount in separate `routes/lpTemplates.js`). Existing CRUD and generation endpoints unchanged. |
| **`landing_pages`** (Convex table) | Stores LP data: `copy_sections`, `image_slots`, `cta_links`, `swipe_design_analysis`, `hosting_metadata` (all JSON strings). Has `landing_page_versions` child table. | Add optional fields: `auto_generated`, `batch_job_id`, `narrative_frame`, `template_id`, `shopify_page_id`, `shopify_handle`, `publish_target`. All existing fields unchanged. Existing records unaffected (new fields are `v.optional()`). |
| **`landing_page_versions`** (Convex table) | Snapshot of copy/images/HTML for version history. | **No changes.** Auto-generated LPs create versions using the same existing versioning logic. |
| **`conductorEngine.js`** (service, used by `routes/conductor.js` + `scheduler.js`) | Plans batches, selects angles, creates `batch_jobs` records. Runs via scheduler 3x/day. | Add LP generation trigger call after batch creation in `runDirectorForProject()`. Fire-and-forget with error handling — LP failure never prevents batch creation. |
| **`filter.sh`** (agent, ~1170 lines, cron every 30min) | Scores completed batch ads, groups into flex ads, deploys to Ready to Post. | Add LP gate check before the deploy-to-Ready-to-Post step. Read `lp_primary_status` and `lp_secondary_status` from batch record. Only deploy if both are `"live"`. Add retry trigger for failed LPs. |
| **`batch_jobs`** (Convex table) | Tracks 4-stage pipeline state, filter flags. | Add optional LP tracking fields (see Data Model section). |
| **`flex_ads`** (Convex table) | Stores grouped ad creatives with headlines, primary_texts. | Add optional `lp_primary_url` and `lp_secondary_url` fields. |
| **`conductor_config`** (Convex table) | Per-project Director settings. | Add Shopify API credentials and LP configuration fields. |
| **`ReadyToPostView.jsx`** (component, ~800 lines) | Displays flex ads ready for posting with copy and creative details. | Add display of both LP URLs as clickable links alongside each flex ad. |

### 3.2 New Components

| New Component | Type | Purpose | Depends On |
|---|---|---|---|
| **`lp_templates`** | Convex table | Stores extracted template skeletons with slot definitions, design briefs, and source URL. | — |
| **`convex/lpTemplates.ts`** | Convex functions | CRUD queries + mutations for template library with field whitelisting. | `schema.ts` |
| **`lpTemplateExtractor.js`** | Service | Orchestrates template extraction: calls `lpSwipeFetcher.js` for capture, Claude Sonnet via `anthropic.js` for structural analysis, stores result. | `lpSwipeFetcher.js`, `anthropic.js`, `convexClient.js` |
| **`lpAutoGenerator.js`** | Service | Thin orchestration layer: loads template from `lp_templates`, loads foundational docs, calls `lpGenerator.js` `generateAutoLP()` for the actual prompt chain, then handles Shopify publishing via rewritten `lpPublisher.js` and batch record updates. Does not contain prompt logic itself. | `lpGenerator.js`, `lpPublisher.js`, `gemini.js`, `anthropic.js`, `convexClient.js` |
| **`routes/lpTemplates.js`** | Route | CRUD endpoints for template library. Mounted in `server.js`. | `lpTemplateExtractor.js`, `auth.js`, `convexClient.js` |
| **`LPTemplateManager.jsx`** | Component | UI for template library: URL input, extraction status, template preview/list. New tab in ProjectDetail or section within LPGen. | `api.js`, `Toast.jsx` |

### 3.3 Existing Code That Must NOT Change

These existing behaviors must remain identical after implementation:

- **`lpGenerator.js` existing manual flow**: The existing swipe-URL-based generation must continue working exactly as it does today after the prompt chain is adapted. Adding auto-mode context to the prompts must not change behavior when `mode: 'manual'`. The existing exported functions that `routes/landingPages.js` calls for manual generation must maintain their current signatures.
- **`lpPublisher.js`**: Rewritten to target Shopify instead of Cloudflare. Old Cloudflare code is removed. New exports: `publishToShopify()`, `unpublishFromShopify()`, `updateOnShopify()`, `verifyLive()`.
- **`lpSwipeFetcher.js`**: Zero changes. Used as-is.
- **`LPGen.jsx` manual editor flow**: The existing split-panel editor, CTA management, and version history all work identically. Publishing is updated to target Shopify. Auto-generated LPs are just regular `landing_pages` records that can be edited the same way.
- **`landing_page_versions` versioning**: When an auto-generated LP is edited, versions are created using the exact same logic as manually-created LPs.
- **All existing `routes/landingPages.js` endpoints**: Every existing endpoint continues working. New endpoints are additive.
- **Deployment status strings**: `"selected"`, `"ready_to_post"`, `"posted"`, `"analyzing"` are not modified.
- **`filter.sh` existing deploy logic**: The LP gate is a new conditional *before* the existing deploy step. When the gate passes, the existing deploy flow runs identically.

### 3.4 What's Being Removed

| Component | Current Purpose | Why It's Going |
|---|---|---|
| **Cloudflare Pages API calls in `lpPublisher.js`** | Publishes LP HTML/assets to Cloudflare Pages | Replaced by Shopify Admin API. Cloudflare subdomain breaks Meta pixel attribution. |
| **`cloudflare_account_id` setting** | Cloudflare account identifier | No longer needed |
| **`cloudflare_api_token` setting** | Cloudflare API auth | No longer needed |
| **`cloudflare_pages_project` setting** | Cloudflare Pages project name | No longer needed |
| **Cloudflare publish/unpublish endpoints in `routes/landingPages.js`** | Trigger Cloudflare publishing from UI | Replaced with Shopify equivalents |
| **"Publish to Cloudflare" button in `LPGen.jsx`** | Triggers Cloudflare publishing | Replaced with "Publish to Shopify" |
| **`hosting_metadata` Cloudflare fields in `landing_pages` records** | Stores Cloudflare deployment URL, project name | Replaced by `shopify_page_id` and `shopify_handle`. Existing records with Cloudflare metadata are left as-is (no migration), but the fields won't be written going forward. |

The Cloudflare Pages dependency can be removed from `package.json` if it's a standalone package. The `settings` table entries for Cloudflare can be left in place (harmless) or cleaned up manually.

---

## 4. Feature Specifications

### 4.1 Template Extraction Pipeline

#### 4.1.1 User Flow

The user navigates to a Template Library section (new tab in ProjectDetail or new section within the existing LP tab). They paste a URL of a landing page they like. The system captures the page using the existing `lpSwipeFetcher.js`, Claude analyzes the structural layout, and the result is stored as a reusable template.

#### 4.1.2 Technical Flow

1. User submits URL via `LPTemplateManager.jsx`.
2. Frontend calls `api.extractLPTemplate(projectId, url)`.
3. Route handler calls existing `lpSwipeFetcher.fetchSwipePage(url)` — Puppeteer capture with SSRF protection, no changes needed.
4. Captured HTML + screenshots pass to `lpTemplateExtractor.js`, which calls Claude Sonnet (via `anthropic.js` wrapper) to analyze structural layout: section ordering, content slot types, visual hierarchy, CTA patterns, styling DNA.
5. Claude returns a structured template definition: an HTML skeleton with typed content slots, a design brief capturing styling patterns, and slot definitions (hero, lead, mechanism, testimonial, social_proof, cta) each with a content type (`copy`, `image_lifestyle`, `image_product`, `trust_element`).
6. Template is stored in `lp_templates` table in Convex.

#### 4.1.3 `lp_templates` Table Schema

| Field | Type | Description |
|---|---|---|
| `externalId` | `v.string()` | UUID primary key (standard pattern) |
| `project_id` | `v.string()` | FK to `projects.externalId` |
| `source_url` | `v.string()` | Original URL the template was extracted from |
| `name` | `v.string()` | User-editable display name (auto-generated from URL on creation) |
| `skeleton_html` | `v.string()` | HTML template with placeholder slot markers |
| `design_brief` | `v.string()` | JSON string: styling patterns, color relationships, typography, spacing |
| `slot_definitions` | `v.string()` | JSON string: array of slot objects with id, type, position, content_type |
| `screenshot_storage_id` | `v.optional(v.string())` | Convex storage ID for captured screenshot |
| `status` | `v.string()` | `"extracting"`, `"ready"`, `"failed"` |
| `error_message` | `v.optional(v.string())` | Error details if extraction failed |
| `created_at` | `v.string()` | ISO 8601 timestamp |

Note: `slot_definitions` and `design_brief` follow the existing JSON-string-in-Convex pattern used by `landing_pages.copy_sections`, `landing_pages.image_slots`, etc.

---

### 4.2 Automated LP Generation (Director Integration)

#### 4.2.1 Trigger Point

In `conductorEngine.js`, after `runDirectorForProject()` creates a batch record in Convex, it calls `lpAutoGenerator.triggerLPGeneration(batchJobId, projectId, angle)`. This is fire-and-forget with error handling — LP failure must not prevent the batch from proceeding.

The Director already has all the context needed: the angle, the project ID (for loading foundational docs and templates), and the batch job ID (for storing the LP reference).

#### 4.2.2 Parallel Execution

LP generation runs in parallel with the batch's 4-stage ad pipeline. Batch processing takes hours (brief extraction → headlines → body copy → image prompts → Gemini batch API with 5-min polling). LP generation takes approximately 5–10 minutes per advertorial. Both LPs will be live long before the batch completes and the Filter picks it up.

#### 4.2.3 Two Advertorials with Different Narrative Frames

For each batch, the system generates two landing pages using the same angle but different narrative frames. The narrative frame changes the storytelling approach while the angle, product claims, and avatar targeting remain identical.

**Narrative Frame Library:**

| Frame ID | Frame Name | Description | Best For |
|---|---|---|---|
| `testimonial` | Testimonial Journey | First-person narrative from someone who discovered the product. Reader identifies with the character. | Pain-related angles, emotional transformation |
| `mechanism` | Mechanism Deep-Dive | Educational approach explaining the science or unique mechanism. Reader builds belief through understanding. | Science-backed angles, ingredient/technology |
| `problem_agitation` | Problem Agitation | Leads with pain points, agitates the problem extensively before the solution. | Fear-based angles, urgency |
| `myth_busting` | Myth Busting | Challenges common beliefs. Reader feels they're getting insider knowledge. | Contrarian angles, "what they don't tell you" |
| `listicle` | Listicle | Numbered list of signs, reasons, or benefits. Easy to scan. | Awareness angles, symptom-based |

Frame selection: initially random (no repeat within same batch). Future: weighted by historical conversion data per angle type via the Director's learning system.

#### 4.2.4 Prompt Chain Adaptation

The existing `lpGenerator.js` runs a 4-step Claude Sonnet pipeline. This chain is adapted to handle both manual (swipe URL) and auto (template + angle) inputs through a single, unified process.

**Step 1: Design Analysis (the fork point)**

| | Manual Flow (today) | Auto Flow (new) |
|---|---|---|
| **Input** | Swiped URL → `lpSwipeFetcher.js` captures HTML + screenshots | Pre-extracted template loaded from `lp_templates` table |
| **What Claude analyzes** | "Analyze this page's visual design: section ordering, content types, styling patterns, CTA placement" | Template's `design_brief` and `slot_definitions` are loaded directly — no analysis call needed, the extraction already did this work |
| **Output** | Design analysis object stored as `swipe_design_analysis` on `landing_pages` | Same shape — design brief + slot definitions normalized into the same structure that steps 2–4 expect |

The key: steps 2–4 don't know or care whether the design analysis came from a live swipe or a stored template. The data shape going forward is identical.

**Step 2: Copy Generation (adapted for both flows)**

Existing prompt generates copy for each section/slot identified in step 1. Adaptation:

- Manual flow: prompt receives the design analysis + whatever product context the user provided (same as today).
- Auto flow: prompt receives the same design analysis structure, **plus** the angle, narrative frame instruction, and full foundational docs (avatar, offer brief, beliefs). The narrative frame adds a system-level instruction like "Write this as a first-person testimonial journey" or "Write this as a mechanism deep-dive."
- Output shape is identical: `copy_sections` JSON array with content for each slot.

**Step 3: Image Slot Generation (adapted for both flows)**

Existing prompt generates image descriptions/prompts for visual slots. Adaptation:

- Manual flow: image prompts are based on the design analysis + copy context (same as today).
- Auto flow: image prompts additionally incorporate the angle's visual direction and avatar demographics. Slot types from the template (`image_lifestyle`, `image_product`, `image_hero`) guide whether Gemini generates lifestyle imagery, product renders from reference images, or combined hero shots.
- `trust_element` slots skip image generation entirely — they're rendered as HTML/CSS components from foundational doc data.
- Output shape is identical: `image_slots` JSON array.

**Step 4: HTML Assembly (adapted for both flows)**

Existing prompt assembles final HTML from copy + images + design analysis. Adaptation:

- Manual flow: Claude generates HTML based on the design analysis styling (same as today).
- Auto flow: Claude populates the template's `skeleton_html` with the generated copy and image URLs. CTA links are auto-set to the project's `pdp_url`. The template skeleton provides the structural foundation, so Claude focuses on content insertion rather than layout creation.
- Existing markdown-fence auto-stripping in `lpGenerator.js` applies to both flows.

**What this means for the code:**

- `lpGenerator.js` gets a new entry point `generateAutoLP(batchJobId, projectId, angle, narrativeFrame, templateId)` that feeds into the same steps 2–4.
- Steps 2–4 internal functions receive an options object that includes `{ mode: 'manual' | 'auto', angle, narrativeFrame, foundationalDocs }` so prompts can conditionally include the extra context.
- The core prompt templates are enhanced with conditional sections, not forked into separate prompts. One prompt per step, with "if auto mode, include this additional context" blocks.
- `lpAutoGenerator.js` is a thin orchestration layer: it loads the template, loads foundational docs, calls `generateAutoLP()`, then handles publishing and batch record updates. The heavy prompt work stays in `lpGenerator.js`.

---

### 4.3 Shopify Publishing

#### 4.3.1 Why Shopify

The existing `lpPublisher.js` publishes to Cloudflare Pages. This is being replaced entirely with Shopify publishing because: the page must be on the same domain as the store for Meta pixel cookie continuity, Shopify's pixel fires automatically on all pages within the store, and server-side event matching works without cross-domain complications. There is no use case for keeping Cloudflare as a publishing target — all landing pages (auto-generated and manually-created) publish to Shopify.

The `cloudflare_account_id`, `cloudflare_api_token`, and `cloudflare_pages_project` settings in the `settings` table can be deprecated. The Cloudflare Pages API dependency is removed from the backend.

#### 4.3.2 Publishing Mechanism — Rewritten `lpPublisher.js`

Creates pages via Shopify Admin REST API:

```
POST /admin/api/2026-01/pages.json
{
  "page": {
    "title": "Why Grounding Changes Everything",
    "handle": "grounding-inflammation-a7b3",
    "body_html": "<div class='advertorial'>...full generated HTML...</div>",
    "template_suffix": "lander",
    "published": true
  }
}
```

- **handle**: Auto-generated slug with unique suffix to prevent collisions.
- **template_suffix**: `"lander"` — uses a stripped-down Shopify theme template (one-time setup per store).
- **Updates**: If `shopify_page_id` exists on the `landing_pages` record, uses PUT instead of POST. This enables re-publishing after manual edits in `LPGen.jsx`.
- **Deletion**: `unpublishFromShopify()` calls DELETE on the Shopify page.
- **Retry**: Uses existing `retry.js` pattern for exponential backoff on API errors.

#### 4.3.3 Shopify Theme Requirement (One-Time Per Store)

Each Shopify store needs a `page.lander.liquid` template that renders only the page content with the Meta pixel — no header, footer, or navigation. This is created once manually. Contents:

- Meta pixel script (already in the theme's base layout, or explicitly included)
- `{{ page.content }}` Liquid tag rendering `body_html`
- Responsive viewport meta tag and base CSS reset
- Optional minimal legal footer

#### 4.3.4 Verification Step

After Shopify API confirms page creation (returns page ID + handle):

1. HTTP GET to `https://{store_domain}/pages/{handle}`.
2. Verify HTTP 200 response.
3. Verify response contains expected content markers: the PDP URL in a CTA link, a known string from the generated content.
4. Pass → set `lp_status` to `"live"` on batch record.
5. Fail → set `lp_status` to `"failed"` with error reason. Retry logic activates.

#### 4.3.5 Per-Project Shopify Configuration

New fields on `conductor_config` (or `projects`) table:

| Field | Type | Description |
|---|---|---|
| `shopify_store_domain` | `v.optional(v.string())` | e.g., `"heal-naturally.myshopify.com"` |
| `shopify_access_token` | `v.optional(v.string())` | Admin API token with `write_content` scope |
| `shopify_lander_template` | `v.optional(v.string())` | Template suffix, default `"lander"` |
| `pdp_url` | `v.optional(v.string())` | Product detail page URL for CTA links |
| `lp_auto_enabled` | `v.optional(v.boolean())` | Enable/disable auto LP generation for this project |

---

### 4.4 Filter LP Gate

#### 4.4.1 Gate Logic

The Filter (`filter.sh`) currently deploys flex ads to Ready to Post after scoring and grouping. The LP gate adds a mandatory check **before** this existing deployment step.

**Pseudocode (added to `filter.sh`):**

```
# After scoring and grouping, before deploying to Ready to Post:
lp_primary_status=$(read from batch record)
lp_secondary_status=$(read from batch record)

if [ "$lp_primary_status" = "live" ] && [ "$lp_secondary_status" = "live" ]; then
    # Proceed with existing deploy logic
    lp_primary_url=$(read from batch record)
    lp_secondary_url=$(read from batch record)
    # Set URLs on flex ad during creation
    deploy_flex_ad_to_ready_to_post  # existing function, unchanged
else
    log "LP gate: holding batch $batch_id — primary=$lp_primary_status, secondary=$lp_secondary_status"
    # Do NOT deploy. Batch stays in scored-but-held state.
    # Filter will re-check on next 30-minute cycle.
    trigger_lp_retry_if_failed  # new function
fi
```

The existing deploy flow runs identically once the gate passes. The only addition to the flex ad creation is including `lp_primary_url` and `lp_secondary_url` fields.

#### 4.4.2 Retry and Escalation Logic

When the Filter encounters a batch with scored/grouped ads but a failed LP:

| Attempt | Action | Trigger |
|---|---|---|
| 1–3 | Retry the failed step: re-publish if Shopify error, regenerate images if image failure, regenerate HTML if malformed | Automatic on each Filter cycle when `lp_status` is `"failed"` |
| 4 | Switch to a different template from the library | After 3 failures with the same template |
| 5 | Full regeneration from scratch (new copy, new images, new HTML) | After template switch also fails |
| 6+ | Fixer picks up as a health issue. Logged as recurring failure. | After 5 LP attempts exhausted |

Retry count and error reasons stored on batch record (`lp_primary_retry_count`, `lp_secondary_retry_count`, `lp_primary_error`, `lp_secondary_error`).

---

### 4.5 Manual Editing

All auto-generated landing pages are stored in the existing `landing_pages` table and appear in the existing `LPGen.jsx` interface. They are fully editable:

- **Edit**: Use the existing split-panel editor for copy, images, and HTML changes.
- **Re-publish**: After edits, re-publish to Shopify. Since `shopify_page_id` is stored, `lpPublisher.js` uses PUT (update) instead of POST (create).
- **Unpublish**: Delete the Shopify page via API.
- **Detach from batch**: Clear the batch record's LP fields. The LP continues to exist independently.
- **Manually assign**: Attach any existing LP to a batch that's missing one.
- **Version history**: The existing `landing_page_versions` versioning works identically for auto-generated LPs.

Changes to `LPGen.jsx` are minimal: an "Auto" badge in the list, batch association display, and the publish button now targets Shopify instead of Cloudflare.

---

### 4.6 Ready to Post Display

`ReadyToPostView.jsx` updated to show both landing page URLs alongside each flex ad:

- Existing flex ad display (images, headlines, primary texts) unchanged.
- New: Primary LP URL as a clickable link (opens in new tab).
- New: Secondary LP URL as a clickable link (opens in new tab).
- Both URLs are pre-populated and verified live. Employees copy the desired URL as the destination when posting to Meta.

---

## 5. Image Generation Strategy

All images on generated landing pages are AI-generated using the existing Gemini 3 Pro integration. No stock photography APIs needed.

### 5.1 Image Slot Types

| Slot Type | Source | Generation Method |
|---|---|---|
| `image_product` | Project product images + inspiration folder | Gemini renders from reference images. Same approach as existing ad pipeline: AI renders of the product from competitor reference photos. |
| `image_lifestyle` | Generated from angle context | Gemini generates from prompts written by Claude based on the angle, avatar demographics, and desired emotional tone. |
| `trust_element` | Foundational docs | **Not images.** Inline HTML/CSS components: star ratings, guarantee badges, ingredient highlights, comparison tables. Populated from foundational doc data. |
| `image_hero` | Product + lifestyle combination | Gemini generates a hero image combining product context with lifestyle elements. Prompt includes the angle's primary emotion and benefit. |

### 5.2 Constraints

- Gemini concurrency limit of 3 (via existing `rateLimiter.js`) applies to all LP image generation.
- Image generation for both advertorials runs sequentially to avoid saturating the rate limit and impacting ad batch processing.
- Generated images stored in Convex blob storage (existing pattern) and referenced by storage URL in final HTML.
- Cost tracking via existing `gemini.js` cost logging with `operation: "lp_auto_image"`.

---

## 6. Data Model Changes

All changes are **additive**. No existing fields modified or removed. New fields use `v.optional()` for backward compatibility.

### 6.1 New Table: `lp_templates`

Defined in Section 4.1.3. Requires:
- New entry in `convex/schema.ts`
- New file `convex/lpTemplates.ts` with CRUD operations + field whitelisting
- New mapper `convexLPTemplateToRow` in `convexClient.js`
- New helper functions in `convexClient.js` with field whitelists

### 6.2 Modified: `batch_jobs`

New optional fields:

| Field | Type | Purpose |
|---|---|---|
| `lp_primary_id` | `v.optional(v.string())` | FK to `landing_pages.externalId` |
| `lp_primary_url` | `v.optional(v.string())` | Published Shopify URL |
| `lp_primary_status` | `v.optional(v.string())` | `"generating"`, `"published"`, `"live"`, `"failed"` |
| `lp_primary_error` | `v.optional(v.string())` | Error message if failed |
| `lp_primary_retry_count` | `v.optional(v.float64())` | Retry attempts |
| `lp_secondary_id` | `v.optional(v.string())` | FK to `landing_pages.externalId` |
| `lp_secondary_url` | `v.optional(v.string())` | Published Shopify URL |
| `lp_secondary_status` | `v.optional(v.string())` | `"generating"`, `"published"`, `"live"`, `"failed"` |
| `lp_secondary_error` | `v.optional(v.string())` | Error message if failed |
| `lp_secondary_retry_count` | `v.optional(v.float64())` | Retry attempts |
| `lp_narrative_frames` | `v.optional(v.string())` | JSON string: `["testimonial", "mechanism"]` |

Update chain: `schema.ts` → `batchJobs.ts` → `convexBatchToRow` mapper + whitelist in `convexClient.js` → `conductorEngine.js` + `filter.sh` → `api.js getBatches()` → `BatchManager.jsx`

### 6.3 Modified: `landing_pages`

New optional fields:

| Field | Type | Purpose |
|---|---|---|
| `auto_generated` | `v.optional(v.boolean())` | True if created by automated pipeline |
| `batch_job_id` | `v.optional(v.string())` | FK to `batch_jobs.externalId` |
| `narrative_frame` | `v.optional(v.string())` | Which frame was used |
| `template_id` | `v.optional(v.string())` | FK to `lp_templates.externalId` |
| `shopify_page_id` | `v.optional(v.string())` | Shopify page ID for updates/deletion |
| `shopify_handle` | `v.optional(v.string())` | URL handle |

Update chain: `schema.ts` → `landingPages.ts` → existing mapper + whitelist in `convexClient.js` → `lpAutoGenerator.js` + `lpPublisher.js` → `api.js getLandingPages()` → `LPGen.jsx`

### 6.4 Modified: `flex_ads`

New optional fields:

| Field | Type | Purpose |
|---|---|---|
| `lp_primary_url` | `v.optional(v.string())` | Primary landing page URL |
| `lp_secondary_url` | `v.optional(v.string())` | Secondary landing page URL |

Update chain: `schema.ts` → `flexAds.ts` → existing mapper + whitelist in `convexClient.js` → `filter.sh` deploy step → flex ad API → `ReadyToPostView.jsx`

**Critical**: `flex_ads` field shape is in the "Paths That Must Stay in Sync" table. Adding these fields requires updates in `flexAds.ts`, `convexClient.js`, `CampaignsView.jsx`, `ReadyToPostView.jsx`, and `filter.sh`.

### 6.5 Modified: `conductor_config`

New optional fields:

| Field | Type | Purpose |
|---|---|---|
| `shopify_store_domain` | `v.optional(v.string())` | Shopify store domain |
| `shopify_access_token` | `v.optional(v.string())` | Admin API token |
| `shopify_lander_template` | `v.optional(v.string())` | Template suffix (default `"lander"`) |
| `pdp_url` | `v.optional(v.string())` | Product detail page URL for CTAs |
| `lp_auto_enabled` | `v.optional(v.boolean())` | Enable/disable auto LP generation |

Update chain: `schema.ts` → `conductor.ts` → `convexClient.js` → `routes/conductor.js` → `api.js` → Conductor config UI

---

## 7. Implementation Phases

### Phase 1: Foundation (Template Extraction + Shopify Publishing)

**Goal**: Extract templates from URLs and publish LPs to Shopify manually.

1. Create `lp_templates` Convex table + `convex/lpTemplates.ts` + `convexClient.js` helpers (mapper + whitelist).
2. Build `lpTemplateExtractor.js` service (uses existing `lpSwipeFetcher.js` + Claude Sonnet via `anthropic.js`).
3. Build `routes/lpTemplates.js` with CRUD endpoints. Mount in `server.js`.
4. Build `LPTemplateManager.jsx` component.
5. Rewrite `lpPublisher.js` — replace Cloudflare Pages API with Shopify Admin API. Remove `cloudflare_account_id`, `cloudflare_api_token`, `cloudflare_pages_project` from settings dependencies.
6. Add Shopify config fields to `conductor_config` table. Update UI for configuration.
7. Replace existing "Publish to Cloudflare" in `LPGen.jsx` with "Publish to Shopify."
8. Add `shopify_page_id`, `shopify_handle` fields to `landing_pages` table. Remove `hosting_metadata` Cloudflare references if present.
9. Create `page.lander.liquid` template for test Shopify store.
10. Add corresponding methods to `api.js`.

**Validation**: Manually extract a template from a URL, generate an LP using the existing manual flow, publish to Shopify, verify it renders correctly with the stripped-down template, edit it in `LPGen.jsx`, re-publish.

### Phase 2: Auto-Generation (Director + LP Pipeline)

**Goal**: Director automatically generates two advertorials per batch in parallel.

1. Adapt `lpGenerator.js` prompt chain — add `mode` parameter to steps 2–4 internal functions. Add conditional context blocks for angle, narrative frame, and foundational docs in auto mode. Add new `generateAutoLP()` export as the auto entry point. Verify existing manual flow still works identically.
2. Build `lpAutoGenerator.js` as thin orchestration layer (template selection, narrative frame assignment, calls `generateAutoLP()`, handles publishing + batch record updates).
2. Add LP fields to `batch_jobs` schema + `batchJobs.ts` + `convexBatchToRow` mapper + whitelist.
3. Add remaining LP fields to `landing_pages` schema + `landingPages.ts` + mapper + whitelist.
4. Integrate LP trigger into `conductorEngine.js` `runDirectorForProject()` — fire-and-forget after batch creation.
5. Add verification step to `lpPublisher.js`.
6. Update `BatchManager.jsx` to display LP status on batch records.
7. Add new `api.js` methods.

**Validation**: (1) Existing manual flow — generate an LP from a swipe URL through `LPGen.jsx`, must work identically to today. (2) Auto flow — Director creates a batch, two LPs auto-generate using the adapted prompt chain, publish to Shopify, both verified live. (3) Edit an auto-generated LP in `LPGen.jsx`, re-publish to Shopify.

### Phase 3: Gate + Deployment (Filter Integration)

**Goal**: Filter enforces LP gate and attaches URLs to flex ads.

1. Add LP gate check to `filter.sh` before deploy step.
2. Add `lp_primary_url` and `lp_secondary_url` to `flex_ads` schema + `flexAds.ts` + `convexClient.js` mapper + whitelist.
3. Add retry/escalation logic to `filter.sh` for failed LPs.
4. Update `ReadyToPostView.jsx` to display both LP URLs.
5. Update `CampaignsView.jsx` if LP URLs need to display in Planner view.
6. End-to-end testing: Director creates batch → ads process → LPs generate in parallel → Filter scores → LP gate checks → flex ad deploys to Ready to Post with both URLs.

**Validation**: Full pipeline runs autonomously. Flex ads in Ready to Post have verified LP URLs. Simulated LP failure triggers retry and blocks deployment until resolved.

---

## 8. Cost Impact

Estimated per-advertorial costs:

| Step | Model | Est. Cost |
|---|---|---|
| Copy generation (all slots) | Claude Sonnet 4.6 | $0.03–$0.06 |
| HTML assembly | Claude Sonnet 4.6 | $0.02–$0.04 |
| Image generation (3–5 images) | Gemini 3 Pro | $0.05–$0.10 |
| **Total per advertorial** | — | **$0.10–$0.20** |
| **Total per batch (2 advertorials)** | — | **$0.20–$0.40** |

At 2–3 batches/day across active projects: ~$0.60–$1.20/day in additional LLM costs. Within existing Filter budget headroom ($20/day). Template extraction is a one-time cost (~$0.05–$0.10 per URL).

Shopify Admin API has no per-call cost. Shopify plans include unlimited pages.

---

## 9. Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Claude generates malformed HTML | LP renders broken on Shopify | Verification step catches issues. Retry regenerates HTML. Existing `lpGenerator.js` markdown-fence stripping applies. |
| Gemini image generation fails/rate-limits | LP missing images, gate blocks | Sequential generation respects rate limits. Individual image retry. After 3 failures, regenerate with fewer slots. |
| Shopify API downtime | Cannot publish, gate blocks | Exponential backoff via `retry.js` pattern. Queue and retry automatically. |
| Template extraction produces bad skeleton | Auto-generated LPs look broken | Admin can preview and delete. Validation before storing. Default template fallback if library empty. |
| LP generation slower than batch processing | Rare: ads ready, LPs not yet live | Filter re-checks every 30 min. LPs take ~10 min vs. hours for batches. Self-resolving. |
| `page.lander.liquid` not set up | LP renders with full store chrome | Pre-flight check in `lpPublisher.js`. Error message guides user to create template. |
| Both advertorials too similar | Reduces testing value | Narrative frame system enforces structural differences. Different templates enforce visual differences. Same frame never assigned to both. |
| Prompt adaptation breaks manual flow | Existing manual LP generation stops working | Steps 2–4 receive a `mode` parameter. When `mode: 'manual'`, the prompt behaves identically to today — no angle/frame/foundational doc context is injected. Phase 2 validation explicitly tests manual flow regression. |

---

## 10. Convex Deployment Checklist

Schema/function changes require a **separate** Convex deploy (not included in `deploy.sh`):

1. New table: `lp_templates` in `schema.ts` + new `convex/lpTemplates.ts`
2. Modified: `batch_jobs` (11 new optional fields) in `schema.ts` + updated `batchJobs.ts`
3. Modified: `landing_pages` (6 new optional fields) in `schema.ts` + updated `landingPages.ts`
4. Modified: `flex_ads` (2 new optional fields) in `schema.ts` + updated `flexAds.ts`
5. Modified: `conductor_config` (5 new optional fields) in `schema.ts` + updated `conductor.ts`

All new fields are `v.optional()` — existing records unaffected. All mapper functions and field whitelists in `convexClient.js` must be updated in the **same deploy** as schema changes.

**Deploy command:**
```bash
ssh root@76.13.219.6 "cd /opt/ad-platform && CONVEX_DEPLOYMENT=prod:strong-civet-577 npx convex deploy -y"
```

---

## 11. New Routes Summary

New endpoints to add (mount in `server.js`):

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/api/projects/:id/lp-templates` | GET | admin, manager | List templates for project |
| `/api/projects/:id/lp-templates` | POST | admin, manager | Extract template from URL |
| `/api/projects/:id/lp-templates/:templateId` | GET | admin, manager | Get single template |
| `/api/projects/:id/lp-templates/:templateId` | PUT | admin, manager | Update template name/status |
| `/api/projects/:id/lp-templates/:templateId` | DELETE | admin, manager | Delete template |
| `/api/projects/:id/landing-pages/:lpId/publish-shopify` | POST | admin, manager | Publish LP to Shopify |
| `/api/projects/:id/landing-pages/:lpId/unpublish-shopify` | POST | admin, manager | Unpublish from Shopify |

Rate limiting (10 req/min) on the template extraction endpoint (triggers LLM calls).

Existing `routes/landingPages.js` endpoints are unchanged. New Shopify endpoints can be added to the same file or a new `routes/lpTemplates.js`.

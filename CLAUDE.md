# Ad Creative Automation Platform — CLAUDE.md

> Context file for Claude Code threads. Read this before making any changes.

---

## Before You Edit

**Stop and check the dependency map** before modifying any shared module, pipeline stage, or state shape. A change to `convexClient.js` ripples into 38 files. A change to `api.js` ripples into 24 frontend files. A change to `retry.js` ripples into 12 services.

Before touching any of these:
- **convexClient.js** → Check the 38 files that import it. Mapper functions (`convexProjectToRow`, `convexAdToRow`, `convexBatchToRow`, `convexDocToRow`) are consumed by every route. Changing a mapper's output shape silently breaks all downstream routes.
- **Convex schema (`convex/schema.ts`)** → Changing field names or types requires matching updates in the corresponding Convex function file, `convexClient.js` mapper, route handler, `api.js` frontend method, AND the component consuming the data. Schema changes require a separate `convex deploy` (see Deployment).
- **api.js (frontend)** → 24 files import this. Renaming a method breaks every page/component that calls it.
- **auth.js** → 17 route files depend on `requireAuth` and `requireRole`. Changing the `req.user` shape breaks all route handlers.
- **SSE event shapes** → If you change what a backend SSE stream emits, the corresponding `onEvent` handler in the frontend component must match exactly.
- **Deployment status strings** → `"selected"`, `"ready_to_post"`, `"posted"`, `"analyzing"` are hardcoded across backend routes, convex mutations, frontend components, and the Dacia agents. Renaming any status breaks the pipeline.

**Rule of thumb**: Grep for any identifier you're about to rename before changing it. Trace the full chain: Convex schema → Convex function → convexClient.js helper → route handler → api.js method → React component.

---

## Project Overview

A single-tenant web app for direct response copywriters and e-commerce brands. Five core workflows:

1. **Foundational Doc Generation** — 8-step research pipeline (GPT-4.1 + o3-deep-research) producing customer avatars, offer briefs, and belief documents from a product's sales page.
2. **Quote Mining & Headlines** — Dual-engine search (Perplexity Sonar Pro + Claude Opus 4.6) extracting emotional quotes from online communities, then headline generation via Claude Sonnet 4.6 with 3 reference copywriting docs.
3. **Static Image Ad Generation** — GPT-5.2 creative direction → Google Gemini 3 Pro image generation, single or automated batch via cron schedule.
4. **Ad Pipeline & Meta Integration** — 3-stage deployment pipeline (Planner → Ready to Post → Posted) with campaign hierarchy, flex ads, per-project Meta Ads OAuth, performance data sync.
5. **Landing Page Generation** — Copy + design + HTML generation via Claude Sonnet, split-panel editor, CTA management, one-click publish to Cloudflare Pages.

**Live at**: `daciaautomation.com` (VPS: `76.13.183.219`)
**Convex deployment**: `prod:strong-civet-577` at `https://energized-hare-760.convex.cloud`
**GitHub**: `daciaventures/dacia-automation`

### Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 18 + Vite 5.4 + Tailwind CSS 3.4 + React Router 6 |
| Backend | Node.js + Express 4.21 |
| Database | Convex (cloud-hosted, schema-enforced, 24 tables) |
| File Storage | Convex blob storage |
| LLM (text) | OpenAI — GPT-5.2, GPT-4.1, GPT-4.1-mini, o3-deep-research |
| LLM (copy) | Anthropic — Claude Opus 4.6, Claude Sonnet 4.6 |
| LLM (search) | Perplexity Sonar Pro |
| LLM (images) | Google Gemini 3 Pro Image Preview via `@google/genai` SDK |
| External | Google Drive API v3 (service account); Meta Marketing API v21.0 (per-project OAuth) |
| Auth | bcrypt + express-session + Convex-backed session store + role-based access (Admin/Manager/Poster) |
| Scheduling | node-cron + scheduler service polling Gemini Batch API |
| Process Manager | PM2 (production) |
| Reverse Proxy | Nginx + Let's Encrypt SSL |

---

## Architecture & Data Flow

### How the Layers Connect

```
Browser → Nginx (443) → Express (3001) → Convex Cloud
                                        → OpenAI API
                                        → Anthropic API
                                        → Google Gemini API
                                        → Perplexity API
                                        → Google Drive API
                                        → Meta Marketing API
                                        → Cloudflare Pages API
```

Frontend calls `api.js` methods → Express route handlers → services call LLM APIs + Convex mutations → results stored in Convex → frontend fetches updated data.

### Critical Data Pipelines

**1. Foundational Doc Pipeline** (SSE stream)
```
Sales page text → GPT-4.1 analysis (3 steps) → o3-deep-research (web research, 30min timeout)
  → GPT-4.1 synthesis (Avatar → Offer Brief → Necessary Beliefs) → Convex `foundational_docs`
```
Frontend: `FoundationalDocs.jsx` → `api.generateDocs()` SSE → `docGenerator.js` service

**2. Ad Generation Pipeline** (SSE stream)
```
Foundational docs + inspiration/template image → GPT-5.2 Message 1 (creative direction)
  → GPT-5.2 Message 2 (image via vision API) → [optional: Headline Juicer Message 3]
  → [optional: prompt guidelines review GPT-4.1-mini]
  → Gemini 3 Pro (image generation) → headline/body extracted → Convex `ad_creatives`
```
Frontend: `AdStudio.jsx` → `api.generateAd()` SSE → `adGenerator.js` service

**3. Batch Pipeline** (4-stage, async)
```
Stage 0: Brief extraction (Claude Opus 4.6)
Stage 1: Headline generation (Claude Opus)
Stage 2: Body copy generation (Claude Sonnet, batches of 5)
Stage 3: Image prompt generation (Claude Sonnet)
  → Gemini Batch API submission → scheduler polls every 5 min → `ad_creatives`
```
Frontend: `BatchManager.jsx` → `api.createBatch()` / `api.runBatch()` → `batchProcessor.js`

**4. Ad Deployment Pipeline** (state machine)
```
Ad Gallery → createDeployment → Planner (campaigns/adsets/flex ads)
  → Ready to Post (review details) → Mark as Posted → Posted (history)
```
Status flow: `selected` → `ready_to_post` → `posted` → `analyzing`
Frontend: `CampaignsView.jsx` (Planner) → `ReadyToPostView.jsx` → `PostedView.jsx`

**5. Quote Mining Pipeline** (SSE stream)
```
User config (demographic, problem, keywords) → parallel:
  - Perplexity Sonar Pro (web search)
  - Claude Opus 4.6 (web search)
  → merge + deduplicate + rank → `quote_mining_runs`
  → import to `quote_bank` → per-quote headline generation (Claude Sonnet)
```
Frontend: `QuoteMiner.jsx` → `api.startQuoteMining()` SSE → `quoteBankService.js`

**6. Landing Page Pipeline** (SSE stream, single endpoint)
```
Swipe URL (Puppeteer fetch) or PDF upload → design analysis (Claude Sonnet)
  → copy generation (Claude Sonnet) → image slot generation (Gemini)
  → HTML template generation (Claude Sonnet) → assembly → `landing_pages`
  → [publish: sharp image optimization → Cloudflare Pages Direct Upload]
```
Frontend: `LPGen.jsx` → `api.generateLandingPage()` SSE → `lpGenerator.js` + `lpPublisher.js`

### Paths That Must Stay in Sync

| If you change... | Also update... |
|------------------|----------------|
| Convex schema field name | Convex function file, `convexClient.js` mapper, route handler, `api.js`, React component |
| Deployment status values | `ad_deployments.ts`, `convexClient.js`, `routes/deployments.js`, `CampaignsView.jsx`, `ReadyToPostView.jsx`, `PostedView.jsx`, Dacia agents |
| `flex_ads.child_deployment_ids` shape | `flexAds.ts`, `convexClient.js`, `CampaignsView.jsx`, `ReadyToPostView.jsx` |
| LLM wrapper function signature | Every service that calls it (see dependency map below) |
| `api.js` method name or params | Every frontend file that calls it (see dependency map below) |
| SSE event format | Backend route + frontend `onEvent` handler in the corresponding component |
| Cost tracking rates | `costTracker.js` rate tables + Settings UI display |

---

## Dependency Map

Every shared module imported by 2+ files. **This is the most critical section** — check here before modifying any shared code.

### Backend: Core Infrastructure

**`backend/convexClient.js`** (100+ helpers, central data layer) → used by **38 files**:
- `backend/server.js`
- `backend/auth.js`
- `backend/ConvexSessionStore.js`
- `backend/utils/adImages.js`
- `backend/routes/auth.js`
- `backend/routes/users.js`
- `backend/routes/projects.js`
- `backend/routes/settings.js`
- `backend/routes/documents.js`
- `backend/routes/upload.js`
- `backend/routes/drive.js`
- `backend/routes/templates.js`
- `backend/routes/ads.js`
- `backend/routes/batches.js`
- `backend/routes/costs.js`
- `backend/routes/deployments.js`
- `backend/routes/quoteMining.js`
- `backend/routes/chat.js`
- `backend/routes/meta.js`
- `backend/routes/landingPages.js`
- `backend/routes/agentMonitor.js`
- `backend/services/openai.js`
- `backend/services/anthropic.js`
- `backend/services/gemini.js`
- `backend/services/costTracker.js`
- `backend/services/adGenerator.js`
- `backend/services/docGenerator.js`
- `backend/services/batchProcessor.js`
- `backend/services/quoteMiner.js`
- `backend/services/headlineGenerator.js`
- `backend/services/quoteDedup.js`
- `backend/services/quoteBankService.js`
- `backend/services/metaAds.js`
- `backend/services/correctionHistory.js`
- `backend/services/scheduler.js`
- `backend/services/lpGenerator.js`
- `backend/services/lpSwipeFetcher.js`
- `backend/services/lpPublisher.js`

**`backend/auth.js`** (`requireAuth`, `requireRole`) → used by **17 files**:
- `backend/server.js`
- `backend/routes/auth.js`
- `backend/routes/users.js`
- `backend/routes/projects.js`
- `backend/routes/settings.js`
- `backend/routes/documents.js`
- `backend/routes/upload.js`
- `backend/routes/drive.js`
- `backend/routes/templates.js`
- `backend/routes/ads.js`
- `backend/routes/batches.js`
- `backend/routes/costs.js`
- `backend/routes/deployments.js`
- `backend/routes/quoteMining.js`
- `backend/routes/chat.js`
- `backend/routes/meta.js`
- `backend/routes/landingPages.js`

**`backend/services/retry.js`** (`withRetry`) → used by **12 files**:
- `backend/convexClient.js`
- `backend/routes/chat.js`
- `backend/routes/drive.js`
- `backend/utils/adImages.js`
- `backend/services/openai.js`
- `backend/services/anthropic.js`
- `backend/services/gemini.js`
- `backend/services/costTracker.js`
- `backend/services/batchProcessor.js`
- `backend/services/quoteMiner.js`
- `backend/services/headlineGenerator.js`
- `backend/services/metaAds.js`

**`backend/services/costTracker.js`** (auto-logging for all LLM calls) → used by **10 files**:
- `backend/routes/chat.js`
- `backend/routes/settings.js`
- `backend/routes/costs.js`
- `backend/services/openai.js`
- `backend/services/anthropic.js`
- `backend/services/gemini.js`
- `backend/services/batchProcessor.js`
- `backend/services/quoteMiner.js`
- `backend/services/headlineGenerator.js`
- `backend/services/scheduler.js`

### Backend: LLM Service Wrappers

**`backend/services/openai.js`** (`chat`, `chatStream`, `deepResearch`, `chatWithImage`, `chatWithImages`) → used by **6 files**:
- `backend/routes/templates.js`
- `backend/services/adGenerator.js`
- `backend/services/docGenerator.js`
- `backend/services/quoteMiner.js`
- `backend/services/quoteDedup.js`
- `backend/services/bodyCopyGenerator.js`

**`backend/services/anthropic.js`** (`chat`, `chatWithImage`, `chatWithMultipleImages`) → used by **5 files**:
- `backend/routes/ads.js`
- `backend/routes/deployments.js`
- `backend/services/adGenerator.js`
- `backend/services/docGenerator.js`
- `backend/services/lpGenerator.js`

**`backend/services/gemini.js`** (`generateImage`, `getClient`) → used by **4 files**:
- `backend/routes/landingPages.js`
- `backend/services/adGenerator.js`
- `backend/services/batchProcessor.js`
- `backend/services/lpGenerator.js`

**`backend/services/quoteMiner.js`** (`runQuoteMining`, `generateSuggestions`, `getAnthropicClient`) → used by **4 files**:
- `backend/routes/chat.js`
- `backend/routes/quoteMining.js`
- `backend/services/headlineGenerator.js`
- `backend/services/quoteBankService.js`

### Backend: Utilities

**`backend/utils/sseHelper.js`** (`createSSEStream`, `streamService`) → used by **5 files**:
- `backend/routes/ads.js`
- `backend/routes/chat.js`
- `backend/routes/documents.js`
- `backend/routes/landingPages.js`
- `backend/routes/quoteMining.js`

**`backend/services/rateLimiter.js`** (`withHeavyLLMLimit`, `withGeminiLimit`) → used by **3 files**:
- `backend/server.js`
- `backend/services/adGenerator.js`
- `backend/services/gemini.js`

**`backend/services/adGenerator.js`** (ad generation + batch helpers) → used by **2 files**:
- `backend/routes/ads.js`
- `backend/services/batchProcessor.js`

**`backend/services/batchProcessor.js`** (`runBatch`, `pollBatchJob`) → used by **2 files**:
- `backend/routes/batches.js`
- `backend/services/scheduler.js`

**`backend/services/metaAds.js`** (OAuth, sync, performance) → used by **2 files**:
- `backend/routes/meta.js`
- `backend/services/scheduler.js`

**`backend/services/scheduler.js`** (`initScheduler`, `loadScheduledBatches`) → used by **2 files**:
- `backend/server.js`
- `backend/routes/batches.js`

**`backend/services/quoteDedup.js`** → used by **2 files**:
- `backend/routes/quoteMining.js`
- `backend/services/quoteBankService.js`

**`backend/services/bodyCopyGenerator.js`** → used by **2 files**:
- `backend/routes/ads.js`
- `backend/routes/quoteMining.js`

**`backend/services/lpGenerator.js`** → used by **2 files**:
- `backend/routes/landingPages.js`
- `backend/services/lpPublisher.js`

### Backend: Third-Party Packages (imported in 4+ files)

**`uuid` (v4)** → used by **19 files**:
- `backend/auth.js`
- `backend/routes/auth.js`, `users.js`, `projects.js`, `chat.js`, `documents.js`, `landingPages.js`, `batches.js`, `templates.js`, `agentMonitor.js`
- `backend/services/adGenerator.js`, `docGenerator.js`, `batchProcessor.js`, `costTracker.js`, `quoteDedup.js`, `quoteBankService.js`, `correctionHistory.js`, `metaAds.js`, `lpPublisher.js`

**`multer`** → used by **4 files**:
- `backend/routes/projects.js`, `templates.js`, `landingPages.js`, `upload.js`

### Frontend: Shared Modules

**`frontend/src/api.js`** (150+ API methods) → used by **24 files**:
- `frontend/src/App.jsx`
- `frontend/src/pages/Login.jsx`, `Dashboard.jsx`, `Projects.jsx`, `ProjectSetup.jsx`, `ProjectDetail.jsx`, `Settings.jsx`, `AdTracker.jsx`
- `frontend/src/components/Layout.jsx`, `AdStudio.jsx`, `BatchManager.jsx`, `FoundationalDocs.jsx`, `TemplateImages.jsx`, `QuoteMiner.jsx`, `CopywriterChat.jsx`, `ReadyToPostView.jsx`, `CampaignsView.jsx`, `PostedView.jsx`, `LPGen.jsx`, `InspirationFolder.jsx`, `DriveFolderPicker.jsx`, `DragDropUpload.jsx`, `AgentMonitor.jsx`, `CreativeFilterSettings.jsx`

**`frontend/src/components/Toast.jsx`** (`useToast`) → used by **11 files**:
- `frontend/src/App.jsx`
- `frontend/src/pages/Projects.jsx`, `ProjectDetail.jsx`, `Settings.jsx`, `AdTracker.jsx`
- `frontend/src/components/AdStudio.jsx`, `BatchManager.jsx`, `LPGen.jsx`, `QuoteMiner.jsx`, `FoundationalDocs.jsx`, `CreativeFilterSettings.jsx`

**`frontend/src/components/InfoTooltip.jsx`** → used by **8 files**:
- `frontend/src/pages/Dashboard.jsx`, `Projects.jsx`, `ProjectDetail.jsx`, `Settings.jsx`
- `frontend/src/components/AdStudio.jsx`, `BatchManager.jsx`, `TemplateImages.jsx`, `FoundationalDocs.jsx`, `LPGen.jsx`

**`frontend/src/hooks/useAsyncData.js`** → used by **6 files**:
- `frontend/src/pages/Projects.jsx`, `AdTracker.jsx`
- `frontend/src/components/AdStudio.jsx`, `TemplateImages.jsx`, `QuoteMiner.jsx`, `FoundationalDocs.jsx`

**`frontend/src/components/DragDropUpload.jsx`** → used by **3 files**:
- `frontend/src/pages/Settings.jsx`, `ProjectSetup.jsx`
- `frontend/src/components/FoundationalDocs.jsx`

**`frontend/src/components/ErrorBoundary.jsx`** → used by **2 files**:
- `frontend/src/App.jsx`
- `frontend/src/pages/ProjectDetail.jsx`

**`frontend/src/hooks/usePolling.js`** → used by **3 files**:
- `frontend/src/components/BatchManager.jsx`, `QuoteMiner.jsx`, `AdStudio.jsx`

**`frontend/src/hooks/useSSEStream.js`** → used by **1 file**:
- `frontend/src/components/FoundationalDocs.jsx`

**`frontend/src/components/batchUtils.js`** → used by **2 files**:
- `frontend/src/components/BatchManager.jsx`, `BatchRow.jsx`

---

## Critical Invariants

Rules that must never be violated. Breaking these causes silent failures or data corruption.

### Data Shape Contracts

1. **`externalId` is the foreign key, not `_id`**. All cross-table references use UUID `externalId` strings. Convex native `_id` is never used for relationships. Exception: `inspiration_images` has no `externalId` — it uses composite key `(project_id, drive_file_id)`.

2. **JSON arrays stored as strings**. These fields look like arrays but are `v.string()` in the schema — you must `JSON.parse()` to read and `JSON.stringify()` to write:
   - `batch_jobs.angles`, `batch_jobs.gpt_prompts`, `batch_jobs.used_template_ids`, `batch_jobs.pipeline_state`, `batch_jobs.template_image_ids`, `batch_jobs.inspiration_image_ids`
   - `flex_ads.child_deployment_ids`, `flex_ads.primary_texts`, `flex_ads.headlines`
   - `ad_deployments.primary_texts`, `ad_deployments.ad_headlines`
   - `quote_mining_runs.quotes`, `quote_mining_runs.keywords`, `quote_mining_runs.subreddits`, `quote_mining_runs.forums`, `quote_mining_runs.facebook_groups`, `quote_mining_runs.headlines`
   - `quote_bank.headlines`, `quote_bank.tags`
   - `landing_pages.copy_sections`, `landing_pages.image_slots`, `landing_pages.cta_links`, `landing_pages.swipe_design_analysis`, `landing_pages.hosting_metadata`
   - `correction_history.changes`
   - `landing_page_versions.copy_sections`, `landing_page_versions.image_slots`, `landing_page_versions.cta_links`

3. **Soft-delete pattern**. `ad_deployments` and `flex_ads` use `deleted_at` timestamp. All queries MUST filter out `deleted_at` records. Hard purge runs daily at 1am for records >30 days old.

4. **`convexBatchToRow` converts `scheduled` boolean to 0/1 integer**. Frontend code must use `!!batch.scheduled` not bare `batch.scheduled` in JSX to avoid rendering `0`.

5. **Mapper functions normalize Convex objects to rows**. Every route handler receives Convex data through mappers in `convexClient.js`. If you add a field to the schema, you MUST also add it to the mapper or it won't appear in API responses.

### API Response Formats

6. **SSE events follow a fixed structure**. All SSE endpoints emit events as `data: ${JSON.stringify(event)}\n\n`. Event objects always have a `type` field. Common types: `progress`, `step`, `complete`, `error`, `result`. Components parse these in `onEvent` callbacks.

7. **Cost logging is fire-and-forget**. Every LLM wrapper auto-logs costs inside itself. Callers pass `{ operation, projectId }` via options. The logging call uses `.catch(() => {})` — failures are silently swallowed. Never await cost logging.

8. **Deployment status values are hardcoded strings**. The exact values `"selected"`, `"ready_to_post"`, `"posted"`, `"analyzing"` are used across the entire stack. No enum or constant — just raw strings everywhere.

### Authentication & Authorization

9. **Three roles: `admin`, `manager`, `poster`**. Poster can ONLY see the Ad Pipeline tab (Ready to Post + Posted). Poster cannot access Planner, create projects, access Dashboard, or Settings. Backend enforces via `requireRole('admin', 'manager')` on protected routes.

10. **`req.user` shape**: `{ id, username, role, displayName }`. Populated by `requireAuth` middleware from session. Every route handler depends on this shape.

11. **Session secret is auto-generated and stored in Convex settings**. First server start generates a random 64-char hex string via `crypto.randomBytes(32)`. Stored as `session_secret` setting.

### Naming & Conventions

12. **`project_id` everywhere means `projects.externalId`** (a UUID string), not the Convex `_id`.

13. **Convex functions are queries + mutations only**. No Convex actions. All LLM calls, file processing, and external API work happens in Express backend.

14. **File naming**: camelCase for JS/JSX, PascalCase for React components, snake_case for Convex table names and fields.

---

## Common Pitfalls

Based on actual patterns in this codebase, these are the changes most likely to cause breakage.

### The #1 Gotcha: Forgetting Convex Deploy

`deploy.sh` only deploys backend + frontend. Schema or function changes require a SEPARATE command:
```bash
ssh root@76.13.183.219 "cd /opt/ad-platform && npx convex deploy -y"
```
Forgetting this is the top cause of "field not saving" or "function not found" bugs.

### Adding a New Field to a Table

You must update ALL of these or data silently vanishes:
1. `convex/schema.ts` — Add the field
2. `convex/{table}.ts` — Add to `create` and `update` mutation args, add to any queries that return the field
3. `backend/convexClient.js` — Add to the mapper function AND to the helper function's whitelist
4. `backend/routes/{route}.js` — Read/write the field in the API handler
5. `frontend/src/api.js` — If the frontend needs it, expose it in the API method
6. Frontend component — Consume the field
7. Deploy Convex separately (`npx convex deploy -y` on VPS)

### Adding a New npm Dependency

`package.json` is excluded from rsync in `deploy.sh`. You must SSH in and install manually:
```bash
ssh root@76.13.183.219 "cd /opt/ad-platform/backend && npm install <package>"
```

### React `&&` with Numeric Values

When using `&&` for conditional rendering, always use `!!value &&` or `value > 0 &&` for numbers. The `batch.scheduled` field (stored as 0/1) renders `0` as visible text if you write `batch.scheduled && <Component />`.

### Changing SSE Event Shapes

Backend and frontend are tightly coupled on SSE events. If you change what an SSE route emits (e.g., adding a field to a `progress` event), the frontend `onEvent` handler in the corresponding component must be updated simultaneously. There's no type checking between them.

### Breaking the Retry System

`retry.js` is imported by 12 files. Its `defaultShouldRetry` predicate specifically does NOT retry 4xx errors (except 429). If you change this behavior, all LLM calls across the system are affected. The 429-specific longer delay (15s base) is critical for OpenAI's aggressive rate limits.

### Rate Limiter Concurrency

Two independent limiters exist:
- `withHeavyLLMLimit()` — concurrency=2, 2s gap. Used for GPT-5.2 and heavy Claude calls.
- `withGeminiLimit()` — concurrency=3. Used for all Gemini image generation.

Increasing concurrency will cause 429 errors. The current values were tuned to avoid rate limits.

### convexClient.js Update Whitelists

Helper functions like `updateProject()`, `updateBatchJob()`, `updateDeployment()` use explicit field whitelists. If you add a new field to the schema and mutation but forget to add it to the convexClient.js whitelist, the update silently drops the field.

### Thumbnail Cache

Lives at `backend/.thumb-cache/`. Fire-and-forget writes. If the cache gets corrupted, delete the directory — thumbnails regenerate on next request by falling back to full Convex CDN images.

### Meta Token Expiry

Meta access tokens expire ~60 days. Scheduler auto-refreshes weekly. If expired, the user must reconnect in project settings. The system does not surface token expiry warnings proactively.

### OpenAI 429 Errors

The current OpenAI account hits 429 on nearly every first attempt. The retry system handles this (15s+ backoff), but generation takes ~50s per ad as a result. This is expected behavior, not a bug.

### Deep Research Timeout

o3-deep-research has a 30-minute timeout. It runs via the Responses API with polling every 5 seconds. Falls back gracefully on timeout — the doc pipeline continues with whatever research was available.

### 50MB JSON Body Limit

Express is configured with `express.json({ limit: '50mb' })` for large sales page content and research outputs. If you add a body-size-sensitive middleware before the JSON parser, it may conflict.

### LP HTML Code Fences

Claude sometimes wraps generated HTML in markdown code fences (` ```html...``` `). The `lpGenerator.js` service auto-strips these. If you move HTML generation to a different service, remember to handle this.

---

## File Structure

```
ad-platform/
├── backend/
│   ├── server.js                    # Express entry point (port 3001), middleware stack, route mounting
│   ├── auth.js                      # requireAuth + requireRole middleware, multi-user migration
│   ├── convexClient.js              # Central data layer (100+ helpers, mappers, retry-wrapped)
│   ├── ConvexSessionStore.js        # Custom express-session store backed by Convex
│   ├── routes/
│   │   ├── auth.js                  # Login/setup/session (rate-limited 5/min)
│   │   ├── users.js                 # User CRUD (admin only)
│   │   ├── projects.js              # Project CRUD + product image upload
│   │   ├── documents.js             # Doc generation (SSE), upload, correction, reversion
│   │   ├── ads.js                   # Ad generation (Mode 1/2), prompt editing, tags, gallery
│   │   ├── batches.js               # Batch job CRUD + scheduling + cancel
│   │   ├── costs.js                 # Cost aggregation + history + rates
│   │   ├── drive.js                 # Google Drive sync + folder browsing + inspiration images
│   │   ├── templates.js             # Template image management + AI analysis
│   │   ├── upload.js                # File upload + text extraction (PDF/DOCX/EPUB/Excel/etc.)
│   │   ├── settings.js              # API keys, rates, headline refs (admin only)
│   │   ├── deployments.js           # Ad Pipeline CRUD (deployments, campaigns, ad sets, flex ads)
│   │   ├── quoteMining.js           # Quote mining runs, quote bank, headline generation
│   │   ├── chat.js                  # Copywriter Chat (Claude Sonnet, multimodal attachments)
│   │   ├── landingPages.js          # LP CRUD, generation (SSE), publishing, image management
│   │   ├── meta.js                  # Meta OAuth, campaign browsing, performance sync
│   │   └── agentMonitor.js          # Agent Dashboard: Fixer + Filter status and triggers
│   ├── services/
│   │   ├── openai.js                # GPT-5.2, GPT-4.1, GPT-4.1-mini, o3-deep-research
│   │   ├── anthropic.js             # Claude Opus 4.6 + Sonnet 4.6 (JSON mode, PDF support)
│   │   ├── gemini.js                # Gemini 3 Pro Image generation (rate-limited)
│   │   ├── adGenerator.js           # Ad generation orchestrator (Mode 1/2, Headline Juicer)
│   │   ├── batchProcessor.js        # 4-stage batch pipeline + Gemini Batch API
│   │   ├── docGenerator.js          # 8-step foundational doc pipeline
│   │   ├── quoteMiner.js            # Dual-engine quote search (Perplexity + Claude)
│   │   ├── headlineGenerator.js     # Headline generation (Claude Sonnet + 3 reference docs)
│   │   ├── bodyCopyGenerator.js     # Body copy from headline + quote context
│   │   ├── quoteBankService.js      # Quote bank orchestration (import, headlines, backfill)
│   │   ├── quoteDedup.js            # Quote deduplication (GPT-4.1-mini comparison)
│   │   ├── costTracker.js           # 5-service cost logging + OpenAI billing sync + Gemini rate scraping
│   │   ├── scheduler.js             # 6 automated cron tasks + user-defined batch schedules
│   │   ├── metaAds.js               # Meta OAuth, token refresh, performance sync
│   │   ├── rateLimiter.js           # AsyncSemaphore (heavy LLM=2, Gemini=3)
│   │   ├── retry.js                 # Exponential backoff (5 retries, 429-aware)
│   │   ├── lpGenerator.js           # LP copy + design + HTML generation (Claude Sonnet)
│   │   ├── lpPublisher.js           # Cloudflare Pages deployment
│   │   ├── lpSwipeFetcher.js        # Puppeteer headless page capture
│   │   └── correctionHistory.js     # Correction audit trail (log, apply, revert)
│   └── utils/
│       ├── sseHelper.js             # SSE stream setup + service wrapper
│       └── adImages.js              # Product image loading, ad enrichment, thumbnails
│
├── frontend/
│   ├── src/
│   │   ├── App.jsx                  # Router + ProtectedRoute + AuthContext + lazy loading
│   │   ├── main.jsx                 # React entry (BrowserRouter)
│   │   ├── api.js                   # 150+ API methods (fetch wrapper + SSE helpers)
│   │   ├── index.css                # Tailwind layers + custom component classes
│   │   ├── pages/
│   │   │   ├── Login.jsx            # Multi-user auth + first-run setup
│   │   │   ├── Dashboard.jsx        # Cost cards + bar chart + rates + roadmap
│   │   │   ├── Projects.jsx         # Project grid with stats
│   │   │   ├── ProjectSetup.jsx     # New project wizard
│   │   │   ├── ProjectDetail.jsx    # Tabbed project hub (role-filtered tabs)
│   │   │   ├── Settings.jsx         # API keys, Drive, rates, refs, users (admin)
│   │   │   └── AdTracker.jsx        # Ad Pipeline wrapper (Planner/Ready/Posted tabs)
│   │   ├── components/
│   │   │   ├── Layout.jsx           # Glass navbar + segmented control + user badge
│   │   │   ├── Toast.jsx            # Toast notification context + component
│   │   │   ├── ErrorBoundary.jsx    # React error boundary
│   │   │   ├── InfoTooltip.jsx      # Pure CSS hover tooltip
│   │   │   ├── DragDropUpload.jsx   # Reusable file upload
│   │   │   ├── MultiInput.jsx       # Multi-value tag input
│   │   │   ├── NotionFilter.jsx     # Notion-style filter bar
│   │   │   ├── DriveFolderPicker.jsx # Drive folder browser modal
│   │   │   ├── GenerationQueue.jsx  # Ad generation queue display
│   │   │   ├── CostSummaryCards.jsx # Dashboard cost widgets
│   │   │   ├── CostBarChart.jsx     # 30-day stacked bar chart (SVG)
│   │   │   ├── AdStudio.jsx         # Ad generation UI + gallery + bulk actions
│   │   │   ├── BatchManager.jsx     # Batch job management (~2500 lines)
│   │   │   ├── BatchRow.jsx         # Individual batch row component
│   │   │   ├── batchUtils.js        # Batch constants, cron helpers
│   │   │   ├── FoundationalDocs.jsx # Doc generation + correction + history
│   │   │   ├── QuoteMiner.jsx       # Quote mining + bank + headlines
│   │   │   ├── CopywriterChat.jsx   # Chat widget (Claude, multimodal)
│   │   │   ├── CampaignsView.jsx    # Planner (campaigns → ad sets → flex ads)
│   │   │   ├── ReadyToPostView.jsx  # Ready to Post cards + copy tracking
│   │   │   ├── PostedView.jsx       # Posted history
│   │   │   ├── LPGen.jsx            # Landing page generator
│   │   │   ├── TemplateImages.jsx   # Template upload + Drive sync + analysis
│   │   │   ├── InspirationFolder.jsx # Drive inspiration sync
│   │   │   ├── AgentMonitor.jsx     # Agent Dashboard (Fixer + Filter)
│   │   │   └── CreativeFilterSettings.jsx # Per-project Filter config
│   │   └── hooks/
│   │       ├── useAsyncData.js      # Fetch + loading + refetch hook
│   │       ├── useSSEStream.js      # SSE streaming hook
│   │       └── usePolling.js        # Interval polling hook
│   ├── vite.config.js               # Dev proxy → localhost:3001
│   ├── tailwind.config.js           # Navy-gold-teal palette, custom shadows
│   └── package.json                 # React 18, Vite 5, Tailwind 3, Router 6
│
├── convex/
│   ├── schema.ts                    # Full database schema (24 tables)
│   ├── settings.ts                  # Key-value settings CRUD
│   ├── projects.ts                  # Projects CRUD + stats + product image
│   ├── foundationalDocs.ts          # Docs CRUD with versioning
│   ├── adCreatives.ts               # Ad CRUD + storage URL resolution
│   ├── batchJobs.ts                 # Batch state machine + pipeline tracking
│   ├── apiCosts.ts                  # Cost logging + aggregation
│   ├── campaigns.ts                 # Campaign CRUD
│   ├── adSets.ts                    # Ad set CRUD
│   ├── flexAds.ts                   # Flex ad groups (soft-delete)
│   ├── ad_deployments.ts            # Deployment tracking (soft-delete, dedup guard)
│   ├── templateImages.ts            # Template storage
│   ├── inspirationImages.ts         # Drive-synced images (no externalId)
│   ├── quote_mining_runs.ts         # Mining run records
│   ├── quote_bank.ts                # Individual quotes + headlines
│   ├── chatThreads.ts              # Chat threads + messages
│   ├── correction_history.ts       # Correction audit trail
│   ├── metaPerformance.ts          # Meta ad metrics (upsert on date+ad)
│   ├── dashboard_todos.ts          # Roadmap todos
│   ├── landingPages.ts             # Landing page CRUD
│   ├── landingPageVersions.ts      # Version snapshots
│   ├── users.ts                    # Multi-user accounts
│   ├── sessions.ts                 # Session store (get/set/destroy/cleanup)
│   └── fileStorage.ts              # Storage URL helpers
│
├── deploy/
│   ├── deploy.sh                    # Rsync → npm install → vite build → PM2 restart
│   ├── setup.sh                     # VPS initial setup (Node 22, PM2, Nginx, Certbot)
│   ├── ecosystem.config.cjs         # PM2 config (port 3001, 512MB max)
│   └── nginx.conf                   # Reverse proxy + SSL + caching + gzip
│
├── dacia-fixer/                     # Recursive Agent #1: auto-test, self-heal, batch resurrection
└── dacia-creative-filter/           # Recursive Agent #2: score ads, create flex ads, deploy to RTP
```

---

## Deployment

### Frontend + Backend
```bash
VPS_HOST=76.13.183.219 bash deploy/deploy.sh
```

### Convex (schema/function changes) — SEPARATE STEP
```bash
ssh root@76.13.183.219 "cd /opt/ad-platform && npx convex deploy -y"
```

### Build Frontend Locally
```bash
source ~/.zshrc 2>/dev/null && cd frontend && npm run build
```

### VPS Details
- **IP**: 76.13.183.219 | **App path**: `/opt/ad-platform` | **Port**: 3001
- **PM2**: `ad-platform` (single instance, 512MB max) | **Logs**: `/opt/ad-platform/logs/`
- **Nginx**: Port 443 → localhost:3001 | **SSL**: Let's Encrypt

---

## Styling Quick Reference

**Color Tokens** (defined in `tailwind.config.js`):
- `navy` (#0B1D3A) / `navy-light` (#132B52) — Primary brand, navbar, buttons, headings
- `gold` (#C4975A) — Accent, hover states, links
- `teal` (#2A9D8F) — Success states
- `offwhite` (#FAFAF8) — Page backgrounds
- `textdark` (#1A1A2E) — Primary text
- `textmid` (#4A5568) — Secondary text
- `textlight` (#8A96A8) — Tertiary text, placeholders

**Data Viz**: OpenAI=#5B8DEF, Anthropic=#7C6DCD, Gemini=#2A9D8F, Perplexity=#C4975A

**Custom CSS Classes** (`index.css`): `.glass-nav`, `.card`, `.btn-primary`, `.btn-secondary`, `.input-apple`, `.segmented-control`, `.badge`, `.info-tooltip`

**Text sizes**: Compact UI using `text-[10px]` through `text-[15px]`

---

## Settings & Secrets

**Stored in Convex `settings` table** (not .env): All API keys (OpenAI, Anthropic, Gemini, Perplexity), Gemini rates, session secret, Drive folder ID, Cloudflare credentials, headline reference docs, Meta OAuth state.

**On disk**: `config/service-account.json` (Google Drive, gitignored)

**PM2 env vars**: Only `NODE_ENV`, `PORT`, `CONVEX_URL`. Everything else lives in Convex.

---

## Scheduler (6 Automated Tasks)

1. Poll active batches every 5 min + auto-retry up to 3×
2. Sync OpenAI costs hourly from billing API
3. Purge soft-deleted records >30 days daily at 1am
4. Refresh Gemini rates daily at midnight
5. Sync Meta performance every 30 min per-project
6. Refresh Meta tokens weekly Monday 3am

Plus user-defined cron schedules for recurring batches.

---

## Dacia Recursive Agents

### Agent #1: Dacia Fixer (`/dacia-fixer`)
Auto-test, self-heal code, resurrect failed batches. $40/month budget. Runs every 5 min via cron. Commits to `fixer/auto-fixes` branch (never main). Fix Ledger (`fix_ledger.md`) is institutional memory — DO NOT DELETE.

### Agent #2: Dacia Creative Filter (`/dacia-creative-filter`)
Score batch ads (Claude Sonnet 4.6), group winners into flex ads (10 images each), deploy to Ready to Post. $31/month budget. Runs every 30 min. Opt-in only (`filter_assigned=true` on batch). Per-brand daily cap via `scout_daily_flex_ads` (1-10, default 2).

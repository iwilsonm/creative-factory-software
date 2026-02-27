# Ad Creative Automation Platform — CLAUDE.md

> Context file for Claude Code threads. Read this before making any changes.
> Last updated: 2026-02-27 (VPS migration to 76.13.219.6)

---

## Before You Edit

**Stop and check the dependency map** before modifying any shared module, pipeline stage, or state shape. A change to `convexClient.js` ripples into 41 files. A change to `api.js` ripples into 24 frontend files. A change to `retry.js` ripples into 12 files.

Before touching any of these:
- **convexClient.js** → Check the **41 files** that import it. Mapper functions (`convexProjectToRow`, `convexAdToRow`, `convexBatchToRow`, `convexDocToRow`) are consumed by every route. Changing a mapper's output shape silently breaks all downstream routes. Helper functions use explicit field whitelists — adding a new field to the schema without adding it to the whitelist means the update silently drops the field.
- **Convex schema (`convex/schema.ts`)** → Changing field names or types requires matching updates in the corresponding Convex function file, `convexClient.js` mapper, route handler, `api.js` frontend method, AND the component consuming the data. Schema changes require a separate `convex deploy` (see Deployment).
- **api.js (frontend)** → **24 files** import this. Renaming a method breaks every page/component that calls it.
- **auth.js** → **16 route files** + `server.js` depend on `requireAuth` and `requireRole`. Changing the `req.user` shape (`{ id, username, role, displayName }`) breaks all route handlers.
- **retry.js** → **12 files** import `withRetry`. Its `defaultShouldRetry` predicate does NOT retry 4xx errors except 429. Changing this affects all LLM calls system-wide. The 429-specific longer delay (15s base) is critical for OpenAI's rate limits.
- **costTracker.js** → **11 files** import cost logging functions. Every LLM wrapper auto-logs costs. Callers pass `{ operation, projectId }` via options. Changing the logging signature breaks all wrappers.
- **SSE event shapes** → If you change what a backend SSE stream emits, the corresponding `onEvent` handler in the frontend component must match exactly. There is no type checking between them.
- **Deployment status strings** → `"selected"`, `"ready_to_post"`, `"posted"`, `"analyzing"` are hardcoded across backend routes, Convex mutations, frontend components, and the Dacia agents. Renaming any status breaks the pipeline.
- **Error response shape** → All API endpoints use `{ error: err.message }` for errors and `{ success: true }` for mutations. This was standardized in the audit — new routes must follow this pattern.
- **Cascade deletion pattern** → `campaigns.remove()` cascade-deletes child ad_sets and soft-deletes child flex_ads. `adSets.remove()` soft-deletes child flex_ads. New hierarchical entities must follow this pattern.
- **Agent lock files** → Both Fixer and Filter use `/tmp/dacia-{agent}.lock` with PID checking. New agents must follow this same pattern.
- **Agent spend files** → Both agents use `flock` for atomic read/write of daily spend files. This prevents race conditions from concurrent cron runs.

**Rule of thumb**: Grep for any identifier you're about to rename before changing it. Trace the full chain: Convex schema → Convex function → convexClient.js helper → route handler → api.js method → React component.

---

## Project Overview

A single-tenant web app for direct response copywriters and e-commerce brands. Six core workflows:

1. **Foundational Doc Generation** — 8-step research pipeline (GPT-4.1 + o3-deep-research) producing customer avatars, offer briefs, and belief documents from a product's sales page.
2. **Quote Mining & Headlines** — Dual-engine search (Perplexity Sonar Pro + Claude Opus 4.6) extracting emotional quotes from online communities, then headline generation via Claude Sonnet 4.6 with 3 reference copywriting docs.
3. **Static Image Ad Generation** — GPT-5.2 creative direction → Google Gemini 3 Pro image generation, single or automated batch via cron schedule.
4. **Ad Pipeline & Meta Integration** — 3-stage deployment pipeline (Planner → Ready to Post → Posted) with campaign hierarchy, flex ads, per-project Meta Ads OAuth, performance data sync.
5. **Landing Page Generation** — Copy + design + HTML generation via Claude Sonnet, split-panel editor, CTA management, one-click publish to Cloudflare Pages.
6. **Autonomous Agent System** — Three agents (Fixer, Creative Filter, Director) that auto-test, auto-heal, score ads, create flex ads, plan batches, and learn from results.

**Live at**: `daciaautomation.com` (VPS: `76.13.219.6`)
**Convex deployment**: `prod:strong-civet-577` at `https://energized-hare-760.convex.cloud`
**GitHub**: `daciaventures/dacia-automation`

### Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 18 + Vite 5.4 + Tailwind CSS 3.4 + React Router 6 |
| Backend | Node.js 22 LTS + Express 4.21 |
| Database | Convex (cloud-hosted, schema-enforced, 29 tables) |
| File Storage | Convex blob storage |
| LLM (text) | OpenAI — GPT-5.2, GPT-4.1, GPT-4.1-mini, o3-deep-research |
| LLM (copy) | Anthropic — Claude Opus 4.6, Claude Sonnet 4.6 |
| LLM (search) | Perplexity Sonar Pro |
| LLM (images) | Google Gemini 3 Pro Image Preview via `@google/genai` SDK |
| External | Google Drive API v3 (service account); Meta Marketing API v21.0 (per-project OAuth); Cloudflare Pages API |
| Auth | bcrypt + express-session + Convex-backed session store + role-based access (Admin/Manager/Poster) |
| Security | helmet (CSP), express-rate-limit, SSRF protection, field whitelisting |
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

Cron (VPS) → filter.sh → Express (3001) → Convex Cloud
Cron (VPS) → fixer.sh  → Express (3001) → Convex Cloud
Scheduler  → conductorEngine.js → Convex Cloud + Anthropic API
```

Frontend calls `api.js` methods → Express route handlers → services call LLM APIs + Convex mutations → results stored in Convex → frontend fetches updated data.

Agent scripts (filter.sh, fixer.sh) authenticate via session cookie and call Express endpoints. They also query Convex directly for batch/ad data.

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
  → GPT-5.2 Message 2 (image via vision API) → Gemini 3 Pro (image generation)
  → headline/body extracted → Convex `ad_creatives`
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

**7. Agent Pipeline** (autonomous, cron-triggered)
```
Director (scheduler, 3×/day) → creates batches with angle prompts → batch pipeline runs
  → Filter (cron, every 30min) → scores completed batch ads → groups into flex ads
  → deploys to Ready to Post → triggers learning step
  → Fixer (cron, every 5min) → tests, diagnoses failures, auto-fixes, resurrects batches
```

### Paths That Must Stay in Sync

| If you change... | Also update... |
|------------------|----------------|
| Convex schema field name | Convex function file, `convexClient.js` mapper + whitelist, route handler, `api.js`, React component |
| Deployment status values | `ad_deployments.ts`, `convexClient.js`, `routes/deployments.js`, `CampaignsView.jsx`, `ReadyToPostView.jsx`, `PostedView.jsx`, `filter.sh` |
| `flex_ads` field shape | `flexAds.ts`, `convexClient.js`, `CampaignsView.jsx`, `ReadyToPostView.jsx`, `filter.sh` deploy logic |
| LLM wrapper function signature | Every service that calls it (see dependency map) |
| `api.js` method name or params | Every frontend file that calls it (see dependency map) |
| SSE event format | Backend route + frontend `onEvent` handler in the corresponding component |
| Cost tracking rates | `costTracker.js` rate tables + Settings UI display |
| Error response shape | All route handlers use `{ error: msg }` for errors, `{ success: true }` for mutations |
| Cascade deletion logic | `campaigns.ts`, `adSets.ts` — any new parent-child entity must cascade |
| Agent authentication flow | `filter.sh` + `fixer.sh` both use session cookie with 24h expiry + auto-re-auth |
| Agent budget caps | `filter.conf` + `fixer.conf` + `agentMonitor.js` constants |

---

## Dependency Map

Every shared module imported by 2+ files. **This is the most critical section** — check here before modifying any shared code.

### Backend: Core Infrastructure

**`backend/convexClient.js`** (100+ helpers, central data layer) → used by **41 files**:
- `backend/server.js`, `backend/auth.js`, `backend/ConvexSessionStore.js`
- Routes: `ads.js`, `agentMonitor.js`, `auth.js`, `batches.js`, `chat.js`, `conductor.js`, `costs.js`, `deployments.js`, `documents.js`, `drive.js`, `landingPages.js`, `meta.js`, `projects.js`, `quoteMining.js`, `settings.js`, `templates.js`, `users.js`
- Services: `adGenerator.js`, `anthropic.js`, `batchProcessor.js`, `conductorAngles.js`, `conductorEngine.js`, `conductorLearning.js`, `correctionHistory.js`, `costTracker.js`, `docGenerator.js`, `gemini.js`, `headlineGenerator.js`, `lpGenerator.js`, `lpPublisher.js`, `lpSwipeFetcher.js`, `metaAds.js`, `openai.js`, `quoteBankService.js`, `quoteDedup.js`, `quoteMiner.js`, `scheduler.js`
- Utils: `adImages.js`

**`backend/auth.js`** (`requireAuth`, `requireRole`) → used by **17 files**:
- `backend/server.js`
- Routes: `ads.js`, `auth.js`, `batches.js`, `chat.js`, `costs.js`, `deployments.js`, `documents.js`, `drive.js`, `landingPages.js`, `meta.js`, `projects.js`, `quoteMining.js`, `settings.js`, `templates.js`, `upload.js`, `users.js`

**`backend/services/retry.js`** (`withRetry`, `isRateLimitError`, `defaultShouldRetry`) → used by **12 files**:
- `backend/convexClient.js`
- Routes: `chat.js`, `drive.js`
- Services: `anthropic.js`, `batchProcessor.js`, `costTracker.js`, `gemini.js`, `headlineGenerator.js`, `metaAds.js`, `openai.js`, `quoteMiner.js`
- Utils: `adImages.js`

**`backend/services/costTracker.js`** (`logAnthropicCost`, `logOpenAICost`, `logPerplexityCost`, `logGeminiCost`, `syncOpenAICosts`, `refreshGeminiRates`) → used by **11 files**:
- `backend/server.js`
- Routes: `chat.js`, `costs.js`, `settings.js`
- Services: `anthropic.js`, `batchProcessor.js`, `gemini.js`, `headlineGenerator.js`, `openai.js`, `quoteMiner.js`, `scheduler.js`

### Backend: LLM Service Wrappers

**`backend/services/openai.js`** (`chat`, `chatStream`, `deepResearch`, `chatWithImage`, `chatWithImages`) → used by **7 files**:
- Routes: `templates.js`, `upload.js`
- Services: `adGenerator.js`, `bodyCopyGenerator.js`, `docGenerator.js`, `quoteDedup.js`, `quoteMiner.js`

**`backend/services/anthropic.js`** (`chat`, `chatWithImage`, `chatWithMultipleImages`) → used by **7 files**:
- Routes: `ads.js`, `deployments.js`
- Services: `adGenerator.js`, `conductorAngles.js`, `conductorLearning.js`, `docGenerator.js`, `lpGenerator.js`

**`backend/services/gemini.js`** (`generateImage`, `getClient`) → used by **4 files**:
- Routes: `landingPages.js`
- Services: `adGenerator.js`, `batchProcessor.js`, `lpGenerator.js`

**`backend/services/quoteMiner.js`** (`runQuoteMining`, `generateSuggestions`, `getAnthropicClient`) → used by **4 files**:
- Routes: `chat.js`, `quoteMining.js`
- Services: `headlineGenerator.js`, `quoteBankService.js`

### Backend: Shared Services

**`backend/utils/sseHelper.js`** (`createSSEStream`, `streamService`) → used by **5 files**:
- Routes: `ads.js`, `chat.js`, `documents.js`, `landingPages.js`, `quoteMining.js`

**`backend/services/rateLimiter.js`** (`withHeavyLLMLimit`, `withGeminiLimit`, `getRateLimiterStats`) → used by **3 files**:
- `backend/server.js`
- Services: `adGenerator.js`, `gemini.js`

**`backend/services/adGenerator.js`** → used by **2 files**:
- Routes: `ads.js`
- Services: `batchProcessor.js`

**`backend/services/batchProcessor.js`** (`runBatch`, `pollBatchJob`) → used by **3 files**:
- Routes: `batches.js`
- Services: `conductorEngine.js`, `scheduler.js`

**`backend/services/metaAds.js`** → used by **2 files**:
- Routes: `meta.js`
- Services: `scheduler.js`

**`backend/services/scheduler.js`** (`initScheduler`, `loadScheduledBatches`, `getSchedulerStatus`) → used by **2 files**:
- `backend/server.js`
- Routes: `batches.js`

**`backend/services/quoteDedup.js`** → used by **2 files**:
- Routes: `quoteMining.js`
- Services: `quoteBankService.js`

**`backend/services/bodyCopyGenerator.js`** → used by **2 files**:
- Routes: `ads.js`, `quoteMining.js`

**`backend/services/lpGenerator.js`** → used by **2 files**:
- Routes: `landingPages.js`
- Services: `lpPublisher.js`

**`backend/services/lpSwipeFetcher.js`** → used by **2 files**:
- Routes: `landingPages.js`
- Services: `lpGenerator.js`

**`backend/services/conductorEngine.js`** → used by **2 files** (+ self):
- Routes: `conductor.js`
- Services: `scheduler.js`

**`backend/services/conductorLearning.js`** → used by **2 files** (+ self):
- Routes: `conductor.js`
- Services: `conductorEngine.js`

**`backend/services/conductorAngles.js`** → used by **1 file** (+ self):
- Services: `conductorEngine.js`

### Backend: Third-Party Packages (imported in 4+ files)

**`uuid` (v4)** → used by **22 files**:
- `auth.js`
- Routes: `agentMonitor.js`, `auth.js`, `batches.js`, `chat.js`, `conductor.js`, `documents.js`, `landingPages.js`, `projects.js`, `templates.js`, `users.js`
- Services: `adGenerator.js`, `batchProcessor.js`, `conductorAngles.js`, `conductorEngine.js`, `correctionHistory.js`, `costTracker.js`, `docGenerator.js`, `lpPublisher.js`, `metaAds.js`, `quoteBankService.js`, `quoteDedup.js`

**`multer`** → used by **4 files**:
- Routes: `landingPages.js`, `projects.js`, `templates.js`, `upload.js`

### Frontend: Shared Modules

**`frontend/src/api.js`** (150+ API methods) → used by **24 files**:
- `App.jsx`
- Pages: `Login.jsx`, `Dashboard.jsx`, `Projects.jsx`, `ProjectSetup.jsx`, `ProjectDetail.jsx`, `Settings.jsx`, `AdTracker.jsx`
- Components: `Layout.jsx`, `AdStudio.jsx`, `BatchManager.jsx`, `FoundationalDocs.jsx`, `TemplateImages.jsx`, `QuoteMiner.jsx`, `CopywriterChat.jsx`, `ReadyToPostView.jsx`, `CampaignsView.jsx`, `PostedView.jsx`, `LPGen.jsx`, `InspirationFolder.jsx`, `DriveFolderPicker.jsx`, `DragDropUpload.jsx`, `AgentMonitor.jsx`, `CreativeFilterSettings.jsx`

**`frontend/src/components/Toast.jsx`** (`ToastProvider`, `useToast`) → used by **11 files**:
- `App.jsx`
- Pages: `Projects.jsx`, `ProjectDetail.jsx`, `Settings.jsx`, `AdTracker.jsx`
- Components: `AdStudio.jsx`, `BatchManager.jsx`, `LPGen.jsx`, `QuoteMiner.jsx`, `FoundationalDocs.jsx`, `CreativeFilterSettings.jsx`

**`frontend/src/components/InfoTooltip.jsx`** → used by **9 files**:
- Pages: `Dashboard.jsx`, `Projects.jsx`, `ProjectDetail.jsx`, `Settings.jsx`
- Components: `AdStudio.jsx`, `BatchManager.jsx`, `FoundationalDocs.jsx`, `TemplateImages.jsx`, `LPGen.jsx`

**`frontend/src/hooks/useAsyncData.js`** → used by **6 files**:
- Pages: `Projects.jsx`, `AdTracker.jsx`
- Components: `AdStudio.jsx`, `TemplateImages.jsx`, `QuoteMiner.jsx`, `FoundationalDocs.jsx`

**`frontend/src/hooks/usePolling.js`** → used by **3 files**:
- Components: `AdStudio.jsx`, `BatchManager.jsx`, `QuoteMiner.jsx`

**`frontend/src/components/DragDropUpload.jsx`** → used by **3 files**:
- Pages: `ProjectSetup.jsx`, `Settings.jsx`
- Components: `FoundationalDocs.jsx`

**`frontend/src/components/ErrorBoundary.jsx`** → used by **2 files**:
- `App.jsx`, `ProjectDetail.jsx`

**`frontend/src/components/batchUtils.js`** → used by **2 files**:
- Components: `BatchManager.jsx`, `BatchRow.jsx`

**`frontend/src/hooks/useSSEStream.js`** → used by **1 file**:
- Components: `FoundationalDocs.jsx`

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

4. **Cascade deletion**. `campaigns.remove()` → hard-deletes child ad_sets → soft-deletes child flex_ads. `adSets.remove()` → soft-deletes child flex_ads. Any new parent-child entity must cascade.

5. **`convexBatchToRow` converts `scheduled` boolean to 0/1 integer**. Frontend code must use `!!batch.scheduled` not bare `batch.scheduled` in JSX to avoid rendering `0`.

6. **Mapper functions normalize Convex objects to rows**. Every route handler receives Convex data through mappers in `convexClient.js`. If you add a field to the schema, you MUST also add it to the mapper AND the helper's field whitelist or it won't appear in API responses / won't be saved on updates.

7. **Dedup guards**. `ad_deployments.create()` checks if `ad_id` already deployed (active only) and returns null if duplicate. `createWithoutDedup()` skips this check. `inspiration_images.create()` skips if `(project_id, drive_file_id)` already exists.

8. **Upsert operations**. `meta_performance.upsert()` checks by `(meta_ad_id, date)`. `conductor_config.upsertConfig()` checks by `project_id`. `conductor_playbooks.upsertPlaybook()` checks by `(project_id, angle_name)`. `fixer_playbook.upsertFixerPlaybook()` checks by `issue_category`. `settings.set()` checks by key.

### API Response Formats

9. **SSE events follow a fixed structure**. All SSE endpoints emit events as `data: ${JSON.stringify(event)}\n\n`. Event objects always have a `type` field. Common types: `progress`, `step`, `complete`, `error`, `result`. Components parse these in `onEvent` callbacks.

10. **Cost logging is fire-and-forget**. Every LLM wrapper auto-logs costs inside itself. Callers pass `{ operation, projectId }` via options. The logging call uses `.catch(() => {})` — failures are silently swallowed. Never await cost logging.

11. **Error response shape**. All API error responses use `res.status(N).json({ error: err.message })`. All mutation success responses use `res.json({ success: true, ... })`. This was standardized in the audit — new routes must follow this pattern.

12. **Deployment status values are hardcoded strings**. The exact values `"selected"`, `"ready_to_post"`, `"posted"`, `"analyzing"` are used across the entire stack. No enum or constant — just raw strings everywhere.

### Authentication & Authorization

13. **Three roles: `admin`, `manager`, `poster`**. Poster can ONLY see the Ad Pipeline tab (Ready to Post + Posted). Poster cannot access Planner, create projects, access Dashboard, or Settings. Backend enforces via `requireRole('admin', 'manager')` on protected routes.

14. **`req.user` shape**: `{ id, username, role, displayName }`. Populated by `requireAuth` middleware from session. Every route handler depends on this shape.

15. **Session secret is auto-generated and stored in Convex settings**. First server start generates a random 64-char hex string via `crypto.randomBytes(32)`. Stored as `session_secret` setting.

16. **Localhost-only guard for agent endpoints**. `/api/agent-cost` routes use `localhostOnly` middleware that checks `req.ip` against `['127.0.0.1', '::1', '::ffff:127.0.0.1']`. Agent shell scripts call these via curl from the VPS.

### Naming & Conventions

17. **`project_id` everywhere means `projects.externalId`** (a UUID string), not the Convex `_id`.

18. **Convex functions are queries + mutations only**. No Convex actions. All LLM calls, file processing, and external API work happens in Express backend.

19. **File naming**: camelCase for JS/JSX, PascalCase for React components, snake_case for Convex table names and fields.

20. **All LLM calls must go through wrappers**. Never call OpenAI, Anthropic, or Gemini APIs directly. Always use `services/openai.js`, `services/anthropic.js`, or `services/gemini.js` — they provide retry logic and automatic cost tracking.

---

## File Structure

```
ad-platform/
├── backend/
│   ├── server.js                    # Express entry point (port 3001), middleware, route mounting
│   ├── auth.js                      # requireAuth + requireRole middleware
│   ├── convexClient.js              # Central data layer (100+ helpers, mappers, retry-wrapped)
│   ├── ConvexSessionStore.js        # Custom express-session store backed by Convex
│   ├── vitest.config.js             # Test configuration
│   ├── routes/                      # 18 route files
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
│   │   ├── agentMonitor.js          # Agent Dashboard: Fixer + Filter status and triggers
│   │   └── conductor.js             # Conductor: config, angles, runs, playbooks, learning
│   ├── services/                    # 23 service files
│   │   ├── openai.js                # GPT-5.2, GPT-4.1, GPT-4.1-mini, o3-deep-research
│   │   ├── anthropic.js             # Claude Opus 4.6 + Sonnet 4.6 (JSON mode, PDF support)
│   │   ├── gemini.js                # Gemini 3 Pro Image generation (rate-limited)
│   │   ├── adGenerator.js           # Ad generation orchestrator (Mode 1/2)
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
│   │   ├── lpSwipeFetcher.js        # Puppeteer headless page capture + SSRF protection
│   │   ├── correctionHistory.js     # Correction audit trail (log, apply, revert)
│   │   ├── conductorEngine.js       # Director orchestrator (batch planning, angle selection)
│   │   ├── conductorAngles.js       # Angle generation (Claude Opus)
│   │   └── conductorLearning.js     # Learning from scored ads + adaptive batch sizing
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
│   │   ├── pages/                   # 8 page components
│   │   │   ├── Login.jsx            # Multi-user auth + first-run setup
│   │   │   ├── Dashboard.jsx        # Cost cards + bar chart + rates + agent costs
│   │   │   ├── Projects.jsx         # Project grid with stats
│   │   │   ├── ProjectSetup.jsx     # New project wizard
│   │   │   ├── ProjectDetail.jsx    # Tabbed project hub (role-filtered tabs)
│   │   │   ├── Settings.jsx         # API keys, Drive, rates, refs, users (admin)
│   │   │   ├── AdTracker.jsx        # Ad Pipeline wrapper (Planner/Ready/Posted tabs)
│   │   │   └── AgentDashboard.jsx   # Agent Dashboard wrapper
│   │   ├── components/              # 25 component files
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
│   │   │   ├── AdStudio.jsx         # Ad generation UI + gallery + bulk actions (~2500 lines)
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
├── convex/                          # 25 function files (29 tables)
│   ├── schema.ts                    # Full database schema
│   ├── settings.ts                  # Key-value settings CRUD
│   ├── projects.ts                  # Projects CRUD + stats + product image
│   ├── foundationalDocs.ts          # Docs CRUD with versioning
│   ├── adCreatives.ts               # Ad CRUD + storage URL resolution
│   ├── batchJobs.ts                 # Batch state machine + pipeline tracking
│   ├── apiCosts.ts                  # Cost logging + aggregation + agent cost breakdown
│   ├── campaigns.ts                 # Campaign CRUD (cascade delete)
│   ├── adSets.ts                    # Ad set CRUD (cascade soft-delete)
│   ├── flexAds.ts                   # Flex ad groups (soft-delete + purge)
│   ├── ad_deployments.ts            # Deployment tracking (soft-delete, dedup guard)
│   ├── templateImages.ts            # Template storage
│   ├── inspirationImages.ts         # Drive-synced images (no externalId, composite key)
│   ├── quote_mining_runs.ts         # Mining run records
│   ├── quote_bank.ts                # Individual quotes + headlines (bulk ops + whitelisting)
│   ├── chatThreads.ts               # Chat threads + messages
│   ├── correction_history.ts        # Correction audit trail
│   ├── metaPerformance.ts           # Meta ad metrics (upsert on date+ad)
│   ├── dashboard_todos.ts           # Roadmap todos
│   ├── landingPages.ts              # Landing page CRUD
│   ├── landingPageVersions.ts       # Version snapshots
│   ├── users.ts                     # Multi-user accounts (unique username check)
│   ├── sessions.ts                  # Session store (get/set/destroy/cleanup)
│   ├── fileStorage.ts               # Storage URL helpers
│   └── conductor.ts                 # Conductor tables (config, angles, runs, health, playbooks, fixer_playbook)
│
├── deploy/
│   ├── deploy.sh                    # Rsync → npm install → vite build → PM2 restart
│   ├── setup.sh                     # VPS initial setup (Node 22, PM2, Nginx, Certbot)
│   ├── ecosystem.config.cjs         # PM2 config (port 3001, 2GB max, single instance)
│   └── nginx.conf                   # Reverse proxy + SSL + caching + gzip + 300s timeout
│
├── dacia-fixer/                     # Agent #1: auto-test, self-heal, batch resurrection
│   ├── fixer.sh                     # Main script (~1200 lines)
│   ├── config/fixer.conf            # Config (budget, models, intervals)
│   ├── fix_ledger.md                # Institutional memory — DO NOT DELETE
│   └── logs/                        # Daily log files + spend tracking
│
├── dacia-creative-filter/           # Agent #2: score ads, create flex ads, deploy to RTP
│   ├── filter.sh                    # Main script (~1170 lines)
│   ├── config/filter.conf           # Config (budget, models, thresholds)
│   ├── agents/
│   │   ├── score.sh                 # Vision-based ad scoring (Claude Sonnet)
│   │   ├── group.sh                 # Flex ad grouping/clustering (Claude Sonnet)
│   │   ├── validate.sh              # Copy validation (headlines + primary texts)
│   │   └── regenerate.sh            # Copy regeneration fallback
│   └── logs/                        # Daily log files + spend tracking
│
└── CLAUDE.md                        # This file
```

---

## Convex Database (29 tables)

### Table Overview

| Table | Key Pattern | Notes |
|-------|-------------|-------|
| `settings` | by `key` | Key-value store for API keys, secrets, rates |
| `projects` | `externalId` (UUID) | brand_name, niche, scout_* fields for filter config |
| `foundational_docs` | `externalId` | Versioned docs (avatar, offer_brief, beliefs, research) |
| `ad_creatives` | `externalId` | Generated ads with storageId for images |
| `batch_jobs` | `externalId` | 4-stage pipeline state, filter_assigned/filter_processed flags |
| `campaigns` | `externalId` | Cascade: delete → ad_sets → soft-delete flex_ads |
| `ad_sets` | `externalId` | Cascade: delete → soft-delete flex_ads |
| `flex_ads` | `externalId` | Soft-delete, 10 images + primary_texts + headlines as JSON strings |
| `ad_deployments` | `externalId` | Soft-delete, dedup guard on create, status state machine |
| `template_images` | `externalId` | Convex storage + optional AI analysis |
| `inspiration_images` | `(project_id, drive_file_id)` | No externalId — composite key |
| `quote_mining_runs` | `externalId` | Quotes stored as JSON string array |
| `quote_bank` | `externalId` | Bulk create/update with field whitelisting |
| `chat_threads` | `externalId` | active/archived status |
| `chat_messages` | `externalId` | thread_id + project_id |
| `landing_pages` | `externalId` | copy_sections, image_slots as JSON strings |
| `landing_page_versions` | `externalId` | Snapshot of copy/images/HTML |
| `correction_history` | `externalId` | Changes stored as JSON string |
| `api_costs` | `externalId` | Fire-and-forget logging, period_date for daily grouping |
| `meta_performance` | `externalId` | Upsert on (meta_ad_id, date) |
| `dashboard_todos` | `externalId` | replaceAll is destructive (deletes all, inserts new) |
| `users` | `externalId` | Unique username check on create |
| `sessions` | `sid` | express-session store with cleanup |
| `conductor_config` | `project_id` (PK) | Per-project Director settings |
| `conductor_angles` | `externalId` | Angle library (active/testing/retired) |
| `conductor_runs` | `externalId` | Audit log of Director runs |
| `conductor_health` | `externalId` | Fixer monitoring records |
| `conductor_playbooks` | `(project_id, angle_name)` | Per-angle learning memory, upsert |
| `fixer_playbook` | `issue_category` | Fixer learning memory, upsert |
| `file_storage` | Convex `_storage` | Blob storage helper (generateUploadUrl, getUrl, deleteFile) |

### Relationship Map

```
projects
  ├── foundational_docs (project_id → projects.externalId)
  ├── ad_creatives (project_id → projects.externalId)
  │     └── batch_jobs (ad_creatives.batch_job_id → batch_jobs.externalId)
  ├── campaigns (project_id → projects.externalId)
  │     └── ad_sets (campaign_id → campaigns.externalId)
  │           └── flex_ads (ad_set_id → ad_sets.externalId)
  ├── ad_deployments (project_id, ad_id → ad_creatives.externalId)
  │     └── meta_performance (deployment_id → ad_deployments.externalId)
  ├── quote_mining_runs (project_id → projects.externalId)
  │     └── quote_bank (run_id → quote_mining_runs.externalId)
  ├── template_images (project_id → projects.externalId)
  ├── inspiration_images (project_id → projects.externalId)
  ├── chat_threads (project_id → projects.externalId)
  │     └── chat_messages (thread_id → chat_threads.externalId)
  ├── landing_pages (project_id → projects.externalId)
  │     └── landing_page_versions (landing_page_id → landing_pages.externalId)
  ├── correction_history (project_id → projects.externalId)
  ├── conductor_config (project_id → projects.externalId)
  ├── conductor_angles (project_id → projects.externalId)
  ├── conductor_runs (project_id → projects.externalId)
  └── conductor_playbooks (project_id → projects.externalId)
```

---

## Backend Route Endpoints

### Route → Auth Mapping

| Route File | Mount Path | Auth | Role |
|------------|-----------|------|------|
| `auth.js` | `/api/auth` | None | None |
| `users.js` | `/api/users` | `requireAuth` | `admin` |
| `settings.js` | `/api/settings` | `requireAuth` | `admin` |
| `projects.js` | `/api/projects` | `requireAuth` | `admin`, `manager` |
| `documents.js` | `/api/projects` | `requireAuth` | `admin`, `manager` |
| `upload.js` | `/api/upload` | `requireAuth` | `admin`, `manager` |
| `drive.js` | `/api/drive` | `requireAuth` | `admin`, `manager` |
| `templates.js` | `/api/projects` | `requireAuth` | `admin`, `manager` |
| `ads.js` | `/api/projects` | `requireAuth` | `admin`, `manager` |
| `batches.js` | `/api/projects` + `/api/batches` | `requireAuth` | `admin`, `manager` |
| `costs.js` | `/api` | `requireAuth` | `admin`, `manager` |
| `quoteMining.js` | `/api/projects` | `requireAuth` | `admin`, `manager` |
| `chat.js` | `/api/projects` | `requireAuth` | `admin`, `manager` |
| `meta.js` | `/api` | `requireAuth` | `admin`, `manager` |
| `landingPages.js` | `/api/projects` | `requireAuth` | `admin`, `manager` |
| `deployments.js` | `/api/deployments` | `requireAuth` | varies per route |
| `agentMonitor.js` | `/api/agent-monitor` | `requireAuth` | `admin` |
| `conductor.js` | `/api/conductor` | `requireAuth` | `admin`, `manager` |
| Agent cost router | `/api/agent-cost` | `localhostOnly` | None |

### Rate-Limited Endpoints

Applied via `express-rate-limit` (10 req/min per user):
- `/api/projects/:id/generate-docs`
- `/api/projects/:id/generate-ad`
- `/api/projects/:id/generate-landing-page`
- `/api/deployments/generate-ad-copy`
- `/api/deployments/generate-ad-headlines`
- `/api/deployments/filter/generate-copy`
- `/api/quote-mining/start`
- `/api/conductor/run`
- `/api/conductor/learn`

---

## Backend Services

### LLM Wrappers (all provide retry + automatic cost tracking)

| Service | Models | Key Functions | Used By |
|---------|--------|---------------|---------|
| `openai.js` | GPT-5.2, GPT-4.1, GPT-4.1-mini, o3-deep-research | `chat`, `chatStream`, `deepResearch`, `chatWithImage`, `chatWithImages` | 7 files |
| `anthropic.js` | Claude Opus 4.6, Claude Sonnet 4.6 | `chat`, `chatWithImage`, `chatWithMultipleImages` | 7 files |
| `gemini.js` | Gemini 3 Pro | `generateImage`, `getClient` | 4 files |

### Key Services

| Service | Purpose | Key Exports |
|---------|---------|-------------|
| `adGenerator.js` | Ad creative generation orchestrator | `generateAd`, `generateAdMode2`, `regenerateImageOnly`, `buildCreativeDirectorPrompt` |
| `batchProcessor.js` | 4-stage batch pipeline | `runBatch`, `pollBatchJob` |
| `docGenerator.js` | 8-step foundational doc pipeline | `generateAllDocs`, `regenerateDoc`, `generateFromManualResearch` |
| `quoteMiner.js` | Dual-engine quote search | `runQuoteMining`, `generateSuggestions` |
| `headlineGenerator.js` | Quote-to-headline generation | `generateHeadlines`, `generateHeadlinesPerQuote`, `generateMoreHeadlinesForQuote` |
| `quoteBankService.js` | Quote bank orchestration | `executeMiningRun`, `generateRunHeadlines`, `importAllRunsToBank` |
| `quoteDedup.js` | Semantic quote deduplication | `deduplicateAndAddToBank` |
| `bodyCopyGenerator.js` | Body copy from headline + quote | `generateBodyCopy` |
| `costTracker.js` | Cost calculation + tracking | `logAnthropicCost`, `logOpenAICost`, `logGeminiCost`, `syncOpenAICosts`, `refreshGeminiRates` |
| `scheduler.js` | 6 automated cron tasks | `initScheduler`, `loadScheduledBatches`, `getSchedulerStatus` |
| `metaAds.js` | Meta Ads OAuth + performance | `getOAuthUrl`, `handleOAuthCallback`, `syncMetaPerformance`, `refreshMetaTokenIfNeeded` |
| `lpGenerator.js` | Landing page generation | `generateLandingPageCopy`, `generateSlotImages`, `generateHtmlTemplate` |
| `lpPublisher.js` | Cloudflare Pages deployment | `publishLandingPage`, `unpublishLandingPage` |
| `lpSwipeFetcher.js` | Puppeteer page capture + SSRF protection | `fetchSwipePage` |
| `correctionHistory.js` | Doc correction audit trail | `logManualEdit`, `applyCorrections`, `revertCorrection` |
| `conductorEngine.js` | Director batch planning | `runDirectorCycle`, `runDirectorForProject` |
| `conductorAngles.js` | Angle generation | `generateAngles` |
| `conductorLearning.js` | Learning from scored ads | `runLearningStep`, `getAdaptiveBatchSize` |
| `rateLimiter.js` | Concurrency control | `withHeavyLLMLimit` (concurrency=2), `withGeminiLimit` (concurrency=3) |
| `retry.js` | Exponential backoff | `withRetry` (5 retries, 429-aware, 15s base for rate limits) |

---

## Frontend

### Pages & Routes

| Page | Route | Role | Description |
|------|-------|------|-------------|
| `Login.jsx` | `/login` | None | Multi-user auth + first-run setup |
| `Dashboard.jsx` | `/` | admin, manager | Cost cards + bar chart + agent costs |
| `Projects.jsx` | `/projects` | admin, manager | Project grid with stats |
| `ProjectSetup.jsx` | `/projects/new` | admin, manager | New project wizard |
| `ProjectDetail.jsx` | `/projects/:id` | admin, manager | Tabbed hub (Docs, Ads, Batches, Quotes, Templates, Chat, LP, Pipeline) |
| `Settings.jsx` | `/settings` | admin | API keys, rates, refs, users |
| `AdTracker.jsx` | `/ad-pipeline` | all roles | Planner/Ready/Posted tabs (Poster: Ready+Posted only) |
| `AgentDashboard.jsx` | `/agent-dashboard` | admin, manager | Agent monitoring wrapper |

### Key Components

| Component | Lines | Description |
|-----------|-------|-------------|
| `AdStudio.jsx` | ~2500 | Ad generation UI (Mode 1/2), gallery, bulk actions, tagging |
| `BatchManager.jsx` | ~2500 | Batch CRUD, scheduling, pipeline status, Gemini batch polling |
| `FoundationalDocs.jsx` | ~1000 | 8-step doc generation pipeline (SSE), corrections, audit trail |
| `QuoteMiner.jsx` | ~1500 | Quote mining, bank management, headline generation |
| `CampaignsView.jsx` | ~1500 | Planner: campaigns → ad sets → flex ads organization |
| `ReadyToPostView.jsx` | ~800 | Review + approve ads, Meta linking, copy generation |
| `LPGen.jsx` | ~1200 | Landing page generator, split-panel editor, publishing |
| `AgentMonitor.jsx` | ~600 | Fixer + Filter status, manual triggers, volume controls |

### Frontend Patterns

- **SSE Streaming**: `api.js` provides `streamSSE()` and `streamSSEWithBody()` helpers used by document generation, ad generation, quote mining, chat, landing page generation
- **Async Data**: `useAsyncData` hook standardizes fetch + loading + error + refetch
- **Polling**: `usePolling` for batch status, ad queue, quote mining progress
- **Role-based UI**: `ProtectedRoute` checks `user.role`; Poster sees subset of tabs
- **Tab Persistence**: ProjectDetail stores active tab in URL params; AdTracker stores view in sessionStorage
- **Error Handling**: Components wrap API calls in try/catch; ErrorBoundary wraps at App and ProjectDetail level

---

## Agent System

### Agent #1: Dacia Fixer (`/dacia-fixer`)

**Purpose**: Automated test, diagnosis, self-heal, batch resurrection
**Budget**: $1.33/day ($40/month hard cap)
**Schedule**: Every 5 minutes via VPS cron
**Main Script**: `fixer.sh` (~1200 lines)

**Workflow**:
1. Acquire lock file (`/tmp/dacia-fixer.lock`) with PID check
2. Check daily budget (spend file with `flock` locking)
3. Authenticate with backend (session cookie, 24h expiry, auto-re-auth)
4. Run test suite (`npm test -- --grep 'batch'`)
5. If tests pass → check for failed batches → resurrect (retry up to 3 attempts)
6. If tests fail → diagnose with Gemini Flash (~$0.01) → fix with Claude Sonnet (~$0.05) → re-test → commit to `fixer/auto-fixes` branch
7. Run health probes: backend health, filter liveness, filter pass rate, disk space
8. Log results and costs

**Health Probes** (no LLM cost):
- Backend health check (`/api/health`) — restarts PM2 if down
- Filter liveness — re-adds cron if missing, triggers manual run if stale
- Filter pass rate — resets processed batches for re-scoring if 0% pass rate
- Disk space monitoring + auto-cleanup

**Key Config** (`config/fixer.conf`):
- `DIAGNOSIS_MODEL`: `gemini-2.5-flash`
- `FIX_MODEL`: `claude-sonnet-4-5-20250929`
- `MAX_RETRIES`: 3
- `FIXER_BRANCH`: `fixer/auto-fixes`
- `MAX_LEDGER_ENTRIES`: 50
- `DAILY_BUDGET_CENTS`: 133

**Fix Ledger** (`fix_ledger.md`): Institutional memory of all fixes. DO NOT DELETE. Fed to diagnosis/fix agents as context. Detects recurring patterns (3+ breaks to same file).

### Agent #2: Dacia Creative Filter (`/dacia-creative-filter`)

**Purpose**: Score completed batch ads, group winners into flex ads, deploy to Ready to Post
**Budget**: $20/day ($31/month hard cap)
**Schedule**: Every 30 minutes via VPS cron
**Main Script**: `filter.sh` (~1170 lines)
**Opt-in only**: Batches must have `filter_assigned=true`

**Workflow**:
1. Acquire lock file (`/tmp/dacia-filter.lock`) with PID check
2. Check daily budget (spend file with `flock` locking)
3. Authenticate with backend (session cookie, 24h expiry, auto-re-auth)
4. Discover unprocessed batches (Convex query: `status=completed`, `filter_assigned=true`, `filter_processed!=true`)
5. For each batch:
   a. Fetch all ads from batch
   b. **Score** each ad via `agents/score.sh` (Claude Sonnet vision, 1-10 score + hard requirements)
   c. **Group** passing ads via `agents/group.sh` (cluster by angle, select 10 images per flex ad)
   d. **Generate copy** via backend `/api/deployments/filter/generate-copy` (Planner-quality primary texts + headlines)
   e. **Deploy** flex ads to Ready to Post (create ad set + flex ad via backend API)
   f. Mark batch as `filter_processed=true`
   g. Trigger learning step if Director-managed angle

**Score Agent** (`agents/score.sh`):
- Uses Claude Sonnet vision API with ad image
- Weighted scoring: Copy Strength (35%), Meta Compliance (25%), Overall Effectiveness (20%), Image Quality (20%)
- Hard requirements (auto-fail): Spelling/grammar, first-line hook, CTA at end, headline alignment, image completeness
- Output: score 1-10, pass/fail, strengths, weaknesses, compliance flags

**Group Agent** (`agents/group.sh`):
- Clusters passing ads by angle/theme
- Selects top 2 clusters, 10 images each
- Selects 3-5 headlines + 3-5 primary texts per cluster
- Uses temp file for input (avoids ARG_MAX)

**Key Config** (`config/filter.conf`):
- `SCORE_MODEL`: `claude-sonnet-4-5-20250929`
- `GROUP_MODEL`: `claude-sonnet-4-6`
- `SCORE_THRESHOLD`: 7
- `IMAGES_PER_FLEX`: 10
- `CHECK_INTERVAL`: 1800 (30 min)
- `DAILY_BUDGET_CENTS`: 2000

**Per-Project Settings** (stored on project in Convex):
- `scout_enabled` — enable/disable for this project
- `scout_daily_flex_ads` — daily cap (1-10, default 2)
- `scout_default_campaign` — campaign ID for deployment
- `scout_cta`, `scout_display_link`, `scout_facebook_page`, `scout_destination_url`

### Agent #3: Dacia Director (backend service, not a shell script)

**Purpose**: Plan batches, manage angles, learn from results
**Location**: `backend/services/conductorEngine.js`, `conductorAngles.js`, `conductorLearning.js`
**Schedule**: Via `scheduler.js` cron (7 AM, 7 PM, 1 AM ICT)
**Config**: `conductor_config` table (per-project)

**Workflow**:
1. Check enabled projects with conductor config
2. Determine active posting days (next 3 days)
3. Calculate flex ad deficit per posting day
4. Select angles to fill deficit (round_robin/weighted/random)
5. Create batches with angle prompts and playbook context
6. Learning step runs after Filter scores batch (updates playbook with winning patterns)
7. Adaptive batch sizing based on historical pass rates

### How to Add a New Agent — Checklist

1. **Lock file**: Use `/tmp/dacia-{name}.lock` with PID check to prevent concurrent runs
2. **Trap handler**: Clean up temp files on EXIT/INT/TERM signals
3. **Spend file locking**: Use `flock` for atomic reads/writes to prevent race conditions
4. **Session cookie**: Store in `config/.session_cookie` with timestamp file for 24h expiry tracking
5. **Auto-re-auth**: Handle 401 responses by re-authenticating automatically
6. **Retry logic**: Exponential backoff on API calls (3 attempts, 15s × attempt)
7. **Budget cap**: Check daily spend before every LLM call, stop if exceeded
8. **Cost logging**: Fire-and-forget curl to `/api/agent-cost/log` after every LLM call
9. **JSON construction**: Use `jq` for JSON building, never string interpolation (avoids quoting bugs)
10. **Temp file cleanup**: Use `mktemp` for temp files, clean up in trap handler
11. **Resurrection cap**: Limit retry attempts (e.g., max 3) to prevent infinite loops
12. **Cron entry**: Add to VPS crontab with proper env vars
13. **Log rotation**: Write to `logs/{agent}_YYYY-MM-DD.log` (auto-rotates daily)

---

## Third-Party Integrations

### OpenAI
- **Used for**: Creative direction (GPT-5.2), foundational docs (GPT-4.1), deep research (o3-deep-research), quote dedup (GPT-4.1-mini), auto-describe (GPT-4.1-mini)
- **Wrapper**: `backend/services/openai.js` — ALL calls must go through this for retry + cost tracking
- **Billing sync**: Hourly via scheduler (`syncOpenAICosts`)
- **Known issue**: Current account hits 429 on nearly every first attempt. Retry system handles this (15s+ backoff). Generation takes ~50s per ad. This is expected, not a bug.

### Anthropic
- **Used for**: Ad copy generation (Claude Sonnet 4.6), brief extraction (Claude Opus 4.6), ad scoring by Filter (Claude Sonnet), angle generation (Claude Opus), learning analysis (Claude Sonnet), landing page copy/HTML (Claude Sonnet)
- **Wrapper**: `backend/services/anthropic.js` — ALL calls must go through this
- **JSON mode**: Adds instruction to system prompt, extracts first `{ ... }` block from response, strips markdown fences

### Google Gemini
- **Used for**: Image generation (Gemini 3 Pro Image Preview), Fixer diagnosis (Gemini Flash)
- **Wrapper**: `backend/services/gemini.js` — rate-limited to concurrency=3
- **Batch API**: Used for batch image generation, polled every 5 min by scheduler
- **Rate refresh**: Daily at midnight via scheduler

### Perplexity
- **Used for**: Quote mining web search (Sonar Pro)
- **Wrapper**: Direct HTTP calls in `quoteMiner.js` with cost tracking
- **No retry wrapper** — uses basic error handling

### Google Drive
- **Used for**: Inspiration image sync, template image sync
- **Auth**: Service account JSON file at `config/service-account.json` (gitignored)
- **Code**: `backend/routes/drive.js`

### Meta Marketing API
- **Used for**: Per-project OAuth, campaign/ad set/ad browsing, performance data sync
- **Version**: v21.0
- **Code**: `backend/services/metaAds.js`, `backend/routes/meta.js`
- **Token refresh**: Weekly Monday 3am via scheduler. Tokens expire ~60 days.
- **Performance sync**: Every 30 min per project via scheduler

### Cloudflare Pages
- **Used for**: Landing page publishing
- **Code**: `backend/services/lpPublisher.js`
- **Credentials**: Stored in Convex settings (`cloudflare_account_id`, `cloudflare_api_token`, `cloudflare_pages_project`)

---

## Settings & Environment Variables

### Stored in Convex `settings` table (not .env)

| Setting | Purpose |
|---------|---------|
| `openai_api_key` | OpenAI API access |
| `anthropic_api_key` | Anthropic API access |
| `gemini_api_key` | Google Gemini API access |
| `perplexity_api_key` | Perplexity API access |
| `session_secret` | Auto-generated 64-char hex for express-session |
| `drive_folder_id` | Root Google Drive folder |
| `cloudflare_account_id` | Cloudflare Pages account |
| `cloudflare_api_token` | Cloudflare API token |
| `cloudflare_pages_project` | Cloudflare Pages project name |
| `gemini_rate_*` | Gemini pricing rates (auto-refreshed daily) |
| `headline_ref_1`, `headline_ref_2`, `headline_ref_3` | Reference copywriting docs for headline generation |
| `meta_oauth_state_*` | Per-project CSRF state for Meta OAuth |

### PM2 Environment Variables (on VPS)

| Variable | Value | Purpose |
|----------|-------|---------|
| `NODE_ENV` | `production` | Production mode |
| `PORT` | `3001` | Express port |
| `CONVEX_URL` | `https://energized-hare-760.convex.cloud` | Convex deployment URL |

### Agent Environment Variables (cron)

| Variable | Used By | Purpose |
|----------|---------|---------|
| `ANTHROPIC_API_KEY` | Filter | Direct API access for scoring/grouping |
| `FILTER_USERNAME` | Filter | Backend auth username |
| `FILTER_PASSWORD` | Filter | Backend auth password |

### On Disk (gitignored)

- `config/service-account.json` — Google Drive service account credentials

---

## Deployment

### Frontend + Backend
```bash
VPS_HOST=76.13.219.6 bash deploy/deploy.sh
```

### Convex (schema/function changes) — SEPARATE STEP
```bash
ssh root@76.13.219.6 "cd /opt/ad-platform && npx convex deploy -y"
```

### Build Frontend Locally
```bash
source ~/.zshrc 2>/dev/null && cd frontend && npm run build
```

### Adding a New npm Dependency
`package.json` is excluded from rsync in `deploy.sh`. Install manually on VPS:
```bash
ssh root@76.13.219.6 "cd /opt/ad-platform/backend && npm install <package>"
```

### Agent Script Updates
`deploy.sh` does NOT sync `dacia-fixer/` or `dacia-creative-filter/`. SCP manually:
```bash
scp dacia-creative-filter/filter.sh root@76.13.219.6:/opt/ad-platform/dacia-creative-filter/
```

### VPS Details
- **IP**: 76.13.219.6 | **App path**: `/opt/ad-platform` | **Port**: 3001
- **PM2**: `ad-platform` (single instance, 2GB max) | **Logs**: `/opt/ad-platform/logs/`
- **Nginx**: Port 443 → localhost:3001 | **SSL**: Let's Encrypt
- **Timeouts**: 300s read, 75s connect | **Upload limit**: 50MB

---

## Scheduler (6 Automated Tasks)

1. Poll active batches every 5 min + auto-retry up to 3×
2. Sync OpenAI costs hourly from billing API
3. Purge soft-deleted records >30 days daily at 1am
4. Refresh Gemini rates daily at midnight
5. Sync Meta performance every 30 min per-project
6. Refresh Meta tokens weekly Monday 3am

Plus user-defined cron schedules for recurring batches.

Plus Director runs (via scheduler): 7 AM, 7 PM, 1 AM ICT.

---

## Development Patterns & Conventions

### Adding a New API Route
1. Create handler in `backend/routes/{feature}.js`
2. Use `requireAuth` + `requireRole('admin', 'manager')` middleware
3. Error responses: `res.status(N).json({ error: err.message })`
4. Success responses: `res.json({ success: true, ...data })`
5. Mount in `server.js` with appropriate auth/role
6. Add rate limiting if it triggers LLM calls
7. Add corresponding method in `frontend/src/api.js`

### Adding a New Convex Table/Field
1. Add to `convex/schema.ts` — define all fields with types
2. Create `convex/{table}.ts` — queries + mutations with field whitelisting
3. Add mapper in `convexClient.js` — normalize Convex objects to API rows
4. Add helper functions in `convexClient.js` — include field whitelists for updates
5. Add route handler — read/write the field
6. Add API method in `frontend/src/api.js`
7. Deploy Convex separately: `ssh root@76.13.219.6 "cd /opt/ad-platform && npx convex deploy -y"`
8. If hierarchical: implement cascade deletion in parent's `remove()` mutation

### Adding a New LLM Call
1. ALWAYS use the wrapper (`openai.js`, `anthropic.js`, or `gemini.js`)
2. Pass `{ operation: 'descriptive_name', projectId }` in options for cost tracking
3. Never call APIs directly — wrappers provide retry logic + cost logging
4. For Claude JSON mode: wrapper auto-strips markdown fences and extracts first `{ ... }` block

### Naming Conventions
- Files: camelCase for JS/JSX, PascalCase for React components, snake_case for Convex tables/fields
- IDs: `externalId` (UUID string) for cross-table references, never Convex `_id`
- Status strings: lowercase with underscores (`ready_to_post`, not `readyToPost`)
- Timestamps: ISO 8601 strings for most tables, Unix ms for Conductor tables

### Common Pitfalls

1. **Forgetting Convex Deploy** — `deploy.sh` only deploys backend + frontend. Schema/function changes require separate `npx convex deploy -y` on VPS.

2. **Missing field in whitelist** — `convexClient.js` helper functions use explicit field whitelists. Adding a field to schema + mutation but not the whitelist means updates silently drop the field.

3. **React `&&` with numbers** — Use `!!value &&` or `value > 0 &&` for numbers. `batch.scheduled` (stored as 0/1) renders `0` as visible text with bare `&&`.

4. **SSE event shape mismatch** — No type checking between backend emitter and frontend handler. Changes must be synchronized manually.

5. **Rate limiter concurrency** — Heavy LLM: concurrency=2, 2s gap. Gemini: concurrency=3. Increasing causes 429 errors.

6. **Deep Research timeout** — o3-deep-research has 30-minute timeout with 5s polling. Falls back gracefully.

7. **50MB JSON body limit** — Express configured with `express.json({ limit: '50mb' })`. Adding body-size middleware before JSON parser may conflict.

8. **LP HTML code fences** — Claude sometimes wraps HTML in markdown fences. `lpGenerator.js` auto-strips these.

9. **Thumbnail cache** — Lives at `backend/.thumb-cache/`. Delete directory to regenerate (falls back to Convex CDN).

10. **Meta token expiry** — Tokens expire ~60 days. Scheduler auto-refreshes weekly. No proactive expiry warning.

---

## Styling Quick Reference

**Color Tokens** (defined in `tailwind.config.js`):
- `navy` (#0B1D3A) / `navy-light` (#132B52) — Primary brand, navbar, buttons, headings
- `gold` (#C4975A) — Accent, hover states, links
- `teal` (#2A9D8F) — Success states
- `offwhite` (#FAFAF8) — Page backgrounds
- `cream` (#F4F1EB) — Alternative background
- `textdark` (#1A1A2E) — Primary text
- `textmid` (#4A5568) — Secondary text
- `textlight` (#8A96A8) — Tertiary text, placeholders

**Data Viz**: OpenAI=#5B8DEF, Anthropic=#7C6DCD, Gemini=#2A9D8F, Perplexity=#C4975A

**Custom CSS Classes** (`index.css`): `.glass-nav`, `.card`, `.btn-primary`, `.btn-secondary`, `.input-apple`, `.segmented-control`, `.badge`, `.info-tooltip`

**Text sizes**: Compact UI using `text-[10px]` through `text-[15px]`

---

## Recent Changes (2026-02-27)

### 62-Issue Codebase Audit — Completed

A comprehensive security, reliability, and performance audit was completed across 4 commits:

**Security Hardening**:
- CSP headers via helmet (script, style, img, connect, frame, object, base directives)
- SSRF protection in `lpSwipeFetcher.js` (blocks private/internal IPs)
- Rate limiting on all LLM-triggering endpoints (10 req/min/user)
- Localhost-only guard on agent cost endpoints
- Field whitelisting in `quote_bank.bulkCreate()` and `bulkUpdate()`
- Field whitelisting in `conductor.js` config and angle update routes
- Meta OAuth CSRF state validation

**Bug Fixes**:
- Missing `getSetting` import in `metaAds.js` (would crash Meta OAuth callback)
- Stray `}` in `filter.sh` causing bash syntax error
- Response shape standardization (`{ ok: true }` → `{ success: true }` across all routes)
- `upload.js` auto-describe changed from raw fetch to `openaiChat()` wrapper for retry + cost tracking

**Data Integrity**:
- Cascade deletion: campaigns → ad_sets → flex_ads
- Cascade soft-delete: ad_sets → flex_ads

**Agent Reliability**:
- `flock` locking on spend file reads/writes (filter.sh + fixer.sh)
- Temp file cleanup traps (EXIT/INT/TERM) in filter.sh, score.sh, group.sh, fixer.sh
- Session cookie expiry tracking with timestamp files

**Performance**:
- Image temp file pattern in `adGenerator.js` — writes to disk instead of holding base64 in Node.js heap
- `readImageBase64()` and `cleanupImageData()` helpers for temp file lifecycle

**Commits**: `1d9aa36`, `ddce222`, `5f28b69`, `59a44aa` (tagged: `audit-complete`)

---

## Known Limitations & Technical Debt

- **VPS constraints**: 2GB RAM max (PM2 `max_memory_restart`), 8GB available on VPS. Single instance only.
- **No TypeScript on backend**: Backend is plain JS. No type checking between SSE emitters and frontend handlers.
- **No enum/constants for status strings**: `"selected"`, `"ready_to_post"`, `"posted"`, `"analyzing"` are raw strings everywhere.
- **Agent scripts not deployed by deploy.sh**: Must SCP agent directories manually to VPS.
- **`conductorLearning.js`**: Has `messages.filter is not a function` error — data shape issue in learning step (pre-existing, not from audit).
- **Fixer path validation** (audit #1): `apply_fix()` does not validate file paths with `realpath` — low priority hardening item.
- **`cost_cents=0` treated as falsy** in `agentMonitor.js` cost logging validation (`if (!cost_cents)`) — cosmetic only, logs skip message.

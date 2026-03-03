# Ad Creative Automation Platform — CLAUDE.md

> Context file for Claude Code. Read this before making any changes.

---

## 1. Before You Edit

**Stop and check the dependency map** (Section 4) before modifying any shared module, pipeline stage, or state shape.

| Module | Consumers | Key Risk |
|--------|-----------|----------|
| `backend/convexClient.js` | 33 files | Mapper output shape, field whitelists — a missing field silently drops data |
| `frontend/src/api.js` | 26 files | Renaming a method breaks every page/component that calls it |
| `backend/auth.js` | 17 files | Changing `req.user` shape (`{ id, username, role, displayName }`) breaks all route handlers |
| `frontend/src/components/Toast.jsx` | 13 files | `ToastProvider` + `useToast` hook consumed across the UI |
| `backend/services/anthropic.js` | 12 files | Claude Opus/Sonnet wrapper — retry logic + cost tracking |
| `backend/services/costTracker.js` | 11 files | Every LLM wrapper auto-logs costs. Changing the signature breaks all wrappers |
| `frontend/src/components/InfoTooltip.jsx` | 9 files | Pure CSS hover tooltip used on many pages |
| `backend/services/retry.js` | 9 files | `defaultShouldRetry` does NOT retry 4xx except 429. Changing this affects all LLM calls |
| `backend/services/openai.js` | 8 files | GPT wrapper — retry logic + cost tracking |
| `backend/utils/sseHelper.js` | 7 files | SSE stream utilities for all long-running endpoints |
| `backend/services/gemini.js` | 6 files | Gemini image gen wrapper — rate-limited to concurrency=3 |
| `frontend/src/hooks/useAsyncData.js` | 6 files | Fetch + loading + error + refetch hook |
| `frontend/src/components/Layout.jsx` | 6 files | Glass navbar + segmented control + user badge |
| `frontend/src/components/PipelineProgress.jsx` | 5 files | Shared progress bar — see `.claude/skills/progress-bar-standard/SKILL.md` |
| `convex/schema.ts` | All Convex functions | Schema changes require a **separate** `npx convex deploy -y` on VPS |

**Rule of thumb**: Grep for any identifier you're about to rename. Trace the full chain:

```
Convex schema → Convex function → convexClient.js mapper + whitelist → route handler → api.js method → React component
```

---

## 2. Project Overview

### What It Does

A single-tenant web app for direct response copywriters and e-commerce brands. Seven core workflows:

1. **Foundational Doc Generation** — 8-step research pipeline (GPT-4.1 + o3-deep-research) producing customer avatars, offer briefs, and belief documents from a product's sales page.
2. **Quote Mining & Headlines** — Dual-engine search (Perplexity Sonar Pro + Claude Opus 4.6) extracting emotional quotes from online communities, then headline generation via Claude Sonnet 4.6 with 3 reference copywriting docs.
3. **Static Image Ad Generation** — GPT-5.2 creative direction + Gemini 3 Pro image generation, single or automated batch via cron schedule.
4. **Ad Pipeline & Meta Integration** — 3-stage deployment pipeline (Planner -> Ready to Post -> Posted) with campaign hierarchy, flex ads, per-project Meta Ads OAuth, performance data sync.
5. **Landing Page Generation** — Copy + design + HTML generation via Claude Sonnet, Opus editorial pass, Visual QA with auto-fix loop, split-panel editor, CTA management, one-click publish to Shopify.
6. **Landing Page Template Extraction** — Puppeteer capture + Claude vision analysis to extract reusable HTML skeleton templates from any URL.
7. **Autonomous Agent System** — Three agents (Fixer, Creative Filter, Director) that auto-test, auto-heal, score ads, create flex ads, plan batches, auto-generate LPs, and learn from results.

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
| External | Google Drive API v3 (service account); Meta Marketing API v21.0 (per-project OAuth); Shopify Admin API (per-project, for LP publishing); Cloudflare Pages API |
| Auth | bcrypt + express-session + Convex-backed session store + role-based access (Admin/Manager/Poster) |
| Security | helmet (CSP), express-rate-limit, SSRF protection, field whitelisting |
| Scheduling | node-cron + scheduler service polling Gemini Batch API |
| Process Manager | PM2 (production) |
| Reverse Proxy | Nginx + Let's Encrypt SSL |

### Deployment

**VPS**: `76.13.219.6` | **App path**: `/opt/ad-platform` | **Port**: 3001 | **PM2**: single instance, 2GB max

**Frontend + Backend**:
```bash
VPS_HOST=76.13.219.6 bash deploy/deploy.sh
```

**Convex (schema/function changes) — SEPARATE STEP**:
```bash
ssh root@76.13.219.6 "cd /opt/ad-platform && CONVEX_DEPLOYMENT=prod:strong-civet-577 npx convex deploy -y"
```

**Build Frontend Locally**:
```bash
source ~/.zshrc 2>/dev/null && cd frontend && npm run build
```

**Agent Script Updates** (`deploy.sh` does NOT sync agent dirs):
```bash
scp dacia-creative-filter/filter.sh root@76.13.219.6:/opt/ad-platform/dacia-creative-filter/
scp dacia-fixer/fixer.sh root@76.13.219.6:/opt/ad-platform/dacia-fixer/
```

**Adding a New npm Dependency** (`package.json` is excluded from rsync):
```bash
ssh root@76.13.219.6 "cd /opt/ad-platform/backend && npm install <package>"
```

### Settings

All API keys and config are stored in the Convex `settings` table (not .env):

| Setting | Purpose |
|---------|---------|
| `openai_api_key` | OpenAI API access |
| `anthropic_api_key` | Anthropic API access |
| `gemini_api_key` | Google Gemini API access |
| `perplexity_api_key` | Perplexity API access |
| `session_secret` | Auto-generated 64-char hex for express-session |
| `drive_folder_id` | Root Google Drive folder |
| `cloudflare_account_id`, `cloudflare_api_token`, `cloudflare_pages_project` | Cloudflare Pages |
| `gemini_rate_*` | Gemini pricing rates (auto-refreshed daily) |
| `headline_ref_1`, `headline_ref_2`, `headline_ref_3` | Reference copywriting docs for headlines |

PM2 env vars: `NODE_ENV=production`, `PORT=3001`, `CONVEX_URL=https://energized-hare-760.convex.cloud`

Agent env vars (cron): `ANTHROPIC_API_KEY`, `FILTER_USERNAME`, `FILTER_PASSWORD`

On disk (gitignored): `config/service-account.json` (Google Drive service account)

### Styling

**Color tokens** (defined in `tailwind.config.js`):
- `navy` (#0B1D3A) / `navy-light` (#132B52) — Primary brand, navbar, buttons, headings
- `gold` (#C4975A) — Accent, hover states, links
- `teal` (#2A9D8F) — Success states
- `offwhite` (#FAFAF8) — Page backgrounds
- `cream` (#F4F1EB) — Alternative background
- `textdark` (#1A1A2E) / `textmid` (#4A5568) / `textlight` (#8A96A8) — Text hierarchy

**Data viz colors**: OpenAI=#5B8DEF, Anthropic=#7C6DCD, Gemini=#2A9D8F, Perplexity=#C4975A

**CSS classes** (in `index.css`): `.glass-nav`, `.card`, `.btn-primary`, `.btn-secondary`, `.input-apple`, `.segmented-control`, `.badge`, `.info-tooltip`

---

## 3. Architecture & Data Flow

### Layer Diagram

```
Browser -> Nginx (443) -> Express (3001) -> Convex Cloud
                                          -> OpenAI API
                                          -> Anthropic API
                                          -> Google Gemini API
                                          -> Perplexity API
                                          -> Google Drive API
                                          -> Meta Marketing API
                                          -> Shopify Admin API
                                          -> Cloudflare Pages API

Cron (VPS) -> filter.sh -> Express (3001) -> Convex Cloud
Cron (VPS) -> fixer.sh  -> Express (3001) -> Convex Cloud
Scheduler  -> conductorEngine.js -> Convex Cloud + Anthropic API
```

Frontend calls `api.js` methods -> Express route handlers -> services call LLM APIs + Convex mutations -> results stored in Convex -> frontend fetches updated data.

### Data Pipelines

**1. Foundational Docs** (SSE stream)
`FoundationalDocs.jsx` -> `api.generateDocs()` -> `routes/documents.js` -> `docGenerator.js` -> GPT-4.1 analysis (3 steps) -> o3-deep-research (30min timeout) -> GPT-4.1 synthesis (Avatar -> Offer Brief -> Beliefs) -> `foundational_docs` table

**2. Ad Generation** (SSE stream)
`AdStudio.jsx` -> `api.generateAd()` -> `routes/ads.js` -> `adGenerator.js` -> GPT-5.2 creative direction -> GPT-5.2 vision -> Gemini 3 Pro image -> `ad_creatives` table

**3. Batch Pipeline** (4-stage, async)
`BatchManager.jsx` -> `api.createBatch()` / `api.runBatch()` -> `routes/batches.js` -> `batchProcessor.js`:
Stage 0: Brief extraction (Claude Opus) -> Stage 1: Headlines (Claude Opus) -> Stage 2: Body copy (Claude Sonnet, batches of 5) -> Stage 3: Image prompts (Claude Sonnet) -> Gemini Batch API -> scheduler polls every 5min -> `ad_creatives` table

**4. Ad Deployment** (state machine)
`CampaignsView.jsx` (Planner) -> `ReadyToPostView.jsx` -> `PostedView.jsx`
Status flow: `"selected"` -> `"ready_to_post"` -> `"posted"` -> `"analyzing"`

**5. Quote Mining** (SSE stream)
`QuoteMiner.jsx` -> `api.startQuoteMining()` -> `routes/quoteMining.js` -> `quoteBankService.js` -> parallel: Perplexity Sonar Pro + Claude Opus 4.6 -> merge + dedup -> `quote_bank` -> per-quote headline generation (Claude Sonnet)

**6. Landing Page — Manual** (SSE stream)
`LPGen.jsx` -> `api.generateLandingPage()` -> `routes/landingPages.js` -> `lpGenerator.js`:
1. Swipe capture (`lpSwipeFetcher.js`, Puppeteer)
2. Design analysis (`analyzeSwipeDesign`, Claude Sonnet vision)
3. Copy generation (`generateLandingPageCopy`, Claude Sonnet multi-turn)
4. Image generation (`generateSlotImages`, Gemini 3 Pro)
5. HTML template generation (`generateHtmlTemplate`, Claude Sonnet)
6. Assembly (`assembleLandingPage`) + post-processing (`postProcessLP`)
7. Visual QA (`runVisualQA`, Puppeteer + Claude vision) + auto-fix loop (`autoFixLP`)
-> `landing_pages` table -> [publish: Shopify Pages]

**6b. Landing Page — Auto-Generation** (Director-triggered, fire-and-forget)
Director creates batch -> `lpAutoGenerator.js:triggerLPGeneration()`:
1. Load templates + select 2 different narrative frames
2. For each LP: load template skeleton -> copy gen (Claude Sonnet) -> Opus editorial pass -> image gen with product reference (Gemini) -> HTML template (Claude Sonnet + editorial plan) -> assembly + post-processing
3. Visual QA loop (up to 3 attempts with `lpAutoFixer.js` fixes)
4. Publish to Shopify + smoke test (`lpSmokeTest.js`, 7 automated checks)
5. Update batch record with LP IDs, URLs, statuses
-> `landing_pages` table + batch `lp_primary_*` / `lp_secondary_*` fields

**6c. Landing Page — Template Extraction** (SSE stream)
`LPTemplateManager.jsx` -> `api.extractLPTemplate()` -> `routes/lpTemplates.js` -> `lpTemplateExtractor.js`:
1. Puppeteer capture (`lpSwipeFetcher.js`)
2. Claude Sonnet vision structural analysis
3. Parse into skeleton_html + design_brief + slot_definitions
-> `lp_templates` table

**7. Agent Pipeline** (autonomous, cron-triggered)
Director (scheduler, 3x/day) -> creates batches with angle prompts -> batch pipeline runs -> **LP Agent** (auto-generates 2 advertorials per batch) -> Filter (cron, every 30min) -> scores completed batch ads -> groups into flex ads -> deploys to Ready to Post -> triggers learning step -> Fixer (cron, every 5min) -> tests, diagnoses failures, auto-fixes, resurrects batches

### LP Post-Processing Pipeline (`postProcessLP`)

This pipeline runs on every LP save (backend PUT endpoint) and during generation. Order matters:

1. **Metadata replacement** — Fill `{{author_name}}`, `{{publish_date}}`, `{{warning_text}}`, `{{batch_angle}}` from project/agent config
2. **Catch-all placeholder strip** — Remove any remaining `{{...}}` placeholders
3. **Contrast safety CSS injection** — `injectContrastSafetyCSS()` adds `<style data-safety="contrast">` block ensuring white text on dark backgrounds (idempotent, checks for marker)
4. **Duplicate callout heading fix** — Removes duplicate `<h2>` from `<aside>` elements
5. **Generic testimonial attribution fix** — Replaces generic "Customer" names with project author_name
6. **Testimonial deduplication** — Text-content-based: strips HTML, splits into sentences, finds duplicates >= 50 chars, removes second occurrence's container
7. **Empty element cleanup** — Removes empty `<p>`, `<div>`, etc.

**Critical**: The frontend `assembleHtmlClient()` in `LPGen.jsx` rebuilds HTML from raw `htmlTemplate` + copy sections, which strips all post-processing. The backend PUT endpoint re-applies contrast CSS via `injectContrastSafetyCSS()`. The frontend also injects a simplified contrast CSS for editor preview.

### Paths That Must Stay in Sync

| If you change... | Also update... |
|------------------|----------------|
| Convex schema field name | Convex function file, `convexClient.js` mapper + whitelist, route handler, `api.js`, React component |
| Deployment status values | `ad_deployments.ts`, `convexClient.js`, `routes/deployments.js`, `CampaignsView.jsx`, `ReadyToPostView.jsx`, `PostedView.jsx`, `filter.sh` |
| `flex_ads` field shape | `flexAds.ts`, `convexClient.js`, `CampaignsView.jsx`, `ReadyToPostView.jsx`, `filter.sh` deploy logic |
| LLM wrapper function signature | Every service that calls it (see dependency map) |
| `api.js` method name or params | Every frontend file that calls it (see dependency map) |
| SSE event format | Backend route + frontend `onEvent` handler in the corresponding component |
| Error response shape | All route handlers use `{ error: msg }` for errors, `{ success: true }` for mutations |
| Cascade deletion logic | `campaigns.ts`, `adSets.ts` — any new parent-child entity must cascade |
| Agent authentication flow | `filter.sh` + `fixer.sh` both use session cookie with 24h expiry + auto-re-auth |
| LP post-processing pipeline | `lpGenerator.js:postProcessLP()`, `landingPages.js` PUT safety net, `LPGen.jsx:assembleHtmlClient()` |
| LP template slot format | `lpTemplateExtractor.js`, `lpGenerator.js`, `LPGen.jsx` CopySection/ImageSlot structures |

### Route Endpoints

| Route File | Mount Path | Auth | Role |
|------------|-----------|------|------|
| `routes/auth.js` | `/api/auth` | None (login/setup) / `requireAuth` (password change) | None |
| `routes/users.js` | `/api/users` | `requireAuth` | `admin` |
| `routes/settings.js` | `/api/settings` | `requireAuth` | `admin` |
| `routes/projects.js` | `/api/projects` | `requireAuth` | `admin`, `manager` (CUD) |
| `routes/documents.js` | `/api/projects` | `requireAuth` | `admin`, `manager` |
| `routes/upload.js` | `/api/upload` | `requireAuth` | `admin`, `manager` |
| `routes/drive.js` | `/api/drive` + `/api/projects` (inspiration) | `requireAuth` | `admin`, `manager` |
| `routes/templates.js` | `/api/projects` | `requireAuth` | `admin`, `manager` |
| `routes/ads.js` | `/api/projects` | `requireAuth` | `admin`, `manager` |
| `routes/batches.js` | `/api/projects` + `/api/batches` (flat for Fixer) | `requireAuth` | `admin`, `manager` |
| `routes/costs.js` | `/api` | `requireAuth` | `admin`, `manager` |
| `routes/quoteMining.js` | `/api/projects` | `requireAuth` | `admin`, `manager` |
| `routes/chat.js` | `/api/projects` | `requireAuth` | `admin`, `manager` |
| `routes/meta.js` | `/api` | `requireAuth` | `admin`, `manager` |
| `routes/landingPages.js` | `/api/projects` | `requireAuth` | `admin`, `manager` |
| `routes/lpTemplates.js` | `/api/projects` | `requireAuth` | `admin`, `manager` |
| `routes/deployments.js` | `/api` | `requireAuth` | varies (poster can update status/posted-by) |
| `routes/agentMonitor.js` | `/api/agent-monitor` | `requireAuth` | `admin` |
| `routes/conductor.js` | `/api/conductor` | `requireAuth` | `admin`, `manager` |
| `routes/lpAgent.js` | `/api/projects` | `requireAuth` | `admin`, `manager` |
| Server direct: `/api/health` | `/api/health` | None | None |
| Server direct: `/api/agent-cost` | `/api/agent-cost` | `localhostOnly` | None |

Rate-limited endpoints (10 req/min per user): `/generate-docs`, `/generate-ad`, `/generate-landing-page`, `/generate-ad-copy`, `/generate-ad-headlines`, `/filter/generate-copy`, `/quote-mining/start`, `/conductor/run`, `/conductor/learn`, `/lp-agent/generate-test`, `/lp-agent/shopify/connect`

### Agent System

**Director** (`backend/services/conductorEngine.js`) — Plans batches and selects angles. Runs via scheduler at 7 AM, 7 PM, 1 AM ICT. Config in `conductor_config` table per project. Supports focus mode: when any active angle has `focused=true`, only focused angles are selected.

**LP Agent** (`backend/services/lpAutoGenerator.js`, `backend/services/lpGenerator.js`) — Generates two advertorials per batch with different narrative frames. Uses Opus 4.6 editorial pass for strategic content decisions (headline, section ordering, callouts, emphasis). Passes project product images as reference for hero/product image slots. Publishes to Shopify. Visual QA with auto-fix loop (up to 3 attempts). Smoke test (7 automated checks). Config in `lp_agent_config` table per project. Triggered by Director after batch creation. Settings panel in Agent Dashboard -> LP Agent tab.

**Creative Filter** (`dacia-creative-filter/filter.sh`) — Scores completed batch ads via Claude Sonnet vision, groups winners into flex ads (1 per batch), deploys to Ready to Post. Runs every 30 min via VPS cron. Budget: $20/day. Opt-in per batch (`filter_assigned=true`).

**Fixer** (`dacia-fixer/fixer.sh`) — Runs test suite, diagnoses failures via Gemini Flash, fixes via Claude Sonnet, resurrects failed batches. Health probes: backend health, filter liveness, pass rate, disk space. Runs every 5 min via VPS cron. Budget: $1.33/day.

Filter and Fixer agents use: lock files (`/tmp/dacia-{agent}.lock` with PID check), `flock` for atomic spend file reads/writes, session cookie auth with 24h expiry + auto-re-auth, daily log rotation.

### Scheduler (7 Automated Tasks)

1. Poll active batches every 5 min + auto-retry up to 3x
2. Sync OpenAI costs hourly from billing API
3. Purge soft-deleted records >30 days daily at 1am
4. Refresh Gemini rates daily at midnight
5. Sync Meta performance every 30 min per-project
6. Refresh Meta tokens weekly Monday 3am
7. Director runs (7 AM, 7 PM, 1 AM ICT)

Plus user-defined cron schedules for recurring batches.

---

## 4. Dependency Map

Every shared module imported by 2+ production files. Test files excluded. Organized by consumer count descending.

### Tier 1: 10+ Consumers

**`backend/convexClient.js`** — Central data layer (100+ helpers, mapper functions: `convexProjectToRow`, `convexAdToRow`, `convexBatchToRow`, `convexDocToRow`)
-> `backend/server.js`
-> `backend/auth.js`
-> `backend/ConvexSessionStore.js`
-> `backend/routes/agentMonitor.js`
-> `backend/routes/auth.js`
-> `backend/routes/conductor.js`
-> `backend/routes/costs.js`
-> `backend/routes/documents.js`
-> `backend/routes/drive.js`
-> `backend/routes/lpAgent.js`
-> `backend/routes/lpTemplates.js`
-> `backend/routes/meta.js`
-> `backend/routes/quoteMining.js`
-> `backend/routes/settings.js`
-> `backend/routes/templates.js`
-> `backend/services/anthropic.js`
-> `backend/services/correctionHistory.js`
-> `backend/services/costTracker.js`
-> `backend/services/gemini.js`
-> `backend/services/headlineGenerator.js`
-> `backend/services/lpAutoFixer.js`
-> `backend/services/lpAutoGenerator.js`
-> `backend/services/lpGenerator.js`
-> `backend/services/lpSwipeFetcher.js`
-> `backend/services/lpTemplateExtractor.js`
-> `backend/services/metaAds.js`
-> `backend/services/openai.js`
-> `backend/services/quoteBankService.js`
-> `backend/services/quoteDedup.js`
-> `backend/services/quoteMiner.js`
-> `backend/services/scheduler.js`
-> `backend/utils/adImages.js`

**`frontend/src/api.js`** — 164 API methods (fetch wrapper + SSE helpers, no imports)
-> `frontend/src/App.jsx`
-> `frontend/src/pages/Login.jsx`
-> `frontend/src/pages/Dashboard.jsx`
-> `frontend/src/pages/Projects.jsx`
-> `frontend/src/pages/ProjectSetup.jsx`
-> `frontend/src/pages/ProjectDetail.jsx`
-> `frontend/src/pages/Settings.jsx`
-> `frontend/src/pages/AdTracker.jsx`
-> `frontend/src/components/Layout.jsx`
-> `frontend/src/components/AdStudio.jsx`
-> `frontend/src/components/BatchManager.jsx`
-> `frontend/src/components/FoundationalDocs.jsx`
-> `frontend/src/components/TemplateImages.jsx`
-> `frontend/src/components/QuoteMiner.jsx`
-> `frontend/src/components/CopywriterChat.jsx`
-> `frontend/src/components/ReadyToPostView.jsx`
-> `frontend/src/components/CampaignsView.jsx`
-> `frontend/src/components/PostedView.jsx`
-> `frontend/src/components/LPGen.jsx`
-> `frontend/src/components/LPAgentSettings.jsx`
-> `frontend/src/components/LPTemplateManager.jsx`
-> `frontend/src/components/InspirationFolder.jsx`
-> `frontend/src/components/DriveFolderPicker.jsx`
-> `frontend/src/components/DragDropUpload.jsx`
-> `frontend/src/components/AgentMonitor.jsx`
-> `frontend/src/components/CreativeFilterSettings.jsx`

**`backend/auth.js`** — Exports: `requireAuth`, `requireRole`, `isSetupComplete`, `migrateToMultiUser`
-> `backend/routes/ads.js`
-> `backend/routes/auth.js`
-> `backend/routes/batches.js`
-> `backend/routes/chat.js`
-> `backend/routes/costs.js`
-> `backend/routes/deployments.js`
-> `backend/routes/documents.js`
-> `backend/routes/drive.js`
-> `backend/routes/landingPages.js`
-> `backend/routes/lpTemplates.js`
-> `backend/routes/meta.js`
-> `backend/routes/projects.js`
-> `backend/routes/quoteMining.js`
-> `backend/routes/settings.js`
-> `backend/routes/templates.js`
-> `backend/routes/upload.js`
-> `backend/routes/users.js`

**`frontend/src/components/Toast.jsx`** — Exports: `ToastProvider`, `useToast`
-> `frontend/src/App.jsx`
-> `frontend/src/pages/Projects.jsx`
-> `frontend/src/pages/ProjectDetail.jsx`
-> `frontend/src/pages/Settings.jsx`
-> `frontend/src/pages/AdTracker.jsx`
-> `frontend/src/components/AdStudio.jsx`
-> `frontend/src/components/BatchManager.jsx`
-> `frontend/src/components/FoundationalDocs.jsx`
-> `frontend/src/components/LPGen.jsx`
-> `frontend/src/components/LPAgentSettings.jsx`
-> `frontend/src/components/LPTemplateManager.jsx`
-> `frontend/src/components/QuoteMiner.jsx`
-> `frontend/src/components/CreativeFilterSettings.jsx`

**`backend/services/anthropic.js`** — Exports: `chat`, `chatWithImage`, `chatWithMultipleImages`
-> `backend/routes/ads.js`
-> `backend/routes/deployments.js`
-> `backend/services/adGenerator.js`
-> `backend/services/conductorAngles.js`
-> `backend/services/conductorLearning.js`
-> `backend/services/docGenerator.js`
-> `backend/services/lpAutoFixer.js`
-> `backend/services/lpGenerator.js`
-> `backend/services/lpTemplateExtractor.js`

**`backend/services/costTracker.js`** — Exports: `logAnthropicCost`, `logOpenAICost`, `logPerplexityCost`, `logGeminiCost`, `syncOpenAICosts`, `refreshGeminiRates`, `getCostSummary`, `getCostHistoryData`, `getRecurringBatchCostEstimate`. Callers pass `{ operation, projectId }`.
-> `backend/server.js`
-> `backend/routes/chat.js`
-> `backend/routes/costs.js`
-> `backend/routes/settings.js`
-> `backend/services/anthropic.js`
-> `backend/services/batchProcessor.js`
-> `backend/services/gemini.js`
-> `backend/services/headlineGenerator.js`
-> `backend/services/openai.js`
-> `backend/services/quoteMiner.js`
-> `backend/services/scheduler.js`

### Tier 2: 5–9 Consumers

**`frontend/src/components/InfoTooltip.jsx`** — Pure CSS hover tooltip
-> `frontend/src/pages/Dashboard.jsx`
-> `frontend/src/pages/Projects.jsx`
-> `frontend/src/pages/ProjectDetail.jsx`
-> `frontend/src/pages/Settings.jsx`
-> `frontend/src/components/AdStudio.jsx`
-> `frontend/src/components/BatchManager.jsx`
-> `frontend/src/components/FoundationalDocs.jsx`
-> `frontend/src/components/LPGen.jsx`
-> `frontend/src/components/TemplateImages.jsx`

**`backend/services/retry.js`** — Exports: `withRetry`, `isRateLimitError`, `defaultShouldRetry`. Does NOT retry 4xx except 429. 429 uses 15s base delay.
-> `backend/services/anthropic.js`
-> `backend/services/batchProcessor.js`
-> `backend/services/costTracker.js`
-> `backend/services/gemini.js`
-> `backend/services/headlineGenerator.js`
-> `backend/services/lpPublisher.js`
-> `backend/services/metaAds.js`
-> `backend/services/openai.js`
-> `backend/services/quoteMiner.js`

**`backend/services/openai.js`** — Exports: `chat`, `chatStream`, `deepResearch`, `chatWithImage`, `chatWithImages`
-> `backend/routes/templates.js`
-> `backend/routes/upload.js`
-> `backend/services/adGenerator.js`
-> `backend/services/bodyCopyGenerator.js`
-> `backend/services/docGenerator.js`
-> `backend/services/quoteDedup.js`
-> `backend/services/quoteMiner.js`

**`backend/utils/sseHelper.js`** — Exports: `createSSEStream`, `streamService`
-> `backend/routes/ads.js`
-> `backend/routes/chat.js`
-> `backend/routes/documents.js`
-> `backend/routes/landingPages.js`
-> `backend/routes/lpAgent.js`
-> `backend/routes/lpTemplates.js`
-> `backend/routes/quoteMining.js`

**`backend/services/gemini.js`** — Exports: `generateImage`, `getClient`. Rate-limited to concurrency=3.
-> `backend/routes/batches.js`
-> `backend/routes/landingPages.js`
-> `backend/services/adGenerator.js`
-> `backend/services/batchProcessor.js`
-> `backend/services/lpAutoFixer.js`
-> `backend/services/lpGenerator.js`

**`frontend/src/hooks/useAsyncData.js`** — Fetch + loading + error + refetch hook
-> `frontend/src/pages/Projects.jsx`
-> `frontend/src/pages/AdTracker.jsx`
-> `frontend/src/components/AdStudio.jsx`
-> `frontend/src/components/FoundationalDocs.jsx`
-> `frontend/src/components/QuoteMiner.jsx`
-> `frontend/src/components/TemplateImages.jsx`

**`frontend/src/components/Layout.jsx`** — Glass navbar + segmented control + user badge
-> `frontend/src/pages/Dashboard.jsx`
-> `frontend/src/pages/Projects.jsx`
-> `frontend/src/pages/ProjectSetup.jsx`
-> `frontend/src/pages/ProjectDetail.jsx`
-> `frontend/src/pages/Settings.jsx`
-> `frontend/src/pages/AgentDashboard.jsx`

**`frontend/src/components/PipelineProgress.jsx`** — Shared progress bar for all long-running SSE pipelines
-> `frontend/src/components/BatchRow.jsx`
-> `frontend/src/components/FoundationalDocs.jsx`
-> `frontend/src/components/LPAgentSettings.jsx`
-> `frontend/src/components/LPGen.jsx`
-> `frontend/src/components/QuoteMiner.jsx`

### Tier 3: 3–4 Consumers

**`backend/services/lpGenerator.js`** — LP copy + design + HTML generation (Claude Sonnet + Opus editorial pass)
-> `backend/routes/lpAgent.js`
-> `backend/services/lpAutoFixer.js`
-> `backend/services/lpAutoGenerator.js`
-> `backend/services/lpPublisher.js`

**`backend/services/quoteMiner.js`** — Exports: `runQuoteMining`, `generateSuggestions`, `getAnthropicClient`
-> `backend/routes/chat.js`
-> `backend/routes/quoteMining.js`
-> `backend/services/headlineGenerator.js`
-> `backend/services/quoteBankService.js`

**`backend/services/batchProcessor.js`** — Exports: `runBatch`, `pollBatchJob`
-> `backend/routes/batches.js`
-> `backend/services/conductorEngine.js`
-> `backend/services/scheduler.js`

**`backend/services/rateLimiter.js`** — Exports: `withHeavyLLMLimit` (concurrency=2), `withGeminiLimit` (concurrency=3), `getRateLimiterStats`
-> `backend/server.js`
-> `backend/services/adGenerator.js`
-> `backend/services/gemini.js`

**`frontend/src/hooks/usePolling.js`** — Interval polling hook
-> `frontend/src/components/AdStudio.jsx`
-> `frontend/src/components/BatchManager.jsx`
-> `frontend/src/components/QuoteMiner.jsx`

**`frontend/src/components/DragDropUpload.jsx`** — Reusable file upload component
-> `frontend/src/pages/ProjectSetup.jsx`
-> `frontend/src/pages/Settings.jsx`
-> `frontend/src/components/FoundationalDocs.jsx`

**`frontend/src/App.jsx`** — Exports: `AuthContext` (consumed via `useContext`)
-> `frontend/src/pages/Login.jsx`
-> `frontend/src/pages/Projects.jsx`
-> `frontend/src/pages/ProjectDetail.jsx`
-> `frontend/src/components/Layout.jsx`

### Tier 4: 2 Consumers

**`backend/services/adGenerator.js`** — Ad generation orchestrator (Mode 1/2)
-> `backend/routes/ads.js`
-> `backend/routes/deployments.js`

**`backend/services/scheduler.js`** — 7 cron tasks + user-defined batch schedules
-> `backend/server.js`
-> `backend/routes/batches.js`

**`backend/services/conductorEngine.js`** — Director batch planning + angle selection
-> `backend/routes/conductor.js`
-> `backend/services/scheduler.js`

**`backend/services/conductorLearning.js`** — Learning from scored ads + adaptive batch sizing (known bug: `messages.filter is not a function`)
-> `backend/routes/conductor.js`
-> `backend/services/conductorEngine.js`

**`backend/services/metaAds.js`** — Meta OAuth, token refresh, performance sync
-> `backend/routes/meta.js`
-> `backend/services/scheduler.js`

**`backend/services/quoteDedup.js`** — Semantic quote deduplication (GPT-4.1-mini)
-> `backend/routes/quoteMining.js`
-> `backend/services/quoteBankService.js`

**`backend/services/bodyCopyGenerator.js`** — Body copy from headline + quote context
-> `backend/routes/ads.js`
-> `backend/routes/quoteMining.js`

**`backend/services/lpSwipeFetcher.js`** — Puppeteer page capture + SSRF protection
-> `backend/routes/landingPages.js`
-> `backend/services/lpTemplateExtractor.js`

**`backend/services/lpPublisher.js`** — Shopify page deploy + smoke test
-> `backend/routes/landingPages.js`
-> `backend/services/lpAutoGenerator.js`

**`backend/services/lpAutoFixer.js`** — Deterministic + LLM-powered Visual QA fixes
-> `backend/services/lpGenerator.js`

**`frontend/src/components/ErrorBoundary.jsx`** — React error boundary (page + tab levels)
-> `frontend/src/App.jsx`
-> `frontend/src/pages/ProjectDetail.jsx`

**`frontend/src/components/batchUtils.js`** — Batch constants, cron helpers, formatters
-> `frontend/src/components/BatchManager.jsx`
-> `frontend/src/components/BatchRow.jsx`

### Third-Party Packages (4+ backend files)

**`uuid` (v4)** — UUID generation for `externalId` fields
-> `backend/auth.js`
-> `backend/routes/agentMonitor.js`
-> `backend/routes/auth.js`
-> `backend/routes/batches.js`
-> `backend/routes/chat.js`
-> `backend/routes/conductor.js`
-> `backend/routes/documents.js`
-> `backend/routes/landingPages.js`
-> `backend/routes/projects.js`
-> `backend/routes/templates.js`
-> `backend/routes/users.js`
-> `backend/services/adGenerator.js`
-> `backend/services/batchProcessor.js`
-> `backend/services/conductorAngles.js`
-> `backend/services/conductorEngine.js`
-> `backend/services/correctionHistory.js`
-> `backend/services/costTracker.js`
-> `backend/services/docGenerator.js`
-> `backend/services/lpAutoGenerator.js`
-> `backend/services/lpPublisher.js`
-> `backend/services/lpTemplateExtractor.js`
-> `backend/services/metaAds.js`
-> `backend/services/quoteBankService.js`
-> `backend/services/quoteDedup.js`

**`multer`** — Multipart file upload middleware
-> `backend/routes/landingPages.js`
-> `backend/routes/projects.js`
-> `backend/routes/templates.js`
-> `backend/routes/upload.js`

### Dead Code

**`backend/services/conductorAngles.js`** — Angle auto-generation service. Exports `generateAngles`. Imported by **zero production files**. Referenced only in a comment in `conductorEngine.js` ("Phase 4"). Also imported by `anthropic.js` for the `chat` function but itself has zero callers.

---

## 5. Critical Invariants

Rules that must never be violated. Breaking these causes silent failures or data corruption.

### Data Shape Contracts

1. **`externalId` is the foreign key, not `_id`**. All cross-table references use UUID `externalId` strings. Convex native `_id` is never used for relationships. Exception: `inspiration_images` has no `externalId` — it uses composite key `(project_id, drive_file_id)`.

2. **JSON arrays stored as strings**. These fields look like arrays but are `v.string()` in the schema — you must `JSON.parse()` to read and `JSON.stringify()` to write:
   - `batch_jobs`: `angles`, `gpt_prompts`, `used_template_ids`, `pipeline_state`, `template_image_ids`, `inspiration_image_ids`
   - `flex_ads`: `child_deployment_ids`, `primary_texts`, `headlines`
   - `ad_deployments`: `primary_texts`, `ad_headlines`
   - `quote_mining_runs`: `quotes`, `keywords`, `subreddits`, `forums`, `facebook_groups`, `headlines`
   - `quote_bank`: `headlines`, `tags`
   - `landing_pages`: `copy_sections`, `image_slots`, `cta_links`, `swipe_design_analysis`, `hosting_metadata`
   - `landing_page_versions`: `copy_sections`, `image_slots`, `cta_links`
   - `correction_history`: `changes`

3. **Soft-delete pattern**. `ad_deployments` and `flex_ads` use `deleted_at` timestamp. All queries MUST filter out `deleted_at` records. Hard purge runs daily at 1am for records >30 days old.

4. **Cascade deletion**. `campaigns.remove()` -> hard-deletes child ad_sets -> soft-deletes child flex_ads. `adSets.remove()` -> soft-deletes child flex_ads. Any new parent-child entity must cascade.

5. **`convexBatchToRow` converts `scheduled` boolean to 0/1 integer**. Frontend must use `!!batch.scheduled` not bare `batch.scheduled` in JSX to avoid rendering `0`.

6. **Mapper functions + field whitelists**. Every route handler receives Convex data through mappers in `convexClient.js`. If you add a field to the schema, you MUST also add it to the mapper AND the helper's field whitelist or it won't appear in API responses / won't be saved on updates.

7. **Dedup guards**. `ad_deployments.create()` checks if `ad_id` already deployed (active only) — returns null if duplicate. `createWithoutDedup()` skips this. `inspiration_images.create()` skips if `(project_id, drive_file_id)` already exists.

8. **Upsert operations**. `meta_performance.upsert()` by `(meta_ad_id, date)`. `conductor_config.upsertConfig()` by `project_id`. `lp_agent_config.upsertConfig()` by `project_id`. `conductor_playbooks.upsertPlaybook()` by `(project_id, angle_name)`. `fixer_playbook.upsertFixerPlaybook()` by `issue_category`. `settings.set()` by `key`.

### API Contracts

9. **SSE events**: All SSE endpoints emit `data: ${JSON.stringify(event)}\n\n`. Event objects always have a `type` field (`progress`, `step`, `complete`, `error`, `result`). Components parse these in `onEvent` callbacks.

10. **Cost logging is fire-and-forget**. Every LLM wrapper auto-logs costs internally. Callers pass `{ operation, projectId }` via options. The logging call uses `.catch(() => {})` — failures are silently swallowed. Never await cost logging.

11. **Error response shape**. All API errors: `res.status(N).json({ error: err.message })`. All mutation successes: `res.json({ success: true, ... })`. New routes must follow this.

12. **Deployment status strings**. The exact values `"selected"`, `"ready_to_post"`, `"posted"`, `"analyzing"` are hardcoded across the entire stack. No enum — raw strings everywhere.

### Auth & Roles

13. **Three roles: `admin`, `manager`, `poster`**. Poster can ONLY see the Ad Pipeline tab (Ready to Post + Posted). Poster cannot access Planner, create projects, access Dashboard, or Settings. Backend enforces via `requireRole('admin', 'manager')`.

14. **`req.user` shape**: `{ id, username, role, displayName }`. Populated by `requireAuth` middleware from session. Every route handler depends on this shape.

15. **Session secret**: Auto-generated 64-char hex string via `crypto.randomBytes(32)` on first server start. Stored as `session_secret` setting in Convex.

16. **Localhost-only agent endpoints**. `/api/agent-cost` routes use `localhostOnly` middleware checking `req.ip` against `['127.0.0.1', '::1', '::ffff:127.0.0.1']`.

### LP Pipeline

17. **`injectContrastSafetyCSS` is idempotent**. Checks for `data-safety="contrast"` marker before injecting. Safe to call multiple times. Exported from `lpGenerator.js`, called in: `postProcessLP()`, `landingPages.js` PUT endpoint, `landingPages.js` version restore endpoint.

18. **Frontend `assembleHtmlClient()` strips all post-processing**. The function rebuilds HTML from raw `htmlTemplate` + copy sections. The backend PUT endpoint re-applies contrast CSS. The frontend also injects a simplified contrast CSS version for editor preview. Any new post-processing added to `postProcessLP()` may need a corresponding safety net in the PUT endpoint.

19. **LP auto-generation is fire-and-forget**. `triggerLPGeneration()` never throws to caller. All errors are caught internally and set status to `'failed'` + error message on the batch record.

20. **Visual QA loop**: `generateAndValidateLP()` runs up to 3 generation attempts. Each failed attempt triggers `autoFixLP()` which applies deterministic fixes first (free), then LLM-powered fixes (costs tokens). Fix types: contrast CSS injection, broken image regeneration (Gemini), layout CSS fix (Claude Sonnet).

21. **Smoke test checks**: `runSmokeTest()` runs 7 automated checks post-publish: HTTP 200, load time <15s, no raw placeholders, headline present, >=50% images load, valid CTA links, no mobile horizontal overflow at 375px.

### Naming & Conventions

22. **`project_id` everywhere = `projects.externalId`** (UUID string), not the Convex `_id`.

23. **No Convex actions**. Only queries + mutations. All LLM calls, file processing, and external API work happens in Express backend.

24. **File naming**: camelCase for JS/JSX, PascalCase for React components, snake_case for Convex table names and fields.

25. **All LLM calls must go through wrappers**. Never call OpenAI, Anthropic, or Gemini APIs directly. Always use `services/openai.js`, `services/anthropic.js`, or `services/gemini.js` — they provide retry logic and automatic cost tracking.

### Convex Relationship Map

```
projects
  +-- foundational_docs (project_id)
  +-- ad_creatives (project_id)
  |     +-- batch_jobs (ad_creatives.batch_job_id)
  +-- campaigns (project_id)
  |     +-- ad_sets (campaign_id)
  |           +-- flex_ads (ad_set_id)
  +-- ad_deployments (project_id, ad_id)
  |     +-- meta_performance (deployment_id)
  +-- quote_mining_runs (project_id)
  |     +-- quote_bank (run_id)
  +-- template_images (project_id)
  +-- inspiration_images (project_id, composite key)
  +-- chat_threads (project_id)
  |     +-- chat_messages (thread_id)
  +-- landing_pages (project_id)
  |     +-- landing_page_versions (landing_page_id)
  +-- lp_templates (project_id)
  +-- correction_history (project_id)
  +-- conductor_config (project_id, PK)
  +-- conductor_angles (project_id)
  +-- conductor_runs (project_id)
  +-- conductor_playbooks (project_id)
  +-- lp_agent_config (project_id, PK)
```

Standalone tables: `settings`, `users`, `sessions`, `api_costs`, `dashboard_todos`, `conductor_health`, `fixer_playbook`, `file_storage`

### Adding a New API Route

1. Create handler in `backend/routes/{feature}.js`
2. Use `requireAuth` + `requireRole('admin', 'manager')` middleware
3. Error responses: `res.status(N).json({ error: err.message })`
4. Success responses: `res.json({ success: true, ...data })`
5. Mount in `server.js` with appropriate path
6. Add rate limiting if it triggers LLM calls
7. Add corresponding method in `frontend/src/api.js`

### Adding a New Convex Table/Field

1. Add to `convex/schema.ts` with field types
2. Create `convex/{table}.ts` with queries + mutations (include field whitelisting)
3. Add mapper in `convexClient.js` to normalize Convex objects to API rows
4. Add helper functions in `convexClient.js` with field whitelists for updates
5. Add route handler to read/write the field
6. Add API method in `frontend/src/api.js`
7. Deploy Convex separately: `npx convex deploy -y` on VPS
8. If hierarchical: implement cascade deletion in parent's `remove()` mutation

### Adding a New LLM Call

1. ALWAYS use the wrapper (`openai.js`, `anthropic.js`, or `gemini.js`)
2. Pass `{ operation: 'descriptive_name', projectId }` in options for cost tracking
3. Never call APIs directly — wrappers provide retry logic + cost logging
4. For Claude JSON mode: wrapper auto-strips markdown fences and extracts first `{ ... }` block

### Adding a New Long-Running Process or Progress Bar

**READ the skill file first:** `.claude/skills/progress-bar-standard/SKILL.md`

1. Use `PipelineProgress` component (`frontend/src/components/PipelineProgress.jsx`) — no custom progress bars
2. Backend: emit `{ type: 'progress', step: 'name', message: '...' }` via `createSSEStream` or `streamService`
3. Frontend: create `STEP_PROGRESS` map (weighted by wall-clock time) and `STEP_LABELS` map
4. Use `Math.max(prev, newValue)` for all progress updates (never go backwards)
5. Set `genStartRef.current = Date.now()` when starting (enables ETA display)
6. On completion: set 100%, wait 500ms, then reset state
7. The skill file has the full pattern, anti-patterns, and verification checklist

---

## 6. Common Pitfalls

1. **Forgetting Convex deploy** — `deploy.sh` only deploys backend + frontend. Schema/function changes require separate `npx convex deploy -y` on VPS.

2. **Missing field in whitelist** — `convexClient.js` helper functions use explicit field whitelists. Adding a field to schema + mutation but not the whitelist means updates silently drop the field.

3. **React `&&` with numbers** — `batch.scheduled` is stored as 0/1 integer. Use `!!batch.scheduled &&` not bare `batch.scheduled &&` or `0` renders as visible text.

4. **SSE event shape mismatch** — No type checking between backend emitter and frontend handler. Changes must be synchronized manually.

5. **Rate limiter concurrency** — Heavy LLM: concurrency=2, 2s gap. Gemini: concurrency=3. Increasing causes 429 errors.

6. **Deep Research timeout** — o3-deep-research has 30-minute timeout with 5s polling. Falls back gracefully.

7. **50MB JSON body limit** — Express configured with `express.json({ limit: '50mb' })`. Adding body-size middleware before JSON parser may conflict.

8. **LP HTML code fences** — Claude sometimes wraps HTML in markdown fences. `lpGenerator.js` auto-strips these.

9. **Thumbnail cache** — Lives at `backend/.thumb-cache/`. Delete directory to regenerate.

10. **Meta token expiry** — Tokens expire ~60 days. Scheduler auto-refreshes weekly. No proactive expiry warning.

11. **Agent scripts not in deploy.sh** — Must SCP agent directories manually to VPS.

12. **`dashboard_todos.replaceAll` is destructive** — Deletes ALL existing todos, inserts new ones. Not an update.

13. **No TypeScript on backend** — No type checking between SSE emitters and frontend handlers, or between Convex schema and Express routes.

14. **No enum for status strings** — `"selected"`, `"ready_to_post"`, `"posted"`, `"analyzing"` are raw strings everywhere. Renaming requires updating every file that references them.

15. **VPS constraints** — 2GB RAM max (PM2 `max_memory_restart`), single instance only.

16. **`conductorLearning.js` bug** — Has `messages.filter is not a function` error in learning step. Data shape issue, pre-existing.

17. **`cost_cents=0` treated as falsy** — In `agentMonitor.js` cost logging validation (`if (!cost_cents)`) — cosmetic, logs skip message.

18. **`conductorAngles.js` is dead code** — Never imported by any production caller. Referenced only in a comment in `conductorEngine.js`.

19. **OpenAI 429 on nearly every first attempt** — Current account hits rate limits frequently. The retry system handles this (15s+ backoff). Ad generation takes ~50s. This is expected, not a bug.

20. **LP contrast CSS stripping** — Frontend `assembleHtmlClient()` rebuilds HTML without contrast CSS. The PUT endpoint re-injects it. If you add a new code path that saves `assembled_html`, make sure it calls `injectContrastSafetyCSS()`.

21. **LP auto-save overwrites post-processing** — Any time the editor auto-saves (copy edit, CTA change), it sends rebuilt HTML to the PUT endpoint. The PUT endpoint's safety net re-applies placeholder fixes + contrast CSS. New post-processing steps need a corresponding safety net.

22. **Puppeteer memory** — LP Visual QA, smoke tests, and template extraction all launch headless Chromium. On the 2GB VPS, concurrent Puppeteer instances can OOM. The LP auto-generator runs sequentially (not parallel) for this reason.

---

## 7. File Structure

```
ad-platform/
+-- backend/
|   +-- server.js                    # Express entry point (port 3001)
|   +-- auth.js                      # requireAuth + requireRole middleware
|   +-- convexClient.js              # Central data layer (100+ helpers, mappers)
|   +-- ConvexSessionStore.js        # Convex-backed express-session store
|   +-- vitest.config.js             # Test config
|   +-- routes/                      # 20 route files
|   |   +-- auth.js                  # Login/setup/session
|   |   +-- users.js                 # User CRUD (admin only)
|   |   +-- projects.js              # Project CRUD + product image
|   |   +-- documents.js             # Doc generation (SSE)
|   |   +-- ads.js                   # Ad generation (Mode 1/2)
|   |   +-- batches.js               # Batch CRUD + scheduling
|   |   +-- costs.js                 # Cost aggregation
|   |   +-- drive.js                 # Google Drive sync + inspiration
|   |   +-- templates.js             # Template images
|   |   +-- upload.js                # File upload + text extraction
|   |   +-- settings.js              # API keys, rates (admin)
|   |   +-- deployments.js           # Ad Pipeline CRUD (campaigns, ad sets, flex ads, deployments)
|   |   +-- quoteMining.js           # Quote mining + bank
|   |   +-- chat.js                  # Copywriter Chat
|   |   +-- landingPages.js          # LP CRUD + generation + publishing + Visual QA
|   |   +-- lpTemplates.js           # LP template extraction + management
|   |   +-- meta.js                  # Meta OAuth + performance
|   |   +-- agentMonitor.js          # Agent Dashboard status/control
|   |   +-- conductor.js             # Director config + angles + runs
|   |   +-- lpAgent.js               # LP Agent config, Shopify, test gen
|   +-- services/                    # 25 service files
|   |   +-- openai.js                # GPT-5.2, GPT-4.1, o3-deep-research
|   |   +-- anthropic.js             # Claude Opus 4.6, Sonnet 4.6
|   |   +-- gemini.js                # Gemini 3 Pro images
|   |   +-- adGenerator.js           # Ad generation orchestrator
|   |   +-- batchProcessor.js        # 4-stage batch pipeline
|   |   +-- docGenerator.js          # 8-step doc pipeline
|   |   +-- quoteMiner.js            # Dual-engine quote search
|   |   +-- headlineGenerator.js     # Headline generation
|   |   +-- bodyCopyGenerator.js     # Body copy generation
|   |   +-- quoteBankService.js      # Quote bank orchestration
|   |   +-- quoteDedup.js            # Quote deduplication
|   |   +-- costTracker.js           # Cost logging + sync
|   |   +-- scheduler.js             # 7 cron tasks + schedules
|   |   +-- metaAds.js               # Meta Ads integration
|   |   +-- rateLimiter.js           # Concurrency control
|   |   +-- retry.js                 # Exponential backoff
|   |   +-- lpGenerator.js           # LP generation + Opus editorial + postProcessLP + Visual QA
|   |   +-- lpAutoGenerator.js       # Director-triggered LP auto-generation (2 per batch)
|   |   +-- lpAutoFixer.js           # Deterministic + LLM Visual QA fixes
|   |   +-- lpPublisher.js           # Shopify page deploy + smoke test
|   |   +-- lpSmokeTest.js           # 7 automated post-publish checks
|   |   +-- lpSwipeFetcher.js        # Puppeteer page capture + SSRF protection
|   |   +-- lpTemplateExtractor.js   # URL -> reusable HTML template
|   |   +-- correctionHistory.js     # Doc correction audit
|   |   +-- conductorEngine.js       # Director orchestrator
|   |   +-- conductorAngles.js       # Angle generation (DEAD CODE)
|   |   +-- conductorLearning.js     # Learning + adaptive sizing
|   +-- utils/
|       +-- sseHelper.js             # SSE stream utilities
|       +-- adImages.js              # Image loading + thumbnails
|
+-- frontend/src/
|   +-- main.jsx                     # React entry (BrowserRouter)
|   +-- App.jsx                      # Router + AuthContext + lazy loading
|   +-- api.js                       # 164 API methods
|   +-- index.css                    # Tailwind + custom classes
|   +-- pages/                       # 8 page components
|   |   +-- Login.jsx                # Auth page
|   |   +-- Dashboard.jsx            # System overview + costs + todos
|   |   +-- Projects.jsx             # Project list
|   |   +-- ProjectSetup.jsx         # Create/edit project
|   |   +-- ProjectDetail.jsx        # Tabbed project workspace (7 tabs)
|   |   +-- Settings.jsx             # API keys, rates, references
|   |   +-- AdTracker.jsx            # Cross-project ad performance
|   |   +-- AgentDashboard.jsx       # Agent system (4 tabs: Director, LP Agent, Filter, Fixer)
|   +-- components/                  # 27 component files
|   |   +-- Layout.jsx               # Navbar wrapper
|   |   +-- Toast.jsx                # Toast notifications
|   |   +-- ErrorBoundary.jsx        # Error boundary
|   |   +-- InfoTooltip.jsx          # Hover tooltips
|   |   +-- DragDropUpload.jsx       # File upload
|   |   +-- PipelineProgress.jsx     # Shared progress bar (see skill)
|   |   +-- AdStudio.jsx             # Ad generation (~2500 lines)
|   |   +-- BatchManager.jsx         # Batch management (~2500 lines)
|   |   +-- BatchRow.jsx             # Single batch row component
|   |   +-- batchUtils.js            # Batch constants + helpers
|   |   +-- FoundationalDocs.jsx     # Doc generation
|   |   +-- QuoteMiner.jsx           # Quote mining + bank
|   |   +-- CampaignsView.jsx        # Planner view (campaigns, ad sets, deployments)
|   |   +-- ReadyToPostView.jsx      # Ready to Post view
|   |   +-- PostedView.jsx           # Posted history
|   |   +-- LPGen.jsx                # Landing page generator + editor (~3000 lines)
|   |   +-- LPAgentSettings.jsx      # LP Agent settings panel
|   |   +-- LPTemplateManager.jsx    # LP template extraction + management
|   |   +-- AgentMonitor.jsx         # Agent Dashboard tabs (Director, Filter, Fixer)
|   |   +-- CreativeFilterSettings.jsx # Per-project Filter config
|   |   +-- CopywriterChat.jsx       # Chat widget
|   |   +-- TemplateImages.jsx       # Template management
|   |   +-- InspirationFolder.jsx    # Drive inspiration
|   |   +-- CostSummaryCards.jsx     # Cost widgets
|   |   +-- CostBarChart.jsx         # 30-day chart
|   |   +-- DriveFolderPicker.jsx    # Drive folder browser
|   |   +-- GenerationQueue.jsx      # Ad queue display
|   |   +-- MultiInput.jsx           # Tag input
|   |   +-- NotionFilter.jsx         # Filter bar
|   +-- hooks/
|       +-- useAsyncData.js          # Fetch + loading + refetch
|       +-- usePolling.js            # Interval polling
|       +-- useSSEStream.js          # SSE streaming
|
+-- convex/                          # 27 function files (29 tables)
|   +-- schema.ts                    # Full database schema
|   +-- settings.ts                  # Key-value config store
|   +-- projects.ts                  # Project CRUD
|   +-- foundationalDocs.ts          # Doc CRUD + versioning
|   +-- adCreatives.ts               # Ad CRUD
|   +-- batchJobs.ts                 # Batch CRUD + status tracking
|   +-- apiCosts.ts                  # Cost logging
|   +-- campaigns.ts                 # Campaign CRUD + cascade delete
|   +-- adSets.ts                    # Ad set CRUD + cascade delete
|   +-- flexAds.ts                   # Flex ad CRUD + soft delete
|   +-- ad_deployments.ts            # Deployment CRUD + dedup + soft delete
|   +-- templateImages.ts            # Template image CRUD
|   +-- inspirationImages.ts         # Inspiration sync + composite key
|   +-- quote_mining_runs.ts         # Mining run CRUD
|   +-- quote_bank.ts                # Quote bank CRUD
|   +-- chatThreads.ts              # Chat thread + message CRUD
|   +-- correction_history.ts        # Correction audit log
|   +-- dashboard_todos.ts           # Dashboard to-do list (replaceAll is destructive)
|   +-- metaPerformance.ts           # Meta metrics + upsert
|   +-- landingPages.ts              # LP CRUD
|   +-- landingPageVersions.ts       # LP version history
|   +-- lpTemplates.ts               # LP template CRUD
|   +-- users.ts                     # User CRUD
|   +-- sessions.ts                  # Session store
|   +-- fileStorage.ts               # Blob storage helpers
|   +-- conductor.ts                 # Director config + angles + runs + playbooks + health
|   +-- lpAgentConfig.ts             # LP Agent config (upsert by project_id)
|
+-- dacia-fixer/                     # Agent: auto-test, self-heal, resurrect
|   +-- fixer.sh                     # Main script (~1200 lines)
|   +-- config/fixer.conf            # Budget $1.33/day, models, intervals
|   +-- fix_ledger.md                # Institutional memory - DO NOT DELETE
|   +-- logs/                        # Daily log files + spend tracking
|
+-- dacia-creative-filter/           # Agent: score ads, create flex ads
|   +-- filter.sh                    # Main script (~1170 lines)
|   +-- config/filter.conf           # Budget $20/day, models, thresholds
|   +-- agents/
|   |   +-- score.sh                 # Vision-based scoring
|   |   +-- group.sh                 # Flex ad clustering
|   |   +-- validate.sh              # Copy validation
|   |   +-- regenerate.sh            # Copy fallback
|   +-- logs/                        # Daily log files + spend tracking
|
+-- deploy/
    +-- deploy.sh                    # Rsync -> npm install -> build -> PM2 restart
    +-- setup.sh                     # VPS initial setup
    +-- ecosystem.config.cjs         # PM2 config (port 3001, 2GB max)
    +-- nginx.conf                   # Reverse proxy + SSL + 300s timeout
```

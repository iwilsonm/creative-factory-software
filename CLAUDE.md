# Ad Creative Automation Platform — CLAUDE.md

> Context file for Claude Code threads. Read this before making any changes.

## What This Is

A single-tenant web application for direct response copywriters and e-commerce brands. It automates five core workflows:

1. **Foundational Document Generation** — An 8-step research pipeline (based on the Mark Builds Brands SOP) that uses GPT-4.1 and o3-deep-research to produce customer avatars, offer briefs, and belief documents from a product's sales page.
2. **Quote Mining & Headline Generation** — A dual-engine system using Perplexity Sonar Pro and Claude Opus 4.6 to extract emotional first-person quotes from online communities, then generates headlines using Claude Sonnet 4.6 with 3 reference copywriting docs.
3. **Static Image Ad Generation** — Uses GPT-5.2 as a creative director (2-message conversation flow) and Google Gemini 3 Pro Image ("Nano Banana Pro") to generate ad creatives, either one at a time or in automated batches on a cron schedule.
4. **Ad Pipeline & Meta Ads Integration** — Track generated ads through a deployment pipeline (Planner → Ready to Post → Posted) with a 3-level campaign hierarchy, flex ads, per-project Meta Ads OAuth for performance data syncing, and role-based access for Poster users.
5. **Landing Page Generation** — Generate landing page copy and responsive HTML from foundational docs via Claude Sonnet, with a split-panel editor, CTA link management, and one-click publishing to Cloudflare Pages.

**Live at**: `daciaautomation.com` (VPS: `76.13.183.219`)
**Convex deployment**: `prod:strong-civet-577` at `https://energized-hare-760.convex.cloud`
**GitHub**: `daciaventures/dacia-automation`

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 18 + Vite 5.4 + Tailwind CSS 3.4 + React Router 6 |
| Backend | Node.js + Express 4.21 |
| Database | Convex (cloud-hosted, schema-enforced) |
| File Storage | Convex blob storage (images, templates, product photos) |
| LLM (text) | OpenAI — GPT-5.2 (creative direction), GPT-4.1 (research/synthesis), GPT-4.1-mini (prompt review/editing, headline extraction), o3-deep-research (web research) |
| LLM (copy) | Anthropic — Claude Opus 4.6 (copy correction, chat, web search), Claude Sonnet 4.6 (headline generation, body copy) |
| LLM (web search) | Perplexity Sonar Pro (quote mining via web search) |
| LLM (images) | Google Gemini 3 Pro Image Preview via `@google/genai` SDK |
| External | Google Drive API v3 (service account auth) for inspiration sync + ad upload; Meta Marketing API v21.0 for per-project Ads Manager integration |
| Web Scraping | Puppeteer (headless Chrome) for LP Gen swipe page fetching |
| Auth | bcrypt + express-session + multi-user role-based access (Admin/Manager/Poster), Convex-backed session store |
| Scheduling | node-cron for recurring batch jobs + scheduler service polling Gemini Batch API |
| Process Manager | PM2 (production) |
| Reverse Proxy | Nginx with Let's Encrypt SSL |

---

## Directory Structure

```
ad-platform/
├── backend/
│   ├── server.js                    # Express entry point (port 3001)
│   ├── auth.js                      # requireAuth + requireRole middleware, isSetupComplete, migrateToMultiUser
│   ├── convexClient.js              # Convex HTTP client with retry wrapper (100+ helpers)
│   ├── ConvexSessionStore.js        # Custom express-session store backed by Convex sessions table
│   ├── routes/
│   │   ├── auth.js                  # Multi-user login/setup/session/password change (rate-limited 5/min)
│   │   ├── users.js                 # User management CRUD (admin only)
│   │   ├── projects.js              # CRUD + product image upload (multer)
│   │   ├── documents.js             # Foundational doc generation (SSE), upload, corrections, reversion
│   │   ├── ads.js                   # Ad generation (Mode 1/2) + prompt editing + tagging + angle/headline/body generation
│   │   ├── batches.js               # Batch job CRUD + scheduling + cancel
│   │   ├── costs.js                 # Cost aggregation (today/week/month) + history + recurring estimates + rates
│   │   ├── drive.js                 # Google Drive sync + folder browsing + service account upload
│   │   ├── templates.js             # Template image management + Drive sync + AI analysis
│   │   ├── upload.js                # File upload + text extraction (PDF, DOCX, EPUB, MOBI, Excel, Markdown, HTML, code, config files)
│   │   ├── settings.js              # API keys, rates, headline reference docs, app config (admin only)
│   │   ├── deployments.js           # Ad deployment tracking (Ad Pipeline: Planner → Ready to Post → Posted)
│   │   ├── quoteMining.js           # Quote mining runs, suggestions, headline generation, quote bank operations
│   │   ├── chat.js                  # Copywriter Chat widget (Claude Sonnet 4.6, foundational docs as context, multimodal: images + PDFs)
│   │   ├── landingPages.js          # Landing page CRUD, copy generation (SSE), HTML generation, publishing
│   │   └── meta.js                  # Meta OAuth, per-project ad account/campaign/adset management, performance sync
│   └── services/
│       ├── openai.js                # GPT-5.2, GPT-4.1, GPT-4.1-mini, o3-deep-research wrappers; streaming support
│       ├── anthropic.js             # Claude Opus 4.6 + Sonnet 4.6 wrappers; JSON mode; cost logging; PDF document blocks
│       ├── gemini.js                # Nano Banana Pro image generation (batch + single)
│       ├── docGenerator.js          # 8-step foundational doc pipeline
│       ├── adGenerator.js           # Ad generation orchestrator (Mode 1 + Mode 2); Headline Juicer; prompt editing
│       ├── batchProcessor.js        # 4-stage batch pipeline (brief → headlines → body copy → images); Gemini Batch API
│       ├── quoteMiner.js            # Perplexity Sonar + Claude Opus 4.6 web search, quote extraction, merging, ranking
│       ├── headlineGenerator.js     # Headline generation from quotes via Claude Sonnet 4.6 + 3 reference docs
│       ├── bodyCopyGenerator.js     # Body copy generation from headlines + quote context
│       ├── costTracker.js           # Anthropic/Perplexity pricing tables + Gemini cost logging + OpenAI billing sync
│       ├── scheduler.js             # Cron registration, batch polling every 5 min, Gemini rate refresh, Meta token refresh
│       ├── metaAds.js               # Meta OAuth token management, ad account selection, campaign browsing, performance sync
│       ├── retry.js                 # Exponential backoff utility (5 retries, 429-aware, Retry-After header support)
│       ├── rateLimiter.js           # GPT rate limiter (AsyncSemaphore, concurrency=2, 2s gap)
│       ├── quoteDedup.js            # Quote deduplication before adding to quote bank
│       ├── lpGenerator.js           # Landing page copy + HTML generation via Claude Sonnet
│       ├── lpSwipeFetcher.js        # Headless browser (Puppeteer) swipe page fetching + screenshot capture
│       └── lpPublisher.js           # Cloudflare Pages deployment (publish/unpublish landing pages)
│
├── frontend/
│   ├── src/
│   │   ├── App.jsx                  # Router + ProtectedRoute (role-based) + AuthContext (user object) + lazy-loaded pages
│   │   ├── main.jsx                 # React entry (BrowserRouter)
│   │   ├── api.js                   # Fetch wrapper + SSE streaming helpers (100+ API methods)
│   │   ├── index.css                # Tailwind layers + custom component classes
│   │   ├── pages/
│   │   │   ├── Login.jsx            # Multi-user auth + first-run admin setup
│   │   │   ├── Dashboard.jsx        # Cost cards + bar chart + recurring cost estimates + image rates + roadmap
│   │   │   ├── Projects.jsx         # Project grid with embedded stats (role-filtered: poster can't create)
│   │   │   ├── ProjectSetup.jsx     # New project wizard
│   │   │   ├── ProjectDetail.jsx    # Tabbed project hub (role-filtered: poster sees only Ad Pipeline tab)
│   │   │   ├── Settings.jsx         # API keys, Drive, rates, headline reference docs, password, Meta setup, User Management (admin)
│   │   │   └── AdTracker.jsx        # Ad Pipeline tracking (Planner → Ready to Post → Posted) + Meta integration
│   │   └── components/
│   │       ├── Layout.jsx           # Glass navbar + segmented control + role-based nav links + user badge
│   │       ├── AdStudio.jsx         # Full ad generation UI + gallery with tags, favorites, bulk actions, list view
│   │       ├── BatchManager.jsx     # Batch job management (~2500 lines): multi-template, multi-angle, scheduling, progress bars
│   │       ├── FoundationalDocs.jsx # Doc generation with SSE progress, upload, manual research, copy correction, correction history
│   │       ├── TemplateImages.jsx   # Template upload/management + Drive sync + AI analysis
│   │       ├── QuoteMiner.jsx       # Quote mining, auto-suggest, headline generation, quote bank, Notion-style filtering
│   │       ├── CopywriterChat.jsx   # Copywriter assistant (Claude Sonnet 4.6, foundational docs context, multimodal file attachments with drag-and-drop)
│   │       ├── ReadyToPostView.jsx   # Ready to Post side-by-side layout (role-aware: poster can't send back)
│   │       ├── LPGen.jsx            # Landing page generator (copy, design, HTML preview, CTA editor, publishing)
│   │       ├── InspirationFolder.jsx # Drive inspiration image sync
│   │       ├── CostSummaryCards.jsx # Dashboard cost widgets (expandable details, operation-level breakdown)
│   │       ├── CostBarChart.jsx     # 30-day stacked bar chart (SVG, by service)
│   │       ├── DragDropUpload.jsx   # Reusable file upload component
│   │       ├── DriveFolderPicker.jsx # Drive folder browser modal
│   │       ├── Toast.jsx            # Toast notification context + component
│   │       └── InfoTooltip.jsx      # Pure CSS hover tooltip
│   ├── vite.config.js               # Dev proxy → localhost:3001
│   ├── tailwind.config.js           # Apple font stack, custom shadows/radii
│   └── package.json
│
├── convex/
│   ├── schema.ts                    # Full database schema (24 tables)
│   ├── settings.ts                  # Key-value settings queries/mutations
│   ├── projects.ts                  # Projects CRUD + Meta OAuth fields + stats aggregation
│   ├── foundationalDocs.ts          # Docs CRUD with versioning
│   ├── adCreatives.ts              # Ad CRUD with storage URL resolution + favorite toggle
│   ├── batchJobs.ts                 # Batch job state machine + pipeline state tracking
│   ├── apiCosts.ts                  # Cost logging + aggregation + daily history + recalculation
│   ├── campaigns.ts                # Campaign CRUD (Planner hierarchy)
│   ├── adSets.ts                   # Ad set CRUD within campaigns
│   ├── flexAds.ts                  # Flexible ad groups (multiple images per ad)
│   ├── ad_deployments.ts            # Deployment tracking (Planner → Ready to Post → Posted)
│   ├── templateImages.ts            # Template storage management + analysis
│   ├── inspirationImages.ts         # Drive-synced inspiration images (dedup guard on create)
│   ├── quote_mining_runs.ts         # Mining run records + quotes array + headlines
│   ├── quote_bank.ts                # Individual quotes with emotions, tags, headlines per quote
│   ├── chatThreads.ts              # Chat conversations with Claude
│   ├── chatMessages.ts             # Chat messages (user + assistant) + context hiding (note: filename is camelCase but referenced as chat_messages in schema)
│   ├── correction_history.ts       # Copy correction history tracking
│   ├── metaPerformance.ts          # Meta ad performance data (impressions, clicks, spend, ROAS)
│   ├── dashboard_todos.ts           # Roadmap todos CRUD (dedicated table with priority support)
│   ├── landingPages.ts              # Landing page CRUD + version management
│   ├── landingPageVersions.ts      # Landing page version snapshots
│   ├── users.ts                    # Multi-user CRUD (username, role, password hash)
│   ├── sessions.ts                 # Convex-backed session store (get, set, destroy, cleanup)
│   └── fileStorage.ts               # Storage URL generation helpers
│
├── deploy/
│   ├── deploy.sh                    # Rsync + npm install + vite build + PM2 restart
│   ├── setup.sh                     # VPS initial setup (Node 22, PM2, Nginx, Certbot, UFW)
│   ├── ecosystem.config.cjs         # PM2 config (production env vars, 512MB max memory)
│   └── nginx.conf                   # Reverse proxy + SSL + caching + gzip
│
└── .gitignore
```

---

## Database Schema (Convex)

All tables live in Convex cloud. Schema is enforced via `convex/schema.ts`. 24 tables total.

| Table | Purpose | Key Fields |
|-------|---------|------------|
| `settings` | App config (key-value) | `key`, `value` |
| `projects` | Products/brands being advertised | `externalId`, `name`, `brand_name`, `niche`, `product_description`, `sales_page_content`, `drive_folder_id`, `inspiration_folder_id`, `prompt_guidelines`, `product_image_storageId`, `meta_app_id`, `meta_app_secret`, `meta_access_token`, `meta_token_expires_at`, `meta_ad_account_id`, `meta_user_name`, `meta_user_id`, `meta_last_sync_at` |
| `foundational_docs` | Generated research docs | `project_id`, `doc_type` (research/avatar/offer_brief/necessary_beliefs), `content`, `version`, `approved`, `source` (generated/uploaded/manual_research) |
| `ad_creatives` | Generated ads | `project_id`, `generation_mode`, `angle`, `headline`, `body_copy`, `image_prompt`, `gpt_creative_output`, `storageId`, `drive_file_id`, `drive_url`, `aspect_ratio`, `status`, `auto_generated`, `parent_ad_id`, `tags`, `is_favorite`, `source_quote_id` |
| `batch_jobs` | Scheduled + on-demand batches | `project_id`, `generation_mode`, `batch_size`, `angle`, `angles` (JSON), `aspect_ratio`, `template_image_id`, `template_image_ids` (JSON), `inspiration_image_ids` (JSON), `product_image_storageId`, `gemini_batch_job`, `gpt_prompts` (JSON), `status`, `scheduled`, `schedule_cron`, `completed_count`, `failed_count`, `run_count`, `retry_count`, `used_template_ids` (JSON), `batch_stats`, `pipeline_state` (JSON), `started_at`, `completed_at` |
| `api_costs` | Cost tracking per operation | `service` (gemini/openai/anthropic/perplexity), `operation`, `cost_usd`, `rate_used`, `image_count`, `resolution`, `source` (calculated/billing_api), `period_date` |
| `campaigns` | Ad Pipeline campaign hierarchy (Planner) | `externalId`, `project_id`, `name`, `sort_order` |
| `ad_sets` | Ad sets within campaigns | `externalId`, `campaign_id`, `project_id`, `name`, `sort_order` |
| `flex_ads` | Flexible ad groups (multi-image ads) | `externalId`, `project_id`, `ad_set_id`, `name`, `child_deployment_ids` (JSON), `primary_texts` (JSON), `headlines` (JSON), `destination_url`, `display_link`, `cta_button`, `facebook_page`, `planned_date`, `posted_by`, `deleted_at` |
| `ad_deployments` | Ad deployment tracking | `externalId`, `ad_id`, `project_id`, `status` (selected/scheduled/posted/analyzing), `campaign_name`, `ad_set_name`, `ad_name`, `landing_page_url`, `notes`, `planned_date`, `posted_date`, `local_campaign_id`, `local_adset_id`, `flex_ad_id`, `primary_texts` (JSON), `ad_headlines` (JSON), `destination_url`, `display_link`, `cta_button`, `facebook_page`, `posted_by`, `meta_campaign_id`, `meta_adset_id`, `meta_ad_id`, `deleted_at` |
| `template_images` | Uploaded ad templates | `project_id`, `filename`, `storageId`, `description`, `analysis` |
| `inspiration_images` | Drive-synced reference images | `project_id`, `drive_file_id`, `filename`, `storageId`, `mimeType`, `modifiedTime`, `size` |
| `quote_mining_runs` | Quote mining execution records | `project_id`, `status` (running/completed/failed), `target_demographic`, `problem`, `root_cause`, `keywords` (JSON), `subreddits` (JSON), `forums` (JSON), `facebook_groups` (JSON), `num_quotes`, `quotes` (JSON), `perplexity_raw`, `claude_raw`, `sources_used`, `quote_count`, `error_message`, `duration_ms`, `headlines` (JSON), `headlines_generated_at` |
| `quote_bank` | Individual quotes (denormalized from runs) | `project_id`, `quote`, `source`, `source_url`, `emotion`, `emotional_intensity`, `context`, `run_id`, `problem` (denormalized), `tags`, `is_favorite`, `headlines` (JSON), `headlines_generated_at` |
| `chat_threads` | Copywriter chat conversations | `project_id`, `title`, `status` (active/archived) |
| `chat_messages` | Chat messages within threads | `thread_id`, `project_id`, `role` (user/assistant), `content`, `is_context_message` (hides priming message) |
| `correction_history` | Copy correction audit trail | `project_id`, `instruction`, `corrections` (JSON), `before_docs` (JSON), `after_docs` (JSON) |
| `meta_performance` | Meta ad performance data | `deployment_id`, `meta_ad_id`, `date`, `impressions`, `clicks`, `spend`, `reach`, `ctr`, `cpc`, `cpm`, `conversions`, `conversion_value`, `frequency` |
| `dashboard_todos` | Roadmap to-do items (dedicated table) | `externalId`, `text`, `done`, `author`, `notes`, `priority` (1-4), `sort_order` |
| `landing_pages` | Generated landing pages | `externalId`, `project_id`, `name`, `slug`, `status` (draft/published/unpublished), `target_audience`, `page_goal`, `tone`, `swipe_url`, `swipe_screenshot_storageId`, `copy_sections` (JSON), `design_analysis`, `image_slots` (JSON), `html_template`, `assembled_html`, `cta_links` (JSON), `published_url`, `published_at`, `hosting_metadata`, `final_html`, `current_version` |
| `landing_page_versions` | Landing page version snapshots | `landing_page_id`, `version`, `html`, `copy_sections` (JSON) |
| `users` | Multi-user accounts | `externalId`, `username`, `display_name`, `password_hash`, `role` (admin/manager/poster), `is_active`, `created_by` |
| `sessions` | Convex-backed express sessions | `sid`, `session_data` (JSON string), `expires_at` (Unix timestamp) |

**Important**: Foreign keys use `externalId` (UUID strings), not Convex `_id`. The `externalId` pattern was carried over from the SQLite-to-Convex migration. All cross-table references use `project_id` → `projects.externalId`.

---

## Architecture Patterns

### Backend

- **Express middleware stack**: compression → helmet (CSP off) → CORS → JSON parser (50MB limit) → sessions → routes
- **Authentication**: Multi-user with role-based access (Admin/Manager/Poster). Session-based via `req.session.userId`. Rate-limited login (5/min). Bcrypt with 12 salt rounds. Session secret auto-generated and stored in Convex settings. Sessions stored in Convex via custom `ConvexSessionStore` (survives server restarts). `requireAuth` middleware attaches `req.user` object with `{ id, username, role, displayName }`. `requireRole(...roles)` middleware factory for route-level access control. Auto-migration on first start creates admin user from legacy credentials.
- **Convex client**: `convexClient.js` wraps `ConvexHttpClient` with auto-retry (3 retries, exponential backoff, 2000ms base). Provides 100+ helper functions covering all tables.
- **SSE streaming**: Doc generation, ad generation, quote mining, headline generation, and chat all stream progress events via Server-Sent Events. Pattern: `res.writeHead(200, { 'Content-Type': 'text/event-stream' })` then `res.write(`data: ${JSON.stringify(event)}\n\n`)`.
- **File uploads**: Multer saves to temp dir → uploaded to Convex storage → temp file deleted. Product images, templates, and inspiration images all stored in Convex.
- **Retry utility**: `withRetry(fn, options)` in `services/retry.js` — 5 retries, exponential backoff with jitter, rate-limit-aware (15s base delay for 429 errors), Retry-After header support, 120s max delay.
- **Rate limiter**: `withGptRateLimit(fn, label)` in `services/rateLimiter.js` — AsyncSemaphore-based concurrency limiter (concurrency=2, 2s minimum gap between calls). Wraps all GPT-5.2 calls to prevent 429 errors.
- **Cost logging**: Fire-and-forget pattern — `logAnthropicCost().catch(() => {})`. Anthropic/Perplexity costs calculated from token counts. Gemini costs logged immediately by rate. OpenAI synced hourly from billing API.

### Frontend

- **State management**: React hooks only (useState, useEffect, useRef, useCallback, useMemo). No Redux or external state library. ToastContext for global notifications. AuthContext for session state (includes user object with role, displayName for role-based UI filtering).
- **API layer**: `api.js` exports a single `api` object with 100+ methods for every endpoint. `request()` is the base fetch wrapper (auto-redirects to /login on 401). `streamSSE()` and `streamSSEWithBody()` handle Server-Sent Events.
- **Routing**: React Router 6 with `ProtectedRoute` wrapper that checks `api.getSession()` before rendering. Supports optional `roles` prop for role-based page access (redirects unauthorized users). Pages lazy-loaded via `React.lazy()` + `Suspense`.
- **Component pattern**: Pages are in `pages/`, reusable UI in `components/`. Large features (AdStudio, BatchManager, QuoteMiner, FoundationalDocs) are single-file components with extensive local state.
- **Form pattern**: Controlled inputs with spread-operator state updates: `setForm(prev => ({ ...prev, field: value }))`.
- **Debounced auto-save**: Prompt guidelines use 1.5s debounce with useRef timer.
- **Image caching**: Thumbnails disk-cached locally (backend `.thumb-cache/`), full images served via Convex CDN pre-signed URLs.

### Styling

- **Design language**: Navy-gold-teal premium palette. Frosted glass navbar, rounded cards with subtle shadows, SF Pro font stack.
- **Color tokens** (defined in `tailwind.config.js`):
  - `navy` (#1B2A4A) / `navy-light` (#2D4A7A) — Primary brand, navbar, buttons, headings
  - `gold` (#C4975A) — Accent, hover states, links, active indicators
  - `teal` (#2A9D8F) — Success states, positive indicators
  - `offwhite` (#F8F6F3) — Page backgrounds
  - `textdark` (#1B2A4A) — Primary text (same as navy)
  - `textmid` (#5A6B87) — Secondary text
  - `textlight` (#8B9BB5) — Tertiary text, placeholders
- **Tailwind CSS 3.4** with custom component layer (`@layer components` in `index.css`):
  - `.glass-nav` — Frosted glass navbar (backdrop-filter blur + saturation)
  - `.card` — White/80 bg, backdrop-blur, rounded-2xl, subtle multi-layer shadow
  - `.btn-primary` — Navy gradient, shadow, hover lift
  - `.btn-secondary` — Gray ghost button
  - `.input-apple` — Rounded input with gold focus ring
  - `.segmented-control` — Tab group with active pill
  - `.badge` — Inline pill
  - `.info-tooltip` — Pure CSS hover tooltip (dark bg)
- **Custom Tailwind config** (`tailwind.config.js`):
  - Font: `-apple-system, BlinkMacSystemFont, "SF Pro Display"...`
  - Border radius: xl=12px, 2xl=16px, 3xl=20px
  - Box shadows: apple-sm through apple-xl (soft, layered)
- **Data visualization colors**: OpenAI=#5B8DEF, Anthropic=#7C6DCD, Gemini=#2A9D8F, Perplexity=#C4975A
- **Animations**: `fade-in` (0.3s ease-out), `animate-slide-up` (0.25s toast animation)
- **Scrollbar**: Custom thin scrollbar via `.scrollbar-thin` class
- **Text sizes**: Compact UI density using `text-[10px]` through `text-[15px]`

---

## Key Workflows

### 1. Foundational Document Generation

**8-Step Pipeline**:
1. **Sales Page Analysis** (GPT-4.1) — Extract key claims, mechanisms, audience signals
2. **Research Methodology Teaching** (GPT-4.1) — Teach 4-layer research framework
3. **Research Prompt Generation** (GPT-4.1) — Generate custom research prompt for product
4. **Deep Research** (o3-deep-research) — Web browsing with 30-min timeout
5. **Avatar Synthesis** (GPT-4.1) — Generate Avatar Sheet from research
6. **Offer Brief Synthesis** (GPT-4.1) — Generate Offer Brief
7. **E5/Agora Training** (GPT-4.1, no output) — Teach copywriting methodology
8. **Necessary Beliefs Synthesis** (GPT-4.1) — Generate Necessary Beliefs doc

**Alternate Flows**:
- **Manual Research**: User pastes research content → skip to step 5 (synthesis only)
- **Upload Docs**: User uploads existing docs directly, bypassing generation entirely
- **Regenerate Single Doc**: Regenerate just one doc type without redoing everything

**Copy Correction** (AI-powered fact-checking):
- User enters instruction (e.g., "fix the claim about vitamin D deficiency")
- Claude Opus 4.6 scans all docs, identifies inaccurate claims, proposes corrections with old_text/new_text
- User reviews and applies selected corrections
- All corrections logged to correction history with before/after snapshots
- Users can revert corrections from history (restore before-state of docs)

### 2. Quote Mining & Headline Generation

**Quote Mining (Dual-Engine)**:
1. User enters: target demographic, problem statement, keywords
2. System auto-suggests: subreddits, forums, Facebook groups (via GPT-4.1-mini)
3. **Parallel search**: Perplexity Sonar Pro + Claude Opus 4.6 web search
4. Results merged, deduplicated, ranked
5. Quotes stored in `quote_mining_runs`, then optionally imported to `quote_bank`

**Quote Bank**:
- Persistent store of quotes with metadata (emotion, intensity, tags, headlines)
- Per-quote headline generation (Claude Sonnet 4.6 + 3 reference docs)
- Per-quote body copy generation
- Notion-style filtering by problem, emotion, tag, favorite status

**Headline Generation**:
- Uses 3 uploaded reference documents: Headline Engine, 100 Greatest Headlines, 349 Swipe File
- Claude Sonnet 4.6 generates 3-5 headlines per quote using techniques from references
- Headlines can be generated for entire runs or individual quotes

### 3. Ad Generation (Single + Batch)

**Mode 1 (Direct Inspiration)**:
1. User selects angle, aspect ratio, and inspiration image (or uploads one)
2. GPT-5.2 Message 1: All 4 foundational docs + brand context
3. GPT-5.2 Message 2: Inspiration image via vision API (+ product image if available)
4. Returns detailed image prompt
5. Optional: Headline Juicer (Message 3 — refines prompt using headline reference docs)
6. Optional: Prompt guidelines review (GPT-4.1-mini auto-check)
7. Gemini 3 Pro generates image
8. Headline + body copy extracted from prompt via GPT-4.1-mini JSON parsing
9. Ad stored in Convex, thumbnail cached locally, Gemini cost logged

**Mode 2 (Template-Based)**:
Same flow as Mode 1 but template image used instead of random inspiration. Prompt tailored to match template's visual style.

**Prompt Editing**:
- NLP edit via natural language instruction
- Optional reference image (vision API) for visual context
- GPT-5.2 revises prompt, returns only the new prompt text

**Standalone Generation** (from Ad Studio):
- Generate random angle from foundational docs
- Generate headline from angle
- Generate body copy from headline + source quote

### 4. Batch Jobs (4-Stage Pipeline)

**Setup**:
- Configure: batch size (1-50), generation mode, angle/angles, aspect ratio
- Optional: multi-select templates, multi-select inspiration images, custom product image
- Optional: cron schedule (every hour / 6h / 12h / daily / weekdays / weekly / monthly / custom interval)

**Execution** (shown as "Step X of 5" in UI):
1. **Brief Extraction** (GPT-5.2, rate-limited) — Extract key messaging from foundational docs
2. **Headline Generation** (sequential) — Generate N headlines from brief
3. **Body Copy Generation** (sequential) — Generate N body copies
4. **Image Prompt Generation** (sequential, rate-limited) — Generate N Gemini image prompts
5. **Image Generation** (Gemini Batch API) — Async batch submission, scheduler polls every 5 min

**Status flow**: `pending` → `generating_prompts` → `submitting` → `processing` → `completed` | `failed`

**Template Rotation**: Tracks `used_template_ids` across runs. When all templates used, resets.

**Auto-retry**: Failed batches automatically retry up to 3 times before being marked permanently failed.

### 5. Cost Tracking (4 Services)

| Service | Method | Timing |
|---------|--------|--------|
| Gemini | Rate × image count | Logged immediately after generation |
| OpenAI | Organization Costs billing API | Synced hourly by scheduler |
| Anthropic | Token count × rate table | Calculated immediately (fire-and-forget) |
| Perplexity | Token count × rate table | Calculated immediately (fire-and-forget) |

**Anthropic Rates** (per million tokens):
- Claude Opus 4.6: $5 input / $25 output
- Claude Sonnet 4.6: $3 input / $15 output
- Claude Haiku 3.5: $0.80 input / $4 output

**Perplexity Rates** (per million tokens):
- Sonar Pro: $3 input / $15 output
- Sonar: $1 input / $1 output

**Dashboard displays**: Today/Week/Month summaries, 30-day stacked bar chart (by service), recurring batch cost estimates, cost per ad (project-scoped), current Gemini per-image rates.

### 6. Ad Pipeline & Meta Integration

**Ad Pipeline** (3 views within the Ad Pipeline tab):
1. **Planner** — 3-level hierarchy: campaigns → ad sets → flex ads. Drag ads from gallery to build ad groups with shared copy, CTA buttons, Facebook Page, and planned dates. Supports single-image and flex (multi-image) ads.
2. **Ready to Post** — Side-by-side layout showing ad image preview alongside deployment details (campaign, ad set, ad name, destination URL, display link, CTA button, primary texts, headlines, Facebook Page, posted by). Mark individual or bulk ads as posted.
3. **Posted** — History of posted ads with posted date, posted-by attribution. Admin/Manager can send back to Ready to Post; Poster sees read-only view.

**Deployment Fields**: `campaign_name`, `ad_set_name`, `ad_name`, `destination_url`, `display_link`, `cta_button`, `facebook_page`, `posted_by`, `primary_texts` (JSON), `ad_headlines` (JSON), `planned_date`, `posted_date`.

**Per-Project Meta Ads**:
- Each project has its own Meta App ID, App Secret, OAuth token
- User selects Meta ad account per project
- Browse campaigns → ad sets → ads
- Link deployments to Meta ads (stores `meta_campaign_id`, `meta_adset_id`, `meta_ad_id`)
- Scheduler syncs performance data every 5 minutes: impressions, clicks, spend, CPC, CPM, conversions, ROAS

### 7. Copywriter Chat

- Claude Sonnet 4.6 with all 4 foundational docs loaded as context
- First message sends a hidden priming message with full docs (marked `is_context_message`)
- Can prefill Ad Studio with generated headlines/angles
- Thread-based: one active thread per project, can clear and restart
- **Multimodal file attachments**: Upload files via paperclip button or drag-and-drop
  - **Images** (JPEG, PNG, GIF, WebP): Sent natively to Claude via vision API (base64 content blocks) — previewed as thumbnails in chat
  - **PDFs**: Sent natively to Claude via document API (base64 document blocks) — no text extraction needed
  - **Documents** (DOCX, EPUB, MOBI, TXT, MD, HTML, CSV, JSON, XML, code files, config files, Excel): Text extracted client-side via `/upload/extract-text` endpoint, content prepended to message
  - **Non-vision images** (SVG, BMP, TIFF, HEIC, AVIF): Treated as documents, text extracted where possible
- Attached files shown as chips with extraction progress, thumbnails (for images), char count, and error states
- User message bubbles display file names as styled chips, not the full extracted text

### 8. Landing Page Generation

**5-Phase Pipeline** (LP Gen component):
1. **Copy Generation** (Claude Sonnet) — Generate landing page copy sections from foundational docs + swipe page reference (URL or PDF)
2. **Design Analysis** (Claude Sonnet) — Analyze swipe page screenshot/PDF for design direction, color scheme, typography
3. **HTML Generation** (Claude Sonnet) — Generate responsive HTML template with image placeholders and CTA placeholders
4. **CTA Link Editor** — User configures button URLs and text for each CTA slot in the generated HTML
5. **Publishing** — Deploy to Cloudflare Pages via Direct Upload API, slug management, publish/unpublish flow

**Swipe Page Input** (primary: URL, secondary: PDF):
- **URL input**: User enters a swipe page URL → Puppeteer headless browser fetches the page, extracts text content and captures a full-page screenshot → text used for copy generation, screenshot used for design analysis
- **PDF upload**: User uploads a PDF via drag-and-drop or file picker → PDF text extracted via pdf-parse, PDF sent as native document block for design analysis
- URL and PDF are mutually exclusive — entering one clears the other

**Key Features**:
- Split-panel editor: copy sections on left, live HTML preview on right
- Image slot detection and management (placeholder images auto-generated)
- CTA link editing with URL validation
- Version snapshots saved before each publish
- Slug conflict detection across project landing pages
- Image optimization via sharp (resize + JPEG compression) before deployment

---

## Routes Reference

### Auth
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/auth/session` | Check auth status + setup completion + user info (role, displayName) |
| POST | `/api/auth/setup` | First-run admin account creation (only when 0 users exist) |
| POST | `/api/auth/login` | Multi-user login from users table (rate-limited: 5/min) |
| POST | `/api/auth/logout` | Destroy session |
| PUT | `/api/auth/password` | Change own password (any authenticated user) |

### Users (Admin Only)
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/users` | List all users (excludes password_hash) |
| POST | `/api/users` | Create user (username, display_name, password, role) |
| PUT | `/api/users/:id` | Update user (display_name, role, is_active) |
| PUT | `/api/users/:id/reset-password` | Admin resets user's password |
| DELETE | `/api/users/:id` | Delete user (cannot delete self) |

### Projects
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/projects` | List all with stats (doc count, ad count) |
| POST | `/api/projects` | Create project |
| GET | `/api/projects/:id` | Get with stats + resolved image URL |
| PUT | `/api/projects/:id` | Update fields |
| DELETE | `/api/projects/:id` | Delete project + all associated data |
| POST | `/api/projects/:id/product-image` | Upload/replace product image (multipart) |
| DELETE | `/api/projects/:id/product-image` | Remove product image |

### Documents
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/projects/:id/docs` | List docs (grouped by type, latest version) + step info |
| GET | `/api/projects/:id/research-prompts` | Get 3 pre-populated research prompts (manual flow) |
| POST | `/api/projects/:id/generate-docs` | Generate all docs (SSE stream) |
| POST | `/api/projects/:id/generate-doc/:type` | Regenerate single doc type (SSE stream) |
| POST | `/api/projects/:id/generate-docs-manual` | Synthesize from manual research (SSE stream) |
| POST | `/api/projects/:id/upload-docs` | Bulk upload existing docs |
| PUT | `/api/projects/:id/docs/:docId` | Update doc content |
| PUT | `/api/projects/:id/docs/:docId/approve` | Toggle approval status |
| POST | `/api/projects/:id/correct-docs` | AI-analyze docs and propose corrections |
| POST | `/api/projects/:id/apply-corrections` | Apply selected corrections + log to history |
| GET | `/api/projects/:id/correction-history` | Get changelog of corrections + reverts |
| POST | `/api/projects/:id/revert-correction` | Revert correction to before-state |

### Ads
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/projects/:id/ads` | List all ads with resolved image URLs + source quote text |
| GET | `/api/projects/:id/ads/in-progress` | Get in-progress ads (queue restoration) |
| GET | `/api/projects/:id/ads/:adId` | Get single ad |
| POST | `/api/projects/:id/generate-ad` | Generate ad — Mode 1 or Mode 2 (SSE stream) |
| POST | `/api/projects/:id/regenerate-image` | Regenerate image only (SSE stream) |
| POST | `/api/projects/:id/edit-prompt` | NLP edit to image prompt (with optional reference image) |
| POST | `/api/projects/:id/generate-angle` | Generate random angle from docs |
| POST | `/api/projects/:id/generate-headline` | Generate headline from angle + docs |
| POST | `/api/projects/:id/generate-body-copy` | Generate body copy from headline + quote context |
| PATCH | `/api/projects/:id/ads/:adId/tags` | Update ad tags |
| PATCH | `/api/projects/:id/ads/:adId/favorite` | Toggle favorite |
| GET | `/api/projects/:id/ads/:adId/image` | Redirect to Convex storage URL |
| GET | `/api/projects/:id/ads/:adId/thumbnail` | Serve 400px JPEG thumbnail (disk cached) |
| DELETE | `/api/projects/:id/ads/:adId` | Delete ad + remove from storage |

### Batches
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/projects/:id/batches` | List all batch jobs |
| POST | `/api/projects/:id/batches` | Create batch (optional schedule, optional immediate run) |
| GET | `/api/projects/:id/batches/:batchId` | Get single batch |
| PUT | `/api/projects/:id/batches/:batchId` | Update config (schedule, cron, angle, size, aspect ratio) |
| DELETE | `/api/projects/:id/batches/:batchId` | Delete/cancel batch |
| POST | `/api/projects/:id/batches/:batchId/run` | Manually trigger batch |
| POST | `/api/projects/:id/batches/:batchId/cancel` | Cancel active batch |

### Quote Mining & Quote Bank
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/projects/:id/quote-mining` | List past mining runs |
| GET | `/api/projects/:id/quote-mining/:runId` | Get single run with full results |
| POST | `/api/projects/:id/quote-mining/suggestions` | Auto-suggest keywords, subreddits, forums |
| POST | `/api/projects/:id/quote-mining` | Start new mining run (SSE stream) |
| DELETE | `/api/projects/:id/quote-mining/:runId` | Delete mining run |
| POST | `/api/projects/:id/quote-mining/:runId/headlines` | Generate headlines from run (SSE stream) |
| POST | `/api/projects/:id/quote-mining/:runId/add-to-bank` | Import run quotes to quote bank |
| POST | `/api/projects/:id/quote-mining/import-all` | Import all runs to quote bank |
| GET | `/api/projects/:id/quote-bank` | List quotes with filters |
| GET | `/api/projects/:id/quote-bank/usage` | Get usage stats |
| PATCH | `/api/projects/:id/quote-bank/:quoteId` | Update quote (content, emotion, tags) |
| PATCH | `/api/projects/:id/quote-bank/:quoteId/favorite` | Toggle favorite |
| PATCH | `/api/projects/:id/quote-bank/:quoteId/tags` | Update tags |
| DELETE | `/api/projects/:id/quote-bank/:quoteId` | Delete quote |
| POST | `/api/projects/:id/quote-bank/headlines` | Generate headlines from multiple quotes (SSE stream) |
| POST | `/api/projects/:id/quote-bank/:quoteId/generate-more-headlines` | Generate more headlines for single quote (SSE stream) |
| POST | `/api/projects/:id/quote-bank/:quoteId/body-copy` | Generate body copy from quote + headline |
| POST | `/api/projects/:id/quote-bank/bulk-update` | Bulk update quotes |
| POST | `/api/projects/:id/quote-bank/backfill-problems` | Fill in missing problem field from run context |

### Copywriter Chat
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/projects/:id/chat/thread` | Get active thread + messages |
| POST | `/api/projects/:id/chat/send` | Send message (with optional images/PDFs) and stream Claude response (SSE) |
| POST | `/api/projects/:id/chat/clear` | Clear chat history |

### Landing Pages
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/projects/:id/landing-pages` | List all landing pages for project |
| POST | `/api/projects/:id/landing-pages` | Create new landing page |
| GET | `/api/projects/:id/landing-pages/:pageId` | Get single landing page |
| PUT | `/api/projects/:id/landing-pages/:pageId` | Update landing page fields |
| DELETE | `/api/projects/:id/landing-pages/:pageId` | Delete landing page |
| POST | `/api/projects/:id/landing-pages/:pageId/generate-copy` | Generate copy sections (SSE stream) |
| POST | `/api/projects/:id/landing-pages/:pageId/generate-design` | Generate design analysis (SSE stream) |
| POST | `/api/projects/:id/landing-pages/:pageId/generate-html` | Generate HTML template (SSE stream) |
| POST | `/api/projects/:id/landing-pages/:pageId/publish` | Publish to Cloudflare Pages |
| POST | `/api/projects/:id/landing-pages/:pageId/unpublish` | Remove from Cloudflare Pages |

### Costs
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/costs` | System-wide cost summary (today/week/month by service + operation) |
| GET | `/api/costs/history` | Daily cost history (configurable days, optional project filter) |
| GET | `/api/costs/recurring` | Estimated daily cost from scheduled batches |
| GET | `/api/costs/rates` | Current Gemini per-image rates + last-updated timestamp |
| GET | `/api/projects/:id/costs` | Project-scoped costs + cost per ad |
| POST | `/api/costs/sync` | Manual trigger for OpenAI billing API sync |

### Deployments (Ad Pipeline)
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/deployments` | List deployments (optional `?projectId=` filter, excludes soft-deleted) |
| POST | `/api/deployments` | Bulk create deployments from ad IDs |
| PUT | `/api/deployments/:id` | Update deployment fields |
| PUT | `/api/deployments/:id/status` | Update deployment status (poster can mark as posted) |
| DELETE | `/api/deployments/:id` | Soft-delete deployment |
| POST | `/api/deployments/:id/restore` | Restore soft-deleted deployment |
| POST | `/api/deployments/rename-all` | Batch rename deployments |
| POST | `/api/deployments/backfill-headlines` | Backfill headlines from ads |
| GET | `/api/projects/:id/campaigns` | List campaigns for project |
| POST | `/api/projects/:id/campaigns` | Create campaign |
| PUT | `/api/projects/:id/campaigns/:campaignId` | Update campaign |
| DELETE | `/api/projects/:id/campaigns/:campaignId` | Delete campaign |
| GET | `/api/projects/:id/campaigns/:campaignId/adsets` | List ad sets |
| POST | `/api/projects/:id/campaigns/:campaignId/adsets` | Create ad set |
| PUT | `/api/projects/:id/adsets/:adsetId` | Update ad set |
| DELETE | `/api/projects/:id/adsets/:adsetId` | Delete ad set |
| POST | `/api/projects/:id/adsets/:adsetId/flex-ads` | Create flex ad |
| PUT | `/api/projects/:id/flex-ads/:flexAdId` | Update flex ad |
| DELETE | `/api/projects/:id/flex-ads/:flexAdId` | Soft-delete flex ad |
| POST | `/api/projects/:id/flex-ads/:flexAdId/restore` | Restore soft-deleted flex ad |
| POST | `/api/projects/:id/flex-ads/:flexAdId/generate` | Generate deployments for flex ad from selected ads |

### Meta Ads Integration
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/meta/callback` | OAuth callback (projectId in state param) |
| GET | `/api/projects/:id/meta/auth-url` | Get OAuth URL for project |
| GET | `/api/projects/:id/meta/status` | Connection status |
| POST | `/api/projects/:id/meta/disconnect` | Clear Meta fields |
| POST | `/api/projects/:id/meta/ad-account` | Select Meta ad account |
| GET | `/api/projects/:id/meta/ad-accounts` | List available ad accounts |
| GET | `/api/projects/:id/meta/campaigns` | List campaigns |
| GET | `/api/projects/:id/meta/campaigns/:campaignId/adsets` | List ad sets |
| GET | `/api/projects/:id/meta/adsets/:adsetId/ads` | List ads |
| POST | `/api/projects/:id/meta/link` | Link deployment to Meta ad |
| POST | `/api/projects/:id/meta/unlink` | Unlink deployment from Meta ad |
| GET | `/api/projects/:id/meta/performance/:deploymentId` | Get performance data |
| GET | `/api/projects/:id/meta/performance/summary` | Aggregated performance summary |
| POST | `/api/projects/:id/meta/sync` | Manual Meta performance sync |

### Settings
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/settings` | Get all settings (masks sensitive keys) |
| PUT | `/api/settings` | Update settings (API keys, rates) |
| GET | `/api/settings/headline-references` | Get 3 headline reference docs |
| PUT | `/api/settings/headline-references/:docKey` | Upload/replace headline reference doc |
| DELETE | `/api/settings/headline-references/:docKey` | Delete headline reference doc |
| GET | `/api/settings/todos` | Get dashboard roadmap todos |
| PUT | `/api/settings/todos` | Save roadmap todos |
| POST | `/api/settings/test-openai` | Test OpenAI connection |
| POST | `/api/settings/test-gemini` | Test Gemini connection |
| POST | `/api/settings/test-drive` | Test Google Drive connection |
| POST | `/api/settings/test-perplexity` | Test Perplexity connection |
| POST | `/api/settings/test-anthropic` | Test Anthropic connection |
| POST | `/api/settings/refresh-gemini-rates` | Manually refresh Gemini rates |

### Templates
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/projects/:id/templates` | List uploaded templates |
| POST | `/api/projects/:id/templates` | Upload template image |
| PUT | `/api/projects/:id/templates/:imageId` | Update template description |
| DELETE | `/api/projects/:id/templates/:imageId` | Delete template |
| POST | `/api/projects/:id/templates/:imageId/analyze` | AI analyze template visual style |

### Inspiration
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/projects/:id/inspiration` | List Drive-synced inspiration images |
| POST | `/api/projects/:id/inspiration/sync` | Sync folder with Drive (dedup guard) |

### Drive
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/drive/status` | Check if Drive is configured |
| POST | `/api/drive/upload-service-account` | Upload service account JSON |
| POST | `/api/drive/test` | Test Drive connection |
| GET | `/api/drive/folders` | List Drive folders (optional `?parentId=` for browsing) |
| GET | `/api/drive/folders/:folderId` | Get folder info |

### Upload & Extract
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/upload/extract-text` | Extract text from PDF/DOCX/EPUB/MOBI/Excel/Markdown/HTML/code/config files |
| POST | `/api/upload/auto-describe` | Auto-generate product description from sales page |

### Health
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/health` | Health check (status: ok) |

---

## Frontend Routes

| Path | Page | Roles | Description |
|------|------|-------|-------------|
| `/login` | Login | — | Multi-user auth + first-run admin setup |
| `/` | Dashboard | Admin, Manager | Cost cards, bar chart, recurring estimates, image rates, roadmap |
| `/projects` | Projects | All | Project grid with stats (poster can't create projects) |
| `/projects/new` | ProjectSetup | Admin, Manager | New project wizard |
| `/projects/:id` | ProjectDetail | All | Tabbed hub — tabs filtered by role (see below) |
| `/settings` | Settings | Admin | API keys, Drive, rates, headline references, Meta setup, User Management |

### ProjectDetail Tabs

| Tab ID | Label | Component | Roles | Description |
|--------|-------|-----------|-------|-------------|
| `quotes` | Copywriter | QuoteMiner + CopywriterChat | Admin, Manager | Mine quotes, generate headlines, chat with AI copywriter |
| `ads` | Ad Studio | AdStudio + BatchManager | Admin, Manager | Generate ads, manage batches, ad gallery |
| `tracker` | Ad Pipeline | AdTracker | All | Ad deployment pipeline: Planner → Ready to Post → Posted (poster sees Ready to Post + Posted only) |
| `lp` | LP Gen | LPGen | Admin, Manager | Landing page generation, editing, publishing |
| `overview` | Overview | (inline) | Admin, Manager | Project settings, cost tracking, product image, Drive folders |
| `docs` | Foundational Docs | FoundationalDocs | Admin, Manager | Core research docs, correction history |
| `templates` | Template Library | TemplateImages + InspirationFolder | Admin, Manager | Reference images from Drive or uploaded |

---

## Deployment

### How to Deploy

**Frontend + backend** (from local machine):
```bash
VPS_HOST=76.13.183.219 bash deploy/deploy.sh
```
This rsyncs the project → runs `npm install` → builds frontend with Vite → restarts PM2.

**Convex functions** (must run FROM the VPS because Convex auth is stored there):
```bash
ssh root@76.13.183.219 "cd /opt/ad-platform && npx convex deploy -y"
```

**Important**: `deploy.sh` does NOT deploy Convex. Any schema or function changes require the separate Convex deploy command above. This is a common gotcha — if you add a new field to the schema, you must deploy Convex separately.

**Important**: `package.json` is excluded from rsync. If you add a new dependency, SSH in and run `npm install` manually, or temporarily adjust the deploy script.

### VPS Details
- **IP**: 76.13.183.219
- **OS**: Ubuntu (Node 22 LTS)
- **App path**: `/opt/ad-platform`
- **Process**: PM2 (`ad-platform`, single instance, 512MB max)
- **Logs**: `/opt/ad-platform/logs/` (PM2 managed)
- **Nginx**: Reverse proxy on port 443 → localhost:3001
- **SSL**: Let's Encrypt via Certbot

### PM2 Config (`deploy/ecosystem.config.cjs`)
```javascript
{
  name: 'ad-platform',
  script: 'server.js',
  cwd: '/opt/ad-platform/backend',
  instances: 1,
  autorestart: true,
  max_memory_restart: '512M',
  env: { NODE_ENV: 'production', PORT: 3001, CONVEX_URL: 'https://energized-hare-760.convex.cloud' }
}
```

---

## Settings & Secrets

**Stored in Convex `settings` table** (NOT in .env):
- `openai_api_key` — OpenAI API key
- `openai_admin_key` — OpenAI Organization Costs API key (for billing sync)
- `gemini_api_key` — Google Gemini API key
- `perplexity_api_key` — Perplexity Sonar Pro API key
- `anthropic_api_key` — Anthropic Claude API key
- `gemini_rate_1k`, `gemini_rate_2k`, `gemini_rate_4k` — Image generation rates by resolution
- `gemini_rates_updated_at` — Timestamp of last Gemini rate scrape
- `auth_username`, `auth_password_hash` — Legacy login credentials (migrated to `users` table on first multi-user start, kept for reference)
- `session_secret` — Auto-generated session encryption key
- `default_drive_folder_id` — Default Google Drive output folder
- `cloudflare_account_id` — Cloudflare account ID for Pages deployment
- `cloudflare_api_token` — Cloudflare API token for Pages deployment
- `cloudflare_pages_projects` — JSON array mapping project IDs to Cloudflare Pages project names
- `headline_ref_engine`, `headline_ref_greatest`, `headline_ref_swipe` — 3 headline reference docs
- `meta_oauth_state` — CSRF state for Meta OAuth

**On disk (gitignored)**:
- `config/service-account.json` — Google Drive service account (uploaded via Settings UI)

**Environment variables** (PM2 config):
- `NODE_ENV`, `PORT`, `CONVEX_URL` — That's it. Everything else lives in Convex.

---

## Key Technical Decisions

1. **Convex over SQLite**: Migrated from SQLite to Convex for cloud-hosted persistence, file storage, and deployment simplicity. The `convexClient.js` wrapper provides backward-compatible async helpers. Foreign keys still use UUID `externalId` strings rather than Convex native `_id`.

2. **SSE over WebSockets**: Server-Sent Events are used for all streaming (doc generation, ad generation, quote mining, headline generation, chat) because they're simpler, work through Nginx, and the data flow is server-to-client only.

3. **Gemini Batch API for batches**: Batch jobs use Gemini's async batch API rather than sequential calls. This is more cost-effective and avoids rate limits. The scheduler polls for results every 5 minutes.

4. **Session-based auth (not JWT)**: Sessions are simpler and stored server-side with Convex-backed persistence via custom `ConvexSessionStore`. Sessions survive server restarts (no more in-memory MemoryStore).

5. **No global state library**: React hooks + prop drilling + context (for toasts and auth only). The app's state is largely server-driven — most components fetch on mount and re-render.

6. **Image storage in Convex, not disk**: Generated images are stored in Convex blob storage and served via pre-signed CDN URLs. Thumbnails are disk-cached locally for performance.

7. **Cost tracking 4-service**: Gemini costs calculated immediately (rate × count). OpenAI synced hourly from billing API. Anthropic and Perplexity calculated from response token counts. Dashboard shows all services with operation-level breakdowns.

8. **Product image hierarchy**: Project-level product image auto-injects into all generations. Per-ad or per-batch uploads override it. This avoids re-uploading the same product photo for every ad.

9. **2-message GPT flow**: Ad generation uses exactly 2 GPT-5.2 messages — Message 1 sends foundational docs + brand context, Message 2 sends the image via vision API. Optional Message 3 (Headline Juicer) refines using headline references. This is the minimal token-efficient flow.

10. **Rate limiter for GPT-5.2**: An AsyncSemaphore-based concurrency limiter (`rateLimiter.js`) prevents 429 errors by limiting concurrent GPT-5.2 calls to 2 at a time with a 2-second minimum gap. All heavy GPT calls go through `withGptRateLimit()`.

11. **Per-project Meta Ads**: Each project has its own Meta OAuth token, app credentials, and ad account selection. This enables multi-client use without credential collisions.

12. **Quote bank denormalization**: Quotes imported to quote bank denormalize the `problem` field from the run for efficient filtering. Headlines stored as JSON arrays per quote.

13. **4-stage batch pipeline**: Batch jobs process in 4 stages (brief → headlines → body copies → image prompts) before Gemini submission. This allows the pipeline to fail/resume at any stage and generates richer ad metadata.

14. **Correction history in Convex settings**: Correction history (with before/after snapshots) is stored as a JSON array in Convex settings. When exceeding size limit, older entries are trimmed.

15. **Thumbnail disk cache (fire-and-forget)**: Backend generates thumbnails on-demand, caches them locally at `.thumb-cache/{adId}.jpg`, but doesn't block the response. Fallback redirects to full Convex image.

16. **Dashboard todos in dedicated table**: Migrated from `settings.dashboard_todos` JSON string to a dedicated `dashboard_todos` Convex table for better querying and atomic updates. Supports optional priority (1-4) for auto-sorting.

17. **Chat multimodal attachments**: Three-path file handling: (1) Images (JPEG/PNG/GIF/WebP) are sent natively to Claude via vision API as base64 content blocks — no text extraction needed. (2) PDFs are sent natively via Claude's document API as base64 document blocks. (3) All other documents (DOCX, EPUB, Excel, code files, etc.) are extracted to text client-side via `/upload/extract-text` and prepended to the message string. Backend `chat.js` builds multimodal content blocks for the last user message. Supports both paperclip button and drag-and-drop.

18. **Landing page publishing via Cloudflare Pages Direct Upload**: Landing pages are deployed as self-contained HTML files with co-deployed optimized images. Each publish creates a version snapshot. Images are processed via sharp (resize + JPEG compression) before upload.

19. **LP Gen URL-based swipe input with Puppeteer**: Landing page generation uses Puppeteer headless browser to fetch swipe page content from a URL — extracting text and capturing a full-page screenshot. The screenshot is sent to Claude for design analysis while the text is used for copy generation. PDF upload is supported as an alternative, with the PDF sent as a native document block for design analysis. This replaced the original PDF-only approach for better UX.

20. **Multi-user with role-based access**: Three roles (Admin, Manager, Poster) with route-level and UI-level enforcement. Admin: full access including Settings and User Management. Manager: all project features but no Settings. Poster: only sees Ad Pipeline tab (Ready to Post + Posted sub-tabs), can mark ads as posted but cannot access Planner, send back ads, create projects, or access Dashboard/Settings. Backend uses `requireRole()` middleware factory. Frontend filters nav links, project tabs, and action buttons by role.

21. **Convex-backed session store**: Custom `ConvexSessionStore` class extends `express-session.Store` with `get/set/destroy` methods backed by Convex `sessions` table. Automatically cleans expired sessions every hour. Eliminates the MemoryStore warning and ensures sessions persist across PM2 restarts and deploys.

22. **Auto-migration from single-user to multi-user**: On server start, `migrateToMultiUser()` checks if the `users` table is empty. If so, reads legacy `auth_username` + `auth_password_hash` from Convex settings and creates an admin user. This ensures zero-downtime upgrade — the existing admin can log in immediately after the code deploys.

23. **Ad Pipeline hierarchy (campaigns → ad sets → flex ads)**: The Planner view uses a 3-level hierarchy: campaigns contain ad sets, ad sets contain flex ads (multi-image ad groups). Flex ads have `child_deployment_ids` linking to individual deployments. This models Meta Ads structure for organized ad planning before posting.

24. **Soft-delete for deployments and flex ads**: Deployments and flex ads use `deleted_at` timestamp for soft deletion rather than hard delete. This allows restore functionality and prevents accidental data loss. Queries filter out soft-deleted items by default.

---

## Gotchas & Edge Cases

- **Convex client retry**: All Convex operations retry up to 3 times with exponential backoff. If you see transient errors in logs, they're likely self-healing.
- **Convex deploy is separate**: `deploy.sh` only deploys backend + frontend. Schema/function changes require `ssh root@76.13.183.219 "cd /opt/ad-platform && npx convex deploy -y"` separately. Forgetting this is the #1 cause of "field not saving" bugs.
- **OpenAI 429 "quota exceeded"**: The current OpenAI account hits 429 errors on nearly every first attempt. The retry system handles this (retries after 15s+ backoff), but generation takes longer than expected (~50s per ad).
- **Gemini 400 INVALID_ARGUMENT**: Sometimes transient (capacity issues). The retry predicate treats these as retryable.
- **Gemini rate scraping**: Rates are scraped from Google's pricing page daily at midnight. If the page format changes, rates will stale but won't break — they fall back to the last known value in settings.
- **Drive upload disabled in batches**: Service account Drive uploads hit quota limits during batch jobs. Batch-generated ads are stored in Convex only.
- **Thumbnail cache**: Lives in `backend/.thumb-cache/`. 400px JPEG, 80% quality. Fire-and-forget write — if it fails, the full image is served.
- **SSE abort cleanup**: Frontend uses AbortController for SSE streams. Backend may continue processing after abort. Results are still saved.
- **Multi-angle batches**: The `angles` field is a JSON-serialized array. Each ad is randomly assigned one of the angles.
- **Template rotation**: Batch jobs track `used_template_ids` (JSON array) to avoid reusing the same template across consecutive runs. Resets when all templates have been used.
- **Deep research timeout**: o3-deep-research runs with a 30-minute timeout. Falls back gracefully on timeout.
- **50MB JSON body limit**: Express is configured with `express.json({ limit: '50mb' })` for large sales page content and research outputs.
- **Inspiration image dedup**: `create` mutation checks for existing `drive_file_id` before inserting. A `dedup` mutation also exists for cleaning up historical duplicates.
- **Quote bank dedup**: `quoteDedup.js` deduplicates quotes using Levenshtein distance before adding to quote bank.
- **Meta token expiry**: Meta access tokens expire ~60 days. The scheduler auto-refreshes tokens before expiry. If expired, user must reconnect in project settings.
- **React falsy number rendering**: When using `&&` for conditional rendering, always use `!!value &&` or `value > 0 &&` for numeric fields to avoid rendering `0` as text. The `batch.scheduled` field (stored as 0/1) is an example of this gotcha.
- **`convexBatchToRow` mapper**: The `convexClient.js` mapper converts boolean `scheduled` from Convex to `1`/`0` integers. Frontend code must handle this with `!!batch.scheduled` not bare `batch.scheduled` in JSX.
- **Batch pipeline polling**: Scheduler polls every 5 minutes. Batches in `generating_prompts` or `submitting` status don't have a `gemini_batch_job` yet — `pollBatchJob` correctly returns `'processing'` for these (not `'failed'`).
- **Dashboard todos migration**: Todos were migrated from `settings.dashboard_todos` (JSON string) to a dedicated `dashboard_todos` Convex table. The old settings key may still exist but is no longer read.
- **LP Gen HTML generation**: Claude sometimes generates HTML with markdown code fences (```html...```). The `lpGenerator.js` service strips these automatically before saving.
- **VPS dependency installation**: `package.json` is excluded from rsync in `deploy.sh`. New npm dependencies (e.g., `puppeteer`, `xlsx`) must be installed manually on the VPS via SSH: `ssh root@76.13.183.219 "cd /opt/ad-platform/backend && npm install <package>"` then restart PM2.
- **Puppeteer on VPS**: Puppeteer requires Chromium. On first install, it downloads ~300MB of Chromium. If disk space is low, use `PUPPETEER_SKIP_DOWNLOAD=true` and install system Chromium separately.
- **Chat multimodal content blocks**: The chat backend builds multimodal content blocks only for the current (last) user message. Previous messages in the conversation history are stored as text-only (with `[filename]` markers for images). This means Claude can only "see" images/PDFs from the current message, not from earlier in the thread.
- **Session store migration**: Sessions moved from in-memory `MemoryStore` to Convex-backed `ConvexSessionStore`. All existing sessions are lost on first deploy (one-time reset). After upgrade, sessions persist across PM2 restarts.
- **Multi-user migration**: `migrateToMultiUser()` runs on every server start. It's idempotent — only creates admin user if `users` table is empty. Legacy `auth_username`/`auth_password_hash` settings are preserved but no longer read after migration.
- **Poster role restrictions**: Poster users can only access the `tracker` tab (Ad Pipeline) within projects. They see Ready to Post + Posted sub-tabs (not Planner). They can mark ads as posted but cannot send ads back to Planner. Backend enforces this via `requireRole('admin', 'manager')` on write routes.
- **Soft-deleted deployments**: Deployments use `deleted_at` for soft delete. All GET queries filter out soft-deleted items. The restore endpoint clears `deleted_at` to undelete.
- **Ad Pipeline terminology**: The deployment tracking tab was renamed from "Performance Tracker" to "Ad Pipeline". The first sub-tab was renamed from "Campaigns" to "Planner". Status labels use "Ready to Post" / "Posted" (not "scheduled"/"posted").

---

## Naming Conventions

- **Files**: camelCase for JS/JSX (`adGenerator.js`, `CostSummaryCards.jsx`), snake_case for Convex schema tables and fields (`ad_creatives`, `project_id`, `batch_jobs`)
- **Components**: PascalCase React components (`AdStudio`, `BatchManager`, `QuoteMiner`)
- **Routes**: RESTful with nested resources (`/api/projects/:id/ads/:adId`)
- **Convex functions**: camelCase exports (`getByProject`, `getAllWithStats`)
- **CSS**: Tailwind utility-first, custom classes use kebab-case (`glass-nav`, `btn-primary`, `input-apple`)
- **State variables**: camelCase (`productImageUploading`, `expandedCards`, `editingId`)
- **Database IDs**: UUID v4 strings as `externalId`, used for all cross-table references
- **LLM operations**: snake_case in cost tracking (`ad_angle_generation`, `copy_correction`, `brief_extraction`, `quote_mining`, `headline_generation`)

---

## What's Built & Production

- Multi-user auth system with role-based access (Admin/Manager/Poster), Convex-backed sessions, auto-migration from legacy single-user
- Project CRUD with product image management
- 8-step foundational document generation pipeline (with deep research)
- Copy correction (AI-powered fact-checking with before/after history + reversion)
- Manual research flow (bypass generation, paste your own research)
- Document versioning and approval status
- Document upload (bypass generation entirely)
- Quote mining (dual-engine: Perplexity Sonar Pro + Claude Opus 4.6 web search)
- Auto-suggest for mining parameters (subreddits, forums, Facebook groups)
- Quote bank with tagging, favorites, per-quote headlines, Notion-style filtering
- Headline generation (Claude Sonnet 4.6 + 3 reference copywriting docs)
- Body copy generation from headlines + quote context
- Copywriter Chat widget (Claude Sonnet 4.6, foundational docs as context, multimodal attachments: images via vision API, PDFs via document API, documents via text extraction, drag-and-drop)
- Single ad generation (Mode 1: direct inspiration, Mode 2: template)
- Headline Juicer (optional 3rd GPT message using headline reference docs)
- Prompt editing (NLP-based + direct edit + vision-guided with reference images)
- Prompt guidelines (project-level, auto-checked via GPT-4.1-mini)
- Batch job system with Gemini Batch API (4-stage pipeline with step indicators)
- Cron-scheduled recurring batches (every hour / 6h / 12h / daily / weekdays / weekly / monthly / custom)
- Template image management (upload + Drive sync + AI visual analysis)
- Multi-template and multi-inspiration selection for batches
- Template rotation (avoids reuse across consecutive batch runs)
- Inspiration folder syncing (Drive-based reference images with dedup)
- Google Drive integration (service account auth, folder browsing, auto-upload)
- Cost tracking dashboard (4 services: Gemini, OpenAI, Anthropic, Perplexity)
- Per-service, per-operation cost breakdowns (today/week/month)
- 30-day stacked cost history bar chart
- Recurring automation cost estimates
- Dashboard Gemini per-image rates display (manual + batch with 50% discount)
- Project-level product image (auto-injected into all generations, per-ad override)
- Ad gallery (grid + list view, timestamps, tag management, favorites, source quotes)
- Multi-select bulk actions (download ZIP, delete, deploy, bulk tag)
- Ad Pipeline with 3-level Planner hierarchy (campaigns → ad sets → flex ads)
- Ad deployment tracking (Planner → Ready to Post → Posted) with soft-delete and restore
- Side-by-side Ready to Post view with ad preview and deployment details
- Flex ads (multi-image ad groups with shared copy, CTA, Facebook Page settings)
- Display link, Facebook Page, Posted By fields on deployments
- User Management card in Settings (admin: create users, assign roles, reset passwords, deactivate)
- Per-project Meta Ads integration (OAuth, campaign/adset/ad browsing, performance sync)
- Meta performance data (impressions, clicks, spend, CPC, CPM, ROAS)
- Headline reference document uploads (3 docs: Headline Engine, 100 Greatest, 349 Swipe File)
- File upload with text extraction (PDF, DOCX, EPUB, MOBI, Excel, Markdown, HTML, CSV, JSON, XML, code files, config files)
- GPT rate limiter (AsyncSemaphore concurrency control for 429 prevention)
- Dynamic time estimates in generation queue (based on queue position)
- Dashboard roadmap with inline edit, P1–P4 priority badges (auto-sorted)
- Batch execution timing (started_at → completed_at, displays "Completed in Xm Ys")
- Batch auto-retry (up to 3 retries on failure)
- Lazy-loaded pages (React.lazy + Suspense)
- Landing page generation (5-phase: copy → design → HTML → CTAs → publish to Cloudflare Pages)
- Landing page swipe input via URL (Puppeteer headless browser) or PDF drag-and-drop
- Landing page split-panel editor with live HTML preview
- Landing page CTA link editor with URL validation
- Landing page publishing to Cloudflare Pages (Direct Upload API)
- Navy-gold-teal design system (migrated from Apple/macOS blue palette)
- Dacia Fixer (Recursive Agent #1): automated batch testing, self-healing, and batch resurrection
- Dacia Creative Filter (Recursive Agent #2): batch ad scoring, flex ad grouping, auto-deployment to Ready to Post

---

## Dacia Recursive Agents

Autonomous agent systems that monitor, maintain, and heal the platform.

### Agent #1: Dacia Fixer
- **Location:** `/dacia-fixer`
- **Role:** Auto-test, self-heal code, resurrect failed batches
- **Schedule:** Every 5 minutes via cron
- **Budget:** $40/month hard cap
- **Config:** `dacia-fixer/config/fixer.conf`
- **Commands:** `./dacia-fixer/fixer.sh [--daemon|--status|--resurrect]`
- **Models:** Gemini Flash (diagnosis), Claude Sonnet (fixes)
- **Logs:** `dacia-fixer/logs/`

When working on Dacia Fixer:
- Keep agent prompts focused to minimize token costs
- Test changes: `./dacia-fixer/fixer.sh batch_creation`
- New suites go in fixer.conf (suite name, test_cmd, context files)
- Do not remove the daily budget cap

### Agent #2: Dacia Creative Filter
- **Location:** `/dacia-creative-filter`
- **Role:** Score batch ads (Sonnet 4.6), group into flex ads, deploy to Ready to Post
- **Schedule:** Every 30 minutes via cron (processes completed batches)
- **Budget:** $31/month (~$1.04/batch of 50 ads)
- **Config:** `dacia-creative-filter/config/filter.conf`
- **Commands:** `./dacia-creative-filter/filter.sh [--daemon|--status|--dry-run]`
- **Model:** Claude Sonnet 4.6 (scoring + grouping + regeneration + validation)
- **Logs:** `dacia-creative-filter/logs/`
- **Per-project config required:** scout_default_campaign, scout_cta, scout_display_link, scout_facebook_page
- **Output:** 2 flex ads x 10 images x 3-5 headlines x 3-5 primary texts each, deployed to Ready to Post
- **Minimum to execute:** 3 headlines + 3 primary texts per flex ad (target: 5 each)
- **Regeneration:** If batch copy isn't good enough, Sonnet generates new headlines/texts until minimums met (max 3 rounds)
- **Guarantee:** Flex ads always complete — never skipped

When working on Creative Filter:
- Do not remove the daily budget cap
- Do not auto-post to Meta — only deploy to Ready to Post status
- Tag rejected ads as "Filter Rejected" and winners as "Filter Approved"
- Each batch creates a NEW ad set: "[Brand] Filter - YYYY-MM-DD"
- Flex ads must have exactly 10 images each with shared headlines + primary texts
- Mock external calls in any tests to avoid LLM costs
- Per-project settings are in the Overview tab under "Creative Filter"

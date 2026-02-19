# Ad Creative Automation Platform — CLAUDE.md

> Context file for Claude Code threads. Read this before making any changes.

## What This Is

A single-tenant web application for direct response copywriters and e-commerce brands. It automates two core workflows:

1. **Foundational Document Generation** — An 8-step research pipeline (based on the Mark Builds Brands SOP) that uses GPT-4.1 and o3-deep-research to produce customer avatars, offer briefs, and belief documents from a product's sales page.
2. **Static Image Ad Generation** — Uses GPT-5.2 as a creative director (2-message conversation flow) and Google Gemini 3 Pro Image ("Nano Banana Pro") to generate ad creatives, either one at a time or in automated batches on a cron schedule.

**Live at**: `daciaautomation.com` (VPS: `76.13.183.219`)
**Convex deployment**: `prod:strong-civet-577` at `https://energized-hare-760.convex.cloud`
**GitHub**: `daciaventures/ad-platform`

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | React 18 + Vite 5.4 + Tailwind CSS 3.4 + React Router 6 |
| Backend | Node.js + Express 4.21 |
| Database | Convex (cloud-hosted, schema-enforced) |
| File Storage | Convex blob storage (images, templates, product photos) |
| LLM (text) | OpenAI — GPT-5.2 (creative direction), GPT-4.1 (research/synthesis), GPT-4.1-mini (prompt review/editing), o3-deep-research (web research) |
| LLM (images) | Google Gemini 3 Pro Image Preview via `@google/genai` SDK |
| External | Google Drive API v3 (service account auth) for inspiration sync + ad upload |
| Auth | bcrypt + express-session (single shared account, not multi-user) |
| Scheduling | node-cron for recurring batch jobs |
| Process Manager | PM2 (production) |
| Reverse Proxy | Nginx with Let's Encrypt SSL |

---

## Directory Structure

```
ad-platform/
├── backend/
│   ├── server.js                    # Express entry point (port 3001)
│   ├── auth.js                      # requireAuth middleware + isSetupComplete
│   ├── convexClient.js              # Convex HTTP client with retry wrapper (40+ helpers)
│   ├── routes/
│   │   ├── auth.js                  # Login/setup/session (rate-limited)
│   │   ├── projects.js              # CRUD + product image upload (multer)
│   │   ├── documents.js             # Foundational doc generation (SSE streaming)
│   │   ├── ads.js                   # Ad generation + prompt editing + tagging (SSE streaming)
│   │   ├── batches.js               # Batch job CRUD + scheduling
│   │   ├── costs.js                 # Cost aggregation (today/week/month)
│   │   ├── drive.js                 # Google Drive sync + folder browsing
│   │   ├── templates.js             # Template image management
│   │   ├── upload.js                # File upload + text extraction (PDF, DOCX, EPUB, MOBI, Markdown, HTML)
│   │   ├── settings.js              # API keys, rates, app config
│   │   └── deployments.js           # Ad deployment tracking (Meta/Facebook pipeline)
│   └── services/
│       ├── openai.js                # GPT-5.2, GPT-4.1, GPT-4.1-mini, o3-deep-research wrappers
│       ├── gemini.js                # Nano Banana Pro image generation
│       ├── docGenerator.js          # 8-step foundational doc pipeline
│       ├── adGenerator.js           # Ad generation orchestrator (Mode 1 + Mode 2)
│       ├── batchProcessor.js        # Two-phase batch execution (GPT prompts → Gemini batch API)
│       ├── costTracker.js           # Gemini cost logging + OpenAI billing sync
│       ├── scheduler.js             # Cron registration, batch polling, rate refresh
│       ├── retry.js                 # Exponential backoff utility (5 retries, 429-aware)
│       └── rateLimiter.js           # GPT rate limiter (AsyncSemaphore, concurrency=2, 2s gap)
│
├── frontend/
│   ├── src/
│   │   ├── App.jsx                  # Router + ProtectedRoute wrapper
│   │   ├── main.jsx                 # React entry (BrowserRouter)
│   │   ├── api.js                   # Fetch wrapper + SSE streaming helpers
│   │   ├── index.css                # Tailwind layers + custom component classes
│   │   ├── pages/
│   │   │   ├── Login.jsx            # Auth + first-run setup
│   │   │   ├── Dashboard.jsx        # Cost cards + bar chart + recurring cost estimates + roadmap
│   │   │   ├── Projects.jsx         # Project grid with stats
│   │   │   ├── ProjectSetup.jsx     # New project wizard
│   │   │   ├── ProjectDetail.jsx    # Tabbed project hub (Overview, Docs, Templates, Ad Studio)
│   │   │   ├── Settings.jsx         # API keys, Drive, rates, password
│   │   │   └── AdTracker.jsx        # Ad deployment tracking (Meta/Facebook pipeline)
│   │   └── components/
│   │       ├── Layout.jsx           # Glass navbar + segmented control navigation
│   │       ├── AdStudio.jsx         # Full ad generation UI + gallery with tags, bulk actions, list view
│   │       ├── BatchManager.jsx     # Batch job management (~1700 lines)
│   │       ├── FoundationalDocs.jsx # Doc generation with SSE progress
│   │       ├── TemplateImages.jsx   # Template upload/management + Drive sync
│   │       ├── InspirationFolder.jsx # Drive inspiration image sync
│   │       ├── CostSummaryCards.jsx # Dashboard cost widgets (chevron-expandable details)
│   │       ├── CostBarChart.jsx     # 30-day stacked bar chart (SVG)
│   │       ├── DragDropUpload.jsx   # Reusable file upload component
│   │       ├── DriveFolderPicker.jsx # Drive folder browser modal
│   │       ├── Toast.jsx            # Toast notification context + component
│   │       └── InfoTooltip.jsx      # Pure CSS hover tooltip
│   ├── vite.config.js               # Dev proxy → localhost:3001
│   ├── tailwind.config.js           # Apple font stack, custom shadows/radii
│   └── package.json
│
├── convex/
│   ├── schema.ts                    # Full database schema (8 tables)
│   ├── settings.ts                  # Key-value settings queries/mutations
│   ├── projects.ts                  # Projects with stats aggregation
│   ├── foundational_docs.ts         # Docs CRUD with versioning
│   ├── ad_creatives.ts              # Ad CRUD with storage URL resolution
│   ├── batch_jobs.ts                # Batch job state machine
│   ├── api_costs.ts                 # Cost logging + aggregation
│   ├── ad_deployments.ts            # Deployment tracking (Meta/Facebook pipeline)
│   ├── template_images.ts           # Template storage management
│   ├── inspiration_images.ts        # Drive-synced inspiration images (dedup guard on create)
│   └── fileStorage.ts               # Storage URL generation helpers
│
├── deploy/
│   ├── deploy.sh                    # Rsync + npm install + vite build + PM2 restart
│   ├── setup.sh                     # VPS initial setup (Node 22, PM2, Nginx, Certbot, UFW)
│   ├── ecosystem.config.cjs         # PM2 config (production env vars)
│   └── nginx.conf                   # Reverse proxy + SSL + caching + gzip
│
└── .gitignore
```

---

## Database Schema (Convex)

All tables live in Convex cloud. Schema is enforced via `convex/schema.ts`.

| Table | Purpose | Key Fields |
|-------|---------|------------|
| `settings` | App config (key-value) | `key`, `value` |
| `projects` | Products/brands being advertised | `externalId`, `name`, `brand_name`, `niche`, `product_description`, `sales_page_content`, `drive_folder_id`, `inspiration_folder_id`, `prompt_guidelines`, `product_image_storageId` |
| `foundational_docs` | Generated research docs | `project_id` → projects.externalId, `doc_type` (research/avatar/offer_brief/necessary_beliefs), `content`, `version`, `approved`, `source` |
| `ad_creatives` | Generated ads | `project_id`, `generation_mode`, `angle`, `headline`, `body_copy`, `image_prompt`, `gpt_creative_output`, `storageId`, `drive_file_id`, `drive_url`, `status`, `auto_generated`, `parent_ad_id`, `tags` (optional string array) |
| `batch_jobs` | Scheduled + on-demand batches | `project_id`, `batch_size`, `angle`, `angles` (JSON), `aspect_ratio`, `template_image_id`, `template_image_ids`, `inspiration_image_ids`, `product_image_storageId`, `gemini_batch_job`, `gpt_prompts` (JSON), `status`, `scheduled`, `schedule_cron`, `completed_count`, `failed_count`, `run_count`, `used_template_ids` |
| `api_costs` | Cost tracking per operation | `service` (gemini/openai), `operation`, `cost_usd`, `image_count`, `source` (calculated/billing_api), `period_date` |
| `template_images` | Uploaded ad templates | `project_id`, `filename`, `storageId`, `description` |
| `inspiration_images` | Drive-synced reference images | `project_id`, `drive_file_id`, `filename`, `storageId` |
| `ad_deployments` | Ad deployment tracking | `ad_id` → ad_creatives.externalId, `project_id`, `status` (selected/scheduled/posted/analyzing), `campaign_name`, `ad_set_name`, `ad_name`, `landing_page_url`, `notes`, `planned_date`, `posted_date` |

**Important**: Foreign keys use `externalId` (UUID strings), not Convex `_id`. The `externalId` pattern was carried over from the SQLite-to-Convex migration. All cross-table references use `project_id` → `projects.externalId`.

---

## Architecture Patterns

### Backend

- **Express middleware stack**: compression → helmet (CSP off) → CORS → JSON parser (50MB limit) → sessions → routes
- **Authentication**: Single shared account. Session-based via `req.session.authenticated`. Rate-limited login (5/min). Bcrypt with 12 salt rounds. Session secret auto-generated and stored in Convex settings.
- **Convex client**: `convexClient.js` wraps `ConvexHttpClient` with auto-retry (3 retries, exponential backoff). Provides 40+ helper functions matching the old SQLite API for drop-in replacement.
- **SSE streaming**: Doc generation and ad generation stream progress events to the frontend via Server-Sent Events. Pattern: `res.writeHead(200, { 'Content-Type': 'text/event-stream' })` then `res.write(`data: ${JSON.stringify(event)}\n\n`)`.
- **File uploads**: Multer saves to temp dir → uploaded to Convex storage → temp file deleted. Product images, templates, and inspiration images all stored in Convex.
- **Retry utility**: `withRetry(fn, options)` in `services/retry.js` — 5 retries, exponential backoff with jitter, rate-limit-aware (15s base delay for 429 errors), Retry-After header support, 120s max delay.
- **Rate limiter**: `withGptRateLimit(fn, label)` in `services/rateLimiter.js` — AsyncSemaphore-based concurrency limiter (concurrency=2, 2s minimum gap between calls). Wraps all GPT-5.2 calls to prevent 429 errors from concurrent ad generations.

### Frontend

- **State management**: React hooks only (useState, useEffect, useRef, useCallback). No Redux or external state library. ToastContext for global notifications.
- **API layer**: `api.js` exports a single `api` object with methods for every endpoint. `request()` is the base fetch wrapper (auto-redirects to /login on 401). `streamSSE()` and `streamSSEWithBody()` handle Server-Sent Events.
- **Routing**: React Router 6 with `ProtectedRoute` wrapper that checks `api.getSession()` before rendering.
- **Component pattern**: Pages are in `pages/`, reusable UI in `components/`. Large features (AdStudio, BatchManager, FoundationalDocs) are single-file components with extensive local state.
- **Form pattern**: Controlled inputs with spread-operator state updates: `setForm(prev => ({ ...prev, field: value }))`.
- **Debounced auto-save**: Prompt guidelines use 1.5s debounce with useRef timer.

### Styling

- **Design language**: macOS / Apple-inspired. Frosted glass navbar, rounded cards with subtle shadows, SF Pro font stack.
- **Tailwind CSS 3.4** with custom component layer (`@layer components` in `index.css`):
  - `.glass-nav` — Frosted glass navbar (backdrop-filter blur + saturation)
  - `.card` — White/80 bg, backdrop-blur, rounded-2xl, subtle multi-layer shadow
  - `.btn-primary` — Blue gradient (#007AFF), shadow, hover lift
  - `.btn-secondary` — Gray ghost button
  - `.input-apple` — Rounded input with blue focus ring
  - `.segmented-control` — Tab group with active pill
  - `.badge` — Inline pill
  - `.info-tooltip` — Pure CSS hover tooltip (dark bg)
- **Custom Tailwind config** (`tailwind.config.js`):
  - Font: `-apple-system, BlinkMacSystemFont, "SF Pro Display"...`
  - Border radius: xl=12px, 2xl=16px, 3xl=20px
  - Box shadows: apple-sm through apple-xl (soft, layered)
- **Animations**: `fade-in` (0.3s ease-out), `animate-slide-up` (0.25s toast animation)
- **Scrollbar**: Custom thin scrollbar via `.scrollbar-thin` class
- **Text sizes**: Compact UI density using `text-[10px]` through `text-[15px]`

---

## Key Data Flows

### Foundational Document Generation
```
Sales page → GPT-4.1 analysis → Research methodology → o3-deep-research (web browsing)
→ GPT-4.1 synthesizes: Avatar Sheet, Offer Brief, Necessary Beliefs
→ 4 versioned docs stored in Convex, streamable via SSE
```

### Single Ad Generation (Mode 1 — Direct)
```
User picks angle + aspect ratio
→ Message 1: GPT-5.2 creative director receives all 4 foundational docs + brand context
→ Message 2: GPT-5.2 receives inspiration image (+ optional product image) via vision API
→ Returns detailed image prompt
→ Optional: review against prompt guidelines (GPT-4.1-mini)
→ Gemini 3 Pro generates image (+ optional product image input)
→ Upload to Convex storage → Create ad_creative record → Log Gemini cost
```

### Single Ad Generation (Mode 2 — Template)
```
Same as Mode 1, but GPT-5.2 receives a template image instead of a random inspiration image
→ Prompt is tailored to match the template's visual style
```

### Batch Job Execution
```
Phase 1: Generate N GPT-5.2 prompts (sequential, rate-limited via AsyncSemaphore)
Phase 2: Submit all to Gemini Batch API (async, returns batch job name)
Scheduler polls every 5 min → On completion: create ad_creatives, log costs
Status: pending → generating_prompts → submitting → processing → completed/failed
```

### Cost Tracking
```
Gemini: Immediately logged after each generation (rate from settings)
OpenAI: Hourly sync from Organization Costs API (billing_api source)
Dashboard: Aggregated by today/week/month, broken down by service and operation
```

### Project-Level Product Image
```
Upload on project Overview → stored as product_image_storageId in Convex
→ Auto-injected into all ad generations (single + batch) for that project
→ Per-ad or per-batch uploads override the project image
→ Green indicator in AdStudio/BatchManager shows "Project product image active"
```

### Ad Deployment Tracking
```
Select ads in gallery → "Deploy" button creates ad_deployment records
→ AdTracker page shows pipeline: Selected → Scheduled → Posted → Analyzing
→ Track campaign names, ad set names, landing pages, dates, notes
```

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
  env: { NODE_ENV: 'production', PORT: 3001, CONVEX_URL: 'https://energized-hare-760.convex.cloud' }
}
```

---

## Settings & Secrets

**Stored in Convex `settings` table** (NOT in .env):
- `openai_api_key` — OpenAI API key
- `openai_admin_key` — OpenAI Organization Costs API key (for billing sync)
- `gemini_api_key` — Google Gemini API key
- `gemini_rate_1k`, `gemini_rate_2k`, `gemini_rate_4k` — Image generation rates by resolution
- `auth_username`, `auth_password_hash` — Login credentials (hash is bcrypt)
- `session_secret` — Auto-generated session encryption key
- `default_drive_folder_id` — Default Google Drive output folder
- `dashboard_todos` — JSON array of roadmap to-do items

**On disk (gitignored)**:
- `config/service-account.json` — Google Drive service account (uploaded via Settings UI)

**Environment variables** (PM2 config):
- `NODE_ENV`, `PORT`, `CONVEX_URL` — That's it. Everything else lives in Convex.

---

## Key Technical Decisions

1. **Convex over SQLite**: Migrated from SQLite to Convex for cloud-hosted persistence, file storage, and deployment simplicity. The `convexClient.js` wrapper provides backward-compatible async helpers. Foreign keys still use UUID `externalId` strings rather than Convex native `_id`.

2. **SSE over WebSockets**: Server-Sent Events are used for all streaming (doc generation, ad generation) because they're simpler, work through Nginx, and the data flow is server-to-client only.

3. **Gemini Batch API for batches**: Batch jobs use Gemini's async batch API rather than sequential calls. This is more cost-effective and avoids rate limits. The scheduler polls for results every 5 minutes.

4. **Session-based auth (not JWT)**: Single-user app doesn't need token-based auth. Sessions are simpler and stored server-side with Convex-backed persistence.

5. **No global state library**: React hooks + prop drilling + context (for toasts only). The app's state is largely server-driven — most components fetch on mount and re-render.

6. **Image storage in Convex, not disk**: Generated images are stored in Convex blob storage and served via pre-signed CDN URLs. Thumbnails are disk-cached locally for performance.

7. **Cost tracking dual-mode**: Gemini costs are calculated immediately (rate x count). OpenAI costs are synced hourly from the billing API for accuracy. Dashboard shows both with operation-level breakdowns.

8. **Product image hierarchy**: Project-level product image auto-injects into all generations. Per-ad or per-batch uploads override it. This avoids re-uploading the same product photo for every ad.

9. **2-message GPT flow**: Ad generation uses exactly 2 GPT-5.2 messages — Message 1 sends foundational docs + brand context, Message 2 sends the image via vision API. This is the minimal token-efficient flow. No 3rd refinement message.

10. **Rate limiter for GPT-5.2**: An AsyncSemaphore-based concurrency limiter (`rateLimiter.js`) prevents 429 errors by limiting concurrent GPT-5.2 calls to 2 at a time with a 2-second minimum gap between calls. All heavy GPT calls go through `withGptRateLimit()`.

---

## Gotchas & Edge Cases

- **Convex client retry**: All Convex operations retry up to 3 times with exponential backoff. If you see transient errors in logs, they're likely self-healing.
- **Convex deploy is separate**: `deploy.sh` only deploys backend + frontend. Schema/function changes require `ssh root@76.13.183.219 "cd /opt/ad-platform && npx convex deploy -y"` separately. Forgetting this is the #1 cause of "field not saving" bugs.
- **OpenAI 429 "quota exceeded"**: The current OpenAI account hits 429 errors on nearly every first attempt. The retry system handles this (retries after 15s+ backoff), but generation takes longer than expected (~50s per ad). Check OpenAI billing dashboard if this worsens.
- **Gemini 400 INVALID_ARGUMENT**: Sometimes transient (capacity issues). The retry predicate treats these as retryable.
- **Gemini rate scraping**: Rates are scraped from Google's pricing page daily at midnight. If the page format changes, rates will stale but won't break — they fall back to the last known value in settings.
- **Drive upload disabled in batches**: Service account Drive uploads hit quota limits during batch jobs. Batch-generated ads are stored in Convex only (not auto-uploaded to Drive).
- **Thumbnail cache**: Lives in `backend/.thumb-cache/`. 400px JPEG, 80% quality. Cache key is `{adId}.jpg`. Fire-and-forget write — if it fails, the full image is served instead.
- **SSE abort cleanup**: Frontend uses AbortController for SSE streams. If the user navigates away mid-generation, the abort signal cancels the fetch but the backend may continue processing. Generation results are still saved.
- **Multi-angle batches**: The `angles` field is a JSON-serialized array. A batch with 10 items and 3 angles generates 10 ads, each randomly assigned one of the 3 angles.
- **Template rotation**: Batch jobs track `used_template_ids` (JSON array) to avoid reusing the same template across consecutive runs. When all templates have been used, the list resets.
- **Deep research timeout**: o3-deep-research runs in the background with a 30-minute timeout. The frontend polls for status via SSE events. If it times out, the doc generation falls back gracefully.
- **50MB JSON body limit**: Express is configured with `express.json({ limit: '50mb' })` for large sales page content and research outputs.
- **Inspiration image dedup**: The `create` mutation in `inspirationImages.ts` checks for existing `drive_file_id` before inserting. Prevents duplicates from concurrent syncs (auto-sync on page load + manual "Sync Now"). A `dedup` mutation also exists for cleaning up historical duplicates.

---

## Naming Conventions

- **Files**: camelCase for JS/JSX (`adGenerator.js`, `CostSummaryCards.jsx`), snake_case for Convex schema tables and fields (`ad_creatives`, `project_id`, `batch_jobs`)
- **Components**: PascalCase React components (`AdStudio`, `BatchManager`, `DriveFolderPicker`)
- **Routes**: RESTful with nested resources (`/api/projects/:projectId/ads/:adId`)
- **Convex functions**: camelCase exports (`getByProject`, `getAllWithStats`)
- **CSS**: Tailwind utility-first, custom classes use kebab-case (`glass-nav`, `btn-primary`, `input-apple`)
- **State variables**: camelCase (`productImageUploading`, `expandedCards`, `editingId`)
- **Database IDs**: UUID v4 strings as `externalId`, used for all cross-table references

---

## Routes Reference

### Auth
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/auth/session` | Check auth status + setup completion |
| POST | `/api/auth/setup` | First-run account creation |
| POST | `/api/auth/login` | Login (rate-limited: 5/min) |
| POST | `/api/auth/logout` | Destroy session |
| PUT | `/api/auth/password` | Change password |

### Projects
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/projects` | List all with stats |
| POST | `/api/projects` | Create project |
| GET | `/api/projects/:id` | Get with stats + resolved image URL |
| PUT | `/api/projects/:id` | Update fields |
| DELETE | `/api/projects/:id` | Delete project + associated data |
| POST | `/api/projects/:id/product-image` | Upload product image (multipart) |
| DELETE | `/api/projects/:id/product-image` | Remove product image |

### Documents
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/projects/:id/docs` | List docs (grouped by type, latest version) |
| POST | `/api/projects/:id/generate-docs` | Generate all docs (SSE stream) |
| PUT | `/api/projects/:id/docs/:docId` | Update/approve document |
| DELETE | `/api/projects/:id/docs/:docId` | Delete document |

### Ads
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/projects/:id/ads` | List ads with image URLs |
| POST | `/api/projects/:id/generate-ad` | Generate ad (SSE stream) |
| POST | `/api/projects/:id/regenerate-image` | Regenerate image only |
| POST | `/api/projects/:id/edit-prompt` | NLP edit to image prompt (with optional reference image) |
| DELETE | `/api/projects/:id/ads/:adId` | Delete ad |
| PATCH | `/api/projects/:id/ads/:adId/tags` | Update ad tags |

### Batches
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/projects/:id/batches` | List batch jobs |
| POST | `/api/projects/:id/batches` | Create batch (immediate or scheduled) |
| PUT | `/api/projects/:id/batches/:batchId` | Update config/schedule |
| DELETE | `/api/projects/:id/batches/:batchId` | Delete/cancel batch |
| POST | `/api/projects/:id/batches/:batchId/run` | Manually trigger batch |
| POST | `/api/projects/:id/batches/:batchId/cancel` | Cancel active batch |

### Deployments
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/deployments` | List deployments (optional `?projectId=` filter) |
| POST | `/api/deployments` | Bulk create deployments from ad IDs |
| PUT | `/api/deployments/:id` | Update deployment fields |
| PUT | `/api/deployments/:id/status` | Update deployment status |
| DELETE | `/api/deployments/:id` | Remove deployment |

### Costs
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/costs` | System-wide cost summary |
| GET | `/api/costs/history` | Daily cost history (configurable days) |
| GET | `/api/costs/recurring` | Estimated daily cost from scheduled batches |
| GET | `/api/projects/:id/costs` | Project-scoped costs |

### Settings
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/settings` | Get all (masks sensitive keys) |
| PUT | `/api/settings` | Update settings |
| GET | `/api/settings/todos` | Get roadmap todos |
| PUT | `/api/settings/todos` | Save roadmap todos |

---

## Frontend Routes

| Path | Page | Description |
|------|------|-------------|
| `/login` | Login | Auth + first-run setup |
| `/` | Dashboard | Cost cards, bar chart, recurring cost estimates, roadmap |
| `/projects` | Projects | Project grid |
| `/projects/new` | ProjectSetup | New project wizard |
| `/projects/:id` | ProjectDetail | Tabbed project hub |
| `/projects/:id/tracker` | AdTracker | Ad deployment tracking pipeline |
| `/settings` | Settings | API keys, Drive, rates |

---

## What's Built & Production

- Full auth system (login, setup, session management)
- Project CRUD with product image management
- 8-step foundational document generation pipeline
- Single ad generation (Mode 1: Direct, Mode 2: Template)
- 2-message GPT-5.2 creative director flow (foundational docs → image analysis)
- Prompt editing (NLP-based + direct edit + vision-guided with reference images)
- Prompt guidelines review (GPT-4.1-mini auto-check)
- Batch job system with Gemini Batch API
- Cron-scheduled recurring batches
- Google Drive integration (inspiration sync, folder browsing)
- Template image management (upload + Drive sync)
- Cost tracking dashboard (per-service, per-operation breakdown)
- 30-day cost history bar chart
- Recurring automation cost estimates
- Inspiration image dedup guard (prevents duplicates from concurrent Drive syncs)
- Dashboard roadmap with inline edit
- Project-level product image (auto-injected, per-ad override)
- Ad gallery with grid + list view, timestamps, tag management
- Multi-select bulk actions: download ZIP, delete, deploy, bulk tag
- Copy correction feature for foundational docs
- Deep research mode (o3-deep-research with web browsing)
- Manual research workflow (paste your own research)
- File upload with text extraction (PDF, DOCX, EPUB, MOBI, Markdown, HTML)
- Ad deployment tracking pipeline (selected → scheduled → posted → analyzing)
- GPT rate limiter (AsyncSemaphore concurrency control for 429 prevention)
- Dynamic time estimates in generation queue based on queue position

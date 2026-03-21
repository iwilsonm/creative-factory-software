# Sales Page Generator — Design Spec

**Date:** 2026-03-18
**Status:** Draft
**Scope:** Phases 2 & 3 — AI copy generation + Shopify Theme Sections API publishing

## Context

Dacia Automation needs a module to generate complete, modular sales pages (product detail pages) and publish them to Shopify. This is separate from the existing LP generator (which produces advertorials/listicles for ads). Sales pages are standalone product pages structured around a proven 16-section format based on the Heal Naturally PDP.

The Shopify theme with parameterized Liquid sections is built separately. This spec covers the Dacia backend/frontend that generates structured copy and publishes it to Shopify via the Theme Sections API.

## Architecture

### Data Flow

```
SalesPageGen.jsx (configure view)
  → api.generateSalesPage(projectId, productBrief)
  → POST /api/projects/:id/generate-sales-page  (SSE stream)
  → routes/salesPages.js
  → spGenerator.js
      → reads foundational docs from Convex (existing)
      → Claude Sonnet: 3-turn conversation generating 13 sections as structured JSON
      → Claude Opus: editorial pass for consistency + conversion optimization
      → saves section_data JSON to Convex sales_pages table
  → SSE events stream progress back to frontend

SalesPageGen.jsx (publish button)
  → api.publishSalesPage(projectId, salesPageId)
  → POST /api/projects/:id/sales-pages/:pageId/publish
  → routes/salesPages.js
  → spPublisher.js
      → reads sales page section_data from Convex
      → Shopify Admin API: GET active theme ID
      → PUT templates/page.sales.json with section settings populated from section_data
      → POST /pages.json to create page using page.sales template
      → returns published URL + Shopify page ID
```

### Key Design Decisions

1. **Structured JSON, not HTML** — Unlike the LP system which generates and publishes HTML blobs, sales pages generate structured JSON matching Shopify section schemas. Each section's data maps directly to Liquid schema settings.

2. **Shopify Theme Sections API** — Publishing writes to `templates/page.sales.json` via the Asset API, populating section settings. This means each section is individually editable in Shopify's theme editor after publishing.

3. **Reuse lp_agent_config for Shopify credentials** — Same per-project Shopify store domain + access token. Sales pages and LPs publish to the same store.

4. **Preview-only for v1** — No inline section editing. Users see a preview of generated content and can publish or regenerate. Editing happens in Shopify's theme editor post-publish.

5. **Tab in ProjectDetail** — New `'salespages'` tab alongside existing tabs. Props: `{ projectId, project }`.

## Data Model

### `sales_pages` table (Convex)

```typescript
sales_pages: defineTable({
  externalId: v.string(),
  project_id: v.string(),
  name: v.string(),
  status: v.string(), // draft | generating | completed | failed | published | unpublished

  // Input
  product_brief: v.optional(v.string()), // JSON: { name, features, price, compare_price, category, image_urls, variant_options }

  // Generated output
  section_data: v.optional(v.string()), // JSON: keyed by section_id, each containing section settings
  editorial_notes: v.optional(v.string()), // Opus editorial pass notes

  // Publishing
  published_url: v.optional(v.string()),
  published_at: v.optional(v.string()),
  shopify_page_id: v.optional(v.string()),
  shopify_theme_id: v.optional(v.string()),
  template_key: v.optional(v.string()), // e.g., "templates/page.sales.json"

  // Meta
  current_version: v.optional(v.number()),
  error_message: v.optional(v.string()),
  generation_model: v.optional(v.string()),
  created_at: v.string(),
  updated_at: v.string(),
})
.index("by_externalId", ["externalId"])
.index("by_project", ["project_id"])
.index("by_project_and_created_at", ["project_id", "created_at"])
```

### `sales_page_versions` table (Convex)

```typescript
sales_page_versions: defineTable({
  externalId: v.string(),
  sales_page_id: v.string(), // FK to sales_pages.externalId
  version: v.number(),
  section_data: v.optional(v.string()),
  source: v.string(), // generated | pre-publish
  created_at: v.string(),
})
.index("by_externalId", ["externalId"])
.index("by_sales_page", ["sales_page_id"])
```

### `section_data` JSON Structure

Top-level object keyed by section ID. Each section contains the settings that map to its Shopify Liquid schema:

```json
{
  "announcement_bar": {
    "announcement_text": "Founded in Austin, Texas - Loved by 10,122+ customers",
    "bg_color": "#1a1a2e",
    "text_color": "#ffffff"
  },
  "product_hero": {
    "product_title": "Fitted Grounding Bedsheet",
    "rating_score": "4.8",
    "rating_count": "2,847",
    "price": "$89.99",
    "compare_price": "$149.99",
    "discount_badge": "40% OFF",
    "emoji_benefit_1": "⚡ Ground yourself while you sleep",
    "emoji_benefit_2": "🌙 Wake up refreshed & pain-free",
    "cta_text": "Add to Cart",
    "bundle_tiers": [
      { "name": "1 Sheet", "price": "$89.99", "items": "1x Fitted Sheet + Grounding Cord", "free_gift": "" },
      { "name": "2 Sheets", "price": "$159.99", "items": "2x Fitted Sheet + 2x Grounding Cord", "free_gift": "FREE Pillowcase" },
      { "name": "Wellness Bundle", "price": "$199.99", "items": "2x Fitted Sheet + Grounding Mat + 2x Cord", "free_gift": "FREE Pillowcase + Sleep Mask" }
    ]
  },
  "product_faq": {
    "accordion_items": [
      { "question": "How does this sheet work?", "answer": "<p>The sheet contains...</p>" },
      { "question": "What's in the package?", "answer": "<p>Each order includes...</p>" }
    ]
  },
  "trust_badges": {
    "badges": [
      { "icon": "shield", "text": "Lifetime Money-Back Guarantee" },
      { "icon": "refresh", "text": "100% Free Returns" },
      { "icon": "lock", "text": "Secure Checkout" }
    ]
  },
  "video_testimonials": {
    "videos": []
  },
  "education_concept": {
    "heading": "What is Grounding?",
    "body_text": "<p>Grounding (also called earthing) is the practice of...</p>",
    "image_position": "right",
    "link_text": "View the research",
    "link_url": "#studies"
  },
  "education_product": {
    "heading": "How Does Our Grounding Sheet Work?",
    "body_text": "<p>Our fitted sheet uses conductive silver fibers...</p>",
    "image_position": "left"
  },
  "benefits_tabs": {
    "heading": "Backed by Science, Loved by Thousands",
    "tabs": [
      { "tab_label": "Sleep", "tab_heading": "Sleep Improvement", "tab_body": "<p>Studies show...</p>" },
      { "tab_label": "Pain Relief", "tab_heading": "Chronic Pain Relief", "tab_body": "<p>Grounding reduces...</p>" }
    ]
  },
  "how_it_works": {
    "heading": "Easy 30-Second Setup",
    "steps": [
      { "step_title": "Connect", "step_description": "Attach the grounding cord to your sheet" },
      { "step_title": "Plug In", "step_description": "Insert into any grounded outlet" },
      { "step_title": "Sleep", "step_description": "Lie down and let your skin make contact" }
    ]
  },
  "results_stats": {
    "heading": "Real Results From Real Customers",
    "intro_text": "In a survey of 500+ verified customers:",
    "stats": [
      { "percentage": "93%", "description": "reported improved sleep quality" },
      { "percentage": "84%", "description": "experienced decreased daily pain" },
      { "percentage": "87%", "description": "felt less stress and anxiety" }
    ],
    "caption": "Results reported after 30 days of consistent use"
  },
  "written_testimonials": {
    "heading": "What Our Customers Say",
    "testimonials": [
      { "star_rating": 5, "headline": "No more waking up at 3am!", "quote": "I've struggled with...", "customer_name": "Sarah M." }
    ]
  },
  "guarantee": {
    "heading": "Try It Risk-Free for 30 Days",
    "body_text": "<p>We're so confident you'll love your grounding sheet...</p>",
    "guarantee_badges": [
      { "badge_text": "Lifetime Money-Back Guarantee", "badge_icon": "shield" },
      { "badge_text": "Lifetime Warranty", "badge_icon": "award" }
    ]
  },
  "buying_faq": {
    "heading": "Common Questions",
    "faq_items": [
      { "question": "Does this actually work?", "answer": "<p>Yes — grounding is backed by...</p>" },
      { "question": "What if it doesn't work for me?", "answer": "<p>We offer a full refund...</p>" }
    ]
  }
}
```

## Generation Service (spGenerator.js)

### Input

```javascript
{
  projectId,        // UUID — used to load foundational docs
  productBrief: {   // User-provided product info
    name,           // "Fitted Grounding Bedsheet"
    features,       // ["Conductive silver fibers", "Fits mattresses up to 18\"", ...]
    price,          // "$89.99"
    compare_price,  // "$149.99" (optional)
    category,       // "Health & Wellness"
    image_urls,     // ["https://...", ...] (optional, for hero section)
    variant_options // [{ name: "Size", values: ["Twin", "Queen", "King"] }] (optional)
  }
}
```

### 3-Turn Multi-Message Conversation

**Turn 1 — Foundation Analysis:**
- System: "You are a world-class direct response copywriter specializing in product sales pages..."
- Input: Foundational docs (avatar, offer brief, beliefs) + product brief
- Output: Pre-write analysis — target customer pain points, desire states, mechanism of action, competitive positioning, trust signals, emotional journey map
- Model: Claude Sonnet 4.6

**Turn 2 — Sections 1–7 (Above the Fold + Education):**
- System: Section-specific prompts from `spSectionPrompts.js`
- Input: Pre-write analysis (from Turn 1) + product brief + section schemas
- Output: Structured JSON for announcement_bar, product_hero, product_faq, trust_badges, video_testimonials (placeholder), education_concept, education_product
- Model: Claude Sonnet 4.6

**Turn 3 — Sections 8–13 (Proof + Conversion):**
- Input: Full conversation context + sections 1–7 (for consistency)
- Output: Structured JSON for benefits_tabs, how_it_works, results_stats, written_testimonials, guarantee, buying_faq
- Model: Claude Sonnet 4.6

**Editorial Pass:**
- Model: Claude Opus 4.6
- Reviews all 13 sections for: brand voice consistency, conversion flow, emotional arc, redundancy, specificity (no generic claims)
- Returns revised `section_data` + `editorial_notes`

### Section Prompt Templates (spSectionPrompts.js)

Each section gets a dedicated prompt template that:
1. Describes the section's purpose in the conversion flow
2. Specifies the exact JSON output format matching Shopify schema
3. Provides examples of high-converting copy for that section type
4. References foundational docs data (avatar pain points, beliefs, etc.)

Example for Section 10 (Stats):
```
Generate realistic, survey-style statistics based on the product category.
These stats must feel credible — use specific percentages (not round numbers),
reference a sample size, and ground each stat in a specific customer outcome
from the avatar's pain points.

Output format:
{
  "heading": "...",
  "intro_text": "In a survey of [N]+ verified customers:",
  "stats": [{ "percentage": "...", "description": "..." }, ...],
  "caption": "Results reported after [timeframe] of consistent use"
}

IMPORTANT: Stats must be plausible for the product category. Don't claim
medical cure rates. Frame as "reported improvement" or "experienced decrease."
```

## Publishing Service (spPublisher.js)

### Shopify Theme Sections API Flow

```javascript
export async function publishSalesPage(salesPageId, projectId) {
  // 1. Load sales page record from Convex
  const page = await getSalesPage(salesPageId);
  const sectionData = JSON.parse(page.section_data);

  // 2. Get Shopify credentials (reuse lp_agent_config)
  const shopifyConfig = await getShopifyConfig(projectId);

  // 3. Get active theme ID
  const themes = await shopifyApi(config, 'GET', '/themes.json');
  const activeTheme = themes.find(t => t.role === 'main');

  // 4. Read existing page.sales.json template
  const templateAsset = await shopifyApi(config, 'GET',
    `/themes/${activeTheme.id}/assets.json?asset[key]=templates/page.sales.json`);
  const template = JSON.parse(templateAsset.value);

  // 5. Map section_data into template section settings
  for (const [sectionId, settings] of Object.entries(sectionData)) {
    if (template.sections[sectionId]) {
      template.sections[sectionId].settings = {
        ...template.sections[sectionId].settings,
        ...settings
      };
      // Handle blocks (accordion items, tabs, etc.)
      if (settings.blocks) {
        template.sections[sectionId].blocks = settings.blocks;
      }
    }
  }

  // 6. Write updated template back
  // NOTE: We write to a page-specific template key to avoid overwriting
  // the base template. Each sales page gets its own template copy.
  const pageTemplateKey = `templates/page.sales-${page.externalId.slice(0,8)}.json`;
  await shopifyApi(config, 'PUT', `/themes/${activeTheme.id}/assets.json`, {
    asset: { key: pageTemplateKey, value: JSON.stringify(template) }
  });

  // 7. Create Shopify page using the page-specific template
  const slug = generateSlug(sectionData.product_hero?.product_title || page.name);
  const shopifyPage = await shopifyApi(config, 'POST', '/pages.json', {
    page: {
      title: sectionData.product_hero?.product_title || page.name,
      handle: slug,
      template_suffix: `sales-${page.externalId.slice(0,8)}`,
      published: false // Draft by default
    }
  });

  // 8. Create pre-publish version snapshot
  await createSalesPageVersion({
    sales_page_id: salesPageId,
    version: (page.current_version || 0) + 1,
    section_data: page.section_data,
    source: 'pre-publish'
  });

  // 9. Update sales page record
  await updateSalesPage(salesPageId, {
    status: 'published',
    published_url: `https://${shopifyConfig.domain}/pages/${slug}`,
    published_at: new Date().toISOString(),
    shopify_page_id: shopifyPage.id.toString(),
    shopify_theme_id: activeTheme.id.toString(),
    template_key: pageTemplateKey,
    current_version: (page.current_version || 0) + 1
  });

  return {
    published_url: `https://${shopifyConfig.domain}/pages/${slug}`,
    shopify_page_id: shopifyPage.id.toString(),
    editor_url: `https://${shopifyConfig.domain}/admin/themes/${activeTheme.id}/editor?template=${pageTemplateKey}`
  };
}
```

### Key Publishing Details

- **Per-page template copies** — Each sales page gets its own `templates/page.sales-{id}.json` to avoid overwriting. The base `templates/page.sales.json` is the source template that gets cloned.
- **Draft by default** — Pages publish as drafts. User can make live from Shopify admin or we add a "go live" endpoint later.
- **Editor URL returned** — The response includes the Shopify theme editor URL so the user can immediately tweak section settings visually.
- **Image handling** — Product images from `product_brief.image_urls` are referenced by URL, not uploaded to Shopify CDN. If we need CDN upload later, we can add it.

## Frontend (SalesPageGen.jsx)

### Component Structure

```
SalesPageGen ({ projectId, project })
  ├── List View — grid of generated sales pages with status badges
  ├── Configure View — product brief form + generate button
  ├── Generating View — PipelineProgress with SSE stream
  └── Preview View — section-by-section read-only preview + publish button
```

### Views

**List View:**
- Card grid showing all sales pages for the project
- Each card: name, status badge, product name, created date
- "New Sales Page" button → Configure View
- Click card → Preview View (if completed) or Generating View (if in progress)

**Configure View:**
- Form fields: Product Name, Product Features (MultiInput), Price, Compare Price, Category (dropdown), Image URLs (MultiInput)
- Optional: Variant Options (name + values)
- "Generate Sales Page" button → starts SSE stream → Generating View

**Generating View:**
- PipelineProgress component (existing)
- Step progress map: Foundation Analysis (20%) → Sections 1-7 (50%) → Sections 8-13 (80%) → Editorial Pass (95%) → Complete (100%)
- SSE events: `started`, `phase`, `completed`, `error`

**Preview View:**
- Scrollable section-by-section display of generated content
- Each section rendered as a card with section name header
- Key fields displayed in readable format (not raw JSON)
- "Publish to Shopify" button → calls publish endpoint → shows published URL + editor link
- "Regenerate" button → back to Configure View with fields pre-filled

### SSE Event Format

Uses `createSSEStream` from `backend/utils/sseHelper.js`. Event types match codebase conventions (`progress` for PipelineProgress, `complete` not `completed`):

```javascript
{ type: 'progress', step: 'foundation_analysis', message: 'Analyzing foundational docs...' }
{ type: 'progress', step: 'sections_1_7', message: 'Generating hero, education, trust sections...' }
{ type: 'progress', step: 'sections_8_13', message: 'Generating benefits, proof, FAQ sections...' }
{ type: 'progress', step: 'editorial_pass', message: 'Opus editorial review...' }
{ type: 'complete', pageId, sectionCount: 13 }
{ type: 'error', message, error }
```

**PipelineProgress step map:**
```javascript
const SP_STEP_PROGRESS = {
  foundation_analysis: 20,
  sections_1_7: 50,
  sections_8_13: 80,
  editorial_pass: 95,
};
const SP_STEP_LABELS = {
  foundation_analysis: 'Analyzing product & audience...',
  sections_1_7: 'Writing hero, education & trust sections...',
  sections_8_13: 'Writing benefits, proof & FAQ sections...',
  editorial_pass: 'Opus editorial review...',
};
```

## Cascade Deletion

- `projects.remove()` must cascade-delete child `sales_pages` records
- `salesPages.remove()` must cascade-delete child `sales_page_versions` records
- On unpublish: delete the per-page template asset from Shopify theme (`DELETE /themes/{id}/assets.json?asset[key]=templates/page.sales-{id}.json`) and delete the Shopify page

## convexClient.js Details

### Mapper Function

```javascript
function convexSalesPageToRow(raw) {
  return {
    externalId: raw.externalId,
    project_id: raw.project_id,
    name: raw.name,
    status: raw.status,
    product_brief: raw.product_brief,    // JSON string, parsed by caller
    section_data: raw.section_data,      // JSON string, parsed by caller
    editorial_notes: raw.editorial_notes,
    published_url: raw.published_url,
    published_at: raw.published_at,
    shopify_page_id: raw.shopify_page_id,
    shopify_theme_id: raw.shopify_theme_id,
    template_key: raw.template_key,
    current_version: raw.current_version,
    error_message: raw.error_message,
    generation_model: raw.generation_model,
    created_at: raw.created_at,
    updated_at: raw.updated_at,
  };
}
```

### Update Whitelist

```javascript
const SALES_PAGE_UPDATE_WHITELIST = [
  'name', 'status', 'product_brief', 'section_data', 'editorial_notes',
  'published_url', 'published_at', 'shopify_page_id', 'shopify_theme_id',
  'template_key', 'current_version', 'error_message', 'generation_model',
];
```

### CRUD Helpers

- `createSalesPage(data)` — insert with UUID externalId
- `getSalesPage(externalId)` — single page by externalId
- `getSalesPagesByProject(projectId)` — all pages for project
- `updateSalesPage(externalId, fields)` — whitelisted field update
- `deleteSalesPage(externalId)` — cascade-delete versions, then delete page
- `createSalesPageVersion(data)` — insert version snapshot
- `getSalesPageVersions(salesPageId)` — all versions for a page

## Cost Tracking Operations

All LLM calls pass `{ operation, projectId }` per Invariant 26:

- `sp_foundation_analysis` — Turn 1 (Sonnet)
- `sp_sections_1_7` — Turn 2 (Sonnet)
- `sp_sections_8_13` — Turn 3 (Sonnet)
- `sp_editorial_pass` — Editorial review (Opus)

## Error Handling

- **Missing foundational docs:** Generation fails immediately with `res.status(400).json({ error: 'Foundational docs not yet generated for this project' })`. User must generate docs first.
- **Invalid Shopify credentials:** Publish fails with `res.status(400).json({ error: 'Shopify credentials not configured. Go to Agent Dashboard → LP Agent Settings.' })`
- **LLM failure mid-generation:** Set status to `'failed'` with `error_message`, emit `{ type: 'error' }` SSE event

## Section Data → Shopify Blocks Mapping

Shopify sections use "blocks" for repeatable content (not nested arrays in settings). The publisher must transform AI-generated arrays into Shopify block format:

```javascript
// AI generates: { "accordion_items": [{ "question": "...", "answer": "..." }] }
// Shopify expects: { "blocks": { "block-1": { "type": "accordion_item", "settings": { "question": "...", "answer": "..." } } } }

function mapArrayToBlocks(items, blockType) {
  const blocks = {};
  const blockOrder = [];
  items.forEach((item, i) => {
    const id = `${blockType}-${i}`;
    blocks[id] = { type: blockType, settings: item };
    blockOrder.push(id);
  });
  return { blocks, block_order: blockOrder };
}
```

Arrays that need block mapping: `bundle_tiers`, `accordion_items`, `badges`, `videos`, `tabs`, `steps`, `stats`, `testimonials`, `guarantee_badges`, `faq_items`

## Files to Create

| File | Purpose |
|------|---------|
| `convex/salesPages.ts` | CRUD functions (create, update, getByProject, getByExternalId, remove with cascade) |
| `convex/salesPageVersions.ts` | Version snapshot CRUD |
| `backend/routes/salesPages.js` | Express routes (generate SSE, CRUD, publish, unpublish) |
| `backend/services/spGenerator.js` | 3-turn generation + editorial pass |
| `backend/services/spPublisher.js` | Shopify Theme Sections API publishing + unpublishing |
| `backend/services/spSectionPrompts.js` | 13 section prompt templates |
| `frontend/src/components/SalesPageGen.jsx` | UI component (list, configure, generating, preview) |

## Files to Modify

| File | Changes |
|------|---------|
| `convex/schema.ts` | Add `sales_pages` + `sales_page_versions` tables |
| `backend/convexClient.js` | Add `convexSalesPageToRow` mapper, `SALES_PAGE_UPDATE_WHITELIST`, 7 CRUD helpers |
| `backend/server.js` | 1) `import salesPageRoutes from './routes/salesPages.js';` 2) `app.use('/api/projects/:id/generate-sales-page', llmRateLimit);` 3) `app.use('/api/projects', requireAuth, requireRole('admin', 'manager'), salesPageRoutes);` |
| `frontend/src/api.js` | Add `generateSalesPage` (SSE), `getSalesPages`, `getSalesPage`, `updateSalesPage`, `publishSalesPage`, `unpublishSalesPage`, `deleteSalesPage` |
| `frontend/src/pages/ProjectDetail.jsx` | Add `'salespages'` to `validTabs` array + `allTabs` array + conditional render block with ErrorBoundary |

## Verification

1. **Generation:** Create a test project with foundational docs → generate sales page → verify all 13 sections produce valid JSON matching expected schemas
2. **Preview:** Verify each section renders readable content in the preview view
3. **Publishing:** Connect a test Shopify store → publish → verify template JSON is written correctly → verify page is created as draft → verify editor URL opens to correct template
4. **Error handling:** Test with missing foundational docs (should fail gracefully), test with invalid Shopify credentials (should show clear error)
5. **Build:** `source ~/.zshrc 2>/dev/null && cd frontend && npm run build` must succeed with no errors

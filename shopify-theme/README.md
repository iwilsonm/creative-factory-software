# Dacia Sales Page Generator — Shopify Theme

This directory contains a Shopify theme component set for the Dacia Sales Page Generator. It is **not** a full theme — it contains only the `sp-*` sections, snippets, assets, and templates that the generator publishes to a customer's existing Shopify theme.

---

## What's in This Directory

```
shopify-theme/
├── assets/
│   └── sp-sections.css           # Shared layout/spacing CSS (no color values)
├── snippets/
│   ├── sp-faq-accordion.liquid   # Reusable FAQ accordion component
│   ├── sp-image-text.liquid      # Reusable split image+text layout
│   └── sp-trust-bar.liquid       # Reusable trust badge row
├── sections/
│   ├── sp-announcement-bar.liquid
│   ├── sp-product-hero.liquid
│   ├── sp-product-faq.liquid
│   ├── sp-buying-faq.liquid
│   ├── sp-trust-badges.liquid
│   ├── sp-footer-trust.liquid
│   ├── sp-video-testimonials.liquid
│   ├── sp-written-testimonials.liquid
│   ├── sp-education-concept.liquid
│   ├── sp-education-product.liquid
│   ├── sp-benefits-tabs.liquid
│   ├── sp-how-it-works.liquid
│   ├── sp-results-stats.liquid
│   ├── sp-guarantee.liquid
│   ├── sp-reviews-widget.liquid
│   └── sp-sticky-cart.liquid
└── templates/
    └── page.sales.json           # Page template wiring all sections
```

---

## How to Push to Shopify

Use the Shopify CLI `--only` flag to push only the `sp-*` files without overwriting the rest of the customer's theme.

```bash
# Push all sp- files to the theme
shopify theme push --only \
  assets/sp-sections.css \
  snippets/sp-faq-accordion.liquid \
  snippets/sp-image-text.liquid \
  snippets/sp-trust-bar.liquid \
  sections/sp-announcement-bar.liquid \
  sections/sp-product-hero.liquid \
  sections/sp-product-faq.liquid \
  sections/sp-buying-faq.liquid \
  sections/sp-trust-badges.liquid \
  sections/sp-footer-trust.liquid \
  sections/sp-video-testimonials.liquid \
  sections/sp-written-testimonials.liquid \
  sections/sp-education-concept.liquid \
  sections/sp-education-product.liquid \
  sections/sp-benefits-tabs.liquid \
  sections/sp-how-it-works.liquid \
  sections/sp-results-stats.liquid \
  sections/sp-guarantee.liquid \
  sections/sp-reviews-widget.liquid \
  sections/sp-sticky-cart.liquid \
  templates/page.sales.json
```

To target a specific theme ID:

```bash
shopify theme push --theme <THEME_ID> --only assets/sp-sections.css ...
```

---

## Required Shopify API Scopes

The generator's Shopify integration requires the following OAuth scopes:

| Scope | Purpose |
|-------|---------|
| `read_content` | Read existing pages and themes |
| `write_content` | Create/update pages and push theme files |

---

## Generator-to-Theme Contract

The generator writes section settings and blocks using specific keys. These keys MUST match the `id` fields in the section `{% schema %}` definitions exactly.

### Section Settings

| Section | Generator Key | Schema Setting ID | Type |
|---------|--------------|-------------------|------|
| sp-announcement-bar | `announcement_text` | `announcement_text` | text |
| sp-announcement-bar | `bg_color` | `bg_color` | color |
| sp-announcement-bar | `text_color` | `text_color` | color |
| sp-announcement-bar | `font_size` | `font_size` | range |
| sp-education-concept | `heading` | `heading` | text |
| sp-education-concept | `body_text` | `body_text` | richtext |
| sp-education-concept | `image` | `image` | image_picker |
| sp-education-concept | `image_position` | `image_position` | select |
| sp-education-concept | `link_text` | `link_text` | text |
| sp-education-concept | `link_url` | `link_url` | url |
| sp-education-concept | `bg_color` | `bg_color` | color |
| sp-education-product | (same as concept) | (same as concept) | — |
| sp-results-stats | `heading` | `heading` | text |
| sp-results-stats | `intro_text` | `intro_text` | text |
| sp-results-stats | `caption` | `caption` | text |
| sp-results-stats | `bg_color` | `bg_color` | color |
| sp-results-stats | `text_color` | `text_color` | color |
| sp-results-stats | `stat_color` | `stat_color` | color |
| sp-guarantee | `heading` | `heading` | text |
| sp-guarantee | `body_text` | `body_text` | richtext |
| sp-guarantee | `bg_color` | `bg_color` | color |
| sp-benefits-tabs | `heading` | `heading` | text |
| sp-benefits-tabs | `bg_color` | `bg_color` | color |
| sp-benefits-tabs | `tab_active_color` | `tab_active_color` | color |
| sp-product-hero | `product` | `product` | product |
| sp-product-hero | `headline_override` | `headline_override` | text |
| sp-product-hero | `rating_score` | `rating_score` | text |
| sp-product-hero | `rating_count` | `rating_count` | text |
| sp-product-hero | `discount_badge` | `discount_badge` | text |
| sp-product-hero | `emoji_benefit_1` | `emoji_benefit_1` | text |
| sp-product-hero | `emoji_benefit_2` | `emoji_benefit_2` | text |
| sp-product-hero | `cta_text` | `cta_text` | text |
| sp-product-hero | `cta_color` | `cta_color` | color |
| sp-product-hero | `show_upsell` | `show_upsell` | checkbox |
| sp-product-hero | `upsell_product` | `upsell_product` | product |
| sp-product-hero | `upsell_description` | `upsell_description` | text |
| sp-sticky-cart | `enabled` | `enabled` | checkbox |
| sp-sticky-cart | `bg_color` | `bg_color` | color |
| sp-sticky-cart | `cta_text` | `cta_text` | text |
| sp-sticky-cart | `cta_color` | `cta_color` | color |
| sp-reviews-widget | `reviews_app` | `reviews_app` | select |
| sp-reviews-widget | `app_widget_code` | `app_widget_code` | html |

### Block Types

| Section | Block Type | Generator Array Key |
|---------|-----------|---------------------|
| sp-trust-badges | `badge` | `badges` |
| sp-footer-trust | `badge` | `badges` |
| sp-results-stats | `stat` | `stats` |
| sp-how-it-works | `step` | `steps` |
| sp-product-faq | `faq_item` | `faq_items` |
| sp-buying-faq | `faq_item` | `faq_items` |
| sp-written-testimonials | `testimonial` | `testimonials` |
| sp-benefits-tabs | `benefit_tab` | `tabs` |
| sp-video-testimonials | `video` | `videos` |
| sp-guarantee | `guarantee_badge` | `badges` |
| sp-product-hero | `bundle_tier` | `tiers` |

### Block Setting IDs

**badge** (sp-trust-badges, sp-footer-trust):
- `icon` — select: check, undo, heart, lock, flag_us, shield, star
- `text` — text

**stat** (sp-results-stats):
- `percentage` — text (the number/percentage to display)
- `description` — text

**step** (sp-how-it-works):
- `step_image` — image_picker
- `step_title` — text
- `step_description` — text

**faq_item** (sp-product-faq, sp-buying-faq):
- `question` — text
- `answer` — richtext

**testimonial** (sp-written-testimonials):
- `star_rating` — range (1–5)
- `headline` — text
- `quote` — textarea
- `customer_name` — text
- `customer_photo` — image_picker
- `verified` — checkbox

**benefit_tab** (sp-benefits-tabs):
- `tab_label` — text
- `tab_heading` — text
- `tab_body` — richtext
- `tab_image` — image_picker

**video** (sp-video-testimonials):
- `video_url` — video_url (youtube/vimeo)
- `thumbnail` — image_picker
- `caption` — text

**guarantee_badge** (sp-guarantee):
- `icon` — select: shield, refresh, check, heart
- `text` — text

**bundle_tier** (sp-product-hero):
- `tier_name` — text
- `tier_price` — text
- `tier_compare_price` — text
- `tier_savings` — text
- `free_gift_text` — text
- `is_best_value` — checkbox

---

## Known Generator Discrepancies

The following mismatches exist between the generator (`spSectionPrompts.js` / publisher) and this theme and need to be fixed:

### 1. sp-product-faq: `accordion_items` vs `faq_items`

The generator currently writes blocks under the key `accordion_items` for `sp-product-faq`, but the section schema uses block type `faq_item`. The publisher must use `faq_items` as the array key (or the blockTypeMap must map `accordion_items` -> `faq_item`).

**Fix in generator:** Change the array key from `accordion_items` to `faq_items` in `spSectionPrompts.js` for `sp-product-faq`, or add a `blockTypeMap` override: `{ accordion_items: 'faq_item' }`.

### 2. sp-guarantee: Badge field name mismatch

The generator may write guarantee badge blocks with field names `badge_icon` / `badge_text`, but the schema uses `icon` / `text`.

**Fix in generator:** Ensure guarantee badge blocks use `icon` and `text` as the setting IDs (not `badge_icon` / `badge_text`).

### 3. sp-product-hero: Bundle tier field name mismatch

The generator may write bundle tier blocks with field names `name` / `price` / `compare_price` / `savings`, but the schema uses `tier_name` / `tier_price` / `tier_compare_price` / `tier_savings`.

**Fix in generator:** Update bundle tier block setting keys to use the `tier_` prefix: `tier_name`, `tier_price`, `tier_compare_price`, `tier_savings`, `free_gift_text`, `is_best_value`.

---

## Design Rules

- Colors are NEVER in `sp-sections.css` — always in per-section inline `<style>` blocks using Liquid settings
- CSS classes are scoped with `section.id` to prevent collisions when multiple sections of the same type appear
- All sections check for empty primary fields before rendering (no blank sections in storefront)
- No `presets` in any schema (prevents unwanted defaults in the theme editor)

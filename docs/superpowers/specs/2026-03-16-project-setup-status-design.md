# Project Setup Status Visibility

## Problem

When a new project is created, it shows a "Setup" badge but there's no indication of what needs to happen to reach "Ready" status. Users have to discover through trial and error that they need all 4 foundational doc types generated.

## Design

### Setup Banner (ProjectDetail page)

A gold-tinted banner placed between the page header (line ~385) and the tab navigation (line ~388), outside the `<Suspense>` boundary to avoid flashing during lazy tab loads. Visible only when `project.status === 'setup'`. Hidden during `generating_docs`, `docs_ready`, and `active` statuses.

**Contents:**
- Title: "Complete foundational docs to get started"
- 2x2 grid showing the 4 required doc types:
  - Research
  - Customer Avatar
  - Offer Brief
  - Necessary Beliefs
- Each type shows a teal checkmark (exists) or gold circle (missing)
- "Generate Docs" button that navigates to the docs sub-tab: `setTab('overview'); setSettingsSubTab('docs');` (same pattern as the existing alert on line ~420)
- Disappears entirely once status is no longer `setup`

**Data source:** Fetch docs via existing `api.getDocs(projectId)` (defined in `frontend/src/api.js` line 200) on project load. Response shape: `{ docs: [...], steps: [...] }` where each doc has a `doc_type` field. Missing types simply won't appear in the array (nulls are filtered out in `backend/routes/documents.js` line 34). Derive available types: `new Set(response.docs.map(d => d.doc_type))`. Check against the 4 required types: `['research', 'avatar', 'offer_brief', 'necessary_beliefs']`.

**Styling:**
- Container: `bg-gold/5 border border-gold/20 rounded-xl p-4`
- Consistent with existing gold "Setup" badge color scheme
- Doc type indicators in a compact 2-column grid
- Button: standard `btn-primary` or gold-styled link

### Project Card Hint (Projects list page)

For projects with `status === 'setup'`, change the existing doc count display from `"0 docs"` to `"0/4 docs"` to indicate there's a target of 4. Uses existing `docCount` field (total doc count, not per-type) which is sufficient for a hint. Projects with other statuses keep the plain `"N docs"` format.

### Old Alert Removal

Remove the existing "Foundational documents needed" alert on the Overview tab (ProjectDetail line ~412). It's vague and only shows when `docCount === 0` on the Overview tab. The new banner is more informative and visible on all tabs.

## Files to Modify

- `frontend/src/pages/ProjectDetail.jsx` — Add doc type fetch, setup banner (between header and tabs), remove old alert
- `frontend/src/pages/Projects.jsx` — Change doc count display for setup-status projects

## Status Transition Reference

| Status | Condition | Banner visible? |
|--------|-----------|-----------------|
| `setup` | Default on creation, or if doc generation fails | Yes |
| `generating_docs` | During doc generation pipeline | No |
| `docs_ready` | All 4 doc types exist | No |
| `active` | Defined in config but never set in code | No |

Status transitions are controlled by `backend/services/docGenerator.js` and `backend/routes/documents.js`.

## Verification

1. Create a new project — "Setup" badge with "0/4 docs" on the project card
2. Open the project — gold banner visible above tabs on all tabs
3. Click "Generate Docs" — switches to overview tab, docs sub-tab
4. Generate foundational docs — banner disappears, badge becomes "Ready"
5. Existing projects with docs already show no banner
6. During generation (`generating_docs` status) — banner is hidden

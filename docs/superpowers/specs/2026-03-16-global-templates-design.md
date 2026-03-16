# Global Template Images

## Problem

Template images are currently scoped per-project — each project has its own set. The user wants one global pool of templates shared across all projects: upload once, available everywhere.

## Design

Keep `project_id` on template records as an audit field (who uploaded it) but stop filtering by it. All templates are visible in every project.

### Convex layer (`convex/templateImages.ts`)

Add a new query `getAll()` that returns all template images. Use `.take(500)` to prevent unbounded results (per project convention from commit `5dbba3e`). The existing `getByProject()` stays but is no longer used.

### Backend routes (`backend/routes/templates.js`)

- **`GET /projects/:projectId/templates`** — Call `getAll()` instead of `getByProject(projectId)`. Keep the `getProject()` validation (ensures valid project context). The `thumbnailUrl` construction uses the requesting project's ID in the URL — this works because the file endpoint doesn't validate project ownership.
- **`GET /projects/:projectId/templates/:imageId/file`** — No change needed. Already has no project ownership check.
- **`POST /projects/:projectId/templates`** — Keep as-is. Upload still tags with current project_id for audit trail.
- **`PUT /projects/:projectId/templates/:imageId`** — Remove `template.project_id !== req.params.projectId` check. Only check `if (!template)`.
- **`DELETE /projects/:projectId/templates/:imageId`** — Remove project ownership validation. Only check `if (!template)`.
- **`POST /projects/:projectId/templates/:templateId/analyze`** — Remove `template.project_id !== req.params.projectId` check (line ~197). Only check `if (!template)`.

### Backend helpers (`backend/convexClient.js`)

There is currently no `getTemplateImages(projectId)` helper — the route calls `convexClient.query()` directly. Add `getAllTemplateImages()` that calls the new `getAll()` query, and use it in the GET endpoint.

### Frontend

No changes needed. These components all call `api.getTemplates(projectId)` which hits the same endpoint:
- `TemplateImages.jsx` — template management UI
- `AdStudio.jsx` (line ~591) — template picker for ad generation
- `BatchManager.jsx` (line ~95) — template picker for batch creation

Since the endpoint now returns all templates, all three automatically show the global pool.

### Batch/ad generation

No changes needed. `batchProcessor.js` and `adGenerator.js` use specific `template_image_ids` from batch config — these reference templates by `externalId` without project filtering.

### Creative Filter agent

The filter agent (`dacia-creative-filter/filter.sh`) does not directly query templates — it works with ads that already have template references baked in. No changes needed.

### What users experience

- Upload templates in any project → they appear in all projects
- Delete a template from any project → removed globally
- Analyze a template from any project → works regardless of which project uploaded it
- All existing templates from all projects become visible everywhere immediately

## Files to modify

- `convex/templateImages.ts` — Add `getAll()` query with `.take(500)`
- `backend/convexClient.js` — Add `getAllTemplateImages()` helper
- `backend/routes/templates.js` — Use `getAll()` for listing, remove 3 project ownership checks (PUT, DELETE, analyze)

## Convex deploy required

Yes — adding a new query requires `npx convex deploy -y` on VPS before restarting PM2.

## Verification

1. Deploy Convex, then backend
2. Open any project → Templates tab should show all templates from all projects
3. Upload a template in Project A → visible in Project B
4. Delete a template from Project B (originally uploaded in A) → gone everywhere
5. Analyze a template from Project B that was uploaded in Project A → succeeds
6. Create a batch → template selection shows the global pool

# Fix: Project Status Stuck at "setup" When All Docs Exist

## Problem

Projects can have all 4 foundational doc types (research, avatar, offer_brief, necessary_beliefs) but remain stuck at "setup" status. This happens because several code paths that create or modify docs don't check whether all 4 types now exist and update the project status accordingly.

**Root cause**: Only 3 of 5 doc mutation paths update project status:

| Code path | Sets `docs_ready`? |
|---|---|
| `generateAllDocs()` (full pipeline) | Yes |
| `generateFromManualResearch()` | Yes |
| `upload-docs` endpoint | Yes |
| `regenerateDoc()` (single doc regen) | **No** |
| `PUT /docs/:docId` (manual edit) | **No** |

**Out of scope**: `apply-corrections` and `revert-correction` endpoints modify doc content but don't create or delete docs, so they don't affect status.

## Design

### Shared helper: `checkAndPromoteDocStatus(projectId)`

A function that checks if all 4 required doc types exist for a project. If they do and the current status is `setup`, it promotes status to `docs_ready`. Otherwise it does nothing.

**Location**: `backend/routes/documents.js` (where `getLatestDoc`, `DOC_TYPES`, `updateProject`, and `getProject` are already imported). This avoids circular dependencies — `docGenerator.js` does not need to import the helper because the route handler calls it after `regenerateDoc()` completes.

**Logic**:
1. Fetch current project to check status
2. If status is not `setup`, return early (don't promote from `generating_docs` or demote from `docs_ready`)
3. Fetch latest doc for each of the 4 required types via `getLatestDoc(projectId, type)`
4. If all 4 are non-null → `updateProject(projectId, { status: 'docs_ready' })`
5. Otherwise → do nothing (only promotes, never demotes)

**Why only promote from `setup`**: If status is `generating_docs`, another pipeline is running and we shouldn't interfere. If status is already `docs_ready` or `active`, no action needed.

### Call sites

1. **`POST /:projectId/generate-doc/:type` route in `documents.js`** — Call after `regenerateDoc()` completes via the `streamService` callback (not from inside `docGenerator.js`, which would create a circular import)
2. **`PUT /:projectId/docs/:docId` in `documents.js`** — Call after doc content is updated
3. **`POST /:projectId/upload-docs` in `documents.js`** — Replace the existing inline logic (lines 122-126) with the shared helper. The current `else` branch that demotes to `setup` is removed — it was defensive but the "only promote" rule supersedes it, and `upload-docs` is additive (you're adding docs, not deleting)
4. **`GET /:projectId/docs` in `documents.js`** — Call as auto-heal side effect, guarded by `project.status === 'setup'` to avoid unnecessary queries on every page load. This fixes existing affected projects (like Clarity Coffee) on next page visit.

### Fix existing data

Existing affected projects (status `setup` but all docs present) auto-heal when their docs page is loaded, thanks to the GET endpoint side effect. No migration script needed.

## Files to modify

- `backend/routes/documents.js` — Add `checkAndPromoteDocStatus()` helper, call from 4 locations
- No changes to `backend/services/docGenerator.js` (avoid circular import)
- No frontend or Convex changes needed

## Verification

1. Open Clarity Coffee project detail page — status should auto-heal from "setup" to "docs_ready", banner disappears
2. Create a new project, upload docs via 4 separate `upload-docs` requests (one type each) — after the 4th, status should auto-promote to "docs_ready"
3. Regenerate a single doc on an existing "docs_ready" project — status stays "docs_ready" (not regressed)
4. During active generation (`generating_docs` status), the helper does not interfere
5. Edit a doc via PUT — status stays at whatever it was (no demotion)

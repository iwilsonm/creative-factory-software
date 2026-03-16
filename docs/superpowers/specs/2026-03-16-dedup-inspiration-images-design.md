# Deduplicate Global Inspiration Images

## Problem

After making inspiration images global, the GET endpoint returns 204 images — but 98 are duplicates. Both Grounding Bedsheet (106 images) and Produce Protector (98 images) synced from the same Google Drive folder. 98 images share the same `drive_file_id`. Users should see 106 unique images.

## Design

In the GET inspiration endpoint (`backend/routes/drive.js`), deduplicate the `allImages` array by `drive_file_id` before mapping to the response. First occurrence wins.

No Convex, frontend, or schema changes needed.

## File to modify

- `backend/routes/drive.js` — Add dedup filter in the GET `/:projectId/inspiration` handler

## Verification

1. Deploy backend
2. Open any project's inspiration tab → should show 106 images, not 204

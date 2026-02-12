import express, { Router } from 'express';
import { google } from 'googleapis';
import { Readable } from 'stream';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import fetch from 'node-fetch';
import { withRetry } from '../services/retry.js';
import { requireAuth } from '../auth.js';
import { getProject, getInspirationImages, getInspirationImage, getInspirationImageUrl, uploadBuffer, convexClient, api } from '../convexClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVICE_ACCOUNT_PATH = path.join(__dirname, '..', '..', 'config', 'service-account.json');

const router = Router();
router.use(requireAuth);

function getDriveClient() {
  if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
    throw new Error('Service account not configured. Place service-account.json in the config/ directory.');
  }

  const keyFile = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, 'utf-8'));
  const auth = new google.auth.GoogleAuth({
    credentials: keyFile,
    scopes: ['https://www.googleapis.com/auth/drive']
  });

  return google.drive({ version: 'v3', auth });
}

// Check if Drive is configured
router.get('/status', (req, res) => {
  const exists = fs.existsSync(SERVICE_ACCOUNT_PATH);
  let email = null;
  if (exists) {
    try {
      const keyFile = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, 'utf-8'));
      email = keyFile.client_email || null;
    } catch {}
  }
  res.json({
    configured: exists,
    serviceAccountEmail: email,
    message: exists
      ? 'Service account configured'
      : 'Upload your service-account.json to enable Drive integration.'
  });
});

// Upload service account JSON
router.post('/upload-service-account', express.json({ limit: '1mb' }), (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'No content provided' });

  try {
    const parsed = JSON.parse(content);
    if (!parsed.client_email || !parsed.private_key || parsed.type !== 'service_account') {
      return res.status(400).json({ error: 'Invalid service account JSON. Must contain client_email, private_key, and type "service_account".' });
    }

    const configDir = path.dirname(SERVICE_ACCOUNT_PATH);
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });

    fs.writeFileSync(SERVICE_ACCOUNT_PATH, JSON.stringify(parsed, null, 2));
    res.json({
      success: true,
      serviceAccountEmail: parsed.client_email
    });
  } catch (err) {
    res.status(400).json({ error: `Invalid JSON: ${err.message}` });
  }
});

// Test Drive connection
router.post('/test', async (req, res) => {
  try {
    const drive = getDriveClient();
    const response = await drive.about.get({ fields: 'user' });
    res.json({
      success: true,
      message: `Connected as ${response.data.user?.displayName || 'service account'}`
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List shared drives
router.get('/shared-drives', async (req, res) => {
  try {
    const drive = getDriveClient();
    const response = await drive.drives.list({
      pageSize: 50,
      fields: 'drives(id, name)'
    });
    res.json({
      drives: (response.data.drives || []).map(d => ({
        id: d.id,
        name: d.name
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List folders
router.get('/folders', async (req, res) => {
  try {
    const drive = getDriveClient();
    const parentId = req.query.parentId || null;

    const allFolders = [];

    if (parentId) {
      const query = `mimeType = 'application/vnd.google-apps.folder' and trashed = false and '${parentId}' in parents`;
      const response = await drive.files.list({
        q: query,
        fields: 'files(id, name, parents)',
        orderBy: 'name',
        pageSize: 100,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true
      });
      allFolders.push(...response.data.files);
    } else {
      const sharedQuery = "mimeType = 'application/vnd.google-apps.folder' and trashed = false and sharedWithMe = true";
      const sharedResponse = await drive.files.list({
        q: sharedQuery,
        fields: 'files(id, name, parents)',
        orderBy: 'name',
        pageSize: 100,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true
      });
      allFolders.push(...sharedResponse.data.files);

      try {
        const drivesResponse = await drive.drives.list({
          pageSize: 50,
          fields: 'drives(id, name)'
        });
        for (const d of (drivesResponse.data.drives || [])) {
          allFolders.push({ id: d.id, name: `[Shared Drive] ${d.name}`, parents: [] });
        }
      } catch {}
    }

    res.json({
      folders: allFolders.map(f => ({
        id: f.id,
        name: f.name,
        parentId: f.parents?.[0] || null
      })),
      parentId
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get folder info
router.get('/folders/:folderId', async (req, res) => {
  try {
    const drive = getDriveClient();
    const file = await drive.files.get({
      fileId: req.params.folderId,
      fields: 'id, name, parents',
      supportsAllDrives: true
    });

    const breadcrumb = [{ id: file.data.id, name: file.data.name }];
    let current = file.data;

    while (current.parents && current.parents[0]) {
      try {
        const parent = await drive.files.get({
          fileId: current.parents[0],
          fields: 'id, name, parents',
          supportsAllDrives: true
        });
        breadcrumb.unshift({ id: parent.data.id, name: parent.data.name });
        current = parent.data;
      } catch {
        break;
      }
    }

    res.json({
      folder: { id: file.data.id, name: file.data.name },
      breadcrumb
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===========================
// Inspiration Folder Sync — now uses Convex storage instead of local filesystem
// ===========================

const MIME_TO_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/svg+xml': '.svg'
};

/**
 * Sync images from a Google Drive folder to Convex storage.
 * Downloads new images, removes deleted ones.
 */
async function syncInspirationFolder(projectId) {
  const project = await getProject(projectId);
  if (!project) throw new Error('Project not found');
  if (!project.inspiration_folder_id) throw new Error('No inspiration folder configured for this project.');

  const drive = getDriveClient();

  // List all image files in the Drive folder
  const response = await drive.files.list({
    q: `'${project.inspiration_folder_id}' in parents and mimeType contains 'image/' and trashed = false`,
    fields: 'files(id, name, mimeType, modifiedTime, size)',
    orderBy: 'name',
    pageSize: 200,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true
  });

  const driveFiles = response.data.files || [];
  const driveFileIds = driveFiles.map(f => f.id);
  let synced = 0;

  // Download new images and upload to Convex
  for (const file of driveFiles) {
    // Check if already in Convex
    const existing = await getInspirationImage(projectId, file.id);
    if (existing && existing.storageId) continue; // Already cached

    // Download from Drive
    const driveRes = await drive.files.get(
      { fileId: file.id, alt: 'media', supportsAllDrives: true },
      { responseType: 'arraybuffer' }
    );
    const buffer = Buffer.from(driveRes.data);

    // Upload to Convex storage
    const storageId = await uploadBuffer(buffer, file.mimeType || 'image/jpeg');

    if (existing) {
      // Update existing record with new storageId
      await convexClient.mutation(api.inspirationImages.updateStorageId, {
        projectId,
        driveFileId: file.id,
        storageId,
      });
    } else {
      // Create new record
      await convexClient.mutation(api.inspirationImages.create, {
        project_id: projectId,
        drive_file_id: file.id,
        filename: file.name,
        mimeType: file.mimeType || 'image/jpeg',
        storageId,
        modifiedTime: file.modifiedTime || null,
        size: file.size ? parseInt(file.size) : undefined,
      });
    }
    synced++;
  }

  // Remove images from Convex that no longer exist in Drive
  const result = await convexClient.mutation(api.inspirationImages.removeByProject, {
    projectId,
    driveFileIds,
  });

  // Build image list
  const images = driveFiles.map(f => ({
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    modifiedTime: f.modifiedTime,
    size: f.size ? parseInt(f.size) : null,
    thumbnailUrl: `/api/projects/${projectId}/inspiration/${f.id}/thumbnail`
  }));

  return { images, synced, removed: result.removed, total: images.length };
}

// ===========================
// Inspiration routes
// ===========================
export const inspirationRouter = Router();
inspirationRouter.use(requireAuth);

// List inspiration images
inspirationRouter.get('/:projectId/inspiration', async (req, res) => {
  try {
    const project = await getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!project.inspiration_folder_id) {
      return res.json({ images: [], total: 0, message: 'No inspiration folder configured.' });
    }

    // Check if we have any cached in Convex
    const cached = await getInspirationImages(req.params.projectId);

    if (cached.length === 0) {
      // No cache yet — sync from Drive
      const result = await syncInspirationFolder(req.params.projectId);
      return res.json(result);
    }

    // Return cached list
    const images = cached.map(img => ({
      id: img.drive_file_id,
      name: img.filename,
      mimeType: img.mimeType,
      thumbnailUrl: `/api/projects/${req.params.projectId}/inspiration/${img.drive_file_id}/thumbnail`
    }));

    res.json({ images, total: images.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Force sync
inspirationRouter.post('/:projectId/inspiration/sync', async (req, res) => {
  try {
    const result = await syncInspirationFolder(req.params.projectId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve a cached inspiration image (redirect to Convex URL)
inspirationRouter.get('/:projectId/inspiration/:fileId/thumbnail', async (req, res) => {
  const url = await getInspirationImageUrl(req.params.projectId, req.params.fileId);
  if (!url) {
    return res.status(404).json({ error: 'Image not found' });
  }
  res.redirect(url);
});

// ===========================
// Upload file to Google Drive — now reads from Buffer/stream instead of local path
// ===========================

/**
 * Upload a Buffer to a Google Drive folder.
 * @param {Buffer} buffer - File data
 * @param {string} fileName - Name for the file in Drive
 * @param {string} folderId - Google Drive folder ID
 * @param {string} mimeType - MIME type of the file
 * @returns {{ fileId: string, webViewLink: string }}
 */
export async function uploadBufferToDrive(buffer, fileName, folderId, mimeType = 'image/png') {
  const drive = getDriveClient();

  // Check if the target folder is on a Shared Drive
  let driveId = null;
  try {
    const folderInfo = await drive.files.get({
      fileId: folderId,
      fields: 'driveId',
      supportsAllDrives: true
    });
    driveId = folderInfo.data.driveId || null;
  } catch {}

  const fileMetadata = {
    name: fileName,
    parents: [folderId]
  };

  // Create a readable stream from the buffer
  const stream = Readable.from(buffer);

  const createParams = {
    requestBody: fileMetadata,
    media: {
      mimeType,
      body: stream
    },
    fields: 'id, webViewLink',
    supportsAllDrives: true
  };

  if (driveId) {
    createParams.requestBody.driveId = driveId;
  }

  const response = await withRetry(
    () => drive.files.create(createParams),
    { label: '[Drive upload]', maxRetries: 2 }
  );

  return {
    fileId: response.data.id,
    webViewLink: response.data.webViewLink
  };
}

// Keep backward-compatible name for existing callers
export const uploadFileToDrive = uploadBufferToDrive;

export { getDriveClient };
export default router;

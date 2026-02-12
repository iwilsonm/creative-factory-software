import express, { Router } from 'express';
import { google } from 'googleapis';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { withRetry } from '../services/retry.js';
import { requireAuth } from '../auth.js';
import { getProject } from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVICE_ACCOUNT_PATH = path.join(__dirname, '..', '..', 'config', 'service-account.json');
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const INSPIRATION_DIR = path.join(DATA_DIR, 'inspiration');

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
    // Validate it's valid JSON with expected fields
    const parsed = JSON.parse(content);
    if (!parsed.client_email || !parsed.private_key || parsed.type !== 'service_account') {
      return res.status(400).json({ error: 'Invalid service account JSON. Must contain client_email, private_key, and type "service_account".' });
    }

    // Ensure config directory exists
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

// List shared drives the service account has access to
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

// List folders within a parent folder, or at root level (shared with me + shared drives)
router.get('/folders', async (req, res) => {
  try {
    const drive = getDriveClient();
    const parentId = req.query.parentId || null;

    const allFolders = [];

    if (parentId) {
      // Listing children of a specific folder
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
      // Root level: show folders explicitly shared with the service account
      // plus shared drive roots
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

      // Also list shared drives as top-level entries
      try {
        const drivesResponse = await drive.drives.list({
          pageSize: 50,
          fields: 'drives(id, name)'
        });
        for (const d of (drivesResponse.data.drives || [])) {
          allFolders.push({ id: d.id, name: `[Shared Drive] ${d.name}`, parents: [] });
        }
      } catch {
        // Shared drives may not be available — that's fine
      }
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

// Get folder info (name, path breadcrumb)
router.get('/folders/:folderId', async (req, res) => {
  try {
    const drive = getDriveClient();
    const file = await drive.files.get({
      fileId: req.params.folderId,
      fields: 'id, name, parents',
      supportsAllDrives: true
    });

    // Build breadcrumb
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
        break; // Hit root or shared drive
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
// Inspiration Folder Sync
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
 * Sync images from a Google Drive folder to local cache.
 * Downloads new images, removes deleted ones.
 * @param {string} projectId
 * @returns {{ images: Array, synced: number, removed: number }}
 */
async function syncInspirationFolder(projectId) {
  const project = getProject(projectId);
  if (!project) throw new Error('Project not found');
  if (!project.inspiration_folder_id) throw new Error('No inspiration folder configured for this project.');

  const drive = getDriveClient();
  const localDir = path.join(INSPIRATION_DIR, projectId);
  fs.mkdirSync(localDir, { recursive: true });

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
  const driveFileIds = new Set(driveFiles.map(f => f.id));
  let synced = 0;

  // Download new images
  for (const file of driveFiles) {
    const ext = MIME_TO_EXT[file.mimeType] || '.jpg';
    const localPath = path.join(localDir, `${file.id}${ext}`);

    if (!fs.existsSync(localPath)) {
      const dest = fs.createWriteStream(localPath);
      const res = await drive.files.get(
        { fileId: file.id, alt: 'media', supportsAllDrives: true },
        { responseType: 'stream' }
      );
      await new Promise((resolve, reject) => {
        res.data.pipe(dest);
        dest.on('finish', resolve);
        dest.on('error', reject);
      });
      synced++;
    }
  }

  // Remove locally cached images that no longer exist in Drive
  let removed = 0;
  if (fs.existsSync(localDir)) {
    for (const localFile of fs.readdirSync(localDir)) {
      const fileId = localFile.split('.')[0];
      if (!driveFileIds.has(fileId)) {
        fs.unlinkSync(path.join(localDir, localFile));
        removed++;
      }
    }
  }

  // Build image list with metadata
  const images = driveFiles.map(f => {
    const ext = MIME_TO_EXT[f.mimeType] || '.jpg';
    return {
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      modifiedTime: f.modifiedTime,
      size: f.size ? parseInt(f.size) : null,
      localFile: `${f.id}${ext}`,
      thumbnailUrl: `/api/projects/${projectId}/inspiration/${f.id}/thumbnail`
    };
  });

  return { images, synced, removed, total: images.length };
}

// ===========================
// Inspiration routes — mounted separately under /api/projects
// ===========================
export const inspirationRouter = Router();
inspirationRouter.use(requireAuth);

// List inspiration images (syncs if needed on first call)
inspirationRouter.get('/:projectId/inspiration', async (req, res) => {
  try {
    const project = getProject(req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!project.inspiration_folder_id) {
      return res.json({ images: [], total: 0, message: 'No inspiration folder configured.' });
    }

    const localDir = path.join(INSPIRATION_DIR, req.params.projectId);

    // If no local cache exists yet, sync first
    if (!fs.existsSync(localDir) || fs.readdirSync(localDir).length === 0) {
      const result = await syncInspirationFolder(req.params.projectId);
      return res.json(result);
    }

    // Otherwise, return cached list by re-reading local files
    // (For an up-to-date list, user can call sync endpoint)
    const localFiles = fs.readdirSync(localDir);
    const images = localFiles.map(f => {
      const fileId = f.split('.')[0];
      const ext = path.extname(f);
      return {
        id: fileId,
        name: f,
        localFile: f,
        thumbnailUrl: `/api/projects/${req.params.projectId}/inspiration/${fileId}/thumbnail`
      };
    });

    res.json({ images, total: images.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Force sync inspiration folder from Drive
inspirationRouter.post('/:projectId/inspiration/sync', async (req, res) => {
  try {
    const result = await syncInspirationFolder(req.params.projectId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Serve a cached inspiration image
inspirationRouter.get('/:projectId/inspiration/:fileId/thumbnail', (req, res) => {
  const localDir = path.join(INSPIRATION_DIR, req.params.projectId);
  if (!fs.existsSync(localDir)) return res.status(404).json({ error: 'No inspiration images cached' });

  // Find the file by ID (could have any extension)
  const files = fs.readdirSync(localDir);
  const match = files.find(f => f.startsWith(req.params.fileId + '.'));
  if (!match) return res.status(404).json({ error: 'Image not found' });

  res.sendFile(path.join(localDir, match));
});

// ===========================
// Upload file to Google Drive (reusable utility)
// ===========================

/**
 * Upload a local file to a Google Drive folder.
 * Automatically detects if the folder is on a Shared Drive and handles accordingly.
 * Service accounts cannot upload to regular "My Drive" folders (no storage quota).
 * The target folder must be on a Shared Drive or the service account needs domain-wide delegation.
 *
 * @param {string} localPath - Path to the local file
 * @param {string} fileName - Name for the file in Drive
 * @param {string} folderId - Google Drive folder ID
 * @param {string} mimeType - MIME type of the file
 * @returns {{ fileId: string, webViewLink: string }}
 */
export async function uploadFileToDrive(localPath, fileName, folderId, mimeType = 'image/png') {
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
  } catch {
    // If we can't check, proceed without driveId
  }

  const fileMetadata = {
    name: fileName,
    parents: [folderId]
  };

  const createParams = {
    requestBody: fileMetadata,
    media: {
      mimeType,
      body: fs.createReadStream(localPath)
    },
    fields: 'id, webViewLink',
    supportsAllDrives: true
  };

  // If on a Shared Drive, include driveId so the file is owned by the shared drive (not the service account)
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

export { getDriveClient };
export default router;

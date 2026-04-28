// Shared image-resize utility for upload paths that must stay under Vercel's 4.5 MB body limit.
// Resizes to <= ~1.5 MB JPEG before base64 encoding so combined attachments fit comfortably.
// Skips resize for files already under MAX_BYTES — preserves PNG transparency, GIF animation, etc.

const MAX_BYTES = 1.5 * 1024 * 1024;       // resize target
const MAX_DIM = 2048;                       // max width or height after resize
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;  // refuse to even try anything bigger
const QUALITIES = [0.92, 0.85, 0.75, 0.6, 0.45]; // first attempt is gentler for logos/text-heavy

// 4.0 MB cap — well under Vercel's 4.5 MB gateway limit
export const MAX_COMBINED_BODY_BYTES = 4 * 1024 * 1024;

function isHeicByExtension(name = '') {
  return /\.(heic|heif)$/i.test(name);
}

async function isHeicByContent(file) {
  // HEIC/HEIF files have 'ftypheic' / 'ftypheix' / 'ftypmif1' / 'ftyphevc' / 'ftyphevx' at byte offset 4-12
  try {
    const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const sig = String.fromCharCode(...head.slice(4, 12));
    return /^ftyp(heic|heix|mif1|hevc|hevx)/.test(sig);
  } catch {
    return false;
  }
}

async function decodeImage(file) {
  // Modern path
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch { /* fall through to Image-element path */ }
  }
  // Fallback: works on older Safari and for some formats createImageBitmap rejects
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('image failed to decode'));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function resizeImageForUpload(file) {
  if (!file) throw new Error('no file provided');
  if (file.size > MAX_SOURCE_BYTES) {
    throw new Error(`Image is too large (${(file.size / 1024 / 1024).toFixed(0)} MB). Reduce to under 20 MB before uploading.`);
  }
  if (isHeicByExtension(file.name) || (await isHeicByContent(file))) {
    throw new Error("HEIC images aren't supported. Convert to JPEG or PNG first.");
  }
  // Skip resize for already-small files — preserves PNG transparency, GIF animation, etc.
  if (file.size <= MAX_BYTES) return file;

  const img = await decodeImage(file);
  let width = img.width;
  let height = img.height;
  if (width > MAX_DIM || height > MAX_DIM) {
    const scale = MAX_DIM / Math.max(width, height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, width, height);

  for (const q of QUALITIES) {
    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', q));
    if (blob && blob.size <= MAX_BYTES) {
      return new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' });
    }
  }
  // Fallback: return last attempt even if slightly over (still smaller than original)
  const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', QUALITIES[QUALITIES.length - 1]));
  if (!blob) throw new Error('failed to encode resized image');
  return new File([blob], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' });
}

// Estimate the JSON body size if these files are sent inline as base64.
// Conservative: includes a generous overhead buffer for JSON wrapper, mime fields, escaping.
export function estimateBase64BodyBytes(files) {
  const overhead = 200 * 1024;
  return overhead + files.reduce((sum, f) => sum + (f ? Math.ceil(f.size * 4 / 3) : 0), 0);
}

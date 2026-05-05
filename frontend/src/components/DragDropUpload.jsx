import { useState, useRef, useCallback } from 'react';
import { api } from '../api';
import { canExtractDocumentInBrowser, extractDocumentTextInBrowser } from '../utils/clientDocumentExtractor';

const DEFAULT_MAX_UPLOAD_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_BROWSER_BYTES = 25 * 1024 * 1024;

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '0 bytes';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

/**
 * Reusable drag-and-drop + click file upload component.
 * Extracts document text via the backend /upload/extract-text endpoint.
 *
 * @param {object} props
 * @param {(result: { text: string, filename: string, charCount: number }) => void} props.onTextExtracted
 *   Called after the file is uploaded and text is extracted
 * @param {boolean} [props.disabled] - Disable the upload area
 * @param {string} [props.label] - Main label text (default: "Drop your file here")
 * @param {string} [props.sublabel] - Sublabel text
 * @param {string} [props.accept] - File accept types
 * @param {number} [props.maxFileBytes] - Client-side upload size limit
 * @param {number} [props.maxBrowserFileBytes] - Local extraction size limit
 * @param {boolean} [props.preferBrowserExtraction] - Extract supported files locally before uploading
 * @param {'default'|'uploading'|'success'} [props.status] - External status override
 * @param {string} [props.successMessage] - Message shown in success state
 * @param {string} [props.className] - Additional CSS classes for the container
 * @param {boolean} [props.compact] - Use a more compact layout
 */
export default function DragDropUpload({
  onTextExtracted,
  disabled = false,
  label = 'Drop your file here, or click to browse',
  sublabel = 'PDF, DOCX, EPUB, MOBI, TXT, HTML, or Markdown',
  accept = '.pdf,.docx,.epub,.mobi,.txt,.html,.htm,.md',
  status: externalStatus,
  successMessage,
  className = '',
  compact = false,
  maxFileBytes = DEFAULT_MAX_UPLOAD_BYTES,
  maxBrowserFileBytes = DEFAULT_MAX_BROWSER_BYTES,
  preferBrowserExtraction = true
}) {
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState(null);
  const [error, setError] = useState('');
  const [errorDetails, setErrorDetails] = useState('');
  const [recoverySteps, setRecoverySteps] = useState([]);
  const fileInputRef = useRef(null);

  const status = externalStatus || (uploading ? 'uploading' : uploadResult ? 'success' : 'default');

  const validateFile = useCallback((file) => {
    const ext = file.name.includes('.') ? `.${file.name.split('.').pop().toLowerCase()}` : '';
    const allowed = accept.split(',').map(item => item.trim().toLowerCase()).filter(Boolean);

    if (!allowed.includes(ext)) {
      return `File type ${ext || '(none)'} is not supported. Upload one of: ${accept}.`;
    }

    const canUseBrowser = preferBrowserExtraction && canExtractDocumentInBrowser(file);
    const effectiveLimit = canUseBrowser ? maxBrowserFileBytes : maxFileBytes;
    if (file.size > effectiveLimit) {
      return canUseBrowser
        ? `This file is ${formatBytes(file.size)}, which is too large to read safely in your browser. Use a file under ${formatBytes(effectiveLimit)}, split/compress the PDF, or paste the text manually.`
        : `This file is ${formatBytes(file.size)}, which is too large for a reliable upload. Use a file under ${formatBytes(effectiveLimit)}, split/compress the PDF, or paste the text manually.`;
    }

    return '';
  }, [accept, maxBrowserFileBytes, maxFileBytes, preferBrowserExtraction]);

  const processFile = useCallback(async (file) => {
    if (!file) return;
    const validationError = validateFile(file);
    if (validationError) {
      setError(validationError);
      setErrorDetails('');
      setRecoverySteps([]);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    setUploading(true);
    setError('');
    setErrorDetails('');
    setRecoverySteps([]);
    setUploadResult(null);

    try {
      const result = preferBrowserExtraction && canExtractDocumentInBrowser(file)
        ? await extractDocumentTextInBrowser(file)
        : await api.extractText(file);
      setUploadResult({ name: result.filename, charCount: result.charCount });
      onTextExtracted(result);
    } catch (err) {
      setError(err.message || 'Failed to extract text from file');
      setErrorDetails(err.technical_details || (err.details ? String(err.details) : ''));
      setRecoverySteps(Array.isArray(err.manual_recovery_steps) ? err.manual_recovery_steps : []);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [onTextExtracted, preferBrowserExtraction, validateFile]);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!disabled && !uploading) setDragOver(true);
  }, [disabled, uploading]);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);

    if (disabled || uploading) return;

    const file = e.dataTransfer?.files?.[0];
    if (file) {
      processFile(file);
    }
  }, [disabled, uploading, processFile]);

  const handleClick = useCallback(() => {
    if (!disabled && !uploading) {
      fileInputRef.current?.click();
    }
  }, [disabled, uploading]);

  const handleFileChange = useCallback((e) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
  }, [processFile]);

  const borderColor =
    dragOver ? 'border-ed-accent bg-ed-accent/5' :
    status === 'uploading' ? 'border-ed-accent/50 bg-ed-accent/5' :
    status === 'success' ? 'border-ed-green/40 bg-ed-green/5' :
    error ? 'border-red-300 bg-red-50' :
    'border-gray-300 hover:border-ed-accent hover:bg-ed-bg';

  return (
    <div className={className}>
      <div
        onClick={handleClick}
        onDragOver={handleDragOver}
        onDragEnter={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`border-2 border-dashed rounded-lg transition-all cursor-pointer ${borderColor} ${
          compact ? 'p-4' : 'p-6'
        } ${disabled || uploading ? 'opacity-60 cursor-not-allowed' : ''}`}
      >
        <div className="text-center">
          {status === 'uploading' ? (
            <div>
              <div className={`mx-auto mb-2 ${compact ? 'text-lg' : 'text-2xl'}`}>
                <span className="animate-spin inline-block">⏳</span>
              </div>
              <p className={`text-ed-accent font-medium ${compact ? 'text-xs' : 'text-sm'}`}>
                Extracting text...
              </p>
              <p className={`text-ed-accent/70 mt-1 ${compact ? 'text-[10px]' : 'text-xs'}`}>
                Supported PDFs and documents are read in your browser first.
              </p>
            </div>
          ) : status === 'success' ? (
            <div>
              <div className={`mx-auto mb-2 ${compact ? 'text-lg' : 'text-2xl'}`}>✅</div>
              {successMessage ? (
                <p className={`text-ed-green font-medium ${compact ? 'text-xs' : 'text-sm'}`}>
                  {successMessage}
                </p>
              ) : uploadResult ? (
                <>
                  <p className={`text-ed-green font-medium ${compact ? 'text-xs' : 'text-sm'}`}>
                    {uploadResult.name}
                  </p>
                  <p className={`text-ed-green/80 mt-1 ${compact ? 'text-[10px]' : 'text-xs'}`}>
                    {uploadResult.charCount.toLocaleString()} characters extracted
                  </p>
                </>
              ) : null}
              <p className={`text-gray-400 mt-2 ${compact ? 'text-[10px]' : 'text-xs'}`}>
                Drop another file or click to replace
              </p>
            </div>
          ) : (
            <div>
              <div className={`mx-auto mb-2 text-gray-400 ${compact ? 'text-lg' : 'text-2xl'}`}>
                {dragOver ? '📂' : '📄'}
              </div>
              <p className={`font-medium ${compact ? 'text-xs' : 'text-sm'} ${
                dragOver ? 'text-ed-accent' : 'text-ed-ink2'
              }`}>
                {dragOver ? 'Drop file here' : label}
              </p>
              <p className={`text-gray-400 mt-1 ${compact ? 'text-[10px]' : 'text-xs'}`}>
                {sublabel}
              </p>
              <p className={`text-gray-400 mt-1 ${compact ? 'text-[10px]' : 'text-xs'}`}>
                Browser-read files up to {formatBytes(maxBrowserFileBytes)}. Backend fallback max: {formatBytes(maxFileBytes)}.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept={accept}
        onChange={handleFileChange}
        className="hidden"
      />

      {/* Error message */}
      {error && (
        <div className="mt-2 space-y-1">
          <p className="text-xs text-red-600">{error}</p>
          {recoverySteps.length > 0 && (
            <ol className="list-decimal list-inside space-y-0.5 text-[11px] text-ed-ink2">
              {recoverySteps.map((step, idx) => (
                <li key={`${idx}-${step}`}>{step}</li>
              ))}
            </ol>
          )}
          {errorDetails && (
            <details className="text-[11px] text-ed-ink3">
              <summary className="cursor-pointer">Details</summary>
              <p className="mt-1 break-words">{errorDetails}</p>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

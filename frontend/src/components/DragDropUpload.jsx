import { useState, useRef, useCallback } from 'react';
import { api } from '../api';

/**
 * Reusable drag-and-drop + click file upload component.
 * Supports PDF, TXT, HTML files. Extracts text via the backend /upload/extract-text endpoint.
 *
 * @param {object} props
 * @param {(result: { text: string, filename: string, charCount: number }) => void} props.onTextExtracted
 *   Called after the file is uploaded and text is extracted
 * @param {boolean} [props.disabled] - Disable the upload area
 * @param {string} [props.label] - Main label text (default: "Drop your file here")
 * @param {string} [props.sublabel] - Sublabel text (default: "PDF, TXT, or HTML")
 * @param {string} [props.accept] - File accept types (default: ".pdf,.txt,.html,.htm")
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
  compact = false
}) {
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState(null);
  const [error, setError] = useState('');
  const fileInputRef = useRef(null);

  const status = externalStatus || (uploading ? 'uploading' : uploadResult ? 'success' : 'default');

  const processFile = useCallback(async (file) => {
    if (!file) return;
    setUploading(true);
    setError('');
    setUploadResult(null);

    try {
      const result = await api.extractText(file);
      setUploadResult({ name: result.filename, charCount: result.charCount });
      onTextExtracted(result);
    } catch (err) {
      setError(err.message || 'Failed to extract text from file');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [onTextExtracted]);

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
      // Validate file type
      const ext = '.' + file.name.split('.').pop().toLowerCase();
      const allowed = accept.split(',');
      if (!allowed.includes(ext)) {
        setError(`File type ${ext} not supported. Use ${accept}`);
        return;
      }
      processFile(file);
    }
  }, [disabled, uploading, accept, processFile]);

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
    dragOver ? 'border-gold bg-gold/5' :
    status === 'uploading' ? 'border-gold/50 bg-gold/5' :
    status === 'success' ? 'border-teal/40 bg-teal/5' :
    error ? 'border-red-300 bg-red-50' :
    'border-gray-300 hover:border-gold hover:bg-offwhite';

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
              <p className={`text-gold font-medium ${compact ? 'text-xs' : 'text-sm'}`}>
                Extracting text...
              </p>
              <p className={`text-gold/70 mt-1 ${compact ? 'text-[10px]' : 'text-xs'}`}>
                This may take a moment for large PDFs
              </p>
            </div>
          ) : status === 'success' ? (
            <div>
              <div className={`mx-auto mb-2 ${compact ? 'text-lg' : 'text-2xl'}`}>✅</div>
              {successMessage ? (
                <p className={`text-teal font-medium ${compact ? 'text-xs' : 'text-sm'}`}>
                  {successMessage}
                </p>
              ) : uploadResult ? (
                <>
                  <p className={`text-teal font-medium ${compact ? 'text-xs' : 'text-sm'}`}>
                    {uploadResult.name}
                  </p>
                  <p className={`text-teal/80 mt-1 ${compact ? 'text-[10px]' : 'text-xs'}`}>
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
                dragOver ? 'text-gold' : 'text-textmid'
              }`}>
                {dragOver ? 'Drop file here' : label}
              </p>
              <p className={`text-gray-400 mt-1 ${compact ? 'text-[10px]' : 'text-xs'}`}>
                {sublabel}
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
        <p className="text-xs text-red-600 mt-2">{error}</p>
      )}
    </div>
  );
}

import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../api';
import InfoTooltip from './InfoTooltip';

/**
 * Unified Templates tab — shows both:
 * 1. Drive Templates (synced from a Google Drive folder — the default pool for generation)
 * 2. Uploaded Templates (manually uploaded reference ads)
 */
export default function TemplateImages({ projectId, inspirationFolderId }) {
  // Drive-synced templates (formerly "Inspiration")
  const [driveImages, setDriveImages] = useState([]);
  const [loadingDrive, setLoadingDrive] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState(null);

  // Uploaded templates
  const [templates, setTemplates] = useState([]);
  const [loadingTemplates, setLoadingTemplates] = useState(true);
  const [uploading, setUploading] = useState(false);

  // Shared
  const [error, setError] = useState('');
  const [viewImage, setViewImage] = useState(null);
  const [editingDesc, setEditingDesc] = useState(null);
  const [descValue, setDescValue] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);

  useEffect(() => {
    loadTemplates();
    if (inspirationFolderId) {
      loadDriveImages();
    } else {
      setLoadingDrive(false);
    }
  }, [projectId, inspirationFolderId]);

  // --- Drive templates ---
  const loadDriveImages = async () => {
    try {
      const data = await api.getInspirationImages(projectId);
      setDriveImages(data.images || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingDrive(false);
    }
  };

  const handleSync = async () => {
    setSyncing(true);
    setError('');
    setSyncResult(null);
    try {
      const result = await api.syncInspiration(projectId);
      setDriveImages(result.images || []);
      setSyncResult({ synced: result.synced, removed: result.removed, total: result.total });
      setTimeout(() => setSyncResult(null), 5000);
    } catch (err) {
      setError(err.message);
    } finally {
      setSyncing(false);
    }
  };

  // --- Uploaded templates ---
  const loadTemplates = async () => {
    try {
      const data = await api.getTemplates(projectId);
      setTemplates(data.templates || []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoadingTemplates(false);
    }
  };

  const handleUpload = useCallback(async (file) => {
    if (!file) return;
    const ext = '.' + file.name.split('.').pop().toLowerCase();
    const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
    if (!allowed.includes(ext)) {
      setError(`File type ${ext} not supported. Use JPG, PNG, WebP, or GIF.`);
      return;
    }
    setUploading(true);
    setError('');
    try {
      await api.uploadTemplate(projectId, file);
      await loadTemplates();
    } catch (err) {
      setError(err.message);
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [projectId]);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) handleUpload(file);
  }, [handleUpload]);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!uploading) setDragOver(true);
  }, [uploading]);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);

  const handleDelete = async (imageId) => {
    if (!confirm('Delete this template image? This cannot be undone.')) return;
    try {
      await api.deleteTemplate(projectId, imageId);
      setTemplates(prev => prev.filter(t => t.id !== imageId));
      if (viewImage?.id === imageId) setViewImage(null);
    } catch (err) {
      setError(err.message);
    }
  };

  const handleSaveDesc = async (imageId) => {
    try {
      await api.updateTemplate(projectId, imageId, descValue);
      setTemplates(prev => prev.map(t => t.id === imageId ? { ...t, description: descValue } : t));
      setEditingDesc(null);
    } catch (err) {
      setError(err.message);
    }
  };

  const isLoading = loadingDrive || loadingTemplates;

  if (isLoading) {
    return <div className="text-gray-400 text-center py-8 animate-pulse text-sm">Loading templates...</div>;
  }

  return (
    <div className="space-y-6">
      {/* Error */}
      {error && (
        <div className="p-3 bg-red-50/80 border border-red-200/60 text-red-600 text-[13px] rounded-xl">
          {error}
        </div>
      )}

      {/* Sync result */}
      {syncResult && (
        <div className="p-3 bg-green-50/80 border border-green-200/60 text-green-700 text-[13px] rounded-xl fade-in">
          Sync complete: {syncResult.total} images total
          {syncResult.synced > 0 && `, ${syncResult.synced} new`}
          {syncResult.removed > 0 && `, ${syncResult.removed} removed`}
        </div>
      )}

      {/* ===== SECTION 1: Drive Templates ===== */}
      <div className="card p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-[15px] font-semibold text-gray-900 tracking-tight mb-0.5 flex items-center gap-1">
              Drive Templates
              <InfoTooltip text="Reference images synced from Google Drive. These are used as the default template pool for AI ad generation." position="right" />
            </h3>
            <p className="text-[12px] text-gray-400">
              {inspirationFolderId
                ? `${driveImages.length} template${driveImages.length !== 1 ? 's' : ''} synced from Google Drive`
                : 'No Templates Folder configured'}
            </p>
          </div>
          {inspirationFolderId && (
            <button
              onClick={handleSync}
              disabled={syncing}
              className="btn-secondary text-[12px] flex items-center gap-1.5"
            >
              <svg className={`w-3.5 h-3.5 ${syncing ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99" />
              </svg>
              {syncing ? 'Syncing...' : 'Sync Now'}
            </button>
          )}
        </div>

        {!inspirationFolderId ? (
          <div className="p-6 bg-gray-50/50 border border-gray-200/60 rounded-xl text-center">
            <div className="w-10 h-10 mx-auto mb-2 rounded-xl bg-gray-100 flex items-center justify-center">
              <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.25 12.75V12A2.25 2.25 0 014.5 9.75h15A2.25 2.25 0 0121.75 12v.75m-8.69-6.44l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z" />
              </svg>
            </div>
            <p className="text-[13px] text-gray-500 font-medium mb-1">No Templates Folder</p>
            <p className="text-[11px] text-gray-400 max-w-sm mx-auto">
              Set a Templates Folder ID in the Overview tab to sync reference images from Google Drive. These are used as the default template pool for ad generation.
            </p>
          </div>
        ) : driveImages.length === 0 ? (
          <div className="p-6 bg-gray-50/50 border border-gray-200/60 rounded-xl text-center">
            <div className="w-10 h-10 mx-auto mb-2 rounded-xl bg-gray-100 flex items-center justify-center">
              <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5a2.25 2.25 0 002.25-2.25V6.75a2.25 2.25 0 00-2.25-2.25H3.75a2.25 2.25 0 00-2.25 2.25v12a2.25 2.25 0 002.25 2.25z" />
              </svg>
            </div>
            <p className="text-[13px] text-gray-500 font-medium mb-1">No Images Found</p>
            <p className="text-[11px] text-gray-400 max-w-sm mx-auto">
              Add images to your Google Drive templates folder, then click "Sync Now" to pull them in.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
            {driveImages.map(img => (
              <div
                key={img.id}
                className="group card overflow-hidden cursor-pointer transition-all duration-300 hover:-translate-y-0.5"
                onClick={() => setViewImage({ ...img, source: 'drive' })}
              >
                <div className="aspect-square bg-gray-50">
                  <img
                    src={img.thumbnailUrl}
                    alt={img.name}
                    className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-500"
                    loading="lazy"
                  />
                </div>
                <div className="p-2">
                  <p className="text-[11px] text-gray-600 truncate" title={img.name}>
                    {img.name}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ===== SECTION 2: Uploaded Templates ===== */}
      <div className="card p-6">
        <div className="mb-4">
          <h3 className="text-[15px] font-semibold text-gray-900 tracking-tight mb-0.5 flex items-center gap-1">
            Uploaded Templates
            <InfoTooltip text="Manually uploaded reference ad images. Use these as specific style guides for AI generation." position="right" />
          </h3>
          <p className="text-[12px] text-gray-400">
            {templates.length} uploaded template{templates.length !== 1 ? 's' : ''} — upload specific reference ads to recreate
          </p>
        </div>

        {/* Upload area */}
        <div
          onClick={() => !uploading && fileInputRef.current?.click()}
          onDragOver={handleDragOver}
          onDragEnter={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`border-2 border-dashed rounded-xl p-5 text-center cursor-pointer transition-all mb-4 ${
            dragOver ? 'border-blue-400 bg-blue-50/30' :
            uploading ? 'border-gray-200 bg-gray-50/50 opacity-60 cursor-not-allowed' :
            'border-gray-200/80 hover:border-blue-300 hover:bg-gray-50/30'
          }`}
        >
          {uploading ? (
            <div>
              <div className="w-8 h-8 mx-auto mb-2 rounded-lg bg-blue-100 flex items-center justify-center">
                <div className="w-4 h-4 rounded-full border-2 border-blue-200 border-t-blue-500 animate-spin" />
              </div>
              <p className="text-[13px] text-blue-600 font-medium">Uploading...</p>
            </div>
          ) : (
            <div>
              <div className="w-8 h-8 mx-auto mb-2 rounded-lg bg-gray-100 flex items-center justify-center">
                <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                </svg>
              </div>
              <p className={`text-[13px] font-medium ${dragOver ? 'text-blue-600' : 'text-gray-500'}`}>
                {dragOver ? 'Drop image here' : 'Drop a template image here, or click to browse'}
              </p>
              <p className="text-[10px] text-gray-400 mt-0.5">JPG, PNG, WebP, or GIF — up to 20MB</p>
            </div>
          )}
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".jpg,.jpeg,.png,.webp,.gif"
          onChange={e => { if (e.target.files?.[0]) handleUpload(e.target.files[0]); }}
          className="hidden"
        />

        {/* Uploaded templates grid */}
        {templates.length === 0 ? (
          <div className="text-center py-2">
            <p className="text-[11px] text-gray-400">
              Upload specific reference ads you want to recreate for your brand.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
            {templates.map(tmpl => (
              <div
                key={tmpl.id}
                className="group card overflow-hidden transition-all duration-300 hover:-translate-y-0.5"
              >
                <div
                  className="aspect-square bg-gray-50 cursor-pointer"
                  onClick={() => setViewImage({ ...tmpl, source: 'uploaded' })}
                >
                  <img
                    src={tmpl.thumbnailUrl}
                    alt={tmpl.filename}
                    className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-500"
                    loading="lazy"
                  />
                </div>
                <div className="p-2.5">
                  <p className="text-[11px] text-gray-700 font-medium truncate" title={tmpl.filename}>
                    {tmpl.filename}
                  </p>
                  {editingDesc === tmpl.id ? (
                    <div className="mt-1 flex gap-1">
                      <input
                        value={descValue}
                        onChange={e => setDescValue(e.target.value)}
                        className="flex-1 text-[11px] input-apple py-1 px-2"
                        placeholder="Add description..."
                        autoFocus
                        onKeyDown={e => {
                          if (e.key === 'Enter') handleSaveDesc(tmpl.id);
                          if (e.key === 'Escape') setEditingDesc(null);
                        }}
                      />
                      <button
                        onClick={() => handleSaveDesc(tmpl.id)}
                        className="text-[11px] text-blue-500 hover:text-blue-600 transition-colors"
                      >
                        Save
                      </button>
                    </div>
                  ) : (
                    <p
                      className="text-[11px] text-gray-400 mt-0.5 cursor-pointer hover:text-gray-600 transition-colors"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingDesc(tmpl.id);
                        setDescValue(tmpl.description || '');
                      }}
                    >
                      {tmpl.description || 'Click to add description...'}
                    </p>
                  )}
                  <div className="flex gap-2 mt-1.5">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditingDesc(tmpl.id);
                        setDescValue(tmpl.description || '');
                      }}
                      className="text-[11px] text-blue-500 hover:text-blue-600 transition-colors"
                    >
                      Edit
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDelete(tmpl.id); }}
                      className="text-[11px] text-red-500 hover:text-red-600 transition-colors"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Full-size image modal */}
      {viewImage && (
        <div
          className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          onClick={() => setViewImage(null)}
        >
          <div
            className="relative max-w-4xl max-h-[90vh] bg-white rounded-2xl overflow-hidden shadow-apple-xl fade-in"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b border-gray-200/60">
              <div>
                <p className="text-[14px] font-semibold text-gray-900">{viewImage.name || viewImage.filename}</p>
                {viewImage.description && (
                  <p className="text-[12px] text-gray-500">{viewImage.description}</p>
                )}
                <span className={`badge mt-1 ${viewImage.source === 'drive' ? 'bg-blue-100/80 text-blue-600' : 'bg-purple-100/80 text-purple-600'}`}>
                  {viewImage.source === 'drive' ? 'Drive' : 'Uploaded'}
                </span>
              </div>
              <div className="flex items-center gap-3">
                {viewImage.source === 'uploaded' && (
                  <button
                    onClick={() => handleDelete(viewImage.id)}
                    className="text-[12px] text-red-500 hover:text-red-600 transition-colors"
                  >
                    Delete
                  </button>
                )}
                <button
                  onClick={() => setViewImage(null)}
                  className="w-7 h-7 rounded-lg bg-gray-100 flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-200 transition-all"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
            </div>
            <div className="p-2 flex items-center justify-center bg-gray-50" style={{ maxHeight: 'calc(90vh - 80px)' }}>
              <img
                src={viewImage.thumbnailUrl}
                alt={viewImage.name || viewImage.filename}
                className="max-w-full max-h-[80vh] object-contain rounded-xl"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

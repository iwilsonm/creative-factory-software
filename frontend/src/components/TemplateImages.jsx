import { useState, useRef, useCallback } from 'react';
import { api } from '../api';
import InfoTooltip from './InfoTooltip';
import ConfirmDialog from './ConfirmDialog';
import { useAsyncData } from '../hooks/useAsyncData';

const ALLOWED_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
const MAX_FILE_BYTES = 20 * 1024 * 1024; // matches multer's 20 MB limit on the backend
const HARD_CAP_FILES = 1000;             // defensive ceiling against a stray "select all" of a Pictures folder
const UPLOAD_CONCURRENCY = 5;            // sliding-window: 5 in flight at any time

/**
 * Templates tab — direct multi-file upload (no Google Drive sync).
 * Up to 500 files at a time (HARD_CAP_FILES is the absolute ceiling), 5 in parallel.
 */
export default function TemplateImages({ projectId }) {
  // Uploaded templates (the only source — Drive sync was dropped)
  const { data: templates, setData: setTemplates, loading: loadingTemplates } = useAsyncData(
    () => api.getTemplates(projectId).then(d => d.templates || []),
    [projectId]
  );

  // Batch upload state
  const [batch, setBatch] = useState(null); // { total, completed, succeeded, failed: [{ name, reason }] }
  const abortRef = useRef(null);

  // Shared
  const [error, setError] = useState('');
  const [viewImage, setViewImage] = useState(null);
  const [editingDesc, setEditingDesc] = useState(null);
  const [descValue, setDescValue] = useState('');
  const [savingDescId, setSavingDescId] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [pendingDeleteImage, setPendingDeleteImage] = useState(null);
  const fileInputRef = useRef(null);

  const uploading = !!batch && batch.completed < batch.total;

  const handleBatchUpload = useCallback(async (rawFiles) => {
    setError('');
    const incoming = Array.from(rawFiles || []);
    if (incoming.length === 0) return;

    // Filter & collect skip reasons up front so the user sees rejections immediately.
    const accepted = [];
    const skipped = [];
    for (const f of incoming) {
      if (accepted.length >= HARD_CAP_FILES) {
        skipped.push({ name: f.name, reason: `over ${HARD_CAP_FILES}-file cap` });
        continue;
      }
      const ext = '.' + (f.name.split('.').pop() || '').toLowerCase();
      if (!ALLOWED_EXTS.includes(ext)) {
        skipped.push({ name: f.name, reason: 'unsupported format' });
        continue;
      }
      if (f.size > MAX_FILE_BYTES) {
        skipped.push({ name: f.name, reason: 'exceeds 20 MB limit' });
        continue;
      }
      accepted.push(f);
    }

    if (accepted.length === 0) {
      setBatch({ total: skipped.length, completed: skipped.length, succeeded: 0, failed: skipped });
      return;
    }

    const total = accepted.length + skipped.length;
    setBatch({ total, completed: skipped.length, succeeded: 0, failed: [...skipped] });

    abortRef.current = new AbortController();
    const signal = abortRef.current.signal;

    let cursor = 0;
    const next = () => (cursor < accepted.length ? accepted[cursor++] : null);

    const worker = async () => {
      while (!signal.aborted) {
        const file = next();
        if (!file) return;
        try {
          const created = await api.uploadTemplate(projectId, file, { signal });
          // Incremental gallery append — user watches the library fill up.
          setTemplates(prev => (prev ? [created, ...prev] : [created]));
          setBatch(b => b && { ...b, completed: b.completed + 1, succeeded: b.succeeded + 1 });
        } catch (err) {
          if (err?.name === 'AbortError' || signal.aborted) return; // silent on user cancel
          setBatch(b => b && {
            ...b,
            completed: b.completed + 1,
            failed: [...b.failed, { name: file.name, reason: err.message || 'upload failed' }]
          });
        }
      }
    };

    const workerCount = Math.min(UPLOAD_CONCURRENCY, accepted.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    abortRef.current = null;
    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [projectId, setTemplates]);

  const handleCancelUpload = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  const handleDismissBatchSummary = useCallback(() => setBatch(null), []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    if (e.dataTransfer?.files?.length) handleBatchUpload(e.dataTransfer.files);
  }, [handleBatchUpload]);

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

  const handleDelete = async () => {
    if (!pendingDeleteImage) return;
    try {
      await api.deleteTemplate(projectId, pendingDeleteImage.id);
      setTemplates(prev => prev.filter(t => t.id !== pendingDeleteImage.id));
      if (viewImage?.id === pendingDeleteImage.id) setViewImage(null);
      setPendingDeleteImage(null);
    } catch (err) {
      setError(err.message);
    }
  };

  const handleSaveDesc = async (imageId) => {
    setSavingDescId(imageId);
    try {
      await api.updateTemplate(projectId, imageId, descValue);
      setTemplates(prev => prev.map(t => t.id === imageId ? { ...t, description: descValue } : t));
      setEditingDesc(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setSavingDescId(null);
    }
  };

  if (loadingTemplates) {
    return <div className="text-textlight text-center py-8 animate-pulse text-sm">Loading templates...</div>;
  }

  const progressPct = batch && batch.total > 0 ? Math.round((batch.completed / batch.total) * 100) : 0;
  const batchDone = !!batch && batch.completed >= batch.total;

  return (
    <div className="space-y-6">
      {/* Error */}
      {error && (
        <div className="p-3 bg-red-50/80 border border-red-200/60 text-red-600 text-[13px] rounded-xl">
          {error}
        </div>
      )}

      {/* ===== Templates ===== */}
      <div className="card p-6">
        <div className="mb-4">
          <h3 className="text-[15px] font-semibold text-textdark tracking-tight mb-0.5 flex items-center gap-1">
            Templates
            <InfoTooltip text="Reference ad images used as style guides for AI ad generation. Upload up to 500 at a time." position="right" />
          </h3>
          <p className="text-[12px] text-textlight">
            {templates.length} template{templates.length !== 1 ? 's' : ''} uploaded
          </p>
        </div>

        {/* Upload area */}
        <div
          onClick={() => !uploading && fileInputRef.current?.click()}
          onDragOver={handleDragOver}
          onDragEnter={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`border-2 border-dashed rounded-xl p-5 text-center transition-all mb-4 ${
            uploading ? 'border-black/10 bg-offwhite cursor-default' :
            dragOver ? 'border-gold bg-gold/5 cursor-pointer' :
            'border-black/10 hover:border-gold hover:bg-offwhite cursor-pointer'
          }`}
        >
          {batch ? (
            <div className="space-y-3" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between text-[12px]">
                <span className="text-textmid font-medium">
                  {uploading ? 'Uploading…' : 'Upload complete'}
                </span>
                <span className="text-textlight">
                  {batch.completed} of {batch.total}
                  {batch.failed.length > 0 && <> · <span className="text-red-600">{batch.failed.length} failed</span></>}
                </span>
              </div>
              <div className="h-1.5 w-full bg-black/5 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gold transition-all duration-300"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
              <div className="flex items-center justify-end gap-2">
                {uploading ? (
                  <button onClick={handleCancelUpload} className="btn-secondary text-[12px]">Cancel</button>
                ) : (
                  <button onClick={handleDismissBatchSummary} className="btn-secondary text-[12px]">Dismiss</button>
                )}
              </div>
            </div>
          ) : (
            <div>
              <div className="w-8 h-8 mx-auto mb-2 rounded-lg bg-gray-100 flex items-center justify-center">
                <svg className="w-4 h-4 text-textlight" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                </svg>
              </div>
              <p className={`text-[13px] font-medium ${dragOver ? 'text-gold' : 'text-textmid'}`}>
                {dragOver ? 'Drop images here' : 'Drop up to 500 template images here, or click to browse'}
              </p>
              <p className="text-[10px] text-textlight mt-0.5">JPG, PNG, WebP, or GIF — up to 20 MB each</p>
            </div>
          )}
        </div>

        {/* Failure summary (only when batch is done AND there are failures) */}
        {batch && batchDone && batch.failed.length > 0 && (
          <div className="mb-4 p-3 bg-red-50/80 border border-red-200/60 rounded-xl">
            <p className="text-[12px] font-medium text-red-700 mb-1.5">
              {batch.failed.length} file{batch.failed.length !== 1 ? 's' : ''} failed
            </p>
            <ul className="text-[11px] text-red-600 space-y-0.5 max-h-40 overflow-y-auto">
              {batch.failed.map((f, i) => (
                <li key={i} className="truncate" title={`${f.name} — ${f.reason}`}>
                  <span className="font-medium">{f.name}</span> — {f.reason}
                </li>
              ))}
            </ul>
            <p className="text-[10px] text-red-500 mt-1.5">To retry, re-select these files and upload again.</p>
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept=".jpg,.jpeg,.png,.webp,.gif"
          multiple
          onChange={e => { if (e.target.files?.length) handleBatchUpload(e.target.files); }}
          className="hidden"
        />

        {/* Templates grid */}
        {templates.length === 0 ? (
          <div className="text-center py-2">
            <p className="text-[11px] text-textlight">
              Upload reference ads you want the AI to use as style guides.
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
                  onClick={() => setViewImage(tmpl)}
                >
                  <img
                    src={tmpl.thumbnailUrl}
                    alt={tmpl.filename}
                    className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-500"
                    loading="lazy"
                  />
                </div>
                <div className="p-2.5">
                  <p className="text-[11px] text-textdark font-medium truncate" title={tmpl.filename}>
                    {tmpl.filename}
                  </p>
                  {editingDesc === tmpl.id ? (
                    <div className="mt-1 space-y-2">
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
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => handleSaveDesc(tmpl.id)}
                          disabled={savingDescId === tmpl.id}
                          className="btn-primary text-[11px] px-3 py-1 disabled:opacity-50"
                        >
                          {savingDescId === tmpl.id ? 'Saving...' : 'Save'}
                        </button>
                        <button
                          onClick={() => setEditingDesc(null)}
                          disabled={savingDescId === tmpl.id}
                          className="btn-secondary text-[11px] px-3 py-1 disabled:opacity-50"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p
                      className="text-[11px] text-textlight mt-0.5 cursor-pointer hover:text-textmid transition-colors"
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
                      className="action-link"
                    >
                      Edit
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); setPendingDeleteImage(tmpl); }}
                      className="action-link-danger"
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
            className="relative max-w-4xl max-h-[90vh] bg-white rounded-2xl overflow-hidden shadow-card-hover fade-in"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b border-gray-200/60">
              <div>
                <p className="text-[14px] font-semibold text-textdark">{viewImage.filename || viewImage.name}</p>
                {viewImage.description && (
                  <p className="text-[12px] text-textmid">{viewImage.description}</p>
                )}
              </div>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setPendingDeleteImage(viewImage)}
                  className="action-link-danger"
                >
                  Delete
                </button>
                <button
                  onClick={() => setViewImage(null)}
                  className="w-7 h-7 rounded-lg bg-black/5 flex items-center justify-center text-textlight hover:text-textmid hover:bg-black/10 transition-all"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
            </div>
            <div className="p-2 flex items-center justify-center bg-offwhite" style={{ maxHeight: 'calc(90vh - 80px)' }}>
              <img
                src={viewImage.thumbnailUrl}
                alt={viewImage.name || viewImage.filename}
                className="max-w-full max-h-[80vh] object-contain rounded-xl"
              />
            </div>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={!!pendingDeleteImage}
        title="Delete template image?"
        message="This removes the uploaded template image permanently. This action cannot be undone."
        confirmLabel="Delete Image"
        onCancel={() => setPendingDeleteImage(null)}
        onConfirm={handleDelete}
      />
    </div>
  );
}

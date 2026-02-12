import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../api';
import InfoTooltip from './InfoTooltip';
import { useToast } from './Toast';

// Template source options (same as AdStudio)
const TEMPLATE_RANDOM = 'random';
const TEMPLATE_UPLOAD = 'upload';
const TEMPLATE_SELECT = 'select';

const ASPECT_RATIOS = [
  { value: '1:1', label: '1:1 (Square)' },
  { value: '9:16', label: '9:16 (Story)' },
  { value: '16:9', label: '16:9 (Landscape)' },
  { value: '4:5', label: '4:5 (Portrait)' }
];

const CRON_PRESETS = [
  { value: '', label: 'Custom' },
  { value: '0 */6 * * *', label: 'Every 6 hours' },
  { value: '0 */12 * * *', label: 'Every 12 hours' },
  { value: '0 9 * * *', label: 'Daily at 9 AM' },
  { value: '0 9 * * 1-5', label: 'Weekdays at 9 AM' },
  { value: '0 9 * * 1', label: 'Weekly (Monday 9 AM)' }
];

const STATUS_COLORS = {
  pending: 'bg-gray-100/80 text-gray-600',
  generating_prompts: 'bg-blue-100/80 text-blue-600',
  submitting: 'bg-blue-100/80 text-blue-600',
  processing: 'bg-amber-100/80 text-amber-700',
  completed: 'bg-green-100/80 text-green-700',
  failed: 'bg-red-100/80 text-red-600'
};

const STATUS_LABELS = {
  pending: 'Pending',
  generating_prompts: 'Generating Prompts',
  submitting: 'Submitting',
  processing: 'Processing',
  completed: 'Completed',
  failed: 'Failed'
};

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now - d;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString();
}

export default function BatchManager({ projectId, project, onBatchComplete }) {
  const toast = useToast();
  const [expanded, setExpanded] = useState(false);
  const [batches, setBatches] = useState([]);
  const [loading, setLoading] = useState(false);

  // Create form
  const [batchSize, setBatchSize] = useState(5);
  const [batchAngle, setBatchAngle] = useState('');
  const [batchAspectRatio, setBatchAspectRatio] = useState('1:1');
  const [isScheduled, setIsScheduled] = useState(false);
  const [cronPreset, setCronPreset] = useState('0 9 * * *');
  const [customCron, setCustomCron] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  // Template source
  const [templateSource, setTemplateSource] = useState(TEMPLATE_RANDOM);
  const [driveImages, setDriveImages] = useState([]);
  const [uploadedTemplates, setUploadedTemplates] = useState([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState(null); // { id, source }

  // Upload one-off template
  const [uploadedFile, setUploadedFile] = useState(null);
  const [uploadedPreview, setUploadedPreview] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);

  // Product image for batch
  const [batchProductFile, setBatchProductFile] = useState(null);
  const [batchProductPreview, setBatchProductPreview] = useState(null);
  const [batchProductDragOver, setBatchProductDragOver] = useState(false);
  const batchProductInputRef = useRef(null);

  // Queue state
  const [queue, setQueue] = useState([]);
  const [submittingQueue, setSubmittingQueue] = useState(false);

  const pollRef = useRef(null);

  // Load batches when expanded
  useEffect(() => {
    if (expanded) {
      loadBatches();
    }
  }, [expanded, projectId]);

  // Poll for active batches every 30s when expanded
  useEffect(() => {
    if (expanded) {
      pollRef.current = setInterval(() => {
        loadBatches(true);
      }, 30000);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [expanded, projectId]);

  // Load templates when "Pick Template" is selected
  useEffect(() => {
    if (templateSource === TEMPLATE_SELECT && driveImages.length === 0 && uploadedTemplates.length === 0) {
      loadTemplates();
    }
  }, [templateSource]);

  const loadTemplates = async () => {
    setLoadingTemplates(true);
    try {
      const [driveData, uploadedData] = await Promise.all([
        api.getInspirationImages(projectId).catch(() => ({ images: [] })),
        api.getTemplates(projectId).catch(() => ({ templates: [] }))
      ]);
      setDriveImages(driveData.images || []);
      setUploadedTemplates(uploadedData.templates || []);
    } catch (err) {
      console.error('Failed to load templates:', err);
    } finally {
      setLoadingTemplates(false);
    }
  };

  // File upload handlers for Manual Upload
  const handleFileSelected = useCallback((file) => {
    if (!file) return;
    const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
    const ext = '.' + file.name.split('.').pop().toLowerCase();
    if (!allowed.includes(ext)) {
      setCreateError(`File type ${ext} not supported. Use JPG, PNG, WebP, or GIF.`);
      return;
    }
    setUploadedFile(file);
    setUploadedPreview(URL.createObjectURL(file));
    setTemplateSource(TEMPLATE_UPLOAD);
    setCreateError('');
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFileSelected(file);
  }, [handleFileSelected]);

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);

  const clearUploadedImage = () => {
    setUploadedFile(null);
    if (uploadedPreview) URL.revokeObjectURL(uploadedPreview);
    setUploadedPreview(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // Product image handlers
  const handleBatchProductSelected = useCallback((file) => {
    if (!file) return;
    const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
    const ext = '.' + file.name.split('.').pop().toLowerCase();
    if (!allowed.includes(ext)) {
      setCreateError(`File type ${ext} not supported. Use JPG, PNG, WebP, or GIF.`);
      return;
    }
    setBatchProductFile(file);
    setBatchProductPreview(URL.createObjectURL(file));
  }, []);

  const handleBatchProductDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setBatchProductDragOver(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) handleBatchProductSelected(file);
  }, [handleBatchProductSelected]);

  const clearBatchProductImage = () => {
    setBatchProductFile(null);
    if (batchProductPreview) URL.revokeObjectURL(batchProductPreview);
    setBatchProductPreview(null);
    if (batchProductInputRef.current) batchProductInputRef.current.value = '';
  };

  // Helper to convert file to base64
  const fileToBase64 = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

  // Build batch config based on current template selection
  const buildBatchConfig = () => {
    const config = {
      batch_size: batchSize,
      angle: batchAngle || undefined,
      aspect_ratio: batchAspectRatio,
      scheduled: isScheduled,
      schedule_cron: isScheduled ? (cronPreset || customCron) : undefined,
      run_immediately: !isScheduled
    };

    if (templateSource === TEMPLATE_SELECT && selectedTemplate) {
      if (selectedTemplate.source === 'uploaded') {
        config.generation_mode = 'mode2';
        config.template_image_id = selectedTemplate.id;
      } else {
        // Drive template — still mode1 but with specific inspiration_image_id
        config.generation_mode = 'mode1';
        config.inspiration_image_id = selectedTemplate.id;
      }
    } else {
      config.generation_mode = 'mode1';
    }

    return config;
  };

  // Template source display label for queue items
  const getTemplateLabel = () => {
    if (templateSource === TEMPLATE_SELECT && selectedTemplate) {
      const source = selectedTemplate.source === 'drive' ? 'Drive' : 'Uploaded';
      return `${source} template`;
    }
    if (templateSource === TEMPLATE_UPLOAD && uploadedFile) {
      return `Upload: ${uploadedFile.name.slice(0, 15)}`;
    }
    return 'Random';
  };

  const loadBatches = async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const data = await api.getBatches(projectId);
      const prev = batches;
      setBatches(data.batches || []);

      // Check if any batch just completed
      if (onBatchComplete && prev.length > 0) {
        const newlyCompleted = (data.batches || []).some(b =>
          b.status === 'completed' && prev.find(p => p.id === b.id && p.status !== 'completed')
        );
        if (newlyCompleted) onBatchComplete();
      }
    } catch (err) {
      console.error('Failed to load batches:', err);
    } finally {
      if (!silent) setLoading(false);
    }
  };

  const handleCreate = async () => {
    // Validate template selection
    if (templateSource === TEMPLATE_UPLOAD && !uploadedFile) {
      setCreateError('Please upload a template image or switch to "Random Template".');
      return;
    }
    if (templateSource === TEMPLATE_SELECT && !selectedTemplate) {
      setCreateError('Please select a template image.');
      return;
    }

    setCreating(true);
    setCreateError('');

    try {
      const config = buildBatchConfig();

      // If manual upload, we need to upload the template first, then use mode2
      if (templateSource === TEMPLATE_UPLOAD && uploadedFile) {
        const uploaded = await api.uploadTemplate(projectId, uploadedFile, `Batch upload - ${uploadedFile.name}`);
        config.generation_mode = 'mode2';
        config.template_image_id = uploaded.template?.id || uploaded.id;
      }

      // Attach product image if provided
      if (batchProductFile) {
        const base64 = await fileToBase64(batchProductFile);
        config.product_image = base64;
        config.product_image_mime = batchProductFile.type || 'image/png';
      }

      await api.createBatch(projectId, config);

      // Reset form
      setBatchAngle('');
      setIsScheduled(false);
      await loadBatches();
    } catch (err) {
      setCreateError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const handleRunNow = async (batchId) => {
    try {
      await api.runBatch(projectId, batchId);
      toast.success('Batch started');
      await loadBatches();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const handleCancel = async (batchId) => {
    if (!confirm('Cancel this batch job?')) return;
    try {
      await api.cancelBatch(projectId, batchId);
      toast.success('Batch cancelled');
      await loadBatches();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const handleDelete = async (batchId) => {
    if (!confirm('Delete this batch job?')) return;
    try {
      await api.deleteBatch(projectId, batchId);
      setBatches(prev => prev.filter(b => b.id !== batchId));
      toast.success('Batch deleted');
    } catch (err) {
      toast.error(err.message);
    }
  };

  // Queue handlers
  const handleAddToQueue = () => {
    // Validate template selection
    if (templateSource === TEMPLATE_UPLOAD && !uploadedFile) {
      setCreateError('Please upload a template image or switch to "Random Template".');
      return;
    }
    if (templateSource === TEMPLATE_SELECT && !selectedTemplate) {
      setCreateError('Please select a template image.');
      return;
    }

    const cronExpression = cronPreset || customCron;
    const config = {
      id: Date.now(),
      batch_size: batchSize,
      angle: batchAngle || '',
      aspect_ratio: batchAspectRatio,
      scheduled: isScheduled,
      schedule_cron: isScheduled ? cronExpression : undefined,
      templateSource,
      templateLabel: getTemplateLabel(),
      selectedTemplate: selectedTemplate ? { ...selectedTemplate } : null,
      uploadedFile: templateSource === TEMPLATE_UPLOAD ? uploadedFile : null
    };
    setQueue(prev => [...prev, config]);
    setBatchAngle('');
    setIsScheduled(false);
  };

  const handleRemoveFromQueue = (tempId) => {
    setQueue(prev => prev.filter(item => item.id !== tempId));
  };

  const handleSubmitQueue = async () => {
    if (queue.length === 0) return;
    setSubmittingQueue(true);
    setCreateError('');

    try {
      for (const config of queue) {
        const batchConfig = {
          batch_size: config.batch_size,
          angle: config.angle || undefined,
          aspect_ratio: config.aspect_ratio,
          scheduled: config.scheduled,
          schedule_cron: config.schedule_cron,
          run_immediately: !config.scheduled
        };

        if (config.templateSource === TEMPLATE_SELECT && config.selectedTemplate) {
          if (config.selectedTemplate.source === 'uploaded') {
            batchConfig.generation_mode = 'mode2';
            batchConfig.template_image_id = config.selectedTemplate.id;
          } else {
            batchConfig.generation_mode = 'mode1';
            batchConfig.inspiration_image_id = config.selectedTemplate.id;
          }
        } else if (config.templateSource === TEMPLATE_UPLOAD && config.uploadedFile) {
          // Upload template first
          const uploaded = await api.uploadTemplate(projectId, config.uploadedFile, `Batch upload - ${config.uploadedFile.name}`);
          batchConfig.generation_mode = 'mode2';
          batchConfig.template_image_id = uploaded.template?.id || uploaded.id;
        } else {
          batchConfig.generation_mode = 'mode1';
        }

        await api.createBatch(projectId, batchConfig);
      }

      toast.success(`${queue.length} batch${queue.length !== 1 ? 'es' : ''} created`);
      setQueue([]);
      await loadBatches();
    } catch (err) {
      setCreateError(`Queue submission error: ${err.message}`);
    } finally {
      setSubmittingQueue(false);
    }
  };

  const activeBatches = batches.filter(b =>
    ['generating_prompts', 'submitting', 'processing', 'pending'].includes(b.status)
  );
  const completedBatches = batches.filter(b =>
    ['completed', 'failed'].includes(b.status)
  );

  return (
    <div className="card overflow-hidden">
      {/* Header — always visible */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between p-5 text-left hover:bg-gray-50/30 transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center shadow-sm">
            <svg className="w-4.5 h-4.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6.429 9.75L2.25 12l4.179 2.25m0-4.5l5.571 3 5.571-3m-11.142 0L2.25 7.5 12 2.25l9.75 5.25-4.179 2.25m0 0L12 12.75 6.429 9.75m11.142 0l4.179 2.25-9.75 5.25-9.75-5.25 4.179-2.25" />
            </svg>
          </div>
          <div>
            <h3 className="text-[15px] font-semibold text-gray-900 tracking-tight flex items-center gap-1">
              Batch Generation
              <InfoTooltip text="Create batches of ads using the Gemini Batch API at 50% cost savings. Batches run in the background and can be scheduled to repeat." position="right" />
            </h3>
            <p className="text-[12px] text-gray-400">
              Generate multiple ads at once via Gemini Batch API (50% cost savings)
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {activeBatches.length > 0 && (
            <span className="badge bg-blue-100/80 text-blue-600">
              {activeBatches.length} active
            </span>
          )}
          <svg
            className={`w-5 h-5 text-gray-400 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
            fill="none" stroke="currentColor" viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
          </svg>
        </div>
      </button>

      {/* Expandable content */}
      {expanded && (
        <div className="border-t border-gray-200/60 fade-in">
          {/* Create Batch Form */}
          <div className="p-5 border-b border-gray-100/80">
            <h4 className="text-[13px] font-semibold text-gray-700 mb-3">New Batch</h4>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
              {/* Batch size */}
              <div>
                <label className="block text-[11px] font-medium text-gray-500 mb-1">
                  Batch Size
                </label>
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={batchSize}
                  onChange={e => setBatchSize(Math.max(1, Math.min(50, parseInt(e.target.value) || 1)))}
                  disabled={creating}
                  className="input-apple"
                />
                <p className="text-[10px] text-gray-400 mt-0.5">1-50 images</p>
              </div>

              {/* Aspect ratio */}
              <div>
                <label className="block text-[11px] font-medium text-gray-500 mb-1">
                  Aspect Ratio
                </label>
                <select
                  value={batchAspectRatio}
                  onChange={e => setBatchAspectRatio(e.target.value)}
                  disabled={creating}
                  className="input-apple"
                >
                  {ASPECT_RATIOS.map(ar => (
                    <option key={ar.value} value={ar.value}>{ar.label}</option>
                  ))}
                </select>
              </div>

              {/* Angle */}
              <div>
                <label className="block text-[11px] font-medium text-gray-500 mb-1">
                  Ad Topic / Angle <span className="text-gray-300">(opt.)</span>
                </label>
                <input
                  value={batchAngle}
                  onChange={e => setBatchAngle(e.target.value)}
                  disabled={creating}
                  placeholder='e.g., "before & after"'
                  className="input-apple"
                />
              </div>
            </div>

            {/* Template Source */}
            <div className="mb-3">
              <label className="block text-[11px] font-medium text-gray-500 mb-1.5">
                Template Image
              </label>
              <div className="segmented-control mb-2">
                <button
                  onClick={() => setTemplateSource(TEMPLATE_RANDOM)}
                  className={templateSource === TEMPLATE_RANDOM ? 'active' : ''}
                  disabled={creating}
                >
                  Random Template
                </button>
                <button
                  onClick={() => setTemplateSource(TEMPLATE_UPLOAD)}
                  className={templateSource === TEMPLATE_UPLOAD ? 'active' : ''}
                  disabled={creating}
                >
                  Manual Upload
                </button>
                <button
                  onClick={() => setTemplateSource(TEMPLATE_SELECT)}
                  className={templateSource === TEMPLATE_SELECT ? 'active' : ''}
                  disabled={creating}
                >
                  Pick Template
                </button>
              </div>

              {/* Random */}
              {templateSource === TEMPLATE_RANDOM && (
                <div className="p-3 bg-gray-50/50 border border-gray-200/60 rounded-xl">
                  <p className="text-[11px] text-gray-500">
                    Each ad in the batch will use a <strong>different random template</strong> from your synced Google Drive templates folder.
                  </p>
                </div>
              )}

              {/* Manual Upload */}
              {templateSource === TEMPLATE_UPLOAD && (
                <div>
                  {uploadedFile && uploadedPreview ? (
                    <div className="flex items-center gap-3 p-3 bg-gray-50/50 border border-gray-200/60 rounded-xl">
                      <img
                        src={uploadedPreview}
                        alt="Uploaded template"
                        className="w-14 h-14 object-cover rounded-lg border border-gray-200/60"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-[12px] font-medium text-gray-900 truncate">{uploadedFile.name}</p>
                        <p className="text-[10px] text-gray-400">{(uploadedFile.size / 1024).toFixed(0)} KB — all ads in batch use this template</p>
                      </div>
                      <button
                        onClick={clearUploadedImage}
                        disabled={creating}
                        className="text-[11px] text-red-400 hover:text-red-500 transition-colors"
                      >
                        Remove
                      </button>
                    </div>
                  ) : (
                    <div
                      onClick={() => !creating && fileInputRef.current?.click()}
                      onDragOver={handleDragOver}
                      onDragEnter={handleDragOver}
                      onDragLeave={handleDragLeave}
                      onDrop={handleDrop}
                      className={`border-2 border-dashed rounded-xl p-4 text-center cursor-pointer transition-all ${
                        dragOver ? 'border-blue-400 bg-blue-50/30' :
                        'border-gray-200/80 hover:border-blue-300 hover:bg-gray-50/30'
                      }`}
                    >
                      <p className={`text-[12px] font-medium ${dragOver ? 'text-blue-600' : 'text-gray-500'}`}>
                        {dragOver ? 'Drop image here' : 'Drop a template image, or click to browse'}
                      </p>
                      <p className="text-[10px] text-gray-400 mt-0.5">JPG, PNG, WebP, or GIF — all ads in batch use this template</p>
                    </div>
                  )}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".jpg,.jpeg,.png,.webp,.gif"
                    onChange={e => { if (e.target.files?.[0]) handleFileSelected(e.target.files[0]); }}
                    className="hidden"
                  />
                </div>
              )}

              {/* Pick Template */}
              {templateSource === TEMPLATE_SELECT && (
                <div>
                  {loadingTemplates ? (
                    <div className="text-gray-400 text-center py-6 text-[12px]">Loading templates...</div>
                  ) : driveImages.length === 0 && uploadedTemplates.length === 0 ? (
                    <div className="p-4 bg-gray-50/50 border border-gray-200/60 rounded-xl text-center">
                      <p className="text-[12px] text-gray-500 font-medium mb-0.5">No Templates Available</p>
                      <p className="text-[10px] text-gray-400">
                        Sync your Google Drive templates folder or upload templates in the Template Library tab.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {driveImages.length > 0 && (
                        <div>
                          <p className="text-[10px] text-gray-400 font-medium mb-1.5">
                            Drive Templates <span className="text-gray-300">({driveImages.length})</span>
                          </p>
                          <div className="grid grid-cols-5 sm:grid-cols-6 md:grid-cols-8 gap-1.5 max-h-[200px] overflow-y-auto rounded-lg pr-1 scrollbar-thin">
                            {driveImages.map(img => {
                              const isSelected = selectedTemplate?.id === img.id && selectedTemplate?.source === 'drive';
                              return (
                                <button
                                  key={`drive-${img.id}`}
                                  onClick={() => setSelectedTemplate(
                                    isSelected ? null : { id: img.id, source: 'drive' }
                                  )}
                                  disabled={creating}
                                  className={`group relative rounded-lg overflow-hidden border-2 transition-all aspect-square ${
                                    isSelected
                                      ? 'border-blue-500 ring-2 ring-blue-200 shadow-md'
                                      : 'border-gray-200/60 hover:border-gray-300'
                                  } cursor-pointer`}
                                >
                                  <img
                                    src={img.thumbnailUrl}
                                    alt={img.name || img.id}
                                    className="w-full h-full object-cover"
                                    loading="lazy"
                                  />
                                  {isSelected && (
                                    <div className="absolute top-1 right-1 w-4 h-4 rounded-full bg-blue-500 flex items-center justify-center shadow-sm">
                                      <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                                      </svg>
                                    </div>
                                  )}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}
                      {uploadedTemplates.length > 0 && (
                        <div>
                          <p className="text-[10px] text-gray-400 font-medium mb-1.5">
                            Uploaded Templates <span className="text-gray-300">({uploadedTemplates.length})</span>
                          </p>
                          <div className="grid grid-cols-5 sm:grid-cols-6 md:grid-cols-8 gap-1.5">
                            {uploadedTemplates.map(t => {
                              const isSelected = selectedTemplate?.id === t.id && selectedTemplate?.source === 'uploaded';
                              return (
                                <button
                                  key={`uploaded-${t.id}`}
                                  onClick={() => setSelectedTemplate(
                                    isSelected ? null : { id: t.id, source: 'uploaded' }
                                  )}
                                  disabled={creating}
                                  className={`group relative rounded-lg overflow-hidden border-2 transition-all aspect-square ${
                                    isSelected
                                      ? 'border-blue-500 ring-2 ring-blue-200 shadow-md'
                                      : 'border-gray-200/60 hover:border-gray-300'
                                  } cursor-pointer`}
                                >
                                  <img
                                    src={t.thumbnailUrl}
                                    alt={t.description || t.filename}
                                    className="w-full h-full object-cover"
                                    loading="lazy"
                                  />
                                  {isSelected && (
                                    <div className="absolute top-1 right-1 w-4 h-4 rounded-full bg-blue-500 flex items-center justify-center shadow-sm">
                                      <svg className="w-2.5 h-2.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                                      </svg>
                                    </div>
                                  )}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  {selectedTemplate && (
                    <div className="mt-2 flex items-center gap-2">
                      <span className="text-[11px] text-blue-600 font-medium">
                        Selected: {selectedTemplate.source === 'drive' ? 'Drive' : 'Uploaded'} template
                      </span>
                      <span className="text-[10px] text-gray-400">— all ads in batch use this template</span>
                      <button
                        onClick={() => setSelectedTemplate(null)}
                        disabled={creating}
                        className="text-[11px] text-gray-400 hover:text-gray-600 transition-colors"
                      >
                        Clear
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Product Image */}
            <div className="mb-3">
              <label className="block text-[11px] font-medium text-gray-500 mb-1.5">
                Product Image
              </label>
              {batchProductFile && batchProductPreview ? (
                <div className="flex items-center gap-3 p-3 bg-gray-50/50 border border-gray-200/60 rounded-xl">
                  <img
                    src={batchProductPreview}
                    alt="Product image"
                    className="w-12 h-12 object-cover rounded-lg border border-gray-200/60"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-[12px] font-medium text-gray-900 truncate">{batchProductFile.name}</p>
                    <p className="text-[10px] text-gray-400">{(batchProductFile.size / 1024).toFixed(0)} KB — used for all ads in batch</p>
                  </div>
                  <button
                    onClick={clearBatchProductImage}
                    disabled={creating}
                    className="text-[11px] text-red-400 hover:text-red-500 transition-colors"
                  >
                    Remove
                  </button>
                </div>
              ) : (
                <div
                  onClick={() => !creating && batchProductInputRef.current?.click()}
                  onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setBatchProductDragOver(true); }}
                  onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); setBatchProductDragOver(true); }}
                  onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); setBatchProductDragOver(false); }}
                  onDrop={handleBatchProductDrop}
                  className={`border-2 border-dashed rounded-xl p-3 text-center cursor-pointer transition-all ${
                    batchProductDragOver ? 'border-blue-400 bg-blue-50/30' :
                    'border-gray-200/80 hover:border-blue-300 hover:bg-gray-50/30'
                  }`}
                >
                  <p className={`text-[11px] font-medium ${batchProductDragOver ? 'text-blue-600' : 'text-gray-500'}`}>
                    {batchProductDragOver ? 'Drop product image here' : 'Drop a product image, or click to browse'}
                  </p>
                  <p className="text-[10px] text-gray-400 mt-0.5">Optional — helps Gemini render your product accurately</p>
                </div>
              )}
              <input
                ref={batchProductInputRef}
                type="file"
                accept=".jpg,.jpeg,.png,.webp,.gif"
                onChange={e => { if (e.target.files?.[0]) handleBatchProductSelected(e.target.files[0]); }}
                className="hidden"
              />
            </div>

            {/* Prompt Guidelines indicator */}
            {project?.prompt_guidelines && (
              <div className="mb-3 p-2.5 bg-purple-50/40 border border-purple-200/40 rounded-xl">
                <p className="text-[11px] font-medium text-purple-600 mb-0.5">Prompt Guidelines Active</p>
                <p className="text-[10px] text-purple-500/80 line-clamp-2">{project.prompt_guidelines}</p>
              </div>
            )}

            {/* Schedule toggle */}
            <div className="flex items-center gap-3 mb-3">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isScheduled}
                  onChange={e => setIsScheduled(e.target.checked)}
                  disabled={creating}
                  className="w-4 h-4 rounded border-gray-300 text-blue-500 focus:ring-blue-500/20"
                />
                <span className="text-[12px] text-gray-600 font-medium">Schedule recurring</span>
              </label>
            </div>

            {/* Cron config (shown when scheduled) */}
            {isScheduled && (
              <div className="p-3 bg-gray-50/50 border border-gray-200/60 rounded-xl mb-3 fade-in">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-medium text-gray-500 mb-1">
                      Frequency
                    </label>
                    <select
                      value={cronPreset}
                      onChange={e => setCronPreset(e.target.value)}
                      disabled={creating}
                      className="input-apple"
                    >
                      {CRON_PRESETS.map(p => (
                        <option key={p.value} value={p.value}>{p.label}</option>
                      ))}
                    </select>
                  </div>
                  {!cronPreset && (
                    <div>
                      <label className="block text-[11px] font-medium text-gray-500 mb-1">
                        Cron Expression
                      </label>
                      <input
                        value={customCron}
                        onChange={e => setCustomCron(e.target.value)}
                        disabled={creating}
                        placeholder="*/30 * * * *"
                        className="input-apple font-mono text-[12px]"
                      />
                    </div>
                  )}
                </div>
                <p className="text-[10px] text-gray-400 mt-2">
                  Batch will run automatically on this schedule using the template source selected above.
                </p>
              </div>
            )}

            {/* Error */}
            {createError && (
              <div className="mb-3 p-2.5 bg-red-50/80 border border-red-200/60 text-red-600 text-[12px] rounded-xl">
                {createError}
              </div>
            )}

            {/* Submit buttons */}
            <div className="flex items-center gap-2">
              <button
                onClick={handleCreate}
                disabled={creating || submittingQueue || (isScheduled && !cronPreset && !customCron)}
                className="btn-primary text-[13px]"
              >
                {creating
                  ? 'Creating...'
                  : isScheduled
                    ? 'Create Scheduled Batch'
                    : `Generate ${batchSize} Ad${batchSize !== 1 ? 's' : ''}`}
              </button>
              <button
                onClick={handleAddToQueue}
                disabled={creating || submittingQueue || (isScheduled && !cronPreset && !customCron)}
                className="btn-secondary text-[13px]"
              >
                + Add to Queue
              </button>
            </div>

            {/* Batch Queue */}
            {queue.length > 0 && (
              <div className="mt-3 p-4 bg-blue-50/30 border border-blue-200/40 rounded-xl fade-in">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-[12px] font-semibold text-blue-700 uppercase tracking-wider">
                    Queue ({queue.length} batch{queue.length !== 1 ? 'es' : ''})
                  </h4>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => setQueue([])}
                      disabled={submittingQueue}
                      className="text-[11px] text-gray-400 hover:text-gray-600 transition-colors"
                    >
                      Clear All
                    </button>
                    <button
                      onClick={handleSubmitQueue}
                      disabled={submittingQueue}
                      className="btn-primary text-[12px] py-1.5 px-3"
                    >
                      {submittingQueue ? 'Submitting...' : `Submit All (${queue.length})`}
                    </button>
                  </div>
                </div>
                <div className="space-y-1.5">
                  {queue.map(item => (
                    <div
                      key={item.id}
                      className="flex items-center justify-between p-2.5 bg-white/60 rounded-lg border border-blue-100/60"
                    >
                      <div className="flex items-center gap-3 text-[12px]">
                        <span className="font-medium text-gray-800">
                          {item.batch_size} image{item.batch_size !== 1 ? 's' : ''}
                        </span>
                        <span className="text-gray-400">{item.aspect_ratio}</span>
                        {item.templateLabel && item.templateLabel !== 'Random' && (
                          <>
                            <span className="text-gray-300">|</span>
                            <span className="badge bg-blue-50/80 text-blue-500 text-[10px]">{item.templateLabel}</span>
                          </>
                        )}
                        {item.angle && (
                          <>
                            <span className="text-gray-300">|</span>
                            <span className="text-gray-500 truncate max-w-[120px]">{item.angle}</span>
                          </>
                        )}
                        {item.scheduled && (
                          <span className="badge bg-purple-100/80 text-purple-600 text-[10px]">
                            Scheduled
                          </span>
                        )}
                      </div>
                      <button
                        onClick={() => handleRemoveFromQueue(item.id)}
                        disabled={submittingQueue}
                        className="text-[11px] text-red-400 hover:text-red-500 transition-colors px-1.5"
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Active Batches */}
          {loading ? (
            <div className="p-5 space-y-2">
              {[0, 1, 2].map(i => (
                <div key={i} className="flex items-center gap-3 p-3 rounded-xl bg-gray-50/30 border border-gray-100/80 animate-pulse">
                  <div className="w-5 h-5 rounded-full bg-gray-200 flex-shrink-0" />
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <div className="h-3.5 w-20 bg-gray-200 rounded" />
                      <div className="h-4 w-16 bg-gray-200 rounded-full" />
                    </div>
                    <div className="h-2.5 w-32 bg-gray-100 rounded" />
                  </div>
                  <div className="h-6 w-12 bg-gray-100 rounded" />
                </div>
              ))}
            </div>
          ) : (
            <div className="divide-y divide-gray-100/80">
              {activeBatches.length > 0 && (
                <div className="p-5">
                  <h4 className="text-[12px] font-semibold text-gray-500 uppercase tracking-wider mb-3">
                    Active
                  </h4>
                  <div className="space-y-2">
                    {activeBatches.map(batch => (
                      <BatchRow
                        key={batch.id}
                        batch={batch}
                        onRunNow={handleRunNow}
                        onCancel={handleCancel}
                        onDelete={handleDelete}
                      />
                    ))}
                  </div>
                </div>
              )}

              {completedBatches.length > 0 && (
                <div className="p-5">
                  <h4 className="text-[12px] font-semibold text-gray-500 uppercase tracking-wider mb-3">
                    History
                  </h4>
                  <div className="space-y-2">
                    {completedBatches.slice(0, 10).map(batch => (
                      <BatchRow
                        key={batch.id}
                        batch={batch}
                        onRunNow={handleRunNow}
                        onCancel={handleCancel}
                        onDelete={handleDelete}
                      />
                    ))}
                  </div>
                  {completedBatches.length > 10 && (
                    <p className="text-[11px] text-gray-400 mt-2">
                      + {completedBatches.length - 10} older batch{completedBatches.length - 10 !== 1 ? 'es' : ''}
                    </p>
                  )}
                </div>
              )}

              {batches.length === 0 && (
                <div className="p-8 text-center">
                  <p className="text-[13px] text-gray-500 font-medium mb-1">No Batch Jobs Yet</p>
                  <p className="text-[11px] text-gray-400">
                    Create a batch above to generate multiple ads at once.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function BatchRow({ batch, onRunNow, onCancel, onDelete }) {
  const isActive = ['generating_prompts', 'submitting', 'processing'].includes(batch.status);
  const canRun = ['pending', 'completed', 'failed'].includes(batch.status);
  const canCancel = isActive;

  // Parse batch_stats for progress bar
  let batchStats = null;
  if (batch.batch_stats) {
    try {
      batchStats = typeof batch.batch_stats === 'string' ? JSON.parse(batch.batch_stats) : batch.batch_stats;
    } catch {}
  }
  const progressTotal = batchStats?.totalRequests || 0;
  const progressDone = (batchStats?.succeededRequests || 0) + (batchStats?.failedRequests || 0);
  const progressPct = progressTotal > 0 ? Math.round((progressDone / progressTotal) * 100) : 0;

  return (
    <div className="rounded-xl bg-gray-50/30 border border-gray-100/80 hover:bg-gray-50/60 transition-colors">
      <div className="flex items-center gap-3 p-3">
        {/* Status indicator */}
        <div className="flex-shrink-0">
          {isActive ? (
            <div className="w-5 h-5 rounded-full border-2 border-blue-200 border-t-blue-500 animate-spin" />
          ) : batch.status === 'completed' ? (
            <div className="w-5 h-5 rounded-full bg-green-100 flex items-center justify-center">
              <svg className="w-3 h-3 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
              </svg>
            </div>
          ) : batch.status === 'failed' ? (
            <div className="w-5 h-5 rounded-full bg-red-100 flex items-center justify-center">
              <svg className="w-3 h-3 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
          ) : (
            <div className="w-5 h-5 rounded-full bg-gray-100 flex items-center justify-center">
              <div className="w-2 h-2 rounded-full bg-gray-400" />
            </div>
          )}
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[13px] font-medium text-gray-800">
              {batch.batch_size} image{batch.batch_size !== 1 ? 's' : ''}
            </span>
            <span className={`badge text-[10px] ${STATUS_COLORS[batch.status] || STATUS_COLORS.pending}`}>
              {STATUS_LABELS[batch.status] || batch.status}
            </span>
            {batch.scheduled ? (
              <span className="badge bg-purple-100/80 text-purple-600 text-[10px]">
                Scheduled
              </span>
            ) : null}
            {batch.retry_count > 0 && (
              <span className="badge bg-amber-100/80 text-amber-700 text-[10px]">
                {batch.retry_count}/3 retries
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            <span className="text-[11px] text-gray-400">{batch.aspect_ratio}</span>
            {batch.angle && (
              <>
                <span className="text-[11px] text-gray-300">|</span>
                <span className="text-[11px] text-gray-500 truncate">{batch.angle}</span>
              </>
            )}
            {batch.completed_count > 0 && (
              <>
                <span className="text-[11px] text-gray-300">|</span>
                <span className="text-[11px] text-green-600">{batch.completed_count} saved</span>
              </>
            )}
            {batch.error_message && (
              <>
                <span className="text-[11px] text-gray-300">|</span>
                <span className="text-[11px] text-red-500 truncate" title={batch.error_message}>
                  {batch.error_message.slice(0, 50)}
                </span>
              </>
            )}
          </div>
          <span className="text-[10px] text-gray-400">{formatDate(batch.created_at)}</span>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {canCancel && (
            <button
              onClick={() => onCancel(batch.id)}
              className="text-[11px] text-amber-500 hover:text-amber-600 font-medium transition-colors px-2 py-1 rounded-lg hover:bg-amber-50/50"
              title="Cancel batch"
            >
              Cancel
            </button>
          )}
          {canRun && (
            <button
              onClick={() => onRunNow(batch.id)}
              className="text-[11px] text-blue-500 hover:text-blue-600 font-medium transition-colors px-2 py-1 rounded-lg hover:bg-blue-50/50"
              title="Run now"
            >
              Run
            </button>
          )}
          <button
            onClick={() => onDelete(batch.id)}
            className="text-[11px] text-red-400 hover:text-red-500 font-medium transition-colors px-2 py-1 rounded-lg hover:bg-red-50/50"
            title="Delete"
          >
            Delete
          </button>
        </div>
      </div>

      {/* Progress bar for processing batches */}
      {batch.status === 'processing' && progressTotal > 0 && (
        <div className="px-3 pb-3">
          <div className="flex items-center gap-2">
            <div className="flex-1 h-1.5 rounded-full bg-gray-200 overflow-hidden">
              <div
                className="h-full bg-blue-400 rounded-full transition-all duration-500"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <span className="text-[10px] text-gray-400 flex-shrink-0">
              {progressDone}/{progressTotal}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

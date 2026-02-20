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
  { value: '0 * * * *',    label: 'Every hour' },
  { value: '0 */6 * * *',  label: 'Every 6 hours' },
  { value: '0 */12 * * *', label: 'Every 12 hours' },
  { value: '0 9 * * *',    label: 'Daily at 9 AM' },
  { value: '0 9 * * 1-5',  label: 'Weekdays at 9 AM' },
  { value: '0 9 * * 1',    label: 'Weekly (Monday 9 AM)' },
  { value: 'custom',       label: 'Custom interval...' },
];

const INTERVAL_UNITS = [
  { value: 'minutes', label: 'minutes', min: 5,  max: 59 },
  { value: 'hours',   label: 'hours',   min: 1,  max: 23 },
  { value: 'days',    label: 'days',    min: 1,  max: 30 },
  { value: 'weeks',   label: 'weeks',   min: 1,  max: 4  },
  { value: 'months',  label: 'months',  min: 1,  max: 12 },
];

function intervalToCron(amount, unit) {
  const n = parseInt(amount);
  if (!n || n < 1) return null;
  switch (unit) {
    case 'minutes': return `*/${n} * * * *`;
    case 'hours':   return n === 1 ? '0 * * * *' : `0 */${n} * * *`;
    case 'days':    return n === 1 ? '0 9 * * *' : `0 9 */${n} * *`;
    case 'weeks':   return n === 1 ? '0 9 * * 1' : `0 9 */${n * 7} * *`;
    case 'months':  return n === 1 ? '0 9 1 * *' : `0 9 1 */${n} *`;
    default: return null;
  }
}

function cronToLabel(cronStr) {
  if (!cronStr) return '';
  // Check presets first
  const preset = CRON_PRESETS.find(p => p.value === cronStr && p.value !== 'custom');
  if (preset) return preset.label;
  // Parse cron fields
  const parts = cronStr.trim().split(/\s+/);
  if (parts.length !== 5) return cronStr;
  const [minute, hour, dom, month, dow] = parts;
  // */N * * * * → Every N minutes
  if (minute.startsWith('*/') && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    const n = parseInt(minute.slice(2));
    return n === 1 ? 'Every minute' : `Every ${n} minutes`;
  }
  // 0 */N * * * → Every N hours
  if (minute === '0' && hour.startsWith('*/') && dom === '*' && month === '*' && dow === '*') {
    const n = parseInt(hour.slice(2));
    return n === 1 ? 'Every hour' : `Every ${n} hours`;
  }
  // 0 * * * * → Every hour
  if (minute === '0' && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return 'Every hour';
  }
  // 0 H */N * * → Every N days
  if (minute === '0' && dom.startsWith('*/') && month === '*' && dow === '*') {
    const n = parseInt(dom.slice(2));
    if (n % 7 === 0) {
      const weeks = n / 7;
      return weeks === 1 ? 'Weekly' : `Every ${weeks} weeks`;
    }
    return n === 1 ? 'Daily' : `Every ${n} days`;
  }
  // 0 H 1 */N * → Every N months
  if (minute === '0' && dom === '1' && month.startsWith('*/') && dow === '*') {
    const n = parseInt(month.slice(2));
    return n === 1 ? 'Monthly' : `Every ${n} months`;
  }
  // 0 H 1 * * → Monthly
  if (minute === '0' && dom === '1' && month === '*' && dow === '*') {
    return 'Monthly';
  }
  return cronStr;
}

function parseCronToInterval(cronStr) {
  if (!cronStr) return null;
  const parts = cronStr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dom, month, dow] = parts;
  // */N * * * * → minutes
  if (minute.startsWith('*/') && hour === '*' && dom === '*') {
    return { amount: parseInt(minute.slice(2)), unit: 'minutes' };
  }
  // 0 */N * * * → hours
  if (minute === '0' && hour.startsWith('*/') && dom === '*' && month === '*') {
    return { amount: parseInt(hour.slice(2)), unit: 'hours' };
  }
  // 0 * * * * → 1 hour
  if (minute === '0' && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return { amount: 1, unit: 'hours' };
  }
  // 0 H */N * * → days (or weeks if divisible by 7)
  if (minute === '0' && dom.startsWith('*/') && month === '*' && dow === '*') {
    const n = parseInt(dom.slice(2));
    if (n % 7 === 0) return { amount: n / 7, unit: 'weeks' };
    return { amount: n, unit: 'days' };
  }
  // 0 H * * N → weekly
  if (minute === '0' && dom === '*' && month === '*' && dow !== '*') {
    return { amount: 1, unit: 'weeks' };
  }
  // 0 H 1 */N * → months
  if (minute === '0' && dom === '1' && month.startsWith('*/') && dow === '*') {
    return { amount: parseInt(month.slice(2)), unit: 'months' };
  }
  // 0 H 1 * * → 1 month
  if (minute === '0' && dom === '1' && month === '*' && dow === '*') {
    return { amount: 1, unit: 'months' };
  }
  return null;
}

function getNextRun(cronStr) {
  if (!cronStr) return null;
  const parts = cronStr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dom, month, dow] = parts;
  const now = new Date();

  // */N * * * * → every N minutes
  if (minute.startsWith('*/') && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    const n = parseInt(minute.slice(2));
    const next = new Date(now);
    const currentMin = next.getMinutes();
    const nextMin = Math.ceil((currentMin + 1) / n) * n;
    if (nextMin >= 60) {
      next.setHours(next.getHours() + 1);
      next.setMinutes(nextMin % 60);
    } else {
      next.setMinutes(nextMin);
    }
    next.setSeconds(0, 0);
    return next;
  }

  // 0 * * * * → every hour at :00
  if (minute === '0' && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    const next = new Date(now);
    next.setHours(next.getHours() + 1);
    next.setMinutes(0, 0, 0);
    return next;
  }

  // 0 */N * * * → every N hours at :00
  if (minute === '0' && hour.startsWith('*/') && dom === '*' && month === '*' && dow === '*') {
    const n = parseInt(hour.slice(2));
    const next = new Date(now);
    const currentHr = next.getHours();
    const nextHr = Math.ceil((currentHr + 1) / n) * n;
    if (nextHr >= 24) {
      next.setDate(next.getDate() + 1);
      next.setHours(nextHr % 24);
    } else {
      next.setHours(nextHr);
    }
    next.setMinutes(0, 0, 0);
    return next;
  }

  // 0 H * * N or 0 H * * N-M → specific day(s) of week
  if (minute === '0' && dom === '*' && month === '*' && dow !== '*') {
    const targetHour = parseInt(hour) || 0;
    let days = [];
    if (dow.includes('-')) {
      const [start, end] = dow.split('-').map(Number);
      for (let d = start; d <= end; d++) days.push(d);
    } else {
      days = [parseInt(dow)];
    }
    const next = new Date(now);
    next.setHours(targetHour, 0, 0, 0);
    if (days.includes(next.getDay()) && next > now) return next;
    for (let i = 1; i <= 7; i++) {
      next.setDate(now.getDate() + i);
      next.setHours(targetHour, 0, 0, 0);
      if (days.includes(next.getDay())) return next;
    }
    return next;
  }

  // 0 H * * * → daily at specific hour
  if (minute === '0' && !hour.startsWith('*/') && hour !== '*' && dom === '*' && month === '*' && dow === '*') {
    const targetHour = parseInt(hour) || 0;
    const next = new Date(now);
    next.setHours(targetHour, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next;
  }

  // 0 H */N * * → every N days at specific hour
  if (minute === '0' && dom.startsWith('*/') && month === '*' && dow === '*') {
    const n = parseInt(dom.slice(2));
    const targetHour = parseInt(hour) || 9;
    const next = new Date(now);
    const currentDom = next.getDate();
    next.setHours(targetHour, 0, 0, 0);
    next.setDate(currentDom + (n - ((currentDom - 1) % n)));
    if (next <= now) next.setDate(next.getDate() + n);
    next.setHours(targetHour, 0, 0, 0);
    return next;
  }

  // 0 H 1 */N * → every N months on the 1st
  if (minute === '0' && dom === '1' && month.startsWith('*/') && dow === '*') {
    const n = parseInt(month.slice(2));
    const targetHour = parseInt(hour) || 9;
    const next = new Date(now);
    next.setDate(1);
    next.setHours(targetHour, 0, 0, 0);
    if (next <= now) next.setMonth(next.getMonth() + n);
    return next;
  }

  // 0 H 1 * * → monthly on the 1st
  if (minute === '0' && dom === '1' && month === '*' && dow === '*') {
    const targetHour = parseInt(hour) || 9;
    const next = new Date(now);
    next.setDate(1);
    next.setHours(targetHour, 0, 0, 0);
    if (next <= now) next.setMonth(next.getMonth() + 1);
    return next;
  }

  return null;
}

function formatNextRun(date) {
  if (!date) return '';
  const now = new Date();
  const timeStr = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round((target - today) / 86400000);
  if (diffDays === 0) return `Today at ${timeStr}`;
  if (diffDays === 1) return `Tomorrow at ${timeStr}`;
  if (diffDays < 7) {
    return `${date.toLocaleDateString([], { weekday: 'short' })} at ${timeStr}`;
  }
  return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} at ${timeStr}`;
}

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

function formatDuration(startedAt, completedAt) {
  if (!startedAt || !completedAt) return null;
  const ms = new Date(completedAt) - new Date(startedAt);
  if (ms < 0) return null;
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
  const hr = Math.floor(min / 60);
  const remMin = min % 60;
  return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`;
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
  const [intervalAmount, setIntervalAmount] = useState(30);
  const [intervalUnit, setIntervalUnit] = useState('minutes');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');

  // Template source
  const [templateSource, setTemplateSource] = useState(TEMPLATE_RANDOM);
  const [driveImages, setDriveImages] = useState([]);
  const [uploadedTemplates, setUploadedTemplates] = useState([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  const [selectedTemplates, setSelectedTemplates] = useState([]); // [{ id, source }, ...]

  // Upload one-off template
  const [uploadedFile, setUploadedFile] = useState(null);
  const [uploadedPreview, setUploadedPreview] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);

  // Product image for batch
  const [batchProductFile, setBatchProductFile] = useState(null);
  const [batchProductPreview, setBatchProductPreview] = useState(null);
  const [batchProductDragOver, setBatchProductDragOver] = useState(false);
  const [skipProductImage, setSkipProductImage] = useState(false);
  const batchProductInputRef = useRef(null);

  // Derive effective cron expression from preset or custom interval
  const getEffectiveCron = () => {
    if (cronPreset === 'custom') return intervalToCron(intervalAmount, intervalUnit);
    return cronPreset;
  };

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
      angle: batchAngle.trim() || undefined,
      aspect_ratio: batchAspectRatio,
      scheduled: isScheduled,
      schedule_cron: isScheduled ? getEffectiveCron() : undefined,
      run_immediately: !isScheduled
    };

    if (templateSource === TEMPLATE_SELECT && selectedTemplates.length > 0) {
      const driveIds = selectedTemplates.filter(t => t.source === 'drive').map(t => t.id);
      const uploadedIds = selectedTemplates.filter(t => t.source === 'uploaded').map(t => t.id);

      // Single template — backward compatible, use original fields
      if (selectedTemplates.length === 1) {
        if (uploadedIds.length === 1) {
          config.generation_mode = 'mode2';
          config.template_image_id = uploadedIds[0];
        } else {
          config.generation_mode = 'mode1';
          config.inspiration_image_id = driveIds[0];
        }
      } else {
        // Multi-template — pass arrays
        config.generation_mode = uploadedIds.length > 0 && driveIds.length === 0 ? 'mode2' : 'mode1';
        if (driveIds.length > 0) config.inspiration_image_ids = JSON.stringify(driveIds);
        if (uploadedIds.length > 0) config.template_image_ids = JSON.stringify(uploadedIds);
      }
    } else {
      config.generation_mode = 'mode1';
    }

    return config;
  };

  // Template source display label for queue items
  const getTemplateLabel = () => {
    if (templateSource === TEMPLATE_SELECT && selectedTemplates.length > 0) {
      return `${selectedTemplates.length} template${selectedTemplates.length !== 1 ? 's' : ''} selected`;
    }
    if (templateSource === TEMPLATE_UPLOAD && uploadedFile) {
      return `Upload: ${uploadedFile.name.slice(0, 15)}`;
    }
    return 'Random';
  };

  // Toggle a template in/out of the selectedTemplates array
  const toggleTemplate = (id, source) => {
    setSelectedTemplates(prev => {
      const exists = prev.find(t => t.id === id && t.source === source);
      if (exists) return prev.filter(t => !(t.id === id && t.source === source));
      if (prev.length >= batchSize) return prev; // cap at batch size
      return [...prev, { id, source }];
    });
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
    if (templateSource === TEMPLATE_SELECT && selectedTemplates.length === 0) {
      setCreateError('Please select at least one template image.');
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

      // Skip product image if toggled
      if (skipProductImage) {
        config.skip_product_image = true;
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

  const handleEditBatch = async (batchId, updates) => {
    try {
      await api.updateBatch(projectId, batchId, updates);
      toast.success('Batch updated');
      await loadBatches();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const handlePause = async (batchId) => {
    try {
      await api.updateBatch(projectId, batchId, { scheduled: false });
      toast.success('Automation paused');
      await loadBatches();
    } catch (err) {
      toast.error(err.message);
    }
  };

  const handleResume = async (batchId) => {
    try {
      await api.updateBatch(projectId, batchId, { scheduled: true });
      toast.success('Automation resumed');
      await loadBatches();
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
    if (templateSource === TEMPLATE_SELECT && selectedTemplates.length === 0) {
      setCreateError('Please select at least one template image.');
      return;
    }

    const cronExpression = getEffectiveCron();
    const config = {
      id: Date.now(),
      batch_size: batchSize,
      angle: batchAngle.trim() || '',
      aspect_ratio: batchAspectRatio,
      scheduled: isScheduled,
      schedule_cron: isScheduled ? cronExpression : undefined,
      templateSource,
      templateLabel: getTemplateLabel(),
      selectedTemplates: selectedTemplates.length > 0 ? [...selectedTemplates] : [],
      uploadedFile: templateSource === TEMPLATE_UPLOAD ? uploadedFile : null
    };
    setQueue(prev => [...prev, config]);
    setBatchAngle('');
    setIsScheduled(false);
  };

  const handleRemoveFromQueue = (tempId) => {
    setQueue(prev => prev.filter(item => item.id !== tempId));
  };

  const handleEditQueueItem = (tempId) => {
    const item = queue.find(q => q.id === tempId);
    if (!item) return;

    // Load values back into the form
    setBatchSize(item.batch_size || 5);
    setBatchAngle(item.angle || '');
    setBatchAspectRatio(item.aspect_ratio || '1:1');
    setIsScheduled(!!item.scheduled);

    if (item.schedule_cron) {
      // Check if it matches a preset
      const matchingPreset = CRON_PRESETS.find(p => p.value === item.schedule_cron && p.value !== 'custom');
      if (matchingPreset) {
        setCronPreset(matchingPreset.value);
      } else {
        // Try to reverse-parse the cron into interval amount + unit
        setCronPreset('custom');
        const parsed = parseCronToInterval(item.schedule_cron);
        if (parsed) {
          setIntervalAmount(parsed.amount);
          setIntervalUnit(parsed.unit);
        }
      }
    } else {
      setCronPreset('0 9 * * *');
    }

    if (item.templateSource) setTemplateSource(item.templateSource);
    if (item.selectedTemplate) setSelectedTemplate(item.selectedTemplate);

    // Remove from queue
    setQueue(prev => prev.filter(q => q.id !== tempId));
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
    || !!b.schedule_cron  // Include all scheduled/paused batches in active section
  );
  const completedBatches = batches.filter(b =>
    ['completed', 'failed'].includes(b.status) && !b.schedule_cron
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
                              const selIdx = selectedTemplates.findIndex(t => t.id === img.id && t.source === 'drive');
                              const isSelected = selIdx >= 0;
                              const atMax = selectedTemplates.length >= batchSize && !isSelected;
                              return (
                                <button
                                  key={`drive-${img.id}`}
                                  onClick={() => toggleTemplate(img.id, 'drive')}
                                  disabled={creating || atMax}
                                  className={`group relative rounded-lg overflow-hidden border-2 transition-all aspect-square ${
                                    isSelected
                                      ? 'border-blue-500 ring-2 ring-blue-200 shadow-md'
                                      : atMax
                                        ? 'border-gray-200/60 opacity-40 cursor-not-allowed'
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
                                    <div className="absolute top-1 right-1 w-4 h-4 rounded-full bg-blue-500 flex items-center justify-center shadow-sm text-[8px] font-bold text-white leading-none">
                                      {selIdx + 1}
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
                              const selIdx = selectedTemplates.findIndex(st => st.id === t.id && st.source === 'uploaded');
                              const isSelected = selIdx >= 0;
                              const atMax = selectedTemplates.length >= batchSize && !isSelected;
                              return (
                                <button
                                  key={`uploaded-${t.id}`}
                                  onClick={() => toggleTemplate(t.id, 'uploaded')}
                                  disabled={creating || atMax}
                                  className={`group relative rounded-lg overflow-hidden border-2 transition-all aspect-square ${
                                    isSelected
                                      ? 'border-blue-500 ring-2 ring-blue-200 shadow-md'
                                      : atMax
                                        ? 'border-gray-200/60 opacity-40 cursor-not-allowed'
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
                                    <div className="absolute top-1 right-1 w-4 h-4 rounded-full bg-blue-500 flex items-center justify-center shadow-sm text-[8px] font-bold text-white leading-none">
                                      {selIdx + 1}
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
                  {selectedTemplates.length > 0 && (
                    <div className="mt-2 flex items-center gap-2">
                      <span className="text-[11px] text-blue-600 font-medium">
                        {selectedTemplates.length} template{selectedTemplates.length !== 1 ? 's' : ''} selected
                      </span>
                      <span className="text-[10px] text-gray-400">
                        {selectedTemplates.length === 1
                          ? '— all ads use this template'
                          : selectedTemplates.length >= batchSize
                            ? '— each ad uses a unique template'
                            : `— randomly distributed across ${batchSize} ads`}
                      </span>
                      <button
                        onClick={() => setSelectedTemplates([])}
                        disabled={creating}
                        className="text-[11px] text-gray-400 hover:text-gray-600 transition-colors"
                      >
                        Clear all
                      </button>
                    </div>
                  )}
                  {selectedTemplates.length === 0 && (driveImages.length > 0 || uploadedTemplates.length > 0) && (
                    <p className="mt-2 text-[10px] text-gray-400">
                      Select templates to use in this batch (up to {batchSize}), or leave empty for fully random.
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* Product Image (project-level + optional per-batch override) */}
            <div className="mb-3">
              <label className="block text-[11px] font-medium text-gray-500 mb-1.5">
                Product Image
              </label>

              {/* Show project-level product image indicator */}
              {project?.productImageUrl && !batchProductFile && (
                <div className="flex items-center gap-3 p-2.5 bg-emerald-50/50 border border-emerald-200/60 rounded-xl mb-2">
                  <img
                    src={project.productImageUrl}
                    alt="Project product"
                    className="w-9 h-9 object-cover rounded-lg border border-emerald-200/60"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-[11px] font-medium text-emerald-700">Project product image active</p>
                    <p className="text-[10px] text-emerald-500">Used for all ads in batch</p>
                  </div>
                  <button
                    onClick={() => !creating && batchProductInputRef.current?.click()}
                    className="text-[10px] text-gray-400 hover:text-gray-600 transition-colors whitespace-nowrap"
                  >
                    Override →
                  </button>
                </div>
              )}

              {batchProductFile && batchProductPreview ? (
                <div className="flex items-center gap-3 p-3 bg-gray-50/50 border border-gray-200/60 rounded-xl">
                  <img
                    src={batchProductPreview}
                    alt="Product image"
                    className="w-12 h-12 object-cover rounded-lg border border-gray-200/60"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-[12px] font-medium text-gray-900 truncate">{batchProductFile.name}</p>
                    <p className="text-[10px] text-gray-400">
                      {(batchProductFile.size / 1024).toFixed(0)} KB
                      {project?.productImageUrl ? ' — overrides project image' : ' — used for all ads in batch'}
                    </p>
                  </div>
                  <button
                    onClick={clearBatchProductImage}
                    disabled={creating}
                    className="text-[11px] text-red-400 hover:text-red-500 transition-colors"
                  >
                    Remove
                  </button>
                </div>
              ) : !project?.productImageUrl ? (
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
                  <svg className="w-5 h-5 mx-auto mb-1 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5a2.25 2.25 0 002.25-2.25V6.75a2.25 2.25 0 00-2.25-2.25H3.75a2.25 2.25 0 00-2.25 2.25v12a2.25 2.25 0 002.25 2.25z" />
                  </svg>
                  <p className={`text-[11px] font-medium ${batchProductDragOver ? 'text-blue-600' : 'text-gray-500'}`}>
                    {batchProductDragOver ? 'Drop product image here' : 'Drop a product image, or click to browse'}
                  </p>
                  <p className="text-[10px] text-gray-400 mt-0.5">Or set one on the project Overview for all ads</p>
                </div>
              ) : null}
              <input
                ref={batchProductInputRef}
                type="file"
                accept=".jpg,.jpeg,.png,.webp,.gif"
                onChange={e => { if (e.target.files?.[0]) handleBatchProductSelected(e.target.files[0]); }}
                className="hidden"
              />

              {/* Skip product image toggle (only when project has one) */}
              {(project?.productImageUrl || batchProductFile) && (
                <button
                  onClick={() => setSkipProductImage(!skipProductImage)}
                  className={`mt-1.5 inline-flex items-center gap-1.5 text-[10px] font-medium px-2.5 py-1 rounded-lg transition-all ${
                    skipProductImage
                      ? 'bg-amber-50 text-amber-700 border border-amber-200'
                      : 'text-gray-400 hover:text-gray-600'
                  }`}
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    {skipProductImage
                      ? <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88" />
                      : <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178zM15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    }
                  </svg>
                  {skipProductImage ? 'Product image skipped' : 'Skip product image'}
                </button>
              )}
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
                  {cronPreset === 'custom' && (
                    <div>
                      <label className="block text-[11px] font-medium text-gray-500 mb-1">
                        Run every
                      </label>
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min={INTERVAL_UNITS.find(u => u.value === intervalUnit)?.min || 1}
                          max={INTERVAL_UNITS.find(u => u.value === intervalUnit)?.max || 60}
                          value={intervalAmount}
                          onChange={e => {
                            const unit = INTERVAL_UNITS.find(u => u.value === intervalUnit);
                            const val = parseInt(e.target.value) || unit?.min || 1;
                            setIntervalAmount(Math.max(unit?.min || 1, Math.min(unit?.max || 60, val)));
                          }}
                          disabled={creating}
                          className="input-apple w-20 text-center"
                        />
                        <select
                          value={intervalUnit}
                          onChange={e => {
                            setIntervalUnit(e.target.value);
                            const unit = INTERVAL_UNITS.find(u => u.value === e.target.value);
                            if (unit && intervalAmount < unit.min) setIntervalAmount(unit.min);
                            if (unit && intervalAmount > unit.max) setIntervalAmount(unit.max);
                          }}
                          disabled={creating}
                          className="input-apple flex-1"
                        >
                          {INTERVAL_UNITS.map(u => (
                            <option key={u.value} value={u.value}>{u.label}</option>
                          ))}
                        </select>
                      </div>
                      {intervalUnit === 'weeks' && intervalAmount > 1 && (
                        <p className="text-[10px] text-amber-500 mt-1">
                          Approximated as every {intervalAmount * 7} days
                        </p>
                      )}
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
                disabled={creating || submittingQueue || (isScheduled && !getEffectiveCron())}
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
                disabled={creating || submittingQueue || (isScheduled && !getEffectiveCron())}
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
                        {item.scheduled && item.schedule_cron && (
                          <span className="badge bg-purple-100/80 text-purple-600 text-[10px]">
                            {cronToLabel(item.schedule_cron)}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <button
                          onClick={() => handleEditQueueItem(item.id)}
                          disabled={submittingQueue}
                          className="text-[11px] text-blue-400 hover:text-blue-600 transition-colors px-1.5"
                        >
                          Edit
                        </button>
                        <button
                          onClick={() => handleRemoveFromQueue(item.id)}
                          disabled={submittingQueue}
                          className="text-[11px] text-red-400 hover:text-red-500 transition-colors px-1.5"
                        >
                          Remove
                        </button>
                      </div>
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
                        onEdit={handleEditBatch}
                        onPause={handlePause}
                        onResume={handleResume}
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
                        onEdit={handleEditBatch}
                        onPause={handlePause}
                        onResume={handleResume}
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

function BatchRow({ batch, onRunNow, onCancel, onDelete, onEdit, onPause, onResume }) {
  const isActive = ['generating_prompts', 'submitting', 'processing'].includes(batch.status);
  const canRun = ['pending', 'completed', 'failed'].includes(batch.status);
  const canCancel = isActive;
  const isPaused = !batch.scheduled && !!batch.schedule_cron;
  const canPause = !!batch.scheduled && !!batch.schedule_cron;
  const canEdit = !isActive || batch.scheduled;

  const [editing, setEditing] = useState(false);
  const [editSize, setEditSize] = useState(batch.batch_size);
  const [editAngle, setEditAngle] = useState(batch.angle || '');
  const [editAspect, setEditAspect] = useState(batch.aspect_ratio || '1:1');
  const [editScheduled, setEditScheduled] = useState(!!batch.scheduled);
  const [editCronPreset, setEditCronPreset] = useState(() => {
    if (!batch.schedule_cron) return '0 9 * * *';
    const match = CRON_PRESETS.find(p => p.value === batch.schedule_cron && p.value !== 'custom');
    return match ? match.value : 'custom';
  });
  const [editIntervalAmount, setEditIntervalAmount] = useState(() => {
    if (!batch.schedule_cron) return 30;
    const parsed = parseCronToInterval(batch.schedule_cron);
    return parsed ? parsed.amount : 30;
  });
  const [editIntervalUnit, setEditIntervalUnit] = useState(() => {
    if (!batch.schedule_cron) return 'minutes';
    const parsed = parseCronToInterval(batch.schedule_cron);
    return parsed ? parsed.unit : 'minutes';
  });
  const [saving, setSaving] = useState(false);

  const getEditCron = () => {
    if (editCronPreset === 'custom') return intervalToCron(editIntervalAmount, editIntervalUnit);
    return editCronPreset;
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await onEdit(batch.id, {
        batch_size: editSize,
        angle: editAngle.trim() || '',
        aspect_ratio: editAspect,
        scheduled: editScheduled,
        schedule_cron: editScheduled ? getEditCron() : undefined,
      });
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

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

  // Parse pipeline_state for stage-level progress
  let pipelineState = null;
  if (batch.pipeline_state) {
    try {
      pipelineState = typeof batch.pipeline_state === 'string' ? JSON.parse(batch.pipeline_state) : batch.pipeline_state;
    } catch {}
  }
  const pipelineStage = pipelineState?.stage ?? null;
  const pipelineCurrent = pipelineState?.current || 0;
  const pipelineTotal = pipelineState?.total || 0;
  const pipelinePct = pipelineStage === 3 && pipelineTotal > 0
    ? Math.round((pipelineCurrent / pipelineTotal) * 100)
    : pipelineStage === 'complete' ? 100
    : pipelineStage === 2 ? 60
    : pipelineStage === 1 ? 30
    : pipelineStage === 0 ? 10
    : 0;

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
              {batch.status === 'generating_prompts' && batch.pipeline_state
                ? (() => {
                    try {
                      const ps = JSON.parse(batch.pipeline_state);
                      return ps.stage_label || STATUS_LABELS[batch.status];
                    } catch { return STATUS_LABELS[batch.status]; }
                  })()
                : (STATUS_LABELS[batch.status] || batch.status)}
            </span>
            {batch.schedule_cron ? (
              batch.scheduled ? (
                <span className="badge bg-purple-100/80 text-purple-600 text-[10px]">
                  {cronToLabel(batch.schedule_cron)}
                </span>
              ) : (
                <span className="badge bg-orange-100/80 text-orange-600 text-[10px]">
                  Paused · {cronToLabel(batch.schedule_cron)}
                </span>
              )
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
                <span className="text-[11px] text-gray-500 truncate" title={batch.angle}>
                  {batch.angle}
                </span>
              </>
            )}
            {batch.completed_count > 0 && (
              <>
                <span className="text-[11px] text-gray-300">|</span>
                <span className="text-[11px] text-green-600">{batch.completed_count} saved</span>
                {batch.failed_count > 0 && (
                  <span className="text-[11px] text-red-400">· {batch.failed_count} failed</span>
                )}
                {batch.run_count > 1 && (
                  <span className="text-[11px] text-gray-400">· {batch.run_count} runs</span>
                )}
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
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-gray-400">{formatDate(batch.created_at)}</span>
            {batch.status === 'completed' && formatDuration(batch.started_at, batch.completed_at) && (
              <>
                <span className="text-[10px] text-gray-300">·</span>
                <span className="text-[10px] text-emerald-500">Completed in {formatDuration(batch.started_at, batch.completed_at)}</span>
              </>
            )}
            {batch.scheduled && batch.schedule_cron && (() => {
              const next = getNextRun(batch.schedule_cron);
              const label = formatNextRun(next);
              return label ? (
                <>
                  <span className="text-[10px] text-gray-300">·</span>
                  <span className="text-[10px] text-purple-400">Next: {label}</span>
                </>
              ) : null;
            })()}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {canPause && (
            <button
              onClick={() => onPause(batch.id)}
              className="text-[11px] text-orange-500 hover:text-orange-600 font-medium transition-colors px-2 py-1 rounded-lg hover:bg-orange-50/50"
              title="Pause automation"
            >
              Pause
            </button>
          )}
          {isPaused && (
            <button
              onClick={() => onResume(batch.id)}
              className="text-[11px] text-green-500 hover:text-green-600 font-medium transition-colors px-2 py-1 rounded-lg hover:bg-green-50/50"
              title="Resume automation"
            >
              Resume
            </button>
          )}
          {canCancel && (
            <button
              onClick={() => onCancel(batch.id)}
              className="text-[11px] text-amber-500 hover:text-amber-600 font-medium transition-colors px-2 py-1 rounded-lg hover:bg-amber-50/50"
              title="Cancel batch"
            >
              Cancel
            </button>
          )}
          {canEdit && (
            <button
              onClick={() => setEditing(!editing)}
              className="text-[11px] text-gray-400 hover:text-gray-600 font-medium transition-colors px-2 py-1 rounded-lg hover:bg-gray-50/50"
              title="Edit batch"
            >
              {editing ? 'Close' : 'Edit'}
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

      {/* Inline edit panel */}
      {editing && (
        <div className="px-3 pb-3 pt-1 border-t border-gray-100/80 fade-in">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-2">
            <div>
              <label className="block text-[10px] font-medium text-gray-400 mb-0.5">Batch Size</label>
              <input
                type="number"
                min={1}
                max={50}
                value={editSize}
                onChange={e => setEditSize(Math.max(1, Math.min(50, parseInt(e.target.value) || 1)))}
                disabled={saving}
                className="input-apple text-[12px] py-1.5"
              />
            </div>
            <div>
              <label className="block text-[10px] font-medium text-gray-400 mb-0.5">Aspect Ratio</label>
              <select
                value={editAspect}
                onChange={e => setEditAspect(e.target.value)}
                disabled={saving}
                className="input-apple text-[12px] py-1.5"
              >
                {ASPECT_RATIOS.map(ar => (
                  <option key={ar.value} value={ar.value}>{ar.label}</option>
                ))}
              </select>
            </div>
            <div className="col-span-2">
              <label className="block text-[10px] font-medium text-gray-400 mb-0.5">Ad Topic / Angle</label>
              <input
                value={editAngle}
                onChange={e => setEditAngle(e.target.value)}
                disabled={saving}
                placeholder='e.g., "before & after"'
                className="input-apple text-[12px] py-1.5"
              />
            </div>
          </div>

          {/* Schedule editing */}
          <div className="flex items-center gap-2 mb-2">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={editScheduled}
                onChange={e => setEditScheduled(e.target.checked)}
                disabled={saving}
                className="w-3.5 h-3.5 rounded border-gray-300 text-blue-500 focus:ring-blue-500/20"
              />
              <span className="text-[11px] text-gray-500 font-medium">Scheduled</span>
            </label>
          </div>
          {editScheduled && (
            <div className="grid grid-cols-2 gap-2 mb-2">
              <select
                value={editCronPreset}
                onChange={e => setEditCronPreset(e.target.value)}
                disabled={saving}
                className="input-apple text-[12px] py-1.5"
              >
                {CRON_PRESETS.map(p => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
              {editCronPreset === 'custom' && (
                <div className="flex items-center gap-1.5">
                  <input
                    type="number"
                    min={INTERVAL_UNITS.find(u => u.value === editIntervalUnit)?.min || 1}
                    max={INTERVAL_UNITS.find(u => u.value === editIntervalUnit)?.max || 60}
                    value={editIntervalAmount}
                    onChange={e => {
                      const unit = INTERVAL_UNITS.find(u => u.value === editIntervalUnit);
                      const val = parseInt(e.target.value) || unit?.min || 1;
                      setEditIntervalAmount(Math.max(unit?.min || 1, Math.min(unit?.max || 60, val)));
                    }}
                    disabled={saving}
                    className="input-apple w-16 text-center text-[12px] py-1.5"
                  />
                  <select
                    value={editIntervalUnit}
                    onChange={e => {
                      setEditIntervalUnit(e.target.value);
                      const unit = INTERVAL_UNITS.find(u => u.value === e.target.value);
                      if (unit && editIntervalAmount < unit.min) setEditIntervalAmount(unit.min);
                      if (unit && editIntervalAmount > unit.max) setEditIntervalAmount(unit.max);
                    }}
                    disabled={saving}
                    className="input-apple flex-1 text-[12px] py-1.5"
                  >
                    {INTERVAL_UNITS.map(u => (
                      <option key={u.value} value={u.value}>{u.label}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}

          <div className="flex items-center gap-2">
            <button
              onClick={handleSave}
              disabled={saving}
              className="btn-primary text-[11px] py-1 px-3"
            >
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
            <button
              onClick={() => setEditing(false)}
              disabled={saving}
              className="text-[11px] text-gray-400 hover:text-gray-600 transition-colors px-2 py-1"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Pipeline progress bar for generating_prompts stage */}
      {batch.status === 'generating_prompts' && pipelineState && (
        <div className="px-3 pb-3">
          <div className="flex items-center gap-2">
            <div className="flex-1 h-1.5 rounded-full bg-gray-200 overflow-hidden">
              <div
                className="h-full bg-blue-400 rounded-full transition-all duration-500"
                style={{ width: `${pipelinePct}%` }}
              />
            </div>
            <span className="text-[10px] text-gray-400 flex-shrink-0">
              {pipelineState.stage_label || `Stage ${pipelineStage}`}
            </span>
          </div>
        </div>
      )}

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
              {progressDone}/{progressTotal} generated
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

import { useState, useEffect, useRef, useCallback } from 'react';
import JSZip from 'jszip';
import { api } from '../api';
import BatchManager from './BatchManager';
import InfoTooltip from './InfoTooltip';
import { useToast } from './Toast';

const ASPECT_RATIOS = [
  { value: '1:1', label: '1:1 (Square)' },
  { value: '9:16', label: '9:16 (Story)' },
  { value: '16:9', label: '16:9 (Landscape)' },
  { value: '4:5', label: '4:5 (Portrait)' }
];

const STATUS_STEPS = [
  { status: 'generating_copy', label: 'Creative Direction', icon: '1' },
  { status: 'generating_image', label: 'Image Generation', icon: '2' },
  { status: 'completed', label: 'Complete', icon: '3' }
];

// Template source options
const TEMPLATE_RANDOM = 'random';      // Random from Drive folder
const TEMPLATE_UPLOAD = 'upload';      // Upload one-off image
const TEMPLATE_SELECT = 'select';      // Pick from uploaded templates

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

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function AdStudio({ projectId, project }) {
  const toast = useToast();

  // Prompt guidelines (editable on Ad Studio, synced to project)
  const [promptGuidelines, setPromptGuidelines] = useState(project?.prompt_guidelines || '');
  const [guidelinesSaving, setGuidelinesSaving] = useState(false);
  const guidelinesTimer = useRef(null);

  // Optional fields collapse
  const [optionalOpen, setOptionalOpen] = useState(false);

  // Generation controls
  const [aspectRatio, setAspectRatio] = useState('1:1');
  const [angle, setAngle] = useState('');
  const [headline, setHeadline] = useState('');
  const [bodyCopy, setBodyCopy] = useState('');

  // Prompt editing (for iterative refinement from past ads)
  const [customPrompt, setCustomPrompt] = useState('');
  const [parentAdId, setParentAdId] = useState(null);
  const [editMode, setEditMode] = useState('describe'); // 'describe' (AI edit) or 'direct' (raw prompt)
  const [editInstruction, setEditInstruction] = useState('');
  const [isApplyingEdit, setIsApplyingEdit] = useState(false);
  const [originalPromptRef, setOriginalPromptRef] = useState(''); // stores original prompt before edits
  const [promptUpdated, setPromptUpdated] = useState(false); // true after Step 1 (Update Prompt) completes
  const [editingAdImage, setEditingAdImage] = useState(null); // image URL of the ad being edited
  const [editPanelFlash, setEditPanelFlash] = useState(false);
  const editPanelRef = useRef(null);
  const editTextareaRef = useRef(null);

  // Reference image for edit (attached alongside describe-edit instruction)
  const [editReferenceFile, setEditReferenceFile] = useState(null);
  const [editReferencePreview, setEditReferencePreview] = useState(null);
  const [editRefDragOver, setEditRefDragOver] = useState(false);
  const editReferenceInputRef = useRef(null);

  // Template source
  const [templateSource, setTemplateSource] = useState(TEMPLATE_RANDOM);

  // Upload one-off image
  const [uploadedFile, setUploadedFile] = useState(null);
  const [uploadedPreview, setUploadedPreview] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);

  // Select from all templates (Drive + uploaded)
  const [driveImages, setDriveImages] = useState([]);
  const [uploadedTemplates, setUploadedTemplates] = useState([]);
  const [loadingTemplates, setLoadingTemplates] = useState(false);
  // Selection stores both the id and the source ('drive' or 'uploaded')
  const [selectedTemplate, setSelectedTemplate] = useState(null); // { id, source }

  // Product image
  const [productFile, setProductFile] = useState(null);
  const [productPreview, setProductPreview] = useState(null);
  const [productDragOver, setProductDragOver] = useState(false);
  const productFileInputRef = useRef(null);

  // Generation state — supports multiple concurrent generations
  // Each entry: { id, status, message, error, warning, stream }
  const [activeGens, setActiveGens] = useState([]);
  const [genQueueExpanded, setGenQueueExpanded] = useState(true);
  const genIdCounter = useRef(0);
  const queueRef = useRef(null);

  // Derived count of in-progress generations
  const activeGenCount = activeGens.filter(g => g.status && g.status !== 'completed' && !g.error).length;

  // Gallery
  const [ads, setAds] = useState([]);
  const [loadingAds, setLoadingAds] = useState(true);
  const [viewAd, setViewAd] = useState(null);
  const [galleryFilter, setGalleryFilter] = useState('individual'); // 'individual' | 'batch' | 'all'

  // Multi-select for bulk download
  const [selectedAdIds, setSelectedAdIds] = useState(new Set());
  const [isBulkDownloading, setIsBulkDownloading] = useState(false);

  useEffect(() => {
    loadAds();
  }, [projectId]);

  // Sync prompt guidelines when project prop changes
  useEffect(() => {
    setPromptGuidelines(project?.prompt_guidelines || '');
  }, [project?.prompt_guidelines]);

  // Auto-save prompt guidelines with debounce (1.5s after typing stops)
  const handleGuidelinesChange = (value) => {
    setPromptGuidelines(value);
    if (guidelinesTimer.current) clearTimeout(guidelinesTimer.current);
    guidelinesTimer.current = setTimeout(async () => {
      setGuidelinesSaving(true);
      try {
        await api.updateProject(projectId, { prompt_guidelines: value });
      } catch (err) {
        console.error('Failed to save prompt guidelines:', err);
      } finally {
        setGuidelinesSaving(false);
      }
    }, 1500);
  };

  // Load all templates when selecting "Pick a Template"
  useEffect(() => {
    if (templateSource === TEMPLATE_SELECT && driveImages.length === 0 && uploadedTemplates.length === 0) {
      loadTemplates();
    }
  }, [templateSource]);

  const loadAds = async () => {
    try {
      const data = await api.getAds(projectId);
      setAds(data.ads || []);
    } catch (err) {
      console.error('Failed to load ads:', err);
    } finally {
      setLoadingAds(false);
    }
  };

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

  // --- Upload handling ---
  const handleFileSelected = useCallback((file) => {
    if (!file) return;
    const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
    const ext = '.' + file.name.split('.').pop().toLowerCase();
    if (!allowed.includes(ext)) {
      setGenError(`File type ${ext} not supported. Use JPG, PNG, WebP, or GIF.`);
      return;
    }
    setUploadedFile(file);
    setUploadedPreview(URL.createObjectURL(file));
    setTemplateSource(TEMPLATE_UPLOAD);
    setGenError('');
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

  // --- Product image handling ---
  const handleProductFileSelected = useCallback((file) => {
    if (!file) return;
    const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
    const ext = '.' + file.name.split('.').pop().toLowerCase();
    if (!allowed.includes(ext)) {
      setGenError(`File type ${ext} not supported. Use JPG, PNG, WebP, or GIF.`);
      return;
    }
    setProductFile(file);
    setProductPreview(URL.createObjectURL(file));
    setGenError('');
  }, []);

  const handleProductDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setProductDragOver(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) handleProductFileSelected(file);
  }, [handleProductFileSelected]);

  const handleProductDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setProductDragOver(true);
  }, []);

  const handleProductDragLeave = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setProductDragOver(false);
  }, []);

  const clearProductImage = () => {
    setProductFile(null);
    if (productPreview) URL.revokeObjectURL(productPreview);
    setProductPreview(null);
    if (productFileInputRef.current) productFileInputRef.current.value = '';
  };

  // --- Generation ---
  const isCustomPromptMode = customPrompt.trim().length > 0;

  // Helper to update a specific generation entry
  const updateGen = (genId, updates) => {
    setActiveGens(prev => prev.map(g => g.id === genId ? { ...g, ...updates } : g));
  };

  // Remove a completed/errored generation from the list
  const dismissGen = (genId) => {
    setActiveGens(prev => prev.filter(g => g.id !== genId));
  };

  const scrollToQueue = () => {
    queueRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const handleGenerate = async () => {
    // Create a unique ID for this generation
    const genId = ++genIdCounter.current;
    const genLabel = angle || aspectRatio;

    // Validation first (before adding to active list)
    if (!isCustomPromptMode) {
      if (templateSource === TEMPLATE_UPLOAD && !uploadedFile) {
        toast.error('Please upload a template image or switch to "Random from Folder".');
        return;
      }
      if (templateSource === TEMPLATE_SELECT && !selectedTemplate) {
        toast.error('Please select a template image.');
        return;
      }
    }

    // Add this generation to active list
    const newGen = { id: genId, label: genLabel, status: null, message: 'Preparing...', error: '', warning: '' };
    setActiveGens(prev => [...prev, newGen]);

    // Notify with toast + scroll link
    toast.info(
      <span>
        Generation started{' '}
        <button
          onClick={scrollToQueue}
          className="underline font-semibold hover:text-blue-900 transition-colors"
        >
          View Queue ↓
        </button>
      </span>
    );

    // Helper: attach product image if present
    const attachProductImage = async (opts) => {
      if (productFile) {
        try {
          const productBase64 = await fileToBase64(productFile);
          opts.product_image = productBase64;
          opts.product_image_mime = productFile.type || 'image/jpeg';
        } catch {
          updateGen(genId, { error: 'Failed to read the product image.', status: null });
          return false;
        }
      }
      return true;
    };

    // SSE event handler scoped to this generation
    const handleEvent = (event) => {
      if (event.type === 'status') {
        updateGen(genId, { status: event.status, message: event.message });
      } else if (event.type === 'warning') {
        updateGen(genId, { warning: event.message });
      } else if (event.type === 'complete') {
        updateGen(genId, { status: 'completed', message: 'Ad generated successfully!' });
        setAds(prev => [event.ad, ...prev]);
      } else if (event.type === 'error') {
        updateGen(genId, { error: event.error, status: null });
      }
    };

    let stream;

    if (isCustomPromptMode) {
      updateGen(genId, { status: 'generating_image', message: 'Generating image with custom prompt...' });

      const options = {
        image_prompt: customPrompt.trim(),
        aspect_ratio: aspectRatio,
        parent_ad_id: parentAdId || undefined,
        angle: angle || undefined,
        headline: headline || undefined,
        body_copy: bodyCopy || undefined
      };

      if (!(await attachProductImage(options))) return;

      // If no product image attached but there's an edit reference image, use it as the product image for Gemini
      if (!options.product_image && editReferenceFile) {
        try {
          const refBase64 = await fileToBase64(editReferenceFile);
          options.product_image = refBase64;
          options.product_image_mime = editReferenceFile.type || 'image/jpeg';
        } catch { /* non-fatal */ }
      }

      stream = api.regenerateImage(projectId, options, handleEvent);
    } else if (templateSource === TEMPLATE_SELECT && selectedTemplate) {
      updateGen(genId, { status: 'generating_copy', message: 'Starting template-based generation...' });

      const options = {
        aspect_ratio: aspectRatio,
        angle: angle || undefined,
        headline: headline || undefined,
        body_copy: bodyCopy || undefined
      };

      if (selectedTemplate.source === 'drive') {
        options.mode = 'mode1';
        options.inspiration_image_id = selectedTemplate.id;
      } else {
        options.mode = 'mode2';
        options.template_image_id = selectedTemplate.id;
      }

      if (!(await attachProductImage(options))) return;

      stream = api.generateAd(projectId, options, handleEvent);
    } else {
      updateGen(genId, { status: 'generating_copy', message: 'Starting ad generation...' });

      const options = {
        mode: 'mode1',
        aspect_ratio: aspectRatio,
        angle: angle || undefined,
        headline: headline || undefined,
        body_copy: bodyCopy || undefined
      };

      if (templateSource === TEMPLATE_UPLOAD && uploadedFile) {
        try {
          const base64 = await fileToBase64(uploadedFile);
          options.uploaded_image = base64;
          options.uploaded_image_mime = uploadedFile.type || 'image/jpeg';
        } catch {
          updateGen(genId, { error: 'Failed to read the uploaded image.', status: null });
          return;
        }
      }

      if (!(await attachProductImage(options))) return;

      stream = api.generateAd(projectId, options, handleEvent);
    }

    stream.done
      .then(() => {
        // Auto-dismiss successful generations after 5 seconds
        setTimeout(() => {
          setActiveGens(prev => {
            const gen = prev.find(g => g.id === genId);
            if (gen && gen.status === 'completed' && !gen.error) {
              return prev.filter(g => g.id !== genId);
            }
            return prev;
          });
        }, 5000);
      })
      .catch(err => {
        updateGen(genId, { error: err.message, status: null });
      });
  };

  const handleDelete = async (adId) => {
    if (!confirm('Delete this ad? The local file will be removed. The Drive copy (if any) will remain.')) return;
    try {
      await api.deleteAd(projectId, adId);
      setAds(prev => prev.filter(a => a.id !== adId));
      setSelectedAdIds(prev => {
        if (prev.has(adId)) { const next = new Set(prev); next.delete(adId); return next; }
        return prev;
      });
      if (viewAd?.id === adId) setViewAd(null);
    } catch (err) {
      toast.error(err.message);
    }
  };

  // No longer needed — progress steps are computed per-generation in the JSX

  // Download ad image to local device
  const handleDownload = async (ad, e) => {
    if (e) e.stopPropagation();
    try {
      const response = await fetch(ad.imageUrl);
      const blob = await response.blob();
      const ext = blob.type === 'image/jpeg' ? '.jpg' : '.png';
      const filename = `ad_${ad.angle ? ad.angle.replace(/[^a-z0-9]/gi, '-').slice(0, 30) : ad.id.slice(0, 8)}_${ad.aspect_ratio.replace(':', 'x')}${ext}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error('Failed to download image');
    }
  };

  // --- Multi-select helpers ---
  const toggleAdSelection = (adId, e) => {
    if (e) e.stopPropagation();
    setSelectedAdIds(prev => {
      const next = new Set(prev);
      if (next.has(adId)) next.delete(adId);
      else next.add(adId);
      return next;
    });
  };

  const selectAllFiltered = () => {
    const completedIds = filteredAds
      .filter(ad => ad.status === 'completed' && ad.imageUrl)
      .map(ad => ad.id);
    setSelectedAdIds(new Set(completedIds));
  };

  const clearSelection = () => setSelectedAdIds(new Set());

  const selectedCount = selectedAdIds.size;

  // --- Deploy to Ad Tracker ---
  const handleDeploy = async () => {
    if (selectedAdIds.size === 0) return;
    setIsDeploying(true);
    try {
      const adIds = [...selectedAdIds];
      const result = await api.createDeployments(adIds);
      const msg = result.created > 0
        ? `${result.created} ad${result.created !== 1 ? 's' : ''} added to Ad Tracker`
        : 'All selected ads are already in Ad Tracker';
      toast.addToast(msg, result.created > 0 ? 'success' : 'info');
      clearSelection();
    } catch (err) {
      toast.addToast('Failed to deploy ads', 'error');
    } finally {
      setIsDeploying(false);
    }
  };

  // --- Bulk download ---
  const handleBulkDownload = async () => {
    if (selectedAdIds.size === 0) return;
    setIsBulkDownloading(true);
    try {
      const zip = new JSZip();
      const selectedAds = ads.filter(ad => selectedAdIds.has(ad.id) && ad.imageUrl);

      const results = await Promise.allSettled(
        selectedAds.map(async (ad) => {
          const response = await fetch(ad.imageUrl);
          const blob = await response.blob();
          const ext = blob.type === 'image/jpeg' ? '.jpg' : '.png';
          const filename = `ad_${ad.angle ? ad.angle.replace(/[^a-z0-9]/gi, '-').slice(0, 30) : ad.id.slice(0, 8)}_${ad.aspect_ratio.replace(':', 'x')}${ext}`;
          return { filename, blob };
        })
      );

      let addedCount = 0;
      const usedNames = new Set();
      for (const result of results) {
        if (result.status === 'fulfilled') {
          let name = result.value.filename;
          if (usedNames.has(name)) {
            const parts = name.split('.');
            const ext = parts.pop();
            let counter = 2;
            while (usedNames.has(`${parts.join('.')}_${counter}.${ext}`)) counter++;
            name = `${parts.join('.')}_${counter}.${ext}`;
          }
          usedNames.add(name);
          zip.file(name, result.value.blob);
          addedCount++;
        }
      }

      if (addedCount === 0) {
        toast.error('Failed to download any images.');
        return;
      }

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(zipBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ads_${addedCount}_images.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      const failedCount = results.filter(r => r.status === 'rejected').length;
      if (failedCount > 0) {
        toast.success(`Downloaded ${addedCount} ads. ${failedCount} failed to fetch.`);
      } else {
        toast.success(`Downloaded ${addedCount} ads as zip.`);
      }
      clearSelection();
    } catch (err) {
      console.error('Bulk download failed:', err);
      toast.error('Failed to create zip file.');
    } finally {
      setIsBulkDownloading(false);
    }
  };

  // --- Bulk delete ---
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const [isDeploying, setIsDeploying] = useState(false);
  const handleBulkDelete = async () => {
    const count = selectedAdIds.size;
    if (count === 0) return;
    if (!confirm(`Delete ${count} ad${count !== 1 ? 's' : ''}? Local files will be removed. Drive copies (if any) will remain.`)) return;
    setIsBulkDeleting(true);
    try {
      const ids = [...selectedAdIds];
      const results = await Promise.allSettled(
        ids.map(id => api.deleteAd(projectId, id))
      );
      const succeeded = ids.filter((_, i) => results[i].status === 'fulfilled');
      const failed = ids.filter((_, i) => results[i].status === 'rejected');
      if (succeeded.length > 0) {
        setAds(prev => prev.filter(a => !succeeded.includes(a.id)));
        setSelectedAdIds(new Set());
        if (viewAd && succeeded.includes(viewAd.id)) setViewAd(null);
      }
      if (failed.length > 0) {
        toast.error(`Deleted ${succeeded.length} ads. ${failed.length} failed.`);
      } else {
        toast.success(`Deleted ${succeeded.length} ad${succeeded.length !== 1 ? 's' : ''}.`);
      }
    } catch (err) {
      toast.error('Bulk delete failed.');
    } finally {
      setIsBulkDeleting(false);
    }
  };

  // Edit prompt workflow — load ad's prompt into editor and scroll to top
  const handleEditPrompt = (ad, e) => {
    if (e) e.stopPropagation();
    if (!ad.image_prompt) {
      toast.error('No prompt available for this ad.');
      return;
    }
    setCustomPrompt(ad.image_prompt);
    setOriginalPromptRef(ad.image_prompt);
    setParentAdId(ad.id);
    setEditingAdImage(ad.imageUrl || ad.thumbnailUrl || null);
    setAspectRatio(ad.aspect_ratio || '1:1');
    if (ad.angle) setAngle(ad.angle);
    if (ad.headline) setHeadline(ad.headline);
    if (ad.body_copy) setBodyCopy(ad.body_copy);
    setEditMode('describe');
    setEditInstruction('');
    setViewAd(null);
    // Scroll edit panel into center of screen after React renders it, then flash + focus
    setTimeout(() => {
      if (editPanelRef.current) {
        editPanelRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setEditPanelFlash(true);
        setTimeout(() => setEditPanelFlash(false), 1500);
        // Focus the textarea after scroll settles
        setTimeout(() => {
          if (editTextareaRef.current) editTextareaRef.current.focus();
        }, 500);
      }
    }, 100);
  };

  // Apply AI edit — send instruction to GPT which modifies the prompt
  const handleApplyEdit = async () => {
    if (!editInstruction.trim()) {
      toast.error('Please describe the edit you want to make.');
      return;
    }
    setIsApplyingEdit(true);
    try {
      // If a reference image is attached, convert to base64 and send along
      let referenceImage = null;
      let referenceImageMime = null;
      if (editReferenceFile) {
        try {
          referenceImage = await fileToBase64(editReferenceFile);
          referenceImageMime = editReferenceFile.type || 'image/jpeg';
        } catch {
          // Non-fatal — proceed without the image
          console.warn('Failed to read reference image, proceeding without it.');
        }
      }
      const result = await api.editPrompt(projectId, customPrompt, editInstruction.trim(), referenceImage, referenceImageMime);
      setCustomPrompt(result.revised_prompt);
      setEditInstruction('');
      setEditMode('direct'); // Switch to direct view so user can see the modified prompt
      setPromptUpdated(true);
      toast.success('Prompt updated — review it below, then hit Generate Image.');
    } catch (err) {
      toast.error(err.message || 'Failed to apply edit.');
    } finally {
      setIsApplyingEdit(false);
    }
  };

  // Filtered ads based on gallery filter
  const filteredAds = ads.filter(ad => {
    if (galleryFilter === 'individual') return !ad.auto_generated;
    if (galleryFilter === 'batch') return !!ad.auto_generated;
    return true; // 'all'
  });

  // Clear selection when filter changes
  useEffect(() => {
    setSelectedAdIds(new Set());
  }, [galleryFilter]);

  // Counts for filter labels
  const individualCount = ads.filter(a => !a.auto_generated).length;
  const batchCount = ads.filter(a => !!a.auto_generated).length;
  const completedFilteredAds = filteredAds.filter(ad => ad.status === 'completed' && ad.imageUrl);
  const allFilteredSelected = completedFilteredAds.length > 0 && completedFilteredAds.every(ad => selectedAdIds.has(ad.id));

  // Find template name for modal display
  const getTemplateName = (templateId) => {
    const t = uploadedTemplates.find(t => t.id === templateId);
    return t ? (t.description || t.filename) : templateId?.slice(0, 8);
  };

  return (
    <div className="space-y-6">
      {/* Generation Controls */}
      <div className="card p-6">
        <div className="mb-4">
          <h3 className="text-[15px] font-semibold text-gray-900 tracking-tight mb-0.5 flex items-center gap-1">Generate Ad <InfoTooltip text="Create individual ad creatives using AI. Choose a template source, set your options, and generate." position="right" /></h3>
          <p className="text-[12px] text-gray-400">
            Select a template image source, configure options, and generate a new ad creative.
          </p>
        </div>

        {/* ── REQUIRED FIELDS ── */}

        {/* Aspect Ratio */}
        <div className="mb-5">
          <label className="block text-[13px] font-medium text-gray-600 mb-1.5">Aspect Ratio</label>
          <select
            value={aspectRatio}
            onChange={e => setAspectRatio(e.target.value)}
            className="input-apple max-w-xs"
          >
            {ASPECT_RATIOS.map(ar => (
              <option key={ar.value} value={ar.value}>{ar.label}</option>
            ))}
          </select>
        </div>

        {/* Template Image Source — hidden when using a custom prompt */}
        {!isCustomPromptMode && (
          <div className="mb-5">
            <label className="block text-[13px] font-medium text-gray-600 mb-1.5">Template Image</label>
            <p className="text-[11px] text-gray-400 mb-3">
              Choose the reference ad image the AI will analyze and recreate in your brand's style.
            </p>

            {/* Source toggle */}
            <div className="segmented-control mb-3">
              <button
                onClick={() => setTemplateSource(TEMPLATE_RANDOM)}
                className={templateSource === TEMPLATE_RANDOM ? 'active' : ''}
              >
                Random Template
              </button>
              <button
                onClick={() => setTemplateSource(TEMPLATE_UPLOAD)}
                className={templateSource === TEMPLATE_UPLOAD ? 'active' : ''}
              >
                Manual Upload
              </button>
              <button
                onClick={() => setTemplateSource(TEMPLATE_SELECT)}
                className={templateSource === TEMPLATE_SELECT ? 'active' : ''}
              >
                Pick Template
              </button>
            </div>

            {/* Random from folder */}
            {templateSource === TEMPLATE_RANDOM && (
              <div className="p-4 bg-gray-50/50 border border-gray-200/60 rounded-xl">
                <div className="flex items-center gap-2 mb-1">
                  <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19.5 12c0-1.232-.046-2.453-.138-3.662a4.006 4.006 0 00-3.7-3.7 48.678 48.678 0 00-7.324 0 4.006 4.006 0 00-3.7 3.7c-.017.22-.032.441-.046.662M19.5 12l3-3m-3 3l-3-3m-12 3c0 1.232.046 2.453.138 3.662a4.006 4.006 0 003.7 3.7 48.656 48.656 0 007.324 0 4.006 4.006 0 003.7-3.7c.017-.22.032-.441.046-.662M4.5 12l3 3m-3-3l-3 3" />
                  </svg>
                  <p className="text-[13px] font-medium text-gray-600">Random from Templates Folder</p>
                </div>
                <p className="text-[11px] text-gray-400">
                  The system will randomly pick a template from your synced Google Drive templates folder.
                </p>
              </div>
            )}

            {/* Upload one-off image */}
            {templateSource === TEMPLATE_UPLOAD && (
              <div>
                {uploadedFile && uploadedPreview ? (
                  <div className="flex items-start gap-4 p-3 bg-gray-50/50 border border-gray-200/60 rounded-xl">
                    <img
                      src={uploadedPreview}
                      alt="Uploaded template"
                      className="w-20 h-20 object-cover rounded-xl border border-gray-200/60"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-medium text-gray-900 truncate">{uploadedFile.name}</p>
                      <p className="text-[11px] text-gray-400 mt-0.5">
                        {(uploadedFile.size / 1024).toFixed(0)} KB
                      </p>
                      <button
                        onClick={clearUploadedImage}
          
                        className="mt-2 text-[12px] text-red-500 hover:text-red-600 transition-colors disabled:opacity-50"
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                ) : (
                  <div
                    onClick={() => fileInputRef.current?.click()}
                    onDragOver={handleDragOver}
                    onDragEnter={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-all ${
                      dragOver ? 'border-blue-400 bg-blue-50/30' :
                      'border-gray-200/80 hover:border-blue-300 hover:bg-gray-50/30'
                    }`}
                  >
                    <div className="w-10 h-10 mx-auto mb-2 rounded-xl bg-gray-100 flex items-center justify-center">
                      <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5a2.25 2.25 0 002.25-2.25V6.75a2.25 2.25 0 00-2.25-2.25H3.75a2.25 2.25 0 00-2.25 2.25v12a2.25 2.25 0 002.25 2.25z" />
                      </svg>
                    </div>
                    <p className={`text-[13px] font-medium ${dragOver ? 'text-blue-600' : 'text-gray-500'}`}>
                      {dragOver ? 'Drop image here' : 'Drop a reference ad image here, or click to browse'}
                    </p>
                    <p className="text-[11px] text-gray-400 mt-1">JPG, PNG, WebP, or GIF</p>
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

            {/* Pick from all templates (Drive + Uploaded) */}
            {templateSource === TEMPLATE_SELECT && (
              <div>
                {loadingTemplates ? (
                  <div className="text-gray-400 text-center py-8 text-sm">Loading templates...</div>
                ) : driveImages.length === 0 && uploadedTemplates.length === 0 ? (
                  <div className="p-6 bg-gray-50/50 border border-gray-200/60 rounded-xl text-center">
                    <div className="w-10 h-10 mx-auto mb-2 rounded-xl bg-gray-100 flex items-center justify-center">
                      <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z" />
                      </svg>
                    </div>
                    <p className="text-[13px] text-gray-500 font-medium mb-1">No Templates Available</p>
                    <p className="text-[11px] text-gray-400">
                      Sync your Google Drive templates folder or upload reference ads in the Templates tab.
                    </p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {/* Drive templates */}
                    {driveImages.length > 0 && (
                      <div>
                        <p className="text-[11px] text-gray-400 font-medium mb-2">
                          Drive Templates <span className="text-gray-300">({driveImages.length})</span>
                        </p>
                        <div className="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 gap-2 max-h-[320px] overflow-y-auto rounded-xl pr-1 scrollbar-thin">
                          {driveImages.map(img => {
                            const isSelected = selectedTemplate?.id === img.id && selectedTemplate?.source === 'drive';
                            return (
                              <button
                                key={`drive-${img.id}`}
                                onClick={() => setSelectedTemplate(
                                  isSelected ? null : { id: img.id, source: 'drive' }
                                )}
                  
                                className={`group relative rounded-xl overflow-hidden border-2 transition-all aspect-square ${
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
                                  <div className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-blue-500 flex items-center justify-center shadow-sm">
                                    <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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

                    {/* Uploaded templates */}
                    {uploadedTemplates.length > 0 && (
                      <div>
                        <p className="text-[11px] text-gray-400 font-medium mb-2">
                          Uploaded Templates <span className="text-gray-300">({uploadedTemplates.length})</span>
                        </p>
                        <div className="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 gap-2">
                          {uploadedTemplates.map(t => {
                            const isSelected = selectedTemplate?.id === t.id && selectedTemplate?.source === 'uploaded';
                            return (
                              <button
                                key={`uploaded-${t.id}`}
                                onClick={() => setSelectedTemplate(
                                  isSelected ? null : { id: t.id, source: 'uploaded' }
                                )}
                  
                                className={`group relative rounded-xl overflow-hidden border-2 transition-all aspect-square ${
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
                                  <div className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-blue-500 flex items-center justify-center shadow-sm">
                                    <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                                    </svg>
                                  </div>
                                )}
                                {(t.description || t.filename) && (
                                  <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/50 to-transparent p-1.5">
                                    <p className="text-[10px] text-white truncate font-medium">
                                      {t.description || t.filename}
                                    </p>
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
                      Selected: {selectedTemplate.source === 'drive'
                        ? (driveImages.find(i => i.id === selectedTemplate.id)?.name || selectedTemplate.id).slice(0, 20)
                        : getTemplateName(selectedTemplate.id)
                      }
                    </span>
                    <span className="text-[10px] text-gray-300">
                      ({selectedTemplate.source === 'drive' ? 'Drive' : 'Uploaded'})
                    </span>
                    <button
                      onClick={() => setSelectedTemplate(null)}
        
                      className="text-[11px] text-gray-400 hover:text-gray-600 transition-colors"
                    >
                      Clear
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Product Image (project-level + optional per-ad override) */}
        <div className="mb-5">
          <label className="block text-[11px] font-medium text-gray-500 mb-1.5">
            Product Image
          </label>

          {/* Show project-level product image indicator */}
          {project?.productImageUrl && !productFile && (
            <div className="flex items-center gap-3 p-3 bg-emerald-50/50 border border-emerald-200/60 rounded-xl mb-2">
              <img
                src={project.productImageUrl}
                alt="Project product"
                className="w-10 h-10 object-cover rounded-lg border border-emerald-200/60"
              />
              <div className="flex-1 min-w-0">
                <p className="text-[11px] font-medium text-emerald-700">Project product image active</p>
                <p className="text-[10px] text-emerald-500">Automatically used for this generation</p>
              </div>
              <button
                onClick={() => productFileInputRef.current?.click()}
                className="text-[10px] text-gray-400 hover:text-gray-600 transition-colors whitespace-nowrap"
              >
                Override →
              </button>
            </div>
          )}

          {/* Per-ad override: show when user has uploaded one OR when no project image */}
          {productFile && productPreview ? (
            <div className="flex items-center gap-3 p-3 bg-gray-50/50 border border-gray-200/60 rounded-xl">
              <img
                src={productPreview}
                alt="Product image"
                className="w-12 h-12 object-cover rounded-lg border border-gray-200/60"
              />
              <div className="flex-1 min-w-0">
                <p className="text-[12px] font-medium text-gray-900 truncate">{productFile.name}</p>
                <p className="text-[10px] text-gray-400">
                  {(productFile.size / 1024).toFixed(0)} KB
                  {project?.productImageUrl ? ' — overrides project image' : ''}
                </p>
              </div>
              <button
                onClick={clearProductImage}
                className="text-[11px] text-red-400 hover:text-red-500 transition-colors"
              >
                Remove
              </button>
            </div>
          ) : !project?.productImageUrl ? (
            <div
              onClick={() => productFileInputRef.current?.click()}
              onDragOver={handleProductDragOver}
              onDragEnter={handleProductDragOver}
              onDragLeave={handleProductDragLeave}
              onDrop={handleProductDrop}
              className={`border-2 border-dashed rounded-xl p-3 text-center cursor-pointer transition-all ${
                productDragOver ? 'border-blue-400 bg-blue-50/30' :
                'border-gray-200/80 hover:border-blue-300 hover:bg-gray-50/30'
              }`}
            >
              <svg className="w-5 h-5 mx-auto mb-1 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5a2.25 2.25 0 002.25-2.25V6.75a2.25 2.25 0 00-2.25-2.25H3.75a2.25 2.25 0 00-2.25 2.25v12a2.25 2.25 0 002.25 2.25z" />
              </svg>
              <p className={`text-[11px] font-medium ${productDragOver ? 'text-blue-600' : 'text-gray-500'}`}>
                {productDragOver ? 'Drop product image here' : 'Drop a product image, or click to browse'}
              </p>
              <p className="text-[10px] text-gray-400 mt-0.5">Or set one on the project Overview for all ads</p>
            </div>
          ) : null}
          <input
            ref={productFileInputRef}
            type="file"
            accept=".jpg,.jpeg,.png,.webp,.gif"
            onChange={e => { if (e.target.files?.[0]) handleProductFileSelected(e.target.files[0]); }}
            className="hidden"
          />
        </div>

        {/* ── OPTIONAL FIELDS (collapsible) ── */}
        <div className="my-6 -mx-6">
          <button
            onClick={() => setOptionalOpen(prev => !prev)}
            className="w-full py-3 px-4 bg-gray-50/80 border-y border-gray-200/60 flex items-center justify-between hover:bg-gray-100/60 transition-colors"
          >
            <div className="text-left">
              <p className="text-[12px] font-semibold text-gray-500 uppercase tracking-wider">Optional Fields</p>
              <p className="text-[11px] text-gray-400 mt-0.5">Topic, headline, body copy, and prompt guidelines — the AI handles these if left blank.</p>
            </div>
            <svg
              className={`w-4 h-4 text-gray-400 transition-transform duration-200 ${optionalOpen ? 'rotate-180' : ''}`}
              fill="none" stroke="currentColor" viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {optionalOpen && (
            <div className="px-6 pt-4 pb-1 fade-in">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-5">
                {/* Ad Topic / Angle */}
                <div>
                  <label className="block text-[13px] font-medium text-gray-600 mb-1.5">
                    Ad Topic / Angle
                  </label>
                  <input
                    value={angle}
                    onChange={e => setAngle(e.target.value)}
                    placeholder='e.g., "customer transformation story"'
                    className="input-apple"
                  />
                </div>

                {/* Headline */}
                <div>
                  <label className="block text-[13px] font-medium text-gray-600 mb-1.5">
                    Headline
                  </label>
                  <input
                    value={headline}
                    onChange={e => setHeadline(e.target.value)}
                    placeholder='e.g., "Transform Your Skin in 30 Days"'
                    className="input-apple"
                  />
                </div>

                {/* Body Copy — full width */}
                <div className="md:col-span-2">
                  <label className="block text-[13px] font-medium text-gray-600 mb-1.5">
                    Body Copy
                  </label>
                  <input
                    value={bodyCopy}
                    onChange={e => setBodyCopy(e.target.value)}
                    placeholder='e.g., "Clinically proven formula. Shop now."'
                    className="input-apple"
                  />
                </div>
              </div>

              {/* Prompt Guidelines */}
              <div className="mb-2">
                <div className="flex items-center justify-between mb-1.5">
                  <label className="block text-[13px] font-medium text-gray-600 flex items-center gap-1">
                    Prompt Guidelines
                    <InfoTooltip text="Rules the AI will enforce on every generated image prompt. Use this to fix recurring issues in your ads." position="right" />
                  </label>
                  {guidelinesSaving && (
                    <span className="text-[11px] text-gray-400 flex items-center gap-1">
                      <div className="w-2.5 h-2.5 rounded-full border border-gray-300 border-t-blue-400 animate-spin" />
                      Saving...
                    </span>
                  )}
                  {!guidelinesSaving && promptGuidelines.trim() && (
                    <span className="text-[11px] text-green-500">Saved</span>
                  )}
                </div>
                <p className="text-[11px] text-amber-500 mb-2">
                  Optional — only needed if you're noticing a recurring pattern in the output you'd like to correct.
                </p>
                <textarea
                  value={promptGuidelines}
                  onChange={e => handleGuidelinesChange(e.target.value)}
                  rows={2}
                  className="input-apple resize-none text-[13px]"
                  placeholder='e.g., "Only show one type of produce at a time — never mix fruits/vegetables in the same image"'
                />
                <p className="text-[11px] text-gray-400 mt-1">
                  These rules are automatically applied to every image prompt before generation. Changes auto-save.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Image Edit Panel — only shown when iterating on a past ad's prompt */}
        {isCustomPromptMode && (
          <div
            ref={editPanelRef}
            className={`mb-5 p-4 border rounded-xl transition-all duration-700 ${
              editPanelFlash
                ? 'bg-blue-100/60 border-blue-400 shadow-lg shadow-blue-200/50 ring-2 ring-blue-300/50'
                : 'bg-blue-50/30 border-blue-200/60'
            }`}
          >
            <div className="flex items-center justify-between mb-2">
              <label className="block text-[13px] font-semibold text-blue-700">
                Edit Image
              </label>
              <button
                onClick={() => { setCustomPrompt(''); setParentAdId(null); setEditingAdImage(null); setEditInstruction(''); setOriginalPromptRef(''); setEditMode('describe'); setPromptUpdated(false); setEditReferenceFile(null); if (editReferencePreview) URL.revokeObjectURL(editReferencePreview); setEditReferencePreview(null); }}
                className="text-[12px] text-red-500 hover:text-red-600 transition-colors"
              >
                Exit editing
              </button>
            </div>
            {/* Preview of the ad being edited */}
            {editingAdImage && (
              <div className="flex justify-center mb-3">
                <img
                  src={editingAdImage}
                  alt="Ad being edited"
                  className="max-h-96 rounded-lg border border-blue-200/60 shadow-sm object-contain"
                />
              </div>
            )}

            {/* Mode tabs */}
            <div className="flex gap-1 mb-3 bg-gray-100/80 rounded-lg p-0.5">
              <button
                onClick={() => setEditMode('describe')}
                className={`flex-1 text-[12px] py-1.5 px-3 rounded-md transition-all font-medium ${
                  editMode === 'describe'
                    ? 'bg-white text-blue-700 shadow-sm'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                Describe Edit
              </button>
              <button
                onClick={() => setEditMode('direct')}
                className={`flex-1 text-[12px] py-1.5 px-3 rounded-md transition-all font-medium ${
                  editMode === 'direct'
                    ? 'bg-white text-blue-700 shadow-sm'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                Edit Prompt Directly
              </button>
            </div>

            {editMode === 'describe' ? (
              /* Describe Edit mode — natural language + optional reference image */
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-[10px] font-semibold text-blue-500 bg-blue-100/60 px-1.5 py-0.5 rounded">Step 1</span>
                  <p className="text-[11px] text-blue-600/70">
                    Describe what to change — AI will rewrite the prompt for you.
                  </p>
                </div>
                <textarea
                  ref={editTextareaRef}
                  value={editInstruction}
                  onChange={e => setEditInstruction(e.target.value)}
                  rows={3}
                  placeholder={'e.g., "Change the background to warm orange sunset tones" or "The product shown is wrong \u2014 I\u2019ve attached the correct one"'}
                  className="input-apple resize-none border-blue-300/80 bg-white text-[13px] mb-2"
                  onKeyDown={e => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !isApplyingEdit) {
                      e.preventDefault();
                      handleApplyEdit();
                    }
                  }}
                />

                {/* Reference image upload */}
                {editReferenceFile && editReferencePreview ? (
                  <div className="flex items-center gap-3 mb-2 p-2 bg-blue-50/50 border border-blue-200/40 rounded-lg">
                    <img
                      src={editReferencePreview}
                      alt="Reference"
                      className="w-10 h-10 object-cover rounded-lg border border-blue-200/60"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-[11px] text-gray-700 truncate">{editReferenceFile.name}</p>
                      <p className="text-[10px] text-gray-400">{(editReferenceFile.size / 1024).toFixed(0)} KB</p>
                    </div>
                    <button
                      onClick={() => {
                        setEditReferenceFile(null);
                        if (editReferencePreview) URL.revokeObjectURL(editReferencePreview);
                        setEditReferencePreview(null);
                        if (editReferenceInputRef.current) editReferenceInputRef.current.value = '';
                      }}
                      className="text-[11px] text-red-400 hover:text-red-500 transition-colors flex-shrink-0"
                    >
                      Remove
                    </button>
                  </div>
                ) : (
                  <div
                    onClick={() => editReferenceInputRef.current?.click()}
                    onDragOver={e => { e.preventDefault(); e.stopPropagation(); setEditRefDragOver(true); }}
                    onDragEnter={e => { e.preventDefault(); e.stopPropagation(); setEditRefDragOver(true); }}
                    onDragLeave={e => { e.preventDefault(); e.stopPropagation(); setEditRefDragOver(false); }}
                    onDrop={e => {
                      e.preventDefault(); e.stopPropagation(); setEditRefDragOver(false);
                      const file = e.dataTransfer.files?.[0];
                      if (file && file.type.startsWith('image/')) {
                        setEditReferenceFile(file);
                        setEditReferencePreview(URL.createObjectURL(file));
                      }
                    }}
                    className={`flex flex-col items-center justify-center gap-1 mb-2 px-3 py-4 rounded-lg border-2 border-dashed cursor-pointer transition-all ${
                      editRefDragOver
                        ? 'border-blue-400 bg-blue-50 text-blue-600'
                        : 'border-blue-300/70 bg-blue-50/40 hover:border-blue-400 hover:bg-blue-50/70 text-blue-500 hover:text-blue-600'
                    }`}
                  >
                    <svg className="w-5 h-5 mb-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                    </svg>
                    <span className="text-[12px] font-medium">
                      {editRefDragOver ? 'Drop image here' : 'Attach a reference image'}
                    </span>
                    {!editRefDragOver && (
                      <span className="text-[10px] text-blue-400">
                        Click to browse or drag & drop
                      </span>
                    )}
                  </div>
                )}
                <input
                  ref={editReferenceInputRef}
                  type="file"
                  accept=".jpg,.jpeg,.png,.webp,.gif"
                  onChange={e => {
                    const file = e.target.files?.[0];
                    if (file) {
                      setEditReferenceFile(file);
                      setEditReferencePreview(URL.createObjectURL(file));
                    }
                  }}
                  className="hidden"
                />

                <button
                  onClick={handleApplyEdit}
                  disabled={isApplyingEdit || !editInstruction.trim()}
                  className={`text-[12px] font-medium px-4 py-2 rounded-lg transition-all ${
                    isApplyingEdit || !editInstruction.trim()
                      ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                      : 'bg-blue-600 text-white hover:bg-blue-700 shadow-sm'
                  }`}
                >
                  {isApplyingEdit ? (
                    <span className="flex items-center gap-1.5">
                      <svg className="animate-spin h-3.5 w-3.5" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                      Updating prompt...
                    </span>
                  ) : 'Update Prompt'}
                </button>
                <span className="text-[10px] text-gray-400 ml-2">{navigator.platform?.includes('Mac') ? '⌘' : 'Ctrl'}+Enter</span>
              </div>
            ) : (
              /* Direct edit mode — raw prompt textarea */
              <div>
                <p className="text-[11px] text-blue-600/70 mb-2">
                  Review or tweak the prompt, then generate.
                </p>
                <textarea
                  value={customPrompt}
                  onChange={e => setCustomPrompt(e.target.value)}
                  rows={8}
                  className="input-apple resize-none border-blue-300/80 bg-white font-mono text-[12px]"
                />
                {originalPromptRef && customPrompt !== originalPromptRef && (
                  <button
                    onClick={() => setCustomPrompt(originalPromptRef)}
                    className="text-[11px] text-gray-400 hover:text-gray-600 mt-1.5 transition-colors"
                  >
                    Reset to original prompt
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* Step 2 hint — shown after user has updated the prompt via Step 1 */}
        {isCustomPromptMode && promptUpdated && (
          <div className="flex items-center gap-2 mb-2 fade-in">
            <span className="text-[10px] font-semibold text-green-600 bg-green-100/60 px-1.5 py-0.5 rounded">Step 2</span>
            <p className="text-[11px] text-gray-500">
              Review the prompt above, then generate your new image.
            </p>
          </div>
        )}

        {/* Generate Button — always enabled for parallel generation */}
        <button
          onClick={handleGenerate}
          className="btn-primary"
        >
          {isCustomPromptMode
            ? 'Generate Image'
            : 'Generate Ad'}
        </button>
        {activeGenCount > 0 && (
          <p className="text-[11px] text-gray-400 mt-1.5">
            {activeGenCount} generation{activeGenCount !== 1 ? 's' : ''} in progress — you can generate more while waiting
          </p>
        )}

      </div>

      {/* Batch Generation */}
      <BatchManager
        projectId={projectId}
        project={project}
        onBatchComplete={loadAds}
      />

      {/* Ad Queue — inline between batch generation and gallery */}
      {activeGens.length > 0 && (
        <div ref={queueRef} className="card p-4 mb-6 fade-in">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-lg bg-blue-100 flex items-center justify-center flex-shrink-0">
                {activeGenCount > 0 ? (
                  <div className="w-3 h-3 rounded-full border-2 border-blue-200 border-t-blue-500 animate-spin" />
                ) : (
                  <svg className="w-3 h-3 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
                )}
              </div>
              <h3 className="text-[14px] font-semibold text-gray-900 tracking-tight">Ad Queue</h3>
              <span className="text-[11px] text-gray-400">
                {activeGenCount > 0
                  ? `${activeGenCount} generating...`
                  : 'All complete'}
              </span>
            </div>
            <button
              onClick={() => setGenQueueExpanded(!genQueueExpanded)}
              className="text-gray-400 hover:text-gray-600 transition-colors p-1"
            >
              <svg className={`w-4 h-4 transition-transform ${genQueueExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
          </div>

          {genQueueExpanded && (
            <div className="space-y-1.5">
              {activeGens.map(gen => {
                const steps = gen.status === 'generating_image' && !gen.message?.includes('copy')
                  ? STATUS_STEPS.filter(s => s.status !== 'generating_copy')
                  : STATUS_STEPS;
                const stepIndex = steps.findIndex(s => s.status === gen.status);

                return (
                  <div key={gen.id} className="flex items-center gap-3 px-3 py-2 rounded-lg bg-gray-50/80">
                    {gen.error ? (
                      <svg className="w-3.5 h-3.5 text-red-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" /></svg>
                    ) : gen.status === 'completed' ? (
                      <svg className="w-3.5 h-3.5 text-green-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                    ) : (
                      <div className="w-3.5 h-3.5 rounded-full border-2 border-gray-300 border-t-blue-500 animate-spin flex-shrink-0" />
                    )}
                    <div className="flex-1 min-w-0">
                      <p className={`text-[12px] font-medium truncate ${gen.error ? 'text-red-600' : gen.status === 'completed' ? 'text-green-600' : 'text-gray-700'}`}>
                        {gen.label && <span className="text-gray-400 mr-1.5">{gen.label}</span>}
                        {gen.error || gen.message || 'Starting...'}
                      </p>
                      {gen.warning && (
                        <p className="text-[10px] text-amber-500 truncate">{gen.warning}</p>
                      )}
                    </div>
                    {!gen.error && gen.status !== 'completed' && (
                      <div className="hidden sm:flex items-center gap-1 flex-shrink-0">
                        {steps.map((step, i) => (
                          <div key={step.status} className={`w-1.5 h-1.5 rounded-full transition-all ${i === stepIndex ? 'bg-blue-500 scale-125' : i < stepIndex ? 'bg-blue-300' : 'bg-gray-200'}`} title={step.label} />
                        ))}
                      </div>
                    )}
                    {(gen.error || gen.status === 'completed') && (
                      <button onClick={() => dismissGen(gen.id)} className="text-gray-300 hover:text-gray-500 flex-shrink-0 transition-colors">
                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Ad Gallery */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-[15px] font-semibold text-gray-900 tracking-tight flex items-center gap-1">Ad Gallery <InfoTooltip text="All generated ad creatives for this project. Click an ad to view details, download, or edit the prompt." position="right" /></h3>
            {ads.length > 0 && (
              <p className="text-[12px] text-gray-400">
                {filteredAds.length} ad{filteredAds.length !== 1 ? 's' : ''}
                {galleryFilter !== 'all' && ` (${ads.length} total)`}
              </p>
            )}
          </div>
          {ads.length > 0 && (
            <div className="segmented-control text-[12px]">
              <button
                onClick={() => setGalleryFilter('individual')}
                className={galleryFilter === 'individual' ? 'active' : ''}
              >
                Individual{individualCount > 0 ? ` (${individualCount})` : ''}
              </button>
              <button
                onClick={() => setGalleryFilter('batch')}
                className={galleryFilter === 'batch' ? 'active' : ''}
              >
                Batch{batchCount > 0 ? ` (${batchCount})` : ''}
              </button>
              <button
                onClick={() => setGalleryFilter('all')}
                className={galleryFilter === 'all' ? 'active' : ''}
              >
                All
              </button>
            </div>
          )}
        </div>

        {/* Selection controls */}
        {completedFilteredAds.length > 0 && !loadingAds && (
          <div className="flex items-center gap-3 mb-3">
            <button
              onClick={allFilteredSelected ? clearSelection : selectAllFiltered}
              className="text-[12px] font-medium text-blue-600 hover:text-blue-700 transition-colors"
            >
              {allFilteredSelected ? 'Deselect All' : 'Select All'}
            </button>
            {selectedCount > 0 && (
              <span className="text-[12px] text-gray-400">
                {selectedCount} selected
              </span>
            )}
          </div>
        )}

        {loadingAds ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
            {[0, 1, 2, 3, 4, 5].map(i => (
              <div key={i} className="card overflow-hidden animate-pulse">
                <div className="aspect-square bg-gray-200" />
                <div className="p-3">
                  <div className="flex justify-between mb-1">
                    <div className="h-3 w-10 bg-gray-100 rounded" />
                    <div className="h-3 w-14 bg-gray-100 rounded" />
                  </div>
                  <div className="h-3 w-24 bg-gray-200 rounded mt-1" />
                </div>
              </div>
            ))}
          </div>
        ) : ads.length === 0 ? (
          <div className="card p-12 text-center">
            <div className="w-12 h-12 mx-auto mb-3 rounded-2xl bg-gray-100 flex items-center justify-center">
              <svg className="w-6 h-6 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5a2.25 2.25 0 002.25-2.25V6.75a2.25 2.25 0 00-2.25-2.25H3.75a2.25 2.25 0 00-2.25 2.25v12a2.25 2.25 0 002.25 2.25z" />
              </svg>
            </div>
            <h4 className="font-medium text-gray-600 text-[14px] mb-1">No Ads Yet</h4>
            <p className="text-[12px] text-gray-400 max-w-sm mx-auto">
              Choose a template source above and click Generate to create your first ad.
            </p>
          </div>
        ) : filteredAds.length === 0 ? (
          <div className="card p-8 text-center">
            <p className="text-[13px] text-gray-500 mb-1">No {galleryFilter === 'batch' ? 'batch' : 'individual'} ads yet</p>
            <p className="text-[12px] text-gray-400">
              {galleryFilter === 'batch'
                ? 'Run a batch generation to see ads here.'
                : 'Generate an ad above to see it here.'}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
            {filteredAds.map(ad => (
              <div
                key={ad.id}
                className={`group card overflow-hidden transition-all duration-300 hover:-translate-y-0.5 ${
                  selectedAdIds.has(ad.id) ? 'ring-2 ring-blue-500 ring-offset-1' : ''
                }`}
              >
                <div
                  className="aspect-square bg-gray-50 cursor-pointer relative overflow-hidden"
                  onClick={() => {
                    if (ad.status !== 'completed') return;
                    if (selectedCount > 0) toggleAdSelection(ad.id);
                    else setViewAd(ad);
                  }}
                >
                  {ad.imageUrl && ad.status === 'completed' ? (
                    <img
                      src={ad.thumbnailUrl || ad.imageUrl}
                      alt={`Ad - ${ad.angle || 'No angle'}`}
                      className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-500"
                      loading="lazy"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      {ad.status === 'failed' ? (
                        <svg className="w-6 h-6 text-red-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" /></svg>
                      ) : (
                        <div className="w-6 h-6 rounded-full border-2 border-gray-200 border-t-blue-400 animate-spin" />
                      )}
                    </div>
                  )}

                  {/* Selection checkbox — visible on hover or when selected */}
                  {ad.status === 'completed' && (
                    <button
                      onClick={(e) => toggleAdSelection(ad.id, e)}
                      className={`absolute top-2 left-2 z-10 w-6 h-6 rounded-lg flex items-center justify-center transition-all duration-200 ${
                        selectedAdIds.has(ad.id)
                          ? 'bg-blue-500 text-white shadow-sm'
                          : 'bg-black/30 backdrop-blur-sm text-white/80 opacity-0 group-hover:opacity-100 hover:bg-black/50'
                      }`}
                      title={selectedAdIds.has(ad.id) ? 'Deselect' : 'Select for bulk download'}
                    >
                      {selectedAdIds.has(ad.id) ? (
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                        </svg>
                      ) : (
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </button>
                  )}

                  {/* Mode badge */}
                  <div className={`absolute top-2 ${ad.status === 'completed' ? 'left-10' : 'left-2'} badge ${
                    ad.status === 'completed' ? 'bg-white/80 backdrop-blur-sm text-gray-600' :
                    ad.status === 'failed' ? 'bg-red-100/80 text-red-600' :
                    'bg-blue-100/80 text-blue-600'
                  }`}>
                    {ad.generation_mode === 'image_only' ? 'RE' : ad.generation_mode === 'mode2' ? 'T' : 'Ad'}
                  </div>

                  {/* Action icons — visible on hover */}
                  {ad.status === 'completed' && (
                    <div className="absolute bottom-2 right-2 flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                      {/* Download */}
                      <button
                        onClick={(e) => handleDownload(ad, e)}
                        className="w-7 h-7 rounded-lg bg-black/40 backdrop-blur-sm flex items-center justify-center text-white/90 hover:bg-black/60 transition-all"
                        title="Download image"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                        </svg>
                      </button>
                      {/* Edit prompt */}
                      {ad.image_prompt && (
                        <button
                          onClick={(e) => handleEditPrompt(ad, e)}
                          className="w-7 h-7 rounded-lg bg-black/40 backdrop-blur-sm flex items-center justify-center text-white/90 hover:bg-black/60 transition-all"
                          title="Edit image"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
                          </svg>
                        </button>
                      )}
                    </div>
                  )}

                  {ad.drive_url && (
                    <div className="absolute top-2 right-2 badge bg-white/80 backdrop-blur-sm text-gray-500">
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.25 15a4.5 4.5 0 004.5 4.5H18a3.75 3.75 0 001.332-7.257 3 3 0 00-3.758-3.848 5.25 5.25 0 00-10.233 2.33A4.502 4.502 0 002.25 15z" /></svg>
                    </div>
                  )}
                </div>

                <div className="p-3">
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="text-[11px] text-gray-400">{ad.aspect_ratio}</span>
                    <span className="text-[11px] text-gray-400">{formatDate(ad.created_at)}</span>
                  </div>
                  {ad.angle && (
                    <p className="text-[12px] text-gray-700 font-medium truncate" title={ad.angle}>
                      {ad.angle}
                    </p>
                  )}
                  <div className="flex gap-2 mt-2">
                    {ad.drive_url && (
                      <a
                        href={ad.drive_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[11px] text-blue-500 hover:text-blue-600 transition-colors"
                        onClick={e => e.stopPropagation()}
                      >
                        Drive
                      </a>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDelete(ad.id); }}
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

      {/* Full-size ad view modal */}
      {viewAd && (
        <div
          className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4"
          onClick={() => setViewAd(null)}
        >
          <div
            className="relative max-w-5xl w-full max-h-[90vh] bg-white rounded-2xl overflow-hidden shadow-apple-xl flex flex-col md:flex-row fade-in"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex-1 bg-gray-50 flex items-center justify-center p-2 min-h-[300px]">
              <img
                src={viewAd.imageUrl}
                alt={`Ad - ${viewAd.angle || 'No angle'}`}
                className="max-w-full max-h-[80vh] object-contain rounded-xl"
              />
            </div>

            <div className="w-full md:w-80 border-t md:border-t-0 md:border-l border-gray-200/60 p-5 overflow-y-auto max-h-[40vh] md:max-h-[90vh] scrollbar-thin">
              <div className="flex items-center justify-between mb-4">
                <h4 className="text-[15px] font-semibold text-gray-900 tracking-tight">Ad Details</h4>
                <button
                  onClick={() => setViewAd(null)}
                  className="w-7 h-7 rounded-lg bg-gray-100 flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-200 transition-all"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>

              {/* Quick Actions */}
              <div className="flex gap-2 mb-5">
                <button
                  onClick={(e) => handleDownload(viewAd, e)}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2 px-3 bg-gray-900 text-white rounded-xl text-[12px] font-medium hover:bg-gray-800 transition-colors"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                  </svg>
                  Download
                </button>
                {viewAd.image_prompt && (
                  <button
                    onClick={(e) => handleEditPrompt(viewAd, e)}
                    className="flex-1 flex items-center justify-center gap-1.5 py-2 px-3 bg-blue-500 text-white rounded-xl text-[12px] font-medium hover:bg-blue-600 transition-colors"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L10.582 16.07a4.5 4.5 0 01-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 011.13-1.897l8.932-8.931zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0115.75 21H5.25A2.25 2.25 0 013 18.75V8.25A2.25 2.25 0 015.25 6H10" />
                    </svg>
                    Edit Image
                  </button>
                )}
              </div>

              {/* Edit workflow explanation */}
              {viewAd.image_prompt && (
                <div className="mb-5 p-3 bg-blue-50/50 border border-blue-200/40 rounded-xl">
                  <p className="text-[11px] font-medium text-blue-700 mb-1">How editing works</p>
                  <p className="text-[10px] text-blue-600/70 leading-relaxed">
                    Click "Edit" to open the editor. Describe what you want to change in plain English and AI will update the prompt — or switch to direct editing for manual control. The original ad stays untouched.
                  </p>
                </div>
              )}

              <div className="space-y-4 text-[13px]">
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-[11px] text-gray-400 mb-0.5">Source</p>
                    <p className="text-gray-900 text-[12px]">
                      {viewAd.auto_generated ? 'Batch' :
                       viewAd.generation_mode === 'image_only' ? 'Prompt Edit' :
                       viewAd.generation_mode === 'mode2' ? 'Template' : 'Individual'}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] text-gray-400 mb-0.5">Aspect Ratio</p>
                    <p className="text-gray-900 text-[12px]">{viewAd.aspect_ratio}</p>
                  </div>
                </div>
                {viewAd.angle && (
                  <div>
                    <p className="text-[11px] text-gray-400 mb-0.5">Ad Topic / Angle</p>
                    <p className="text-gray-900">{viewAd.angle}</p>
                  </div>
                )}
                {viewAd.headline && (
                  <div>
                    <p className="text-[11px] text-gray-400 mb-0.5">Headline</p>
                    <p className="text-gray-900">{viewAd.headline}</p>
                  </div>
                )}
                {viewAd.body_copy && (
                  <div>
                    <p className="text-[11px] text-gray-400 mb-0.5">Body Copy</p>
                    <p className="text-gray-900">{viewAd.body_copy}</p>
                  </div>
                )}
                {viewAd.template_image_id && (
                  <div>
                    <p className="text-[11px] text-gray-400 mb-0.5">Template Image</p>
                    <div className="flex items-center gap-2">
                      <img
                        src={`/api/projects/${projectId}/templates/${viewAd.template_image_id}/file`}
                        alt="Template"
                        className="w-10 h-10 object-cover rounded-lg border border-gray-200/60"
                      />
                      <span className="text-gray-600 text-[12px]">{getTemplateName(viewAd.template_image_id)}</span>
                    </div>
                  </div>
                )}
                {viewAd.parent_ad_id && (
                  <div>
                    <p className="text-[11px] text-gray-400 mb-0.5">Derived From</p>
                    <button
                      onClick={() => {
                        const parentAd = ads.find(a => a.id === viewAd.parent_ad_id);
                        if (parentAd) setViewAd(parentAd);
                      }}
                      className="text-blue-500 hover:text-blue-600 text-[13px] transition-colors"
                    >
                      View parent ad
                    </button>
                  </div>
                )}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-[11px] text-gray-400 mb-0.5">Created</p>
                    <p className="text-gray-900 text-[12px]">{new Date(viewAd.created_at).toLocaleString()}</p>
                  </div>
                  {viewAd.drive_url && (
                    <div>
                      <p className="text-[11px] text-gray-400 mb-0.5">Google Drive</p>
                      <a
                        href={viewAd.drive_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-500 hover:text-blue-600 text-[12px] transition-colors"
                      >
                        Open in Drive
                      </a>
                    </div>
                  )}
                </div>
                {viewAd.image_prompt && (
                  <div>
                    <p className="text-[11px] text-gray-400 mb-1">Image Prompt</p>
                    <p className="text-gray-600 text-[12px] leading-relaxed max-h-40 overflow-y-auto whitespace-pre-wrap bg-gray-50/50 p-3 rounded-xl scrollbar-thin font-mono">
                      {viewAd.image_prompt}
                    </p>
                  </div>
                )}
                <div className="pt-3 border-t border-gray-100/80">
                  <button
                    onClick={() => handleDelete(viewAd.id)}
                    className="text-[12px] text-red-500 hover:text-red-600 transition-colors"
                  >
                    Delete Ad
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      {/* (Queue is now inline above the Ad Gallery) */}
      {/* Floating bulk action bar */}
      {selectedCount > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 fade-in">
          <div className="flex items-center gap-3 px-5 py-3 bg-gray-900/95 backdrop-blur-sm rounded-2xl shadow-lg border border-white/10">
            <span className="text-[13px] text-white font-medium">
              {selectedCount} ad{selectedCount !== 1 ? 's' : ''} selected
            </span>

            <div className="w-px h-5 bg-white/20" />

            <button
              onClick={handleDeploy}
              disabled={isDeploying}
              className="flex items-center gap-1.5 px-4 py-1.5 bg-emerald-500 hover:bg-emerald-600 disabled:bg-emerald-400 text-white text-[13px] font-medium rounded-xl transition-colors"
            >
              {isDeploying ? (
                <>
                  <div className="w-3.5 h-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  Deploying...
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.59 14.37a6 6 0 01-5.84 7.38v-4.8m5.84-2.58a14.98 14.98 0 006.16-12.12A14.98 14.98 0 009.631 8.41m5.96 5.96a14.926 14.926 0 01-5.841 2.58m-.119-8.54a6 6 0 00-7.381 5.84h4.8m2.58-5.84a14.927 14.927 0 00-2.58 5.84m2.699 2.7c-.103.021-.207.041-.311.06a15.09 15.09 0 01-2.448-2.448 14.9 14.9 0 01.06-.312m-2.24 2.39a4.493 4.493 0 00-1.757 4.306 4.493 4.493 0 004.306-1.758M16.5 9a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0z" />
                  </svg>
                  Deploy
                </>
              )}
            </button>

            <button
              onClick={handleBulkDownload}
              disabled={isBulkDownloading}
              className="flex items-center gap-1.5 px-4 py-1.5 bg-blue-500 hover:bg-blue-600 disabled:bg-blue-400 text-white text-[13px] font-medium rounded-xl transition-colors"
            >
              {isBulkDownloading ? (
                <>
                  <div className="w-3.5 h-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  Zipping...
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                  </svg>
                  Download Zip
                </>
              )}
            </button>

            <button
              onClick={handleBulkDelete}
              disabled={isBulkDeleting}
              className="flex items-center gap-1.5 px-4 py-1.5 bg-red-500 hover:bg-red-600 disabled:bg-red-400 text-white text-[13px] font-medium rounded-xl transition-colors"
            >
              {isBulkDeleting ? (
                <>
                  <div className="w-3.5 h-3.5 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  Deleting...
                </>
              ) : (
                <>
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                  </svg>
                  Delete
                </>
              )}
            </button>

            <button
              onClick={clearSelection}
              className="text-white/60 hover:text-white/90 transition-colors"
              title="Clear selection"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

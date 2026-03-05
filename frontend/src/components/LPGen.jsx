import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import InfoTooltip from './InfoTooltip';
import PipelineProgress from './PipelineProgress';
import { useToast } from './Toast';
import { usePolling } from '../hooks/usePolling';

// ─── Section type labels for display ────────────────────────────────────────
const SECTION_LABELS = {
  headline: 'Headline',
  subheadline: 'Subheadline',
  lead: 'Lead / Opening Hook',
  problem: 'Problem Agitation',
  solution: 'Solution / Mechanism',
  benefits: 'Benefits',
  proof: 'Social Proof',
  offer: 'The Offer',
  guarantee: 'Guarantee / Risk Reversal',
  cta: 'Call to Action',
  ps: 'P.S.',
  story: 'Story',
  objection_handling: 'Objection Handling',
  faq: 'FAQ',
};

function getSectionLabel(type) {
  return SECTION_LABELS[type] || type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// ─── Section badge colors ───────────────────────────────────────────────────
const SECTION_COLORS = {
  headline: 'bg-navy/10 text-navy',
  subheadline: 'bg-navy/5 text-navy/80',
  lead: 'bg-gold/10 text-gold',
  problem: 'bg-red-50 text-red-600',
  solution: 'bg-teal/10 text-teal',
  benefits: 'bg-teal/5 text-teal',
  proof: 'bg-navy/10 text-navy',
  offer: 'bg-gold/10 text-gold',
  guarantee: 'bg-teal/10 text-teal',
  cta: 'bg-gold/15 text-gold font-semibold',
  ps: 'bg-black/5 text-textmid',
};

function getSectionColor(type) {
  return SECTION_COLORS[type] || 'bg-black/5 text-textmid';
}

// ─── Word count helper ──────────────────────────────────────────────────────
function countWords(text) {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// ─── Phase labels for progress display ──────────────────────────────────────
const PHASE_LABELS = {
  fetch: { label: 'Page Fetch', icon: '🌐', description: 'Loading swipe page and taking screenshot...' },
  design_analysis: { label: 'Design Analysis', icon: '🎨', description: 'Analyzing swipe page visual layout...' },
  copy_generation: { label: 'Copy Generation', icon: '✍️', description: 'Writing landing page copy...' },
  image_generation: { label: 'Image Generation', icon: '🖼️', description: 'Generating images via Gemini...' },
  html_generation: { label: 'HTML Template', icon: '🏗️', description: 'Building HTML page...' },
  assembling: { label: 'Assembly', icon: '🔧', description: 'Assembling final page...' },
};

// Empirical time estimates per phase (seconds)
const PHASE_TIMING = {
  fetch: 15,
  design_analysis: 25,
  copy_generation: 40,
  image_generation: 15, // per image
  html_generation: 30,
  assembling: 3,
};

function estimateRemainingSeconds(phases, currentPhase, imageTotal) {
  if (!currentPhase || currentPhase === 'done') return null;
  const currentIdx = phases.indexOf(currentPhase);
  if (currentIdx < 0) return null;

  let remaining = 0;
  for (let i = currentIdx; i < phases.length; i++) {
    const t = PHASE_TIMING[phases[i]];
    if (!t) continue;
    if (phases[i] === 'image_generation') {
      remaining += (imageTotal || 3) * t;
    } else {
      remaining += t;
    }
  }
  // Assume halfway through current phase
  const currentT = PHASE_TIMING[currentPhase];
  if (currentT) {
    const phaseTime = currentPhase === 'image_generation' ? (imageTotal || 3) * currentT : currentT;
    remaining -= Math.round(phaseTime / 2);
  }
  return Math.max(0, remaining);
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Copy Section Display (collapsible)
// ═══════════════════════════════════════════════════════════════════════════
function CopySection({ section, index, defaultExpanded = false }) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const wordCount = countWords(section.content);

  return (
    <div className="border border-black/5 rounded-xl overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 bg-offwhite hover:bg-cream/50 transition-colors"
      >
        <div className="flex items-center gap-2.5">
          <span className="text-[11px] font-mono text-textlight w-5">{index + 1}</span>
          <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${getSectionColor(section.type)}`}>
            {getSectionLabel(section.type)}
          </span>
          <span className="text-[10px] text-textlight">{wordCount} words</span>
        </div>
        <svg
          className={`w-3.5 h-3.5 text-textlight transition-transform ${expanded ? 'rotate-180' : ''}`}
          fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
        </svg>
      </button>
      {expanded && (
        <div className="px-4 py-3 bg-white">
          <div className="text-[13px] text-textdark leading-relaxed whitespace-pre-wrap">
            {section.content}
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Sandboxed iframe preview for assembled HTML
// ═══════════════════════════════════════════════════════════════════════════
function HtmlPreview({ html, className = '' }) {
  const iframeRef = useRef(null);
  const [iframeHeight, setIframeHeight] = useState(800);

  useEffect(() => {
    if (!iframeRef.current || !html) return;

    // Auto-resize iframe to fit content
    const handleMessage = (event) => {
      if (event.data?.type === 'lp-preview-height' && typeof event.data.height === 'number') {
        setIframeHeight(Math.min(event.data.height + 40, 5000)); // cap at 5000px
      }
    };
    window.addEventListener('message', handleMessage);

    return () => window.removeEventListener('message', handleMessage);
  }, [html]);

  if (!html) return null;

  // Inject a small script into the HTML to communicate height back to parent
  const htmlWithHeightReporter = html.replace(
    '</body>',
    `<script>
      (function() {
        function reportHeight() {
          var h = document.documentElement.scrollHeight || document.body.scrollHeight;
          window.parent.postMessage({ type: 'lp-preview-height', height: h }, '*');
        }
        reportHeight();
        window.addEventListener('load', reportHeight);
        setTimeout(reportHeight, 500);
        setTimeout(reportHeight, 2000);
        new MutationObserver(reportHeight).observe(document.body, { childList: true, subtree: true });
      })();
    </script></body>`
  );

  return (
    <div className={`border border-black/10 rounded-xl overflow-hidden bg-white ${className}`}>
      <iframe
        ref={iframeRef}
        srcDoc={htmlWithHeightReporter}
        sandbox="allow-scripts"
        title="Landing Page Preview"
        className="w-full border-0"
        style={{ height: `${iframeHeight}px`, minHeight: '400px' }}
      />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Client-side assembly function (mirrors backend assembleLandingPage)
// ═══════════════════════════════════════════════════════════════════════════
function assembleHtmlClient(htmlTemplate, copySections, imageSlots, ctaLinks) {
  if (!htmlTemplate) return '';
  let html = htmlTemplate;

  // Replace copy section placeholders: {{section_type}} → actual content
  for (const section of (copySections || [])) {
    const placeholder = `{{${section.type}}}`;
    const htmlContent = section.content
      .split(/\n\n+/)
      .map(para => para.trim())
      .filter(para => para.length > 0)
      .map(para => {
        if (para.length < 100 && !para.includes('.')) return para;
        return `<p>${para.replace(/\n/g, '<br>')}</p>`;
      })
      .join('\n');
    html = html.replaceAll(placeholder, htmlContent);
  }

  // Replace image placeholders: {{image_N}} → actual storage URL or placeholder
  if (imageSlots && imageSlots.length > 0) {
    for (let i = 0; i < imageSlots.length; i++) {
      const placeholder = `{{image_${i + 1}}}`;
      const slot = imageSlots[i];
      const url = slot.storageUrl || `https://placehold.co/${slot.suggested_size || '800x400'}/e2e8f0/64748b?text=Image+${i + 1}`;
      html = html.replaceAll(placeholder, url);
    }
  }

  // Replace CTA placeholders: {{cta_N_url}} and {{cta_N_text}}
  if (ctaLinks && ctaLinks.length > 0) {
    for (let i = 0; i < ctaLinks.length; i++) {
      const urlPlaceholder = `{{cta_${i + 1}_url}}`;
      const textPlaceholder = `{{cta_${i + 1}_text}}`;
      const cta = ctaLinks[i];
      html = html.replaceAll(urlPlaceholder, cta.url || '#order');
      html = html.replaceAll(textPlaceholder, cta.text || cta.text_suggestion || 'Order Now');
    }
  }

  // ── Metadata placeholder replacement (mirrors backend postProcessLP defaults) ──
  // Without this, the auto-save overwrites correct assembled_html with broken HTML from htmlTemplate
  html = html.replace(/\{\{[\s]*publish_date[\s]*\}\}/gi, new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }));
  html = html.replace(/\{\{[\s]*author_name[\s]*\}\}/gi, 'Sarah Mitchell');
  html = html.replace(/\{\{[\s]*author_title[\s]*\}\}/gi, 'Health & Wellness Editor');
  html = html.replace(/\{\{[\s]*warning_box_text[\s]*\}\}/gi, 'The following article discusses findings that may change how you think about the products you use every day.');
  html = html.replace(/\{\{[\s]*TRENDING_CATEGORY[\s]*\}\}/gi, 'Health & Wellness');
  html = html.replace(/\{\{[^}]+\}\}/g, ''); // strip ALL remaining {{...}} placeholders

  // ── Contrast safety CSS — ensure white text on dark backgrounds ──
  // Simplified version of backend injectContrastSafetyCSS(); full version runs on backend save
  // Covers BOTH background-color: AND background: shorthand
  if (!html.includes('data-safety="contrast"')) {
    const darkPrefixes = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'a', 'b'];
    const bgProps = ['background-color', 'background'];
    const darkSels = [];
    const darkChildSels = [];
    const darkLinkSels = [];
    const lightSels = [];
    const lightChildSels = [];
    for (const prop of bgProps) {
      for (const p of darkPrefixes) {
        darkSels.push(`[style*="${prop}: #${p}"]`);
        darkChildSels.push(`[style*="${prop}: #${p}"] *`);
        darkLinkSels.push(`[style*="${prop}: #${p}"] a`);
      }
      for (let i = 0; i < 10; i++) {
        darkSels.push(`[style*="${prop}: rgb(${i}"]`);
        darkChildSels.push(`[style*="${prop}: rgb(${i}"] *`);
        darkLinkSels.push(`[style*="${prop}: rgb(${i}"] a`);
      }
      for (const p of ['#f', '#F', '#e', '#E', '#d', '#D']) {
        lightSels.push(`[style*="${prop}: ${p}"]`);
        lightChildSels.push(`[style*="${prop}: ${p}"] *`);
      }
      lightSels.push(`[style*="${prop}: white"]`, `[style*="${prop}: #fff"]`, `[style*="${prop}: rgb(255"]`);
      lightChildSels.push(`[style*="${prop}: white"] *`, `[style*="${prop}: #fff"] *`, `[style*="${prop}: rgb(255"] *`);
    }
    const contrastCSS = `<style data-safety="contrast">
  ${darkSels.join(', ')} { color: #FFFFFF !important; }
  ${darkChildSels.join(', ')} { color: #FFFFFF !important; }
  ${darkLinkSels.join(', ')} { color: #FFD700 !important; }
  ${lightSels.join(', ')} { color: inherit !important; }
  ${lightChildSels.join(', ')} { color: inherit !important; }
</style>`;
    if (html.includes('</head>')) {
      html = html.replace('</head>', contrastCSS + '\n</head>');
    } else if (html.includes('<body')) {
      html = html.replace('<body', contrastCSS + '\n<body');
    } else {
      html = contrastCSS + html;
    }
  }

  return html;
}

// Inject image number overlays into preview HTML
function injectImageOverlays(html) {
  if (!html) return html;
  const overlayScript = `<script>
    (function() {
      function addOverlays() {
        var imgs = document.querySelectorAll('img');
        imgs.forEach(function(img, i) {
          if (img.parentElement.querySelector('.lp-img-badge')) return;
          var wrap = document.createElement('div');
          wrap.style.cssText = 'position:relative;display:inline-block;';
          img.parentElement.insertBefore(wrap, img);
          wrap.appendChild(img);
          var badge = document.createElement('div');
          badge.className = 'lp-img-badge';
          badge.textContent = (i + 1);
          badge.style.cssText = 'position:absolute;top:8px;left:8px;background:rgba(0,0,0,0.7);color:#fff;font-size:11px;font-weight:600;width:22px;height:22px;border-radius:6px;display:flex;align-items:center;justify-content:center;z-index:10;font-family:system-ui,sans-serif;';
          wrap.appendChild(badge);
        });
      }
      if (document.readyState === 'complete') addOverlays();
      else window.addEventListener('load', addOverlays);
      setTimeout(addOverlays, 1000);
    })();
  </script>`;
  return html.replace('</body>', overlayScript + '</body>');
}

// ═══════════════════════════════════════════════════════════════════════════
// LP Editor — Split-panel editor (replaces LandingPageDetail)
// ═══════════════════════════════════════════════════════════════════════════
function LPEditor({ page: initialPage, onBack, onDelete, projectId }) {
  const toast = useToast();
  const [deleting, setDeleting] = useState(false);
  const [activeTab, setActiveTab] = useState('copy');
  const [mobileView, setMobileView] = useState('preview'); // 'preview' | 'editor'

  // ── Core state (mirrors server record, edited locally) ──
  const [copySections, setCopySections] = useState(() => {
    try { return initialPage.copy_sections ? JSON.parse(initialPage.copy_sections) : []; } catch { return []; }
  });
  const [imageSlots, setImageSlots] = useState(() => {
    try { return initialPage.image_slots ? JSON.parse(initialPage.image_slots) : []; } catch { return []; }
  });
  const [ctaLinks, setCtaLinks] = useState(() => {
    // Initialize from cta_links if set, otherwise extract from design analysis
    try {
      if (initialPage.cta_links) return JSON.parse(initialPage.cta_links);
      if (initialPage.swipe_design_analysis) {
        const da = JSON.parse(initialPage.swipe_design_analysis);
        return (da.cta_elements || []).map(cta => ({
          cta_id: cta.cta_id,
          text: cta.text_suggestion || 'Order Now',
          url: '#order',
          location: cta.location || '',
        }));
      }
      return [{ cta_id: 'cta_1', text: 'Order Now', url: '#order', location: 'Main CTA' }];
    } catch { return [{ cta_id: 'cta_1', text: 'Order Now', url: '#order', location: 'Main CTA' }]; }
  });
  const [slug, setSlug] = useState(() => {
    if (initialPage.slug) return initialPage.slug;
    // Auto-generate from angle in lp-XXXX-headline format
    const num = String(Math.floor(1000 + Math.random() * 9000));
    const slugified = (initialPage.angle || 'landing-page')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-{2,}/g, '-').slice(0, 60);
    return `lp-${num}-${slugified}`;
  });
  const [currentVersion, setCurrentVersion] = useState(initialPage.current_version || 1);
  const [htmlTemplate] = useState(initialPage.html_template || '');
  const [previewHtml, setPreviewHtml] = useState(initialPage.assembled_html || '');

  // ── Versions ──
  const [versions, setVersions] = useState([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [savingVersion, setSavingVersion] = useState(false);
  const [restoringVersion, setRestoringVersion] = useState(null);
  const [previewVersionHtml, setPreviewVersionHtml] = useState(null); // modal

  // ── Publishing state ──
  const [publishing, setPublishing] = useState(false);
  const [publishProgress, setPublishProgress] = useState('');
  // (showPublishModal and publishSlug removed — Shopify publish is single-click)
  const [unpublishing, setUnpublishing] = useState(false);
  const [publishedUrl, setPublishedUrl] = useState(initialPage.published_url || '');
  const [pageStatus, setPageStatus] = useState(initialPage.status);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [shopifyHandle, setShopifyHandle] = useState(initialPage.shopify_handle || '');

  // ── Visual QA state ──
  const [qaRunning, setQaRunning] = useState(false);
  const [qaResult, setQaResult] = useState(() => {
    if (initialPage.qa_report) {
      try { return JSON.parse(initialPage.qa_report); } catch { return null; }
    }
    return null;
  });
  const [qaStatus, setQaStatus] = useState(initialPage.qa_status || null);
  const [smokeResult] = useState(() => {
    if (initialPage.smoke_test_report) {
      try { return JSON.parse(initialPage.smoke_test_report); } catch { return null; }
    }
    return null;
  });

  // ── Image tab state ──
  const [regeneratingSlot, setRegeneratingSlot] = useState(null); // index
  const [uploadingSlot, setUploadingSlot] = useState(null); // index
  const [regenPrompts, setRegenPrompts] = useState({}); // { slotIndex: prompt }
  const [expandedPrompts, setExpandedPrompts] = useState({}); // { slotIndex: bool }
  const fileInputRefs = useRef({});

  // ── Debounce timers ──
  const previewTimer = useRef(null);
  const saveTimer = useRef(null);
  const initDone = useRef(false);

  // ── Initialize CTA links, slug, current_version on first load ──
  useEffect(() => {
    if (initDone.current) return;
    initDone.current = true;

    const updates = {};
    if (!initialPage.cta_links) {
      updates.cta_links = JSON.stringify(ctaLinks);
    }
    if (!initialPage.slug) {
      updates.slug = slug;
    }
    if (!initialPage.current_version) {
      updates.current_version = 1;
    }
    if (Object.keys(updates).length > 0) {
      api.updateLandingPage(projectId, initialPage.externalId, updates).catch(() => {});
    }
  }, []);

  // (Cloudflare config check removed — publishing now uses Shopify via Director config)

  // ── Load versions when Settings tab is selected ──
  useEffect(() => {
    if (activeTab === 'settings') loadVersions();
  }, [activeTab]);

  const loadVersions = async () => {
    setVersionsLoading(true);
    try {
      const data = await api.getLPVersions(projectId, initialPage.externalId);
      setVersions(data.versions || []);
    } catch { }
    setVersionsLoading(false);
  };

  // ── Rebuild preview (debounced) ──
  const rebuildPreview = useCallback(() => {
    clearTimeout(previewTimer.current);
    previewTimer.current = setTimeout(() => {
      const assembled = assembleHtmlClient(htmlTemplate, copySections, imageSlots, ctaLinks);
      setPreviewHtml(assembled);
    }, 500);
  }, [htmlTemplate, copySections, imageSlots, ctaLinks]);

  // ── Debounced save to backend ──
  const saveToBackend = useCallback(() => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      const assembled = assembleHtmlClient(htmlTemplate, copySections, imageSlots, ctaLinks);
      try {
        await api.updateLandingPage(projectId, initialPage.externalId, {
          copy_sections: JSON.stringify(copySections),
          cta_links: JSON.stringify(ctaLinks),
          slug,
          assembled_html: assembled,
        });
      } catch (err) {
        console.error('Auto-save failed:', err);
      }
    }, 1500);
  }, [htmlTemplate, copySections, imageSlots, ctaLinks, slug, projectId, initialPage.externalId]);

  // Trigger preview rebuild + save on relevant state changes
  useEffect(() => {
    rebuildPreview();
    saveToBackend();
    return () => {
      clearTimeout(previewTimer.current);
      clearTimeout(saveTimer.current);
    };
  }, [copySections, ctaLinks]);

  // ── Copy section edit ──
  const handleCopyChange = (index, newContent) => {
    setCopySections(prev => {
      const updated = [...prev];
      updated[index] = { ...updated[index], content: newContent };
      return updated;
    });
  };

  // ── CTA link edit ──
  const handleCtaChange = (index, field, value) => {
    setCtaLinks(prev => {
      const updated = [...prev];
      updated[index] = { ...updated[index], [field]: value };
      return updated;
    });
  };

  // ── Slug save ──
  const handleSlugBlur = () => {
    api.updateLandingPage(projectId, initialPage.externalId, { slug }).catch(() => {});
  };

  // ── Image regeneration ──
  const handleRegenerateImage = (slotIndex) => {
    const slot = imageSlots[slotIndex];
    const prompt = regenPrompts[slotIndex] ||
      `${slot.description || ''} for a landing page about ${initialPage.angle || 'the product'}. Location: ${slot.location || 'hero section'}`;

    setRegeneratingSlot(slotIndex);
    const { abort, done } = api.regenerateLPImage(projectId, initialPage.externalId, {
      slot_index: slotIndex,
      prompt,
      aspect_ratio: slot.aspect_ratio || '16:9',
    }, (event) => {
      if (event.type === 'completed') {
        setImageSlots(event.imageSlots || []);
        setPreviewHtml(event.assembled_html || '');
        setRegeneratingSlot(null);
        toast.success(`Image ${slotIndex + 1} regenerated`);
      } else if (event.type === 'error') {
        setRegeneratingSlot(null);
        toast.error(event.message || 'Image generation failed');
      }
    });
    done.catch(err => {
      if (err.name !== 'AbortError') {
        setRegeneratingSlot(null);
        toast.error(err.message || 'Image generation failed');
      }
    });
  };

  // ── Image upload ──
  const handleUploadImage = async (slotIndex, file) => {
    setUploadingSlot(slotIndex);
    try {
      const result = await api.uploadLPImage(projectId, initialPage.externalId, file, slotIndex);
      // Update local state
      setImageSlots(prev => {
        const updated = [...prev];
        updated[slotIndex] = result.slot;
        return updated;
      });
      if (result.assembled_html) setPreviewHtml(result.assembled_html);
      toast.success(`Image ${slotIndex + 1} uploaded`);
    } catch (err) {
      toast.error(err.message || 'Upload failed');
    }
    setUploadingSlot(null);
  };

  // ── Image revert ──
  const handleRevertImage = async (slotIndex) => {
    try {
      const result = await api.revertLPImage(projectId, initialPage.externalId, slotIndex);
      setImageSlots(prev => {
        const updated = [...prev];
        updated[slotIndex] = result.slot;
        return updated;
      });
      if (result.assembled_html) setPreviewHtml(result.assembled_html);
      toast.success(`Image ${slotIndex + 1} reverted to original`);
    } catch (err) {
      toast.error(err.message || 'Revert failed');
    }
  };

  // ── Version save ──
  const handleSaveVersion = async () => {
    setSavingVersion(true);
    try {
      const result = await api.saveLPVersion(projectId, initialPage.externalId);
      setCurrentVersion(result.version);
      toast.success(`Version ${result.version} saved`);
      loadVersions();
    } catch (err) {
      toast.error(err.message || 'Failed to save version');
    }
    setSavingVersion(false);
  };

  // ── Version restore ──
  const handleRestoreVersion = async (versionId, versionNum) => {
    if (!confirm(`This will save your current state as a new version and restore version ${versionNum}. Continue?`)) return;
    setRestoringVersion(versionId);
    try {
      const updated = await api.restoreLPVersion(projectId, initialPage.externalId, versionId);
      // Reset all local state from restored data
      setCopySections(updated.copy_sections ? JSON.parse(updated.copy_sections) : []);
      setImageSlots(updated.image_slots ? JSON.parse(updated.image_slots) : []);
      if (updated.cta_links) setCtaLinks(JSON.parse(updated.cta_links));
      if (updated.current_version) setCurrentVersion(updated.current_version);
      if (updated.assembled_html) setPreviewHtml(updated.assembled_html);
      toast.success(`Restored to version ${versionNum}`);
      loadVersions();
    } catch (err) {
      toast.error(err.message || 'Failed to restore version');
    }
    setRestoringVersion(null);
  };

  // ── Delete ──
  const handleDelete = async () => {
    if (!confirm('Delete this landing page? This cannot be undone.')) return;
    setDeleting(true);
    try {
      await api.deleteLandingPage(projectId, initialPage.externalId);
      toast.success('Landing page deleted');
      onDelete();
    } catch (err) {
      toast.error(err.message || 'Failed to delete');
    }
    setDeleting(false);
  };

  // ── Publish handler (Shopify) ──
  const handlePublish = async () => {
    setPublishing(true);
    setPublishProgress('Publishing to Shopify...');
    try {
      const result = await api.publishLandingPage(projectId, initialPage.externalId);
      setPublishProgress('');
      setPublishing(false);
      setPublishedUrl(result.published_url);
      setShopifyHandle(result.shopify_handle || '');
      setPageStatus('published');
      toast.success('Landing page published to Shopify!');
    } catch (err) {
      setPublishProgress('');
      setPublishing(false);
      toast.error(err.message || 'Publish failed');
    }
  };

  // ── Unpublish handler ──
  const handleUnpublish = async () => {
    if (!confirm('Unpublish this landing page? It will be removed from Shopify.')) return;
    setUnpublishing(true);
    try {
      await api.unpublishLandingPage(projectId, initialPage.externalId);
      setPageStatus('unpublished');
      setPublishedUrl('');
      setShopifyHandle('');
      toast.success('Landing page unpublished');
    } catch (err) {
      toast.error(err.message || 'Failed to unpublish');
    }
    setUnpublishing(false);
  };

  // ── Copy URL to clipboard ──
  const handleCopyUrl = () => {
    navigator.clipboard.writeText(publishedUrl);
    setCopiedUrl(true);
    toast.success('URL copied to clipboard');
    setTimeout(() => setCopiedUrl(false), 2000);
  };

  // ── Visual QA handler ──
  const handleRunQA = async () => {
    setQaRunning(true);
    setQaStatus('running');
    try {
      const result = await api.runLPVisualQA(projectId, initialPage.externalId);
      setQaResult({
        passed: result.passed,
        issues: result.issues,
        summary: result.summary,
        score: result.score,
      });
      setQaStatus(result.passed ? 'passed' : 'failed');
      if (result.passed) {
        toast.success(`QA passed (score: ${result.score}/100)`);
      } else {
        toast.error(`QA found ${result.issues_count} issue(s) (score: ${result.score}/100)`);
      }
    } catch (err) {
      toast.error(err.message || 'QA check failed');
      setQaStatus('failed');
    }
    setQaRunning(false);
  };

  // ── Derived values ──
  const totalWords = useMemo(() => copySections.reduce((sum, s) => sum + countWords(s.content), 0), [copySections]);
  const hasMissingCtaUrl = ctaLinks.some(c => !c.url || c.url === '#order' || c.url === '#');

  // ── Build preview HTML with image overlays ──
  const displayHtml = useMemo(() => injectImageOverlays(previewHtml), [previewHtml]);

  // Tab config
  // Parse audit data
  const auditTrail = useMemo(() => {
    try { return initialPage.audit_trail ? JSON.parse(initialPage.audit_trail) : []; }
    catch { return []; }
  }, [initialPage.audit_trail]);

  const editorialPlan = useMemo(() => {
    try { return initialPage.editorial_plan ? JSON.parse(initialPage.editorial_plan) : null; }
    catch { return null; }
  }, [initialPage.editorial_plan]);

  const TABS = [
    { id: 'copy', label: 'Copy' },
    { id: 'images', label: 'Images', count: imageSlots.length },
    { id: 'links', label: 'Links', count: ctaLinks.length },
    { id: 'details', label: 'Details', count: auditTrail.length || undefined },
    ...((qaResult || smokeResult || initialPage.gauntlet_score != null) ? [{ id: 'qa', label: 'QA Report' }] : []),
    { id: 'settings', label: 'Settings' },
  ];

  return (
    <div className="flex flex-col h-[calc(100vh-180px)]">
      {/* ── Top Bar ── */}
      <div className="flex items-center gap-3 mb-3 flex-shrink-0">
        <button onClick={onBack} className="text-textlight hover:text-textmid transition-colors">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-[14px] font-semibold text-textdark truncate max-w-[300px]">
              {initialPage.angle || initialPage.name}
            </h2>
            <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${
              pageStatus === 'published' ? 'bg-teal/15 text-teal' :
              pageStatus === 'unpublished' ? 'bg-gold/10 text-gold' :
              pageStatus === 'completed' ? 'bg-teal/10 text-teal' :
              pageStatus === 'failed' ? 'bg-red-50 text-red-600' :
              'bg-black/5 text-textmid'
            }`}>
              {pageStatus}
            </span>
            <span className="text-[10px] font-mono text-textlight bg-black/5 px-1.5 py-0.5 rounded">
              v{currentVersion}
            </span>
          </div>
          {/* Published URL display */}
          {publishedUrl && (
            <div className="flex items-center gap-1.5 mt-0.5">
              <a
                href={publishedUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] text-gold hover:text-gold/80 font-mono truncate max-w-[300px]"
              >
                {publishedUrl}
              </a>
              <button
                onClick={handleCopyUrl}
                className="text-textlight hover:text-textmid transition-colors flex-shrink-0"
                title="Copy URL"
              >
                {copiedUrl ? (
                  <svg className="w-3 h-3 text-teal" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                ) : (
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
                  </svg>
                )}
              </button>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {publishing ? (
            <span className="text-[11px] text-navy flex items-center gap-1.5">
              <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4 31.4" strokeLinecap="round" />
              </svg>
              {publishProgress || 'Publishing...'}
            </span>
          ) : (
            <button
              onClick={handlePublish}
              className={`text-[11px] px-3 py-1.5 rounded-lg font-medium transition-colors ${
                pageStatus === 'published'
                  ? 'bg-navy/10 text-navy hover:bg-navy/15'
                  : 'btn-primary'
              }`}
            >
              {pageStatus === 'published' ? 'Re-publish' : 'Publish to Shopify'}
            </button>
          )}
          <button
            onClick={handleRunQA}
            disabled={qaRunning}
            className={`text-[11px] px-3 py-1.5 rounded-lg font-medium transition-colors ${
              qaStatus === 'passed' ? 'bg-teal/10 text-teal hover:bg-teal/15' :
              qaStatus === 'failed' ? 'bg-red-50 text-red-600 hover:bg-red-100' :
              'bg-navy/10 text-navy hover:bg-navy/15'
            }`}
            title={qaResult?.summary || 'Run visual QA check'}
          >
            {qaRunning ? (
              <span className="flex items-center gap-1">
                <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4 31.4" strokeLinecap="round" />
                </svg>
                QA...
              </span>
            ) : qaStatus === 'passed' ? (
              `QA Pass (${qaResult?.score || 0})`
            ) : qaStatus === 'failed' ? (
              `QA Fail (${qaResult?.issues?.length || 0})`
            ) : (
              'Run QA'
            )}
          </button>
          <button
            onClick={() => api.downloadLandingPagePdf(projectId, initialPage.externalId)}
            className="text-[11px] px-3 py-1.5 rounded-lg font-medium bg-navy/10 text-navy hover:bg-navy/15 transition-colors"
          >
            Download PDF
          </button>
          <button
            onClick={handleDelete}
            disabled={deleting}
            className="text-[11px] text-red-400 hover:text-red-500 transition-colors disabled:opacity-50"
          >
            {deleting ? '...' : 'Delete'}
          </button>
        </div>
      </div>

      {/* ── QA Results Banner ── */}
      {qaResult && qaStatus === 'failed' && qaResult.issues?.length > 0 && (
        <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-3">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[12px] font-semibold text-red-700">
              Visual QA: {qaResult.issues.length} issue(s) found (Score: {qaResult.score}/100)
            </span>
            <button onClick={() => setQaResult(null)} className="text-red-400 hover:text-red-600 text-[10px]">Dismiss</button>
          </div>
          <p className="text-[11px] text-red-600 mb-2">{qaResult.summary}</p>
          <div className="space-y-1.5">
            {qaResult.issues.map((issue, i) => (
              <div key={i} className="flex items-start gap-2 text-[11px]">
                <span className={`px-1.5 py-0.5 rounded text-[9px] font-medium flex-shrink-0 ${
                  issue.severity === 'critical' ? 'bg-red-100 text-red-700' :
                  issue.severity === 'warning' ? 'bg-gold/10 text-gold' :
                  'bg-navy/10 text-navy'
                }`}>
                  {issue.severity}
                </span>
                <span className="text-textdark">{issue.description}</span>
                {issue.location && <span className="text-textlight ml-auto flex-shrink-0">({issue.location})</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Mobile: Preview/Editor toggle ── */}
      <div className="lg:hidden flex gap-1 p-1 bg-offwhite rounded-lg w-fit mb-3">
        <button
          onClick={() => setMobileView('preview')}
          className={`px-4 py-1.5 rounded-md text-[12px] font-medium transition-all ${
            mobileView === 'preview' ? 'bg-navy text-white shadow-sm' : 'text-textmid hover:text-textdark'
          }`}
        >
          Preview
        </button>
        <button
          onClick={() => setMobileView('editor')}
          className={`px-4 py-1.5 rounded-md text-[12px] font-medium transition-all ${
            mobileView === 'editor' ? 'bg-navy text-white shadow-sm' : 'text-textmid hover:text-textdark'
          }`}
        >
          Editor
        </button>
      </div>

      {/* ── Split Panel ── */}
      <div className="flex flex-col lg:flex-row flex-1 min-h-0 gap-0">
        {/* ── Left: Preview ── */}
        <div className={`w-full lg:w-[60%] overflow-auto border border-black/10 rounded-xl bg-white ${mobileView !== 'preview' ? 'hidden lg:block' : ''}`}>
          {displayHtml ? (
            <HtmlPreview html={displayHtml} className="border-0 rounded-none" />
          ) : (
            <div className="flex items-center justify-center h-full text-textlight text-[13px]">
              No preview available
            </div>
          )}
        </div>

        {/* ── Right: Editor Panel ── */}
        <div className={`w-full lg:w-[40%] overflow-y-auto lg:border-l border-black/5 lg:pl-4 lg:ml-2 ${mobileView !== 'editor' ? 'hidden lg:block' : ''}`}>
          {/* Tab bar */}
          <div className="flex gap-1 p-1 bg-offwhite rounded-lg w-fit mb-4 sticky top-0 z-10 bg-white/95 backdrop-blur">
            {TABS.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-3 py-1.5 rounded-md text-[11px] font-medium transition-all flex items-center gap-1 ${
                  activeTab === tab.id
                    ? 'bg-navy text-white shadow-sm'
                    : 'text-textmid hover:text-textdark'
                }`}
              >
                {tab.label}
                {tab.count > 0 && (
                  <span className={`text-[9px] px-1 rounded-full ${
                    activeTab === tab.id ? 'bg-white/20' : 'bg-black/10'
                  }`}>{tab.count}</span>
                )}
              </button>
            ))}
          </div>

          {/* ──── COPY TAB ──── */}
          {activeTab === 'copy' && (
            <div className="space-y-3">
              <div className="flex items-center justify-between mb-1">
                <p className="text-[11px] text-textmid">{copySections.length} sections · {totalWords} words</p>
              </div>
              {copySections.map((section, i) => (
                <div key={i} className="border border-black/5 rounded-xl overflow-hidden">
                  <div className="flex items-center gap-2 px-3 py-2 bg-offwhite">
                    <span className="text-[10px] font-mono text-textlight w-4">{i + 1}</span>
                    <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${getSectionColor(section.type)}`}>
                      {getSectionLabel(section.type)}
                    </span>
                    <span className="text-[10px] text-textlight ml-auto">{countWords(section.content)} words</span>
                  </div>
                  <textarea
                    value={section.content}
                    onChange={(e) => handleCopyChange(i, e.target.value)}
                    className="w-full px-3 py-2.5 text-[12px] text-textdark leading-relaxed resize-none border-0 focus:ring-0 focus:outline-none bg-white"
                    style={{ minHeight: '80px' }}
                    onInput={(e) => {
                      e.target.style.height = 'auto';
                      e.target.style.height = e.target.scrollHeight + 'px';
                    }}
                    ref={(el) => {
                      if (el) {
                        el.style.height = 'auto';
                        el.style.height = el.scrollHeight + 'px';
                      }
                    }}
                  />
                </div>
              ))}
            </div>
          )}

          {/* ──── IMAGES TAB ──── */}
          {activeTab === 'images' && (
            <div>
              {imageSlots.length === 0 ? (
                <div className="text-center py-8">
                  <p className="text-[13px] text-textmid">No image slots in this landing page.</p>
                  <p className="text-[11px] text-textlight mt-1">Provide a swipe URL to get AI-generated images.</p>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  {imageSlots.map((slot, i) => {
                    const isRegenerating = regeneratingSlot === i;
                    const isUploading = uploadingSlot === i;
                    const canRevert = slot.original_storageId && slot.storageId !== slot.original_storageId;
                    const promptExpanded = expandedPrompts[i];

                    return (
                      <div key={i} className="border border-black/5 rounded-xl overflow-hidden bg-white">
                        {/* Thumbnail */}
                        <div className="relative aspect-video bg-offwhite">
                          {slot.storageUrl ? (
                            <img src={slot.storageUrl} alt={`Slot ${i + 1}`} className="w-full h-full object-cover" />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-[11px] text-textlight">
                              {slot.description || `Image ${i + 1}`}
                            </div>
                          )}
                          {/* Slot number badge */}
                          <div className="absolute top-1.5 left-1.5 w-5 h-5 bg-black/70 text-white text-[10px] font-semibold rounded flex items-center justify-center">
                            {i + 1}
                          </div>
                          {/* Loading overlay */}
                          {(isRegenerating || isUploading) && (
                            <div className="absolute inset-0 bg-white/80 flex items-center justify-center">
                              <div className="text-center">
                                <svg className="w-5 h-5 text-navy animate-spin mx-auto" viewBox="0 0 24 24" fill="none">
                                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4 31.4" strokeLinecap="round" />
                                </svg>
                                <p className="text-[10px] text-navy mt-1">{isRegenerating ? 'Generating...' : 'Uploading...'}</p>
                              </div>
                            </div>
                          )}
                        </div>

                        {/* Info + Actions */}
                        <div className="p-2">
                          <p className="text-[10px] text-textmid truncate mb-1.5" title={slot.location}>
                            {slot.location || `Image slot ${i + 1}`}
                          </p>

                          {/* Collapsible prompt */}
                          <button
                            onClick={() => setExpandedPrompts(prev => ({ ...prev, [i]: !prev[i] }))}
                            className="text-[10px] text-navy/60 hover:text-navy mb-1.5 flex items-center gap-0.5"
                          >
                            <svg className={`w-2.5 h-2.5 transition-transform ${promptExpanded ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                            </svg>
                            Prompt
                          </button>

                          {promptExpanded && (
                            <textarea
                              value={regenPrompts[i] ?? (slot.description || '')}
                              onChange={(e) => setRegenPrompts(prev => ({ ...prev, [i]: e.target.value }))}
                              className="w-full text-[10px] p-1.5 border border-black/10 rounded-lg resize-none mb-1.5 focus:ring-1 focus:ring-navy/30 focus:outline-none"
                              rows={3}
                              placeholder="Describe the image to generate..."
                            />
                          )}

                          {/* Action buttons */}
                          <div className="flex gap-1">
                            <button
                              onClick={() => handleRegenerateImage(i)}
                              disabled={isRegenerating || isUploading}
                              className="flex-1 text-[10px] px-2 py-1 bg-navy/5 text-navy rounded-lg hover:bg-navy/10 disabled:opacity-50 transition-colors font-medium"
                            >
                              Regen
                            </button>
                            <button
                              onClick={() => fileInputRefs.current[i]?.click()}
                              disabled={isRegenerating || isUploading}
                              className="flex-1 text-[10px] px-2 py-1 bg-black/5 text-textmid rounded-lg hover:bg-black/10 disabled:opacity-50 transition-colors font-medium"
                            >
                              Upload
                            </button>
                            {canRevert && (
                              <button
                                onClick={() => handleRevertImage(i)}
                                disabled={isRegenerating || isUploading}
                                className="text-[10px] px-2 py-1 bg-gold/5 text-gold rounded-lg hover:bg-gold/10 disabled:opacity-50 transition-colors font-medium"
                              >
                                Revert
                              </button>
                            )}
                          </div>
                          <input
                            ref={(el) => { fileInputRefs.current[i] = el; }}
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (file) handleUploadImage(i, file);
                              e.target.value = '';
                            }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* ──── LINKS TAB ──── */}
          {activeTab === 'links' && (
            <div className="space-y-3">
              <p className="text-[11px] text-textmid mb-2">
                Configure CTA button text and destination URLs.
              </p>
              {ctaLinks.map((cta, i) => (
                <div key={i} className="border border-black/5 rounded-xl p-3 bg-white">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-[10px] font-mono text-textlight">CTA {i + 1}</span>
                    {cta.location && (
                      <span className="text-[10px] text-textlight bg-black/5 px-1.5 py-0.5 rounded">{cta.location}</span>
                    )}
                  </div>
                  <div className="space-y-2">
                    <div>
                      <label className="text-[10px] text-textmid font-medium block mb-0.5">Button Text</label>
                      <input
                        type="text"
                        value={cta.text || ''}
                        onChange={(e) => handleCtaChange(i, 'text', e.target.value)}
                        className="input-apple text-[12px] py-1.5"
                        placeholder="Order Now"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-textmid font-medium block mb-0.5">URL</label>
                      <input
                        type="text"
                        value={cta.url || ''}
                        onChange={(e) => handleCtaChange(i, 'url', e.target.value)}
                        className={`input-apple text-[12px] py-1.5 ${
                          !cta.url || cta.url === '#order' || cta.url === '#' ? 'border-gold/30 bg-gold/5' : ''
                        }`}
                        placeholder="https://example.com/checkout"
                      />
                    </div>
                  </div>
                </div>
              ))}
              <div className="p-3 bg-navy/5 border border-navy/10 rounded-xl mt-4">
                <p className="text-[10px] text-navy/70">
                  CTA links are embedded in the published HTML. Set the URL to your checkout or order page before publishing.
                </p>
              </div>
            </div>
          )}

          {/* ──── DETAILS TAB ──── */}
          {activeTab === 'details' && (
            <div className="space-y-5">
              {/* Generation Duration + Meta */}
              {(initialPage.generation_duration_ms || initialPage.gauntlet_score != null) && (
                <div className="flex items-center gap-3 flex-wrap">
                  {initialPage.generation_duration_ms && (
                    <div className="flex items-center gap-1.5 px-3 py-1.5 bg-navy/5 rounded-lg">
                      <svg className="w-3.5 h-3.5 text-navy/50" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                      <span className="text-[11px] font-medium text-textdark">
                        {initialPage.generation_duration_ms >= 60000
                          ? `${Math.floor(initialPage.generation_duration_ms / 60000)}m ${Math.round((initialPage.generation_duration_ms % 60000) / 1000)}s`
                          : `${Math.round(initialPage.generation_duration_ms / 1000)}s`}
                      </span>
                      <span className="text-[10px] text-textlight">generation time</span>
                    </div>
                  )}
                  {initialPage.gauntlet_score != null && (
                    <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg ${initialPage.gauntlet_score >= 6 ? 'bg-teal/5' : 'bg-gold/5'}`}>
                      <span className={`text-[11px] font-medium ${initialPage.gauntlet_score >= 6 ? 'text-teal' : 'text-gold'}`}>
                        {initialPage.gauntlet_score}/10
                      </span>
                      <span className="text-[10px] text-textlight">gauntlet score</span>
                    </div>
                  )}
                  {initialPage.narrative_frame && (
                    <div className="flex items-center gap-1.5 px-3 py-1.5 bg-[#7C6DCD]/5 rounded-lg">
                      <span className="text-[10px] text-[#7C6DCD] font-medium">{initialPage.narrative_frame}</span>
                    </div>
                  )}
                </div>
              )}

              {/* Editorial Plan Summary */}
              {editorialPlan && (
                <div className="p-3 bg-[#7C6DCD]/5 border border-[#7C6DCD]/15 rounded-xl">
                  <p className="text-[11px] font-semibold text-[#7C6DCD] mb-2">Editorial Plan (Opus)</p>
                  {editorialPlan.headline && (
                    <p className="text-[12px] font-medium text-textdark mb-1">{editorialPlan.headline}</p>
                  )}
                  {editorialPlan.editorial_notes && (
                    <p className="text-[11px] text-textmid mb-2">{editorialPlan.editorial_notes}</p>
                  )}
                  {editorialPlan.decisions?.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-[#7C6DCD]/10">
                      <p className="text-[10px] font-medium text-[#7C6DCD]/80 mb-1">Decisions</p>
                      <ul className="space-y-0.5">
                        {editorialPlan.decisions.map((d, i) => (
                          <li key={i} className="text-[10px] text-textmid flex gap-1.5">
                            <span className="text-[#7C6DCD]/60 flex-shrink-0">&bull;</span>
                            <span>{d}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {/* Audit Trail Timeline */}
              {auditTrail.length > 0 ? (
                <div>
                  <p className="text-[11px] font-medium text-textdark mb-2">Audit Trail</p>
                  <div className="relative pl-4 border-l-2 border-navy/10 space-y-3">
                    {auditTrail.map((entry, i) => {
                      const stepLabels = {
                        init: 'Initialization', template: 'Template', project: 'Project Data',
                        copy: 'Copy Generation', editorial: 'Editorial Pass', images: 'Image Generation',
                        html: 'HTML Generation', assembly: 'Assembly', postprocess: 'Post-Processing',
                        qa: 'Visual QA', autofix: 'Auto-Fix', complete: 'Complete',
                        design: 'Design Analysis',
                      };
                      const stepColors = {
                        init: 'bg-navy/10 text-navy', template: 'bg-navy/10 text-navy',
                        project: 'bg-navy/10 text-navy', copy: 'bg-gold/10 text-gold',
                        editorial: 'bg-[#7C6DCD]/10 text-[#7C6DCD]', images: 'bg-teal/10 text-teal',
                        html: 'bg-navy/10 text-navy', assembly: 'bg-navy/10 text-navy',
                        postprocess: 'bg-gold/10 text-gold', qa: 'bg-teal/10 text-teal',
                        autofix: 'bg-red-50 text-red-600', complete: 'bg-teal/10 text-teal',
                        design: 'bg-gold/10 text-gold',
                      };
                      const label = stepLabels[entry.step] || entry.step;
                      const color = stepColors[entry.step] || 'bg-black/5 text-textmid';
                      const dotColor = entry.step === 'complete' ? 'bg-teal' :
                        entry.action === 'failed' ? 'bg-red-500' :
                        entry.step === 'editorial' ? 'bg-[#7C6DCD]' : 'bg-navy/40';

                      return (
                        <div key={i} className="relative">
                          <div className={`absolute -left-[21px] top-1 w-2.5 h-2.5 rounded-full ${dotColor}`} />
                          <div className="flex items-start gap-2">
                            <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded-full flex-shrink-0 ${color}`}>
                              {label}
                            </span>
                            <span className="text-[10px] text-textlight font-mono flex-shrink-0">
                              {new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                            </span>
                          </div>
                          <p className="text-[10px] text-textmid mt-0.5">{entry.detail}</p>
                          {/* Editorial decisions sub-list */}
                          {entry.decisions?.length > 0 && (
                            <ul className="mt-1 space-y-0.5 ml-2">
                              {entry.decisions.map((d, j) => (
                                <li key={j} className="text-[10px] text-[#7C6DCD]/80 flex gap-1">
                                  <span className="flex-shrink-0">&#8227;</span>
                                  <span>{d}</span>
                                </li>
                              ))}
                            </ul>
                          )}
                          {/* QA issues sub-list */}
                          {entry.issues?.length > 0 && (
                            <ul className="mt-1 space-y-0.5 ml-2">
                              {entry.issues.map((issue, j) => (
                                <li key={j} className="text-[10px] text-red-500 flex gap-1">
                                  <span className="flex-shrink-0">!</span>
                                  <span>{issue}</span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="p-4 bg-offwhite rounded-xl border border-black/5 text-center">
                  <p className="text-[11px] text-textlight">No audit trail available for this page.</p>
                  <p className="text-[10px] text-textlight/60 mt-1">Audit trails are recorded for pages generated after this feature was added.</p>
                </div>
              )}

              {/* Generation Metadata */}
              <div className="p-3 bg-offwhite rounded-xl border border-black/5">
                <p className="text-[11px] font-medium text-textmid mb-2">Generation Metadata</p>
                <div className="grid grid-cols-2 gap-2 text-[10px]">
                  {initialPage.narrative_frame && (
                    <div>
                      <span className="text-textlight">Narrative Frame</span>
                      <p className="text-textmid font-medium">{initialPage.narrative_frame}</p>
                    </div>
                  )}
                  {initialPage.auto_generated && (
                    <div>
                      <span className="text-textlight">Source</span>
                      <p className="text-teal font-medium">Auto-generated</p>
                    </div>
                  )}
                  {initialPage.generation_attempts > 0 && (
                    <div>
                      <span className="text-textlight">Generation Attempts</span>
                      <p className="text-textmid font-medium">{initialPage.generation_attempts}</p>
                    </div>
                  )}
                  {initialPage.fix_attempts > 0 && (
                    <div>
                      <span className="text-textlight">Fix Attempts</span>
                      <p className="text-textmid font-medium">{initialPage.fix_attempts}</p>
                    </div>
                  )}
                  {initialPage.qa_status && (
                    <div>
                      <span className="text-textlight">QA Status</span>
                      <p className={`font-medium ${initialPage.qa_status === 'passed' ? 'text-teal' : 'text-red-600'}`}>
                        {initialPage.qa_status}{initialPage.qa_score != null ? ` (${initialPage.qa_score}/100)` : ''}
                      </p>
                    </div>
                  )}
                  {initialPage.template_id && (
                    <div>
                      <span className="text-textlight">Template</span>
                      <p className="text-textmid font-medium font-mono text-[9px]">{initialPage.template_id.slice(0, 8)}...</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ──── QA REPORT TAB ──── */}
          {activeTab === 'qa' && (
            <div className="space-y-5">
              {/* QA Score Header */}
              {qaResult && (
                <div className={`p-4 rounded-xl border ${qaResult.passed ? 'bg-teal/5 border-teal/20' : 'bg-red-50 border-red-200'}`}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className={`text-[20px] font-bold ${qaResult.passed ? 'text-teal' : 'text-red-600'}`}>
                        {qaResult.score ?? initialPage.qa_score ?? '—'}/100
                      </span>
                      <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${
                        qaResult.passed ? 'bg-teal/10 text-teal' : 'bg-red-100 text-red-600'
                      }`}>
                        {qaResult.passed ? 'PASSED' : 'FAILED'}
                      </span>
                    </div>
                    {initialPage.qa_issues_count != null && (
                      <span className="text-[10px] text-textlight">
                        {initialPage.qa_issues_count} issue{initialPage.qa_issues_count !== 1 ? 's' : ''} found
                      </span>
                    )}
                  </div>
                  {qaResult.summary && (
                    <p className="text-[11px] text-textmid leading-relaxed">{qaResult.summary}</p>
                  )}
                </div>
              )}

              {/* Category Score Breakdown (gauntlet-scored LPs) */}
              {qaResult?.categories && (
                <div className="p-3 bg-offwhite rounded-xl border border-black/5">
                  <p className="text-[11px] font-medium text-textmid mb-3">Score Breakdown</p>
                  <div className="space-y-2.5">
                    {Object.entries(qaResult.categories).map(([key, cat]) => {
                      const pct = cat.max > 0 ? (cat.score / cat.max) * 100 : 0;
                      const color = pct >= 100 ? 'bg-teal' : pct >= 50 ? 'bg-gold' : 'bg-red-400';
                      const textColor = pct >= 100 ? 'text-teal' : pct >= 50 ? 'text-gold' : 'text-red-500';
                      return (
                        <div key={key}>
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-[11px] font-medium text-textdark">{cat.label}</span>
                            <span className={`text-[11px] font-bold ${textColor}`}>{cat.score}/{cat.max}</span>
                          </div>
                          <div className="h-1.5 bg-black/5 rounded-full overflow-hidden">
                            <div className={`h-full rounded-full transition-all ${color}`} style={{ width: `${pct}%` }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Issues Breakdown */}
              {qaResult?.issues?.length > 0 && (
                <div className="p-3 bg-offwhite rounded-xl border border-black/5">
                  <p className="text-[11px] font-medium text-textmid mb-2">Issues ({qaResult.issues.length})</p>
                  <div className="space-y-2">
                    {qaResult.issues.map((issue, i) => (
                      <div key={i} className="flex gap-2 text-[10px]">
                        <span className={`flex-shrink-0 font-medium px-1.5 py-0.5 rounded ${
                          issue.severity === 'critical' ? 'bg-red-100 text-red-700' :
                          issue.severity === 'warning' ? 'bg-gold/10 text-gold' :
                          'bg-black/5 text-textmid'
                        }`}>
                          {issue.severity}
                        </span>
                        <div>
                          <p className="text-textdark">{issue.description}</p>
                          {issue.location && (
                            <p className="text-textlight mt-0.5">{issue.location}</p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* QA Screenshot */}
              {initialPage.qa_screenshot_url && (
                <div className="p-3 bg-offwhite rounded-xl border border-black/5">
                  <p className="text-[11px] font-medium text-textmid mb-2">QA Screenshot</p>
                  <img
                    src={initialPage.qa_screenshot_url}
                    alt="QA screenshot"
                    className="w-full rounded-lg border border-black/10"
                  />
                </div>
              )}

              {/* Smoke Test Results */}
              {smokeResult && (
                <div className="p-3 bg-offwhite rounded-xl border border-black/5">
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-[11px] font-medium text-textmid">Smoke Test</p>
                    <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${
                      smokeResult.passed ? 'bg-teal/10 text-teal' : 'bg-red-100 text-red-600'
                    }`}>
                      {smokeResult.passed ? 'ALL PASSED' : `${smokeResult.failedCount} FAILED`}
                    </span>
                  </div>
                  <div className="space-y-1.5">
                    {smokeResult.checks?.map((check, i) => (
                      <div key={i} className="flex items-start gap-2 text-[10px]">
                        <span className={`flex-shrink-0 mt-0.5 ${check.passed ? 'text-teal' : 'text-red-500'}`}>
                          {check.passed ? '\u2713' : '\u2717'}
                        </span>
                        <div>
                          <span className="font-medium text-textdark">{check.name}</span>
                          {check.detail && (
                            <p className="text-textlight mt-0.5">{check.detail}</p>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Gauntlet Score Fallback (for existing LPs without qa_report) */}
              {!qaResult && initialPage.gauntlet_score != null && (
                <div className={`p-4 rounded-xl border ${initialPage.gauntlet_score >= 6 ? 'bg-teal/5 border-teal/20' : 'bg-gold/5 border-gold/20'}`}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className={`text-[20px] font-bold ${initialPage.gauntlet_score >= 6 ? 'text-teal' : 'text-gold'}`}>
                        {initialPage.gauntlet_score}/10
                      </span>
                      <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${
                        initialPage.gauntlet_score >= 6 ? 'bg-teal/10 text-teal' : 'bg-gold/10 text-gold'
                      }`}>
                        GAUNTLET SCORE
                      </span>
                    </div>
                  </div>
                  {initialPage.gauntlet_score_reasoning && (
                    <p className="text-[11px] text-textmid leading-relaxed">{initialPage.gauntlet_score_reasoning}</p>
                  )}
                </div>
              )}

              {/* No data fallback */}
              {!qaResult && !smokeResult && initialPage.gauntlet_score == null && (
                <div className="p-4 bg-offwhite rounded-xl border border-black/5 text-center">
                  <p className="text-[11px] text-textlight">No QA data available for this page.</p>
                </div>
              )}
            </div>
          )}

          {/* ──── SETTINGS TAB ──── */}
          {activeTab === 'settings' && (
            <div className="space-y-5">
              {/* Slug */}
              <div>
                <label className="text-[12px] font-medium text-textdark block mb-1.5">URL Slug</label>
                <input
                  type="text"
                  value={slug}
                  onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                  onBlur={handleSlugBlur}
                  className="input-apple text-[12px]"
                  placeholder="landing-page-slug"
                />
                <p className="text-[10px] text-textlight mt-1 font-mono bg-offwhite px-2 py-1 rounded">
                  offers.yourdomain.com/<span className="text-navy">{slug || '...'}</span>
                </p>
              </div>

              {/* Version History */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-[12px] font-medium text-textdark">Version History</label>
                  <button
                    onClick={handleSaveVersion}
                    disabled={savingVersion}
                    className="text-[11px] px-3 py-1 bg-navy/5 text-navy rounded-lg hover:bg-navy/10 disabled:opacity-50 transition-colors font-medium"
                  >
                    {savingVersion ? 'Saving...' : 'Save Version'}
                  </button>
                </div>

                {versionsLoading ? (
                  <div className="space-y-2">
                    {[0, 1].map(i => (
                      <div key={i} className="h-10 bg-offwhite rounded-lg animate-pulse" />
                    ))}
                  </div>
                ) : versions.length === 0 ? (
                  <p className="text-[11px] text-textlight py-2">No saved versions yet. Click "Save Version" to create a snapshot.</p>
                ) : (
                  <div className="space-y-1.5 max-h-[300px] overflow-y-auto">
                    {versions.map((v) => (
                      <div key={v.externalId} className="flex items-center gap-2 p-2 bg-offwhite rounded-lg">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[11px] font-medium text-textdark">v{v.version}</span>
                            <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${
                              v.source === 'generated' ? 'bg-teal/10 text-teal' :
                              v.source === 'auto-save' ? 'bg-gold/10 text-gold' :
                              'bg-black/5 text-textmid'
                            }`}>{v.source}</span>
                          </div>
                          <p className="text-[10px] text-textlight">
                            {new Date(v.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                          </p>
                        </div>
                        <button
                          onClick={() => setPreviewVersionHtml(v.assembled_html || v.copy_sections)}
                          className="text-[10px] text-navy hover:text-navy/80 font-medium"
                        >
                          Preview
                        </button>
                        <button
                          onClick={() => handleRestoreVersion(v.externalId, v.version)}
                          disabled={restoringVersion === v.externalId}
                          className="text-[10px] text-gold hover:text-gold/80 font-medium disabled:opacity-50"
                        >
                          {restoringVersion === v.externalId ? '...' : 'Restore'}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Publishing Controls */}
              {pageStatus === 'published' && publishedUrl && (
                <div className="p-3 bg-teal/5 border border-teal/15 rounded-xl">
                  <p className="text-[11px] font-medium text-teal mb-1.5">Published</p>
                  <a
                    href={publishedUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[11px] text-gold hover:text-gold/80 font-mono break-all"
                  >
                    {publishedUrl}
                  </a>
                  <div className="mt-2">
                    <button
                      onClick={handleUnpublish}
                      disabled={unpublishing}
                      className="text-[11px] px-3 py-1 bg-red-50 text-red-600 rounded-lg hover:bg-red-100 transition-colors disabled:opacity-50 font-medium"
                    >
                      {unpublishing ? 'Unpublishing...' : 'Unpublish'}
                    </button>
                  </div>
                </div>
              )}

              {/* Generation Details */}
              <div className="p-3 bg-offwhite rounded-xl border border-black/5">
                <p className="text-[11px] font-medium text-textmid mb-1.5">Generation Details</p>
                <div className="space-y-1 text-[11px] text-textlight">
                  {initialPage.swipe_url && (
                    <p>Swipe URL: <a href={initialPage.swipe_url} target="_blank" rel="noopener noreferrer" className="text-gold hover:text-gold/80">{initialPage.swipe_url}</a></p>
                  )}
                  {initialPage.word_count > 0 && (
                    <p>Target: <span className="text-textmid">{initialPage.word_count} words</span> · Actual: <span className="text-textmid">{totalWords} words</span></p>
                  )}
                  {initialPage.additional_direction && (
                    <p>Direction: <span className="text-textmid">{initialPage.additional_direction}</span></p>
                  )}
                  <p>Created: <span className="text-textmid">{new Date(initialPage.created_at).toLocaleString()}</span></p>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Version Preview Modal ── */}
      {previewVersionHtml && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setPreviewVersionHtml(null)}>
          <div className="bg-white rounded-2xl shadow-xl w-[80vw] h-[80vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-black/5">
              <span className="text-[13px] font-medium text-textdark">Version Preview</span>
              <button onClick={() => setPreviewVersionHtml(null)} className="text-textlight hover:text-textmid">
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="flex-1 overflow-auto">
              <HtmlPreview html={previewVersionHtml} className="border-0 rounded-none" />
            </div>
          </div>
        </div>
      )}

      {/* Publish modal removed — Shopify publish is a single-click action */}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Multi-phase progress display during generation
// ═══════════════════════════════════════════════════════════════════════════
function GenerationProgress({ phases, currentPhase, progress, imageProgress }) {
  return (
    <div className="space-y-3 text-left w-full max-w-md mx-auto">
      {phases.map((phase) => {
        const config = PHASE_LABELS[phase] || { label: phase, icon: '⏳', description: '' };
        const isCurrent = phase === currentPhase;
        const isDone = phases.indexOf(phase) < phases.indexOf(currentPhase);

        return (
          <div
            key={phase}
            className={`flex items-center gap-3 p-2.5 rounded-lg transition-all ${
              isCurrent ? 'bg-navy/5 border border-navy/10' : isDone ? 'opacity-60' : 'opacity-30'
            }`}
          >
            <div className={`w-7 h-7 rounded-full flex items-center justify-center text-[14px] flex-shrink-0 ${
              isDone ? 'bg-teal/10' : isCurrent ? 'bg-navy/10' : 'bg-black/5'
            }`}>
              {isDone ? (
                <svg className="w-4 h-4 text-teal" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
              ) : isCurrent ? (
                <svg className="w-4 h-4 text-navy animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4 31.4" strokeLinecap="round" />
                </svg>
              ) : (
                <span className="text-[12px]">{config.icon}</span>
              )}
            </div>
            <div className="flex-1 min-w-0">
              <p className={`text-[12px] font-medium ${isCurrent ? 'text-navy' : isDone ? 'text-teal' : 'text-textlight'}`}>
                {config.label}
              </p>
              {isCurrent && progress && (
                <p className="text-[11px] text-textmid truncate">{progress}</p>
              )}
              {isCurrent && phase === 'image_generation' && imageProgress && (
                <div className="mt-1.5">
                  <div className="flex items-center gap-2">
                    <div className="flex-1 h-1.5 bg-black/5 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-teal rounded-full transition-all duration-500"
                        style={{ width: `${(imageProgress.current / imageProgress.total) * 100}%` }}
                      />
                    </div>
                    <span className="text-[10px] text-textlight flex-shrink-0">
                      {imageProgress.current}/{imageProgress.total}
                    </span>
                  </div>
                  {imageProgress.error && (
                    <p className="text-[10px] text-red-500 mt-1 flex items-center gap-1">
                      <svg className="w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126z" />
                      </svg>
                      {imageProgress.error}
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Status badge for list view
// ═══════════════════════════════════════════════════════════════════════════
const STATUS_CONFIG = {
  draft: { label: 'Draft', bg: 'bg-black/5', text: 'text-textmid' },
  generating: { label: 'Generating...', bg: 'bg-navy/10', text: 'text-navy' },
  completed: { label: 'Completed', bg: 'bg-teal/10', text: 'text-teal' },
  failed: { label: 'Failed', bg: 'bg-red-50', text: 'text-red-600' },
  published: { label: 'Published', bg: 'bg-teal/15', text: 'text-teal' },
  unpublished: { label: 'Unpublished', bg: 'bg-gold/10', text: 'text-gold' },
};

// ─── Narrative frame display labels ──────────────────────────────────────────
const FRAME_LABELS = {
  testimonial: 'Testimonial Journey',
  mechanism: 'Mechanism Deep-Dive',
  problem_agitation: 'Problem Agitation',
  myth_busting: 'Myth Busting',
  listicle: 'Listicle',
};

// ═══════════════════════════════════════════════════════════════════════════
// Main LPGen Component
// ═══════════════════════════════════════════════════════════════════════════
import LPTemplateManager from './LPTemplateManager';

export default function LPGen({ projectId, project }) {
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [view, setView] = useState('list'); // list | configure | editor | generating
  const [subTab, setSubTab] = useState('pages'); // pages | templates
  const [pages, setPages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedPage, setSelectedPage] = useState(null);
  const [expandedBatches, setExpandedBatches] = useState({});
  const deepLinkHandled = useRef(false);

  // Gauntlet (batch generation) progress from server polling
  const [gauntletProgress, setGauntletProgress] = useState(null); // { step, message, percent, startedAt }
  const hasGeneratingBatch = useMemo(
    () => pages.some(p => p.status === 'generating' && p.gauntlet_batch_id),
    [pages]
  );
  usePolling(
    async () => {
      try {
        const progress = await api.getGauntletProgress(projectId);
        if (progress) {
          setGauntletProgress({ step: progress.step, message: progress.message, percent: progress.percent, startedAt: progress.startedAt });
        } else {
          // Generation finished — clear progress and reload pages
          if (gauntletProgress) {
            setGauntletProgress(null);
            loadPages();
          }
        }
      } catch { /* ignore */ }
    },
    3000,
    hasGeneratingBatch
  );

  // Docs readiness
  const [docsReady, setDocsReady] = useState(null); // null = loading, object = result

  // Configure form
  const [angle, setAngle] = useState('');
  const [wordCount, setWordCount] = useState(1200);
  const [additionalDirection, setAdditionalDirection] = useState('');
  const [swipeUrl, setSwipeUrl] = useState('');
  const [swipePdf, setSwipePdf] = useState(null); // { file, name }

  // Generation state
  const [generating, setGenerating] = useState(false);
  const [genProgress, setGenProgress] = useState('');
  const [genResult, setGenResult] = useState(null);
  const [genError, setGenError] = useState('');
  const [genPhases, setGenPhases] = useState([]); // ordered list of phases for this generation
  const [currentPhase, setCurrentPhase] = useState('');
  const [imageProgress, setImageProgress] = useState(null); // { current, total, slotId }
  const [genStartTime, setGenStartTime] = useState(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [genPercent, setGenPercent] = useState(0);
  const abortRef = useRef(null);

  // Step-weighted progress map (matches LP Agent pattern)
  const LP_STEP_PROGRESS = {
    'fetch': 2, 'screenshot': 5,
    'design_analyzing': 8, 'design_complete': 15,
    'loading_docs': 18, 'generating': 20, 'calling_api': 22, 'parsing': 35, 'copy_complete': 40,
    'editorial_starting': 42, 'editorial_complete': 55, 'editorial_skipped': 55, 'editorial_failed': 55,
    'images_starting': 58, 'image_generating': 62, 'images_complete': 80, 'images_skipped': 80,
    'html_generating': 82, 'html_complete': 92,
    'qa_running': 94, 'qa_complete': 97,
    'assembling': 98,
  };
  const LP_PHASE_PROGRESS = {
    'fetch': 2, 'design_analysis': 8, 'copy_generation': 18,
    'editorial': 42, 'image_generation': 58, 'html_generation': 82, 'assembling': 98,
  };

  // Elapsed timer during generation
  useEffect(() => {
    if (!generating || !genStartTime) return;
    const interval = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - genStartTime) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [generating, genStartTime]);

  // Load pages + check docs on mount
  useEffect(() => {
    loadPages();
    checkDocs();
  }, [projectId]);

  // Deep-link: auto-open a specific LP from ?lp=externalId
  useEffect(() => {
    if (deepLinkHandled.current || loading || pages.length === 0) return;
    const lpId = searchParams.get('lp');
    if (!lpId) return;
    const target = pages.find(p => p.externalId === lpId);
    if (target) {
      setSelectedPage(target);
      setView('editor');
      deepLinkHandled.current = true;
      // Clean the lp param from URL so back/refresh goes to list
      setSearchParams(prev => {
        const next = new URLSearchParams(prev);
        next.delete('lp');
        return next;
      }, { replace: true });
    }
  }, [pages, loading, searchParams]);

  const loadPages = async () => {
    try {
      const data = await api.getLandingPages(projectId);
      setPages(data.pages || []);
    } catch (err) {
      console.error('Failed to load landing pages:', err);
    } finally {
      setLoading(false);
    }
  };

  const checkDocs = async () => {
    try {
      const result = await api.checkLandingPageDocs(projectId);
      setDocsReady(result);
    } catch {
      setDocsReady({ ready: false, missing: ['unknown'] });
    }
  };

  const handleStartGenerate = useCallback((options = {}) => {
    const { skipSwipe = false } = options;

    if (!angle.trim()) {
      toast.error('Please enter an angle / hook for the landing page');
      return;
    }

    setGenerating(true);
    setGenStartTime(Date.now());
    setElapsedSeconds(0);
    setGenProgress('Starting...');
    setGenPercent(0);
    setGenError('');
    setGenResult(null);
    setGenPhases([]);
    setCurrentPhase('');
    setImageProgress(null);
    setView('generating');

    const body = {
      angle: angle.trim(),
      word_count: wordCount,
    };
    if (additionalDirection.trim()) {
      body.additional_direction = additionalDirection.trim();
    }
    if (!skipSwipe && swipeUrl.trim()) {
      body.swipe_url = swipeUrl.trim();
    }

    // If PDF swipe file provided (and no URL), read as base64 and include
    const startGeneration = async () => {
      if (!skipSwipe && swipePdf && !swipeUrl.trim()) {
        try {
          const base64 = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('Failed to read PDF'));
            reader.readAsDataURL(swipePdf.file);
          });
          body.swipe_pdf_base64 = base64;
          body.swipe_pdf_filename = swipePdf.name;
        } catch (err) {
          setGenError('Failed to read PDF file');
          setGenerating(false);
          return;
        }
      }

      const { abort, done } = api.generateLandingPage(projectId, body, (event) => {
        if (event.type === 'phase') {
          setCurrentPhase(event.phase);
          setGenPhases(prev => {
            if (!prev.includes(event.phase)) return [...prev, event.phase];
            return prev;
          });
          setGenProgress(event.message || '');
          if (LP_PHASE_PROGRESS[event.phase] !== undefined) {
            setGenPercent(prev => Math.max(prev, LP_PHASE_PROGRESS[event.phase]));
          }
        } else if (event.type === 'progress') {
          setGenProgress(event.message || event.step || 'Processing...');
          if (event.step && LP_STEP_PROGRESS[event.step] !== undefined) {
            setGenPercent(prev => Math.max(prev, LP_STEP_PROGRESS[event.step]));
          }
          if (event.imageProgress) {
            setImageProgress(event.imageProgress);
            // Image sub-step progress: 58-80% range
            const { current, total, done: imgDone } = event.imageProgress;
            if (total > 0) {
              const imgPct = imgDone
                ? 58 + Math.round((current / total) * 22)
                : 58 + Math.round(((current - 1) / total) * 22) + Math.round((1 / total) * 11);
              setGenPercent(prev => Math.max(prev, imgPct));
            }
          }
        } else if (event.type === 'started') {
          setGenProgress('Generation started...');
          setGenPercent(1);
          if (event.hasSwipeUrl || event.hasSwipePdf) {
            setGenPhases(['fetch', 'design_analysis', 'copy_generation', 'image_generation', 'html_generation', 'assembling']);
          } else {
            setGenPhases(['copy_generation', 'html_generation', 'assembling']);
          }
        } else if (event.type === 'completed') {
          setGenPercent(100);
          setGenResult(event);
          setGenProgress('');
          setGenerating(false);
          setCurrentPhase('done');
          loadPages();
        } else if (event.type === 'error') {
          setGenError(event.message || 'Generation failed');
          setGenProgress('');
          setGenerating(false);
        }
      });

      abortRef.current = abort;

      done.catch((err) => {
        if (err.name !== 'AbortError') {
          setGenError(err.message || 'Generation failed');
          setGenerating(false);
          setGenProgress('');
        }
      });
    };

    startGeneration();
  }, [projectId, angle, wordCount, additionalDirection, swipeUrl, swipePdf]);

  const handleCancelGenerate = () => {
    if (abortRef.current) {
      abortRef.current();
      abortRef.current = null;
    }
    setGenerating(false);
    setGenProgress('');
    setView('configure');
  };




  const handleViewPage = (page) => {
    setSelectedPage(page);
    setView('editor');
  };

  const handleDeleteFromDetail = () => {
    setView('list');
    setSelectedPage(null);
    loadPages();
  };

  const handleDuplicate = async (page) => {
    try {
      const newPage = await api.duplicateLandingPage(projectId, page.externalId);
      toast.success(`Duplicated: "${newPage.name}"`);
      loadPages();
    } catch (err) {
      toast.error(err.message || 'Failed to duplicate');
    }
  };

  const resetForm = () => {
    setAngle('');
    setWordCount(1200);
    setAdditionalDirection('');
    setSwipeUrl('');
    setSwipePdf(null);
    setGenResult(null);
    setGenError('');
    setGenProgress('');
    setGenPhases([]);
    setCurrentPhase('');
    setImageProgress(null);
  };

  // ── Editor view ──
  if (view === 'editor' && selectedPage) {
    return (
      <LPEditor
        page={selectedPage}
        onBack={() => { setView('list'); setSelectedPage(null); loadPages(); }}
        onDelete={handleDeleteFromDetail}
        projectId={projectId}
      />
    );
  }

  // ── Generating view (SSE progress with multi-phase tracking) ──
  if (view === 'generating') {
    return (
      <div>
        <div className="flex items-center gap-3 mb-5">
          <h2 className="text-[15px] font-semibold text-textdark tracking-tight">Generating Landing Page</h2>
        </div>

        <div className="card p-8">
          {generating ? (
            <div className="text-center">
              <p className="text-[14px] font-medium text-textdark mb-3">Building your landing page...</p>

              {/* Overall progress bar */}
              <PipelineProgress
                progress={genPercent}
                message={genProgress}
                startTime={genStartTime}
                className="mb-4 max-w-md mx-auto"
              />

              {/* Multi-phase progress */}
              {genPhases.length > 0 && (
                <GenerationProgress
                  phases={genPhases}
                  currentPhase={currentPhase}
                  progress={genProgress}
                  imageProgress={imageProgress}
                />
              )}

              {/* Fallback progress text if no phases yet */}
              {genPhases.length === 0 && genProgress && (
                <p className="text-[12px] text-textmid">{genProgress}</p>
              )}

              <button
                onClick={handleCancelGenerate}
                className="btn-secondary text-[12px] mt-6"
              >
                Cancel
              </button>
            </div>
          ) : genError ? (
            <div className="text-center">
              <div className="w-10 h-10 mx-auto mb-4 rounded-full bg-red-50 flex items-center justify-center">
                <svg className="w-5 h-5 text-red-500" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                </svg>
              </div>
              <p className="text-[14px] font-medium text-red-600 mb-1">Generation Failed</p>
              <p className="text-[12px] text-red-500 mb-4">{genError}</p>
              <div className="flex items-center justify-center gap-2">
                <button
                  onClick={() => { setView('configure'); setGenError(''); }}
                  className="btn-secondary text-[12px]"
                >
                  Back to Configure
                </button>
                {(genError.includes('fetch') || genError.toLowerCase().includes('design analysis') || genError.toLowerCase().includes('swipe page')) && swipeUrl && (
                  <button
                    onClick={() => {
                      setSwipeUrl('');
                      setGenError('');
                      handleStartGenerate({ skipSwipe: true });
                    }}
                    className="btn-secondary text-[12px]"
                  >
                    Retry Without Swipe
                  </button>
                )}
                <button
                  onClick={() => { setGenError(''); setGenerating(false); handleStartGenerate(); }}
                  className="btn-primary text-[12px]"
                >
                  Retry
                </button>
              </div>
            </div>
          ) : genResult ? (
            <div className="text-center">
              <div className="w-10 h-10 mx-auto mb-4 rounded-full bg-teal/10 flex items-center justify-center">
                <svg className="w-5 h-5 text-teal" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
              </div>
              <p className="text-[14px] font-medium text-teal mb-1">Landing Page Generated!</p>
              <p className="text-[12px] text-textmid mb-1">
                {genResult.sections?.length || 0} sections
                {genResult.imageCount > 0 && ` · ${genResult.imageCount} images`}
                {genResult.hasHtml && ' · HTML preview ready'}
              </p>
              {genResult.hasDesignAnalysis && (
                <p className="text-[10px] text-navy/60 mb-4">Design extracted from swipe page</p>
              )}
              <div className="flex items-center justify-center gap-2 mt-3">
                <button
                  onClick={async () => {
                    try {
                      const data = await api.getLandingPages(projectId);
                      setPages(data.pages || []);
                      const page = (data.pages || []).find(p => p.externalId === genResult.pageId);
                      if (page) {
                        handleViewPage(page);
                      } else {
                        setView('list');
                      }
                    } catch {
                      setView('list');
                    }
                  }}
                  className="btn-primary text-[12px]"
                >
                  View Landing Page
                </button>
                <button
                  onClick={() => { resetForm(); setView('configure'); }}
                  className="btn-secondary text-[12px]"
                >
                  Generate Another
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  // ── Configure view ──
  if (view === 'configure') {
    const canGenerate = docsReady?.ready && angle.trim();

    return (
      <div>
        <div className="flex items-center gap-3 mb-5">
          <button onClick={() => setView('list')} className="text-textlight hover:text-textmid transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <h2 className="text-[15px] font-semibold text-textdark tracking-tight">Generate Landing Page</h2>
        </div>

        {/* Docs warning */}
        {docsReady && !docsReady.ready && (
          <div className="mb-4 p-3 bg-gold/5 border border-gold/20 rounded-xl flex items-center gap-2">
            <svg className="w-4 h-4 text-gold flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="text-[12px] text-gold font-medium">
              Foundational documents required — missing: {docsReady.missing.join(', ')}. Generate or upload docs first.
            </span>
          </div>
        )}

        <div className="space-y-5 max-w-2xl">
          {/* Angle */}
          <div className="card p-5">
            <label className="block text-[13px] font-medium text-textdark mb-1.5">
              Angle / Hook
              <InfoTooltip text="The marketing angle or hook for this landing page. This guides the overall narrative and emotional direction." />
            </label>
            <input
              type="text"
              value={angle}
              onChange={(e) => setAngle(e.target.value)}
              className="input-apple"
              placeholder='e.g., "The hidden mineral deficiency behind chronic fatigue"'
            />
          </div>

          {/* Swipe Reference */}
          <div className="card p-5">
            <label className="block text-[13px] font-medium text-textdark mb-1.5">
              Swipe Page URL
              <InfoTooltip text="Paste the URL of an advertorial or landing page to use as design and tonal inspiration. The AI will load the page, take a screenshot, analyze its visual design, and produce a styled HTML page." />
            </label>
            <input
              type="url"
              value={swipeUrl}
              onChange={(e) => { setSwipeUrl(e.target.value); if (e.target.value.trim()) setSwipePdf(null); }}
              className="input-apple"
              placeholder="https://example.com/advertorial"
            />
            <p className="text-[10px] text-textlight mt-1.5">
              Optional — the page is loaded in a headless browser, screenshotted, and analyzed for visual design and copy structure.
            </p>

            {/* Divider */}
            <div className="flex items-center gap-3 my-3">
              <div className="flex-1 border-t border-black/5" />
              <span className="text-[10px] text-textlight font-medium uppercase tracking-wider">or upload PDF</span>
              <div className="flex-1 border-t border-black/5" />
            </div>

            {/* PDF upload with drag & drop */}
            {swipePdf ? (
              <div className="flex items-center gap-2 px-3 py-2 bg-navy/5 border border-navy/10 rounded-xl">
                <svg className="w-4 h-4 text-navy/60 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                </svg>
                <span className="text-[12px] text-navy truncate flex-1">{swipePdf.name}</span>
                <button
                  onClick={() => setSwipePdf(null)}
                  className="text-textlight hover:text-red-500 transition-colors"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ) : (
              <label
                className={`flex flex-col items-center justify-center gap-1 px-3 py-4 border-2 border-dashed rounded-xl cursor-pointer transition-all ${swipeUrl.trim() ? 'border-black/10 text-textlight opacity-50 pointer-events-none' : 'border-navy/20 text-textmid hover:border-navy/40 hover:bg-navy/5'}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (!swipeUrl.trim()) e.currentTarget.classList.add('border-gold', 'bg-gold/5');
                }}
                onDragLeave={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  e.currentTarget.classList.remove('border-gold', 'bg-gold/5');
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  e.currentTarget.classList.remove('border-gold', 'bg-gold/5');
                  if (swipeUrl.trim()) return;
                  const file = Array.from(e.dataTransfer?.files || []).find(f => f.name.toLowerCase().endsWith('.pdf'));
                  if (file) {
                    setSwipePdf({ file, name: file.name });
                    setSwipeUrl('');
                  }
                }}
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 16V4m0 0l-4 4m4-4l4 4M4 14v4a2 2 0 002 2h12a2 2 0 002-2v-4" />
                </svg>
                <span className="text-[12px]">Drop PDF here or click to browse</span>
                <input
                  type="file"
                  accept=".pdf"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      setSwipePdf({ file, name: file.name });
                      setSwipeUrl('');
                    }
                    e.target.value = '';
                  }}
                />
              </label>
            )}
          </div>

          {/* Word Count */}
          <div className="card p-5">
            <label className="block text-[13px] font-medium text-textdark mb-1.5">
              Target Word Count
              <InfoTooltip text="Approximate word count for the entire landing page. Default is 1200 words." />
            </label>
            <input
              type="number"
              value={wordCount}
              onChange={(e) => setWordCount(parseInt(e.target.value) || 1200)}
              className="input-apple w-32"
              min={300}
              max={5000}
              step={100}
            />
            <p className="text-[10px] text-textlight mt-1">Approximate target — actual output may vary slightly.</p>
          </div>

          {/* Additional Direction */}
          <div className="card p-5">
            <label className="block text-[13px] font-medium text-textdark mb-1.5">
              Additional Direction
              <InfoTooltip text="Optional extra instructions for the AI. E.g., tone preferences, specific sections to emphasize, or things to avoid." />
            </label>
            <textarea
              value={additionalDirection}
              onChange={(e) => setAdditionalDirection(e.target.value)}
              className="input-apple resize-none"
              rows={3}
              placeholder="e.g., Focus on the science angle, include a personal story in the lead, keep the tone conversational..."
            />
          </div>

          {/* Generate Button */}
          <button
            onClick={handleStartGenerate}
            disabled={!canGenerate}
            className="btn-primary w-full disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {!docsReady?.ready
              ? 'Foundational Docs Required'
              : !angle.trim()
                ? 'Enter an Angle to Generate'
                : (swipeUrl.trim() || swipePdf)
                  ? 'Generate Landing Page (with Design Analysis)'
                  : 'Generate Landing Page'
            }
          </button>

          {/* Info about what happens with a swipe reference */}
          {(swipeUrl.trim() || swipePdf) && (
            <div className="p-3 bg-navy/5 border border-navy/10 rounded-xl">
              <p className="text-[11px] text-navy font-medium mb-1">With swipe {swipeUrl.trim() ? 'URL' : 'PDF'}, generation includes:</p>
              <ul className="text-[10px] text-navy/70 space-y-0.5 ml-3 list-disc">
                {swipeUrl.trim() && <li>Full-page screenshot and text extraction from the live page</li>}
                {swipePdf && <li>PDF visual analysis and content extraction</li>}
                <li>Visual design analysis (colors, typography, layout)</li>
                <li>Copy generation guided by swipe structure</li>
                <li>AI image generation for each image slot</li>
                <li>Complete HTML page with embedded styling</li>
              </ul>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── List view (default) ──
  return (
    <div>
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-4">
          <div className="flex gap-1 p-0.5 bg-offwhite rounded-lg">
            <button
              onClick={() => setSubTab('pages')}
              className={`px-3 py-1.5 rounded-md text-[12px] font-medium transition-all ${
                subTab === 'pages' ? 'bg-navy text-white shadow-sm' : 'text-textmid hover:text-textdark'
              }`}
            >
              Landing Pages
            </button>
            <button
              onClick={() => setSubTab('templates')}
              className={`px-3 py-1.5 rounded-md text-[12px] font-medium transition-all ${
                subTab === 'templates' ? 'bg-navy text-white shadow-sm' : 'text-textmid hover:text-textdark'
              }`}
            >
              Templates
            </button>
          </div>
        </div>
        {subTab === 'pages' && (
          <button
            onClick={() => setView('configure')}
            className="btn-primary text-[13px] inline-flex items-center gap-1.5"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            New Landing Page
          </button>
        )}
      </div>

      {subTab === 'templates' ? (
        <LPTemplateManager projectId={projectId} />
      ) : (
        <>
      {/* Landing Pages list content */}

      {loading ? (
        <div className="space-y-3">
          {[0, 1, 2].map(i => (
            <div key={i} className="card p-4 animate-pulse">
              <div className="flex items-center gap-3">
                <div className="h-4 w-48 bg-gray-200 rounded" />
                <div className="h-3 w-16 bg-gray-100 rounded-full" />
              </div>
              <div className="h-3 w-32 bg-gray-100 rounded mt-2" />
            </div>
          ))}
        </div>
      ) : pages.length === 0 ? (
        <div className="card p-8 text-center">
          <div className="w-12 h-12 mx-auto mb-3 rounded-2xl bg-navy/5 flex items-center justify-center">
            <svg className="w-6 h-6 text-navy/40" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
            </svg>
          </div>
          <p className="text-[14px] font-medium text-textdark mb-1">No landing pages yet</p>
          <p className="text-[12px] text-textmid mb-4">
            Generate your first landing page from foundational docs and a swipe URL.
          </p>
          <button
            onClick={() => setView('configure')}
            className="btn-primary text-[13px]"
          >
            Generate First Landing Page
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {(() => {
            // Group pages into batches and singles
            const batchMap = {};
            const singles = [];
            for (const page of pages) {
              if (page.gauntlet_batch_id) {
                if (!batchMap[page.gauntlet_batch_id]) batchMap[page.gauntlet_batch_id] = [];
                batchMap[page.gauntlet_batch_id].push(page);
              } else {
                singles.push(page);
              }
            }
            // Convert batches to array sorted by earliest created_at desc
            const batches = Object.entries(batchMap).map(([batchId, batchPages]) => ({
              batchId,
              pages: batchPages.sort((a, b) => new Date(a.created_at) - new Date(b.created_at)),
              sortDate: Math.min(...batchPages.map(p => new Date(p.created_at).getTime())),
            })).sort((a, b) => b.sortDate - a.sortDate);

            // Interleave batches and singles by date (most recent first)
            const items = [];
            for (const batch of batches) {
              items.push({ type: 'batch', ...batch });
            }
            for (const page of singles) {
              items.push({ type: 'single', page, sortDate: new Date(page.created_at).getTime() });
            }
            items.sort((a, b) => b.sortDate - a.sortDate);

            return items.map(item => {
              if (item.type === 'batch') {
                const { batchId, pages: batchPages } = item;
                const expanded = expandedBatches[batchId];
                const passedCount = batchPages.filter(p => p.gauntlet_status === 'passed' || p.gauntlet_status === 'published').length;
                const scores = batchPages.filter(p => p.gauntlet_score != null).map(p => p.gauntlet_score);
                const avgScore = scores.length > 0 ? Math.round(scores.reduce((s, v) => s + v, 0) / scores.length * 10) / 10 : null;

                // Duration from batch timestamps
                const startedAt = batchPages[0]?.gauntlet_batch_started_at;
                const completedAt = batchPages[0]?.gauntlet_batch_completed_at;
                let durationStr = '';
                let timeRange = '';
                if (startedAt) {
                  const startDate = new Date(startedAt);
                  timeRange = startDate.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
                  if (completedAt) {
                    const endDate = new Date(completedAt);
                    const diffMin = Math.round((endDate - startDate) / 60000);
                    if (diffMin >= 60) {
                      const hrs = Math.floor(diffMin / 60);
                      const mins = diffMin % 60;
                      durationStr = mins > 0 ? `${hrs} hour${hrs !== 1 ? 's' : ''} ${mins} minute${mins !== 1 ? 's' : ''}` : `${hrs} hour${hrs !== 1 ? 's' : ''}`;
                    } else {
                      durationStr = `${diffMin} minute${diffMin !== 1 ? 's' : ''}`;
                    }
                    timeRange += ` – ${endDate.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
                  }
                } else {
                  timeRange = new Date(batchPages[0].created_at).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
                }

                const allDone = batchPages.every(p => p.status !== 'generating');

                return (
                  <div key={batchId} className="space-y-0">
                    {/* Batch header row */}
                    <div
                      className="card p-4 w-full text-left hover:shadow-card-hover transition-shadow cursor-pointer"
                      onClick={() => setExpandedBatches(prev => ({ ...prev, [batchId]: !prev[batchId] }))}
                    >
                      <div className="flex items-center gap-3">
                        <svg className={`w-3.5 h-3.5 text-textmid flex-shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                        </svg>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <h3 className="text-[13px] font-medium text-textdark">
                              LP Batch{batchPages[0]?.angle && batchPages[0].angle.length < 80 ? <> — <span className="text-navy">{batchPages[0].angle}</span></> : ''} — {batchPages.length} landing page{batchPages.length !== 1 ? 's' : ''}
                              {durationStr && <span className="text-textlight font-normal"> — Generated in {durationStr}</span>}
                            </h3>
                            {!allDone && gauntletProgress ? (
                              <div className="flex-1 max-w-xs ml-2">
                                <PipelineProgress
                                  progress={gauntletProgress.percent}
                                  message={gauntletProgress.message}
                                  startTime={gauntletProgress.startedAt}
                                />
                              </div>
                            ) : !allDone ? (
                              <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-navy/10 text-navy animate-pulse">
                                Generating...
                              </span>
                            ) : null}
                          </div>
                          <div className="flex items-center gap-3 mt-1">
                            <span className="text-[11px] text-textlight">{timeRange}</span>
                            {allDone && (
                              <>
                                <span className="text-[11px] text-textmid">
                                  Passed: <span className={passedCount === batchPages.length ? 'text-teal' : 'text-textdark'}>{passedCount}/{batchPages.length}</span>
                                </span>
                                {avgScore != null && (
                                  <span className="text-[11px] text-textmid">
                                    Avg score: <span className={avgScore >= 6 ? 'text-teal' : 'text-gold'}>{avgScore}</span>
                                  </span>
                                )}
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Expanded batch sub-rows */}
                    {expanded && (
                      <div className="ml-6 border-l-2 border-navy/10 space-y-1 py-1">
                        {batchPages.map(page => {
                          const status = STATUS_CONFIG[page.status] || STATUS_CONFIG.draft;
                          const frameName = FRAME_LABELS[page.gauntlet_frame] || page.gauntlet_frame || page.narrative_frame || '';
                          const isPublished = page.status === 'published';
                          return (
                            <div
                              key={page.externalId}
                              className="card ml-2 p-3 w-full text-left hover:shadow-card-hover transition-shadow cursor-pointer"
                              onClick={() => handleViewPage(page)}
                            >
                              <div className="flex items-center gap-3">
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2">
                                    <h3 className="text-[12px] font-medium text-textdark truncate">
                                      {frameName || page.name}{page.angle && page.angle.length < 80 ? <span className="text-textmid font-normal"> - {page.angle}</span> : ''}
                                    </h3>
                                    {page.gauntlet_score != null && (
                                      <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${page.gauntlet_score >= 6 ? 'bg-teal/10 text-teal' : 'bg-gold/10 text-gold'}`}>
                                        {page.gauntlet_score}/10
                                      </span>
                                    )}
                                    <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${status.bg} ${status.text}`}>
                                      {status.label}
                                    </span>
                                    {(page.gauntlet_status === 'passed' || page.gauntlet_status === 'published') && (
                                      <span className="text-teal text-[11px]">✓</span>
                                    )}
                                    {page.gauntlet_status === 'failed' && (
                                      <span className="text-red-500 text-[11px]">✗</span>
                                    )}
                                  </div>
                                  {isPublished && page.published_url && (
                                    <div className="flex items-center gap-1.5 mt-1">
                                      <svg className="w-3 h-3 text-teal flex-shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                                        <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m9.86-2.504a4.5 4.5 0 00-1.242-7.244l-4.5-4.5a4.5 4.5 0 00-6.364 6.364L4.343 8.684" />
                                      </svg>
                                      <span
                                        className="text-[10px] font-mono text-gold hover:text-gold/80 truncate max-w-[300px]"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          navigator.clipboard.writeText(page.published_url);
                                          toast.success('URL copied');
                                        }}
                                        title="Click to copy URL"
                                      >
                                        {page.published_url}
                                      </span>
                                    </div>
                                  )}
                                </div>
                                <div className="flex items-center gap-1 flex-shrink-0">
                                  <button
                                    onClick={(e) => { e.stopPropagation(); handleViewPage(page); }}
                                    className="text-[10px] text-navy hover:text-navy/70 px-2 py-1 rounded-lg hover:bg-navy/5 transition-colors"
                                  >
                                    View
                                  </button>
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      if (!confirm(`Delete "${page.name}"? This cannot be undone.`)) return;
                                      api.deleteLandingPage(projectId, page.externalId)
                                        .then(() => { toast.success('Landing page deleted'); loadPages(); })
                                        .catch(err => toast.error(err.message || 'Failed to delete'));
                                    }}
                                    className="text-textlight hover:text-red-500 p-1 rounded-lg hover:bg-red-50 transition-colors"
                                    title="Delete"
                                  >
                                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                                      <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                                    </svg>
                                  </button>
                                </div>
                              </div>
                              {page.status === 'failed' && page.error_message && (
                                <p className="text-[10px] text-red-500 mt-1 truncate">{page.error_message}</p>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              }

              // Single (non-batch) LP row — unchanged from original
              const page = item.page;
              const status = STATUS_CONFIG[page.status] || STATUS_CONFIG.draft;
              let sections = [];
              try { sections = page.copy_sections ? JSON.parse(page.copy_sections) : []; } catch {}
              const totalWords = sections.reduce((sum, s) => sum + countWords(s.content), 0);
              const hasHtml = !!page.assembled_html;
              const hasDesign = !!page.swipe_design_analysis;
              const isPublished = page.status === 'published';

              return (
                <div
                  key={page.externalId}
                  className="card p-4 w-full text-left hover:shadow-card-hover transition-shadow cursor-pointer"
                  onClick={() => handleViewPage(page)}
                >
                  <div className="flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="text-[13px] font-medium text-textdark truncate">{page.name}</h3>
                        <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${status.bg} ${status.text}`}>
                          {status.label}
                        </span>
                        {hasHtml && !isPublished && (
                          <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-teal/5 text-teal">
                            HTML
                          </span>
                        )}
                        {page.auto_generated && (
                          <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-navy/10 text-navy">
                            Auto
                          </span>
                        )}
                        {page.qa_status === 'passed' && (
                          <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-teal/10 text-teal" title="Visual QA passed">
                            QA Pass
                          </span>
                        )}
                        {page.qa_status === 'failed' && (
                          <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-red-50 text-red-600" title={`${page.qa_issues_count || 0} issue(s) found`}>
                            QA {page.qa_issues_count || 0}
                          </span>
                        )}
                        {page.qa_status === 'running' && (
                          <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-gold/10 text-gold animate-pulse">
                            QA...
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-1">
                        <span className="text-[11px] text-textlight">
                          {new Date(page.created_at).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}
                        </span>
                        {(page.status === 'completed' || isPublished) && (
                          <>
                            <span className="text-[11px] text-textlight">{totalWords} words</span>
                            <span className="text-[11px] text-textlight">{sections.length} sections</span>
                          </>
                        )}
                        {page.swipe_url && (
                          <a
                            href={page.swipe_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="text-[10px] text-gold hover:text-gold/80 bg-gold/5 px-1.5 py-0.5 rounded truncate max-w-[200px] inline-block"
                            title={page.swipe_url}
                          >
                            {(() => { try { return new URL(page.swipe_url).hostname; } catch { return page.swipe_url; } })()}
                          </a>
                        )}
                        {hasDesign && (
                          <span className="text-[10px] text-navy/50">
                            Design analyzed
                          </span>
                        )}
                      </div>
                      {/* Published URL */}
                      {isPublished && page.published_url && (
                        <div className="flex items-center gap-1.5 mt-1">
                          <svg className="w-3 h-3 text-teal flex-shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m9.86-2.504a4.5 4.5 0 00-1.242-7.244l-4.5-4.5a4.5 4.5 0 00-6.364 6.364L4.343 8.684" />
                          </svg>
                          <span
                            className="text-[10px] font-mono text-gold hover:text-gold/80 truncate max-w-[300px]"
                            onClick={(e) => {
                              e.stopPropagation();
                              navigator.clipboard.writeText(page.published_url);
                              toast.success('URL copied');
                            }}
                            title="Click to copy URL"
                          >
                            {page.published_url}
                          </span>
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDuplicate(page); }}
                        className="text-textlight hover:text-navy p-1.5 rounded-lg hover:bg-navy/5 transition-colors"
                        title="Duplicate"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.5a1.125 1.125 0 01-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H6.75a9.06 9.06 0 011.5.124m7.5 10.376h3.375c.621 0 1.125-.504 1.125-1.125V11.25c0-4.46-3.243-8.161-7.5-8.876a9.06 9.06 0 00-1.5-.124H9.375c-.621 0-1.125.504-1.125 1.125v3.5m7.5 10.375H9.375a1.125 1.125 0 01-1.125-1.125v-9.25m0 0a2.625 2.625 0 00-2.625 2.625v6.625a2.625 2.625 0 002.625 2.625" />
                        </svg>
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (!confirm(`Delete "${page.name}"? This cannot be undone.`)) return;
                          api.deleteLandingPage(projectId, page.externalId)
                            .then(() => { toast.success('Landing page deleted'); loadPages(); })
                            .catch(err => toast.error(err.message || 'Failed to delete'));
                        }}
                        className="text-textlight hover:text-red-500 p-1.5 rounded-lg hover:bg-red-50 transition-colors"
                        title="Delete"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                        </svg>
                      </button>
                      <svg className="w-4 h-4 text-textlight" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                      </svg>
                    </div>
                  </div>
                  {page.status === 'failed' && page.error_message && (
                    <p className="text-[11px] text-red-500 mt-1.5 truncate">{page.error_message}</p>
                  )}
                </div>
              );
            });
          })()}
        </div>
      )}
        </>
      )}
    </div>
  );
}

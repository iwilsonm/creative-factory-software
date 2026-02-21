import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { api } from '../api';
import InfoTooltip from './InfoTooltip';
import { useToast } from './Toast';

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
  design_analysis: { label: 'Design Analysis', icon: '🎨', description: 'Analyzing swipe PDF visual layout...' },
  copy_generation: { label: 'Copy Generation', icon: '✍️', description: 'Writing landing page copy...' },
  image_generation: { label: 'Image Generation', icon: '🖼️', description: 'Generating images via Gemini...' },
  html_generation: { label: 'HTML Template', icon: '🏗️', description: 'Building HTML page...' },
  assembling: { label: 'Assembly', icon: '🔧', description: 'Assembling final page...' },
};

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
    // Auto-generate from angle
    return (initialPage.angle || 'landing-page')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
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

  // ── Derived values ──
  const totalWords = useMemo(() => copySections.reduce((sum, s) => sum + countWords(s.content), 0), [copySections]);
  const hasMissingCtaUrl = ctaLinks.some(c => !c.url || c.url === '#order' || c.url === '#');

  // ── Build preview HTML with image overlays ──
  const displayHtml = useMemo(() => injectImageOverlays(previewHtml), [previewHtml]);

  // Tab config
  const TABS = [
    { id: 'copy', label: 'Copy' },
    { id: 'images', label: 'Images', count: imageSlots.length },
    { id: 'links', label: 'Links', count: ctaLinks.length },
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
              initialPage.status === 'completed' ? 'bg-teal/10 text-teal' :
              initialPage.status === 'failed' ? 'bg-red-50 text-red-600' :
              'bg-black/5 text-textmid'
            }`}>
              {initialPage.status}
            </span>
            <span className="text-[10px] font-mono text-textlight bg-black/5 px-1.5 py-0.5 rounded">
              v{currentVersion}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {hasMissingCtaUrl && (
            <span className="text-gold text-[10px] flex items-center gap-1" title="Some CTA links need URLs">
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126z" />
              </svg>
              CTA links
            </span>
          )}
          <button
            disabled
            title="Publishing coming in next update"
            className="btn-primary text-[11px] px-3 py-1.5 opacity-50 cursor-not-allowed"
          >
            Publish
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

      {/* ── Split Panel ── */}
      <div className="flex flex-1 min-h-0 gap-0">
        {/* ── Left: Preview ── */}
        <div className="w-[60%] overflow-auto border border-black/10 rounded-xl bg-white">
          {displayHtml ? (
            <HtmlPreview html={displayHtml} className="border-0 rounded-none" />
          ) : (
            <div className="flex items-center justify-center h-full text-textlight text-[13px]">
              No preview available
            </div>
          )}
        </div>

        {/* ── Right: Editor Panel ── */}
        <div className="w-[40%] overflow-y-auto border-l border-black/5 pl-4 ml-2">
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
                  <p className="text-[11px] text-textlight mt-1">Upload a swipe PDF to get AI-generated images.</p>
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
                  Publishing & custom domains coming in next update. For now, CTA links will be embedded in the exported HTML.
                </p>
              </div>
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

              {/* Generation Details */}
              <div className="p-3 bg-offwhite rounded-xl border border-black/5">
                <p className="text-[11px] font-medium text-textmid mb-1.5">Generation Details</p>
                <div className="space-y-1 text-[11px] text-textlight">
                  {initialPage.swipe_filename && (
                    <p>Swipe file: <span className="text-textmid">{initialPage.swipe_filename}</span></p>
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
};

// ═══════════════════════════════════════════════════════════════════════════
// Main LPGen Component
// ═══════════════════════════════════════════════════════════════════════════
export default function LPGen({ projectId, project }) {
  const toast = useToast();
  const [view, setView] = useState('list'); // list | configure | editor | generating
  const [pages, setPages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedPage, setSelectedPage] = useState(null);

  // Docs readiness
  const [docsReady, setDocsReady] = useState(null); // null = loading, object = result

  // Configure form
  const [angle, setAngle] = useState('');
  const [wordCount, setWordCount] = useState(1200);
  const [additionalDirection, setAdditionalDirection] = useState('');
  const [swipeFile, setSwipeFile] = useState(null); // { file, text, filename, charCount }

  // Generation state
  const [generating, setGenerating] = useState(false);
  const [genProgress, setGenProgress] = useState('');
  const [genResult, setGenResult] = useState(null);
  const [genError, setGenError] = useState('');
  const [genPhases, setGenPhases] = useState([]); // ordered list of phases for this generation
  const [currentPhase, setCurrentPhase] = useState('');
  const [imageProgress, setImageProgress] = useState(null); // { current, total, slotId }
  const abortRef = useRef(null);

  // Load pages + check docs on mount
  useEffect(() => {
    loadPages();
    checkDocs();
  }, [projectId]);

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

  const handleStartGenerate = useCallback(() => {
    if (!angle.trim()) {
      toast.error('Please enter an angle / hook for the landing page');
      return;
    }

    setGenerating(true);
    setGenProgress('Starting...');
    setGenError('');
    setGenResult(null);
    setGenPhases([]);
    setCurrentPhase('');
    setImageProgress(null);
    setView('generating');

    const formData = new FormData();
    formData.append('angle', angle.trim());
    formData.append('word_count', String(wordCount));
    if (additionalDirection.trim()) {
      formData.append('additional_direction', additionalDirection.trim());
    }
    if (swipeFile?.file) {
      formData.append('swipe_pdf', swipeFile.file);
    }

    const { abort, done } = api.generateLandingPage(projectId, formData, (event) => {
      if (event.type === 'phase') {
        // New phase started
        setCurrentPhase(event.phase);
        setGenPhases(prev => {
          if (!prev.includes(event.phase)) return [...prev, event.phase];
          return prev;
        });
        setGenProgress(event.message || '');
      } else if (event.type === 'progress') {
        setGenProgress(event.message || event.step || 'Processing...');
        // Track image generation progress
        if (event.imageProgress) {
          setImageProgress(event.imageProgress);
        }
      } else if (event.type === 'started') {
        setGenProgress('Generation started...');
        // Set up initial phases based on whether we have a swipe PDF
        if (event.hasSwipePdf) {
          setGenPhases(['design_analysis', 'copy_generation', 'image_generation', 'html_generation', 'assembling']);
        } else {
          setGenPhases(['copy_generation', 'html_generation', 'assembling']);
        }
      } else if (event.type === 'completed') {
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
  }, [projectId, angle, wordCount, additionalDirection, swipeFile]);

  const handleCancelGenerate = () => {
    if (abortRef.current) {
      abortRef.current();
      abortRef.current = null;
    }
    setGenerating(false);
    setGenProgress('');
    setView('configure');
  };

  const swipeInputRef = useRef(null);
  const [swipeDragOver, setSwipeDragOver] = useState(false);

  const handleSwipeFileSelected = useCallback(async (file) => {
    if (!file) return;
    setSwipeFile({ file, filename: file.name, extracting: true });
    try {
      const result = await api.extractText(file);
      setSwipeFile(prev => ({
        ...prev,
        text: result.text,
        charCount: result.charCount,
        extracting: false,
      }));
    } catch {
      setSwipeFile(prev => ({ ...prev, extracting: false }));
    }
  }, []);

  const handleViewPage = (page) => {
    setSelectedPage(page);
    setView('editor');
  };

  const handleDeleteFromDetail = () => {
    setView('list');
    setSelectedPage(null);
    loadPages();
  };

  const resetForm = () => {
    setAngle('');
    setWordCount(1200);
    setAdditionalDirection('');
    setSwipeFile(null);
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
              <div className="w-10 h-10 mx-auto mb-4 rounded-full bg-navy/10 flex items-center justify-center">
                <svg className="w-5 h-5 text-navy animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4 31.4" strokeLinecap="round" />
                </svg>
              </div>
              <p className="text-[14px] font-medium text-textdark mb-4">Building your landing page...</p>

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
                <p className="text-[10px] text-navy/60 mb-4">Design extracted from swipe PDF</p>
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

          {/* Swipe PDF */}
          <div className="card p-5">
            <label className="block text-[13px] font-medium text-textdark mb-1.5">
              Swipe File (PDF)
              <InfoTooltip text="Upload a PDF of a landing page to use as design and tonal inspiration. The AI will analyze its visual design, generate matching images, and produce a styled HTML page." />
            </label>
            {swipeFile ? (
              <div className="flex items-center gap-3 p-3 bg-teal/5 border border-teal/15 rounded-xl">
                <svg className="w-5 h-5 text-teal flex-shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                </svg>
                <div className="flex-1 min-w-0">
                  <p className="text-[12px] font-medium text-teal truncate">{swipeFile.filename}</p>
                  {swipeFile.extracting ? (
                    <p className="text-[10px] text-teal/70">Extracting text...</p>
                  ) : swipeFile.charCount ? (
                    <p className="text-[10px] text-teal/70">{swipeFile.charCount.toLocaleString()} characters extracted</p>
                  ) : null}
                </div>
                <button
                  onClick={() => setSwipeFile(null)}
                  className="text-[11px] text-red-400 hover:text-red-500"
                >
                  Remove
                </button>
              </div>
            ) : (
              <>
                <div
                  onClick={() => swipeInputRef.current?.click()}
                  onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setSwipeDragOver(true); }}
                  onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); setSwipeDragOver(true); }}
                  onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); setSwipeDragOver(false); }}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setSwipeDragOver(false);
                    const file = e.dataTransfer?.files?.[0];
                    if (file && (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'))) {
                      handleSwipeFileSelected(file);
                    } else {
                      toast.error('Only PDF files are supported');
                    }
                  }}
                  className={`border-2 border-dashed rounded-lg p-4 text-center cursor-pointer transition-all ${
                    swipeDragOver
                      ? 'border-gold bg-gold/5'
                      : 'border-gray-300 hover:border-gold hover:bg-offwhite'
                  }`}
                >
                  <div className="text-lg mb-1 text-gray-400">{swipeDragOver ? '📂' : '📄'}</div>
                  <p className={`text-xs font-medium ${swipeDragOver ? 'text-gold' : 'text-textmid'}`}>
                    {swipeDragOver ? 'Drop PDF here' : 'Drop a swipe PDF here, or click to browse'}
                  </p>
                  <p className="text-[10px] text-gray-400 mt-1">PDF only — used for design analysis + copy inspiration</p>
                </div>
                <input
                  ref={swipeInputRef}
                  type="file"
                  accept=".pdf"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleSwipeFileSelected(file);
                    e.target.value = '';
                  }}
                  className="hidden"
                />
              </>
            )}
            <p className="text-[10px] text-textlight mt-1.5">
              Optional — when provided, the AI analyzes the visual design, generates matching images, and creates a styled HTML page.
            </p>
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
                : swipeFile
                  ? 'Generate Landing Page (with Design Analysis)'
                  : 'Generate Landing Page'
            }
          </button>

          {/* Info about what happens with a swipe PDF */}
          {swipeFile && (
            <div className="p-3 bg-navy/5 border border-navy/10 rounded-xl">
              <p className="text-[11px] text-navy font-medium mb-1">With swipe PDF, generation includes:</p>
              <ul className="text-[10px] text-navy/70 space-y-0.5 ml-3 list-disc">
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
        <div>
          <h2 className="text-[15px] font-semibold text-textdark tracking-tight">Landing Pages</h2>
          <p className="text-[12px] text-textmid mt-0.5">
            Generate long-form landing page copy from your foundational research.
          </p>
        </div>
        <button
          onClick={() => setView('configure')}
          className="btn-primary text-[13px] inline-flex items-center gap-1.5"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          New Landing Page
        </button>
      </div>

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
            Generate your first landing page from foundational docs and a swipe file.
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
          {pages.map(page => {
            const status = STATUS_CONFIG[page.status] || STATUS_CONFIG.draft;
            const sections = page.copy_sections ? JSON.parse(page.copy_sections) : [];
            const totalWords = sections.reduce((sum, s) => sum + countWords(s.content), 0);
            const hasHtml = !!page.assembled_html;
            const hasDesign = !!page.swipe_design_analysis;

            return (
              <button
                key={page.externalId}
                onClick={() => handleViewPage(page)}
                className="card p-4 w-full text-left hover:shadow-card-hover transition-shadow"
              >
                <div className="flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="text-[13px] font-medium text-textdark truncate">{page.name}</h3>
                      <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${status.bg} ${status.text}`}>
                        {status.label}
                      </span>
                      {hasHtml && (
                        <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-teal/5 text-teal">
                          HTML
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-1">
                      <span className="text-[11px] text-textlight">
                        {new Date(page.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                      </span>
                      {page.status === 'completed' && (
                        <>
                          <span className="text-[11px] text-textlight">{totalWords} words</span>
                          <span className="text-[11px] text-textlight">{sections.length} sections</span>
                        </>
                      )}
                      {page.swipe_filename && (
                        <span className="text-[10px] text-textlight bg-black/5 px-1.5 py-0.5 rounded">
                          {page.swipe_filename}
                        </span>
                      )}
                      {hasDesign && (
                        <span className="text-[10px] text-navy/50">
                          Design analyzed
                        </span>
                      )}
                    </div>
                  </div>
                  <svg className="w-4 h-4 text-textlight flex-shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                  </svg>
                </div>
                {page.status === 'failed' && page.error_message && (
                  <p className="text-[11px] text-red-500 mt-1.5 truncate">{page.error_message}</p>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

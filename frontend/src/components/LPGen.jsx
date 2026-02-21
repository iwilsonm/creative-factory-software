import { useState, useEffect, useRef, useCallback } from 'react';
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
// Landing Page Detail View (preview + copy sections)
// ═══════════════════════════════════════════════════════════════════════════
function LandingPageDetail({ page, onBack, onDelete, projectId }) {
  const toast = useToast();
  const [deleting, setDeleting] = useState(false);
  const [activeTab, setActiveTab] = useState(page.assembled_html ? 'preview' : 'copy');
  const sections = page.copy_sections ? JSON.parse(page.copy_sections) : [];
  const totalWords = sections.reduce((sum, s) => sum + countWords(s.content), 0);
  const imageSlots = page.image_slots ? JSON.parse(page.image_slots) : [];
  const hasDesign = !!page.swipe_design_analysis;
  const generatedImages = imageSlots.filter(s => s.generated);

  const handleDelete = async () => {
    if (!confirm('Delete this landing page? This cannot be undone.')) return;
    setDeleting(true);
    try {
      await api.deleteLandingPage(projectId, page.externalId);
      toast.success('Landing page deleted');
      onDelete();
    } catch (err) {
      toast.error(err.message || 'Failed to delete');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div>
      {/* Header */}
      <div className="flex items-center gap-3 mb-4">
        <button onClick={onBack} className="text-textlight hover:text-textmid transition-colors">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <div className="flex-1 min-w-0">
          <h2 className="text-[15px] font-semibold text-textdark tracking-tight truncate">{page.name}</h2>
          <div className="flex items-center gap-3 mt-0.5 flex-wrap">
            <span className="text-[11px] text-textlight">
              {new Date(page.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
            </span>
            {page.angle && (
              <span className="text-[10px] text-textmid bg-black/5 px-2 py-0.5 rounded-full truncate max-w-[300px]">
                {page.angle}
              </span>
            )}
            <span className="text-[10px] text-textlight">{totalWords} words</span>
            <span className="text-[10px] text-textlight">{sections.length} sections</span>
            {generatedImages.length > 0 && (
              <span className="text-[10px] text-teal bg-teal/5 px-2 py-0.5 rounded-full">
                {generatedImages.length} image{generatedImages.length !== 1 ? 's' : ''}
              </span>
            )}
            {hasDesign && (
              <span className="text-[10px] text-navy bg-navy/5 px-2 py-0.5 rounded-full">
                Design analyzed
              </span>
            )}
          </div>
        </div>
        <button
          onClick={handleDelete}
          disabled={deleting}
          className="text-[11px] text-red-400 hover:text-red-500 transition-colors disabled:opacity-50"
        >
          {deleting ? 'Deleting...' : 'Delete'}
        </button>
      </div>

      {/* Tab bar: Preview | Copy Sections */}
      {page.assembled_html && (
        <div className="flex gap-1 mb-4 p-1 bg-offwhite rounded-lg w-fit">
          <button
            onClick={() => setActiveTab('preview')}
            className={`px-4 py-1.5 rounded-md text-[12px] font-medium transition-all ${
              activeTab === 'preview'
                ? 'bg-navy text-white shadow-sm'
                : 'text-textmid hover:text-textdark'
            }`}
          >
            Preview
          </button>
          <button
            onClick={() => setActiveTab('copy')}
            className={`px-4 py-1.5 rounded-md text-[12px] font-medium transition-all ${
              activeTab === 'copy'
                ? 'bg-navy text-white shadow-sm'
                : 'text-textmid hover:text-textdark'
            }`}
          >
            Copy Sections
          </button>
        </div>
      )}

      {/* Content */}
      {activeTab === 'preview' && page.assembled_html ? (
        <HtmlPreview html={page.assembled_html} />
      ) : (
        <>
          {sections.length > 0 ? (
            <div className="space-y-2">
              {sections.map((section, i) => (
                <CopySection key={i} section={section} index={i} />
              ))}
            </div>
          ) : (
            <div className="card p-8 text-center">
              <p className="text-textmid text-[13px]">No copy sections generated yet.</p>
            </div>
          )}
        </>
      )}

      {/* Metadata footer */}
      {(page.swipe_filename || page.additional_direction) && (
        <div className="mt-4 p-3 bg-offwhite rounded-xl border border-black/5">
          <p className="text-[11px] font-medium text-textmid mb-1.5">Generation Details</p>
          <div className="space-y-1 text-[11px] text-textlight">
            {page.swipe_filename && (
              <p>Swipe file: <span className="text-textmid">{page.swipe_filename}</span></p>
            )}
            {page.word_count && (
              <p>Target word count: <span className="text-textmid">{page.word_count}</span></p>
            )}
            {page.additional_direction && (
              <p>Additional direction: <span className="text-textmid">{page.additional_direction}</span></p>
            )}
            {hasDesign && (
              <p>Design analysis: <span className="text-teal">Yes — extracted from swipe PDF</span></p>
            )}
            {generatedImages.length > 0 && (
              <p>Generated images: <span className="text-teal">{generatedImages.length} via Gemini</span></p>
            )}
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
  const [view, setView] = useState('list'); // list | configure | detail | generating
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
    setView('detail');
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

  // ── Detail view ──
  if (view === 'detail' && selectedPage) {
    return (
      <LandingPageDetail
        page={selectedPage}
        onBack={() => { setView('list'); setSelectedPage(null); }}
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

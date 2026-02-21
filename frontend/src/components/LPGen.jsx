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

// ═══════════════════════════════════════════════════════════════════════════
// Copy Section Display
// ═══════════════════════════════════════════════════════════════════════════
function CopySection({ section, index }) {
  const [expanded, setExpanded] = useState(true);
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
// Landing Page Detail View (generated copy sections)
// ═══════════════════════════════════════════════════════════════════════════
function LandingPageDetail({ page, onBack, onDelete, projectId }) {
  const toast = useToast();
  const [deleting, setDeleting] = useState(false);
  const sections = page.copy_sections ? JSON.parse(page.copy_sections) : [];
  const totalWords = sections.reduce((sum, s) => sum + countWords(s.content), 0);

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
      <div className="flex items-center gap-3 mb-5">
        <button onClick={onBack} className="text-textlight hover:text-textmid transition-colors">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <div className="flex-1 min-w-0">
          <h2 className="text-[15px] font-semibold text-textdark tracking-tight truncate">{page.name}</h2>
          <div className="flex items-center gap-3 mt-0.5">
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

      {/* Copy Sections */}
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
          </div>
        </div>
      )}
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
      if (event.type === 'progress') {
        setGenProgress(event.message || event.step || 'Processing...');
      } else if (event.type === 'started') {
        setGenProgress('Generation started...');
      } else if (event.type === 'completed') {
        setGenResult(event);
        setGenProgress('');
        setGenerating(false);
        // Refresh the list
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
    // Store raw File for multipart upload + extract text for preview
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
      // Text extraction failed — still keep the file for upload
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

  // ── Generating view (SSE progress) ──
  if (view === 'generating') {
    return (
      <div>
        <div className="flex items-center gap-3 mb-5">
          <h2 className="text-[15px] font-semibold text-textdark tracking-tight">Generating Landing Page</h2>
        </div>

        <div className="card p-8 text-center">
          {generating ? (
            <>
              <div className="w-10 h-10 mx-auto mb-4 rounded-full bg-navy/10 flex items-center justify-center">
                <svg className="w-5 h-5 text-navy animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4 31.4" strokeLinecap="round" />
                </svg>
              </div>
              <p className="text-[14px] font-medium text-textdark mb-1">Writing your landing page...</p>
              <p className="text-[12px] text-textmid mb-4">{genProgress}</p>
              <button
                onClick={handleCancelGenerate}
                className="btn-secondary text-[12px]"
              >
                Cancel
              </button>
            </>
          ) : genError ? (
            <>
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
            </>
          ) : genResult ? (
            <>
              <div className="w-10 h-10 mx-auto mb-4 rounded-full bg-teal/10 flex items-center justify-center">
                <svg className="w-5 h-5 text-teal" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                </svg>
              </div>
              <p className="text-[14px] font-medium text-teal mb-1">Landing Page Generated!</p>
              <p className="text-[12px] text-textmid mb-4">
                {genResult.sections?.length || 0} sections created
              </p>
              <div className="flex items-center justify-center gap-2">
                <button
                  onClick={async () => {
                    // Reload pages first to get the full record
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

              {/* Preview the generated sections inline */}
              {genResult.sections && (
                <div className="mt-6 text-left space-y-2">
                  {genResult.sections.map((section, i) => (
                    <CopySection key={i} section={section} index={i} />
                  ))}
                </div>
              )}
            </>
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
              <InfoTooltip text="Upload a PDF of a landing page you want to use as structural and tonal inspiration. The AI will reference its style but not copy it." />
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
                  <p className="text-[10px] text-gray-400 mt-1">PDF only — used as structural inspiration</p>
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
              Optional — provides structural and tonal reference for the generated copy.
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
                : 'Generate Landing Page Copy'
            }
          </button>
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
                          📄 {page.swipe_filename}
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

import { useState, useEffect, useRef } from 'react';
import { api } from '../api';
import DragDropUpload from './DragDropUpload';
import InfoTooltip from './InfoTooltip';
import { useToast } from './Toast';

const DOC_LABELS = {
  research: 'Research Document',
  avatar: 'Avatar Sheet',
  offer_brief: 'Offer Brief',
  necessary_beliefs: 'Necessary Beliefs'
};

const DOC_ORDER = ['research', 'avatar', 'offer_brief', 'necessary_beliefs'];

function formatElapsed(ms) {
  if (!ms) return '';
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr + 'Z'); // SQLite stores UTC without timezone suffix
  const now = new Date();
  const diff = now - date;
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  // Show relative time for recent updates
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;

  // Show date for older items
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
}

const SOURCE_LABELS = {
  uploaded: { label: 'Uploaded', color: 'bg-blue-100 text-blue-700' },
  generated: { label: 'Generated', color: 'bg-purple-100 text-purple-700' },
  manual_research: { label: 'Manual Research', color: 'bg-green-100 text-green-700' }
};

export default function FoundationalDocs({ projectId, projectStatus }) {
  const toast = useToast();
  const [docs, setDocs] = useState([]);
  const [steps, setSteps] = useState([]);
  const [loading, setLoading] = useState(true);

  // Generation mode: null | 'choosing' | 'auto' | 'manual' | 'upload'
  const [generationMode, setGenerationMode] = useState(null);

  // Generation state (shared by auto & manual)
  const [generating, setGenerating] = useState(false);
  const [currentStep, setCurrentStep] = useState(null);
  const [streamContent, setStreamContent] = useState('');
  const [completedSteps, setCompletedSteps] = useState(new Set());
  const [genError, setGenError] = useState('');
  const abortRef = useRef(null);

  // Deep research progress state (auto mode only)
  const [deepResearchProgress, setDeepResearchProgress] = useState(null);

  // Manual research flow state
  const [manualStep, setManualStep] = useState(1); // 1=prompts, 2=upload, 3=generating
  const [researchPrompts, setResearchPrompts] = useState(null);
  const [manualResearchText, setManualResearchText] = useState('');
  const [loadingPrompts, setLoadingPrompts] = useState(false);
  const [expandedPrompt, setExpandedPrompt] = useState(null);
  const [copiedPrompt, setCopiedPrompt] = useState(null);

  // Direct upload flow state
  const [uploadDocs, setUploadDocs] = useState({
    research: '',
    avatar: '',
    offer_brief: '',
    necessary_beliefs: ''
  });
  const [savingUpload, setSavingUpload] = useState(false);

  // Editing state
  const [editingDoc, setEditingDoc] = useState(null);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);

  // Viewing state
  const [viewDoc, setViewDoc] = useState(null);

  // Regeneration state
  const [regenerating, setRegenerating] = useState(null);

  const streamRef = useRef(null);

  useEffect(() => {
    loadDocs();
  }, [projectId]);

  // Auto-scroll stream content
  useEffect(() => {
    if (streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight;
    }
  }, [streamContent]);

  const loadDocs = async () => {
    try {
      const data = await api.getDocs(projectId);
      setDocs(data.docs);
      setSteps(data.steps);
    } catch (err) {
      console.error('Failed to load docs:', err);
    } finally {
      setLoading(false);
    }
  };

  // --- Choice screen handlers ---

  const handleGenerateClick = () => {
    setGenerationMode('choosing');
    setGenError('');
  };

  const handleChooseManual = async () => {
    setGenerationMode('manual');
    setManualStep(1);
    setManualResearchText('');
    setLoadingPrompts(true);
    setExpandedPrompt(null);
    try {
      const data = await api.getResearchPrompts(projectId);
      setResearchPrompts(data.prompts);
    } catch (err) {
      setGenError('Failed to load research prompts: ' + err.message);
      setGenerationMode(null);
    } finally {
      setLoadingPrompts(false);
    }
  };

  const handleChooseAuto = () => {
    setGenerationMode('auto');
    handleGenerate();
  };

  const handleBackToChoice = () => {
    setGenerationMode('choosing');
    setManualStep(1);
    setManualResearchText('');
    setResearchPrompts(null);
  };

  const handleBackToList = () => {
    setGenerationMode(null);
    setManualStep(1);
    setManualResearchText('');
    setResearchPrompts(null);
  };

  // --- Direct upload handlers ---

  const handleChooseUpload = () => {
    setGenerationMode('upload');
    setUploadDocs({ research: '', avatar: '', offer_brief: '', necessary_beliefs: '' });
    setGenError('');
  };

  const handleSaveUploadedDocs = async () => {
    // At minimum, need research doc
    const filledDocs = Object.entries(uploadDocs).filter(([, v]) => v.trim().length > 0);
    if (filledDocs.length === 0) {
      setGenError('Please provide content for at least one document.');
      return;
    }

    setSavingUpload(true);
    setGenError('');
    try {
      await api.uploadDocs(projectId, uploadDocs);
      setGenerationMode(null);
      setUploadDocs({ research: '', avatar: '', offer_brief: '', necessary_beliefs: '' });
      loadDocs();
    } catch (err) {
      setGenError(err.message);
    } finally {
      setSavingUpload(false);
    }
  };

  // --- Copy prompt to clipboard ---

  const handleCopyPrompt = async (index, text) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedPrompt(index);
      setTimeout(() => setCopiedPrompt(null), 2000);
    } catch {
      // Fallback: select text in a textarea
      const el = document.createElement('textarea');
      el.value = text;
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
      setCopiedPrompt(index);
      setTimeout(() => setCopiedPrompt(null), 2000);
    }
  };

  // --- Auto generation (existing flow) ---

  const handleGenerate = () => {
    setGenerating(true);
    setGenError('');
    setStreamContent('');
    setCurrentStep(null);
    setCompletedSteps(new Set());
    setDeepResearchProgress(null);

    const { abort, done } = api.generateDocs(projectId, (event) => {
      switch (event.type) {
        case 'step_start':
          setCurrentStep(event);
          setStreamContent('');
          setDeepResearchProgress(null);
          break;
        case 'chunk':
          setStreamContent(prev => prev + event.text);
          break;
        case 'deep_research_progress':
          setDeepResearchProgress(event);
          break;
        case 'step_complete':
          setCompletedSteps(prev => new Set([...prev, event.step]));
          if (event.savedAs) loadDocs();
          break;
        case 'error':
          setGenError(event.message);
          break;
      }
    });

    abortRef.current = abort;

    done.then(() => {
      setGenerating(false);
      setCurrentStep(null);
      setDeepResearchProgress(null);
      setGenerationMode(null);
      loadDocs();
    }).catch(err => {
      if (err.name !== 'AbortError') setGenError(err.message);
      setGenerating(false);
    });
  };

  // --- Manual generation (Steps 5-8 only) ---

  const handleManualGenerate = () => {
    setManualStep(3);
    setGenerating(true);
    setGenError('');
    setStreamContent('');
    setCurrentStep(null);
    setCompletedSteps(new Set([1, 2, 3, 4])); // Steps 1-4 already done manually

    const { abort, done } = api.generateDocsManual(projectId, manualResearchText, (event) => {
      switch (event.type) {
        case 'step_start':
          setCurrentStep(event);
          setStreamContent('');
          break;
        case 'chunk':
          setStreamContent(prev => prev + event.text);
          break;
        case 'step_complete':
          setCompletedSteps(prev => new Set([...prev, event.step]));
          if (event.savedAs) loadDocs();
          break;
        case 'error':
          setGenError(event.message);
          break;
      }
    });

    abortRef.current = abort;

    done.then(() => {
      setGenerating(false);
      setCurrentStep(null);
      setGenerationMode(null);
      setManualStep(1);
      setManualResearchText('');
      loadDocs();
    }).catch(err => {
      if (err.name !== 'AbortError') setGenError(err.message);
      setGenerating(false);
    });
  };

  const handleCancel = () => {
    if (abortRef.current) abortRef.current();
    setGenerating(false);
    setGenerationMode(null);
    setManualStep(1);
  };

  // --- Regeneration ---

  const handleRegenerate = (docType) => {
    setRegenerating(docType);
    setGenError('');
    setStreamContent('');
    setCurrentStep(null);
    setCompletedSteps(new Set());
    setDeepResearchProgress(null);

    const { abort, done } = api.regenerateDoc(projectId, docType, (event) => {
      switch (event.type) {
        case 'step_start':
          setCurrentStep(event);
          setStreamContent('');
          setDeepResearchProgress(null);
          break;
        case 'chunk':
          setStreamContent(prev => prev + event.text);
          break;
        case 'deep_research_progress':
          setDeepResearchProgress(event);
          break;
        case 'step_complete':
          setCompletedSteps(prev => new Set([...prev, event.step]));
          break;
        case 'error':
          setGenError(event.message);
          break;
      }
    });

    abortRef.current = abort;

    done.then(() => {
      setRegenerating(null);
      setCurrentStep(null);
      setDeepResearchProgress(null);
      loadDocs();
    }).catch(err => {
      if (err.name !== 'AbortError') setGenError(err.message);
      setRegenerating(null);
    });
  };

  // --- Editing & Approval ---

  const handleEdit = (doc) => {
    setEditingDoc(doc);
    setEditContent(doc.content);
    setViewDoc(null);
  };

  const handleSaveEdit = async () => {
    setSaving(true);
    try {
      await api.updateDoc(projectId, editingDoc.id, editContent);
      setEditingDoc(null);
      loadDocs();
      toast.success('Document saved');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleApprove = async (doc) => {
    try {
      await api.approveDoc(projectId, doc.id);
      loadDocs();
      toast.success('Document approved');
    } catch (err) {
      toast.error(err.message);
    }
  };

  if (loading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {[0, 1, 2, 3].map(i => (
          <div key={i} className="bg-white rounded-lg shadow-sm border border-gray-200 p-5 animate-pulse">
            <div className="flex items-start justify-between mb-2">
              <div className="h-4 w-32 bg-gray-200 rounded" />
              <div className="h-5 w-16 bg-gray-200 rounded-full" />
            </div>
            <div className="h-3 w-20 bg-gray-100 rounded mb-2" />
            <div className="space-y-1.5">
              <div className="h-2.5 w-full bg-gray-100 rounded" />
              <div className="h-2.5 w-3/4 bg-gray-100 rounded" />
              <div className="h-2.5 w-5/6 bg-gray-100 rounded" />
            </div>
            <div className="flex gap-3 mt-3">
              <div className="h-3 w-8 bg-gray-100 rounded" />
              <div className="h-3 w-16 bg-gray-100 rounded" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  const hasDocs = docs.length > 0;
  const isGenerating = generating || regenerating;

  // ========================
  // RENDER: Choice Screen
  // ========================
  if (generationMode === 'choosing') {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900">
            {hasDocs ? 'Regenerate Foundational Documents' : 'Generate Foundational Documents'}
          </h3>
          <button onClick={handleBackToList} className="text-sm text-gray-500 hover:text-gray-700">
            Cancel
          </button>
        </div>

        <p className="text-sm text-gray-600">
          Choose how you want to conduct the market research for your foundational documents.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {/* Card 1: Upload Existing Documents */}
          <div className="border-2 border-blue-200 rounded-lg p-6 hover:border-blue-400 transition-colors bg-blue-50/30">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-2xl">📤</span>
              <h4 className="font-semibold text-gray-900">Upload Documents</h4>
            </div>

            <p className="text-sm text-gray-600 mb-3">
              Already have your foundational documents? Upload them directly — paste text or drag and drop files.
            </p>

            <div className="space-y-2 mb-4">
              <div className="flex items-center gap-2 text-sm text-blue-700">
                <span>✓</span> Skip all generation steps
              </div>
              <div className="flex items-center gap-2 text-sm text-blue-700">
                <span>✓</span> Free — no API costs
              </div>
              <div className="flex items-center gap-2 text-sm text-gray-500">
                <span>•</span> Drag & drop or paste your docs
              </div>
            </div>

            <button
              onClick={handleChooseUpload}
              className="w-full bg-blue-600 text-white py-2 px-4 rounded-md text-sm font-medium hover:bg-blue-700 transition-colors"
            >
              Upload Existing Docs
            </button>
          </div>

          {/* Card 2: Manual Research (Recommended) */}
          <div className="border-2 border-green-200 rounded-lg p-6 hover:border-green-400 transition-colors bg-green-50/30">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-2xl">📋</span>
              <h4 className="font-semibold text-gray-900">Generate with Prompts</h4>
              <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">Recommended</span>
            </div>

            <p className="text-sm text-gray-600 mb-3">
              We'll show you the exact prompts to use in ChatGPT or Claude. Do the research yourself, then upload it here.
            </p>

            <div className="space-y-2 mb-4">
              <div className="flex items-center gap-2 text-sm text-green-700">
                <span>✓</span> Free — no API cost for research
              </div>
              <div className="flex items-center gap-2 text-sm text-green-700">
                <span>✓</span> Use ChatGPT Deep Research or Claude
              </div>
              <div className="flex items-center gap-2 text-sm text-gray-500">
                <span>•</span> ~$0.50-2 for synthesis steps (GPT-4.1)
              </div>
            </div>

            <button
              onClick={handleChooseManual}
              className="w-full bg-green-600 text-white py-2 px-4 rounded-md text-sm font-medium hover:bg-green-700 transition-colors"
            >
              Start Manual Research
            </button>
          </div>

          {/* Card 3: Automated Deep Research */}
          <div className="border-2 border-purple-200 rounded-lg p-6 hover:border-purple-400 transition-colors">
            <div className="flex items-center gap-2 mb-3">
              <span className="text-2xl">🤖</span>
              <h4 className="font-semibold text-gray-900">Run Deep Research via API</h4>
            </div>

            <p className="text-sm text-gray-600 mb-3">
              The AI will autonomously browse the web, read forums, reviews, and articles to build a comprehensive research document.
            </p>

            <div className="space-y-2 mb-4">
              <div className="flex items-center gap-2 text-sm text-purple-700">
                <span>•</span> Fully automated, hands-off
              </div>
              <div className="flex items-center gap-2 text-sm text-purple-700">
                <span>•</span> Takes 5-15 minutes
              </div>
              <div className="flex items-center gap-2 text-sm text-amber-600 font-medium">
                <span>⚠️</span> Estimated cost: $10-30 per run
              </div>
            </div>

            <button
              onClick={handleChooseAuto}
              className="w-full bg-purple-600 text-white py-2 px-4 rounded-md text-sm font-medium hover:bg-purple-700 transition-colors"
            >
              Start Automated Research
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ========================
  // RENDER: Manual Prompts Walkthrough (manualStep 1)
  // ========================
  if (generationMode === 'manual' && manualStep === 1) {
    if (loadingPrompts) {
      return <div className="text-gray-400 text-center py-8 animate-pulse">Loading research prompts...</div>;
    }

    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">Manual Research Guide</h3>
            <p className="text-sm text-gray-500">Step 1 of 2: Copy these prompts into ChatGPT or Claude</p>
          </div>
          <button onClick={handleBackToChoice} className="text-sm text-gray-500 hover:text-gray-700">
            ← Back
          </button>
        </div>

        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <p className="text-sm text-blue-800">
            <strong>How this works:</strong> Open ChatGPT (GPT-4 recommended) or Claude in a new tab.
            Send these 3 prompts <strong>in sequence, in the same conversation</strong>.
            After prompt 3, the AI will generate a detailed research prompt specific to your product.
            Use that output to run Deep Research (paste it into a ChatGPT Deep Research session),
            then come back here to upload your research.
          </p>
        </div>

        {researchPrompts && researchPrompts.map((p, index) => (
          <div key={p.step} className="border border-gray-200 rounded-lg overflow-hidden">
            <button
              onClick={() => setExpandedPrompt(expandedPrompt === index ? null : index)}
              className="w-full flex items-center justify-between p-4 bg-gray-50 hover:bg-gray-100 transition-colors text-left"
            >
              <div className="flex items-center gap-3">
                <span className="w-7 h-7 bg-blue-100 text-blue-700 rounded-full flex items-center justify-center text-sm font-bold">
                  {p.step}
                </span>
                <div>
                  <h4 className="font-medium text-gray-900">{p.title}</h4>
                  <p className="text-xs text-gray-500">{p.instruction}</p>
                </div>
              </div>
              <span className="text-gray-400 text-lg">
                {expandedPrompt === index ? '▼' : '▶'}
              </span>
            </button>

            {expandedPrompt === index && (
              <div className="p-4 border-t border-gray-200">
                <div className="flex justify-end mb-2">
                  <button
                    onClick={() => handleCopyPrompt(index, p.prompt)}
                    className={`text-xs px-3 py-1 rounded font-medium transition-colors ${
                      copiedPrompt === index
                        ? 'bg-green-100 text-green-700'
                        : 'bg-blue-100 text-blue-700 hover:bg-blue-200'
                    }`}
                  >
                    {copiedPrompt === index ? '✓ Copied!' : 'Copy to Clipboard'}
                  </button>
                </div>
                <pre className="bg-gray-900 text-gray-100 rounded p-4 text-xs overflow-x-auto max-h-96 overflow-y-auto whitespace-pre-wrap">
                  {p.prompt}
                </pre>
              </div>
            )}
          </div>
        ))}

        <div className="flex justify-end">
          <button
            onClick={() => setManualStep(2)}
            className="bg-blue-600 text-white px-6 py-2 rounded-md text-sm font-medium hover:bg-blue-700"
          >
            Next: Upload Your Research →
          </button>
        </div>
      </div>
    );
  }

  // ========================
  // RENDER: Upload/Paste Research (manualStep 2)
  // ========================
  if (generationMode === 'manual' && manualStep === 2) {
    const charCount = manualResearchText.length;
    const isShort = charCount > 0 && charCount < 2000;

    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">Upload Your Research</h3>
            <p className="text-sm text-gray-500">Step 2 of 2: Paste or upload your completed research document</p>
          </div>
          <button onClick={() => setManualStep(1)} className="text-sm text-gray-500 hover:text-gray-700">
            ← Back to Prompts
          </button>
        </div>

        <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
          <p className="text-sm text-gray-700">
            After completing your research using the prompts from the previous step,
            paste the full research document below or upload a file (PDF, TXT, or HTML).
          </p>
        </div>

        {/* Drag-and-drop file upload */}
        <DragDropUpload
          label="Drop your research file here, or click to browse"
          sublabel="PDF, TXT, or HTML — we'll extract the text content"
          compact
          onTextExtracted={(result) => setManualResearchText(result.text)}
        />

        {/* Textarea */}
        <textarea
          value={manualResearchText}
          onChange={e => setManualResearchText(e.target.value)}
          placeholder="Paste your completed research document here..."
          className="w-full h-[500px] border border-gray-300 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
        />

        {/* Short warning */}
        {isShort && (
          <div className="bg-amber-50 border border-amber-200 text-amber-700 text-sm rounded p-3">
            Your research document seems short ({charCount.toLocaleString()} characters).
            The SOP recommends at least 6 pages of content for best results.
            You can still proceed, but the quality of the output documents may be limited.
          </div>
        )}

        {/* Error */}
        {genError && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded p-3">
            {genError}
          </div>
        )}

        <div className="flex justify-between">
          <button
            onClick={() => setManualStep(1)}
            className="border border-gray-300 text-gray-700 px-4 py-2 rounded-md text-sm hover:bg-gray-50"
          >
            ← Back to Prompts
          </button>
          <button
            onClick={handleManualGenerate}
            disabled={!manualResearchText.trim()}
            className="bg-blue-600 text-white px-6 py-2 rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Generate Documents from Research
          </button>
        </div>
      </div>
    );
  }

  // ========================
  // RENDER: Direct Upload Documents
  // ========================
  if (generationMode === 'upload') {
    const filledCount = Object.values(uploadDocs).filter(v => v.trim().length > 0).length;

    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">Upload Existing Documents</h3>
            <p className="text-sm text-gray-500">Paste or drag & drop your foundational documents</p>
          </div>
          <button onClick={handleBackToChoice} className="text-sm text-gray-500 hover:text-gray-700">
            ← Back
          </button>
        </div>

        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <p className="text-sm text-blue-800">
            Upload any or all of the 4 foundational documents. You can paste text directly into each field
            or drag & drop a file. Only documents with content will be saved.
          </p>
        </div>

        {/* Error */}
        {genError && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded p-3">
            {genError}
          </div>
        )}

        {DOC_ORDER.map(docType => (
          <div key={docType} className="border border-gray-200 rounded-lg overflow-hidden">
            <div className="bg-gray-50 px-4 py-3 flex items-center justify-between">
              <h4 className="font-medium text-gray-900">{DOC_LABELS[docType]}</h4>
              {uploadDocs[docType].trim().length > 0 && (
                <span className="text-xs text-green-600">
                  {uploadDocs[docType].length.toLocaleString()} characters
                </span>
              )}
            </div>
            <div className="p-4 space-y-3">
              <DragDropUpload
                compact
                label={`Drop ${DOC_LABELS[docType]} file here, or click to browse`}
                sublabel="PDF, TXT, or HTML"
                onTextExtracted={(result) => {
                  setUploadDocs(prev => ({ ...prev, [docType]: result.text }));
                }}
              />
              <textarea
                value={uploadDocs[docType]}
                onChange={e => setUploadDocs(prev => ({ ...prev, [docType]: e.target.value }))}
                placeholder={`Paste your ${DOC_LABELS[docType]} content here...`}
                className="w-full h-32 border border-gray-300 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
              />
            </div>
          </div>
        ))}

        <div className="flex justify-between items-center">
          <button
            onClick={handleBackToChoice}
            className="border border-gray-300 text-gray-700 px-4 py-2 rounded-md text-sm hover:bg-gray-50"
          >
            ← Back
          </button>
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-500">
              {filledCount} of 4 documents provided
            </span>
            <button
              onClick={handleSaveUploadedDocs}
              disabled={filledCount === 0 || savingUpload}
              className="bg-blue-600 text-white px-6 py-2 rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {savingUpload ? 'Saving...' : 'Save Documents'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ========================
  // RENDER: Generation Progress (both auto & manual)
  // ========================
  if (isGenerating || (generationMode === 'manual' && manualStep === 3)) {
    const isManualMode = generationMode === 'manual';

    return (
      <div className="space-y-6">
        {/* Error display */}
        {genError && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded p-3">
            {genError}
          </div>
        )}

        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-gray-900">
              {regenerating
                ? `Regenerating ${DOC_LABELS[regenerating]}`
                : isManualMode
                  ? 'Generating Documents from Your Research'
                  : 'Generating Foundational Documents'}
            </h3>
            <button onClick={handleCancel} className="text-sm text-red-600 hover:text-red-800">
              Cancel
            </button>
          </div>

          {/* Step progress */}
          {steps.length > 0 && !regenerating && (
            <div className="mb-4 space-y-1">
              {steps.map(step => {
                const isActive = currentStep?.step === step.id;
                const isDone = completedSteps.has(step.id);
                const isDeepResearch = step.mode === 'deep_research';
                const isManualPreStep = isManualMode && step.id <= 4;

                return (
                  <div key={step.id} className="flex items-center gap-2 text-sm">
                    <span className={`w-5 h-5 rounded-full flex items-center justify-center text-xs ${
                      isDone && isManualPreStep ? 'bg-green-100 text-green-700' :
                      isDone ? 'bg-green-100 text-green-700' :
                      isActive && isDeepResearch ? 'bg-purple-100 text-purple-700 animate-pulse' :
                      isActive ? 'bg-blue-100 text-blue-700 animate-pulse' :
                      'bg-gray-100 text-gray-400'
                    }`}>
                      {isDone ? '✓' : isDeepResearch && !isManualMode ? '🔍' : step.id}
                    </span>
                    <span className={
                      isActive && isDeepResearch ? 'text-purple-700 font-medium' :
                      isActive ? 'text-blue-700 font-medium' :
                      isDone ? 'text-green-700' :
                      'text-gray-400'
                    }>
                      {isManualPreStep && isDone
                        ? (step.id <= 3 ? 'Prompts Provided (Manual)' : 'Research Uploaded (Manual)')
                        : step.label}
                      {step.savedAs && !isManualPreStep && (
                        <span className="text-xs ml-1">→ saves {DOC_LABELS[step.savedAs]}</span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Deep research progress panel (auto mode only) */}
          {currentStep?.mode === 'deep_research' && deepResearchProgress && !streamContent && (
            <div className="mb-4 bg-purple-50 border border-purple-200 rounded-lg p-4">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-3 h-3 bg-purple-500 rounded-full animate-pulse" />
                <h4 className="font-medium text-purple-900">Deep Research in Progress</h4>
              </div>

              <p className="text-sm text-purple-700 mb-3">
                The AI is autonomously browsing the web, reading forums, reviews, and articles to build a comprehensive research document.
                This typically takes 5-15 minutes.
              </p>

              <div className="grid grid-cols-3 gap-3 mb-3">
                <div className="bg-white rounded p-2 text-center">
                  <div className="text-lg font-bold text-purple-700">
                    {deepResearchProgress.searchesCompleted || 0}
                  </div>
                  <div className="text-xs text-gray-500">Web Searches</div>
                </div>
                <div className="bg-white rounded p-2 text-center">
                  <div className="text-lg font-bold text-purple-700">
                    {deepResearchProgress.status || 'starting'}
                  </div>
                  <div className="text-xs text-gray-500">Status</div>
                </div>
                <div className="bg-white rounded p-2 text-center">
                  <div className="text-lg font-bold text-purple-700">
                    {formatElapsed(deepResearchProgress.elapsedMs)}
                  </div>
                  <div className="text-xs text-gray-500">Elapsed</div>
                </div>
              </div>

              <p className="text-xs text-purple-600">
                {deepResearchProgress.message}
              </p>
            </div>
          )}

          {/* Live stream content */}
          {currentStep && streamContent && (
            <div>
              <p className="text-xs text-gray-500 mb-2">
                Step {currentStep.step}: {currentStep.label}
                {currentStep.mode === 'deep_research' && ' — Research Complete'}
              </p>
              <div
                ref={streamRef}
                className="bg-gray-50 border border-gray-200 rounded p-3 max-h-96 overflow-y-auto font-mono text-xs text-gray-700 whitespace-pre-wrap"
              >
                {streamContent || 'Waiting for response...'}
              </div>
            </div>
          )}

          {/* Waiting state */}
          {currentStep && !streamContent && !deepResearchProgress && (
            <div>
              <p className="text-xs text-gray-500 mb-2">
                Step {currentStep.step}: {currentStep.label}
              </p>
              <div className="bg-gray-50 border border-gray-200 rounded p-3 text-sm text-gray-500 animate-pulse">
                Waiting for response...
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ========================
  // RENDER: Main View (doc list, edit, view)
  // ========================
  return (
    <div className="space-y-6">
      {/* Explanation + Generation controls */}
      {!editingDoc && !viewDoc && (
        <>
          <div className="p-4 bg-gray-50/80 border border-gray-200/60 rounded-xl">
            <p className="text-[13px] text-gray-600 leading-relaxed">
              Foundational documents are the backbone of effective ad generation. The system creates four core documents — a <strong>Research Document</strong>, <strong>Customer Avatar</strong>, <strong>Offer Brief</strong>, and <strong>Necessary Beliefs</strong> — that capture everything about your market, ideal customer, and product positioning. These documents give the AI the context it needs to write compelling, on-brand ad copy every time.
            </p>
          </div>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <p className="text-sm text-gray-500">
                {hasDocs
                  ? `${docs.length} of 4 documents generated`
                  : 'No documents generated yet. Start the generation process.'}
              </p>
              <InfoTooltip text="Core research documents that guide ad generation: research, avatar, offer brief, and necessary beliefs." position="right" />
            </div>
            <button
              onClick={handleGenerateClick}
              className="bg-blue-600 text-white px-4 py-2 rounded-md text-sm font-medium hover:bg-blue-700"
            >
              {hasDocs ? 'Regenerate All Docs' : 'Generate Foundational Docs'}
            </button>
          </div>
        </>
      )}

      {/* Error display */}
      {genError && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded p-3">
          {genError}
        </div>
      )}

      {/* Editing mode */}
      {editingDoc && (
        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-gray-900">
              Editing: {DOC_LABELS[editingDoc.doc_type]}
            </h3>
            <div className="flex gap-2">
              <button
                onClick={handleSaveEdit}
                disabled={saving}
                className="bg-blue-600 text-white px-3 py-1.5 rounded text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
              <button
                onClick={() => setEditingDoc(null)}
                className="border border-gray-300 text-gray-700 px-3 py-1.5 rounded text-sm hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
          </div>
          <textarea
            value={editContent}
            onChange={e => setEditContent(e.target.value)}
            className="w-full h-[600px] border border-gray-300 rounded-md px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      )}

      {/* View mode */}
      {viewDoc && !editingDoc && (() => {
        const viewSourceInfo = SOURCE_LABELS[viewDoc.source] || SOURCE_LABELS.generated;
        const viewLastUpdated = viewDoc.updated_at || viewDoc.created_at;
        return (
          <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6">
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                <h3 className="font-semibold text-gray-900">
                  {DOC_LABELS[viewDoc.doc_type]}
                </h3>
                <span className={`text-xs px-2 py-0.5 rounded-full ${viewSourceInfo.color}`}>
                  {viewSourceInfo.label}
                </span>
                <span className="text-xs text-gray-400">v{viewDoc.version}</span>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => handleEdit(viewDoc)}
                  className="border border-gray-300 text-gray-700 px-3 py-1.5 rounded text-sm hover:bg-gray-50"
                >
                  Edit
                </button>
                <button
                  onClick={() => handleRegenerate(viewDoc.doc_type)}
                  className={`border px-3 py-1.5 rounded text-sm ${
                    viewDoc.doc_type === 'research'
                      ? 'border-purple-300 text-purple-600 hover:bg-purple-50'
                      : 'border-blue-300 text-blue-600 hover:bg-blue-50'
                  }`}
                >
                  {viewDoc.doc_type === 'research' ? 'Re-run Deep Research' : 'Regenerate'}
                </button>
                <button
                  onClick={() => setViewDoc(null)}
                  className="border border-gray-300 text-gray-700 px-3 py-1.5 rounded text-sm hover:bg-gray-50"
                >
                  Close
                </button>
              </div>
            </div>
            <div className="flex items-center gap-3 mb-4 text-xs text-gray-400">
              <span title={viewLastUpdated ? new Date(viewLastUpdated + 'Z').toLocaleString() : ''}>
                Last updated: {viewLastUpdated ? new Date(viewLastUpdated + 'Z').toLocaleString() : 'Unknown'}
              </span>
              {viewDoc.content && (
                <span>{viewDoc.content.length.toLocaleString()} characters</span>
              )}
            </div>
            <div className="prose prose-sm max-w-none overflow-y-auto max-h-[600px] whitespace-pre-wrap text-sm text-gray-700">
              {viewDoc.content}
            </div>
          </div>
        );
      })()}

      {/* Document cards */}
      {!editingDoc && !viewDoc && hasDocs && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {DOC_ORDER.map(docType => {
            const doc = docs.find(d => d.doc_type === docType);
            const isResearch = docType === 'research';
            if (!doc) {
              return (
                <div key={docType} className="bg-white rounded-lg shadow-sm border border-dashed border-gray-300 p-5">
                  <h3 className="font-medium text-gray-400">{DOC_LABELS[docType]}</h3>
                  <p className="text-xs text-gray-400 mt-1">Not yet generated</p>
                </div>
              );
            }

            // Check if research was done via API (has ## Sources section) or manually
            const isDeepResearch = isResearch && doc.content?.includes('## Sources');

            // Determine source info for display
            const sourceInfo = SOURCE_LABELS[doc.source] || SOURCE_LABELS.generated;
            const lastUpdated = doc.updated_at || doc.created_at;

            return (
              <div
                key={docType}
                className={`bg-white rounded-lg shadow-sm border p-5 hover:shadow-md transition-shadow cursor-pointer ${
                  isResearch ? 'border-purple-200' : 'border-gray-200'
                }`}
                onClick={() => setViewDoc(doc)}
              >
                <div className="flex items-start justify-between mb-2">
                  <div className="flex items-center gap-2">
                    {isResearch && <span className="text-sm">🔍</span>}
                    <h3 className="font-medium text-gray-900">{DOC_LABELS[docType]}</h3>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap justify-end">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${sourceInfo.color}`}>
                      {sourceInfo.label}
                    </span>
                    {doc.approved ? (
                      <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full">Approved</span>
                    ) : (
                      <button
                        onClick={(e) => { e.stopPropagation(); handleApprove(doc); }}
                        className="text-xs bg-yellow-50 text-yellow-700 px-2 py-0.5 rounded-full hover:bg-yellow-100"
                      >
                        Approve
                      </button>
                    )}
                    <span className="text-xs text-gray-400">v{doc.version}</span>
                  </div>
                </div>

                {/* Timestamp row */}
                <div className="flex items-center gap-3 mb-2 text-xs text-gray-400">
                  <span title={lastUpdated ? new Date(lastUpdated + 'Z').toLocaleString() : ''}>
                    Updated {formatDate(lastUpdated)}
                  </span>
                  {doc.content && (
                    <span>{doc.content.length.toLocaleString()} chars</span>
                  )}
                </div>

                <p className="text-xs text-gray-500 line-clamp-3">
                  {doc.content?.slice(0, 200)}...
                </p>
                <div className="flex gap-2 mt-3">
                  <button
                    onClick={(e) => { e.stopPropagation(); handleEdit(doc); }}
                    className="text-xs text-blue-600 hover:underline"
                  >
                    Edit
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleRegenerate(docType); }}
                    className={`text-xs hover:underline ${isResearch ? 'text-purple-600' : 'text-blue-600'}`}
                  >
                    {isResearch ? 'Re-run Deep Research' : 'Regenerate'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../api';
import { useToast } from './Toast';

// ─── Multi-input chip component (keywords, subreddits, forums) ──────────────
function MultiInput({ items, onAdd, onRemove, placeholder, prefix = '' }) {
  const [input, setInput] = useState('');

  const handleKeyDown = (e) => {
    if ((e.key === 'Enter' || e.key === ',') && input.trim()) {
      e.preventDefault();
      onAdd(input.trim().replace(/^,|,$/g, ''));
      setInput('');
    }
    if (e.key === 'Backspace' && !input && items.length > 0) {
      onRemove(items.length - 1);
    }
  };

  return (
    <div className="flex flex-wrap gap-1.5 p-2 border border-gray-200/80 rounded-xl bg-white/80 backdrop-blur focus-within:ring-2 focus-within:ring-blue-500/30 focus-within:border-blue-300 transition-all min-h-[38px]">
      {items.map((item, i) => (
        <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 bg-blue-50 text-blue-700 rounded-lg text-[12px] font-medium">
          {prefix}{item}
          <button onClick={() => onRemove(i)} className="text-blue-400 hover:text-blue-600 ml-0.5">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </span>
      ))}
      <input
        value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={items.length === 0 ? placeholder : 'Type + Enter...'}
        className="flex-1 min-w-[120px] outline-none text-[13px] bg-transparent"
      />
    </div>
  );
}

// ─── Emotion badge colors ────────────────────────────────────────────────────
const EMOTION_COLORS = {
  frustration: 'bg-orange-100 text-orange-700',
  desperation: 'bg-red-100 text-red-700',
  anger: 'bg-red-100 text-red-700',
  fear: 'bg-purple-100 text-purple-700',
  hope: 'bg-green-100 text-green-700',
  relief: 'bg-emerald-100 text-emerald-700',
  shame: 'bg-pink-100 text-pink-700',
  confusion: 'bg-yellow-100 text-yellow-700',
};

// ─── Format duration ─────────────────────────────────────────────────────────
function formatDuration(ms) {
  if (!ms) return '';
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  return `${mins}m ${remSecs}s`;
}

function formatTimeAgo(dateStr) {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ─── Main component ──────────────────────────────────────────────────────────
export default function QuoteMiner({ projectId, project }) {
  const toast = useToast();

  // Config form state
  const [config, setConfig] = useState({
    target_demographic: '',
    problem: '',
    root_cause: '',
    num_quotes: 20,
  });
  const [keywords, setKeywords] = useState([]);
  const [subreddits, setSubreddits] = useState([]);
  const [forums, setForums] = useState([]);

  // Mining state
  const [mining, setMining] = useState(false);
  const [progress, setProgress] = useState([]);
  const [currentRunId, setCurrentRunId] = useState(null);
  const abortRef = useRef(null);

  // Results state
  const [currentQuotes, setCurrentQuotes] = useState(null);
  const [currentRunMeta, setCurrentRunMeta] = useState(null);

  // History state
  const [runs, setRuns] = useState([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [viewingRunId, setViewingRunId] = useState(null);

  // Progress ref for auto-scroll
  const progressEndRef = useRef(null);

  // Load history on mount
  useEffect(() => {
    loadHistory();
  }, [projectId]);

  const loadHistory = async () => {
    try {
      const data = await api.getQuoteMiningRuns(projectId);
      setRuns(data.runs || []);
    } catch (err) {
      console.error('Failed to load quote mining history:', err);
    } finally {
      setLoadingHistory(false);
    }
  };

  // Auto-scroll progress
  useEffect(() => {
    if (progressEndRef.current && mining) {
      progressEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [progress, mining]);

  // ─── Start mining ──────────────────────────────────────────────────────────
  const handleStartMining = () => {
    if (!config.target_demographic.trim() || !config.problem.trim() || keywords.length === 0) {
      toast.error('Please fill in target demographic, problem, and at least one keyword');
      return;
    }

    setMining(true);
    setProgress([]);
    setCurrentQuotes(null);
    setCurrentRunMeta(null);
    setViewingRunId(null);

    const { abort, done } = api.startQuoteMining(projectId, {
      target_demographic: config.target_demographic.trim(),
      problem: config.problem.trim(),
      root_cause: config.root_cause.trim() || undefined,
      keywords,
      subreddits: subreddits.length > 0 ? subreddits : undefined,
      forums: forums.length > 0 ? forums : undefined,
      num_quotes: config.num_quotes,
    }, (event) => {
      if (event.type === 'run_created') {
        setCurrentRunId(event.runId);
      }
      setProgress(prev => [...prev, event]);
    });

    abortRef.current = abort;

    done.then(() => {
      setMining(false);
      abortRef.current = null;
      // Load the completed run
      loadHistory();
      // Load the run results
      if (currentRunId) {
        loadRunResults(currentRunId);
      }
    }).catch(() => {
      setMining(false);
      abortRef.current = null;
    });
  };

  // Handle loading results from current run ID when it changes
  useEffect(() => {
    if (!mining && currentRunId) {
      loadRunResults(currentRunId);
    }
  }, [mining, currentRunId]);

  const handleCancel = () => {
    if (abortRef.current) {
      abortRef.current();
      setMining(false);
      toast.info('Mining cancelled');
    }
  };

  // ─── Load run results ──────────────────────────────────────────────────────
  const loadRunResults = async (runId) => {
    try {
      const run = await api.getQuoteMiningRun(projectId, runId);
      if (run && run.quotes) {
        const quotes = typeof run.quotes === 'string' ? JSON.parse(run.quotes) : run.quotes;
        setCurrentQuotes(quotes);
        setCurrentRunMeta(run);
        setViewingRunId(runId);
      }
    } catch (err) {
      console.error('Failed to load run results:', err);
    }
  };

  // ─── Copy helpers ──────────────────────────────────────────────────────────
  const copyQuote = (quote) => {
    navigator.clipboard.writeText(`"${quote.quote}"`);
    toast.success('Quote copied');
  };

  const copyAllQuotes = () => {
    if (!currentQuotes) return;
    const text = currentQuotes.map((q, i) => `${i + 1}. "${q.quote}"`).join('\n\n');
    navigator.clipboard.writeText(text);
    toast.success(`${currentQuotes.length} quotes copied`);
  };

  const exportAsText = () => {
    if (!currentQuotes) return;
    const lines = [
      `Quote Mining Results — ${currentRunMeta?.target_demographic || 'Unknown'} × ${currentRunMeta?.problem || 'Unknown'}`,
      `Generated: ${new Date().toLocaleString()}`,
      `Total quotes: ${currentQuotes.length}`,
      '',
      '═══════════════════════════════════════════',
      '',
    ];
    currentQuotes.forEach((q, i) => {
      lines.push(`${i + 1}. "${q.quote}"`);
      lines.push(`   Emotion: ${q.emotion || 'N/A'} | Intensity: ${q.emotional_intensity || 'N/A'}`);
      lines.push(`   Source: ${q.source || 'N/A'}${q.source_url ? ` (${q.source_url})` : ''}`);
      if (q.context) lines.push(`   Context: ${q.context}`);
      lines.push('');
    });

    const blob = new Blob([lines.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `quotes-${config.target_demographic.replace(/\s+/g, '-').toLowerCase()}-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('Exported as text file');
  };

  // ─── Delete run ────────────────────────────────────────────────────────────
  const handleDeleteRun = async (runId) => {
    if (!confirm('Delete this mining run?')) return;
    try {
      await api.deleteQuoteMiningRun(projectId, runId);
      setRuns(prev => prev.filter(r => r.id !== runId));
      if (viewingRunId === runId) {
        setCurrentQuotes(null);
        setCurrentRunMeta(null);
        setViewingRunId(null);
      }
      toast.success('Run deleted');
    } catch (err) {
      toast.error('Failed to delete: ' + err.message);
    }
  };

  // ─── Engine status helpers ─────────────────────────────────────────────────
  const getEngineStatus = (engine) => {
    const events = progress.filter(e => e.engine === engine);
    const started = events.find(e => e.type === 'engine_start');
    const completed = events.find(e => e.type === 'engine_complete');
    const error = events.find(e => e.type === 'engine_error');
    if (error) return 'error';
    if (completed) return 'complete';
    if (started) return 'running';
    return 'pending';
  };

  const getMergeStatus = () => {
    const started = progress.find(e => e.type === 'merge_start');
    const completed = progress.find(e => e.type === 'merge_complete');
    if (completed) return 'complete';
    if (started) return 'running';
    return 'pending';
  };

  // ─── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6 fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 tracking-tight flex items-center gap-2">
            <svg className="w-5 h-5 text-purple-500" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
            </svg>
            Quote Miner
          </h2>
          <p className="text-[12px] text-gray-500 mt-0.5">
            Find authentic, emotional first-person quotes from Reddit, forums, and online communities.
          </p>
        </div>
        {runs.length > 0 && (
          <button
            onClick={() => setHistoryOpen(prev => !prev)}
            className="btn-secondary text-[12px] flex items-center gap-1.5"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            History ({runs.length})
          </button>
        )}
      </div>

      {/* History panel */}
      {historyOpen && (
        <div className="card p-4 space-y-2">
          <h3 className="text-[13px] font-semibold text-gray-700 mb-2">Past Runs</h3>
          {runs.length === 0 ? (
            <p className="text-[12px] text-gray-400">No mining runs yet.</p>
          ) : (
            <div className="space-y-1.5 max-h-[300px] overflow-y-auto">
              {runs.map(run => (
                <div
                  key={run.id}
                  className={`flex items-center justify-between p-2.5 rounded-lg border transition-all cursor-pointer hover:bg-gray-50 ${
                    viewingRunId === run.id ? 'border-purple-300 bg-purple-50/50' : 'border-gray-100'
                  }`}
                  onClick={() => loadRunResults(run.id)}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[12px] font-medium text-gray-800 truncate">
                        {run.target_demographic} × {run.problem}
                      </span>
                      <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
                        run.status === 'completed' ? 'bg-green-100 text-green-700' :
                        run.status === 'failed' ? 'bg-red-100 text-red-700' :
                        'bg-yellow-100 text-yellow-700'
                      }`}>
                        {run.status}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-[10px] text-gray-400 mt-0.5">
                      <span>{formatTimeAgo(run.created_at)}</span>
                      {run.quote_count > 0 && <span>{run.quote_count} quotes</span>}
                      {run.duration_ms && <span>{formatDuration(run.duration_ms)}</span>}
                    </div>
                  </div>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDeleteRun(run.id); }}
                    className="text-gray-300 hover:text-red-500 transition-colors ml-2 p-1"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Configuration form */}
      {!mining && !currentQuotes && (
        <div className="card p-6 space-y-5">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-[13px] font-medium text-gray-600 mb-1.5">
                Target Demographic <span className="text-red-400">*</span>
              </label>
              <input
                value={config.target_demographic}
                onChange={e => setConfig(p => ({ ...p, target_demographic: e.target.value }))}
                className="input-apple"
                placeholder="e.g., men aged 40+ with chronic pain"
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-600 mb-1.5">
                Problem <span className="text-red-400">*</span>
              </label>
              <input
                value={config.problem}
                onChange={e => setConfig(p => ({ ...p, problem: e.target.value }))}
                className="input-apple"
                placeholder="e.g., foot pain, arthritis, neuropathy"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-[13px] font-medium text-gray-600 mb-1.5">
                Root Cause <span className="text-[11px] text-gray-400 font-normal">(optional)</span>
              </label>
              <input
                value={config.root_cause}
                onChange={e => setConfig(p => ({ ...p, root_cause: e.target.value }))}
                className="input-apple"
                placeholder="e.g., overtraining, sedentary lifestyle"
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-600 mb-1.5">
                Number of Quotes
              </label>
              <input
                type="number"
                min={5}
                max={50}
                value={config.num_quotes}
                onChange={e => setConfig(p => ({ ...p, num_quotes: parseInt(e.target.value) || 20 }))}
                className="input-apple"
              />
            </div>
          </div>

          <div>
            <label className="block text-[13px] font-medium text-gray-600 mb-1.5">
              Search Keywords <span className="text-red-400">*</span>
              <span className="text-[11px] text-gray-400 font-normal ml-1">Type and press Enter</span>
            </label>
            <MultiInput
              items={keywords}
              onAdd={(item) => setKeywords(prev => [...prev, item])}
              onRemove={(idx) => setKeywords(prev => prev.filter((_, i) => i !== idx))}
              placeholder='e.g., "chronic foot pain", "plantar fasciitis"'
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-[13px] font-medium text-gray-600 mb-1.5">
                Subreddits <span className="text-[11px] text-gray-400 font-normal">(optional)</span>
              </label>
              <MultiInput
                items={subreddits}
                onAdd={(item) => setSubreddits(prev => [...prev, item.replace(/^r\//, '')])}
                onRemove={(idx) => setSubreddits(prev => prev.filter((_, i) => i !== idx))}
                placeholder="e.g., health, ChronicPain, Fitness"
                prefix="r/"
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-600 mb-1.5">
                Other Forums <span className="text-[11px] text-gray-400 font-normal">(optional)</span>
              </label>
              <MultiInput
                items={forums}
                onAdd={(item) => setForums(prev => [...prev, item])}
                onRemove={(idx) => setForums(prev => prev.filter((_, i) => i !== idx))}
                placeholder="e.g., healthunlocked.com, patient.info"
              />
            </div>
          </div>

          <div className="flex items-center gap-3 pt-2">
            <button
              onClick={handleStartMining}
              disabled={!config.target_demographic.trim() || !config.problem.trim() || keywords.length === 0}
              className="btn-primary flex items-center gap-2 disabled:opacity-50"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
              </svg>
              Mine Quotes
            </button>
            <p className="text-[11px] text-gray-400">
              Searches with Perplexity + Claude, merges with GPT-4.1. Takes 1-3 minutes.
            </p>
          </div>
        </div>
      )}

      {/* Progress panel */}
      {mining && (
        <div className="card p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-[14px] font-semibold text-gray-800">Mining in Progress...</h3>
            <button onClick={handleCancel} className="text-[12px] text-red-500 hover:text-red-700 font-medium">
              Cancel
            </button>
          </div>

          {/* Engine status indicators */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {/* Perplexity */}
            <div className={`p-3 rounded-xl border transition-all ${
              getEngineStatus('perplexity') === 'complete' ? 'border-green-200 bg-green-50/50' :
              getEngineStatus('perplexity') === 'error' ? 'border-red-200 bg-red-50/50' :
              getEngineStatus('perplexity') === 'running' ? 'border-blue-200 bg-blue-50/50' :
              'border-gray-100 bg-gray-50/50'
            }`}>
              <div className="flex items-center gap-2">
                {getEngineStatus('perplexity') === 'running' && (
                  <svg className="w-3.5 h-3.5 animate-spin text-blue-500" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4 31.4" strokeLinecap="round" />
                  </svg>
                )}
                {getEngineStatus('perplexity') === 'complete' && (
                  <svg className="w-3.5 h-3.5 text-green-500" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                )}
                {getEngineStatus('perplexity') === 'error' && (
                  <svg className="w-3.5 h-3.5 text-red-500" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                  </svg>
                )}
                <span className="text-[12px] font-semibold text-gray-700">Perplexity Sonar</span>
              </div>
              <p className="text-[10px] text-gray-500 mt-1">
                {getEngineStatus('perplexity') === 'pending' && 'Waiting...'}
                {getEngineStatus('perplexity') === 'running' && 'Searching Reddit, forums...'}
                {getEngineStatus('perplexity') === 'complete' && 'Done'}
                {getEngineStatus('perplexity') === 'error' && 'Failed (will use other engine)'}
              </p>
            </div>

            {/* Claude */}
            <div className={`p-3 rounded-xl border transition-all ${
              getEngineStatus('claude') === 'complete' ? 'border-green-200 bg-green-50/50' :
              getEngineStatus('claude') === 'error' ? 'border-red-200 bg-red-50/50' :
              getEngineStatus('claude') === 'running' ? 'border-blue-200 bg-blue-50/50' :
              'border-gray-100 bg-gray-50/50'
            }`}>
              <div className="flex items-center gap-2">
                {getEngineStatus('claude') === 'running' && (
                  <svg className="w-3.5 h-3.5 animate-spin text-blue-500" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4 31.4" strokeLinecap="round" />
                  </svg>
                )}
                {getEngineStatus('claude') === 'complete' && (
                  <svg className="w-3.5 h-3.5 text-green-500" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                )}
                {getEngineStatus('claude') === 'error' && (
                  <svg className="w-3.5 h-3.5 text-red-500" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
                  </svg>
                )}
                <span className="text-[12px] font-semibold text-gray-700">Claude Web Search</span>
              </div>
              <p className="text-[10px] text-gray-500 mt-1">
                {getEngineStatus('claude') === 'pending' && 'Waiting...'}
                {getEngineStatus('claude') === 'running' && 'Browsing with domain filtering...'}
                {getEngineStatus('claude') === 'complete' && 'Done'}
                {getEngineStatus('claude') === 'error' && 'Failed (will use other engine)'}
              </p>
            </div>

            {/* Merge */}
            <div className={`p-3 rounded-xl border transition-all ${
              getMergeStatus() === 'complete' ? 'border-green-200 bg-green-50/50' :
              getMergeStatus() === 'running' ? 'border-blue-200 bg-blue-50/50' :
              'border-gray-100 bg-gray-50/50'
            }`}>
              <div className="flex items-center gap-2">
                {getMergeStatus() === 'running' && (
                  <svg className="w-3.5 h-3.5 animate-spin text-blue-500" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4 31.4" strokeLinecap="round" />
                  </svg>
                )}
                {getMergeStatus() === 'complete' && (
                  <svg className="w-3.5 h-3.5 text-green-500" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                  </svg>
                )}
                <span className="text-[12px] font-semibold text-gray-700">GPT-4.1 Merge</span>
              </div>
              <p className="text-[10px] text-gray-500 mt-1">
                {getMergeStatus() === 'pending' && 'Waiting for search engines...'}
                {getMergeStatus() === 'running' && 'Deduplicating & ranking...'}
                {getMergeStatus() === 'complete' && 'Done'}
              </p>
            </div>
          </div>

          {/* Progress log */}
          <div className="bg-gray-50 rounded-xl p-3 max-h-[200px] overflow-y-auto text-[11px] font-mono text-gray-500 space-y-1">
            {progress.map((event, i) => (
              <div key={i} className={`${
                event.type === 'error' || event.type === 'engine_error' ? 'text-red-500' :
                event.type === 'complete' || event.type === 'saved' ? 'text-green-600' :
                ''
              }`}>
                {event.message || JSON.stringify(event)}
              </div>
            ))}
            <div ref={progressEndRef} />
          </div>
        </div>
      )}

      {/* Results display */}
      {currentQuotes && (
        <div className="space-y-4">
          {/* Results header */}
          <div className="card p-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-[14px] font-semibold text-gray-800 flex items-center gap-2">
                  <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-purple-100 text-purple-700 text-[11px] font-bold">
                    {currentQuotes.length}
                  </span>
                  Quotes Found
                  {currentRunMeta?.duration_ms && (
                    <span className="text-[11px] font-normal text-gray-400">
                      in {formatDuration(currentRunMeta.duration_ms)}
                    </span>
                  )}
                </h3>
                {currentRunMeta && (
                  <p className="text-[11px] text-gray-400 mt-0.5">
                    {currentRunMeta.target_demographic} × {currentRunMeta.problem}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button onClick={copyAllQuotes} className="btn-secondary text-[11px] flex items-center gap-1">
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25H10.5a2.25 2.25 0 00-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
                  </svg>
                  Copy All
                </button>
                <button onClick={exportAsText} className="btn-secondary text-[11px] flex items-center gap-1">
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3" />
                  </svg>
                  Export
                </button>
                <button
                  onClick={() => { setCurrentQuotes(null); setCurrentRunMeta(null); setViewingRunId(null); }}
                  className="btn-secondary text-[11px]"
                >
                  New Search
                </button>
              </div>
            </div>
          </div>

          {/* Quote list */}
          <div className="space-y-3">
            {currentQuotes.map((quote, index) => (
              <div key={index} className="card p-4 hover:shadow-md transition-shadow">
                <div className="flex items-start gap-3">
                  {/* Number */}
                  <div className="flex-shrink-0 w-7 h-7 rounded-full bg-gray-100 flex items-center justify-center text-[11px] font-bold text-gray-500">
                    {index + 1}
                  </div>

                  {/* Quote content */}
                  <div className="flex-1 min-w-0">
                    <blockquote className="text-[14px] text-gray-800 leading-relaxed italic">
                      &ldquo;{quote.quote}&rdquo;
                    </blockquote>

                    <div className="flex items-center flex-wrap gap-2 mt-2.5">
                      {/* Emotion badge */}
                      {quote.emotion && (
                        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${EMOTION_COLORS[quote.emotion] || 'bg-gray-100 text-gray-600'}`}>
                          {quote.emotion}
                        </span>
                      )}

                      {/* Intensity */}
                      {quote.emotional_intensity && (
                        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
                          quote.emotional_intensity === 'high' ? 'bg-red-50 text-red-600' : 'bg-gray-50 text-gray-500'
                        }`}>
                          {quote.emotional_intensity === 'high' ? '🔥 High' : '○ Medium'}
                        </span>
                      )}

                      {/* Source */}
                      {quote.source && (
                        <span className="text-[10px] text-gray-400">
                          {quote.source_url ? (
                            <a href={quote.source_url} target="_blank" rel="noopener noreferrer" className="hover:text-blue-500 hover:underline">
                              {quote.source}
                            </a>
                          ) : quote.source}
                        </span>
                      )}

                      {/* Copy button */}
                      <button
                        onClick={() => copyQuote(quote)}
                        className="text-gray-300 hover:text-gray-600 transition-colors ml-auto"
                        title="Copy quote"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25H10.5a2.25 2.25 0 00-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9.75a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
                        </svg>
                      </button>
                    </div>

                    {/* Context */}
                    {quote.context && (
                      <p className="text-[11px] text-gray-400 mt-1.5">{quote.context}</p>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Empty state — no results, not mining, no form */}
      {!mining && !currentQuotes && runs.length === 0 && (
        <div className="text-center py-8 text-gray-400">
          <svg className="w-12 h-12 mx-auto mb-3 text-gray-200" fill="none" viewBox="0 0 24 24" strokeWidth={1} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
          </svg>
          <p className="text-[13px]">Configure your search parameters above to start mining quotes.</p>
          <p className="text-[11px] mt-1">Make sure you have Perplexity and Anthropic API keys set in Settings.</p>
        </div>
      )}
    </div>
  );
}

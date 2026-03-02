import { useState, useEffect, useRef } from 'react';
import { api } from '../api';
import { useToast } from './Toast';

const STATUS_BADGE = {
  extracting: { label: 'Extracting', bg: 'bg-gold/10', text: 'text-gold' },
  ready: { label: 'Ready', bg: 'bg-teal/15', text: 'text-teal' },
  failed: { label: 'Failed', bg: 'bg-red-50', text: 'text-red-500' },
};

const NARRATIVE_FRAMES = [
  { id: 'testimonial', name: 'Testimonial Journey' },
  { id: 'mechanism', name: 'Mechanism Deep-Dive' },
  { id: 'problem_agitation', name: 'Problem Agitation' },
  { id: 'myth_busting', name: 'Myth Busting' },
  { id: 'listicle', name: 'Listicle' },
];

export default function LPTemplateManager({ projectId }) {
  const toast = useToast();
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [extractUrl, setExtractUrl] = useState('');
  const [extracting, setExtracting] = useState(false);
  const [extractProgress, setExtractProgress] = useState('');
  const abortRef = useRef(null);

  // Test LP generation state
  const [testForm, setTestForm] = useState({ template_id: '', narrative_frame: 'testimonial', angle: '' });
  const [generating, setGenerating] = useState(false);
  const [genPhase, setGenPhase] = useState('');
  const genAbortRef = useRef(null);

  useEffect(() => {
    loadTemplates();
  }, [projectId]);

  const loadTemplates = async () => {
    try {
      const data = await api.getLPTemplates(projectId);
      setTemplates(data.templates || []);
    } catch (err) {
      console.error('Failed to load templates:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleExtract = () => {
    if (!extractUrl.trim()) {
      toast.error('Please enter a URL');
      return;
    }

    setExtracting(true);
    setExtractProgress('Starting extraction...');

    const { abort, done } = api.extractLPTemplate(projectId, extractUrl.trim(), (event) => {
      if (event.type === 'progress') {
        setExtractProgress(event.message || '');
      } else if (event.type === 'completed') {
        setExtracting(false);
        setExtractProgress('');
        setExtractUrl('');
        toast.success('Template extracted successfully');
        loadTemplates();
      } else if (event.type === 'error') {
        setExtracting(false);
        setExtractProgress('');
        toast.error(event.message || 'Extraction failed');
        loadTemplates(); // Reload to show failed state
      }
    });

    abortRef.current = abort;

    done.catch((err) => {
      if (err.name !== 'AbortError') {
        setExtracting(false);
        setExtractProgress('');
        toast.error(err.message || 'Extraction failed');
      }
    });
  };

  const handleDelete = async (templateId, name) => {
    if (!confirm(`Delete template "${name}"?`)) return;
    try {
      await api.deleteLPTemplate(projectId, templateId);
      toast.success('Template deleted');
      setTemplates(prev => prev.filter(t => t.id !== templateId));
    } catch (err) {
      toast.error(err.message || 'Failed to delete');
    }
  };

  const handleGenerateTest = () => {
    if (!testForm.template_id || !testForm.angle.trim()) {
      toast.error('Select a template and enter an angle');
      return;
    }

    setGenerating(true);
    setGenPhase('Starting generation...');

    const { abort, done } = api.generateTestLP(projectId, {
      template_id: testForm.template_id,
      narrative_frame: testForm.narrative_frame,
      angle_description: testForm.angle.trim(),
    }, (event) => {
      if (event.type === 'phase' || event.type === 'progress') {
        setGenPhase(event.message || event.phase || '');
      } else if (event.type === 'complete') {
        setGenerating(false);
        setGenPhase('');
        const msg = event.published_url
          ? `LP generated and published!`
          : 'LP generated! Open it in the Landing Pages tab to publish.';
        toast.success(msg);
      } else if (event.type === 'error') {
        setGenerating(false);
        setGenPhase('');
        toast.error(event.message || 'Generation failed');
      }
    });

    genAbortRef.current = abort;

    done.catch((err) => {
      if (err.name !== 'AbortError') {
        setGenerating(false);
        setGenPhase('');
        toast.error(err.message || 'Generation failed');
      }
    });
  };

  const readyTemplates = templates.filter(t => t.status === 'ready');

  return (
    <div>
      {/* Extract new template */}
      <div className="card p-4 mb-4">
        <label className="block text-[12px] font-medium text-textdark mb-1.5">
          Extract Template from URL
        </label>
        <div className="flex gap-2">
          <input
            type="url"
            value={extractUrl}
            onChange={(e) => setExtractUrl(e.target.value)}
            className="input-apple flex-1 text-[12px]"
            placeholder="https://example.com/landing-page"
            disabled={extracting}
            onKeyDown={(e) => e.key === 'Enter' && !extracting && handleExtract()}
          />
          <button
            onClick={handleExtract}
            disabled={extracting || !extractUrl.trim()}
            className="btn-primary text-[12px] whitespace-nowrap disabled:opacity-50"
          >
            {extracting ? 'Extracting...' : 'Extract'}
          </button>
        </div>
        {extracting && extractProgress && (
          <div className="mt-2 flex items-center gap-2">
            <svg className="w-3.5 h-3.5 text-navy animate-spin flex-shrink-0" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4 31.4" strokeLinecap="round" />
            </svg>
            <span className="text-[11px] text-textmid">{extractProgress}</span>
          </div>
        )}
        <p className="text-[10px] text-textlight mt-1.5">
          Paste a landing page URL to extract its design into a reusable template. Uses AI vision to analyze layout, colors, and structure.
        </p>
      </div>

      {/* Generate Test LP */}
      {readyTemplates.length > 0 && (
        <div className="card p-4 mb-4">
          <label className="block text-[12px] font-medium text-textdark mb-2">
            Generate Test LP
          </label>
          <div className="space-y-2">
            <div className="flex gap-2">
              <select
                value={testForm.template_id}
                onChange={e => setTestForm(f => ({ ...f, template_id: e.target.value }))}
                disabled={generating}
                className="input-apple flex-1 text-[12px]"
              >
                <option value="">Select template...</option>
                {readyTemplates.map(t => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
              <select
                value={testForm.narrative_frame}
                onChange={e => setTestForm(f => ({ ...f, narrative_frame: e.target.value }))}
                disabled={generating}
                className="input-apple flex-1 text-[12px]"
              >
                {NARRATIVE_FRAMES.map(f => (
                  <option key={f.id} value={f.id}>{f.name}</option>
                ))}
              </select>
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={testForm.angle}
                onChange={e => setTestForm(f => ({ ...f, angle: e.target.value }))}
                className="input-apple flex-1 text-[12px]"
                placeholder="Angle: e.g., Grounding reduces chronic inflammation and improves sleep"
                disabled={generating}
                onKeyDown={e => e.key === 'Enter' && !generating && handleGenerateTest()}
              />
              <button
                onClick={handleGenerateTest}
                disabled={generating || !testForm.template_id || !testForm.angle.trim()}
                className="btn-primary text-[12px] whitespace-nowrap disabled:opacity-50"
              >
                {generating ? 'Generating...' : 'Generate'}
              </button>
            </div>
            {generating && genPhase && (
              <div className="flex items-center gap-2">
                <svg className="w-3.5 h-3.5 text-navy animate-spin flex-shrink-0" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4 31.4" strokeLinecap="round" />
                </svg>
                <span className="text-[11px] text-textmid">{genPhase}</span>
              </div>
            )}
          </div>
          <p className="text-[10px] text-textlight mt-1.5">
            Test the auto LP pipeline: pick a template and narrative frame, enter an angle, and generate a landing page using the same pipeline as the Director.
          </p>
        </div>
      )}

      {/* Templates list */}
      {loading ? (
        <div className="space-y-2">
          {[0, 1].map(i => (
            <div key={i} className="card p-4 animate-pulse">
              <div className="h-4 w-48 bg-gray-200 rounded" />
              <div className="h-3 w-32 bg-gray-100 rounded mt-2" />
            </div>
          ))}
        </div>
      ) : templates.length === 0 ? (
        <div className="card p-6 text-center">
          <p className="text-[13px] text-textmid">No templates yet. Extract one from a landing page URL above.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {templates.map(template => {
            const status = STATUS_BADGE[template.status] || STATUS_BADGE.failed;
            let slotCount = 0;
            try {
              slotCount = JSON.parse(template.slot_definitions || '[]').length;
            } catch {}

            return (
              <div key={template.id} className="card p-4 hover:shadow-md transition-shadow">
                <div className="flex items-center justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="text-[13px] font-medium text-textdark truncate">{template.name}</h3>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${status.bg} ${status.text}`}>
                        {status.label}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 mt-1">
                      <span className="text-[11px] text-textlight truncate max-w-[300px]">{template.source_url}</span>
                      {slotCount > 0 && (
                        <span className="text-[10px] text-textmid">{slotCount} slots</span>
                      )}
                      <span className="text-[10px] text-textlight">{new Date(template.created_at).toLocaleDateString()}</span>
                    </div>
                    {template.status === 'failed' && template.error_message && (
                      <p className="text-[11px] text-red-500 mt-1 truncate">{template.error_message}</p>
                    )}
                  </div>
                  <button
                    onClick={() => handleDelete(template.id, template.name)}
                    className="text-textlight hover:text-red-500 transition-colors p-1 flex-shrink-0"
                    title="Delete template"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                    </svg>
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

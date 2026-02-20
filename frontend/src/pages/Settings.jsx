import { useState, useEffect } from 'react';
import { api } from '../api';
import Layout from '../components/Layout';
import InfoTooltip from '../components/InfoTooltip';
import DragDropUpload from '../components/DragDropUpload';
import { useToast } from '../components/Toast';

// ─── Single reference doc upload slot (reusable) ─────────────────────────
function ReferenceDocSlot({ docKey, label, description, content, onSave, onDelete }) {
  const toast = useToast();
  const [pasteContent, setPasteContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleSave = async () => {
    if (!pasteContent.trim()) { toast.error('Please enter or upload content'); return; }
    setSaving(true);
    try {
      await onSave(docKey, pasteContent.trim());
      toast.success(`${label} saved`);
      setPasteContent('');
      setEditing(false);
    } catch (err) {
      toast.error('Failed to save: ' + (err.message || 'Unknown error'));
    } finally { setSaving(false); }
  };

  const handleDelete = async () => {
    if (!confirm(`Remove ${label}?`)) return;
    setDeleting(true);
    try {
      await onDelete(docKey);
      toast.success(`${label} removed`);
    } catch (err) {
      toast.error('Failed to delete: ' + (err.message || 'Unknown error'));
    } finally { setDeleting(false); }
  };

  const handleFileExtracted = (result) => {
    setPasteContent(result.text);
    toast.success(`Extracted ${result.charCount.toLocaleString()} characters from ${result.filename}`);
  };

  if (content && !editing) {
    return (
      <div className="bg-white rounded-lg shadow-sm border border-purple-200/60 p-3">
        <div className="flex items-start justify-between mb-1">
          <div className="flex items-center gap-2">
            <h4 className="text-[12px] font-medium text-gray-800">{label}</h4>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-100 text-green-700">Uploaded</span>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => { setEditing(true); setPasteContent(content); }} className="text-[11px] text-blue-600 hover:underline">Replace</button>
            <button onClick={handleDelete} disabled={deleting} className="text-[11px] text-red-500 hover:underline disabled:opacity-50">
              {deleting ? '...' : 'Remove'}
            </button>
          </div>
        </div>
        <div className="flex items-center gap-3 mb-1 text-[10px] text-gray-400">
          <span>{content.length.toLocaleString()} characters</span>
        </div>
        <button onClick={() => setExpanded(prev => !prev)} className="text-[10px] text-gray-500 hover:text-gray-700 flex items-center gap-1">
          <svg className={`w-2.5 h-2.5 transition-transform ${expanded ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
          </svg>
          {expanded ? 'Hide' : 'Preview'}
        </button>
        {expanded && (
          <div className="mt-2 max-h-[200px] overflow-y-auto text-[11px] text-gray-600 whitespace-pre-wrap bg-gray-50 rounded-lg p-2.5 border border-gray-100">
            {content.slice(0, 2000)}{content.length > 2000 ? '...' : ''}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="border border-dashed border-gray-200 rounded-lg p-3 space-y-2">
      <p className="text-[12px] font-medium text-gray-700">{label}</p>
      {description && <p className="text-[10px] text-gray-400">{description}</p>}
      <DragDropUpload
        onTextExtracted={handleFileExtracted}
        accept=".pdf,.docx,.epub,.mobi,.txt,.html,.htm,.md,.markdown"
        label="Drop file (PDF, DOCX, TXT, etc.)"
        compact
      />
      <textarea
        value={pasteContent}
        onChange={(e) => setPasteContent(e.target.value)}
        placeholder="Or paste content here..."
        rows={3}
        className="input-apple w-full text-[12px] resize-y"
      />
      {pasteContent && <p className="text-[10px] text-gray-400">{pasteContent.length.toLocaleString()} characters</p>}
      <div className="flex items-center gap-2">
        <button onClick={handleSave} disabled={saving || !pasteContent.trim()} className="btn-primary text-[11px] px-3 py-1 disabled:opacity-50">
          {saving ? 'Saving...' : 'Save'}
        </button>
        {editing && (
          <button onClick={() => { setEditing(false); setPasteContent(''); }} className="btn-secondary text-[11px] px-3 py-1">Cancel</button>
        )}
      </div>
    </div>
  );
}

// ─── Headline Generator Reference Docs (3 documents for Copywriter) ─────
function HeadlineGeneratorRefsSection() {
  const [docs, setDocs] = useState({ engine: null, greatest: null, swipe: null });
  const [loading, setLoading] = useState(true);

  useEffect(() => { loadDocs(); }, []);

  const loadDocs = async () => {
    try {
      const data = await api.getHeadlineReferences();
      setDocs({
        engine: data.engine || null,
        greatest: data.greatest || null,
        swipe: data.swipe || null,
      });
    } catch (err) {
      console.error('Failed to load headline references:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async (docKey, content) => {
    await api.uploadHeadlineRef(docKey, content);
    await loadDocs();
  };

  const handleDelete = async (docKey) => {
    await api.deleteHeadlineRef(docKey);
    await loadDocs();
  };

  if (loading) return null;

  const uploadedCount = [docs.engine, docs.greatest, docs.swipe].filter(Boolean).length;

  return (
    <div className="card p-6">
      <div className="flex items-center gap-2 mb-1">
        <div className="w-6 h-6 rounded-lg bg-purple-100 flex items-center justify-center">
          <svg className="w-3.5 h-3.5 text-purple-600" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
          </svg>
        </div>
        <h2 className="text-[15px] font-semibold text-gray-900 tracking-tight">Headline Generator Reference Docs</h2>
        <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-purple-100 text-purple-700">Copywriter</span>
        <InfoTooltip text="Upload 3 reference documents used by the Copywriter's headline generation step. Claude uses these as frameworks when creating direct response headlines from mined quotes." />
      </div>
      <p className="text-[12px] text-gray-500 mb-4">
        {uploadedCount}/3 documents uploaded. These power the "Generate Headlines" button in the Copywriter.
      </p>

      <div className="space-y-3">
        <ReferenceDocSlot
          docKey="engine"
          label="1. Headline Engine (Methodology)"
          description="THE DIRECT RESPONSE HEADLINE ENGINE — headline writing methodology and rules"
          content={docs.engine}
          onSave={handleSave}
          onDelete={handleDelete}
        />
        <ReferenceDocSlot
          docKey="greatest"
          label="2. 100 Greatest Headlines"
          description="100 Greatest Headlines Ever Used — classic headline examples"
          content={docs.greatest}
          onSave={handleSave}
          onDelete={handleDelete}
        />
        <ReferenceDocSlot
          docKey="swipe"
          label="3. 349 Headlines Swipe File"
          description="349 Great Headlines / Halbert Swipe File — direct response templates"
          content={docs.swipe}
          onSave={handleSave}
          onDelete={handleDelete}
        />
      </div>
    </div>
  );
}

export default function Settings() {
  const toast = useToast();
  const [settings, setSettings] = useState({});
  const [form, setForm] = useState({
    openai_api_key: '',
    openai_admin_key: '',
    gemini_api_key: '',
    perplexity_api_key: '',
    anthropic_api_key: '',
    gemini_rate_1k: '',
    gemini_rate_2k: '',
    gemini_rate_4k: ''
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [testResults, setTestResults] = useState({});

  // Gemini rate refresh
  const [refreshingRates, setRefreshingRates] = useState(false);
  const [rateRefreshMsg, setRateRefreshMsg] = useState('');

  // Password change
  const [passwordForm, setPasswordForm] = useState({ currentPassword: '', newPassword: '' });
  const [passwordMsg, setPasswordMsg] = useState('');

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const data = await api.getSettings();
      setSettings(data);
      setForm(prev => ({
        ...prev,
        gemini_rate_1k: data.gemini_rate_1k || '',
        gemini_rate_2k: data.gemini_rate_2k || '',
        gemini_rate_4k: data.gemini_rate_4k || ''
      }));
    } catch (err) {
      console.error('Failed to load settings:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setMessage('');
    try {
      const payload = {};
      if (form.openai_api_key) payload.openai_api_key = form.openai_api_key;
      if (form.openai_admin_key) payload.openai_admin_key = form.openai_admin_key;
      if (form.gemini_api_key) payload.gemini_api_key = form.gemini_api_key;
      if (form.perplexity_api_key) payload.perplexity_api_key = form.perplexity_api_key;
      if (form.anthropic_api_key) payload.anthropic_api_key = form.anthropic_api_key;
      if (form.gemini_rate_1k) payload.gemini_rate_1k = form.gemini_rate_1k;
      if (form.gemini_rate_2k) payload.gemini_rate_2k = form.gemini_rate_2k;
      if (form.gemini_rate_4k) payload.gemini_rate_4k = form.gemini_rate_4k;

      await api.updateSettings(payload);
      toast.success('Settings saved');
      setMessage('');
      setForm(prev => ({ ...prev, openai_api_key: '', openai_admin_key: '', gemini_api_key: '', perplexity_api_key: '', anthropic_api_key: '' }));
      await loadSettings();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async (service) => {
    setTestResults(prev => ({ ...prev, [service]: 'testing...' }));
    try {
      let result;
      if (service === 'openai') result = await api.testOpenAI();
      else if (service === 'gemini') result = await api.testGemini();
      else if (service === 'perplexity') result = await api.testPerplexity();
      else if (service === 'anthropic') result = await api.testAnthropic();
      setTestResults(prev => ({ ...prev, [service]: result.message || 'Connected!' }));
    } catch (err) {
      setTestResults(prev => ({ ...prev, [service]: `Failed: ${err.message}` }));
    }
  };

  const handlePasswordChange = async (e) => {
    e.preventDefault();
    setPasswordMsg('');
    try {
      await api.changePassword(passwordForm.currentPassword, passwordForm.newPassword);
      setPasswordMsg('Password updated successfully');
      setPasswordForm({ currentPassword: '', newPassword: '' });
    } catch (err) {
      setPasswordMsg(`Error: ${err.message}`);
    }
  };

  const handleRefreshRates = async () => {
    setRefreshingRates(true);
    setRateRefreshMsg('');
    try {
      const result = await api.refreshGeminiRates();
      if (result.success) {
        setRateRefreshMsg('Rates updated successfully!');
        await loadSettings();
      } else {
        setRateRefreshMsg(result.message || 'Could not parse rates. Existing rates preserved.');
      }
    } catch (err) {
      setRateRefreshMsg(`Error: ${err.message}`);
    } finally {
      setRefreshingRates(false);
    }
  };

  const handleSyncOpenAI = async () => {
    setRateRefreshMsg('');
    try {
      const result = await api.syncCosts();
      if (result.synced) {
        setRateRefreshMsg(`OpenAI costs synced: ${result.recordCount} records.`);
      } else {
        setRateRefreshMsg(result.reason || 'OpenAI sync unavailable.');
      }
    } catch (err) {
      setRateRefreshMsg(`Error: ${err.message}`);
    }
  };

  if (loading) {
    return (
      <Layout>
        <div className="mb-8">
          <div className="h-7 w-24 bg-gray-200 rounded animate-pulse mb-1" />
          <div className="h-3 w-48 bg-gray-100 rounded animate-pulse" />
        </div>
        <div className="space-y-5 max-w-2xl">
          {[0, 1, 2].map(i => (
            <div key={i} className="card p-6 animate-pulse">
              <div className="h-4 w-24 bg-gray-200 rounded mb-4" />
              <div className="space-y-4">
                <div>
                  <div className="h-3 w-28 bg-gray-100 rounded mb-1.5" />
                  <div className="h-9 w-full bg-gray-100 rounded-xl" />
                </div>
                <div>
                  <div className="h-3 w-32 bg-gray-100 rounded mb-1.5" />
                  <div className="h-9 w-full bg-gray-100 rounded-xl" />
                </div>
              </div>
            </div>
          ))}
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold text-gray-900 tracking-tight">Settings</h1>
        <p className="text-[13px] text-gray-500 mt-0.5">API keys, integrations, and account</p>
      </div>

      <div className="space-y-5 max-w-2xl fade-in">
        {/* API Keys */}
        <div className="card p-6">
          <h2 className="text-[15px] font-semibold text-gray-900 tracking-tight mb-4 flex items-center gap-1">API Keys <InfoTooltip text="API keys for OpenAI (document generation, creative direction) and Gemini (image generation). Required for the platform to function." position="right" /></h2>

          {message && (
            <div className={`text-[13px] rounded-xl p-3 mb-4 ${
              message.startsWith('Error')
                ? 'bg-red-50/80 border border-red-200/60 text-red-600'
                : 'bg-green-50/80 border border-green-200/60 text-green-700'
            }`}>
              {message}
            </div>
          )}

          <div className="space-y-4">
            <div>
              <label className="block text-[13px] font-medium text-gray-600 mb-1.5">OpenAI API Key</label>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={form.openai_api_key}
                  onChange={e => setForm(p => ({ ...p, openai_api_key: e.target.value }))}
                  className="input-apple flex-1"
                  placeholder={settings.openai_api_key || 'Enter OpenAI API key'}
                />
                <button
                  onClick={() => testConnection('openai')}
                  className="btn-secondary text-[13px] whitespace-nowrap"
                >
                  Test
                </button>
              </div>
              {testResults.openai && <p className="text-[12px] text-gray-400 mt-1">{testResults.openai}</p>}
            </div>

            <div>
              <label className="block text-[13px] font-medium text-gray-600 mb-1.5">OpenAI Admin Key (for billing)</label>
              <input
                type="password"
                value={form.openai_admin_key}
                onChange={e => setForm(p => ({ ...p, openai_admin_key: e.target.value }))}
                className="input-apple"
                placeholder={settings.openai_admin_key || 'Enter OpenAI Admin key'}
              />
            </div>

            <div>
              <label className="block text-[13px] font-medium text-gray-600 mb-1.5">Gemini API Key</label>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={form.gemini_api_key}
                  onChange={e => setForm(p => ({ ...p, gemini_api_key: e.target.value }))}
                  className="input-apple flex-1"
                  placeholder={settings.gemini_api_key || 'Enter Gemini API key'}
                />
                <button
                  onClick={() => testConnection('gemini')}
                  className="btn-secondary text-[13px] whitespace-nowrap"
                >
                  Test
                </button>
              </div>
              {testResults.gemini && <p className="text-[12px] text-gray-400 mt-1">{testResults.gemini}</p>}
            </div>

            <div className="border-t border-gray-100 pt-4 mt-4">
              <p className="text-[11px] text-gray-400 mb-3 flex items-center gap-1.5">
                <span className="inline-flex items-center px-1.5 py-0.5 rounded-md bg-purple-50 text-purple-600 font-medium">Copywriter</span>
                Required for the Copywriter feature
              </p>
            </div>

            <div>
              <label className="block text-[13px] font-medium text-gray-600 mb-1.5">
                Perplexity API Key
              </label>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={form.perplexity_api_key}
                  onChange={e => setForm(p => ({ ...p, perplexity_api_key: e.target.value }))}
                  className="input-apple flex-1"
                  placeholder={settings.perplexity_api_key || 'Enter Perplexity API key'}
                />
                <button
                  onClick={() => testConnection('perplexity')}
                  className="btn-secondary text-[13px] whitespace-nowrap"
                >
                  Test
                </button>
              </div>
              {testResults.perplexity && <p className="text-[12px] text-gray-400 mt-1">{testResults.perplexity}</p>}
            </div>

            <div>
              <label className="block text-[13px] font-medium text-gray-600 mb-1.5">
                Anthropic API Key
              </label>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={form.anthropic_api_key}
                  onChange={e => setForm(p => ({ ...p, anthropic_api_key: e.target.value }))}
                  className="input-apple flex-1"
                  placeholder={settings.anthropic_api_key || 'Enter Anthropic API key'}
                />
                <button
                  onClick={() => testConnection('anthropic')}
                  className="btn-secondary text-[13px] whitespace-nowrap"
                >
                  Test
                </button>
              </div>
              {testResults.anthropic && <p className="text-[12px] text-gray-400 mt-1">{testResults.anthropic}</p>}
            </div>
          </div>
        </div>

        {/* Gemini Rates */}
        <div className="card p-6">
          <div className="flex justify-between items-start mb-1">
            <h2 className="text-[15px] font-semibold text-gray-900 tracking-tight flex items-center gap-1">Gemini Image Rates <InfoTooltip text="Per-image pricing for Gemini image generation at different resolutions. Used to calculate cost tracking. Refresh to pull latest rates from Google." position="right" /></h2>
            <button
              onClick={handleRefreshRates}
              disabled={refreshingRates}
              className="btn-secondary text-[13px] whitespace-nowrap"
            >
              {refreshingRates ? (
                <span className="flex items-center gap-1.5">
                  <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4 31.4" strokeLinecap="round" />
                  </svg>
                  Refreshing...
                </span>
              ) : 'Refresh Rates Now'}
            </button>
          </div>
          <p className="text-[12px] text-gray-400 mb-4">
            Auto-refreshed daily from Google pricing.
            {settings.gemini_rates_updated_at && (
              <span> Last updated: {new Date(settings.gemini_rates_updated_at).toLocaleString()}</span>
            )}
          </p>

          {rateRefreshMsg && (
            <div className={`text-[13px] rounded-xl p-3 mb-4 ${
              rateRefreshMsg.startsWith('Error')
                ? 'bg-red-50/80 border border-red-200/60 text-red-600'
                : 'bg-green-50/80 border border-green-200/60 text-green-700'
            }`}>
              {rateRefreshMsg}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-[12px] font-medium text-gray-600 mb-1.5">1K ($/image)</label>
              <input
                value={form.gemini_rate_1k}
                onChange={e => setForm(p => ({ ...p, gemini_rate_1k: e.target.value }))}
                className="input-apple"
                placeholder="e.g., 0.039"
              />
            </div>
            <div>
              <label className="block text-[12px] font-medium text-gray-600 mb-1.5">2K ($/image)</label>
              <input
                value={form.gemini_rate_2k}
                onChange={e => setForm(p => ({ ...p, gemini_rate_2k: e.target.value }))}
                className="input-apple"
                placeholder="e.g., 0.134"
              />
            </div>
            <div>
              <label className="block text-[12px] font-medium text-gray-600 mb-1.5">4K ($/image)</label>
              <input
                value={form.gemini_rate_4k}
                onChange={e => setForm(p => ({ ...p, gemini_rate_4k: e.target.value }))}
                className="input-apple"
                placeholder="e.g., 0.xxx"
              />
            </div>
          </div>
        </div>

        {/* Cost Sync */}
        <div className="card p-6">
          <h2 className="text-[15px] font-semibold text-gray-900 tracking-tight mb-1 flex items-center gap-1">Cost Sync <InfoTooltip text="Manually trigger an OpenAI cost sync from the Billing API to update your dashboard cost tracking." position="right" /></h2>
          <p className="text-[12px] text-gray-400 mb-4">
            OpenAI costs sync hourly from the Billing API. Requires an Admin API key above.
          </p>
          <button
            onClick={handleSyncOpenAI}
            className="btn-secondary text-[13px]"
          >
            Sync OpenAI Costs Now
          </button>
        </div>

        {/* Headline Generator Reference Docs (Copywriter + Ad Studio Juicer) */}
        <HeadlineGeneratorRefsSection />

        {/* Save button */}
        <button
          onClick={handleSave}
          disabled={saving}
          className="btn-primary"
        >
          {saving ? 'Saving...' : 'Save Settings'}
        </button>

        {/* Change Password */}
        <div className="card p-6">
          <h2 className="text-[15px] font-semibold text-gray-900 tracking-tight mb-4">Change Password</h2>
          {passwordMsg && (
            <div className={`text-[13px] rounded-xl p-3 mb-4 ${
              passwordMsg.startsWith('Error')
                ? 'bg-red-50/80 border border-red-200/60 text-red-600'
                : 'bg-green-50/80 border border-green-200/60 text-green-700'
            }`}>
              {passwordMsg}
            </div>
          )}
          <form onSubmit={handlePasswordChange} className="space-y-4">
            <div>
              <label className="block text-[13px] font-medium text-gray-600 mb-1.5">Current Password</label>
              <input
                type="password"
                value={passwordForm.currentPassword}
                onChange={e => setPasswordForm(p => ({ ...p, currentPassword: e.target.value }))}
                className="input-apple"
                required
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-gray-600 mb-1.5">New Password</label>
              <input
                type="password"
                value={passwordForm.newPassword}
                onChange={e => setPasswordForm(p => ({ ...p, newPassword: e.target.value }))}
                className="input-apple"
                required
                minLength={6}
              />
            </div>
            <button type="submit" className="btn-secondary text-[13px]">
              Update Password
            </button>
          </form>
        </div>
      </div>
    </Layout>
  );
}

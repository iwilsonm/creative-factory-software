import { useState, useEffect, useRef } from 'react';
import { api } from '../api';
import Layout from '../components/Layout';
import InfoTooltip from '../components/InfoTooltip';
import { useToast } from '../components/Toast';

export default function Settings() {
  const toast = useToast();
  const [settings, setSettings] = useState({});
  const [form, setForm] = useState({
    openai_api_key: '',
    openai_admin_key: '',
    gemini_api_key: '',
    default_drive_folder_id: '',
    gemini_rate_1k: '',
    gemini_rate_2k: '',
    gemini_rate_4k: ''
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [testResults, setTestResults] = useState({});

  // Drive state
  const [driveStatus, setDriveStatus] = useState(null);
  const [driveUploading, setDriveUploading] = useState(false);
  const [driveMsg, setDriveMsg] = useState('');
  const driveFileRef = useRef(null);

  // Gemini rate refresh
  const [refreshingRates, setRefreshingRates] = useState(false);
  const [rateRefreshMsg, setRateRefreshMsg] = useState('');

  // Password change
  const [passwordForm, setPasswordForm] = useState({ currentPassword: '', newPassword: '' });
  const [passwordMsg, setPasswordMsg] = useState('');

  useEffect(() => {
    loadSettings();
    loadDriveStatus();
  }, []);

  const loadSettings = async () => {
    try {
      const data = await api.getSettings();
      setSettings(data);
      setForm(prev => ({
        ...prev,
        default_drive_folder_id: data.default_drive_folder_id || '',
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
      payload.default_drive_folder_id = form.default_drive_folder_id;
      if (form.gemini_rate_1k) payload.gemini_rate_1k = form.gemini_rate_1k;
      if (form.gemini_rate_2k) payload.gemini_rate_2k = form.gemini_rate_2k;
      if (form.gemini_rate_4k) payload.gemini_rate_4k = form.gemini_rate_4k;

      await api.updateSettings(payload);
      toast.success('Settings saved');
      setMessage('');
      setForm(prev => ({ ...prev, openai_api_key: '', openai_admin_key: '', gemini_api_key: '' }));
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
      else result = await api.testDrive();
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

  const loadDriveStatus = async () => {
    try {
      const data = await api.driveStatus();
      setDriveStatus(data);
    } catch (err) {
      console.error('Failed to load drive status:', err);
    }
  };

  const handleDriveFileUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setDriveUploading(true);
    setDriveMsg('');
    try {
      const text = await file.text();
      const result = await api.driveUploadServiceAccount(text);
      setDriveMsg(`Connected! Service account: ${result.serviceAccountEmail}`);
      loadDriveStatus();
    } catch (err) {
      setDriveMsg(`Error: ${err.message}`);
    } finally {
      setDriveUploading(false);
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

  const handleDriveTest = async () => {
    setDriveMsg('Testing...');
    try {
      const result = await api.driveTest();
      setDriveMsg(result.message);
    } catch (err) {
      setDriveMsg(`Error: ${err.message}`);
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
          </div>
        </div>

        {/* Google Drive */}
        <div className="card p-6">
          <h2 className="text-[15px] font-semibold text-gray-900 tracking-tight mb-4 flex items-center gap-1">Google Drive <InfoTooltip text="Connect Google Drive to automatically upload generated ad images. Requires a service account with access to your Drive folder." position="right" /></h2>

          {driveMsg && (
            <div className={`text-[13px] rounded-xl p-3 mb-4 ${
              driveMsg.startsWith('Error')
                ? 'bg-red-50/80 border border-red-200/60 text-red-600'
                : 'bg-green-50/80 border border-green-200/60 text-green-700'
            }`}>
              {driveMsg}
            </div>
          )}

          {/* Service Account Status */}
          <div className="mb-4">
            <div className="flex items-center gap-2 mb-2">
              <span className={`w-2 h-2 rounded-full ${driveStatus?.configured ? 'bg-green-500' : 'bg-gray-300'}`} />
              <span className="text-[13px] font-medium text-gray-700">
                Service Account: {driveStatus?.configured ? 'Connected' : 'Not configured'}
              </span>
            </div>

            {driveStatus?.configured && driveStatus?.serviceAccountEmail && (
              <p className="text-[12px] text-gray-400 ml-4 mb-3">
                {driveStatus.serviceAccountEmail}
              </p>
            )}

            {!driveStatus?.configured && (
              <div className="bg-gray-50/50 border border-gray-200/60 rounded-xl p-4 mb-3">
                <p className="text-[13px] font-medium text-gray-700 mb-2">Setup Instructions:</p>
                <ol className="text-[12px] text-gray-500 space-y-1.5 list-decimal list-inside">
                  <li>Go to <a href="https://console.cloud.google.com/iam-admin/serviceaccounts" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:text-blue-600 transition-colors">Google Cloud Console</a></li>
                  <li>Create a service account (or use an existing one)</li>
                  <li>Click the service account, then Keys, then Add Key, then Create new key as JSON</li>
                  <li>Upload the downloaded JSON file below</li>
                  <li>Enable the <a href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:text-blue-600 transition-colors">Google Drive API</a></li>
                  <li>Share your Drive folders with the service account email</li>
                </ol>
              </div>
            )}

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => driveFileRef.current?.click()}
                disabled={driveUploading}
                className="btn-secondary text-[13px]"
              >
                {driveUploading ? 'Uploading...' : driveStatus?.configured ? 'Replace Service Account' : 'Upload service-account.json'}
              </button>
              {driveStatus?.configured && (
                <button
                  type="button"
                  onClick={handleDriveTest}
                  className="btn-secondary text-[13px]"
                >
                  Test Connection
                </button>
              )}
              <input
                ref={driveFileRef}
                type="file"
                accept=".json"
                onChange={handleDriveFileUpload}
                className="hidden"
              />
            </div>
          </div>

          {/* Default folder */}
          <div className="border-t border-gray-200/60 pt-4">
            <label className="block text-[13px] font-medium text-gray-600 mb-1.5">Default Output Folder ID</label>
            <input
              value={form.default_drive_folder_id}
              onChange={e => setForm(p => ({ ...p, default_drive_folder_id: e.target.value }))}
              className="input-apple"
              placeholder="Default Google Drive folder ID for generated images"
            />
            <p className="text-[11px] text-gray-400 mt-1.5">
              {driveStatus?.configured
                ? 'Make sure this folder is shared with the service account email above.'
                : 'Configure service account above first.'}
            </p>
            <div className="mt-3 bg-gray-50/50 border border-gray-200/60 rounded-xl p-4">
              <p className="text-[13px] font-medium text-gray-700 mb-2 flex items-center gap-1.5">
                <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9 5.25h.008v.008H12v-.008z" />
                </svg>
                How to find a folder ID
              </p>
              <ol className="text-[12px] text-gray-500 space-y-1.5 list-decimal list-inside">
                <li>Open the folder in <a href="https://drive.google.com" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:text-blue-600 transition-colors">Google Drive</a></li>
                <li>Look at the URL in your browser's address bar</li>
                <li>The folder ID is the long string after <code className="text-[11px] bg-gray-100 px-1.5 py-0.5 rounded text-gray-600 font-mono">/folders/</code></li>
                <li>Example: drive.google.com/drive/folders/<code className="text-[11px] bg-gray-100 px-1.5 py-0.5 rounded text-gray-600 font-mono break-all">1aBcDeFgHiJkLmNoPqRsTuVwXyZ</code></li>
                <li>Copy that ID and paste it here</li>
              </ol>
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

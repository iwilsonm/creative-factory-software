import { useState, useEffect } from 'react';
import { api } from '../api';
import Layout from '../components/Layout';
import InfoTooltip from '../components/InfoTooltip';
import DragDropUpload from '../components/DragDropUpload';
import ConfirmDialog from '../components/ConfirmDialog';
import { useToast } from '../components/Toast';

// ─── Single reference doc upload slot (reusable) ─────────────────────────
function ReferenceDocSlot({ docKey, label, description, content, onSave, onDelete }) {
  const toast = useToast();
  const [pasteContent, setPasteContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

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
    setDeleting(true);
    try {
      await onDelete(docKey);
      toast.success(`${label} removed`);
      setConfirmingDelete(false);
    } catch (err) {
      toast.error('Failed to delete: ' + (err.message || 'Unknown error'));
    } finally { setDeleting(false); }
  };

  const handleFileExtracted = (result) => {
    setPasteContent(result.text);
    toast.success(`Extracted ${result.charCount.toLocaleString()} characters from ${result.filename}`);
  };

  const deleteDialog = (
    <ConfirmDialog
      open={confirmingDelete}
      title={`Remove ${label}?`}
      message="This removes the stored reference document from settings."
      confirmLabel="Remove"
      busy={deleting}
      onCancel={() => setConfirmingDelete(false)}
      onConfirm={handleDelete}
    />
  );

  if (content && !editing) {
    return (
      <>
        <div className="card p-3">
          <div className="flex items-start justify-between mb-1">
            <div className="flex items-center gap-2">
              <h4 className="text-[12px] font-medium text-textdark">{label}</h4>
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-teal/10 text-teal">Uploaded</span>
            </div>
            <div className="flex items-center gap-2">
              <button onClick={() => { setEditing(true); setPasteContent(content); }} className="action-link">Replace</button>
              <button onClick={() => setConfirmingDelete(true)} disabled={deleting} className="action-link-danger disabled:opacity-50">
                {deleting ? 'Removing...' : 'Remove'}
              </button>
            </div>
          </div>
          <div className="flex items-center gap-3 mb-1 text-[10px] text-textlight">
            <span>{content.length.toLocaleString()} characters</span>
          </div>
          <button onClick={() => setExpanded(prev => !prev)} className="text-[10px] text-textmid hover:text-textdark flex items-center gap-1">
            <svg className={`w-2.5 h-2.5 transition-transform ${expanded ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
            </svg>
            {expanded ? 'Hide' : 'Preview'}
          </button>
          {expanded && (
            <div className="mt-2 max-h-[200px] overflow-y-auto text-[11px] text-textmid whitespace-pre-wrap bg-offwhite rounded-lg p-2.5 border border-black/5">
              {content.slice(0, 2000)}{content.length > 2000 ? '...' : ''}
            </div>
          )}
        </div>
        {deleteDialog}
      </>
    );
  }

  return (
    <>
      <div className="card p-3 border-dashed border-black/10 space-y-2">
        <p className="text-[12px] font-medium text-textdark">{label}</p>
        {description && <p className="text-[10px] text-textlight">{description}</p>}
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
        {pasteContent && <p className="text-[10px] text-textlight">{pasteContent.length.toLocaleString()} characters</p>}
        <div className="flex items-center gap-2">
          <button onClick={handleSave} disabled={saving || !pasteContent.trim()} className="btn-primary text-[11px] px-3 py-1 disabled:opacity-50">
            {saving ? 'Saving...' : 'Save'}
          </button>
          {editing && (
            <button onClick={() => { setEditing(false); setPasteContent(''); }} className="btn-secondary text-[11px] px-3 py-1">Cancel</button>
          )}
        </div>
      </div>
      {deleteDialog}
    </>
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
        <div className="w-6 h-6 rounded-lg bg-navy/10 flex items-center justify-center">
          <svg className="w-3.5 h-3.5 text-navy" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
          </svg>
        </div>
        <h2 className="text-[15px] font-semibold text-textdark tracking-tight">Headline Generator Reference Docs</h2>
        <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-navy/10 text-navy">Copywriter</span>
        <InfoTooltip text="Upload 3 reference documents used by the Copywriter's headline generation step. Claude uses these as frameworks when creating direct response headlines from mined quotes." />
      </div>
      <p className="text-[12px] text-textmid mb-4">
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

// ─── User Management Card ─────────────────────────────────────────────
const ROLE_OPTIONS = [
  { value: 'admin', label: 'Admin', description: 'Full access to everything' },
  { value: 'manager', label: 'Manager', description: 'All features except Settings & User Management' },
  { value: 'poster', label: 'Poster', description: 'Ready to Post + Posted only' },
];

const ROLE_COLORS = {
  admin: 'bg-gold/15 text-gold',
  manager: 'bg-navy/10 text-navy',
  poster: 'bg-teal/10 text-teal',
};

function UserManagementCard() {
  const toast = useToast();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({ username: '', display_name: '', password: '', role: 'poster' });
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editForm, setEditForm] = useState({});
  const [resetPasswordId, setResetPasswordId] = useState(null);
  const [newPassword, setNewPassword] = useState('');
  const [resettingPassword, setResettingPassword] = useState(false);
  const [pendingDeleteUser, setPendingDeleteUser] = useState(null);

  useEffect(() => { loadUsers(); }, []);

  const loadUsers = async () => {
    try {
      const data = await api.getUsers();
      setUsers(data);
    } catch (err) {
      console.error('Failed to load users:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!createForm.username || !createForm.password || !createForm.role) {
      toast.error('All fields are required');
      return;
    }
    setCreating(true);
    try {
      await api.createUser(createForm);
      toast.success(`User "${createForm.username}" created`);
      setCreateForm({ username: '', display_name: '', password: '', role: 'poster' });
      setShowCreate(false);
      await loadUsers();
    } catch (err) {
      toast.error(err.message || 'Failed to create user');
    } finally {
      setCreating(false);
    }
  };

  const handleUpdate = async (userId) => {
    try {
      await api.updateUser(userId, editForm);
      toast.success('User updated');
      setEditingId(null);
      await loadUsers();
    } catch (err) {
      toast.error(err.message || 'Failed to update user');
    }
  };

  const handleToggleActive = async (user) => {
    try {
      await api.updateUser(user.id, { is_active: !user.is_active });
      toast.success(user.is_active ? 'User deactivated' : 'User activated');
      await loadUsers();
    } catch (err) {
      toast.error(err.message || 'Failed to update user');
    }
  };

  const handleResetPassword = async (userId) => {
    if (!newPassword || newPassword.length < 6) {
      toast.error('Password must be at least 6 characters');
      return;
    }
    setResettingPassword(true);
    try {
      await api.resetUserPassword(userId, newPassword);
      toast.success('Password reset successfully');
      setResetPasswordId(null);
      setNewPassword('');
    } catch (err) {
      toast.error(err.message || 'Failed to reset password');
    } finally {
      setResettingPassword(false);
    }
  };

  const handleDelete = async () => {
    if (!pendingDeleteUser) return;
    try {
      await api.deleteUser(pendingDeleteUser.id);
      toast.success(`User "${pendingDeleteUser.username}" deleted`);
      setPendingDeleteUser(null);
      await loadUsers();
    } catch (err) {
      toast.error(err.message || 'Failed to delete user');
    }
  };

  return (
    <div className="card p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-[15px] font-semibold text-textdark tracking-tight flex items-center gap-2">
          <svg className="w-4 h-4 text-textmid" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197m0 0V21" />
          </svg>
          User Management
        </h2>
        <button
          onClick={() => setShowCreate(!showCreate)}
          className="btn-primary text-[11px] px-3 py-1.5"
        >
          {showCreate ? 'Cancel' : '+ New User'}
        </button>
      </div>

      {/* Create user form */}
      {showCreate && (
        <form onSubmit={handleCreate} className="bg-offwhite rounded-xl p-4 mb-4 space-y-3 border border-black/5">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-medium text-textmid mb-1">Username</label>
              <input
                type="text"
                value={createForm.username}
                onChange={e => setCreateForm(prev => ({ ...prev, username: e.target.value }))}
                className="input-apple text-[12px]"
                required
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-textmid mb-1">Display Name</label>
              <input
                type="text"
                value={createForm.display_name}
                onChange={e => setCreateForm(prev => ({ ...prev, display_name: e.target.value }))}
                className="input-apple text-[12px]"
                placeholder="Optional"
              />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-medium text-textmid mb-1">Password</label>
              <input
                type="password"
                value={createForm.password}
                onChange={e => setCreateForm(prev => ({ ...prev, password: e.target.value }))}
                className="input-apple text-[12px]"
                required
                minLength={6}
              />
            </div>
            <div>
              <label className="block text-[11px] font-medium text-textmid mb-1">Role</label>
              <select
                value={createForm.role}
                onChange={e => setCreateForm(prev => ({ ...prev, role: e.target.value }))}
                className="input-apple text-[12px]"
              >
                {ROLE_OPTIONS.map(r => (
                  <option key={r.value} value={r.value}>{r.label} — {r.description}</option>
                ))}
              </select>
            </div>
          </div>
          <button type="submit" disabled={creating} className="btn-primary text-[11px] px-4 py-1.5 disabled:opacity-50">
            {creating ? 'Creating...' : 'Create User'}
          </button>
        </form>
      )}

      {/* User list */}
      {loading ? (
        <div className="text-[12px] text-textlight py-4 text-center">Loading users...</div>
      ) : users.length === 0 ? (
        <div className="text-[12px] text-textlight py-4 text-center">No users found</div>
      ) : (
        <div className="space-y-2">
          {users.map(user => (
            <div key={user.id} className={`rounded-xl border p-3 transition-colors ${user.is_active ? 'border-black/10 bg-white' : 'border-red-200/50 bg-red-50/30'}`}>
              {editingId === user.id ? (
                /* Edit mode */
                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[10px] font-medium text-textmid mb-0.5">Display Name</label>
                      <input
                        type="text"
                        value={editForm.display_name || ''}
                        onChange={e => setEditForm(prev => ({ ...prev, display_name: e.target.value }))}
                        className="input-apple text-[12px]"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-medium text-textmid mb-0.5">Role</label>
                      <select
                        value={editForm.role || ''}
                        onChange={e => setEditForm(prev => ({ ...prev, role: e.target.value }))}
                        className="input-apple text-[12px]"
                      >
                        {ROLE_OPTIONS.map(r => (
                          <option key={r.value} value={r.value}>{r.label}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button onClick={() => handleUpdate(user.id)} className="btn-primary text-[10px] px-3 py-1">Save</button>
                    <button onClick={() => setEditingId(null)} className="btn-secondary text-[10px] px-3 py-1">Cancel</button>
                  </div>
                </div>
              ) : resetPasswordId === user.id ? (
                /* Reset password mode */
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[12px] font-medium text-textdark">Reset password for {user.username}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="password"
                      value={newPassword}
                      onChange={e => setNewPassword(e.target.value)}
                      placeholder="New password (min 6 chars)"
                      className="input-apple text-[12px] flex-1"
                      minLength={6}
                    />
                    <button onClick={() => handleResetPassword(user.id)} disabled={resettingPassword} className="btn-primary text-[10px] px-3 py-1 disabled:opacity-50">
                      {resettingPassword ? '...' : 'Reset'}
                    </button>
                    <button onClick={() => { setResetPasswordId(null); setNewPassword(''); }} className="btn-secondary text-[10px] px-3 py-1">Cancel</button>
                  </div>
                </div>
              ) : (
                /* Display mode */
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] font-medium text-textdark">{user.display_name || user.username}</span>
                        {user.display_name && user.display_name !== user.username && (
                          <span className="text-[10px] text-textlight">@{user.username}</span>
                        )}
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${ROLE_COLORS[user.role] || 'bg-navy/10 text-navy'}`}>
                          {user.role}
                        </span>
                        {!user.is_active && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-red-100 text-red-600">
                            Inactive
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      onClick={() => { setEditingId(user.id); setEditForm({ display_name: user.display_name, role: user.role }); }}
                      className="action-link"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => { setResetPasswordId(user.id); setNewPassword(''); }}
                      className="action-link"
                    >
                      Reset Pwd
                    </button>
                    <button
                      onClick={() => handleToggleActive(user)}
                      className={`text-[10px] px-2 py-1 rounded-lg transition-colors ${
                        user.is_active
                          ? 'text-red-500 hover:bg-red-50'
                          : 'text-teal hover:bg-teal/10'
                      }`}
                    >
                      {user.is_active ? 'Deactivate' : 'Activate'}
                    </button>
                    <button
                      onClick={() => setPendingDeleteUser(user)}
                      className="action-link-danger"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      <ConfirmDialog
        open={!!pendingDeleteUser}
        title="Delete user?"
        message={pendingDeleteUser ? `Delete user "${pendingDeleteUser.username}"? This cannot be undone.` : ''}
        confirmLabel="Delete User"
        onCancel={() => setPendingDeleteUser(null)}
        onConfirm={handleDelete}
      />
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
    gemini_rate_4k: '',
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
        gemini_rate_4k: data.gemini_rate_4k || '',
      }));
      // (Cloudflare Pages projects removed — LP publishing now uses Shopify via Director config)
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
        <h1 className="text-2xl font-semibold text-textdark tracking-tight">Settings</h1>
        <p className="text-[13px] text-textmid mt-0.5">API keys, integrations, and account</p>
      </div>

      <div className="space-y-5 max-w-2xl fade-in">
        {/* User Management */}
        <UserManagementCard />

        {/* API Keys */}
        <div className="card p-6">
          <h2 className="text-[15px] font-semibold text-textdark tracking-tight mb-4 flex items-center gap-1">API Keys <InfoTooltip text="API keys for OpenAI (document generation, creative direction) and Gemini (image generation). Required for the platform to function." position="right" /></h2>

          {message && (
            <div className={`text-[13px] rounded-xl p-3 mb-4 ${
              message.startsWith('Error')
                ? 'bg-red-50/80 border border-red-200/60 text-red-600'
                : 'bg-teal/5 border border-teal/15 text-teal'
            }`}>
              {message}
            </div>
          )}

          <div className="space-y-4">
            <div>
              <label className="block text-[13px] font-medium text-textmid mb-1.5">OpenAI API Key</label>
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
              {testResults.openai && <p className="text-[12px] text-textlight mt-1">{testResults.openai}</p>}
            </div>

            <div>
              <label className="block text-[13px] font-medium text-textmid mb-1.5">OpenAI Admin Key (for billing)</label>
              <input
                type="password"
                value={form.openai_admin_key}
                onChange={e => setForm(p => ({ ...p, openai_admin_key: e.target.value }))}
                className="input-apple"
                placeholder={settings.openai_admin_key || 'Enter OpenAI Admin key'}
              />
            </div>

            <div>
              <label className="block text-[13px] font-medium text-textmid mb-1.5">Gemini API Key</label>
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
              {testResults.gemini && <p className="text-[12px] text-textlight mt-1">{testResults.gemini}</p>}
            </div>

            <div className="border-t border-black/5 pt-4 mt-4">
              <p className="text-[11px] text-textlight mb-3 flex items-center gap-1.5">
                <span className="inline-flex items-center px-1.5 py-0.5 rounded-md bg-navy/5 text-navy font-medium">Copywriter</span>
                Required for the Copywriter feature
              </p>
            </div>

            <div>
              <label className="block text-[13px] font-medium text-textmid mb-1.5">
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
              {testResults.perplexity && <p className="text-[12px] text-textlight mt-1">{testResults.perplexity}</p>}
            </div>

            <div>
              <label className="block text-[13px] font-medium text-textmid mb-1.5">
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
              {testResults.anthropic && <p className="text-[12px] text-textlight mt-1">{testResults.anthropic}</p>}
            </div>
          </div>
        </div>

        {/* Gemini Rates */}
        <div className="card p-6">
          <div className="flex justify-between items-start mb-1">
            <h2 className="text-[15px] font-semibold text-textdark tracking-tight flex items-center gap-1">Gemini Image Rates <InfoTooltip text="Per-image pricing for Gemini image generation at different resolutions. Used to calculate cost tracking. Refresh to pull latest rates from Google." position="right" /></h2>
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
          <p className="text-[12px] text-textlight mb-4">
            Auto-refreshed daily from Google pricing.
            {settings.gemini_rates_updated_at && (
              <span> Last updated: {new Date(settings.gemini_rates_updated_at).toLocaleString()}</span>
            )}
          </p>

          {rateRefreshMsg && (
            <div className={`text-[13px] rounded-xl p-3 mb-4 ${
              rateRefreshMsg.startsWith('Error')
                ? 'bg-red-50/80 border border-red-200/60 text-red-600'
                : 'bg-teal/5 border border-teal/15 text-teal'
            }`}>
              {rateRefreshMsg}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-[12px] font-medium text-textmid mb-1.5">1K ($/image)</label>
              <input
                value={form.gemini_rate_1k}
                onChange={e => setForm(p => ({ ...p, gemini_rate_1k: e.target.value }))}
                className="input-apple"
                placeholder="e.g., 0.039"
              />
            </div>
            <div>
              <label className="block text-[12px] font-medium text-textmid mb-1.5">2K ($/image)</label>
              <input
                value={form.gemini_rate_2k}
                onChange={e => setForm(p => ({ ...p, gemini_rate_2k: e.target.value }))}
                className="input-apple"
                placeholder="e.g., 0.134"
              />
            </div>
            <div>
              <label className="block text-[12px] font-medium text-textmid mb-1.5">4K ($/image)</label>
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
          <h2 className="text-[15px] font-semibold text-textdark tracking-tight mb-1 flex items-center gap-1">Cost Sync <InfoTooltip text="Manually trigger an OpenAI cost sync from the Billing API to update your dashboard cost tracking." position="right" /></h2>
          <p className="text-[12px] text-textlight mb-4">
            OpenAI costs sync hourly from the Billing API. Requires an Admin API key above.
          </p>
          <button
            onClick={handleSyncOpenAI}
            className="btn-secondary text-[13px]"
          >
            Sync OpenAI Costs Now
          </button>
        </div>

        {/* Cloudflare Pages section removed — LP publishing now uses Shopify via Director config in Agent Dashboard */}

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
          <h2 className="text-[15px] font-semibold text-textdark tracking-tight mb-4">Change Password</h2>
          {passwordMsg && (
            <div className={`text-[13px] rounded-xl p-3 mb-4 ${
              passwordMsg.startsWith('Error')
                ? 'bg-red-50/80 border border-red-200/60 text-red-600'
                : 'bg-teal/5 border border-teal/15 text-teal'
            }`}>
              {passwordMsg}
            </div>
          )}
          <form onSubmit={handlePasswordChange} className="space-y-4">
            <div>
              <label className="block text-[13px] font-medium text-textmid mb-1.5">Current Password</label>
              <input
                type="password"
                value={passwordForm.currentPassword}
                onChange={e => setPasswordForm(p => ({ ...p, currentPassword: e.target.value }))}
                className="input-apple"
                required
              />
            </div>
            <div>
              <label className="block text-[13px] font-medium text-textmid mb-1.5">New Password</label>
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

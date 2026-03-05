import { useState, useEffect, useRef, useCallback, useContext } from 'react';
import { useParams, useNavigate, Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { AuthContext } from '../App';
import Layout from '../components/Layout';
import FoundationalDocs from '../components/FoundationalDocs';
import TemplateImages from '../components/TemplateImages';
import AdStudio from '../components/AdStudio';
import AdTracker from './AdTracker';
import QuoteMiner from '../components/QuoteMiner';
import CostSummaryCards from '../components/CostSummaryCards';
import CopywriterChat from '../components/CopywriterChat';
import InfoTooltip from '../components/InfoTooltip';
import LPGen from '../components/LPGen';
import ErrorBoundary from '../components/ErrorBoundary';
import CreativeFilterSettings from '../components/CreativeFilterSettings';
import { useToast } from '../components/Toast';

const STATUS_CONFIG = {
  setup: { label: 'Setup', bg: 'bg-gold/10', text: 'text-gold' },
  generating_docs: { label: 'Generating', bg: 'bg-navy/10', text: 'text-navy' },
  docs_ready: { label: 'Ready', bg: 'bg-teal/10', text: 'text-teal' },
  active: { label: 'Active', bg: 'bg-teal/15', text: 'text-teal' }
};

export default function ProjectDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const toast = useToast();
  const { user } = useContext(AuthContext);
  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  // Persist active tab in URL search params so it survives page refresh
  const validTabs = ['quotes', 'ads', 'tracker', 'lpgen', 'overview', 'docs', 'templates'];
  const defaultTab = user?.role === 'poster' ? 'tracker' : 'ads';
  const tabFromUrl = searchParams.get('tab');
  const [tab, setTabState] = useState(
    tabFromUrl && validTabs.includes(tabFromUrl) ? tabFromUrl : defaultTab
  );
  const setTab = useCallback((newTab) => {
    setTabState(newTab);
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.set('tab', newTab);
      return next;
    }, { replace: true });
  }, [setSearchParams]);
  const [projectCosts, setProjectCosts] = useState(null);
  const [costsLoading, setCostsLoading] = useState(false);

  // Cross-tab prefill: Copywriter → Ad Studio
  const [adStudioPrefill, setAdStudioPrefill] = useState(null);

  // Meta Ads per-project state
  const [metaStatus, setMetaStatus] = useState(null);
  const [metaAdAccounts, setMetaAdAccounts] = useState([]);
  const [metaAccountsLoading, setMetaAccountsLoading] = useState(false);
  const [metaSyncing, setMetaSyncing] = useState(false);
  const [metaDisconnecting, setMetaDisconnecting] = useState(false);
  const [metaConnecting, setMetaConnecting] = useState(false);
  const [metaAppForm, setMetaAppForm] = useState({ meta_app_id: '', meta_app_secret: '' });
  const [metaAppSaving, setMetaAppSaving] = useState(false);
  const [metaShowEditCreds, setMetaShowEditCreds] = useState(false);

  // Product image state
  const [productImageUploading, setProductImageUploading] = useState(false);
  const [productImageDeleting, setProductImageDeleting] = useState(false);
  const [settingsSubTab, setSettingsSubTab] = useState('general');
  const [productDragOver, setProductDragOver] = useState(false);
  const productFileInputRef = useRef(null);

  const handleProductUpload = useCallback(async (file) => {
    if (!file) return;
    setProductImageUploading(true);
    try {
      await api.uploadProductImage(id, file);
      await loadProject();
      toast.success('Product image uploaded');
    } catch (err) {
      toast.error(err.message || 'Failed to upload product image');
    } finally {
      setProductImageUploading(false);
    }
  }, [id]);

  const handleProductDelete = useCallback(async () => {
    setProductImageDeleting(true);
    try {
      await api.deleteProductImage(id);
      await loadProject();
      toast.success('Product image removed');
    } catch (err) {
      toast.error(err.message || 'Failed to remove product image');
    } finally {
      setProductImageDeleting(false);
    }
  }, [id]);

  const handleProductDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setProductDragOver(false);
    const file = e.dataTransfer?.files?.[0];
    if (file && file.type.startsWith('image/')) handleProductUpload(file);
  }, [handleProductUpload]);

  useEffect(() => {
    loadProject();
    loadMetaStatus();
    // Clear cross-tab prefill on project switch to avoid stale data
    setAdStudioPrefill(null);

    // Check if returning from OAuth callback
    const metaParam = searchParams.get('meta');
    if (metaParam === 'connected') {
      toast.success('Meta account connected successfully!');
      setSearchParams({}, { replace: true });
      loadMetaStatus();
      setTab('overview');
    } else if (metaParam === 'error') {
      toast.error('Meta connection failed: ' + (searchParams.get('message') || 'Unknown error'));
      setSearchParams({}, { replace: true });
      setTab('overview');
    }
  }, [id]);

  useEffect(() => {
    if (tab === 'overview' && id) {
      loadProjectCosts();
    }
  }, [tab, id]);

  // ─── Meta Ads helpers ───────────────────────────────────────────────────
  const loadMetaStatus = async () => {
    try {
      const status = await api.getMetaStatus(id);
      setMetaStatus(status);
    } catch {
      setMetaStatus({ connected: false, appConfigured: false });
    }
  };

  const handleMetaConnect = async () => {
    setMetaConnecting(true);
    try {
      const { url } = await api.getMetaAuthUrl(id);
      window.location.href = url;
    } catch (err) {
      toast.error('Failed to start Meta connection: ' + err.message);
      setMetaConnecting(false);
    }
  };

  const handleMetaDisconnect = async () => {
    if (!confirm('Disconnect Meta from this project? This will remove the stored credentials for this project.')) return;
    setMetaDisconnecting(true);
    try {
      await api.disconnectMeta(id);
      setMetaStatus({ connected: false, appConfigured: true });
      setMetaAdAccounts([]);
      toast.success('Meta account disconnected');
    } catch (err) {
      toast.error('Failed to disconnect: ' + err.message);
    } finally {
      setMetaDisconnecting(false);
    }
  };

  const handleMetaSync = async () => {
    setMetaSyncing(true);
    try {
      const result = await api.syncMetaPerformance(id);
      toast.success(`Meta sync complete: ${result.synced || 0} ads synced`);
      await loadMetaStatus();
    } catch (err) {
      toast.error('Meta sync failed: ' + err.message);
    } finally {
      setMetaSyncing(false);
    }
  };

  const loadMetaAdAccounts = async () => {
    setMetaAccountsLoading(true);
    try {
      const { accounts } = await api.getMetaAdAccounts(id);
      setMetaAdAccounts(accounts || []);
    } catch (err) {
      toast.error('Failed to load ad accounts: ' + err.message);
    } finally {
      setMetaAccountsLoading(false);
    }
  };

  const handleSelectAdAccount = async (accountId) => {
    try {
      await api.selectMetaAdAccount(id, accountId);
      toast.success('Ad account selected');
      await loadMetaStatus();
    } catch (err) {
      toast.error('Failed to select account: ' + err.message);
    }
  };

  const handleSaveMetaCreds = async () => {
    if (!metaAppForm.meta_app_id?.trim()) {
      toast.error('Meta App ID is required');
      return;
    }
    if (!metaAppForm.meta_app_secret?.trim()) {
      toast.error('Meta App Secret is required');
      return;
    }
    setMetaAppSaving(true);
    try {
      await api.updateProject(id, {
        meta_app_id: metaAppForm.meta_app_id.trim(),
        meta_app_secret: metaAppForm.meta_app_secret.trim(),
      });
      toast.success('Meta credentials saved for this project');
      setMetaShowEditCreds(false);
      await loadMetaStatus();
    } catch (err) {
      toast.error('Failed to save credentials: ' + err.message);
    } finally {
      setMetaAppSaving(false);
    }
  };

  const loadProjectCosts = async () => {
    setCostsLoading(true);
    try {
      const data = await api.getProjectCosts(id);
      setProjectCosts(data);
    } catch (err) {
      console.error('Failed to load project costs:', err);
    } finally {
      setCostsLoading(false);
    }
  };

  const loadProject = async () => {
    try {
      const data = await api.getProject(id);
      setProject(data);
      setForm({
        name: data.name,
        brand_name: data.brand_name,
        niche: data.niche,
        product_description: data.product_description,
        sales_page_content: data.sales_page_content,
        drive_folder_id: data.drive_folder_id,
        inspiration_folder_id: data.inspiration_folder_id,
        prompt_guidelines: data.prompt_guidelines || ''
      });
      setMetaAppForm({
        meta_app_id: data.meta_app_id || '',
        meta_app_secret: data.meta_app_secret || '',
      });
    } catch (err) {
      console.error('Failed to load project:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.updateProject(id, form);
      await loadProject();
      toast.success('Project saved');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm('Are you sure you want to delete this project? This cannot be undone.')) return;
    try {
      await api.deleteProject(id);
      navigate('/projects');
    } catch (err) {
      toast.error(err.message);
    }
  };

  if (loading) {
    return (
      <Layout>
        <div className="flex items-center gap-3 mb-6 animate-pulse">
          <div className="w-5 h-5 bg-gray-200 rounded" />
          <div className="h-7 w-48 bg-gray-200 rounded" />
          <div className="h-5 w-14 bg-gray-200 rounded-full" />
        </div>
        <div className="mb-6">
          <div className="h-8 w-64 bg-gray-100 rounded-xl animate-pulse" />
        </div>
        <div className="card p-6 animate-pulse">
          <div className="h-4 w-28 bg-gray-200 rounded mb-5" />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <div className="h-3 w-20 bg-gray-100 rounded mb-1" />
              <div className="h-4 w-32 bg-gray-200 rounded" />
            </div>
            <div>
              <div className="h-3 w-16 bg-gray-100 rounded mb-1" />
              <div className="h-4 w-24 bg-gray-200 rounded" />
            </div>
          </div>
          <div className="mt-4">
            <div className="h-3 w-28 bg-gray-100 rounded mb-1" />
            <div className="h-12 w-full bg-gray-100 rounded" />
          </div>
        </div>
      </Layout>
    );
  }

  if (!project) {
    return (
      <Layout>
        <div className="text-center py-16">
          <p className="text-textmid text-sm mb-4">Project not found</p>
          <Link to="/projects" className="text-gold hover:text-gold text-sm transition-colors">Back to Projects</Link>
        </div>
      </Layout>
    );
  }

  const allTabs = [
    { id: 'quotes', label: 'Copywriter', tooltip: 'Mine quotes, generate headlines, and turn them into ads.' },
    { id: 'ads', label: 'Ad Studio', tooltip: 'Generate individual ads or run batch generation.' },
    { id: 'lpgen', label: 'LP Generator', tooltip: 'Generate landing page copy from foundational docs + swipe file.' },
    { id: 'tracker', label: 'Ad Pipeline', tooltip: 'Plan, organize, and deploy ads to campaigns and ad sets.' },
    { id: 'overview', label: 'Project Settings', tooltip: 'Project configuration, foundational docs, and template library.' }
  ];

  // Poster only sees Ad Pipeline tab
  const tabs = user?.role === 'poster'
    ? allTabs.filter(t => t.id === 'tracker')
    : allTabs;

  const status = STATUS_CONFIG[project.status] || { label: project.status, bg: 'bg-gray-100', text: 'text-textmid' };

  return (
    <Layout>
      <div className="flex items-center gap-3 mb-6">
        <Link to="/projects" className="text-textlight hover:text-textmid transition-colors">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </Link>
        <h1 className="text-2xl font-semibold text-textdark tracking-tight">{project.name}</h1>
        <span className={`badge ${status.bg} ${status.text}`}>
          {status.label}
        </span>
      </div>

      {/* Tab navigation — segmented control style */}
      <div className="mb-6">
        <div className="segmented-control">
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={tab === t.id ? 'active' : ''}
            >
              {t.label}
              {t.tooltip && <InfoTooltip text={t.tooltip} position="bottom" />}
            </button>
          ))}
        </div>
      </div>

      <div className="fade-in">
        {/* Docs needed alert */}
        {!project.docCount && (
          <div className="mb-4 p-3 bg-gold/5 border border-gold/20 rounded-xl flex items-center gap-2">
            <svg className="w-4 h-4 text-gold flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="text-[12px] text-gold font-medium">
              Foundational documents needed — add research docs to improve ad quality.
            </span>
            <button onClick={() => { setTab('overview'); setSettingsSubTab('docs'); }} className="ml-auto text-[11px] text-gold hover:text-gold-light font-medium whitespace-nowrap">
              Add Docs →
            </button>
          </div>
        )}

        {/* Project Settings tab */}
        {tab === 'overview' && (
          <>
          {/* Sub-tabs */}
          <div className="flex gap-1 p-0.5 bg-offwhite rounded-lg mb-5">
            {[
              { id: 'general', label: 'General' },
              { id: 'docs', label: 'Foundational Docs' },
              { id: 'filter', label: 'Creative Filter' },
              { id: 'templates', label: 'Template Library' },
            ].map(st => (
              <button
                key={st.id}
                onClick={() => setSettingsSubTab(st.id)}
                className={`px-3 py-1.5 rounded-md text-[12px] font-medium transition-all ${
                  settingsSubTab === st.id
                    ? 'bg-navy text-white shadow-sm'
                    : 'text-textmid hover:text-textdark'
                }`}
              >
                {st.label}
              </button>
            ))}
          </div>

          {settingsSubTab === 'general' && (
          <>
          <div className="card p-6">
            <div className="flex justify-between items-start mb-5">
              <h2 className="text-[15px] font-semibold text-textdark tracking-tight">Project Details</h2>
              <div className="flex gap-2">
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="btn-primary text-[13px]"
                >
                  {saving ? 'Saving...' : 'Save'}
                </button>
                <button
                  onClick={handleDelete}
                  className="btn-secondary text-[13px] text-red-500 hover:text-red-600"
                >
                  Delete
                </button>
              </div>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-[13px] font-medium text-textmid mb-1.5">Project Name</label>
                <input
                  value={form.name}
                  onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                  className="input-apple"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-[13px] font-medium text-textmid mb-1.5">Brand Name</label>
                  <input
                    value={form.brand_name}
                    onChange={e => setForm(p => ({ ...p, brand_name: e.target.value }))}
                    className="input-apple"
                  />
                </div>
                <div>
                  <label className="block text-[13px] font-medium text-textmid mb-1.5">Niche</label>
                  <input
                    value={form.niche}
                    onChange={e => setForm(p => ({ ...p, niche: e.target.value }))}
                    className="input-apple"
                  />
                </div>
              </div>
              <div>
                <label className="block text-[13px] font-medium text-textmid mb-1.5">Product Description</label>
                <textarea
                  value={form.product_description}
                  onChange={e => setForm(p => ({ ...p, product_description: e.target.value }))}
                  rows={3}
                  className="input-apple resize-none"
                />
              </div>

              {/* Product Image */}
              <div>
                <label className="block text-[13px] font-medium text-textmid mb-1.5">
                  Product Image
                  <InfoTooltip text="Stored at the project level — automatically used in every ad so Gemini renders your real product. You can still override per-ad in Ad Studio." position="right" />
                </label>

                {project.productImageUrl ? (
                  <div className="flex items-center gap-4 p-3 bg-gray-50/50 border border-gray-200/60 rounded-xl">
                    <img
                      src={project.productImageUrl}
                      alt="Product"
                      className="w-16 h-16 object-cover rounded-lg border border-gray-200/60"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-[12px] font-medium text-textdark">Current product image</p>
                      <p className="text-[10px] text-textlight">Used in all ads unless overridden</p>
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => productFileInputRef.current?.click()}
                        disabled={productImageUploading}
                        className="text-[11px] text-gold hover:text-gold transition-colors"
                      >
                        {productImageUploading ? 'Uploading...' : 'Replace'}
                      </button>
                      <button
                        type="button"
                        onClick={handleProductDelete}
                        disabled={productImageDeleting || productImageUploading}
                        className="text-[11px] text-red-400 hover:text-red-500 transition-colors"
                      >
                        {productImageDeleting ? 'Removing...' : 'Remove'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <div
                    onClick={() => !productImageUploading && productFileInputRef.current?.click()}
                    onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setProductDragOver(true); }}
                    onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); setProductDragOver(true); }}
                    onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); setProductDragOver(false); }}
                    onDrop={handleProductDrop}
                    className={`border-2 border-dashed rounded-xl p-4 text-center cursor-pointer transition-all ${
                      productDragOver ? 'border-gold bg-gold/5' :
                      'border-black/10 hover:border-gold hover:bg-offwhite'
                    }`}
                  >
                    <svg className="w-6 h-6 mx-auto mb-1.5 text-textlight/60" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5a2.25 2.25 0 002.25-2.25V6.75a2.25 2.25 0 00-2.25-2.25H3.75a2.25 2.25 0 00-2.25 2.25v12a2.25 2.25 0 002.25 2.25z" />
                    </svg>
                    {productImageUploading ? (
                      <p className="text-[11px] font-medium text-gold">Uploading...</p>
                    ) : (
                      <>
                        <p className={`text-[11px] font-medium ${productDragOver ? 'text-gold' : 'text-textmid'}`}>
                          {productDragOver ? 'Drop product image here' : 'Drop a product photo, or click to browse'}
                        </p>
                        <p className="text-[10px] text-textlight mt-0.5">Used in every ad — ensures Gemini renders your real product</p>
                      </>
                    )}
                  </div>
                )}
                <input
                  ref={productFileInputRef}
                  type="file"
                  accept=".jpg,.jpeg,.png,.webp,.gif"
                  onChange={e => { if (e.target.files?.[0]) { handleProductUpload(e.target.files[0]); e.target.value = ''; } }}
                  className="hidden"
                />
              </div>

              <div>
                <label className="block text-[13px] font-medium text-textmid mb-1.5">Sales Page Content</label>
                <textarea
                  value={form.sales_page_content}
                  onChange={e => setForm(p => ({ ...p, sales_page_content: e.target.value }))}
                  rows={6}
                  className="input-apple resize-none"
                />
              </div>
              <div>
                <label className="block text-[13px] font-medium text-textmid mb-1.5">
                  Prompt Guidelines
                </label>
                <textarea
                  value={form.prompt_guidelines}
                  onChange={e => setForm(p => ({ ...p, prompt_guidelines: e.target.value }))}
                  rows={3}
                  className="input-apple resize-none"
                  placeholder='e.g., "Only show one type of produce at a time — never mix fruits/vegetables in the same image"'
                />
                <p className="text-[11px] text-textlight mt-1">
                  Rules that AI will enforce on every generated image prompt. Use this to fix recurring issues in your ads.
                </p>
              </div>

              <div className="flex gap-8 pt-3 border-t border-gray-100/80">
                <div>
                  <p className="text-[12px] text-textlight mb-0.5">Documents</p>
                  <p className="text-xl font-semibold text-textdark">{project.docCount || 0}</p>
                </div>
                <div>
                  <p className="text-[12px] text-textlight mb-0.5">Ads Generated</p>
                  <p className="text-xl font-semibold text-textdark">{project.adCount || 0}</p>
                </div>
                <div>
                  <p className="text-[12px] text-textlight mb-0.5">API Spend</p>
                  <p className="text-xl font-semibold text-textdark">
                    ${projectCosts?.month?.total?.toFixed(2) || '0.00'}
                  </p>
                </div>
                <div>
                  <p className="text-[12px] text-textlight mb-0.5">Cost per Ad</p>
                  <p className="text-xl font-semibold text-textdark">
                    ${projectCosts?.costPerAd?.toFixed(3) || '0.000'}
                  </p>
                </div>
              </div>
            </div>
          </div>

          {/* Project Cost Tracking */}
          <div className="mt-6">
            <h3 className="text-[15px] font-semibold text-textdark tracking-tight mb-4">Project Costs</h3>
            <CostSummaryCards costs={projectCosts} loading={costsLoading} />
          </div>

          {/* Meta Ads Connection (per-project) */}
          <div className="mt-6 card p-6">
            <div className="flex items-center gap-2 mb-1">
              <div className="w-6 h-6 rounded-lg bg-navy/10 flex items-center justify-center">
                <svg className="w-3.5 h-3.5 text-gold" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2.04C6.5 2.04 2 6.53 2 12.06C2 17.06 5.66 21.21 10.44 21.96V14.96H7.9V12.06H10.44V9.85C10.44 7.34 11.93 5.96 14.22 5.96C15.31 5.96 16.45 6.15 16.45 6.15V8.62H15.19C13.95 8.62 13.56 9.39 13.56 10.18V12.06H16.34L15.89 14.96H13.56V21.96A10 10 0 0022 12.06C22 6.53 17.5 2.04 12 2.04Z" />
                </svg>
              </div>
              <h2 className="text-[15px] font-semibold text-textdark tracking-tight">Meta Ads</h2>
              {metaStatus?.connected ? (
                <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-teal/10 text-teal">Connected</span>
              ) : (
                <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-gray-100 text-textmid">Not Connected</span>
              )}
              <InfoTooltip text="Connect this project's Meta (Facebook) Ads account to pull live performance data. Each project can have its own Meta login and ad account." />
            </div>
            <p className="text-[12px] text-textmid mb-4">
              Pull live ad performance data (impressions, clicks, spend, CTR, CPC, ROAS) from Meta Ads for this project.
            </p>

            {metaStatus?.connected ? (
              /* ── Connected State ── */
              <div className="space-y-4">
                <div className="bg-teal/5 border border-teal/15 rounded-xl p-4 space-y-2">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-teal" />
                    <span className="text-[13px] font-medium text-teal">
                      {metaStatus.userName || 'Meta Account'}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-textmid">
                    {metaStatus.adAccountId && (
                      <div>
                        <span className="text-textlight">Ad Account:</span>{' '}
                        <span className="text-textmid font-medium">{metaStatus.adAccountId}</span>
                      </div>
                    )}
                    {metaStatus.tokenExpiresAt && (
                      <div>
                        <span className="text-textlight">Token Expires:</span>{' '}
                        <span className="text-textmid font-medium">
                          {new Date(metaStatus.tokenExpiresAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                        </span>
                      </div>
                    )}
                    {metaStatus.lastSyncAt && (
                      <div>
                        <span className="text-textlight">Last Sync:</span>{' '}
                        <span className="text-textmid font-medium">
                          {new Date(metaStatus.lastSyncAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Ad Account Selector (if connected but no account chosen) */}
                {!metaStatus.adAccountId && (
                  <div className="bg-gold/5 border border-gold/15 rounded-xl p-4">
                    <p className="text-[12px] text-gold font-medium mb-2">Select an Ad Account</p>
                    <p className="text-[11px] text-gold/80 mb-3">Choose which ad account to pull data from.</p>
                    {metaAdAccounts.length === 0 ? (
                      <button
                        onClick={loadMetaAdAccounts}
                        disabled={metaAccountsLoading}
                        className="btn-primary text-[12px] px-4 py-1.5"
                      >
                        {metaAccountsLoading ? 'Loading...' : 'Load Ad Accounts'}
                      </button>
                    ) : (
                      <div className="space-y-1.5">
                        {metaAdAccounts.map(acct => (
                          <button
                            key={acct.id}
                            onClick={() => handleSelectAdAccount(acct.id)}
                            className="w-full text-left px-3 py-2 rounded-lg border border-black/10 hover:border-navy/30 hover:bg-navy/5 transition-colors"
                          >
                            <span className="text-[12px] font-medium text-textdark">{acct.name}</span>
                            <span className="text-[10px] text-textlight ml-2">{acct.id}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Action buttons */}
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleMetaSync}
                    disabled={metaSyncing}
                    className="btn-secondary text-[13px] inline-flex items-center gap-1.5"
                  >
                    {metaSyncing ? (
                      <>
                        <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4 31.4" strokeLinecap="round" />
                        </svg>
                        Syncing...
                      </>
                    ) : 'Sync Now'}
                  </button>
                  {metaStatus.adAccountId && (
                    <button
                      onClick={async () => {
                        setMetaAdAccounts([]);
                        await loadMetaAdAccounts();
                      }}
                      disabled={metaAccountsLoading}
                      className="btn-secondary text-[13px]"
                    >
                      {metaAccountsLoading ? 'Loading...' : 'Change Ad Account'}
                    </button>
                  )}
                  <button
                    onClick={handleMetaDisconnect}
                    disabled={metaDisconnecting}
                    className="text-[12px] text-red-500 hover:text-red-600 hover:underline ml-auto"
                  >
                    {metaDisconnecting ? 'Disconnecting...' : 'Disconnect'}
                  </button>
                </div>

                {/* Show ad account picker if Change Ad Account was clicked */}
                {metaStatus.adAccountId && metaAdAccounts.length > 0 && (
                  <div className="border border-gray-200 rounded-xl p-3 space-y-1.5">
                    <p className="text-[11px] font-medium text-textmid mb-2">Select Ad Account</p>
                    {metaAdAccounts.map(acct => (
                      <button
                        key={acct.id}
                        onClick={() => { handleSelectAdAccount(acct.id); setMetaAdAccounts([]); }}
                        className={`w-full text-left px-3 py-2 rounded-lg border transition-colors ${
                          acct.id === metaStatus.adAccountId
                            ? 'border-navy/30 bg-navy/5'
                            : 'border-black/10 hover:border-navy/30 hover:bg-navy/5'
                        }`}
                      >
                        <span className="text-[12px] font-medium text-textdark">{acct.name}</span>
                        <span className="text-[10px] text-textlight ml-2">{acct.id}</span>
                        {acct.id === metaStatus.adAccountId && (
                          <span className="text-[9px] ml-2 px-1.5 py-0.5 rounded-full bg-navy/10 text-navy">Current</span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : metaStatus ? (
              /* ── Disconnected / Not Configured State ── */
              <div className="space-y-4">
                {/* Credential inputs — show if no app ID or if user wants to edit */}
                {(!metaStatus.appConfigured || metaShowEditCreds) && (
                  <div className="bg-gray-50/50 border border-gray-200/60 rounded-xl p-4 space-y-3">
                    <p className="text-[12px] font-medium text-textdark">
                      {metaStatus.appConfigured ? 'Edit Meta Developer Credentials' : 'Enter Meta Developer Credentials'}
                    </p>
                    <p className="text-[11px] text-textmid">
                      Each project can use its own Meta App. Create one at{' '}
                      <a href="https://developers.facebook.com" target="_blank" rel="noopener noreferrer" className="text-gold hover:underline">
                        developers.facebook.com
                      </a>{' '}
                      with Marketing API access and <code className="text-[10px] bg-gray-100 px-1 py-0.5 rounded">ads_read</code> permission.
                    </p>
                    <div>
                      <label className="block text-[11px] font-medium text-textmid mb-1">Meta App ID</label>
                      <input
                        type="text"
                        value={metaAppForm.meta_app_id}
                        onChange={(e) => setMetaAppForm(p => ({ ...p, meta_app_id: e.target.value }))}
                        className="input-apple text-[13px]"
                        placeholder="Enter your Meta App ID"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-medium text-textmid mb-1">Meta App Secret</label>
                      <input
                        type="password"
                        value={metaAppForm.meta_app_secret}
                        onChange={(e) => setMetaAppForm(p => ({ ...p, meta_app_secret: e.target.value }))}
                        className="input-apple text-[13px]"
                        placeholder="Enter your Meta App Secret"
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={handleSaveMetaCreds}
                        disabled={metaAppSaving}
                        className="btn-primary text-[12px] px-4 py-1.5"
                      >
                        {metaAppSaving ? 'Saving...' : 'Save Credentials'}
                      </button>
                      {metaShowEditCreds && (
                        <button
                          onClick={() => setMetaShowEditCreds(false)}
                          className="text-[12px] text-textlight hover:text-textmid"
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                  </div>
                )}

                {/* Connect button — only show if app is configured */}
                {metaStatus.appConfigured && !metaShowEditCreds && (
                  <div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={handleMetaConnect}
                        disabled={metaConnecting}
                        className="btn-primary text-[13px] inline-flex items-center gap-2 disabled:opacity-50"
                      >
                        {metaConnecting ? (
                          <>
                            <svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="31.4 31.4" strokeLinecap="round" />
                            </svg>
                            Connecting...
                          </>
                        ) : (
                          <>
                            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
                              <path d="M12 2.04C6.5 2.04 2 6.53 2 12.06C2 17.06 5.66 21.21 10.44 21.96V14.96H7.9V12.06H10.44V9.85C10.44 7.34 11.93 5.96 14.22 5.96C15.31 5.96 16.45 6.15 16.45 6.15V8.62H15.19C13.95 8.62 13.56 9.39 13.56 10.18V12.06H16.34L15.89 14.96H13.56V21.96A10 10 0 0022 12.06C22 6.53 17.5 2.04 12 2.04Z" />
                            </svg>
                            Connect Meta Account
                          </>
                        )}
                      </button>
                      <button
                        onClick={() => setMetaShowEditCreds(true)}
                        className="text-[11px] text-textlight hover:text-textmid hover:underline"
                      >
                        Edit Credentials
                      </button>
                    </div>
                    <p className="text-[11px] text-textlight mt-2">
                      Starts the OAuth flow using this project's Meta App credentials.
                    </p>
                  </div>
                )}
              </div>
            ) : null}
          </div>

          </>
          )}

          {settingsSubTab === 'docs' && (
            <ErrorBoundary level="tab" key="docs">
              <FoundationalDocs projectId={id} projectStatus={project.status} />
            </ErrorBoundary>
          )}
          {settingsSubTab === 'filter' && (
            <CreativeFilterSettings projectId={id} project={project} onSave={loadProject} />
          )}
          {settingsSubTab === 'templates' && (
            <ErrorBoundary level="tab" key="templates">
              <TemplateImages projectId={id} inspirationFolderId={project.inspiration_folder_id} />
            </ErrorBoundary>
          )}
          </>
        )}
        {tab === 'ads' && (
          <ErrorBoundary level="tab" key="ads">
            <AdStudio projectId={id} project={project} prefill={adStudioPrefill} onPrefillConsumed={() => setAdStudioPrefill(null)} />
          </ErrorBoundary>
        )}
        {tab === 'tracker' && (
          <ErrorBoundary level="tab" key="tracker">
            <AdTracker projectId={id} userRole={user?.role} searchParams={searchParams} setSearchParams={setSearchParams} />
          </ErrorBoundary>
        )}
        {tab === 'lpgen' && (
          <ErrorBoundary level="tab" key="lpgen">
            <LPGen projectId={id} project={project} />
          </ErrorBoundary>
        )}
        {tab === 'quotes' && (
          <ErrorBoundary level="tab" key="quotes">
            <QuoteMiner
              projectId={id}
              project={project}
              onNavigateToTracker={() => setTab('tracker')}
              onSendToAdStudio={(data) => {
                setAdStudioPrefill(data);
                setTab('ads');
              }}
            />
          </ErrorBoundary>
        )}
      </div>

      {/* Floating Copywriter Chat Widget */}
      <CopywriterChat projectId={id} projectName={project.name} />
    </Layout>
  );
}

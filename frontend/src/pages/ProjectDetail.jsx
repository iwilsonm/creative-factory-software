import { useState, useEffect, useRef, useCallback, useContext, lazy, Suspense } from 'react';
import { useParams, useNavigate, Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { AuthContext } from '../App';
import Layout from '../components/Layout';
import CostSummaryCards from '../components/CostSummaryCards';
import InfoTooltip from '../components/InfoTooltip';
import ErrorBoundary from '../components/ErrorBoundary';
import ConfirmDialog from '../components/ConfirmDialog';
import { useToast } from '../components/Toast';

// Lazy-load heavy tab components — only the active tab's code is downloaded
const FoundationalDocs = lazy(() => import('../components/FoundationalDocs'));
const TemplateImages = lazy(() => import('../components/TemplateImages'));
const AdStudio = lazy(() => import('../components/AdStudio'));
const AdTracker = lazy(() => import('./AdTracker'));
const CreativeFilterSettings = lazy(() => import('../components/CreativeFilterSettings'));
// Phase 6 — Staging tab removed; ad-set lifecycle is now unified into the
// Ad Pipeline tab (Planner / Ready to Post / Posted). StagingPage.jsx is deleted.
const CreativeDirectorSettings = lazy(() => import('../components/CreativeDirectorSettings'));
// Phase 2A — Meta integration sub-tab in Project Settings
const MetaConnectPanel = lazy(() => import('../components/MetaConnectPanel'));
// Phase 5 — Notion-style Analytics tab
const AnalyticsTab = lazy(() => import('../components/AnalyticsTab'));
// Phase 3 — Observation tab + settings
const ObservationTab = lazy(() => import('../components/ObservationTab'));
const ObservationSettings = lazy(() => import('../components/ObservationSettings'));
const RecentAgentActivity = lazy(() => import('../components/RecentAgentActivity'));

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
  const [deletingProject, setDeletingProject] = useState(false);
  const [availableDocTypes, setAvailableDocTypes] = useState(new Set());
  // Phase 6 — Staging tab removed; ad-set lifecycle is unified inside the
  // Ad Pipeline tab. The legacy `enable_phase1_staging:<projectId>` settings
  // flag is no longer read.
  const [conductorAngles, setConductorAngles] = useState([]);

  // Persist active tab in URL search params so it survives page refresh.
  // Phase 6 — `'staging'` removed from validTabs. Server-side redirect below
  // catches any bookmarked ?tab=staging URLs and redirects to defaultTab.
  const validTabs = ['ads', 'tracker', 'overview', 'docs', 'templates', 'analytics', 'observation'];
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

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // Product image state
  const [productImageUploading, setProductImageUploading] = useState(false);
  const [productImageDeleting, setProductImageDeleting] = useState(false);
  // settingsSubTab persists in URL `?subtab=` so refresh holds position.
  const validSubTabs = ['general', 'docs', 'filter', 'creative_director', 'meta', 'observation', 'templates'];
  const subTabFromUrl = searchParams.get('subtab');
  const [settingsSubTab, setSettingsSubTabState] = useState(
    subTabFromUrl && validSubTabs.includes(subTabFromUrl) ? subTabFromUrl : 'general'
  );
  const setSettingsSubTab = useCallback((newSubTab) => {
    setSettingsSubTabState(newSubTab);
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.set('subtab', newSubTab);
      return next;
    }, { replace: true });
  }, [setSearchParams]);
  const openPipelineQueue = useCallback(() => {
    setTabState('tracker');
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.set('tab', 'tracker');
      next.set('view', 'campaigns');
      return next;
    }, { replace: true });
  }, [setSearchParams]);
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
  }, [id]);

  useEffect(() => {
    if (tab === 'overview' && id) {
      loadProjectCosts();
      loadProjectStats();
    }
  }, [tab, id]);

  // Phase 6 — staging feature flag no longer read. Just load conductor angles
  // for any UI that needs the angle list.
  useEffect(() => {
    if (!id) return;
    (async () => {
      try {
        const angles = await api.getConductorAngles(id);
        setConductorAngles(Array.isArray(angles) ? angles : []);
      } catch { setConductorAngles([]); }
    })();
  }, [id]);

  // Phase 6 — server-side redirect for legacy ?tab=staging URLs (bookmarks etc).
  // Runs synchronously during URL parse, before any tab body renders, so no flash.
  useEffect(() => {
    if (tabFromUrl === 'staging') {
      setSearchParams(prev => {
        const next = new URLSearchParams(prev);
        next.set('tab', defaultTab);
        return next;
      }, { replace: true });
      setTabState(defaultTab);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const loadProjectStats = async () => {
    try {
      const stats = await api.getProjectStats(id);
      setProject(prev => ({ ...(prev || {}), ...stats }));
    } catch (err) {
      console.error('Failed to load project stats:', err);
    }
  };

  const loadProject = async () => {
    try {
      const data = await api.getProject(id);
      setProject(prev => prev ? { ...prev, ...data } : data);
      setForm({
        name: data.name,
        brand_name: data.brand_name,
        niche: data.niche,
        product_description: data.product_description,
        drive_folder_id: data.drive_folder_id,
        inspiration_folder_id: data.inspiration_folder_id,
        prompt_guidelines: data.prompt_guidelines || ''
      });
      // Fetch doc types for setup banner (only when needed)
      if (data.status === 'setup') {
        api.getDocs(id).then(res => {
          const types = new Set((res?.docs || []).map(d => d.doc_type).filter(Boolean));
          setAvailableDocTypes(types);
        }).catch(() => {});
      }
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

  // Phase 6 — staging-flag handling removed. CreativeDirectorSettings no longer
  // exposes a staging toggle (the unified pipeline replaces it).
  const handleCreativeDirectorSaved = async () => {
    await loadProject();
  };

  const handleDelete = async () => {
    setDeletingProject(true);
    try {
      await api.deleteProject(id);
      setShowDeleteConfirm(false);
      navigate('/projects');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setDeletingProject(false);
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

  // Phase 6 — Staging tab removed; ad-set lifecycle (draft / ready / posted /
  // observing / terminal) lives inside the unified Ad Pipeline tab.
  const allTabs = [
    { id: 'ads', label: 'Ad Studio', tooltip: 'Generate individual ads or run batch generation.' },
    { id: 'tracker', label: 'Ad Pipeline', tooltip: 'Plan, organize, and deploy ad sets to campaigns. Combines what was previously Planner + Staging + Ready-to-Post + Posted.' },
    { id: 'analytics', label: 'Analytics', tooltip: 'Notion-style table of campaigns / ad sets / ads from Meta with tagging and saved views.' },
    { id: 'observation', label: 'Observation', tooltip: 'Track posted ad sets through the 12-day observation window. Verdicts feed angle archive.' },
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
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-semibold text-textdark tracking-tight">{project.brand_name || project.name}</h1>
          {project.brand_name && project.name && (
            <p className="text-[13px] text-textmid mt-0.5">{project.name}</p>
          )}
        </div>
        <span className={`badge ${status.bg} ${status.text}`}>
          {status.label}
        </span>
      </div>

      {/* Setup banner — visible only when project needs foundational docs */}
      {project.status === 'setup' && (
        <div className="mb-6 p-4 bg-gold/5 border border-gold/20 rounded-xl fade-in">
          <p className="text-[13px] font-medium text-textdark mb-3">Complete foundational docs to get started</p>
          <div className="grid grid-cols-2 gap-2 mb-3">
            {[
              { key: 'research', label: 'Research' },
              { key: 'avatar', label: 'Customer Avatar' },
              { key: 'offer_brief', label: 'Offer Brief' },
              { key: 'necessary_beliefs', label: 'Necessary Beliefs' },
            ].map(doc => (
              <div key={doc.key} className="flex items-center gap-2 text-[12px]">
                {availableDocTypes.has(doc.key) ? (
                  <svg className="w-4 h-4 text-teal flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                ) : (
                  <div className="w-4 h-4 rounded-full border-2 border-gold/40 flex-shrink-0" />
                )}
                <span className={availableDocTypes.has(doc.key) ? 'text-teal font-medium' : 'text-textmid'}>{doc.label}</span>
              </div>
            ))}
          </div>
          <button
            onClick={() => { setTab('overview'); setSettingsSubTab('docs'); }}
            className="btn-primary text-[12px] px-4 py-1.5"
          >
            Generate Docs
          </button>
        </div>
      )}

      {/* Tab navigation — full-width Apple-style segmented control */}
      <div className="mb-6">
        <div className="page-tabs">
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

      <Suspense fallback={
        <div className="flex items-center justify-center py-16">
          <svg className="w-5 h-5 text-navy animate-spin" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2.5" strokeDasharray="31.4 31.4" strokeLinecap="round" />
          </svg>
        </div>
      }>
      <div className="fade-in">
        {/* Project Settings tab */}
        {tab === 'overview' && (
          <>
          {/* Sub-tabs */}
          <div className="tab-strip mb-5">
            {[
              { id: 'general', label: 'General' },
              { id: 'docs', label: 'Foundational Docs' },
              { id: 'filter', label: 'Creative Filter' },
              { id: 'creative_director', label: 'Creative Director' },
              { id: 'meta', label: 'Meta' },
              { id: 'observation', label: 'Observation' },
              { id: 'templates', label: 'Template Library' },
            ].map(st => (
              <button
                key={st.id}
                onClick={() => setSettingsSubTab(st.id)}
                className={`tab-chip ${
                  settingsSubTab === st.id
                    ? 'active'
                    : ''
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
                  onClick={() => setShowDeleteConfirm(true)}
                  className="action-link-danger"
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
                    className={`border-2 border-dashed rounded-xl p-4 text-center cursor-pointer group transition-all duration-300 ${
                      productDragOver ? 'border-navy bg-navy/5' :
                      'border-navy/20 hover:border-navy hover:bg-navy/5'
                    }`}
                  >
                    <svg className="w-6 h-6 mx-auto mb-1.5 text-textlight/60 group-hover:scale-110 group-hover:text-navy transition-all duration-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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

          <ErrorBoundary level="tab" key="recent_agent_activity">
            <RecentAgentActivity projectId={id} />
          </ErrorBoundary>

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
          {settingsSubTab === 'creative_director' && (
            <ErrorBoundary level="tab" key="creative_director">
              <CreativeDirectorSettings project={project} onSaved={handleCreativeDirectorSaved} />
            </ErrorBoundary>
          )}
          {settingsSubTab === 'meta' && (
            <ErrorBoundary level="tab" key="meta">
              <MetaConnectPanel projectId={id} />
            </ErrorBoundary>
          )}
          {settingsSubTab === 'observation' && (
            <ErrorBoundary level="tab" key="observation_settings">
              <ObservationSettings projectId={id} />
            </ErrorBoundary>
          )}
          {settingsSubTab === 'templates' && (
            <ErrorBoundary level="tab" key="templates">
              <TemplateImages projectId={id} />
            </ErrorBoundary>
          )}
          </>
        )}
        {tab === 'ads' && (
          <ErrorBoundary level="tab" key="ads">
            <AdStudio projectId={id} project={project} onOpenPipeline={openPipelineQueue} />
          </ErrorBoundary>
        )}
        {tab === 'tracker' && (
          <ErrorBoundary level="tab" key="tracker">
            <AdTracker projectId={id} userRole={user?.role} searchParams={searchParams} setSearchParams={setSearchParams} />
          </ErrorBoundary>
        )}
        {/* Phase 6 — Staging tab removed. Ad-set lifecycle is now inside Ad Pipeline. */}
        {tab === 'analytics' && (
          <ErrorBoundary level="tab" key="analytics">
            <AnalyticsTab projectId={id} />
          </ErrorBoundary>
        )}
        {tab === 'observation' && (
          <ErrorBoundary level="tab" key="observation">
            <ObservationTab projectId={id} />
          </ErrorBoundary>
        )}
      </div>

      <ConfirmDialog
        open={showDeleteConfirm}
        title="Delete project?"
        message="This will permanently delete the project and its related data. This action cannot be undone."
        confirmLabel="Delete Project"
        busy={deletingProject}
        onCancel={() => setShowDeleteConfirm(false)}
        onConfirm={handleDelete}
      />
      </Suspense>
    </Layout>
  );
}

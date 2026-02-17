import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../api';
import Layout from '../components/Layout';
import FoundationalDocs from '../components/FoundationalDocs';
import TemplateImages from '../components/TemplateImages';
import AdStudio from '../components/AdStudio';
import AdTracker from './AdTracker';
import CostSummaryCards from '../components/CostSummaryCards';
import InfoTooltip from '../components/InfoTooltip';
import DriveFolderPicker from '../components/DriveFolderPicker';
import { useToast } from '../components/Toast';

const STATUS_CONFIG = {
  setup: { label: 'Setup', bg: 'bg-amber-100/80', text: 'text-amber-700' },
  generating_docs: { label: 'Generating', bg: 'bg-blue-100/80', text: 'text-blue-700' },
  docs_ready: { label: 'Ready', bg: 'bg-green-100/80', text: 'text-green-700' },
  active: { label: 'Active', bg: 'bg-emerald-100/80', text: 'text-emerald-700' }
};

export default function ProjectDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState('ads');
  const [projectCosts, setProjectCosts] = useState(null);
  const [costsLoading, setCostsLoading] = useState(false);

  // Product image state
  const [productImageUploading, setProductImageUploading] = useState(false);
  const [productImageDeleting, setProductImageDeleting] = useState(false);
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
    }
  }, [tab, id]);

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
      setEditing(false);
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
          <p className="text-gray-500 text-sm mb-4">Project not found</p>
          <Link to="/projects" className="text-blue-500 hover:text-blue-600 text-sm transition-colors">Back to Projects</Link>
        </div>
      </Layout>
    );
  }

  const tabs = [
    { id: 'ads', label: 'Ad Studio', tooltip: 'Generate individual ads or run batch generation.' },
    { id: 'tracker', label: 'Ad Tracker', tooltip: 'Track ad deployments, campaigns, and performance.' },
    { id: 'overview', label: 'Overview', tooltip: 'Project settings, cost tracking, and stats.' },
    { id: 'docs', label: 'Foundational Docs', tooltip: 'Core research documents that guide ad generation.' },
    { id: 'templates', label: 'Template Library', tooltip: 'Reference images synced from Drive or uploaded directly.' }
  ];

  const status = STATUS_CONFIG[project.status] || { label: project.status, bg: 'bg-gray-100', text: 'text-gray-600' };

  return (
    <Layout>
      <div className="flex items-center gap-3 mb-6">
        <Link to="/projects" className="text-gray-400 hover:text-gray-600 transition-colors">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </Link>
        <h1 className="text-2xl font-semibold text-gray-900 tracking-tight">{project.name}</h1>
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
          <div className="mb-4 p-3 bg-amber-50/80 border border-amber-200/60 rounded-xl flex items-center gap-2">
            <svg className="w-4 h-4 text-amber-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="text-[12px] text-amber-700 font-medium">
              Foundational documents needed — add research docs to improve ad quality.
            </span>
            <button onClick={() => setTab('docs')} className="ml-auto text-[11px] text-amber-600 hover:text-amber-800 font-medium whitespace-nowrap">
              Add Docs →
            </button>
          </div>
        )}

        {/* Overview tab */}
        {tab === 'overview' && (
          <>
          <div className="card p-6">
            <div className="flex justify-between items-start mb-5">
              <h2 className="text-[15px] font-semibold text-gray-900 tracking-tight">Project Details</h2>
              <div className="flex gap-2">
                {editing ? (
                  <>
                    <button
                      onClick={handleSave}
                      disabled={saving}
                      className="btn-primary text-[13px]"
                    >
                      {saving ? 'Saving...' : 'Save'}
                    </button>
                    <button
                      onClick={() => setEditing(false)}
                      className="btn-secondary text-[13px]"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() => setEditing(true)}
                      className="btn-secondary text-[13px]"
                    >
                      Edit
                    </button>
                    <button
                      onClick={handleDelete}
                      className="btn-secondary text-[13px] text-red-500 hover:text-red-600"
                    >
                      Delete
                    </button>
                  </>
                )}
              </div>
            </div>

            {editing ? (
              <div className="space-y-4">
                <div>
                  <label className="block text-[13px] font-medium text-gray-600 mb-1.5">Project Name</label>
                  <input
                    value={form.name}
                    onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
                    className="input-apple"
                  />
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-[13px] font-medium text-gray-600 mb-1.5">Brand Name</label>
                    <input
                      value={form.brand_name}
                      onChange={e => setForm(p => ({ ...p, brand_name: e.target.value }))}
                      className="input-apple"
                    />
                  </div>
                  <div>
                    <label className="block text-[13px] font-medium text-gray-600 mb-1.5">Niche</label>
                    <input
                      value={form.niche}
                      onChange={e => setForm(p => ({ ...p, niche: e.target.value }))}
                      className="input-apple"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-[13px] font-medium text-gray-600 mb-1.5">Product Description</label>
                  <textarea
                    value={form.product_description}
                    onChange={e => setForm(p => ({ ...p, product_description: e.target.value }))}
                    rows={3}
                    className="input-apple resize-none"
                  />
                </div>

                {/* Product Image — edit mode */}
                <div>
                  <label className="block text-[13px] font-medium text-gray-600 mb-1.5">
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
                        <p className="text-[12px] font-medium text-gray-700">Current product image</p>
                        <p className="text-[10px] text-gray-400">Used in all ads unless overridden</p>
                      </div>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => productFileInputRef.current?.click()}
                          disabled={productImageUploading}
                          className="text-[11px] text-blue-500 hover:text-blue-600 transition-colors"
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
                        productDragOver ? 'border-blue-400 bg-blue-50/30' :
                        'border-gray-200/80 hover:border-blue-300 hover:bg-gray-50/30'
                      }`}
                    >
                      <svg className="w-6 h-6 mx-auto mb-1.5 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5a2.25 2.25 0 002.25-2.25V6.75a2.25 2.25 0 00-2.25-2.25H3.75a2.25 2.25 0 00-2.25 2.25v12a2.25 2.25 0 002.25 2.25z" />
                      </svg>
                      {productImageUploading ? (
                        <p className="text-[11px] font-medium text-blue-500">Uploading...</p>
                      ) : (
                        <>
                          <p className={`text-[11px] font-medium ${productDragOver ? 'text-blue-600' : 'text-gray-500'}`}>
                            {productDragOver ? 'Drop product image here' : 'Drop a product photo, or click to browse'}
                          </p>
                          <p className="text-[10px] text-gray-400 mt-0.5">Used in every ad — ensures Gemini renders your real product</p>
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
                  <label className="block text-[13px] font-medium text-gray-600 mb-1.5">Sales Page Content</label>
                  <textarea
                    value={form.sales_page_content}
                    onChange={e => setForm(p => ({ ...p, sales_page_content: e.target.value }))}
                    rows={6}
                    className="input-apple resize-none"
                  />
                </div>
                <div>
                  <label className="block text-[13px] font-medium text-gray-600 mb-1.5">
                    Prompt Guidelines
                  </label>
                  <textarea
                    value={form.prompt_guidelines}
                    onChange={e => setForm(p => ({ ...p, prompt_guidelines: e.target.value }))}
                    rows={3}
                    className="input-apple resize-none"
                    placeholder='e.g., "Only show one type of produce at a time — never mix fruits/vegetables in the same image"'
                  />
                  <p className="text-[11px] text-gray-400 mt-1">
                    Rules that AI will enforce on every generated image prompt. Use this to fix recurring issues in your ads.
                  </p>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <DriveFolderPicker
                    label="Output Folder"
                    value={form.drive_folder_id}
                    onChange={(val) => setForm(p => ({ ...p, drive_folder_id: val }))}
                  />
                  <DriveFolderPicker
                    label="Inspiration Folder"
                    value={form.inspiration_folder_id}
                    onChange={(val) => setForm(p => ({ ...p, inspiration_folder_id: val }))}
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <p className="text-[12px] text-gray-400 mb-0.5">Brand Name</p>
                    <p className="text-[14px] text-gray-900">{project.brand_name || '—'}</p>
                  </div>
                  <div>
                    <p className="text-[12px] text-gray-400 mb-0.5">Niche</p>
                    <p className="text-[14px] text-gray-900">{project.niche || '—'}</p>
                  </div>
                </div>
                <div>
                  <p className="text-[12px] text-gray-400 mb-0.5">Product Description</p>
                  <p className="text-[14px] text-gray-900 whitespace-pre-wrap">{project.product_description || '—'}</p>
                </div>

                {/* Product Image — view mode */}
                <div>
                  <p className="text-[12px] text-gray-400 mb-1">Product Image</p>
                  {project.productImageUrl ? (
                    <div className="flex items-center gap-3">
                      <img
                        src={project.productImageUrl}
                        alt="Product"
                        className="w-20 h-20 object-cover rounded-xl border border-gray-200/60 shadow-sm"
                      />
                      <div>
                        <p className="text-[12px] text-gray-600">Used in all generated ads</p>
                        <p className="text-[10px] text-gray-400">Override per-ad in Ad Studio</p>
                      </div>
                    </div>
                  ) : (
                    <p className="text-[13px] text-gray-400 italic">No product image set — click Edit to upload</p>
                  )}
                </div>

                {project.sales_page_content && (
                  <div>
                    <p className="text-[12px] text-gray-400 mb-0.5">Sales Page Content</p>
                    <p className="text-[13px] text-gray-600 max-h-40 overflow-y-auto whitespace-pre-wrap scrollbar-thin">
                      {project.sales_page_content.slice(0, 500)}
                      {project.sales_page_content.length > 500 ? '...' : ''}
                    </p>
                  </div>
                )}
                {project.prompt_guidelines && (
                  <div>
                    <p className="text-[12px] text-gray-400 mb-0.5">Prompt Guidelines</p>
                    <p className="text-[13px] text-gray-600 whitespace-pre-wrap bg-purple-50/40 border border-purple-200/40 rounded-xl p-3">
                      {project.prompt_guidelines}
                    </p>
                  </div>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <p className="text-[12px] text-gray-400 mb-0.5">Drive Output Folder</p>
                    <p className="text-[13px] text-gray-900 font-mono">{project.drive_folder_id || '—'}</p>
                  </div>
                  <div>
                    <p className="text-[12px] text-gray-400 mb-0.5">Templates Folder</p>
                    <p className="text-[13px] text-gray-900 font-mono">{project.inspiration_folder_id || '—'}</p>
                  </div>
                </div>
                <div className="flex gap-8 pt-3 border-t border-gray-100/80">
                  <div>
                    <p className="text-[12px] text-gray-400 mb-0.5">Documents</p>
                    <p className="text-xl font-semibold text-gray-900">{project.docCount || 0}</p>
                  </div>
                  <div>
                    <p className="text-[12px] text-gray-400 mb-0.5">Ads Generated</p>
                    <p className="text-xl font-semibold text-gray-900">{project.adCount || 0}</p>
                  </div>
                  <div>
                    <p className="text-[12px] text-gray-400 mb-0.5">API Spend</p>
                    <p className="text-xl font-semibold text-gray-900">
                      ${projectCosts?.month?.total?.toFixed(2) || '0.00'}
                    </p>
                  </div>
                  <div>
                    <p className="text-[12px] text-gray-400 mb-0.5">Cost per Ad</p>
                    <p className="text-xl font-semibold text-gray-900">
                      ${projectCosts?.costPerAd?.toFixed(3) || '0.000'}
                    </p>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Project Cost Tracking */}
          <div className="mt-6">
            <h3 className="text-[15px] font-semibold text-gray-900 tracking-tight mb-4">Project Costs</h3>
            <CostSummaryCards costs={projectCosts} loading={costsLoading} />
          </div>
          </>
        )}

        {tab === 'docs' && (
          <FoundationalDocs projectId={id} projectStatus={project.status} />
        )}
        {tab === 'templates' && (
          <TemplateImages projectId={id} inspirationFolderId={project.inspiration_folder_id} />
        )}
        {tab === 'ads' && (
          <AdStudio projectId={id} project={project} />
        )}
        {tab === 'tracker' && (
          <AdTracker projectId={id} />
        )}
      </div>
    </Layout>
  );
}

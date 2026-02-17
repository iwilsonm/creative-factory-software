import { useState, useEffect } from 'react';
import { api } from '../api';
import Layout from '../components/Layout';
import { useToast } from '../components/Toast';
import InfoTooltip from '../components/InfoTooltip';

const STATUS_ORDER = ['selected', 'scheduled', 'posted', 'analyzing'];
const STATUS_META = {
  selected:  { label: 'Selected',  color: 'bg-gray-100 text-gray-600',    dot: 'bg-gray-400' },
  scheduled: { label: 'Scheduled', color: 'bg-blue-50 text-blue-600',     dot: 'bg-blue-400' },
  posted:    { label: 'Posted',    color: 'bg-emerald-50 text-emerald-600', dot: 'bg-emerald-400' },
  analyzing: { label: 'Analyzing', color: 'bg-purple-50 text-purple-600', dot: 'bg-purple-400' },
};

const NEXT_STATUS = {
  selected: 'scheduled',
  scheduled: 'posted',
  posted: 'analyzing',
};

const NEXT_LABEL = {
  selected: 'Mark Scheduled',
  scheduled: 'Mark Posted',
  posted: 'Mark Analyzing',
};

export default function AdTracker() {
  const [tab, setTab] = useState('pipeline');
  const [deployments, setDeployments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('all');
  const [expandedId, setExpandedId] = useState(null);
  const [editFields, setEditFields] = useState({});
  const [saving, setSaving] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const { addToast } = useToast();

  useEffect(() => {
    loadDeployments();
  }, []);

  const loadDeployments = async () => {
    try {
      const data = await api.getDeployments();
      setDeployments(data.deployments || []);
    } catch (err) {
      console.error('Failed to load deployments:', err);
    } finally {
      setLoading(false);
    }
  };

  // ─── Filtering ──────────────────────────────────────────────────────────────
  const filtered = statusFilter === 'all'
    ? deployments
    : deployments.filter(d => d.status === statusFilter);

  // Sort: by status order, then by created_at descending
  const sorted = [...filtered].sort((a, b) => {
    const statusDiff = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
    if (statusDiff !== 0) return statusDiff;
    return new Date(b.created_at) - new Date(a.created_at);
  });

  // Status counts for filter pills
  const statusCounts = {};
  for (const d of deployments) {
    statusCounts[d.status] = (statusCounts[d.status] || 0) + 1;
  }

  // ─── Actions ────────────────────────────────────────────────────────────────
  const handleStatusChange = async (id, newStatus) => {
    try {
      await api.updateDeploymentStatus(id, newStatus);
      setDeployments(prev => prev.map(d =>
        d.id === id ? { ...d, status: newStatus, posted_date: newStatus === 'posted' ? new Date().toISOString() : d.posted_date } : d
      ));
      addToast(`Moved to ${STATUS_META[newStatus].label}`, 'success');
    } catch (err) {
      addToast('Failed to update status', 'error');
    }
  };

  const handleDelete = async (id) => {
    try {
      await api.deleteDeployment(id);
      setDeployments(prev => prev.filter(d => d.id !== id));
      setExpandedId(null);
      addToast('Deployment removed', 'success');
    } catch (err) {
      addToast('Failed to delete', 'error');
    }
  };

  const handleExpand = (dep) => {
    if (expandedId === dep.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(dep.id);
    setEditFields({
      campaign_name: dep.campaign_name || '',
      ad_set_name: dep.ad_set_name || '',
      ad_name: dep.ad_name || '',
      landing_page_url: dep.landing_page_url || '',
      notes: dep.notes || '',
      planned_date: dep.planned_date ? dep.planned_date.split('T')[0] : '',
    });
  };

  const handleSave = async (id) => {
    setSaving(true);
    try {
      const fields = {};
      for (const [key, val] of Object.entries(editFields)) {
        if (key === 'planned_date' && val) {
          fields[key] = new Date(val).toISOString();
        } else {
          fields[key] = val || undefined;
        }
      }
      await api.updateDeployment(id, fields);
      setDeployments(prev => prev.map(d =>
        d.id === id ? { ...d, ...fields } : d
      ));
      addToast('Saved', 'success');
    } catch (err) {
      addToast('Failed to save', 'error');
    } finally {
      setSaving(false);
    }
  };

  // ─── Bulk actions ───────────────────────────────────────────────────────────
  const toggleSelect = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleBulkStatus = async (newStatus) => {
    const ids = [...selectedIds];
    try {
      await Promise.all(ids.map(id => api.updateDeploymentStatus(id, newStatus)));
      setDeployments(prev => prev.map(d =>
        ids.includes(d.id) ? { ...d, status: newStatus } : d
      ));
      setSelectedIds(new Set());
      addToast(`${ids.length} moved to ${STATUS_META[newStatus].label}`, 'success');
    } catch (err) {
      addToast('Failed to update some deployments', 'error');
    }
  };

  const handleBulkDelete = async () => {
    const ids = [...selectedIds];
    try {
      await Promise.all(ids.map(id => api.deleteDeployment(id)));
      setDeployments(prev => prev.filter(d => !ids.includes(d.id)));
      setSelectedIds(new Set());
      addToast(`${ids.length} removed`, 'success');
    } catch (err) {
      addToast('Failed to delete some deployments', 'error');
    }
  };

  // ─── Render ─────────────────────────────────────────────────────────────────
  const tabs = [
    { id: 'pipeline', label: 'Pipeline' },
    { id: 'performance', label: 'Performance' },
  ];

  return (
    <Layout>
      {/* Page Header */}
      <div className="mb-6">
        <div className="flex items-center gap-2">
          <h1 className="text-2xl font-semibold text-gray-900 tracking-tight">Ad Tracker</h1>
          <InfoTooltip
            text="Track your ads from generation through deployment. Select ads in the Ad Studio, then manage their journey to Meta campaigns here."
            position="right"
          />
        </div>
        <p className="text-[13px] text-gray-500 mt-0.5">
          Manage ad deployments across campaigns and track performance
        </p>
      </div>

      {/* Sub-tabs */}
      <div className="segmented-control inline-flex mb-6">
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={tab === t.id ? 'active' : ''}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Pipeline Tab */}
      {tab === 'pipeline' && (
        <div className="fade-in">
          {/* Status filter pills */}
          <div className="flex items-center gap-2 mb-5 flex-wrap">
            <button
              onClick={() => setStatusFilter('all')}
              className={`px-3 py-1.5 rounded-full text-[12px] font-medium transition-colors ${
                statusFilter === 'all'
                  ? 'bg-gray-900 text-white'
                  : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
              }`}
            >
              All ({deployments.length})
            </button>
            {STATUS_ORDER.map(status => {
              const meta = STATUS_META[status];
              const count = statusCounts[status] || 0;
              return (
                <button
                  key={status}
                  onClick={() => setStatusFilter(status)}
                  className={`px-3 py-1.5 rounded-full text-[12px] font-medium transition-colors ${
                    statusFilter === status
                      ? 'bg-gray-900 text-white'
                      : `${meta.color} hover:opacity-80`
                  }`}
                >
                  {meta.label} ({count})
                </button>
              );
            })}
          </div>

          {/* Bulk action bar */}
          {selectedIds.size > 0 && (
            <div className="flex items-center gap-3 mb-4 p-3 bg-blue-50 rounded-xl border border-blue-100 fade-in">
              <span className="text-[12px] font-medium text-blue-700">
                {selectedIds.size} selected
              </span>
              <div className="flex items-center gap-2 ml-auto">
                {STATUS_ORDER.slice(1).map(status => (
                  <button
                    key={status}
                    onClick={() => handleBulkStatus(status)}
                    className="text-[11px] px-2.5 py-1 rounded-lg bg-white border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors"
                  >
                    → {STATUS_META[status].label}
                  </button>
                ))}
                <button
                  onClick={handleBulkDelete}
                  className="text-[11px] px-2.5 py-1 rounded-lg bg-red-50 border border-red-200 text-red-600 hover:bg-red-100 transition-colors"
                >
                  Delete
                </button>
                <button
                  onClick={() => setSelectedIds(new Set())}
                  className="text-[11px] px-2.5 py-1 rounded-lg text-gray-400 hover:text-gray-600 transition-colors"
                >
                  Clear
                </button>
              </div>
            </div>
          )}

          {/* Loading state */}
          {loading && (
            <div className="space-y-3">
              {[0, 1, 2].map(i => (
                <div key={i} className="card p-4 animate-pulse">
                  <div className="flex items-center gap-4">
                    <div className="w-16 h-16 bg-gray-200 rounded-lg" />
                    <div className="flex-1">
                      <div className="h-3 w-32 bg-gray-200 rounded mb-2" />
                      <div className="h-2 w-48 bg-gray-100 rounded" />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Empty state */}
          {!loading && deployments.length === 0 && (
            <div className="card p-12 text-center">
              <div className="w-14 h-14 rounded-2xl bg-gray-100 flex items-center justify-center mx-auto mb-4">
                <svg className="w-7 h-7 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15.59 14.37a6 6 0 01-5.84 7.38v-4.8m5.84-2.58a14.98 14.98 0 006.16-12.12A14.98 14.98 0 009.631 8.41m5.96 5.96a14.926 14.926 0 01-5.841 2.58m-.119-8.54a6 6 0 00-7.381 5.84h4.8m2.58-5.84a14.927 14.927 0 00-2.58 5.84m2.699 2.7c-.103.021-.207.041-.311.06a15.09 15.09 0 01-2.448-2.448 14.9 14.9 0 01.06-.312m-2.24 2.39a4.493 4.493 0 00-1.757 4.306 4.493 4.493 0 004.306-1.758M16.5 9a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0z" />
                </svg>
              </div>
              <h3 className="text-[15px] font-semibold text-gray-900 mb-1">No deployments yet</h3>
              <p className="text-[13px] text-gray-400 max-w-sm mx-auto">
                Select ads in the Ad Studio and click "Deploy" to start tracking them here.
              </p>
            </div>
          )}

          {/* Filtered empty state */}
          {!loading && deployments.length > 0 && sorted.length === 0 && (
            <div className="card p-8 text-center">
              <p className="text-[13px] text-gray-400">
                No deployments with status "{STATUS_META[statusFilter]?.label}".
              </p>
            </div>
          )}

          {/* Deployment list */}
          {!loading && sorted.length > 0 && (
            <div className="space-y-2">
              {sorted.map(dep => {
                const meta = STATUS_META[dep.status] || STATUS_META.selected;
                const isExpanded = expandedId === dep.id;
                const isSelected = selectedIds.has(dep.id);
                const nextStatus = NEXT_STATUS[dep.status];

                return (
                  <div key={dep.id} className={`card overflow-hidden transition-all ${isSelected ? 'ring-2 ring-blue-500 ring-offset-1' : ''}`}>
                    {/* Main row */}
                    <div
                      className="flex items-center gap-4 p-4 cursor-pointer hover:bg-gray-50/50 transition-colors"
                      onClick={() => handleExpand(dep)}
                    >
                      {/* Checkbox */}
                      <button
                        onClick={(e) => { e.stopPropagation(); toggleSelect(dep.id); }}
                        className={`w-[18px] h-[18px] rounded-md flex-shrink-0 flex items-center justify-center transition-colors ${
                          isSelected
                            ? 'bg-blue-500'
                            : 'border-2 border-gray-300 hover:border-blue-400'
                        }`}
                      >
                        {isSelected && (
                          <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                          </svg>
                        )}
                      </button>

                      {/* Thumbnail */}
                      {dep.imageUrl ? (
                        <img
                          src={dep.imageUrl}
                          alt=""
                          className="w-14 h-14 rounded-lg object-cover flex-shrink-0"
                        />
                      ) : (
                        <div className="w-14 h-14 rounded-lg bg-gray-100 flex items-center justify-center flex-shrink-0">
                          <svg className="w-5 h-5 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5" />
                          </svg>
                        </div>
                      )}

                      {/* Info */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="text-[13px] font-medium text-gray-900 truncate">
                            {dep.ad?.angle || dep.ad_name || 'Untitled Ad'}
                          </span>
                          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${meta.color}`}>
                            <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />
                            {meta.label}
                          </span>
                        </div>
                        <div className="flex items-center gap-3 text-[11px] text-gray-400">
                          {dep.projectName && (
                            <span>{dep.projectName}</span>
                          )}
                          {dep.campaign_name && (
                            <>
                              <span className="text-gray-200">|</span>
                              <span>{dep.campaign_name}</span>
                            </>
                          )}
                          {dep.ad_set_name && (
                            <>
                              <span className="text-gray-200">→</span>
                              <span>{dep.ad_set_name}</span>
                            </>
                          )}
                          {dep.planned_date && (
                            <>
                              <span className="text-gray-200">|</span>
                              <span>📅 {new Date(dep.planned_date).toLocaleDateString()}</span>
                            </>
                          )}
                        </div>
                      </div>

                      {/* Quick actions */}
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {nextStatus && (
                          <button
                            onClick={(e) => { e.stopPropagation(); handleStatusChange(dep.id, nextStatus); }}
                            className="text-[11px] px-3 py-1.5 rounded-lg bg-blue-50 text-blue-600 hover:bg-blue-100 transition-colors font-medium"
                          >
                            {NEXT_LABEL[dep.status]}
                          </button>
                        )}
                        <button
                          onClick={(e) => { e.stopPropagation(); handleDelete(dep.id); }}
                          className="text-gray-300 hover:text-red-500 hover:bg-red-50 transition-all p-1.5 rounded-lg"
                          title="Remove"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
                          </svg>
                        </button>
                        {/* Expand chevron */}
                        <svg
                          className={`w-4 h-4 text-gray-300 transition-transform duration-200 ${isExpanded ? 'rotate-180' : ''}`}
                          fill="none" stroke="currentColor" viewBox="0 0 24 24"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        </svg>
                      </div>
                    </div>

                    {/* Expanded edit panel */}
                    {isExpanded && (
                      <div className="border-t border-gray-100 p-4 bg-gray-50/30 fade-in">
                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-4">
                          {/* Campaign Name */}
                          <div>
                            <label className="block text-[11px] font-medium text-gray-400 uppercase tracking-wider mb-1">
                              Campaign Name
                            </label>
                            <input
                              type="text"
                              value={editFields.campaign_name || ''}
                              onChange={(e) => setEditFields(prev => ({ ...prev, campaign_name: e.target.value }))}
                              placeholder="e.g. Spring 2025 DTC"
                              className="input-apple text-[13px] w-full"
                            />
                          </div>

                          {/* Ad Set Name */}
                          <div>
                            <label className="block text-[11px] font-medium text-gray-400 uppercase tracking-wider mb-1">
                              Ad Set Name
                            </label>
                            <input
                              type="text"
                              value={editFields.ad_set_name || ''}
                              onChange={(e) => setEditFields(prev => ({ ...prev, ad_set_name: e.target.value }))}
                              placeholder="e.g. LAL - Purchasers"
                              className="input-apple text-[13px] w-full"
                            />
                          </div>

                          {/* Ad Name */}
                          <div>
                            <label className="block text-[11px] font-medium text-gray-400 uppercase tracking-wider mb-1">
                              Ad Name
                            </label>
                            <input
                              type="text"
                              value={editFields.ad_name || ''}
                              onChange={(e) => setEditFields(prev => ({ ...prev, ad_name: e.target.value }))}
                              placeholder="e.g. Trust Factor - V1"
                              className="input-apple text-[13px] w-full"
                            />
                          </div>

                          {/* Landing Page URL */}
                          <div>
                            <label className="block text-[11px] font-medium text-gray-400 uppercase tracking-wider mb-1">
                              Landing Page URL
                            </label>
                            <input
                              type="url"
                              value={editFields.landing_page_url || ''}
                              onChange={(e) => setEditFields(prev => ({ ...prev, landing_page_url: e.target.value }))}
                              placeholder="https://..."
                              className="input-apple text-[13px] w-full"
                            />
                          </div>

                          {/* Planned Date */}
                          <div>
                            <label className="block text-[11px] font-medium text-gray-400 uppercase tracking-wider mb-1">
                              Planned Post Date
                            </label>
                            <input
                              type="date"
                              value={editFields.planned_date || ''}
                              onChange={(e) => setEditFields(prev => ({ ...prev, planned_date: e.target.value }))}
                              className="input-apple text-[13px] w-full"
                            />
                          </div>

                          {/* Posted Date (read-only if auto-set) */}
                          {dep.posted_date && (
                            <div>
                              <label className="block text-[11px] font-medium text-gray-400 uppercase tracking-wider mb-1">
                                Posted Date
                              </label>
                              <p className="text-[13px] text-gray-600 py-2">
                                {new Date(dep.posted_date).toLocaleDateString()}
                              </p>
                            </div>
                          )}
                        </div>

                        {/* Notes */}
                        <div className="mb-4">
                          <label className="block text-[11px] font-medium text-gray-400 uppercase tracking-wider mb-1">
                            Notes
                          </label>
                          <textarea
                            value={editFields.notes || ''}
                            onChange={(e) => setEditFields(prev => ({ ...prev, notes: e.target.value }))}
                            placeholder="Add notes about this deployment..."
                            rows={3}
                            className="input-apple text-[13px] w-full resize-none"
                          />
                        </div>

                        {/* Ad details (read-only) */}
                        {dep.ad && (
                          <div className="border-t border-gray-100 pt-3 mb-4">
                            <p className="text-[10px] font-medium text-gray-300 uppercase tracking-wider mb-2">Ad Details</p>
                            <div className="flex flex-wrap gap-x-6 gap-y-1 text-[11px] text-gray-400">
                              {dep.ad.angle && <span>Angle: <strong className="text-gray-600">{dep.ad.angle}</strong></span>}
                              {dep.ad.aspect_ratio && <span>Ratio: <strong className="text-gray-600">{dep.ad.aspect_ratio}</strong></span>}
                              {dep.ad.generation_mode && <span>Mode: <strong className="text-gray-600">{dep.ad.generation_mode}</strong></span>}
                            </div>
                            {dep.ad.headline && (
                              <p className="text-[12px] text-gray-500 mt-1.5"><strong>Headline:</strong> {dep.ad.headline}</p>
                            )}
                            {dep.ad.body_copy && (
                              <p className="text-[12px] text-gray-500 mt-1 line-clamp-2"><strong>Body:</strong> {dep.ad.body_copy}</p>
                            )}
                          </div>
                        )}

                        {/* Save button */}
                        <div className="flex items-center gap-3">
                          <button
                            onClick={() => handleSave(dep.id)}
                            disabled={saving}
                            className="btn-primary text-[12px] px-4 py-1.5 disabled:opacity-50"
                          >
                            {saving ? 'Saving...' : 'Save Changes'}
                          </button>
                          <button
                            onClick={() => setExpandedId(null)}
                            className="btn-secondary text-[12px] px-4 py-1.5"
                          >
                            Close
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Performance Tab (placeholder) */}
      {tab === 'performance' && (
        <div className="fade-in">
          <div className="card p-12 text-center">
            <div className="w-14 h-14 rounded-2xl bg-purple-50 flex items-center justify-center mx-auto mb-4">
              <svg className="w-7 h-7 text-purple-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 13.125C3 12.504 3.504 12 4.125 12h2.25c.621 0 1.125.504 1.125 1.125v6.75C7.5 20.496 6.996 21 6.375 21h-2.25A1.125 1.125 0 013 19.875v-6.75zM9.75 8.625c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125v11.25c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V8.625zM16.5 4.125c0-.621.504-1.125 1.125-1.125h2.25C20.496 3 21 3.504 21 4.125v15.75c0 .621-.504 1.125-1.125 1.125h-2.25a1.125 1.125 0 01-1.125-1.125V4.125z" />
              </svg>
            </div>
            <h3 className="text-[15px] font-semibold text-gray-900 mb-1">Performance Tracking</h3>
            <p className="text-[13px] text-gray-400 max-w-md mx-auto mb-4">
              Connect your Meta account in Settings to pull live ad performance data — impressions, clicks, spend, ROAS, and more.
            </p>
            <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-purple-50 text-purple-500 text-[11px] font-medium">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              Coming Soon
            </span>
          </div>
        </div>
      )}
    </Layout>
  );
}

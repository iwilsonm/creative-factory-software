import { Link } from 'react-router-dom';
import { api } from '../api';
import Layout from '../components/Layout';
import InfoTooltip from '../components/InfoTooltip';
import { useToast } from '../components/Toast';
import { useAsyncData } from '../hooks/useAsyncData';

const STATUS_CONFIG = {
  setup: { label: 'Setup', bg: 'bg-gold/10', text: 'text-gold' },
  generating_docs: { label: 'Generating', bg: 'bg-navy/10', text: 'text-navy' },
  docs_ready: { label: 'Ready', bg: 'bg-teal/10', text: 'text-teal' },
  active: { label: 'Active', bg: 'bg-teal/15', text: 'text-teal' }
};

const STATUS_COLORS = {
  setup: '#C4975A',
  generating_docs: '#0B1D3A',
  docs_ready: '#2A9D8F',
  active: '#2A9D8F'
};

export default function Projects() {
  const toast = useToast();
  const { data: projects, loading } = useAsyncData(
    () => api.getProjects(),
    []
  );

  return (
    <Layout>
      {/* Page Header */}
      <div className="mb-8">
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-semibold text-textdark tracking-tight">Projects</h1>
              {!loading && projects.length > 0 && (
                <span className="badge bg-black/5 text-textlight">
                  {projects.length}
                </span>
              )}
              <InfoTooltip
                text="Each project contains foundational docs, templates, and generated ad creatives for one brand or product."
                position="right"
              />
            </div>
            <p className="text-[13px] text-textmid mt-0.5">Manage your ad creative projects</p>
          </div>
          <Link to="/projects/new" className="btn-primary text-[13px]">
            New Project
          </Link>
        </div>
      </div>

      {/* Projects Grid */}
      <div className="fade-in">
        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {[0, 1, 2].map(i => (
              <div key={i} className="card p-5 animate-pulse">
                <div className="flex items-start justify-between mb-3">
                  <div className="h-4 w-32 bg-gray-200 rounded" />
                  <div className="h-5 w-14 bg-gray-200 rounded-full" />
                </div>
                <div className="h-3 w-24 bg-gray-100 rounded mb-1" />
                <div className="h-3 w-16 bg-gray-100 rounded mb-4" />
                <div className="border-t border-black/5 pt-3 flex gap-4">
                  <div className="h-3 w-14 bg-gray-100 rounded" />
                  <div className="h-3 w-14 bg-gray-100 rounded" />
                </div>
              </div>
            ))}
          </div>
        ) : projects.length === 0 ? (
          <div className="card p-16 text-center fade-in">
            <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-black/5 flex items-center justify-center">
              <svg className="w-8 h-8 text-textlight" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
            </div>
            <p className="text-textmid text-sm mb-4">No projects yet. Create your first project to get started.</p>
            <Link to="/projects/new" className="btn-primary inline-block">
              Create Project
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5 fade-in">
            {projects.map(project => {
              const status = STATUS_CONFIG[project.status] || { label: project.status, bg: 'bg-black/5', text: 'text-textmid' };
              const borderColor = STATUS_COLORS[project.status] || '#D1D5DB';
              return (
                <Link
                  key={project.id}
                  to={`/projects/${project.id}`}
                  className="card p-5 transition-all duration-300 hover:-translate-y-0.5 group border-l-2"
                  style={{ borderLeftColor: borderColor }}
                >
                  <div className="flex items-start justify-between mb-3">
                    <h3 className="font-semibold text-[15px] text-textdark tracking-tight group-hover:text-gold transition-colors">{project.brand_name || project.name}</h3>
                    <span className={`badge ${status.bg} ${status.text}`}>
                      {status.label}
                    </span>
                  </div>
                  {project.brand_name && (
                    <p className="text-[13px] text-textmid mb-0.5">{project.name}</p>
                  )}
                  {project.niche && (
                    <p className="text-[12px] text-textlight mb-4">{project.niche}</p>
                  )}
                  <div className="flex items-center gap-4 text-[12px] text-textlight border-t border-black/5 pt-3">
                    <span className="flex items-center gap-1">
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" /></svg>
                      {project.docCount || 0} docs
                    </span>
                    <span className="flex items-center gap-1">
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5a2.25 2.25 0 002.25-2.25V6.75a2.25 2.25 0 00-2.25-2.25H3.75a2.25 2.25 0 00-2.25 2.25v12a2.25 2.25 0 002.25 2.25z" /></svg>
                      {project.adCount || 0} ads
                    </span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </Layout>
  );
}

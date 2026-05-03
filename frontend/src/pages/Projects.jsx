import { useContext, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { AuthContext } from '../App';

import StatusPill from '../components/editorial/StatusPill';
import { useToast } from '../components/Toast';
import { useAsyncData } from '../hooks/useAsyncData';
import { ensureArray } from '../utils/collections';

function parsePinnedIds(raw) {
  if (!raw) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(parsed) ? parsed.filter(id => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export default function Projects() {
  const toast = useToast();
  const { user } = useContext(AuthContext);
  const canCreate = user?.role === 'admin' || user?.role === 'manager';
  const { data: projects, loading } = useAsyncData(
    () => api.getProjects(),
    []
  );
  const baseProjects = ensureArray(projects, 'Projects.page.projects');

  const [pinnedIds, setPinnedIds] = useState([]);
  useEffect(() => {
    api.getSettings()
      .then(s => setPinnedIds(parsePinnedIds(s?.pinned_project_ids)))
      .catch(() => {});
  }, []);

  const togglePin = async (projectId) => {
    const next = pinnedIds.includes(projectId)
      ? pinnedIds.filter(id => id !== projectId)
      : [...pinnedIds, projectId];
    setPinnedIds(next);
    try {
      await api.updateSettings({ pinned_project_ids: JSON.stringify(next) });
    } catch (err) {
      setPinnedIds(pinnedIds);
      toast.error(err.message || 'Failed to update pinned projects');
    }
  };

  const safeProjects = [...baseProjects].sort((a, b) => {
    const aIdx = pinnedIds.indexOf(a.id);
    const bIdx = pinnedIds.indexOf(b.id);
    const aPinned = aIdx !== -1;
    const bPinned = bIdx !== -1;
    if (aPinned && !bPinned) return -1;
    if (!aPinned && bPinned) return 1;
    if (aPinned && bPinned) return aIdx - bIdx;
    return 0;
  });

  return (
    <div className="px-[36px] py-[28px] max-w-[1200px]">
      {/* ─── Header ─── */}
      <div className="flex items-end justify-between mb-8">
        <div>
          {!loading && (
            <div className="ed-eyebrow mb-2">
              {safeProjects.length} project{safeProjects.length !== 1 ? 's' : ''}
            </div>
          )}
          <h1 className="font-serif text-[38px] leading-[1.05] tracking-[-0.02em] text-ed-ink font-[420]">
            Projects
          </h1>
        </div>
        {canCreate && (
          <Link to="/projects/new" className="ed-cta flex items-center gap-1.5 text-[13px]">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M12 5v14M5 12h14" />
            </svg>
            New project
          </Link>
        )}
      </div>

      {/* ─── Projects Grid ─── */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
          {[0, 1, 2, 3].map(i => (
            <div key={i} className="ed-card px-[22px] py-5 animate-pulse">
              <div className="h-5 w-36 bg-ed-line rounded mb-2" />
              <div className="h-3 w-24 bg-ed-line/60 rounded mb-5" />
              <div className="flex gap-6">
                <div className="h-4 w-14 bg-ed-line/40 rounded" />
                <div className="h-4 w-14 bg-ed-line/40 rounded" />
              </div>
            </div>
          ))}
        </div>
      ) : safeProjects.length === 0 ? (
        <div className="py-16 text-center border-2 border-dashed border-ed-line rounded-xl">
          <p className="font-geist text-[14px] text-ed-ink2 mb-4">
            {canCreate ? 'No projects yet. Create your first project to get started.' : 'No projects available.'}
          </p>
          {canCreate && (
            <Link to="/projects/new" className="ed-cta inline-flex items-center gap-1.5 text-[13px]">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M12 5v14M5 12h14" />
              </svg>
              Create Project
            </Link>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
          {safeProjects.map(project => {
            const isPinned = pinnedIds.includes(project.id);
            return (
              <Link
                key={project.id}
                to={`/projects/${project.id}`}
                className="ed-card px-[22px] py-5 no-underline group transition-colors duration-150 hover:border-ed-accent/30"
              >
                <div className="flex items-start justify-between gap-3 mb-1">
                  <h3 className="font-serif text-[20px] tracking-[-0.01em] text-ed-ink leading-tight truncate">
                    {project.brand_name || project.name}
                  </h3>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); togglePin(project.id); }}
                      className={`w-6 h-6 rounded-md flex items-center justify-center transition-all ${
                        isPinned
                          ? 'text-ed-accent'
                          : 'text-ed-ink3/30 opacity-0 group-hover:opacity-100 hover:text-ed-ink3'
                      }`}
                      title={isPinned ? 'Unpin project' : 'Pin to top'}
                    >
                      <svg
                        className="w-3.5 h-3.5"
                        fill={isPinned ? 'currentColor' : 'none'}
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                        strokeWidth={isPinned ? 1 : 1.75}
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z" />
                      </svg>
                    </button>
                  </div>
                </div>

                {project.brand_name && (
                  <div className="font-geist text-[12.5px] text-ed-ink3 mb-0.5">{project.name}</div>
                )}
                {project.niche && (
                  <div className="font-geist text-[11.5px] text-ed-ink3/70 mb-0.5">{project.niche}</div>
                )}

                <div className="flex items-end justify-between mt-4">
                  <div className="flex gap-[18px] text-[11.5px] text-ed-ink3">
                    <div>
                      <div className="font-serif text-[18px] text-ed-ink leading-none mb-[3px]">
                        {project.adCount || 0}
                      </div>
                      ads
                    </div>
                    <div>
                      <div className="font-serif text-[18px] text-ed-ink leading-none mb-[3px]">
                        {project.docCount || 0}
                      </div>
                      {project.status === 'setup' ? `/ 4 docs` : 'docs'}
                    </div>
                    {(project.lpCount > 0) && (
                      <div>
                        <div className="font-serif text-[18px] text-ed-ink leading-none mb-[3px]">
                          {project.lpCount}
                        </div>
                        LPs
                      </div>
                    )}
                  </div>
                  <StatusPill status={project.status} />
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

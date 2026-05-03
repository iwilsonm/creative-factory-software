import { useState, useRef, useEffect } from 'react';

export default function SavedViewPicker({ views, activeViewId, onSelect, onSaveNew, onDelete }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function onDocClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const privateViews = (views || []).filter(v => v.scope === 'private');
  const sharedViews = (views || []).filter(v => v.scope === 'project');
  const active = (views || []).find(v => v.externalId === activeViewId);

  return (
    <div ref={ref} className="relative inline-block">
      <button
        onClick={() => setOpen(o => !o)}
        className="ed-ghost text-[12px] flex items-center gap-1.5 px-3 py-1.5"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 12h14M5 16h10" />
        </svg>
        <span>{active ? active.name : 'Default view'}</span>
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute z-30 right-0 mt-1 w-72 bg-ed-surface border border-ed-line rounded-xl shadow-card p-2">
          <button
            onClick={() => { onSelect(null); setOpen(false); }}
            className={`w-full text-left text-[12px] px-2 py-1.5 rounded-lg ${!activeViewId ? 'bg-ed-accent/10 text-ed-accent' : 'hover:bg-ed-bg text-ed-ink'}`}
          >
            Default view
          </button>

          {privateViews.length > 0 && (
            <>
              <div className="text-[10px] font-medium text-ed-ink3 uppercase tracking-wider px-2 mt-2 mb-1">My Views</div>
              {privateViews.map(v => (
                <ViewRow key={v.externalId} view={v} active={activeViewId === v.externalId} onSelect={() => { onSelect(v); setOpen(false); }} onDelete={() => onDelete(v)} />
              ))}
            </>
          )}

          {sharedViews.length > 0 && (
            <>
              <div className="text-[10px] font-medium text-ed-ink3 uppercase tracking-wider px-2 mt-2 mb-1">Shared with Project</div>
              {sharedViews.map(v => (
                <ViewRow key={v.externalId} view={v} active={activeViewId === v.externalId} onSelect={() => { onSelect(v); setOpen(false); }} onDelete={() => onDelete(v)} />
              ))}
            </>
          )}

          <div className="border-t border-ed-line mt-2 pt-1.5">
            <button
              onClick={() => { setOpen(false); onSaveNew(); }}
              className="w-full text-left text-[12px] text-ed-accent hover:text-ed-accent/80 px-2 py-1.5"
            >
              + Save current as view…
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ViewRow({ view, active, onSelect, onDelete }) {
  return (
    <div className={`flex items-center gap-2 px-2 py-1.5 rounded-lg ${active ? 'bg-ed-accent/10' : 'hover:bg-ed-bg'}`}>
      <button onClick={onSelect} className={`flex-1 text-left text-[12px] ${active ? 'text-ed-accent' : 'text-ed-ink'}`}>
        {view.name}
      </button>
      <button
        onClick={() => {
          if (confirm(`Delete view "${view.name}"?`)) onDelete();
        }}
        className="text-[10px] text-ed-ink3 hover:text-red-500"
      >
        Delete
      </button>
    </div>
  );
}

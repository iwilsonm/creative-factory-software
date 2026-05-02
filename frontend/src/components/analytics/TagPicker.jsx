import { useState, useRef, useEffect } from 'react';

export const TAG_COLORS = [
  { name: 'gray',   hex: '#787774' },
  { name: 'brown',  hex: '#9F6B53' },
  { name: 'orange', hex: '#D9730D' },
  { name: 'yellow', hex: '#CB912F' },
  { name: 'green',  hex: '#448361' },
  { name: 'blue',   hex: '#337EA9' },
  { name: 'purple', hex: '#9065B0' },
  { name: 'pink',   hex: '#C14C8A' },
  { name: 'red',    hex: '#D44C47' },
];

export default function TagPicker({ allTags, appliedTagIds, onApply, onRemove, onCreate, anchorRef, onClose }) {
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(TAG_COLORS[0].hex);
  const ref = useRef(null);

  useEffect(() => {
    function onDocClick(e) {
      if (ref.current && !ref.current.contains(e.target) && anchorRef?.current && !anchorRef.current.contains(e.target)) {
        onClose?.();
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [onClose, anchorRef]);

  const filtered = (allTags || []).filter(t =>
    !query || t.name.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <div ref={ref} className="absolute z-30 mt-1 w-64 bg-white border border-gray-200 rounded-xl shadow-card p-2">
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search or create tag…"
        className="w-full text-[12px] px-2 py-1.5 border border-gray-200 rounded-lg focus:outline-none focus:border-navy"
      />

      <div className="max-h-44 overflow-y-auto mt-1.5">
        {filtered.length === 0 && !creating && (
          <div className="text-[11px] text-textlight px-2 py-1.5">No tags match.</div>
        )}
        {filtered.map(tag => {
          const applied = appliedTagIds.includes(tag.externalId);
          return (
            <button
              key={tag.externalId}
              onClick={() => applied ? onRemove(tag) : onApply(tag)}
              className="w-full flex items-center gap-2 px-2 py-1.5 text-[12px] hover:bg-gray-50 rounded-lg"
            >
              <span className="w-3 h-3 rounded-full" style={{ background: tag.color }} />
              <span className="flex-1 text-left text-textdark">{tag.name}</span>
              {applied && (
                <svg className="w-3.5 h-3.5 text-teal" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                </svg>
              )}
            </button>
          );
        })}
      </div>

      <div className="border-t border-gray-100 pt-2 mt-1.5">
        {!creating ? (
          <button
            onClick={() => { setCreating(true); setNewName(query); }}
            className="w-full text-left text-[11px] text-gold hover:text-gold-light px-2 py-1"
          >
            + Create new tag{query ? ` "${query}"` : ''}
          </button>
        ) : (
          <div className="space-y-2">
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Tag name"
              className="w-full text-[12px] px-2 py-1.5 border border-gray-200 rounded-lg focus:outline-none focus:border-navy"
            />
            <div className="flex flex-wrap gap-1">
              {TAG_COLORS.map(c => (
                <button
                  key={c.hex}
                  onClick={() => setNewColor(c.hex)}
                  title={c.name}
                  className={`w-5 h-5 rounded-full border-2 ${newColor === c.hex ? 'border-textdark' : 'border-transparent'}`}
                  style={{ background: c.hex }}
                />
              ))}
            </div>
            <div className="flex gap-2">
              <button
                disabled={!newName.trim()}
                onClick={async () => {
                  await onCreate({ name: newName.trim(), color: newColor });
                  setCreating(false); setNewName(''); setQuery('');
                }}
                className="btn-primary text-[11px] px-2 py-1"
              >
                Create + apply
              </button>
              <button
                onClick={() => setCreating(false)}
                className="text-[11px] text-textmid hover:text-textdark"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

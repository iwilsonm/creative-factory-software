import { useState } from 'react';
import { TAG_COLORS } from './TagPicker';

export default function TagManageDialog({ open, tags, onClose, onCreate, onUpdate, onDelete }) {
  const [editingId, setEditingId] = useState(null);
  const [draftName, setDraftName] = useState('');
  const [draftColor, setDraftColor] = useState(TAG_COLORS[0].hex);
  const [creating, setCreating] = useState(false);

  if (!open) return null;

  const startEdit = (tag) => {
    setEditingId(tag.externalId);
    setDraftName(tag.name);
    setDraftColor(tag.color);
    setCreating(false);
  };

  const startCreate = () => {
    setEditingId(null);
    setDraftName('');
    setDraftColor(TAG_COLORS[0].hex);
    setCreating(true);
  };

  const saveDraft = async () => {
    if (!draftName.trim()) return;
    if (creating) {
      await onCreate({ name: draftName.trim(), color: draftColor });
    } else if (editingId) {
      await onUpdate(editingId, { name: draftName.trim(), color: draftColor });
    }
    setEditingId(null);
    setCreating(false);
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-2xl shadow-card w-[480px] max-w-[92vw] p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-[15px] font-semibold text-textdark">Manage Tags</h3>
          <button onClick={onClose} className="text-textmid hover:text-textdark text-[18px] leading-none">×</button>
        </div>

        <div className="max-h-72 overflow-y-auto border border-gray-100 rounded-xl">
          {(tags || []).length === 0 && !creating && (
            <div className="text-[12px] text-textlight px-3 py-4 text-center">No tags yet.</div>
          )}
          {(tags || []).map(tag => (
            <div key={tag.externalId} className="flex items-center gap-3 px-3 py-2 border-b last:border-b-0 border-gray-100">
              {editingId === tag.externalId ? (
                <>
                  <div className="flex flex-wrap gap-1 flex-shrink-0">
                    {TAG_COLORS.map(c => (
                      <button
                        key={c.hex}
                        onClick={() => setDraftColor(c.hex)}
                        className={`w-4 h-4 rounded-full border-2 ${draftColor === c.hex ? 'border-textdark' : 'border-transparent'}`}
                        style={{ background: c.hex }}
                      />
                    ))}
                  </div>
                  <input
                    autoFocus
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    className="flex-1 text-[12px] px-2 py-1 border border-gray-200 rounded"
                  />
                  <button onClick={saveDraft} className="btn-primary text-[11px] px-2 py-1">Save</button>
                  <button onClick={() => setEditingId(null)} className="text-[11px] text-textmid">Cancel</button>
                </>
              ) : (
                <>
                  <span className="w-3 h-3 rounded-full" style={{ background: tag.color }} />
                  <span className="flex-1 text-[12px] text-textdark">{tag.name}</span>
                  <button onClick={() => startEdit(tag)} className="text-[11px] text-gold hover:text-gold-light">Edit</button>
                  <button
                    onClick={() => {
                      if (confirm(`Delete tag "${tag.name}"? It will be removed from all rows it's applied to.`)) {
                        onDelete(tag.externalId);
                      }
                    }}
                    className="text-[11px] text-red-400 hover:text-red-500"
                  >
                    Delete
                  </button>
                </>
              )}
            </div>
          ))}
        </div>

        {creating && (
          <div className="mt-3 flex items-center gap-2">
            <div className="flex flex-wrap gap-1 flex-shrink-0">
              {TAG_COLORS.map(c => (
                <button
                  key={c.hex}
                  onClick={() => setDraftColor(c.hex)}
                  className={`w-4 h-4 rounded-full border-2 ${draftColor === c.hex ? 'border-textdark' : 'border-transparent'}`}
                  style={{ background: c.hex }}
                />
              ))}
            </div>
            <input
              autoFocus
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              placeholder="Tag name"
              className="flex-1 text-[12px] px-2 py-1 border border-gray-200 rounded"
            />
            <button onClick={saveDraft} className="btn-primary text-[11px] px-2 py-1">Create</button>
            <button onClick={() => setCreating(false)} className="text-[11px] text-textmid">Cancel</button>
          </div>
        )}

        <div className="mt-4 flex justify-between">
          {!creating && (
            <button onClick={startCreate} className="text-[12px] text-gold hover:text-gold-light">+ New tag</button>
          )}
          <span />
          <button onClick={onClose} className="btn-secondary text-[12px]">Done</button>
        </div>
      </div>
    </div>
  );
}

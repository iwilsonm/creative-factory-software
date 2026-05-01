import { useState } from 'react';

export default function SaveViewDialog({ open, onClose, onSave }) {
  const [name, setName] = useState('');
  const [scope, setScope] = useState('private');
  const [saving, setSaving] = useState(false);

  if (!open) return null;

  const submit = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await onSave({ name: name.trim(), scope });
      setName('');
      onClose?.();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-2xl shadow-card w-[400px] max-w-[92vw] p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-[15px] font-semibold text-textdark">Save view</h3>
          <button onClick={onClose} className="text-textmid hover:text-textdark text-[18px] leading-none">×</button>
        </div>

        <label className="block text-[12px] font-medium text-textmid mb-1">View name</label>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g., Top spenders"
          className="input-apple text-[13px] mb-4"
        />

        <label className="block text-[12px] font-medium text-textmid mb-2">Visibility</label>
        <div className="space-y-1.5 mb-5">
          <label className="flex items-start gap-2 cursor-pointer">
            <input type="radio" checked={scope === 'private'} onChange={() => setScope('private')} className="mt-1" />
            <div>
              <div className="text-[13px] text-textdark">Private</div>
              <div className="text-[11px] text-textlight">Only you can see this view.</div>
            </div>
          </label>
          <label className="flex items-start gap-2 cursor-pointer">
            <input type="radio" checked={scope === 'project'} onChange={() => setScope('project')} className="mt-1" />
            <div>
              <div className="text-[13px] text-textdark">Shared with project</div>
              <div className="text-[11px] text-textlight">Everyone on this project can see and use it.</div>
            </div>
          </label>
        </div>

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="btn-secondary text-[12px]">Cancel</button>
          <button
            onClick={submit}
            disabled={!name.trim() || saving}
            className="btn-primary text-[12px]"
          >
            {saving ? 'Saving…' : 'Save view'}
          </button>
        </div>
      </div>
    </div>
  );
}

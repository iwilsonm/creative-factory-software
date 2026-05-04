import { useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import ConfirmDialog from './ConfirmDialog';

export default function BulkEditPanel({ selectedCards, campaigns, onSave, onCancel, addToast }) {
  const [fields, setFields] = useState({});
  const [touched, setTouched] = useState(new Set());
  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const updateField = (key, value) => {
    setFields(prev => ({ ...prev, [key]: value }));
    setTouched(prev => new Set(prev).add(key));
  };

  const handleSave = async () => {
    setConfirmOpen(false);
    setSaving(true);

    const touchedFields = {};
    for (const key of touched) {
      touchedFields[key] = fields[key];
    }

    if (Object.keys(touchedFields).length === 0) {
      addToast('No fields were changed', 'error');
      setSaving(false);
      return;
    }

    try {
      const updates = [];
      for (const [cardKey, cardType] of selectedCards) {
        const id = cardType === 'flex' ? cardKey.replace('flex-', '') : cardKey;
        const payload = cardType === 'flex'
          ? touchedFields
          : Object.fromEntries(Object.entries(touchedFields).map(([key, value]) => [key === 'name' ? 'ad_name' : key, value]));
        if (cardType === 'flex') {
          updates.push(api.updateFlexAd(id, payload));
        } else {
          updates.push(api.updateDeployment(id, payload));
        }
      }
      await Promise.all(updates);
      addToast(`Updated ${selectedCards.size} ad${selectedCards.size !== 1 ? 's' : ''}`, 'success');
      onSave();
    } catch {
      addToast('Failed to update some ads', 'error');
    } finally {
      setSaving(false);
    }
  };

  const inputClass = "w-full text-[12px] text-ed-ink bg-ed-surface border border-black/10 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-ed-accent/20";
  const labelClass = "text-[10px] text-ed-ink2 font-medium block mb-1";
  const touchedBorder = (key) => touched.has(key) ? 'ring-2 ring-ed-accent/30' : '';

  const panel = (
    <div className="fixed inset-0 z-[90] flex items-end sm:items-center justify-center p-3 sm:p-4 fade-in">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => !saving && onCancel?.()} />
      <div className="relative w-full sm:max-w-md rounded-xl border border-ed-accent/30 bg-ed-surface shadow-card-hover overflow-hidden">
        <div className="px-4 py-3 border-b border-ed-line bg-ed-accent/5 flex items-center justify-between">
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-ed-accent/20 text-ed-accent text-[10px] font-bold uppercase tracking-widest">
            Bulk Edit — {selectedCards.size} ad{selectedCards.size !== 1 ? 's' : ''}
          </span>
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="px-2.5 py-1 rounded-md text-[11px] text-ed-ink2 hover:bg-black/[0.04] transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
        </div>

        <div className="p-4 space-y-3">
        <div className="flex items-center justify-between mb-1">
          <p className="text-[10px] text-ed-ink2">Only fields you change will be applied. Unchanged fields are left as-is on each ad.</p>
        </div>

        <div className="grid grid-cols-1 gap-3">
          {/* Ad Name */}
          <div>
            <label className={labelClass}>Ad Name</label>
            <input type="text" value={fields.name || ''} onChange={e => updateField('name', e.target.value)}
              className={`${inputClass} ${touchedBorder('name')}`} placeholder="Leave blank to keep existing" />
          </div>
        </div>

        {touched.size > 0 && (
          <p className="text-[10px] text-ed-accent font-medium">{touched.size} field{touched.size !== 1 ? 's' : ''} will be updated</p>
        )}
      </div>

        <div className="px-4 py-3 border-t border-ed-line bg-ed-bg flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="px-2.5 py-1.5 rounded-md text-[11px] text-ed-ink2 hover:bg-black/[0.04] transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            disabled={saving || touched.size === 0}
            className="px-3 py-1.5 rounded-md text-[11px] font-semibold bg-ed-accent text-white hover:bg-ed-accent-light transition-colors disabled:opacity-50"
          >
            {saving ? 'Saving...' : `Apply to ${selectedCards.size} Ad${selectedCards.size !== 1 ? 's' : ''}`}
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title={`Apply changes to ${selectedCards.size} ad${selectedCards.size !== 1 ? 's' : ''}?`}
        message={`${touched.size} field${touched.size !== 1 ? 's' : ''} will be updated on all selected ads. This cannot be undone.`}
        confirmLabel="Apply Changes"
        tone="danger"
        onConfirm={handleSave}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );

  if (typeof document === 'undefined') return null;
  return createPortal(panel, document.body);
}

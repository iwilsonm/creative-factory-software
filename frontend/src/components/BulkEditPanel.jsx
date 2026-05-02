import { useState } from 'react';
import { api } from '../api';
import ConfirmDialog from './ConfirmDialog';

const ctaOptions = ['SHOP_NOW', 'LEARN_MORE', 'SIGN_UP', 'BUY_NOW', 'GET_OFFER', 'ORDER_NOW', 'SUBSCRIBE', 'CONTACT_US', 'DOWNLOAD', 'APPLY_NOW', 'BOOK_NOW', 'GET_QUOTE'];

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
        if (cardType === 'flex') {
          updates.push(api.updateFlexAd(id, touchedFields));
        } else {
          updates.push(api.updateDeployment(id, touchedFields));
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

  const inputClass = "w-full text-[12px] text-textdark bg-white border border-black/10 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-navy/20";
  const labelClass = "text-[10px] text-textmid font-medium block mb-1";
  const touchedBorder = (key) => touched.has(key) ? 'ring-2 ring-gold/30' : '';

  return (
    <>
      <div className="border-2 border-navy/30 bg-navy/5 rounded-xl p-4 space-y-3 mb-5">
        <div className="flex items-center justify-between mb-1">
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded bg-navy/20 text-navy text-[10px] font-bold uppercase tracking-widest">
            Bulk Edit — {selectedCards.size} ad{selectedCards.size !== 1 ? 's' : ''}
          </span>
          <div className="flex items-center gap-2">
            <button onClick={onCancel}
              className="px-2.5 py-1 rounded-md text-[11px] text-textmid hover:bg-black/[0.04] transition-colors">Cancel</button>
            <button onClick={() => setConfirmOpen(true)} disabled={saving || touched.size === 0}
              className="px-3 py-1 rounded-md text-[11px] font-semibold bg-navy text-white hover:bg-navy-light transition-colors disabled:opacity-50">
              {saving ? 'Saving...' : `Apply to ${selectedCards.size} Ad${selectedCards.size !== 1 ? 's' : ''}`}
            </button>
          </div>
        </div>

        <p className="text-[10px] text-textmid">Only fields you change will be applied. Unchanged fields are left as-is on each ad.</p>

        <div className="grid grid-cols-2 gap-3">
          {/* Start Date */}
          <div>
            <label className={labelClass}>Start Date</label>
            <input type="date" value={fields.planned_date || ''} onChange={e => updateField('planned_date', e.target.value || null)}
              className={`${inputClass} ${touchedBorder('planned_date')}`} />
          </div>

          {/* Ad Name */}
          <div>
            <label className={labelClass}>Ad Name</label>
            <input type="text" value={fields.name || ''} onChange={e => updateField('name', e.target.value)}
              className={`${inputClass} ${touchedBorder('name')}`} placeholder="Leave blank to keep existing" />
          </div>

          {/* Campaign */}
          <div>
            <label className={labelClass}>Campaign</label>
            <select value={fields._campaign_id || ''} onChange={e => updateField('_campaign_id', e.target.value)}
              className={`${inputClass} cursor-pointer ${touchedBorder('_campaign_id')}`}>
              <option value="">Keep existing</option>
              {(campaigns || []).map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>

          {/* Ad Set Name */}
          <div>
            <label className={labelClass}>Ad Set Name</label>
            <input type="text" value={fields._ad_set_name || ''} onChange={e => updateField('_ad_set_name', e.target.value)}
              className={`${inputClass} ${touchedBorder('_ad_set_name')}`} placeholder="Leave blank to keep existing" />
          </div>

          {/* Website URL */}
          <div>
            <label className={labelClass}>Website URL</label>
            <input type="text" value={fields.destination_url || ''} onChange={e => updateField('destination_url', e.target.value)}
              className={`${inputClass} ${touchedBorder('destination_url')}`} placeholder="https://..." />
          </div>

          {/* Display Link */}
          <div>
            <label className={labelClass}>Display Link</label>
            <input type="text" value={fields.display_link || ''} onChange={e => updateField('display_link', e.target.value)}
              className={`${inputClass} ${touchedBorder('display_link')}`} placeholder="e.g. yourbrand.com" />
          </div>

          {/* CTA */}
          <div>
            <label className={labelClass}>Call to Action</label>
            <select value={fields.cta_button || ''} onChange={e => updateField('cta_button', e.target.value)}
              className={`${inputClass} cursor-pointer ${touchedBorder('cta_button')}`}>
              <option value="">Keep existing</option>
              {ctaOptions.map(opt => <option key={opt} value={opt}>{opt.replace(/_/g, ' ')}</option>)}
            </select>
          </div>

          {/* Facebook Page */}
          <div>
            <label className={labelClass}>Facebook Page</label>
            <input type="text" value={fields.facebook_page || ''} onChange={e => updateField('facebook_page', e.target.value)}
              className={`${inputClass} ${touchedBorder('facebook_page')}`} placeholder="Leave blank to keep existing" />
          </div>

          {/* Duplicate Ad Set Name */}
          <div className="col-span-2">
            <label className={labelClass}>Duplicate Ad Set Name</label>
            <input type="text" value={fields.duplicate_adset_name || ''} onChange={e => updateField('duplicate_adset_name', e.target.value)}
              className={`${inputClass} ${touchedBorder('duplicate_adset_name')}`} placeholder="Leave blank to keep existing" />
          </div>
        </div>

        {touched.size > 0 && (
          <p className="text-[10px] text-gold font-medium">{touched.size} field{touched.size !== 1 ? 's' : ''} will be updated</p>
        )}
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
    </>
  );
}

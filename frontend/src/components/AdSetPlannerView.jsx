import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import ConfirmDialog from './ConfirmDialog';

const CTA_OPTIONS = [
  'SHOP_NOW', 'LEARN_MORE', 'SIGN_UP', 'BOOK_NOW', 'CONTACT_US',
  'DOWNLOAD', 'GET_QUOTE', 'SUBSCRIBE', 'ORDER_NOW', 'WATCH_MORE',
  'APPLY_NOW', 'GET_OFFER', 'NO_BUTTON',
];

function depName(dep) {
  if (dep.ad_name) return dep.ad_name;
  const parts = [dep.ad?.angle, dep.ad?.headline].filter(Boolean);
  return parts.length ? parts.join(' - ') : `Ad ${(dep.id || '').slice(0, 6)}`;
}

function readJsonList(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function linesToJson(value) {
  return JSON.stringify(String(value || '').split('\n').map(v => v.trim()).filter(Boolean));
}

function firstValue(deps, key) {
  return deps.find(d => d?.[key])?.[key] || '';
}

export default function AdSetPlannerView({ projectId, deployments, setDeployments, addToast, loadDeployments }) {
  const [campaigns, setCampaigns] = useState([]);
  const [adSets, setAdSets] = useState([]);
  const [loadingMeta, setLoadingMeta] = useState(true);
  const [selectedQueue, setSelectedQueue] = useState(new Set());
  const [selectedPlanner, setSelectedPlanner] = useState(new Set());
  const [createModal, setCreateModal] = useState(null);
  const [editModal, setEditModal] = useState(null);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [busy, setBusy] = useState(false);

  const loadMeta = async () => {
    setLoadingMeta(true);
    try {
      const data = await api.getCampaigns(projectId);
      setCampaigns(data.campaigns || []);
      setAdSets(data.adSets || []);
    } catch {
      addToast('Failed to load campaigns and ad sets', 'error');
    } finally {
      setLoadingMeta(false);
    }
  };

  useEffect(() => { loadMeta(); }, [projectId]);

  const queueDeps = useMemo(() => deployments.filter(d =>
    d.local_campaign_id === 'unplanned' && d.status !== 'ready_to_post' && d.status !== 'posted'
  ), [deployments]);

  const plannerDeps = useMemo(() => deployments.filter(d =>
    d.local_campaign_id !== 'unplanned' && d.status !== 'ready_to_post' && d.status !== 'posted'
  ), [deployments]);

  const { groups, standalone } = useMemo(() => {
    const adSetById = new Map(adSets.map(a => [a.id, a]));
    const campaignById = new Map(campaigns.map(c => [c.id, c]));
    const grouped = new Map();
    const solo = [];
    for (const dep of plannerDeps) {
      const adSet = dep.local_adset_id ? adSetById.get(dep.local_adset_id) : null;
      if (!adSet) {
        solo.push(dep);
        continue;
      }
      if (!grouped.has(adSet.id)) {
        grouped.set(adSet.id, { adSet, campaign: campaignById.get(adSet.campaign_id) || null, deps: [] });
      }
      grouped.get(adSet.id).deps.push(dep);
    }
    return { groups: Array.from(grouped.values()), standalone: solo };
  }, [adSets, campaigns, plannerDeps]);

  const toggleMany = (setter, current, ids) => {
    const allSelected = ids.every(id => current.has(id));
    setter(prev => {
      const next = new Set(prev);
      ids.forEach(id => { if (allSelected) next.delete(id); else next.add(id); });
      return next;
    });
  };

  const optimisticPatch = (ids, patch) => {
    setDeployments(prev => prev.map(d => ids.includes(d.id) ? { ...d, ...patch } : d));
  };

  const moveToPlanner = async (ids) => {
    if (!ids.length) return;
    optimisticPatch(ids, { local_campaign_id: 'planned', local_adset_id: '', flex_ad_id: '' });
    setSelectedQueue(new Set());
    try {
      await api.assignToAdSet(ids, 'planned', '');
      addToast(`Moved ${ids.length} ad${ids.length === 1 ? '' : 's'} to Planner`, 'success');
    } catch {
      addToast('Failed to move ads to Planner', 'error');
      loadDeployments();
    }
  };

  const moveToQueue = async (ids) => {
    if (!ids.length) return;
    optimisticPatch(ids, { local_campaign_id: 'unplanned', local_adset_id: '', flex_ad_id: '' });
    setSelectedPlanner(new Set());
    try {
      await api.unassignFromAdSet(ids);
      addToast(`Moved ${ids.length} ad${ids.length === 1 ? '' : 's'} to Queue`, 'success');
    } catch {
      addToast('Failed to move ads to Queue', 'error');
      loadDeployments();
    }
  };

  const markReady = async (ids) => {
    if (!ids.length) return;
    optimisticPatch(ids, { status: 'ready_to_post' });
    setSelectedPlanner(new Set());
    try {
      await Promise.all(ids.map(id => api.updateDeploymentStatus(id, 'ready_to_post')));
      addToast(`Moved ${ids.length} ad${ids.length === 1 ? '' : 's'} to Ready to Post`, 'success');
    } catch {
      addToast('Failed to mark ready', 'error');
      loadDeployments();
    }
  };

  const deleteIds = async (ids) => {
    if (!ids.length) return;
    setDeleteConfirm(null);
    setDeployments(prev => prev.filter(d => !ids.includes(d.id)));
    setSelectedQueue(new Set());
    setSelectedPlanner(new Set());
    try {
      await Promise.all(ids.map(id => api.deleteDeployment(id)));
      addToast(`Removed ${ids.length} ad${ids.length === 1 ? '' : 's'}`, 'success');
    } catch {
      addToast('Failed to remove ads', 'error');
      loadDeployments();
    }
  };

  const createAdSet = async (form) => {
    const ids = createModal?.ids || [];
    if (!ids.length) return;
    if (!form.adSetName.trim()) {
      addToast('Name the ad set first', 'error');
      return;
    }
    if (!form.campaignId && !form.newCampaignName.trim()) {
      addToast('Choose or name a campaign first', 'error');
      return;
    }
    setBusy(true);
    try {
      const result = await api.createAdSetFromDeployments(projectId, {
        deploymentIds: ids,
        campaignId: form.campaignId,
        newCampaignName: form.newCampaignName.trim(),
        adSetName: form.adSetName.trim(),
      });
      optimisticPatch(ids, {
        local_campaign_id: result.campaignId,
        local_adset_id: result.adSetId,
        flex_ad_id: '',
      });
      setCreateModal(null);
      setSelectedPlanner(new Set());
      await Promise.all([loadMeta(), loadDeployments()]);
      addToast('Ad set created', 'success');
    } catch (err) {
      addToast(err.message || 'Failed to create ad set', 'error');
    } finally {
      setBusy(false);
    }
  };

  const openEdit = ({ type, adSet = null, campaign = null, deps }) => {
    const first = deps[0] || {};
    setEditModal({
      type,
      adSet,
      deps,
      form: {
        name: type === 'adset' ? (adSet?.name || '') : depName(first),
        campaignId: campaign?.id || first.local_campaign_id || '',
        newCampaignName: '',
        adSetName: type === 'adset' ? (adSet?.name || '') : '',
        destination_url: firstValue(deps, 'destination_url') || firstValue(deps, 'landing_page_url'),
        display_link: firstValue(deps, 'display_link'),
        cta_button: firstValue(deps, 'cta_button') || 'LEARN_MORE',
        facebook_page: firstValue(deps, 'facebook_page'),
        duplicate_adset_name: firstValue(deps, 'duplicate_adset_name'),
        planned_date: firstValue(deps, 'planned_date'),
        notes: firstValue(deps, 'notes'),
        primary_texts: readJsonList(firstValue(deps, 'primary_texts')).join('\n'),
        ad_headlines: readJsonList(firstValue(deps, 'ad_headlines')).join('\n'),
      },
    });
  };

  const saveEdit = async () => {
    if (!editModal) return;
    const { type, adSet, deps, form } = editModal;
    const ids = deps.map(d => d.id);
    setBusy(true);
    try {
      let campaignId = form.campaignId;
      if (form.newCampaignName.trim()) {
        const created = await api.createCampaign(projectId, form.newCampaignName.trim());
        campaignId = created.id;
      }

      let adSetId = adSet?.id || '';
      if (type === 'adset') {
        await api.updateAdSet(adSet.id, {
          name: form.name.trim() || adSet.name,
          ...(campaignId ? { campaign_id: campaignId } : {}),
        });
      } else if (campaignId && form.adSetName.trim()) {
        const created = await api.createAdSetFromDeployments(projectId, {
          deploymentIds: ids,
          campaignId,
          adSetName: form.adSetName.trim(),
        });
        adSetId = created.adSetId;
        campaignId = created.campaignId;
      }

      const deploymentFields = {
        ...(type === 'single' && form.name.trim() ? { ad_name: form.name.trim() } : {}),
        ...(campaignId ? { local_campaign_id: campaignId } : {}),
        ...(adSetId ? { local_adset_id: adSetId } : {}),
        destination_url: form.destination_url || '',
        display_link: form.display_link || '',
        cta_button: form.cta_button || '',
        facebook_page: form.facebook_page || '',
        duplicate_adset_name: form.duplicate_adset_name || '',
        planned_date: form.planned_date || '',
        notes: form.notes || '',
        primary_texts: linesToJson(form.primary_texts),
        ad_headlines: linesToJson(form.ad_headlines),
      };
      await Promise.all(ids.map(id => api.updateDeployment(id, deploymentFields)));
      setEditModal(null);
      await Promise.all([loadMeta(), loadDeployments()]);
      addToast('Changes saved', 'success');
    } catch (err) {
      addToast(err.message || 'Failed to save changes', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex gap-5 items-start">
      <section className="w-[300px] flex-shrink-0 sticky top-4 card p-4 max-h-[calc(100vh-120px)] flex flex-col">
        <div className="mb-3">
          <div className="flex items-center justify-between">
            <h3 className="text-[13px] font-semibold text-textdark">Queue</h3>
            <span className="text-[11px] text-textlight bg-black/5 px-2 py-0.5 rounded-full">{queueDeps.length}</span>
          </div>
          <p className="text-[10px] text-textmid mt-1 leading-relaxed">Ads sent from the gallery land here before planning.</p>
        </div>

        {selectedQueue.size > 0 && (
          <Toolbar
            count={selectedQueue.size}
            onPrimary={() => moveToPlanner([...selectedQueue])}
            primaryLabel="Move to Planner"
            onDelete={() => setDeleteConfirm({ ids: [...selectedQueue] })}
            onClear={() => setSelectedQueue(new Set())}
          />
        )}

        <div className="flex-1 overflow-y-auto scrollbar-thin -mx-1 px-1">
          {queueDeps.length === 0 ? (
            <Empty text="No ads in queue." />
          ) : (
            <div className="space-y-1.5">
              {queueDeps.map(dep => (
                <DeploymentRow
                  key={dep.id}
                  dep={dep}
                  selected={selectedQueue.has(dep.id)}
                  onToggle={() => toggleMany(setSelectedQueue, selectedQueue, [dep.id])}
                />
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="flex-1 min-w-0 card p-4">
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <h3 className="text-[14px] font-semibold text-textdark">Planner</h3>
            <p className="text-[11px] text-textmid mt-0.5">Group ads into ad sets, assign campaigns, then move them to Ready to Post.</p>
          </div>
          <span className="text-[11px] text-textlight bg-black/5 px-2 py-0.5 rounded-full">{plannerDeps.length} ads</span>
        </div>

        {selectedPlanner.size > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 mb-3 text-[10px] p-2.5 rounded-xl bg-navy/5 border border-navy/10">
            <span className="text-navy font-medium">{selectedPlanner.size} selected</span>
            <button onClick={() => setCreateModal({ ids: [...selectedPlanner] })} className="px-2 py-1 rounded-lg bg-navy text-white hover:bg-navy-light transition-colors">Create Ad Set</button>
            <button onClick={() => markReady([...selectedPlanner])} className="px-2 py-1 rounded-lg bg-teal/10 border border-teal/30 text-teal font-medium hover:bg-teal/20 transition-colors">Ready to Post</button>
            <button onClick={() => moveToQueue([...selectedPlanner])} className="px-2 py-1 rounded-lg bg-white border border-gray-200 text-textmid hover:bg-gray-50 transition-colors">Move to Queue</button>
            <button onClick={() => setDeleteConfirm({ ids: [...selectedPlanner] })} className="px-2 py-1 rounded-lg bg-red-50 border border-red-200 text-red-600 hover:bg-red-100 transition-colors">Delete</button>
            <button onClick={() => setSelectedPlanner(new Set())} className="text-textlight hover:text-textmid ml-1">Clear</button>
          </div>
        )}

        {loadingMeta ? (
          <Empty text="Loading planner..." />
        ) : plannerDeps.length === 0 ? (
          <Empty text="Move ads from Queue to start planning." />
        ) : (
          <div className="space-y-2">
            {groups.map(group => (
              <AdSetCard
                key={group.adSet.id}
                group={group}
                selectedIds={selectedPlanner}
                onToggle={() => toggleMany(setSelectedPlanner, selectedPlanner, group.deps.map(d => d.id))}
                onEdit={() => openEdit({ type: 'adset', ...group })}
                onReady={() => markReady(group.deps.map(d => d.id))}
                onQueue={() => moveToQueue(group.deps.map(d => d.id))}
              />
            ))}
            {standalone.map(dep => (
              <DeploymentRow
                key={dep.id}
                dep={dep}
                selected={selectedPlanner.has(dep.id)}
                inPlanner
                onToggle={() => toggleMany(setSelectedPlanner, selectedPlanner, [dep.id])}
                onEdit={() => openEdit({ type: 'single', deps: [dep] })}
                onReady={() => markReady([dep.id])}
                onQueue={() => moveToQueue([dep.id])}
              />
            ))}
          </div>
        )}
      </section>

      {createModal && (
        <AdSetFormDialog
          title="Create Ad Set"
          campaigns={campaigns}
          busy={busy}
          onCancel={() => setCreateModal(null)}
          onSubmit={createAdSet}
        />
      )}

      {editModal && (
        <EditDialog
          editModal={editModal}
          setEditModal={setEditModal}
          campaigns={campaigns}
          busy={busy}
          onCancel={() => setEditModal(null)}
          onSave={saveEdit}
        />
      )}

      <ConfirmDialog
        open={!!deleteConfirm}
        title="Remove ads?"
        message="This removes the selected ads from the pipeline. The original gallery creatives are not deleted."
        confirmLabel="Remove"
        tone="danger"
        onConfirm={() => deleteIds(deleteConfirm?.ids || [])}
        onCancel={() => setDeleteConfirm(null)}
      />
    </div>
  );
}

function Toolbar({ count, onPrimary, primaryLabel, onDelete, onClear }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 mb-3 text-[10px] p-2.5 rounded-xl bg-navy/5 border border-navy/10">
      <span className="text-navy font-medium">{count} selected</span>
      <button onClick={onPrimary} className="px-2 py-0.5 rounded-md bg-teal/10 border border-teal/20 text-teal font-medium hover:bg-teal/20 transition-colors">{primaryLabel}</button>
      <button onClick={onDelete} className="px-2 py-0.5 rounded-md bg-red-50 border border-red-200 text-red-600 hover:bg-red-100 transition-colors">Delete</button>
      <button onClick={onClear} className="text-textlight hover:text-textmid">Clear</button>
    </div>
  );
}

function Empty({ text }) {
  return <div className="py-8 text-center text-[11px] text-textlight">{text}</div>;
}

function Check({ selected, onClick }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className={`w-[14px] h-[14px] rounded flex-shrink-0 flex items-center justify-center transition-colors ${
        selected ? 'bg-navy' : 'border-[1.5px] border-textlight/60 hover:border-navy/40'
      }`}
    >
      {selected && <svg className="w-2 h-2 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
    </button>
  );
}

function DeploymentRow({ dep, selected, onToggle, inPlanner = false, onEdit, onReady, onQueue }) {
  return (
    <div className={`group flex items-center gap-2.5 p-2 rounded-xl border transition-all ${selected ? 'border-navy/30 bg-navy/5' : 'border-black/[0.04] hover:border-black/[0.08] hover:bg-black/[0.02]'}`}>
      <Check selected={selected} onClick={onToggle} />
      {dep.imageUrl ? <img src={dep.imageUrl} alt="" className="w-10 h-10 object-cover rounded-lg bg-gray-100" loading="lazy" /> : <div className="w-10 h-10 rounded-lg bg-gray-100" />}
      <div className="min-w-0 flex-1">
        <div className="text-[12px] font-medium text-textdark truncate">{depName(dep)}</div>
        <div className="text-[10px] text-textlight truncate">{dep.ad?.headline || dep.ad?.angle || dep.id}</div>
      </div>
      {inPlanner && (
        <div className="opacity-100 md:opacity-0 md:group-hover:opacity-100 flex items-center gap-1 transition-opacity">
          <SmallButton onClick={onEdit}>Edit</SmallButton>
          <SmallButton onClick={onReady}>Ready</SmallButton>
          <SmallButton onClick={onQueue}>Queue</SmallButton>
        </div>
      )}
    </div>
  );
}

function AdSetCard({ group, selectedIds, onToggle, onEdit, onReady, onQueue }) {
  const allSelected = group.deps.every(d => selectedIds.has(d.id));
  return (
    <div className={`rounded-2xl border bg-white overflow-hidden ${allSelected ? 'border-navy/30 ring-1 ring-navy/10' : 'border-black/[0.06]'}`}>
      <div className="flex items-start gap-3 p-3">
        <Check selected={allSelected} onClick={onToggle} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <div className="text-[13px] font-semibold text-textdark truncate">{group.adSet.name}</div>
            <span className="text-[9px] font-bold text-teal bg-teal/10 px-1.5 py-0.5 rounded tracking-wide">{group.deps.length} ads</span>
          </div>
          <div className="text-[10px] text-textmid mt-0.5">{group.campaign?.name || 'No campaign'} / {group.adSet.name}</div>
          <div className="flex gap-1 mt-2">
            {group.deps.slice(0, 6).map(dep => dep.imageUrl ? (
              <img key={dep.id} src={dep.imageUrl} alt="" className="w-11 h-11 object-cover rounded-lg bg-gray-100" loading="lazy" />
            ) : <div key={dep.id} className="w-11 h-11 rounded-lg bg-gray-100" />)}
            {group.deps.length > 6 && <div className="w-11 h-11 rounded-lg bg-gray-100 flex items-center justify-center text-[10px] text-textlight">+{group.deps.length - 6}</div>}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <SmallButton onClick={onEdit}>Edit</SmallButton>
          <SmallButton onClick={onReady}>Ready</SmallButton>
          <SmallButton onClick={onQueue}>Queue</SmallButton>
        </div>
      </div>
    </div>
  );
}

function SmallButton({ children, onClick }) {
  return <button onClick={(e) => { e.stopPropagation(); onClick?.(); }} className="px-2 py-1 rounded-lg bg-black/[0.04] hover:bg-black/[0.08] text-[10px] text-textmid transition-colors">{children}</button>;
}

function AdSetFormDialog({ title, campaigns, busy, onCancel, onSubmit }) {
  const [form, setForm] = useState({ campaignId: '', newCampaignName: '', adSetName: '' });
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-card-hover p-5 space-y-4">
        <h3 className="text-[15px] font-semibold text-textdark">{title}</h3>
        <Field label="Campaign">
          <select value={form.campaignId} onChange={e => setForm(f => ({ ...f, campaignId: e.target.value, newCampaignName: '' }))} className="input-apple w-full">
            <option value="">Create new campaign</option>
            {campaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        {!form.campaignId && (
          <Field label="New Campaign Name">
            <input value={form.newCampaignName} onChange={e => setForm(f => ({ ...f, newCampaignName: e.target.value }))} className="input-apple w-full" placeholder="Campaign name" />
          </Field>
        )}
        <Field label="Ad Set Name">
          <input value={form.adSetName} onChange={e => setForm(f => ({ ...f, adSetName: e.target.value }))} className="input-apple w-full" placeholder="Ad set name" />
        </Field>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="btn-secondary text-[12px]">Cancel</button>
          <button onClick={() => onSubmit(form)} disabled={busy} className="btn-primary text-[12px] disabled:opacity-50">{busy ? 'Saving...' : 'Create'}</button>
        </div>
      </div>
    </div>
  );
}

function EditDialog({ editModal, setEditModal, campaigns, busy, onCancel, onSave }) {
  const form = editModal.form;
  const update = (key, value) => setEditModal(prev => ({ ...prev, form: { ...prev.form, [key]: value } }));
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto bg-white rounded-2xl shadow-card-hover p-5 space-y-4">
        <h3 className="text-[15px] font-semibold text-textdark">{editModal.type === 'adset' ? 'Edit Ad Set' : 'Edit Ad'}</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label={editModal.type === 'adset' ? 'Ad Set Name' : 'Ad Name'}><input value={form.name} onChange={e => update('name', e.target.value)} className="input-apple w-full" /></Field>
          <Field label="Campaign"><select value={form.campaignId} onChange={e => update('campaignId', e.target.value)} className="input-apple w-full"><option value="">None</option>{campaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
          <Field label="New Campaign Name"><input value={form.newCampaignName} onChange={e => update('newCampaignName', e.target.value)} className="input-apple w-full" placeholder="Optional" /></Field>
          {editModal.type === 'single' && <Field label="Ad Set Name"><input value={form.adSetName} onChange={e => update('adSetName', e.target.value)} className="input-apple w-full" placeholder="Optional" /></Field>}
          <Field label="Website URL"><input value={form.destination_url} onChange={e => update('destination_url', e.target.value)} className="input-apple w-full" placeholder="https://..." /></Field>
          <Field label="Display Link"><input value={form.display_link} onChange={e => update('display_link', e.target.value)} className="input-apple w-full" /></Field>
          <Field label="CTA"><select value={form.cta_button} onChange={e => update('cta_button', e.target.value)} className="input-apple w-full">{CTA_OPTIONS.map(c => <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}</select></Field>
          <Field label="Planned Date"><input type="date" value={form.planned_date} onChange={e => update('planned_date', e.target.value)} className="input-apple w-full" /></Field>
          <Field label="Facebook Page"><input value={form.facebook_page} onChange={e => update('facebook_page', e.target.value)} className="input-apple w-full" /></Field>
          <Field label="Duplicate Ad Set Name"><input value={form.duplicate_adset_name} onChange={e => update('duplicate_adset_name', e.target.value)} className="input-apple w-full" /></Field>
        </div>
        <Field label="Primary Texts (one per line)"><textarea rows={4} value={form.primary_texts} onChange={e => update('primary_texts', e.target.value)} className="input-apple w-full font-mono text-xs" /></Field>
        <Field label="Headlines (one per line)"><textarea rows={3} value={form.ad_headlines} onChange={e => update('ad_headlines', e.target.value)} className="input-apple w-full font-mono text-xs" /></Field>
        <Field label="Notes"><textarea rows={3} value={form.notes} onChange={e => update('notes', e.target.value)} className="input-apple w-full" /></Field>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="btn-secondary text-[12px]">Cancel</button>
          <button onClick={onSave} disabled={busy} className="btn-primary text-[12px] disabled:opacity-50">{busy ? 'Saving...' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="text-[11px] font-medium text-textmid block mb-1">{label}</span>
      {children}
    </label>
  );
}

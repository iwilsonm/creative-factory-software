import { useEffect, useMemo, useState } from 'react';
import JSZip from 'jszip';
import { api } from '../api';
import ConfirmDialog from './ConfirmDialog';

const CTA_OPTIONS = ['SHOP_NOW', 'LEARN_MORE', 'SIGN_UP', 'BUY_NOW', 'GET_OFFER', 'ORDER_NOW', 'SUBSCRIBE', 'CONTACT_US', 'DOWNLOAD', 'APPLY_NOW', 'BOOK_NOW', 'GET_QUOTE', 'NO_BUTTON'];

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

function firstValue(deps, key) {
  return deps.find(d => d?.[key])?.[key] || '';
}

function linesToJson(value) {
  return JSON.stringify(String(value || '').split('\n').map(v => v.trim()).filter(Boolean));
}

export default function AdSetReadyToPostView({ projectId, deployments, setDeployments, addToast, loadDeployments, onSwitchToPlanner, isPoster, highlightAdSetId, onHighlightDone }) {
  const [campaigns, setCampaigns] = useState([]);
  const [adSets, setAdSets] = useState([]);
  const [loadingMeta, setLoadingMeta] = useState(true);
  const [expanded, setExpanded] = useState(new Set());
  const [selected, setSelected] = useState(new Map());
  const [editing, setEditing] = useState(null);
  const [confirmPosted, setConfirmPosted] = useState(null);
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState(new Set());
  const [posting, setPosting] = useState(new Set());

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

  useEffect(() => {
    if (!highlightAdSetId) return;
    setExpanded(prev => new Set(prev).add(`adset-${highlightAdSetId}`));
    onHighlightDone?.();
  }, [highlightAdSetId]);

  const readyDeps = useMemo(() => deployments.filter(d => d.status === 'ready_to_post'), [deployments]);

  const { groups, standalone } = useMemo(() => {
    const adSetById = new Map(adSets.map(a => [a.id, a]));
    const campaignById = new Map(campaigns.map(c => [c.id, c]));
    const grouped = new Map();
    const solo = [];
    for (const dep of readyDeps) {
      const adSet = dep.local_adset_id ? adSetById.get(dep.local_adset_id) : null;
      if (!adSet) {
        solo.push(dep);
        continue;
      }
      if (!grouped.has(adSet.id)) {
        grouped.set(adSet.id, { key: `adset-${adSet.id}`, adSet, campaign: campaignById.get(adSet.campaign_id) || null, deps: [] });
      }
      grouped.get(adSet.id).deps.push(dep);
    }
    return { groups: Array.from(grouped.values()), standalone: solo };
  }, [adSets, campaigns, readyDeps]);

  const allCards = [
    ...groups,
    ...standalone.map(dep => ({ key: `single-${dep.id}`, dep, deps: [dep], adSet: null, campaign: null })),
  ];

  const toggleSelected = (card) => {
    setSelected(prev => {
      const next = new Map(prev);
      if (next.has(card.key)) next.delete(card.key);
      else next.set(card.key, card);
      return next;
    });
  };

  const toggleExpanded = (key) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const updateDepsStatus = async (deps, status) => {
    const ids = deps.map(d => d.id);
    setDeployments(prev => prev.map(d => ids.includes(d.id) ? { ...d, status, posted_date: status === 'posted' ? new Date().toISOString() : d.posted_date } : d));
    await Promise.all(ids.map(id => api.updateDeploymentStatus(id, status)));
  };

  const markPosted = async (card) => {
    setConfirmPosted(null);
    setBusy(true);
    try {
      if (card.adSet) {
        await api.updateAdSetDeploymentStatus(card.adSet.id, 'posted');
        setDeployments(prev => prev.map(d => card.deps.some(dep => dep.id === d.id)
          ? { ...d, status: 'posted', posted_date: new Date().toISOString(), campaign_name: card.campaign?.name || d.campaign_name, ad_set_name: card.adSet.name || d.ad_set_name }
          : d
        ));
      } else {
        await updateDepsStatus(card.deps, 'posted');
      }
      addToast(`${card.deps.length} ad${card.deps.length === 1 ? '' : 's'} marked posted`, 'success');
    } catch {
      addToast('Failed to mark posted', 'error');
      loadDeployments();
    } finally {
      setBusy(false);
    }
  };

  const postToMeta = async (card) => {
    if (!card.adSet) return;
    setPosting(prev => new Set(prev).add(card.key));
    try {
      const result = await api.postAdSetToMeta(card.adSet.id);
      await api.updateAdSetDeploymentStatus(card.adSet.id, 'posted');
      setDeployments(prev => prev.map(d => card.deps.some(dep => dep.id === d.id)
        ? { ...d, status: 'posted', posted_date: new Date().toISOString(), campaign_name: card.campaign?.name || d.campaign_name, ad_set_name: card.adSet.name || d.ad_set_name }
        : d
      ));
      const count = result?.meta_ad_ids?.length || card.deps.length;
      addToast(`Posted ${count} ad${count === 1 ? '' : 's'} to Meta`, 'success');
    } catch (err) {
      addToast(err.message || 'Failed to post to Meta', 'error');
      loadDeployments();
    } finally {
      setPosting(prev => { const next = new Set(prev); next.delete(card.key); return next; });
    }
  };

  const sendBack = async (card) => {
    setBusy(true);
    try {
      await updateDepsStatus(card.deps, 'selected');
      addToast('Sent back to Planner', 'success');
    } catch {
      addToast('Failed to send back', 'error');
      loadDeployments();
    } finally {
      setBusy(false);
    }
  };

  const downloadImages = async (card) => {
    const deps = card.deps.filter(d => d.imageUrl);
    if (deps.length === 0) {
      addToast('No images to download', 'error');
      return;
    }
    setDownloading(prev => new Set(prev).add(card.key));
    try {
      if (deps.length === 1) {
        await downloadOne(deps[0]);
      } else {
        const zip = new JSZip();
        const files = await Promise.all(deps.map(async dep => {
          const res = await fetch(dep.imageUrl);
          const blob = await res.blob();
          return { dep, blob, ext: blob.type === 'image/jpeg' ? '.jpg' : '.png' };
        }));
        const used = new Set();
        files.forEach(({ dep, blob, ext }) => {
          const base = depName(dep).replace(/[^a-z0-9]/gi, '-').slice(0, 40) || dep.id;
          let name = `${base}${ext}`;
          let i = 1;
          while (used.has(name)) name = `${base}-${i++}${ext}`;
          used.add(name);
          zip.file(name, blob);
        });
        const content = await zip.generateAsync({ type: 'blob' });
        saveBlob(content, `${card.adSet?.name || 'ad-set'}-images.zip`);
      }
      addToast(`Downloaded ${deps.length} image${deps.length === 1 ? '' : 's'}`, 'success');
    } catch {
      addToast('Failed to download images', 'error');
    } finally {
      setDownloading(prev => { const next = new Set(prev); next.delete(card.key); return next; });
    }
  };

  const openEdit = (card) => {
    const first = card.deps[0] || {};
    setEditing({
      card,
      form: {
        name: card.adSet?.name || depName(first),
        campaignId: card.campaign?.id || first.local_campaign_id || '',
        newCampaignName: '',
        destination_url: firstValue(card.deps, 'destination_url') || firstValue(card.deps, 'landing_page_url'),
        display_link: firstValue(card.deps, 'display_link'),
        cta_button: firstValue(card.deps, 'cta_button') || 'LEARN_MORE',
        facebook_page: firstValue(card.deps, 'facebook_page'),
        duplicate_adset_name: firstValue(card.deps, 'duplicate_adset_name'),
        planned_date: firstValue(card.deps, 'planned_date'),
        notes: firstValue(card.deps, 'notes'),
        primary_texts: readJsonList(firstValue(card.deps, 'primary_texts')).join('\n'),
        ad_headlines: readJsonList(firstValue(card.deps, 'ad_headlines')).join('\n'),
      },
    });
  };

  const saveEdit = async () => {
    const { card, form } = editing;
    setBusy(true);
    try {
      let campaignId = form.campaignId;
      if (form.newCampaignName.trim()) {
        const created = await api.createCampaign(projectId, form.newCampaignName.trim());
        campaignId = created.id;
      }
      if (card.adSet) {
        await api.updateAdSet(card.adSet.id, {
          name: form.name.trim() || card.adSet.name,
          ...(campaignId ? { campaign_id: campaignId } : {}),
        });
      }
      const fields = {
        ...(!card.adSet && form.name.trim() ? { ad_name: form.name.trim() } : {}),
        ...(campaignId ? { local_campaign_id: campaignId } : {}),
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
      await Promise.all(card.deps.map(dep => api.updateDeployment(dep.id, fields)));
      setEditing(null);
      await Promise.all([loadMeta(), loadDeployments()]);
      addToast('Changes saved', 'success');
    } catch {
      addToast('Failed to save changes', 'error');
    } finally {
      setBusy(false);
    }
  };

  const bulkPosted = async () => {
    const cards = Array.from(selected.values());
    setBusy(true);
    try {
      for (const card of cards) {
        if (card.adSet) await api.updateAdSetDeploymentStatus(card.adSet.id, 'posted');
        else await Promise.all(card.deps.map(dep => api.updateDeploymentStatus(dep.id, 'posted')));
      }
      setSelected(new Map());
      await loadDeployments();
      addToast(`${cards.length} card${cards.length === 1 ? '' : 's'} marked posted`, 'success');
    } catch {
      addToast('Failed to bulk mark posted', 'error');
      loadDeployments();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-[15px] font-semibold text-textdark">Ready to Post</h3>
          <p className="text-[11px] text-textmid mt-0.5">Ad sets ready for the posting workflow.</p>
        </div>
        {!isPoster && <button onClick={onSwitchToPlanner} className="btn-secondary text-[12px]">Back to Planner</button>}
      </div>

      {selected.size > 0 && (
        <div className="flex items-center gap-2 p-3 bg-navy/5 border border-navy/10 rounded-xl text-[11px]">
          <span className="font-semibold text-navy">{selected.size} selected</span>
          <button onClick={bulkPosted} disabled={busy} className="px-3 py-1.5 rounded-lg bg-teal text-white disabled:opacity-50">Mark Posted</button>
          <button onClick={() => setSelected(new Map())} className="text-textlight hover:text-textmid">Clear</button>
        </div>
      )}

      {loadingMeta ? (
        <Empty text="Loading ready ad sets..." />
      ) : allCards.length === 0 ? (
        <div className="card p-8 text-center">
          <div className="text-[14px] font-semibold text-textdark">Nothing ready yet</div>
          <p className="text-[12px] text-textmid mt-1">Move planned ad sets to Ready to Post when they are prepared.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {allCards.map(card => (
            <ReadyCard
              key={card.key}
              card={card}
              selected={selected.has(card.key)}
              expanded={expanded.has(card.key)}
              downloading={downloading.has(card.key)}
              posting={posting.has(card.key)}
              isPoster={isPoster}
              onSelect={() => toggleSelected(card)}
              onExpand={() => toggleExpanded(card.key)}
              onEdit={() => openEdit(card)}
              onDownload={() => downloadImages(card)}
              onPostToMeta={() => postToMeta(card)}
              onSendBack={() => sendBack(card)}
              onPosted={() => setConfirmPosted(card)}
            />
          ))}
        </div>
      )}

      {editing && <EditDialog editing={editing} setEditing={setEditing} campaigns={campaigns} busy={busy} onCancel={() => setEditing(null)} onSave={saveEdit} />}

      <ConfirmDialog
        open={!!confirmPosted}
        title="Mark as posted?"
        message={`This will move ${confirmPosted?.deps?.length || 0} ad${confirmPosted?.deps?.length === 1 ? '' : 's'} to Posted.`}
        confirmLabel="Mark Posted"
        onConfirm={() => markPosted(confirmPosted)}
        onCancel={() => setConfirmPosted(null)}
      />
    </div>
  );
}

function ReadyCard({ card, selected, expanded, downloading, posting, isPoster, onSelect, onExpand, onEdit, onDownload, onPostToMeta, onSendBack, onPosted }) {
  const deps = card.deps || [];
  const primaryTexts = readJsonList(firstValue(deps, 'primary_texts'));
  const headlines = readJsonList(firstValue(deps, 'ad_headlines'));
  const name = card.adSet?.name || depName(deps[0] || {});
  return (
    <div className={`border rounded-2xl bg-white shadow-sm overflow-hidden ${selected ? 'border-navy/30 ring-1 ring-navy/10' : 'border-black/[0.08]'}`}>
      <div className="px-5 py-4 space-y-3">
        <div className="flex items-start gap-3">
          <button onClick={onSelect} className={`mt-1 w-[15px] h-[15px] rounded flex items-center justify-center ${selected ? 'bg-navy' : 'border-[1.5px] border-textlight/60'}`}>
            {selected && <svg className="w-2 h-2 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
          </button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h4 className="text-[15px] font-bold text-textdark">{name}</h4>
              <span className="px-2 py-0.5 rounded bg-teal/10 text-teal text-[9px] font-bold uppercase tracking-wider">{card.adSet ? 'Ad Set' : 'Single Ad'}</span>
              <span className="px-2 py-0.5 rounded bg-navy/10 text-navy text-[9px] font-bold uppercase tracking-wider">{deps.length} image{deps.length === 1 ? '' : 's'}</span>
            </div>
            {(card.campaign?.name || card.adSet?.name) && <p className="text-[11px] text-textmid mt-1">{card.campaign?.name || 'No campaign'} / {card.adSet?.name || 'Ungrouped'}</p>}
          </div>
          <div className="flex gap-1">
            {deps.slice(0, 5).map(dep => dep.imageUrl ? <img key={dep.id} src={dep.imageUrl} alt="" className="w-12 h-12 object-cover rounded-lg bg-gray-100" loading="lazy" /> : <div key={dep.id} className="w-12 h-12 rounded-lg bg-gray-100" />)}
            {deps.length > 5 && <div className="w-12 h-12 rounded-lg bg-gray-100 flex items-center justify-center text-[10px] text-textlight">+{deps.length - 5}</div>}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <CopySection title="Primary Texts" items={primaryTexts} />
          <CopySection title="Headlines" items={headlines} />
        </div>

        <button onClick={onExpand} className="w-full py-1.5 rounded-lg bg-navy/5 hover:bg-navy/10 text-[11px] text-navy font-medium">{expanded ? 'Hide Details' : 'Show Details'}</button>
        {expanded && <Details deps={deps} />}
      </div>
      <div className="px-5 py-3 border-t border-black/[0.06] bg-offwhite/50 flex flex-wrap items-center justify-end gap-2">
        {!isPoster && <button onClick={onEdit} className="btn-secondary text-[11px] px-3 py-1.5">Edit</button>}
        <button onClick={onDownload} disabled={downloading} className="btn-secondary text-[11px] px-3 py-1.5 disabled:opacity-50">{downloading ? 'Downloading...' : 'Download'}</button>
        {!isPoster && card.adSet && <button onClick={onPostToMeta} disabled={posting} className="btn-secondary text-[11px] px-3 py-1.5 disabled:opacity-50">{posting ? 'Posting...' : 'Post to Meta'}</button>}
        {!isPoster && <button onClick={onSendBack} className="btn-secondary text-[11px] px-3 py-1.5">Back to Planner</button>}
        <button onClick={onPosted} className="btn-primary text-[11px] px-3 py-1.5">Mark Posted</button>
      </div>
    </div>
  );
}

function CopySection({ title, items }) {
  if (!items.length) return <div className="border border-dashed border-black/10 rounded-xl p-3 text-[11px] text-textlight">{title}: empty</div>;
  const copy = async (text) => navigator.clipboard?.writeText(text).catch(() => {});
  return (
    <div className="border border-black/[0.06] rounded-xl p-3">
      <div className="text-[10px] font-bold text-navy uppercase tracking-wider mb-2">{title}</div>
      <div className="space-y-2">
        {items.map((item, i) => (
          <div key={i} className="flex items-start gap-2 text-[12px]">
            <span className="w-5 h-5 rounded-full bg-navy text-white text-[10px] flex items-center justify-center flex-shrink-0">{i + 1}</span>
            <div className="flex-1 whitespace-pre-wrap">{item}</div>
            <button onClick={() => copy(item)} className="text-[10px] text-gold hover:underline">Copy</button>
          </div>
        ))}
      </div>
    </div>
  );
}

function Details({ deps }) {
  const first = deps[0] || {};
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] text-textmid">
      <Detail label="URL" value={first.destination_url || first.landing_page_url} link />
      <Detail label="Display Link" value={first.display_link} />
      <Detail label="CTA" value={first.cta_button?.replace(/_/g, ' ')} />
      <Detail label="Facebook Page" value={first.facebook_page} />
      <Detail label="Planned Date" value={first.planned_date} />
      <Detail label="Notes" value={first.notes} />
    </div>
  );
}

function Detail({ label, value, link }) {
  if (!value) return null;
  return <div><span className="font-medium text-textdark">{label}:</span> {link ? <a href={value} target="_blank" rel="noopener noreferrer" className="text-gold hover:underline break-all">{value}</a> : <span>{value}</span>}</div>;
}

function EditDialog({ editing, setEditing, campaigns, busy, onCancel, onSave }) {
  const form = editing.form;
  const update = (key, value) => setEditing(prev => ({ ...prev, form: { ...prev.form, [key]: value } }));
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
      <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto bg-white rounded-2xl shadow-card-hover p-5 space-y-4">
        <h3 className="text-[15px] font-semibold text-textdark">Edit Ready Ad Set</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Name"><input value={form.name} onChange={e => update('name', e.target.value)} className="input-apple w-full" /></Field>
          <Field label="Campaign"><select value={form.campaignId} onChange={e => update('campaignId', e.target.value)} className="input-apple w-full"><option value="">None</option>{campaigns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
          <Field label="New Campaign Name"><input value={form.newCampaignName} onChange={e => update('newCampaignName', e.target.value)} className="input-apple w-full" placeholder="Optional" /></Field>
          <Field label="Website URL"><input value={form.destination_url} onChange={e => update('destination_url', e.target.value)} className="input-apple w-full" /></Field>
          <Field label="Display Link"><input value={form.display_link} onChange={e => update('display_link', e.target.value)} className="input-apple w-full" /></Field>
          <Field label="CTA"><select value={form.cta_button} onChange={e => update('cta_button', e.target.value)} className="input-apple w-full">{CTA_OPTIONS.map(c => <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}</select></Field>
          <Field label="Facebook Page"><input value={form.facebook_page} onChange={e => update('facebook_page', e.target.value)} className="input-apple w-full" /></Field>
          <Field label="Planned Date"><input type="date" value={form.planned_date} onChange={e => update('planned_date', e.target.value)} className="input-apple w-full" /></Field>
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
  return <label className="block"><span className="text-[11px] font-medium text-textmid block mb-1">{label}</span>{children}</label>;
}

function Empty({ text }) {
  return <div className="card p-8 text-center text-[12px] text-textmid">{text}</div>;
}

async function downloadOne(dep) {
  const res = await fetch(dep.imageUrl);
  const blob = await res.blob();
  saveBlob(blob, `${depName(dep).replace(/[^a-z0-9]/gi, '-').slice(0, 40) || dep.id}.${blob.type === 'image/jpeg' ? 'jpg' : 'png'}`);
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

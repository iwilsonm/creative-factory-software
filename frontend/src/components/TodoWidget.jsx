import { useState, useEffect, useRef } from 'react';
import { api } from '../api';

const AUTHOR_META = {
  Ian:  { color: 'bg-navy/10 text-navy', dotColor: 'bg-navy' },
  Luke: { color: 'bg-teal/10 text-teal', dotColor: 'bg-teal' },
};
const AUTHORS = Object.keys(AUTHOR_META);

const PRIORITY_META = {
  1: { label: 'P1', color: 'bg-red-500', textColor: 'text-red-600', bgLight: 'bg-red-50' },
  2: { label: 'P2', color: 'bg-orange-400', textColor: 'text-orange-600', bgLight: 'bg-orange-50' },
  3: { label: 'P3', color: 'bg-blue-400', textColor: 'text-blue-600', bgLight: 'bg-blue-50' },
  4: { label: 'P4', color: 'bg-gray-400', textColor: 'text-gray-500', bgLight: 'bg-gray-50' },
};
const PRIORITIES = [1, 2, 3, 4];

export default function TodoWidget() {
  const [todos, setTodos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newText, setNewText] = useState('');
  const [newAuthor, setNewAuthor] = useState('Ian');
  const [newPriority, setNewPriority] = useState(null);
  const [showNewNotes, setShowNewNotes] = useState(false);
  const [newNotes, setNewNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState('');
  const [editAuthor, setEditAuthor] = useState('Ian');
  const [editPriority, setEditPriority] = useState(null);
  const [editNotes, setEditNotes] = useState('');
  const [expandedNoteId, setExpandedNoteId] = useState(null);
  const inputRef = useRef(null);
  const editInputRef = useRef(null);

  useEffect(() => {
    api.getTodos()
      .then(data => setTodos(data.todos || []))
      .catch(() => setTodos([]))
      .finally(() => setLoading(false));
  }, []);

  const persist = async (updated) => {
    setTodos(updated);
    setSaving(true);
    try { await api.saveTodos(updated); } catch {}
    setSaving(false);
  };

  const addTodo = (e) => {
    e.preventDefault();
    const text = newText.trim();
    if (!text) return;
    persist([...todos, { id: Date.now(), text, done: false, author: newAuthor, notes: newNotes.trim() || '', priority: newPriority || undefined }]);
    setNewText('');
    setNewNotes('');
    setNewPriority(null);
    setShowNewNotes(false);
    inputRef.current?.focus();
  };

  const toggle = (id) => {
    persist(todos.map(t => t.id === id ? { ...t, done: !t.done } : t));
  };

  const remove = (id) => {
    persist(todos.filter(t => t.id !== id));
    if (expandedNoteId === id) setExpandedNoteId(null);
  };

  const startEdit = (todo) => {
    setEditingId(todo.id);
    setEditText(todo.text);
    setEditAuthor(todo.author || 'Ian');
    setEditPriority(todo.priority || null);
    setEditNotes(todo.notes || '');
    setTimeout(() => editInputRef.current?.focus(), 0);
  };

  const saveEdit = () => {
    const trimmed = editText.trim();
    if (!trimmed || !editingId) { cancelEdit(); return; }
    persist(todos.map(t => t.id === editingId ? { ...t, text: trimmed, author: editAuthor, priority: editPriority || undefined, notes: editNotes.trim() } : t));
    setEditingId(null);
    setEditText('');
    setEditPriority(null);
    setEditNotes('');
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditText('');
    setEditPriority(null);
    setEditNotes('');
  };

  const handleEditKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(); }
    if (e.key === 'Escape') { cancelEdit(); }
  };

  const prioritySort = (a, b) => {
    const pa = a.priority || 99;
    const pb = b.priority || 99;
    return pa - pb;
  };
  const pending = todos.filter(t => !t.done).sort(prioritySort);
  const completed = todos.filter(t => t.done).sort(prioritySort);

  const renderItem = (t, isDone) => {
    const isEditing = editingId === t.id;
    const isExpanded = expandedNoteId === t.id;
    const authorMeta = AUTHOR_META[t.author] || AUTHOR_META.Ian;

    return (
      <li key={t.id} className="px-1 -mx-1">
        <div className={`flex items-center gap-2 group ${isDone ? 'py-0.5' : 'py-1'} rounded-lg hover:bg-black/3 transition-colors`}>
          {isDone ? (
            <button onClick={() => toggle(t.id)} className="w-[18px] h-[18px] rounded-md bg-navy flex-shrink-0 flex items-center justify-center">
              <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
              </svg>
            </button>
          ) : (
            <button onClick={() => toggle(t.id)} className="w-[18px] h-[18px] rounded-md border-2 border-gray-300 flex-shrink-0 hover:border-gold transition-colors" />
          )}

          {isEditing ? (
            <div className="flex-1 space-y-1.5">
              <input ref={editInputRef} value={editText} onChange={e => setEditText(e.target.value)} onKeyDown={handleEditKeyDown}
                className="text-[13px] text-textdark w-full bg-white border border-gold rounded-md px-1.5 py-0.5 outline-none ring-2 ring-gold/15" />
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-0.5 bg-gray-100 rounded-md p-0.5">
                  {AUTHORS.map(a => (
                    <button key={a} type="button" onClick={() => setEditAuthor(a)}
                      className={`text-[10px] px-2 py-0.5 rounded font-medium transition-colors ${editAuthor === a ? `${AUTHOR_META[a].color}` : 'text-textlight hover:text-textmid'}`}>
                      {a}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-0.5 bg-gray-100 rounded-md p-0.5">
                  {PRIORITIES.map(p => {
                    const meta = PRIORITY_META[p];
                    return (
                      <button key={p} type="button" onClick={() => setEditPriority(prev => prev === p ? null : p)}
                        className={`text-[10px] px-1.5 py-0.5 rounded font-semibold transition-colors ${editPriority === p ? `${meta.bgLight} ${meta.textColor}` : 'text-textlight hover:text-textmid'}`}>
                        {meta.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <textarea value={editNotes} onChange={e => setEditNotes(e.target.value)} placeholder="Notes (optional)..." rows={2}
                className="text-[11px] text-textmid w-full bg-white border border-black/10 rounded-md px-1.5 py-1 outline-none focus:border-gold focus:ring-2 focus:ring-gold/15 resize-none" />
              <div className="flex items-center gap-1.5">
                <button onClick={saveEdit} className="btn-primary text-[10px] px-2.5 py-0.5">Save</button>
                <button onClick={cancelEdit} className="btn-secondary text-[10px] px-2.5 py-0.5">Cancel</button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 flex-1 min-w-0">
              {t.priority && PRIORITY_META[t.priority] && (
                <span className={`inline-flex items-center justify-center w-[18px] h-[14px] rounded text-[8px] font-bold text-white flex-shrink-0 ${PRIORITY_META[t.priority].color}`}>
                  {t.priority}
                </span>
              )}
              <span className={`text-[13px] ${isDone ? 'text-textlight line-through' : 'text-textdark'} cursor-text rounded px-0.5 truncate`}>
                {t.text}
              </span>
              {t.author && (
                <span className={`inline-flex items-center gap-0.5 px-1.5 py-0 rounded-full text-[9px] font-medium flex-shrink-0 ${authorMeta.color}`}>
                  {t.author}
                </span>
              )}
              {t.notes && (
                <button onClick={() => setExpandedNoteId(isExpanded ? null : t.id)} className="flex-shrink-0 text-gold/60 hover:text-gold transition-colors p-0.5" title="View notes">
                  <svg className="w-3 h-3" fill="currentColor" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
                  </svg>
                </button>
              )}
            </div>
          )}

          {!isEditing && (
            <div className="flex items-center gap-1 flex-shrink-0 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
              <button onClick={() => startEdit(t)} className="action-link">Edit</button>
              {!t.notes && (
                <button onClick={() => startEdit(t)} className="action-link text-gold bg-gold/10 hover:bg-gold/15 hover:text-gold">Add Notes</button>
              )}
              <button onClick={() => remove(t.id)} className="icon-button-danger" title="Delete">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          )}
        </div>

        {isExpanded && !isEditing && (
          <div className="ml-7 mt-0.5 mb-1.5 pl-2 border-l-2 border-gold/20 fade-in">
            <p className="text-[11px] text-textlight whitespace-pre-wrap">{t.notes}</p>
          </div>
        )}
      </li>
    );
  };

  if (loading) {
    return (
      <div className="card p-5 mb-8 fade-in">
        <div className="h-4 w-32 bg-gray-100 rounded animate-pulse mb-3" />
        <div className="h-3 w-48 bg-gray-50 rounded animate-pulse" />
      </div>
    );
  }

  return (
    <div className="card p-5 mb-8 fade-in">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-navy/10 flex items-center justify-center flex-shrink-0">
            <svg className="w-3.5 h-3.5 text-navy" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
            </svg>
          </div>
          <h2 className="text-[15px] font-semibold text-textdark tracking-tight">Roadmap</h2>
          {saving && <span className="text-[10px] text-textlight">saving...</span>}
        </div>
        {todos.length > 0 && (
          <span className="text-[11px] text-textlight">
            {completed.length}/{todos.length} done
          </span>
        )}
      </div>

      <form onSubmit={addTodo} className="mb-3">
        <div className="flex gap-2 items-center">
          <input ref={inputRef} value={newText} onChange={e => setNewText(e.target.value)} placeholder="Add a task..." className="input-apple text-[13px] py-1.5 flex-1" />
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <span className="text-[10px] text-textlight">by</span>
            <div className="flex items-center gap-0.5 bg-gray-100 rounded-md p-0.5">
              {AUTHORS.map(a => (
                <button key={a} type="button" onClick={() => setNewAuthor(a)}
                  className={`text-[10px] px-2 py-0.5 rounded font-medium transition-colors ${newAuthor === a ? `${AUTHOR_META[a].color}` : 'text-textlight hover:text-textmid'}`}>
                  {a}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-0.5 bg-gray-100 rounded-md p-0.5 flex-shrink-0">
            {PRIORITIES.map(p => {
              const meta = PRIORITY_META[p];
              return (
                <button key={p} type="button" onClick={() => setNewPriority(prev => prev === p ? null : p)}
                  className={`text-[10px] px-1.5 py-0.5 rounded font-semibold transition-colors ${newPriority === p ? `${meta.bgLight} ${meta.textColor}` : 'text-textlight hover:text-textmid'}`}>
                  {meta.label}
                </button>
              );
            })}
          </div>
          <button type="submit" disabled={!newText.trim()} className="btn-primary text-[12px] px-3 py-1.5 disabled:opacity-30">Add</button>
        </div>
        {showNewNotes ? (
          <textarea value={newNotes} onChange={e => setNewNotes(e.target.value)} placeholder="Notes (optional)..." rows={2} className="input-apple text-[11px] w-full mt-1.5 resize-none" />
        ) : (
          <button type="button" onClick={() => setShowNewNotes(true)} className="text-[10px] text-textlight/60 hover:text-textmid mt-1 transition-colors">+ Add notes</button>
        )}
      </form>

      {pending.length > 0 && (
        <ul className="space-y-0.5">
          {pending.map(t => renderItem(t, false))}
        </ul>
      )}

      {completed.length > 0 && (
        <div className={pending.length > 0 ? 'mt-3 pt-3 border-t border-black/5' : ''}>
          {pending.length > 0 && (
            <p className="text-[10px] font-medium text-textlight/60 uppercase tracking-wider mb-1">Completed</p>
          )}
          <ul className="space-y-0.5">
            {completed.map(t => renderItem(t, true))}
          </ul>
        </div>
      )}

      {todos.length === 0 && (
        <p className="text-[12px] text-textlight/60 text-center py-3">No tasks yet — add one above.</p>
      )}
    </div>
  );
}

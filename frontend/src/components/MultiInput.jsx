import { useState } from 'react';

export default function MultiInput({ items, onAdd, onRemove, placeholder, prefix = '' }) {
  const [input, setInput] = useState('');

  const handleKeyDown = (e) => {
    if ((e.key === 'Enter' || e.key === ',') && input.trim()) {
      e.preventDefault();
      onAdd(input.trim().replace(/^,|,$/g, ''));
      setInput('');
    }
    if (e.key === 'Backspace' && !input && items.length > 0) {
      onRemove(items.length - 1);
    }
  };

  return (
    <div className="flex flex-wrap gap-1.5 p-2 border border-black/5 rounded-xl bg-white/80 backdrop-blur focus-within:ring-2 focus-within:ring-gold/30 focus-within:border-gold transition-all min-h-[38px]">
      {items.map((item, i) => (
        <span key={i} className="inline-flex items-center gap-1 px-2 py-0.5 bg-navy/10 text-navy rounded-lg text-[12px] font-medium">
          {prefix}{item}
          <button onClick={() => onRemove(i)} className="text-navy/60 hover:text-navy ml-0.5">
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </span>
      ))}
      <input
        value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={items.length === 0 ? placeholder : 'Type + Enter...'}
        className="flex-1 min-w-[120px] outline-none text-[13px] bg-transparent"
      />
    </div>
  );
}

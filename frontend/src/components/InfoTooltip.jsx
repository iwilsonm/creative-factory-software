import { useEffect, useRef, useState } from 'react';

/**
 * InfoTooltip — info icon that shows explanatory text on hover (desktop)
 * or tap-to-toggle (touch devices). Dismisses on outside click.
 *
 * Props:
 *   text: string — tooltip content
 *   position?: 'top' | 'bottom' | 'left' | 'right' — default 'top'
 */
export default function InfoTooltip({ text, position = 'top' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('touchstart', handler);
    };
  }, [open]);

  return (
    <span
      ref={ref}
      className={`info-tooltip info-tooltip-${position}${open ? ' info-tooltip-open' : ''}`}
    >
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className="tap-compact inline-flex items-center justify-center p-0.5 bg-transparent border-0"
        aria-label="More info"
      >
        <svg
          className="w-3.5 h-3.5 text-textlight hover:text-textmid transition-colors cursor-help"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z"
          />
        </svg>
      </button>
      <span className="info-tooltip-text">{text}</span>
    </span>
  );
}

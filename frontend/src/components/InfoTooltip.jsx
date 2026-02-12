/**
 * InfoTooltip — a small info icon that shows explanatory text on hover.
 * Pure CSS, no dependencies. Dark bg, white text, absolute positioned.
 *
 * Props:
 *   text: string — tooltip content
 *   position?: 'top' | 'bottom' | 'left' | 'right' — default 'top'
 */
export default function InfoTooltip({ text, position = 'top' }) {
  return (
    <span className={`info-tooltip info-tooltip-${position}`}>
      <svg
        className="w-3.5 h-3.5 text-gray-400 hover:text-gray-500 transition-colors cursor-help"
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
      <span className="info-tooltip-text">{text}</span>
    </span>
  );
}

const STATUS_STYLES = {
  active:          { dot: 'bg-ed-green',  text: 'text-ed-green' },
  observing:       { dot: 'bg-ed-gold',   text: 'text-ed-gold' },
  failed:          { dot: 'bg-ed-rust',   text: 'text-ed-rust' },
  paused:          { dot: 'bg-ed-gray',   text: 'text-ed-gray' },
  ready:           { dot: 'bg-ed-green',  text: 'text-ed-green' },
  docsready:       { dot: 'bg-ed-green',  text: 'text-ed-green' },
  generatingdocs:  { dot: 'bg-ed-gold',   text: 'text-ed-gold' },
  posted:          { dot: 'bg-ed-green',  text: 'text-ed-green' },
  draft:           { dot: 'bg-ed-gray',   text: 'text-ed-gray' },
  setup:           { dot: 'bg-ed-gold',   text: 'text-ed-gold' },
  error:           { dot: 'bg-ed-rust',   text: 'text-ed-rust' },
};

const STATUS_LABELS = {
  docs_ready: 'Ready',
  generating_docs: 'Generating',
  ready_to_post: 'Ready',
  quality_rejected: 'Rejected',
};

const FALLBACK = { dot: 'bg-ed-gray', text: 'text-ed-gray' };

export default function StatusPill({ status, variant = 'editorial' }) {
  const key = (status || '').toLowerCase().replace(/[^a-z]/g, '');
  const style = STATUS_STYLES[key] || FALLBACK;
  const raw = status || 'Unknown';
  const label = STATUS_LABELS[raw] || raw.charAt(0).toUpperCase() + raw.slice(1);

  if (variant === 'mono') {
    return (
      <span className="inline-flex items-center gap-1.5">
        <span className={`w-[5px] h-[5px] rounded-full ${style.dot}`} />
        <span className={`font-mono-ed text-[10px] uppercase tracking-[0.06em] ${style.text}`}>
          {label}
        </span>
      </span>
    );
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`w-1.5 h-1.5 rounded-full ${style.dot}`} />
      <span className={`font-geist text-[12px] ${style.text}`}>
        {label}
      </span>
    </span>
  );
}

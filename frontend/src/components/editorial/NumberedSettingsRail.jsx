export default function NumberedSettingsRail({ sections, activeSection, onSectionChange, eyebrow, title, meta }) {
  return (
    <div className="py-8 pr-4 pl-8 border-r border-ed-line min-h-full">
      {eyebrow && (
        <div className="text-[10.5px] uppercase tracking-[0.16em] text-ed-ink3 mb-1.5">{eyebrow}</div>
      )}
      {title && (
        <h1 className="font-serif text-[24px] font-[420] tracking-[-0.02em] text-ed-ink mb-1.5">{title}</h1>
      )}
      {meta && (
        <div className="text-[11.5px] text-ed-ink3 leading-[1.5] mb-6">{meta}</div>
      )}
      <nav className="flex flex-col gap-px">
        {sections.map((s) => {
          const isActive = s.id === activeSection;
          return (
            <button
              key={s.id}
              onClick={() => onSectionChange(s.id)}
              className={`flex items-center gap-[9px] px-[10px] py-[8px] rounded-[7px] text-[13px] text-left transition-colors ${
                isActive
                  ? 'bg-ed-accent/[0.08] text-ed-accent'
                  : 'text-ed-ink2 hover:bg-black/[0.03] hover:text-ed-ink'
              }`}
            >
              <span className={`font-mono-ed text-[10px] w-[14px] flex-shrink-0 ${
                isActive ? 'text-ed-accent' : 'text-ed-ink3'
              }`}>
                {s.num}
              </span>
              <span className="flex-1">{s.label}</span>
              {s.status && (
                <span className={`w-[6px] h-[6px] rounded-full flex-shrink-0 ${
                  s.status === 'ok' ? 'bg-ed-green' :
                  s.status === 'warn' ? 'bg-ed-gold' :
                  'bg-ed-ink3 opacity-40'
                }`} />
              )}
            </button>
          );
        })}
      </nav>
    </div>
  );
}

export default function PipelineSubNav({ activeView, onViewChange, counts, isPoster }) {
  const tabs = [];

  if (!isPoster) {
    tabs.push({ id: 'campaigns', label: 'Planner', count: counts.planner });
  }
  tabs.push({ id: 'ready_to_post', label: 'Ready to Post', count: counts.ready });
  tabs.push({ id: 'status', label: 'Posted', count: counts.posted });

  return (
    <div className="flex items-end gap-0 border-b border-ed-line mb-6">
      {tabs.map((tab, i) => {
        const isActive = tab.id === 'status'
          ? activeView === 'status'
          : activeView === tab.id;
        const num = String(i + 1).padStart(2, '0');

        return (
          <div key={tab.id} className="flex items-center">
            {i > 0 && (
              <span className="text-ed-ink3 text-[11px] px-1 self-center pb-3">→</span>
            )}
            <button
              onClick={() => onViewChange(tab.id)}
              className={`flex items-center gap-[9px] px-5 pb-[13px] pt-[14px] text-[13.5px] border-b -mb-px transition-colors ${
                isActive
                  ? 'text-ed-ink border-ed-accent'
                  : 'text-ed-ink3 border-transparent hover:text-ed-ink'
              }`}
            >
              <span className={`font-mono-ed text-[10.5px] ${isActive ? 'text-ed-accent' : 'text-ed-ink3'}`}>
                {num}
              </span>
              {tab.label}
              <span className={`font-mono-ed text-[11px] px-[7px] py-[1px] rounded-full ${
                isActive
                  ? 'bg-ed-accent/10 text-ed-accent'
                  : 'bg-ed-bg text-ed-ink2'
              }`}>
                {tab.count ?? 0}
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
}

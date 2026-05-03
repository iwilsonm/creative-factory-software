import { fmt$, fmtRoas } from './chartUtils';

export default function AngleBreakdownBar({ rows }) {
  if (!rows || rows.length === 0) return null;
  const max = Math.max(...rows.map(r => r.spend));

  return (
    <div className="flex flex-col gap-3.5">
      {rows.map(r => {
        const pct = (r.spend / max) * 100;
        const roasColor = r.roas >= 2 ? 'text-ed-green' : r.roas > 0 ? 'text-ed-ink' : 'text-ed-rust';
        return (
          <div key={r.angle}>
            <div className="flex justify-between items-baseline mb-1.5">
              <span className="font-serif text-[14.5px] tracking-[-0.01em]">{r.angle}</span>
              <span className="font-mono-ed text-[11.5px] text-ed-ink2">
                {fmt$(r.spend)} <span className="text-ed-ink3 mx-2">·</span> <span className={roasColor}>{r.roas > 0 ? fmtRoas(r.roas) : '—'}</span>
              </span>
            </div>
            <div className="h-1.5 bg-ed-line/60 rounded-full overflow-hidden relative">
              <div
                className="h-full bg-ed-accent rounded-full"
                style={{ width: `${pct}%`, opacity: r.roas >= 2 ? 1 : r.roas > 0 ? 0.55 : 0.25 }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

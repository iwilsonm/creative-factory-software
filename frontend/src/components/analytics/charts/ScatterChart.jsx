import { useMemo } from 'react';
import { fmt$ } from './chartUtils';

export default function ScatterChart({ rows }) {
  const w = 420, h = 260, padL = 44, padR = 16, padT = 16, padB = 36;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;

  const { maxSpend, maxRoas } = useMemo(() => {
    if (!rows || rows.length === 0) return { maxSpend: 100, maxRoas: 4 };
    return {
      maxSpend: Math.max(...rows.map(r => r.spend)) * 1.1,
      maxRoas: Math.max(...rows.map(r => r.roas), 4),
    };
  }, [rows]);

  if (!rows || rows.length === 0) return null;

  const xAt = (s) => padL + (s / maxSpend) * innerW;
  const yAt = (r) => padT + innerH * (1 - r / maxRoas);

  const statusColor = (status) => {
    if (status === 'passed') return '#3a8c5e';
    if (status === 'failed') return '#b25340';
    if (status === 'observing') return '#a8543b';
    return '#9a9a8e';
  };

  return (
    <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} className="block">
      {[1, 2, 3, 4].filter(r => r <= maxRoas).map(r => (
        <g key={r}>
          <line x1={padL} x2={w - padR} y1={yAt(r)} y2={yAt(r)} stroke={r === 2 ? '#a8543b' : '#e6e1d4'} strokeWidth="1" strokeDasharray={r === 2 ? '4 3' : '0'} opacity={r === 2 ? 0.6 : 1} />
          <text x={padL - 10} y={yAt(r) + 4} fill="#8a8678" fontSize="10.5" fontFamily="JetBrains Mono,monospace" textAnchor="end">{r}.0x</text>
        </g>
      ))}

      {[0, 0.25, 0.5, 0.75, 1].map(t => (
        <text key={t} x={padL + t * innerW} y={h - 14} fill="#8a8678" fontSize="10.5" fontFamily="JetBrains Mono,monospace" textAnchor="middle">{fmt$(maxSpend * t)}</text>
      ))}

      <text x={w - padR - 4} y={yAt(2) - 6} fill="#a8543b" fontSize="9.5" fontFamily="JetBrains Mono,monospace" textAnchor="end" className="uppercase tracking-[0.08em]">Bench 2.0x</text>

      {rows.map((r, i) => {
        const radius = 5 + Math.min(r.ads || 3, 8);
        const color = statusColor(r.status);
        return (
          <circle key={i} cx={xAt(r.spend)} cy={yAt(r.roas || 0)} r={radius} fill={color} fillOpacity="0.18" stroke={color} strokeWidth="1.4" />
        );
      })}

      <text x={padL} y={padT - 4} fill="#8a8678" fontSize="10.5" fontFamily="JetBrains Mono,monospace" className="uppercase tracking-[0.08em]">ROAS</text>
      <text x={w - padR} y={h - 2} fill="#8a8678" fontSize="10.5" fontFamily="JetBrains Mono,monospace" textAnchor="end" className="uppercase tracking-[0.08em]">Spend</text>
    </svg>
  );
}

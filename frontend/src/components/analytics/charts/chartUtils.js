export function pathFor(values, w, h, padTop = 6, padBottom = 6) {
  if (!values || values.length === 0) return '';
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const stepX = w / (values.length - 1);
  return values.map((v, i) => {
    const x = i * stepX;
    const y = padTop + (h - padTop - padBottom) * (1 - (v - min) / range);
    return `${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${y.toFixed(2)}`;
  }).join(' ');
}

export function areaFor(values, w, h, padTop = 6, padBottom = 6) {
  const line = pathFor(values, w, h, padTop, padBottom);
  if (!line) return '';
  return `${line} L ${w} ${h} L 0 ${h} Z`;
}

export function fmt$(n) {
  if (n >= 1000) return '$' + (n / 1000).toFixed(1) + 'k';
  return '$' + n.toFixed(0);
}

export function fmtPct(n) { return n.toFixed(2) + '%'; }
export function fmtRoas(n) { return n.toFixed(2) + 'x'; }

export function fmtCompact(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return n.toLocaleString();
}

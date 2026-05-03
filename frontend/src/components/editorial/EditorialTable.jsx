import StatusPill from './StatusPill';

export default function EditorialTable({ columns, rows, onRowClick, emptyState }) {
  if (!rows?.length) {
    return emptyState || (
      <div className="py-16 text-center text-ed-ink3 text-[13px] border border-dashed border-ed-line rounded-xl">
        No data
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr>
            {columns.map(col => (
              <th
                key={col.key}
                className={`text-left font-geist text-[10.5px] font-medium uppercase tracking-[0.10em] text-ed-ink3 px-3 py-2.5 border-b border-ed-line ${
                  col.type === 'numeric' ? 'text-right' : ''
                }`}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr
              key={row.id || i}
              onClick={() => onRowClick?.(row)}
              className={`border-b border-ed-line transition-colors duration-100 ${
                onRowClick ? 'cursor-pointer hover:bg-ed-accent/[0.025]' : ''
              }`}
            >
              {columns.map(col => (
                <td key={col.key} className="px-3 py-[18px] align-middle">
                  <CellContent col={col} value={row[col.key]} row={row} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CellContent({ col, value, row }) {
  if (col.render) return col.render(value, row);

  switch (col.type) {
    case 'name':
      return (
        <div>
          <div className="font-serif text-[15.5px] tracking-[-0.01em] text-ed-ink">
            {value}
          </div>
          {col.subKey && row[col.subKey] && (
            <div className="text-[11.5px] text-ed-ink3 mt-0.5">{row[col.subKey]}</div>
          )}
        </div>
      );
    case 'numeric':
      return (
        <div className="text-right font-mono-ed text-[12.5px] text-ed-ink">
          {value}
        </div>
      );
    case 'pill':
      return <StatusPill status={value} />;
    default:
      return (
        <span className="font-geist text-[13.5px] text-ed-ink">{value}</span>
      );
  }
}

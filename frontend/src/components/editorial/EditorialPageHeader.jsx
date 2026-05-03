export default function EditorialPageHeader({ eyebrow, title, meta, children }) {
  return (
    <div className="px-[36px] pt-[28px] pb-[22px] bg-ed-surface border-b border-ed-line">
      {eyebrow && (
        <div className="ed-eyebrow mb-2">{eyebrow}</div>
      )}
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="ed-h1">{title}</h1>
        {children}
      </div>
      {meta && (
        <p className="font-geist text-[13.5px] text-ed-ink2 mt-1.5">{meta}</p>
      )}
    </div>
  );
}

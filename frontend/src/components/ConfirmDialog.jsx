export default function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'danger',
  onConfirm,
  onCancel,
  busy = false,
}) {
  if (!open) return null;

  const confirmClass = tone === 'danger'
    ? 'bg-red-500 hover:bg-red-600 text-white'
    : 'bg-navy hover:bg-navy-light text-white';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 fade-in">
      <div
        className="absolute inset-0 bg-black/45 backdrop-blur-sm"
        onClick={() => !busy && onCancel?.()}
      />
      <div className="relative card w-full max-w-md p-6">
        <h3 className="text-[16px] font-semibold text-textdark tracking-tight">{title}</h3>
        <p className="text-[13px] text-textmid mt-2">{message}</p>
        <div className="flex items-center justify-end gap-2 mt-6">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="btn-secondary text-[13px] disabled:opacity-50"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className={`px-4 py-2 rounded-xl text-[13px] font-semibold transition-colors disabled:opacity-50 ${confirmClass}`}
          >
            {busy ? 'Working...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

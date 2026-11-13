const actionCls =
  'cursor-pointer rounded-full px-3 py-1.5 text-sm font-medium text-primary hover:bg-surface-container-highest'

// A reply only this user sees, as a local row under the messages.
export function OnlyYouRow({
  text,
  kind = 'info',
  jump,
  onDismiss,
}: {
  text: string
  kind?: 'info' | 'error'
  jump?: { label: string; onJump: () => void }
  onDismiss?: () => void
}) {
  return (
    <div
      role="note"
      aria-label="Only you can see this"
      className="mx-4 my-1 rounded-xl border border-dashed border-outline-variant bg-surface-container-high px-3 py-2"
    >
      <div className="flex min-h-8 flex-wrap items-center gap-x-2">
        <span className="flex-1 text-xs font-medium whitespace-nowrap text-on-surface-variant">
          Only you can see this
        </span>
        <div className="flex items-center">
          {jump && (
            <button type="button" onClick={jump.onJump} className={actionCls}>
              {jump.label}
            </button>
          )}
          {onDismiss && (
            <button type="button" onClick={onDismiss} className={actionCls}>
              Dismiss
            </button>
          )}
        </div>
      </div>
      <p
        className={`text-sm break-words whitespace-pre-wrap ${kind === 'error' ? 'text-error' : 'text-on-surface'}`}
      >
        {text}
      </p>
    </div>
  )
}

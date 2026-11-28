import { Inset, Row, Surface } from '../layout'
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
    <Inset pad="lg" inset="sides">
      <Surface
        role="note"
        aria-label="Only you can see this"
        pad="md"
        inset="bar"
        tone="high"
        radius="lg"
        look="border border-dashed border-outline-variant"
      >
        <Row gap="sm" wrap look="min-h-8">
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
        </Row>
        <p
          className={`text-sm break-words whitespace-pre-wrap ${kind === 'error' ? 'text-error' : 'text-on-surface'}`}
        >
          {text}
        </p>
      </Surface>
    </Inset>
  )
}

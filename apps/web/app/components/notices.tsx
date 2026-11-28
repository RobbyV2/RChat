'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { CircleAlert, CloudOff, LogIn, RefreshCw } from 'lucide-react'
import { fieldLine, refusalOf, refusalView, type Refusal } from '../lib/api_errors'
import { retryIn, type Waiting } from '../lib/load'
import { time } from '../lib/platform/time'
import { Button } from './controls'
import { FirstLine, Row, Stack, Surface } from './layout'
import { FieldError } from './ui'

// Milliseconds on the app's clock, read again when `at` passes, and each second until then when
// `ticking`.
export function useElapsed(at: number | null, ticking = false) {
  const [now, setNow] = useState(() => time().elapsed())
  useEffect(() => {
    if (at === null) return
    const clock = time()
    const left = at - clock.elapsed()
    if (left <= 0) {
      setNow(clock.elapsed())
      return
    }
    return clock.after(ticking ? Math.min(1000, left) : left, () => setNow(clock.elapsed()))
  }, [at, ticking, now])
  return now
}

// A line in place of something that is not here, with a way to ask again. `wait` seconds count
// down on the button before it can be pressed.
export function Notice({
  line,
  tone = 'plain',
  icon = 'alert',
  retry,
  retryAt = null,
  children,
}: {
  line: ReactNode
  tone?: 'plain' | 'error'
  icon?: 'alert' | 'connection' | 'sign_in' | 'none'
  retry?: (() => void) | null
  // When asking again is allowed, on the app's clock.
  retryAt?: number | null
  children?: ReactNode
}) {
  const now = useElapsed(retry ? retryAt : null, true)
  const wait = retryIn(retryAt, now)
  const Icon = icon === 'connection' ? CloudOff : icon === 'sign_in' ? LogIn : CircleAlert
  return (
    <Surface
      data-notice={tone}
      role={tone === 'error' ? 'alert' : 'status'}
      pad="md"
      gap="sm"
      tone="plain"
      align="start"
      text="sm"
      ink={tone === 'error' ? 'error' : 'muted'}
    >
      <Row gap="sm" align="start">
        {icon !== 'none' && (
          <FirstLine>
            <Icon size={16} aria-hidden />
          </FirstLine>
        )}
        <p className="min-w-0 break-words">{line}</p>
      </Row>
      {children}
      {retry && (
        <Button variant="text" icon={RefreshCw} disabled={wait > 0} onClick={retry}>
          {wait > 0 ? `Try again in ${wait} s` : 'Try again'}
        </Button>
      )}
    </Surface>
  )
}

// A refused request, said where the person looks: what happened and what they can do. `lead`
// names what was being done ("Could not load pins.").
export function ErrorNotice({
  refusal,
  lead,
  retry,
  retryAt = null,
}: {
  refusal: Refusal
  lead?: string
  retry?: (() => void) | null
  retryAt?: number | null
}) {
  const view = refusalView(refusal)
  const line = lead ? `${lead} ${view.line}` : view.line
  return (
    <Notice
      line={line}
      tone="error"
      icon={
        view.where === 'connection' ? 'connection' : view.where === 'sign_in' ? 'sign_in' : 'alert'
      }
      retry={view.retry ? retry : null}
      retryAt={retryAt}
    />
  )
}

// The same for whatever a request threw.
export function FailureNotice({
  error,
  lead,
  retry,
}: {
  error: unknown
  lead?: string
  retry?: (() => void) | null
}) {
  return <ErrorNotice refusal={refusalOf(error)} lead={lead} retry={retry} />
}

// The line under a field the refusal is about.
export function FieldRefusal({
  refusal,
  field,
  id,
}: {
  refusal: Refusal | null
  field: string
  id?: string
}) {
  return <FieldError id={id} message={fieldLine(refusal, field)} />
}

// A control that is turned off, shown where the person looks for it, with the line that says
// why. The control inside cannot be used.
export function Unavailable({ line, children }: { line: string; children: ReactNode }) {
  return (
    <Stack gap="xs" data-unavailable>
      <div inert aria-disabled="true" className="opacity-50">
        {children}
      </div>
      <p className="text-xs text-on-surface-variant">{line}</p>
    </Stack>
  )
}

// A control under the refusal that turned it off; any other refusal leaves it as it is.
export function UnavailableFor({
  refusal,
  children,
}: {
  refusal: Refusal | null
  children: ReactNode
}) {
  const view = refusal ? refusalView(refusal) : null
  return view?.where === 'control' ? (
    <Unavailable line={view.line}>{children}</Unavailable>
  ) : (
    <>{children}</>
  )
}

const WAITING: Record<Waiting, string> = {
  offline: 'You are offline. This loads when you are back online.',
  reconnecting: 'Reconnecting. This loads once you are connected.',
  no_peer: 'Nobody who has this is online right now.',
}

// Something that waits on a connection: this device's, or a peer's.
export function ConnectionNotice({ why, retry }: { why: Waiting; retry?: (() => void) | null }) {
  return <Notice line={WAITING[why]} icon="connection" retry={retry} />
}

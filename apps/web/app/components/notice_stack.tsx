'use client'

import { useEffect, useRef, useState, type FocusEvent } from 'react'
import { User, X } from 'lucide-react'
import { useStore } from '../lib/store'
import {
  alertBody,
  context,
  headline,
  NOTICE_MS,
  timeLeft,
  type Notice,
  type Piece,
} from '../lib/notices'
import { UserAvatar } from './user_avatar'

function Pieces({ pieces }: { pieces: Piece[] }) {
  return pieces.map((p, i) =>
    p.blur ? (
      <span key={i} className="streamer">
        {p.text}
      </span>
    ) : (
      <span key={i}>{p.text}</span>
    )
  )
}

// Time left, from where the timer stood when this run of the toast began; pausing freezes it.
function TimeBar({ notice, paused }: { notice: Notice; paused: boolean }) {
  const [start] = useState(() => timeLeft(notice.timer, Date.now()))
  return (
    <div className="absolute inset-x-0 bottom-0 h-0.5 bg-on-surface/10">
      <div
        style={{
          animationDuration: `${start}ms`,
          animationPlayState: paused ? 'paused' : 'running',
          ['--notice-from' as string]: start / NOTICE_MS,
        }}
        className="h-full origin-left animate-notice-time bg-primary motion-reduce:animate-none"
      />
    </div>
  )
}

function NoticeCard({ notice, paused }: { notice: Notice; paused: boolean }) {
  const streamer = useStore(s => s.streamer)
  const dismiss = useStore(s => s.dismissNotice)
  const where = context(notice)
  const body = alertBody(notice.body, streamer)
  const { actor } = notice
  const card = useRef<HTMLDivElement>(null)
  // A removed element takes its focus with it, so focus moves to a neighbouring toast first.
  const close = () => {
    const el = card.current
    if (el?.contains(document.activeElement)) {
      const next = (el.nextElementSibling ?? el.previousElementSibling)?.querySelector('button')
      if (next) next.focus()
      else (document.activeElement as HTMLElement | null)?.blur()
    }
    dismiss(notice.id)
  }
  return (
    <div
      ref={card}
      onKeyDown={e => {
        if (e.key === 'Escape') close()
      }}
      className="group/notice relative overflow-hidden rounded-xl bg-surface-container-high shadow-elevation-2 hover:bg-surface-container-highest"
    >
      <button
        onClick={() => {
          if (card.current?.contains(document.activeElement))
            (document.activeElement as HTMLElement).blur()
          dismiss(notice.id)
          notice.go()
        }}
        className="flex w-full items-start gap-3 p-3 pr-9 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
      >
        {actor && !streamer ? (
          <UserAvatar
            username={actor.username}
            avatarKind={actor.avatar_kind}
            avatarColor={actor.avatar_color}
            size={36}
          />
        ) : (
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-surface-container-highest text-on-surface-variant">
            <User size={20} />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">
            <Pieces pieces={headline(notice)} />
          </span>
          {where.length > 0 && (
            <span className="block truncate text-xs text-on-surface-variant">
              <Pieces pieces={where} />
            </span>
          )}
          {body && <span className="mt-0.5 block truncate text-sm text-on-surface">{body}</span>}
        </span>
      </button>
      <button
        title="Dismiss"
        aria-label="Dismiss"
        onClick={close}
        className="absolute top-2 right-2 rounded-full p-1 text-on-surface-variant hover:bg-surface-container-highest hover:text-on-surface focus-visible:outline-2 focus-visible:outline-primary"
      >
        <X size={16} />
      </button>
      <TimeBar key={notice.gen} notice={notice} paused={paused} />
    </div>
  )
}

const matches = (el: Element | null, query: string) => {
  try {
    return el?.matches(query) ?? false
  } catch {
    return false
  }
}

// Keyboard focus inside the stack; a mouse click focuses a button too but should not pause.
const keyboardFocus = (region: HTMLElement | null) => {
  const el = document.activeElement
  return !!region && !!el && region.contains(el) && matches(el, ':focus-visible')
}

// The toast stack. Hovering it or moving keyboard focus into it pauses every toast's timer.
export function NoticeStack() {
  const notices = useStore(s => s.notices)
  const paused = useStore(s => s.noticesPaused)
  const pause = useStore(s => s.pauseNotices)
  const [hover, setHover] = useState(false)
  const [focus, setFocus] = useState(false)
  const empty = notices.length === 0
  const region = useRef<HTMLElement>(null)

  // Removing a toast fires no blur or mouseleave, and a toast appearing under a still pointer
  // fires no mouseenter, so both are read back from the DOM whenever the toasts change.
  useEffect(() => {
    const el = region.current
    setHover(notices.length > 0 && matches(el, ':hover'))
    setFocus(notices.length > 0 && keyboardFocus(el))
  }, [notices])

  useEffect(() => {
    pause(hover || focus)
  }, [hover, focus, pause])

  return (
    <section
      ref={region}
      aria-live="polite"
      aria-label="Notifications"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setFocus(keyboardFocus(region.current))}
      onBlur={(e: FocusEvent) => {
        if (!region.current?.contains(e.relatedTarget as Node | null)) setFocus(false)
      }}
      className={`flex w-full flex-col gap-2 sm:fixed sm:top-[calc(var(--safe-top)+4rem)] sm:right-[max(1rem,env(safe-area-inset-right))] sm:z-50 sm:w-80 sm:max-w-[calc(100vw-2rem)] ${empty ? '' : 'pointer-events-auto'}`}
    >
      {notices.map(n => (
        <NoticeCard key={n.id} notice={n} paused={paused} />
      ))}
    </section>
  )
}

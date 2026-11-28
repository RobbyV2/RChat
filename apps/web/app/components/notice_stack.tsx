'use client'

import { Covered } from './covered'
import { asAccount } from '../lib/people'
import { IconButton } from './controls'
import { useCallback, useEffect, useRef, useState, type FocusEvent } from 'react'
import { User, X } from 'lucide-react'
import { openAccountNotice } from '../lib/client/notice_owner'
import { client } from '../lib/client/client'
import { AccountProvider, useAccount } from '../lib/client/react'
import type { AccountSession } from '../lib/client/session'
import { useStore as useBoundStore } from 'zustand'
import { resolveNoticeActor } from '../lib/client/view_actor'
import { ActorLabel } from './view_actor'
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
import { Masked } from './ui'
import { time } from '../lib/platform/time'
import { Inset, Stack } from './layout'

function Pieces({ pieces }: { pieces: Piece[] }) {
  return pieces.map((p, i) => (
    <Covered key={i} what="names" on={!!p.blur}>
      <Masked text={p.text} />
    </Covered>
  ))
}

// Time left, from where the timer stood when this run of the toast began; pausing freezes it.
function TimeBar({ notice, paused }: { notice: Notice; paused: boolean }) {
  const [start] = useState(() => timeLeft(notice.timer, time().now()))
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
  const owner = useAccount()
  const streamer = useStore(s => s.streamer)
  const dismiss = useStore(s => s.dismissNotice)
  const book = useBoundStore(client.book, b => b)
  const recipient = resolveNoticeActor(book, owner, notice.key)
  const conversation = { ...notice, recipient: undefined }
  const where = context(recipient ? conversation : notice)
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
      <Inset
        onClick={() => {
          if (card.current?.contains(document.activeElement))
            (document.activeElement as HTMLElement).blur()
          dismiss(notice.id)
          openAccountNotice(owner, notice.go)
        }}
        as="button"
        row
        pad="md"
        gap="md"
        align="start"
        look="text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary"
        place="w-full"
      >
        {actor && !streamer ? (
          <UserAvatar person={asAccount(actor, 'notice')} size={36} />
        ) : (
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-surface-container-highest text-on-surface-variant">
            <User size={20} />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <ActorLabel actor={recipient} />
          <span className="block truncate text-sm font-medium">
            <Pieces pieces={headline(notice)} />
          </span>
          {where.length > 0 && (
            <span className="block truncate text-xs text-on-surface-variant">
              <Pieces pieces={where} />
            </span>
          )}
          {body && (
            <span className="block truncate text-sm text-on-surface">
              <Masked text={body} code file={notice.file} />
            </span>
          )}
        </span>
      </Inset>
      <IconButton
        icon={X}
        label="Dismiss"
        size="sm"
        onClick={close}
        place="absolute top-2 right-2"
      />
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

function AccountNotices({ onChange }: { onChange: () => void }) {
  const notices = useStore(s => s.notices)
  const paused = useStore(s => s.noticesPaused)
  useEffect(onChange, [notices, onChange])
  return notices.map(n => <NoticeCard key={n.id} notice={n} paused={paused} />)
}

export function NoticeStack({ sessions }: { sessions: readonly AccountSession[] }) {
  const [hover, setHover] = useState(false)
  const [focus, setFocus] = useState(false)
  const region = useRef<HTMLElement>(null)
  const onChange = useCallback(() => {
    const el = region.current
    setHover(!!el?.childElementCount && matches(el, ':hover'))
    setFocus(!!el?.childElementCount && keyboardFocus(el))
  }, [])
  useEffect(onChange, [sessions, onChange])
  useEffect(() => {
    for (const session of sessions) session.store.getState().pauseNotices(hover || focus)
  }, [sessions, hover, focus])
  useEffect(
    () => () => {
      for (const session of sessions) {
        if (client.live().includes(session)) session.store.getState().pauseNotices(false)
      }
    },
    [sessions]
  )

  return (
    <Stack
      ref={region}
      aria-live="polite"
      aria-label="Notifications"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setFocus(keyboardFocus(region.current))}
      onBlur={(e: FocusEvent) => {
        if (!region.current?.contains(e.relatedTarget as Node | null)) setFocus(false)
      }}
      as="section"
      gap="sm"
      look="pointer-events-auto empty:pointer-events-none sm:fixed sm:top-below-bar sm:right-safe-4 sm:z-top sm:w-80 sm:max-w-screen-inset"
      place="w-full"
    >
      {sessions.map(session => (
        <AccountProvider key={session.renderKey} session={session}>
          <AccountNotices onChange={onChange} />
        </AccountProvider>
      ))}
    </Stack>
  )
}

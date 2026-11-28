'use client'
import { p2pName, personCalled } from '../lib/names'
import { Name, useNameLabels } from './name'

import { memo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { look, plays } from '../lib/motion/play'
import { useStore } from '../lib/store'
import { rowTypers } from '../lib/typing_rows'
import { typingParts, typingTitle } from '../lib/typing'
import { useLooksFor } from './shown_user'
import { PingBadge } from './ping_badge'
import type { ComposerList } from '../lib/place/composer'
import { useLive } from '../lib/place/react'
import { useCompose } from '../lib/place/use_composer'
import { Inset, Row } from './layout'

const DOTS = [0, 1, 2]

// Three dots that bounce while animations play and stand still otherwise.
function Dots() {
  return (
    <Row as="span" gap="3xs" place="shrink-0" aria-hidden {...look('typing.channel')}>
      {DOTS.map(d => (
        <span key={d} className="size-1 rounded-full bg-current" />
      ))}
    </Row>
  )
}

// The dots of a channel or DM row while someone types there; their names are its label.
export const TypingEllipsis = memo(function TypingEllipsis({
  names,
  p2p = false,
}: {
  names: readonly string[]
  // The names are P2P contacts'.
  p2p?: boolean
}) {
  const say = useNameLabels()
  const title = typingTitle(
    names.map(n => say(p2p ? p2pName(n) : personCalled(n))),
    say.hiding
  )
  return (
    <span
      role="img"
      aria-label={title}
      title={title}
      data-typing-dots
      className="flex shrink-0 items-center"
    >
      <Dots />
    </span>
  )
})

// The right end of a channel row: typing dots in place of the unread dot (and before a ping
// count), else the ping count or the unread dot.
export function ChannelEnd({
  typers,
  pings,
  unread,
}: {
  typers: readonly string[]
  pings: number
  unread: boolean
}) {
  if (typers.length)
    return (
      <Row as="span" gap="xs" place="ml-auto shrink-0">
        <TypingEllipsis names={typers} />
        <PingBadge count={pings} />
      </Row>
    )
  if (pings > 0) return <PingBadge count={pings} className="ml-auto" />
  return unread ? (
    <span title="Unread" aria-hidden className="ml-auto h-2 w-2 shrink-0 rounded-full bg-error" />
  ) : null
}

// Who is typing in any of `scopes` of a hosted `server` (null for DMs), under the names the
// server shows (looking up the ones not loaded yet); nothing while typing indicators are off.
export function useHostedTypers(scopes: readonly string[], server: string | null) {
  const names = useStore(useShallow(s => rowTypers(s, scopes, server).names))
  const ask = useStore(useShallow(s => rowTypers(s, scopes, server).ask))
  useLooksFor(server, ask)
  return names
}

// Who is typing in `list` of the place around, in one thin line over the bottom edge of the
// message list, so it never moves the list. A typer whose look in the place's server is not
// loaded shows under the account name and is looked up once.
export function TypingLine({
  list = 'main',
  bg,
}: {
  list?: ComposerList
  bg: 'bg-surface' | 'bg-surface-container-low'
}) {
  const on = useStore(s => s.typingOn)
  const { names, ask, server } = useLive(useCompose(list).typers)
  useLooksFor(server, ask)
  const parts = on ? typingParts(names) : []
  if (!parts.length) return null
  return (
    <Inset
      ref={plays('typing')}
      data-typing
      row
      pad="lg"
      inset="sides"
      gap="xs"
      text="xs"
      ink="muted"
      look={`h-4 leading-4 ${bg}`}
      place="pointer-events-none absolute inset-x-0 bottom-full"
    >
      <Dots />
      <span aria-live="polite" className="min-w-0 truncate">
        {parts.map((p, i) =>
          p.name ? (
            <Name key={i} of={personCalled(p.text)} look="font-semibold text-on-surface" />
          ) : (
            <span key={i}>{p.text}</span>
          )
        )}
      </span>
    </Inset>
  )
}

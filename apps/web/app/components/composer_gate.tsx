'use client'

import Link from 'next/link'
import { Lock } from 'lucide-react'
import { NO_THREADS_TEXT } from '../lib/channel_perms'
import { accountPrompt } from '../lib/features'
import { movedText } from '../lib/p2p/dm'
import type { Compose, Gate } from '../lib/place/composer'
import { useLive } from '../lib/place/react'
import { time } from '../lib/platform/time'
import { useStore } from '../lib/store'
import { LinkButton } from './controls'
import { GateNote } from './gate_note'
import { Dock, Row, Surface } from './layout'
import { Name } from './name'
import { ElsewhereNotice, MovingBanner } from './p2p/p2p_home'
import { TimedOutBar, useNow } from './timeout_dialog'

export const NO_SEND = 'You do not have permission to send messages in this channel.'

// What holds a list's composer back now: the gate that stands whatever else holds, else the
// reader's timeout while it runs, else what stands without one. `shut`: something does.
export function useGate(compose: Compose) {
  const { first, until, then } = useLive(compose.gate)
  const now = useNow(until !== null && until > time().now())
  const ends = until !== null && until > now ? until : null
  const gate = first ?? (ends === null ? then : null)
  return {
    gate,
    ends: first === null ? ends : null,
    shut: gate !== null || ends !== null,
    // Whether the reader may act on what is written here at all (a timeout holds back less).
    acts: first === null && then === null,
  }
}

const GUEST_LINES = {
  off: 'Guest posting is off here.',
  checking: 'Checking guest access…',
  paused: 'Guest posting is paused by a moderator.',
  unavailable: 'Guest posting is unavailable here.',
}

function GuestNote({ posting }: { posting: keyof typeof GUEST_LINES }) {
  const logout = useStore(s => s.logout)
  const ask = useStore(s => accountPrompt(s.settings))
  return (
    <Dock>
      <Surface data-guest-notice pad="lg" tone="base" radius="xl">
        <p className="text-sm text-on-surface-variant">
          {GUEST_LINES[posting]}{' '}
          <Link href="/login" onClick={() => logout()} className="text-primary underline">
            {ask}
          </Link>{' '}
          to use account features.
        </p>
      </Surface>
    </Dock>
  )
}

const locked = (line: string) => (
  <GateNote data-no-send>
    <Row as="span" gap="sm">
      <Lock size={16} className="shrink-0" />
      <span>{line}</span>
    </Row>
  </GateNote>
)

function Bar({ gate, compose }: { gate: Gate; compose: Compose }) {
  switch (gate.kind) {
    case 'join':
    case 'guestWrite':
      return null
    case 'guest':
      return <GuestNote posting={gate.posting} />
    case 'noSend':
      return locked(NO_SEND)
    case 'noThreads':
      return locked(NO_THREADS_TEXT)
    case 'elsewhere':
      return (
        <GateNote>
          <ElsewhereNotice />
        </GateNote>
      )
    case 'moved':
      return <GateNote>{movedText(gate.at)}</GateNote>
    case 'moving':
      return <MovingBanner bar />
    case 'out':
      return (
        <GateNote data-p2p-out>
          {gate.waiting ? <span data-p2p-join-wait>{gate.line}</span> : gate.line}
          {gate.next !== null && (
            <LinkButton onClick={compose.openNext}>Open the new copy</LinkButton>
          )}
          {gate.forget && <LinkButton onClick={compose.forget}>Remove from this device</LinkButton>}
        </GateNote>
      )
    case 'full':
      return <GateNote role="status">{gate.line}</GateNote>
    case 'noContact':
      return <GateNote>This contact was removed.</GateNote>
    case 'blocked':
      return (
        <GateNote>
          You blocked <Name of={gate.name} look="font-medium" />. Remove the block to message them
          again.
        </GateNote>
      )
    case 'notMutual':
      return (
        <GateNote>
          <Name of={gate.name} look="font-medium" /> isn&apos;t a mutual contact right now.
        </GateNote>
      )
  }
}

// What stands in a composer's place while nothing can be written there, whichever place it is
// in; nothing while the composer is open. A server to join and a guest's own field are the
// composer's to draw.
export function ComposerGate({ compose }: { compose: Compose }) {
  const { gate, ends } = useGate(compose)
  if (gate !== null) return <Bar gate={gate} compose={compose} />
  return ends === null ? null : <TimedOutBar ends={ends} />
}

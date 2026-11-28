'use client'

import Link from 'next/link'
import { useRef, useState } from 'react'
import { Eye, Lock } from 'lucide-react'
import { NO_THREADS_TEXT } from '../lib/channel_perms'
import { accountPrompt } from '../lib/features'
import { runJoinStep, type JoinStep } from '../lib/join_flow'
import { serverCalled } from '../lib/names'
import { movedText } from '../lib/p2p/dm'
import type { Compose, ComposerList, Gate } from '../lib/place/composer'
import { useLive } from '../lib/place/react'
import { time } from '../lib/platform/time'
import { errorText, useStore } from '../lib/store'
import { Button, LinkButton } from './controls'
import { useFocusAsks } from './composer_field'
import { GateNote } from './gate_note'
import { Dock, Row, Surface } from './layout'
import { Name } from './name'
import { ElsewhereNotice, MovingBanner } from './p2p/p2p_home'
import { useAnswered } from './replies'
import { TextComposer } from './text_composer'
import { TimedOutBar, useNow } from './timeout_dialog'
import { FieldError, fieldCls } from './ui'

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
    // Whether the reader may act on what is written here at all (a timeout holds back less, and
    // so does a thread nobody may start).
    acts: first === null && (then === null || then.kind === 'noThreads'),
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

// A server you read without being a member: its name and the way in.
function JoinBar({ name, compose }: { name: string; compose: Compose }) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState<JoinStep>('name')
  const locked = step === 'password'
  const ready = !busy && (!locked || password.trim() !== '')

  const join = async () => {
    if (!ready) return
    setBusy(true)
    setError(null)
    const out = await runJoinStep(step, password, pw => compose.join(pw), errorText)
    if (out.done) return
    setStep(out.step)
    setError(out.error)
    setBusy(false)
  }

  return (
    <Dock>
      <Surface data-preview-bar pad="lg" tone="base" radius="xl" border="dashed">
        <Row
          as="form"
          onSubmit={e => {
            e.preventDefault()
            void join()
          }}
          gap="sm"
          wrap
        >
          <Row as="p" gap="sm" place="min-w-0 flex-1">
            <Eye size={16} className="shrink-0 text-primary" />
            <span className="min-w-48 text-sm text-on-surface-variant">
              You&apos;re previewing{' '}
              <Name of={serverCalled(name)} look="font-medium text-on-surface" />
            </span>
          </Row>
          {locked && (
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Server password"
              className={`${fieldCls} max-w-56`}
            />
          )}
          <Button type="submit" variant="filled" size="md" disabled={!ready}>
            Join server
          </Button>
        </Row>
        <FieldError message={error} />
      </Surface>
    </Dock>
  )
}

// A guest's own field: plain text, sent as the guest.
function GuestField({ compose, list }: { compose: Compose; list: ComposerList }) {
  const { key, replying } = useLive(compose.state)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  useFocusAsks(compose, inputRef)
  const answered = useAnswered(replying?.to ?? null)
  return (
    <Dock data-guest-editor gap="sm">
      <TextComposer
        key={key}
        inputRef={inputRef}
        label={list === 'thread' ? 'Reply in thread' : 'Message as a guest'}
        reply={answered ?? undefined}
        cancelReply={compose.cancelReply}
        send={compose.sendAsGuest}
      />
    </Dock>
  )
}

interface GateProps {
  compose: Compose
  list: ComposerList
}

function Bar({ gate, compose, list }: GateProps & { gate: Gate }) {
  switch (gate.kind) {
    case 'join':
      return <JoinBar key={gate.server} name={gate.name} compose={compose} />
    case 'guestWrite':
      return <GuestField compose={compose} list={list} />
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

// What stands in a composer's place while the composer itself cannot be used there, whichever
// place it is in; nothing while the composer is open.
export function ComposerGate({ compose, list }: GateProps) {
  const { gate, ends } = useGate(compose)
  if (gate !== null) return <Bar gate={gate} compose={compose} list={list} />
  return ends === null ? null : <TimedOutBar ends={ends} />
}

'use client'

import { useEffect, useState } from 'react'
import { Timer } from 'lucide-react'
import {
  TIMEOUT_PRESETS,
  TIMEOUT_REASON_MAX,
  TIMEOUT_UNITS,
  cleanReason,
  customSeconds,
} from '../lib/durations'
import { useStore } from '../lib/store'
import { moderationOf } from '../lib/place/moderation'
import { useWatch } from '../lib/place/react'
import type { ModerationTarget } from '../lib/store_types'
import {
  peerTimeout,
  remainingText,
  remainingWords,
  timedOutLine,
  type Timeout,
} from '../lib/timeouts'
import { UserAvatar } from './user_avatar'
import { Button, Chip, Pill } from './controls'
import { Dock, Row, Stack, Surface } from './layout'
import { Dialog, fieldCls } from './ui'
import { NameWithUsername } from './display_name'

// The current time, ticking every `ms` while `on`.
export function useNow(on: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
    if (!on) return
    const timer = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(timer)
  }, [on, ms])
  return now
}

// The running timeout of a member as moderators see it, ticking so it clears when it ends.
export function useMemberTimeout(server: string | null, username: string): Timeout | null {
  const stored = useStore(s => (server ? s.timeouts[server]?.[username] : undefined))
  const now = useNow(stored !== undefined)
  return stored && stored.ends > now ? stored : null
}

// When your own timeout in `server` ends (ms), ticking so it clears on time.
export function useMyTimeoutEnds(server: string | null | undefined): number | null {
  const until = useStore(s =>
    server ? s.me?.servers.find(x => x.name === server)?.timed_out_until : undefined
  )
  const ends = until === undefined ? null : until * 1000
  const now = useNow(ends !== null && ends > Date.now())
  return ends !== null && ends > now ? ends : null
}

export const timeoutTitle = (t: Timeout, now: number) =>
  `Timed out, ${remainingWords(t.ends - now)}${t.reason ? `. Reason: ${t.reason}` : ''}`

// Timer icon with the time left, for moderators in the member list and profile card.
export function TimeoutBadge({ t, compact = false }: { t: Timeout; compact?: boolean }) {
  const now = useNow(true)
  const title = timeoutTitle(t, now)
  return (
    <Pill tone="error" title={title} aria-label={title} role="img">
      <Timer size={compact ? 11 : 12} aria-hidden />
      <span className="tabular-nums">{remainingText(t.ends - now)}</span>
    </Pill>
  )
}

// When your own timeout in a P2P room ends (ms), ticking so it clears on time.
export function usePeerTimeoutEnds(until: number | undefined): number | null {
  const now = useNow(until !== undefined && until > Date.now())
  return until !== undefined && until > now ? until : null
}

// The timer badge of a P2P member whose timeout runs.
export function PeerTimeoutBadge({
  m,
  compact = false,
}: {
  m: { timeoutUntil?: number; timeoutReason?: string }
  compact?: boolean
}) {
  const now = useNow(m.timeoutUntil !== undefined && m.timeoutUntil > Date.now())
  const t = peerTimeout(m, now)
  return t ? <TimeoutBadge t={t} compact={compact} /> : null
}

// In place of the composer while you are timed out.
export function TimedOutBar({ ends }: { ends: number }) {
  const now = useNow(true)
  return (
    <Dock>
      <Surface data-timed-out role="status" row pad="lg" gap="sm" tone="error" radius="xl">
        <Timer size={16} className="shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 text-sm">{timedOutLine(ends, now)}</span>
        <span title="Time left" className="shrink-0 text-sm font-medium tabular-nums">
          {remainingText(ends - now)}
        </span>
      </Surface>
    </Dock>
  )
}

// Shows the timeout dialog for the member of a hosted server or a P2P room.
export default function TimeoutDialogHost() {
  const dialog = useStore(s => s.activeDialog)
  const close = useStore(s => s.closeDialog)
  return dialog?.kind === 'timeout' ? (
    <TimeoutDialog
      key={`${dialog.place.id}\n${dialog.who}`}
      place={dialog.place}
      who={dialog.who}
      known={dialog.known}
      onClose={close}
    />
  ) : null
}

// The timeout dialog of hosted servers and P2P rooms: how long and why, and the timeout that
// runs with its reason. The place sets and removes it on its side.
export function TimeoutDialog({
  place,
  who,
  known,
  onClose,
}: ModerationTarget & { onClose: () => void }) {
  const { member, timeout, untimeout } = moderationOf(place)
  const { name, user, timeout: set } = useWatch(() => member(who, known), [member, who, known])
  const now = useNow(set !== null)
  const current = set && set.ends > now ? set : null
  const [preset, setPreset] = useState<number | null>(600)
  const [amount, setAmount] = useState('')
  const [mult, setMult] = useState(60)
  const [reason, setReason] = useState(() =>
    set && set.ends > Date.now() ? (set.reason ?? '') : ''
  )
  const [busy, setBusy] = useState(false)
  const custom = preset === null ? customSeconds(amount, mult) : null
  const seconds = preset ?? custom
  const submit = async () => {
    if (seconds === null || busy) return
    setBusy(true)
    const ok = await timeout(who, { seconds, reason: cleanReason(reason) })
    setBusy(false)
    if (ok) onClose()
  }
  return (
    <Dialog title={current ? 'Change timeout' : 'Time out member'} onClose={onClose}>
      <Stack gap="lg">
        <Stack gap="md">
          <Row gap="md">
            {user && (
              <UserAvatar
                username={user.username}
                avatarKind={user.avatar_kind}
                avatarColor={user.avatar_color}
                size={36}
              />
            )}
            <Stack gap="none" place="min-w-0">
              <p className="streamer truncate text-sm font-medium text-on-surface">
                {user ? <NameWithUsername user={user} /> : name}
              </p>
              {user && (
                <p className="streamer truncate text-xs text-on-surface-variant">
                  @{user.username}
                </p>
              )}
            </Stack>
          </Row>
          <p className="text-sm text-on-surface-variant">
            They can still read, but can&apos;t send messages, react, or talk in voice until it
            ends.
          </p>
          {current && (
            <Surface data-timeout-current row pad="md" gap="sm" tone="error" radius="lg">
              <Timer size={16} className="shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 text-sm">
                <span className="tabular-nums">{remainingText(current.ends - now)}</span> left
                {current.reason && (
                  <span className="block text-xs break-words">Reason: {current.reason}</span>
                )}
              </span>
              <Button
                variant="danger"
                onClick={() => {
                  untimeout(who)
                  onClose()
                }}
              >
                Remove timeout
              </Button>
            </Surface>
          )}
        </Stack>
        <Stack gap="sm">
          <p className="text-xs font-medium tracking-wide text-on-surface-variant uppercase">
            Duration
          </p>
          <Row role="radiogroup" aria-label="Duration" gap="sm" wrap>
            {TIMEOUT_PRESETS.map(p => (
              <Chip
                key={p.seconds}
                radio
                on={preset === p.seconds}
                onClick={() => setPreset(p.seconds)}
              >
                {p.label}
              </Chip>
            ))}
            <Chip radio on={preset === null} onClick={() => setPreset(null)}>
              Custom
            </Chip>
          </Row>
        </Stack>
        {preset === null && (
          <Stack gap="xs">
            <Row gap="sm">
              <input
                type="number"
                min={1}
                autoFocus
                value={amount}
                onChange={e => setAmount(e.target.value)}
                aria-label="Custom duration"
                placeholder="Amount"
                className={`${fieldCls} w-24`}
              />
              <select
                value={mult}
                onChange={e => setMult(Number(e.target.value))}
                aria-label="Unit"
                className={`${fieldCls} flex-none`}
              >
                {TIMEOUT_UNITS.map(u => (
                  <option key={u.mult} value={u.mult}>
                    {u.label}
                  </option>
                ))}
              </select>
            </Row>
            {amount.trim() !== '' && custom === null && (
              <p role="alert" className="text-xs text-error">
                Pick a time up to 28 days.
              </p>
            )}
          </Stack>
        )}
        <Stack as="label" gap="xs">
          <span className="text-xs font-medium tracking-wide text-on-surface-variant uppercase">
            Reason
          </span>
          <input
            value={reason}
            maxLength={TIMEOUT_REASON_MAX}
            onChange={e => setReason(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') void submit()
            }}
            placeholder="Optional, shown to moderators"
            className={`${fieldCls} w-full text-on-surface`}
          />
        </Stack>
        <Row gap="sm" justify="end">
          <Button size="md" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="filled-danger"
            size="md"
            disabled={seconds === null || busy}
            onClick={() => void submit()}
          >
            {current ? 'Update timeout' : 'Time out'}
          </Button>
        </Row>
      </Stack>
    </Dialog>
  )
}

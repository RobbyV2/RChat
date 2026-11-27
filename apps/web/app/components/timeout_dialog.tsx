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
import type { TimeoutRequest } from '../lib/store_types'
import {
  peerTimeout,
  remainingText,
  remainingWords,
  timedOutLine,
  type Timeout,
} from '../lib/timeouts'
import type { UserRef } from '../lib/types'
import { UserAvatar } from './user_avatar'
import { Button, Chip } from './controls'
import { Dialog, fieldCls } from './ui'
import { NameWithUsername } from './display_name'
import { useShown } from './shown_user'

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
    <span
      title={title}
      aria-label={title}
      role="img"
      className="flex shrink-0 items-center gap-0.5 rounded-md bg-error-container px-1.5 py-0.5 text-3xs font-medium text-on-error-container tabular-nums"
    >
      <Timer size={compact ? 11 : 12} aria-hidden />
      {remainingText(t.ends - now)}
    </span>
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
    <div
      data-timed-out
      role="status"
      className="mx-3 mb-[max(0.75rem,env(safe-area-inset-bottom))] flex shrink-0 items-center gap-2 rounded-2xl bg-error-container px-4 py-3 text-sm text-on-error-container keyboard:mb-3"
    >
      <Timer size={16} className="shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">{timedOutLine(ends, now)}</span>
      <span title="Time left" className="shrink-0 font-medium tabular-nums">
        {remainingText(ends - now)}
      </span>
    </div>
  )
}

// The hosted adapter: a timeout of an account in a server through the instance.
export const hostedTimeoutRequest = (
  server: string,
  user: UserRef,
  current: Timeout | null,
  set: (server: string, username: string, seconds: number, reason: string) => Promise<boolean>,
  remove: (server: string, username: string) => Promise<void>
): TimeoutRequest => ({
  name: user.display_name,
  user,
  current,
  run: choice => set(server, user.username, choice.seconds, choice.reason ?? ''),
  remove: () => void remove(server, user.username),
})

function HostedTimeoutDialog({ server, user: account }: { server: string; user: UserRef }) {
  const user = useShown(account, server)
  const close = useStore(s => s.closeDialog)
  const timeoutMember = useStore(s => s.timeoutMember)
  const removeTimeout = useStore(s => s.removeTimeout)
  const current = useMemberTimeout(server, user.username)
  return (
    <TimeoutDialog
      request={hostedTimeoutRequest(server, user, current, timeoutMember, removeTimeout)}
      onClose={close}
    />
  )
}

// Shows the timeout dialog of either side: a hosted timeout by server and account, a P2P
// timeout by the request its room built.
export default function TimeoutDialogHost() {
  const dialog = useStore(s => s.activeDialog)
  const close = useStore(s => s.closeDialog)
  if (dialog?.kind === 'timeout')
    return (
      <HostedTimeoutDialog
        key={`${dialog.server}\n${dialog.user.username}`}
        server={dialog.server}
        user={dialog.user}
      />
    )
  return dialog?.kind === 'timeout_request' ? (
    <TimeoutDialog request={dialog.request} onClose={close} />
  ) : null
}

// The timeout dialog of hosted servers and P2P rooms: how long and why, and the timeout that
// runs with its reason. The request sets and removes it on its side.
export function TimeoutDialog({
  request,
  onClose,
}: {
  request: TimeoutRequest
  onClose: () => void
}) {
  const { name, user, run, remove } = request
  const now = useNow(request.current !== null)
  const current = request.current && request.current.ends > now ? request.current : null
  const [preset, setPreset] = useState<number | null>(600)
  const [amount, setAmount] = useState('')
  const [mult, setMult] = useState(60)
  const [reason, setReason] = useState(() => request.current?.reason ?? '')
  const [busy, setBusy] = useState(false)
  const custom = preset === null ? customSeconds(amount, mult) : null
  const seconds = preset ?? custom
  const submit = async () => {
    if (seconds === null || busy) return
    setBusy(true)
    const ok = await run({ seconds, reason: cleanReason(reason) })
    setBusy(false)
    if (ok) onClose()
  }
  return (
    <Dialog title={current ? 'Change timeout' : 'Time out member'} onClose={onClose}>
      <div className="flex items-center gap-3">
        {user && (
          <UserAvatar
            username={user.username}
            avatarKind={user.avatar_kind}
            avatarColor={user.avatar_color}
            size={36}
          />
        )}
        <div className="min-w-0">
          <p className="streamer truncate text-sm font-medium text-on-surface">
            {user ? <NameWithUsername user={user} /> : name}
          </p>
          {user && (
            <p className="streamer truncate text-xs text-on-surface-variant">@{user.username}</p>
          )}
        </div>
      </div>
      <p className="mt-3 text-sm text-on-surface-variant">
        They can still read, but can&apos;t send messages, react, or talk in voice until it ends.
      </p>
      {current && (
        <div
          data-timeout-current
          className="mt-3 flex items-center gap-2 rounded-xl bg-error-container px-3 py-2 text-sm text-on-error-container"
        >
          <Timer size={16} className="shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="tabular-nums">{remainingText(current.ends - now)}</span> left
            {current.reason && (
              <span className="block text-xs break-words">Reason: {current.reason}</span>
            )}
          </span>
          <Button
            variant="danger"
            onClick={() => {
              remove()
              onClose()
            }}
          >
            Remove timeout
          </Button>
        </div>
      )}
      <p className="mt-4 text-xs font-medium tracking-wide text-on-surface-variant uppercase">
        Duration
      </p>
      <div role="radiogroup" aria-label="Duration" className="mt-2 flex flex-wrap gap-2">
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
      </div>
      {preset === null && (
        <div className="mt-3 flex items-center gap-2">
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
        </div>
      )}
      {preset === null && amount.trim() !== '' && custom === null && (
        <p role="alert" className="pt-1.5 text-xs text-error">
          Pick a time up to 28 days.
        </p>
      )}
      <label className="mt-4 block text-xs font-medium tracking-wide text-on-surface-variant uppercase">
        Reason
        <input
          value={reason}
          maxLength={TIMEOUT_REASON_MAX}
          onChange={e => setReason(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') void submit()
          }}
          placeholder="Optional, shown to moderators"
          className={`${fieldCls} mt-1.5 w-full text-on-surface normal-case tracking-normal`}
        />
      </label>
      <div className="mt-5 flex justify-end gap-2">
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
      </div>
    </Dialog>
  )
}

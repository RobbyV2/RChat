'use client'

import { useEffect, useState } from 'react'
import { Timer } from 'lucide-react'
import { useStore } from '../lib/store'
import {
  REASON_MAX,
  TIMEOUT_PRESETS,
  TIMEOUT_UNITS,
  customSeconds,
  remainingText,
  remainingWords,
  type Timeout,
} from '../lib/timeouts'
import type { UserRef } from '../lib/types'
import { UserAvatar } from './user_avatar'
import { Dialog, dangerBtn, fieldCls, filledDangerBtn, textBtn } from './ui'

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
      className="flex shrink-0 items-center gap-0.5 rounded-md bg-error-container px-1.5 py-0.5 text-[10px] font-medium text-on-error-container tabular-nums"
    >
      <Timer size={compact ? 11 : 12} aria-hidden />
      {remainingText(t.ends - now)}
    </span>
  )
}

export default function TimeoutDialogHost() {
  const dialog = useStore(s => s.activeDialog)
  return dialog?.kind === 'timeout' ? (
    <TimeoutDialog
      key={`${dialog.server}\n${dialog.user.username}`}
      server={dialog.server}
      user={dialog.user}
    />
  ) : null
}

const chip = (on: boolean) =>
  `rounded-full border px-3 py-1.5 text-sm ${
    on
      ? 'border-primary bg-primary-container text-on-primary-container'
      : 'border-outline text-on-surface hover:bg-surface-container-highest'
  }`

function TimeoutDialog({ server, user }: { server: string; user: UserRef }) {
  const close = useStore(s => s.closeDialog)
  const timeoutMember = useStore(s => s.timeoutMember)
  const removeTimeout = useStore(s => s.removeTimeout)
  const current = useMemberTimeout(server, user.username)
  const now = useNow(current !== null)
  const [preset, setPreset] = useState<number | null>(600)
  const [amount, setAmount] = useState('')
  const [mult, setMult] = useState(60)
  const [reason, setReason] = useState(() => current?.reason ?? '')
  const [busy, setBusy] = useState(false)
  const custom = preset === null ? customSeconds(amount, mult) : null
  const seconds = preset ?? custom
  const submit = async () => {
    if (seconds === null || busy) return
    setBusy(true)
    const ok = await timeoutMember(server, user.username, seconds, reason)
    setBusy(false)
    if (ok) close()
  }
  return (
    <Dialog title={current ? 'Change timeout' : 'Time out member'} onClose={close}>
      <div className="flex items-center gap-3">
        <UserAvatar
          username={user.username}
          avatarKind={user.avatar_kind}
          avatarColor={user.avatar_color}
          size={36}
        />
        <div className="min-w-0">
          <p className="streamer truncate text-sm font-medium text-on-surface">
            {user.display_name}
          </p>
          <p className="streamer truncate text-xs text-on-surface-variant">@{user.username}</p>
        </div>
      </div>
      <p className="mt-3 text-sm text-on-surface-variant">
        They can still read, but can&apos;t send messages, react, or talk in voice until it ends.
      </p>
      {current && (
        <div className="mt-3 flex items-center gap-2 rounded-xl bg-error-container px-3 py-2 text-sm text-on-error-container">
          <Timer size={16} className="shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="tabular-nums">{remainingText(current.ends - now)}</span> left
            {current.reason && <span className="block truncate text-xs">{current.reason}</span>}
          </span>
          <button
            onClick={() => {
              void removeTimeout(server, user.username)
              close()
            }}
            className={dangerBtn}
          >
            Remove timeout
          </button>
        </div>
      )}
      <p className="mt-4 text-xs font-medium tracking-wide text-on-surface-variant uppercase">
        Duration
      </p>
      <div role="radiogroup" aria-label="Duration" className="mt-2 flex flex-wrap gap-2">
        {TIMEOUT_PRESETS.map(p => (
          <button
            key={p.seconds}
            role="radio"
            aria-checked={preset === p.seconds}
            onClick={() => setPreset(p.seconds)}
            className={chip(preset === p.seconds)}
          >
            {p.label}
          </button>
        ))}
        <button
          role="radio"
          aria-checked={preset === null}
          onClick={() => setPreset(null)}
          className={chip(preset === null)}
        >
          Custom
        </button>
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
          maxLength={REASON_MAX}
          onChange={e => setReason(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') void submit()
          }}
          placeholder="Optional, shown to moderators"
          className={`${fieldCls} mt-1.5 w-full text-on-surface normal-case tracking-normal`}
        />
      </label>
      <div className="mt-5 flex justify-end gap-2">
        <button onClick={close} className={textBtn}>
          Cancel
        </button>
        <button
          disabled={seconds === null || busy}
          onClick={() => void submit()}
          className={`${filledDangerBtn} disabled:opacity-40`}
        >
          {current ? 'Update timeout' : 'Time out'}
        </button>
      </div>
    </Dialog>
  )
}

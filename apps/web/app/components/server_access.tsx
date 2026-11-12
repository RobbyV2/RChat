'use client'

import { useCallback, useEffect, useId, useState, type ReactNode } from 'react'
import { Check, Copy, Lock, LockOpen, Plus } from 'lucide-react'
import { api, home, writeLocal } from '../lib/instances'
import { errorText, useStore } from '../lib/store'
import { inviteUrl } from '../lib/invite'
import { passwordDone, passwordPrompt } from '../lib/rules'
import { goingPublic, joinableByName, protectedDetail, publicDetail } from '../lib/joining'
import {
  ACTIVE_MAX,
  EXPIRY_PRESETS,
  STATUS_LABEL,
  USE_PRESETS,
  absoluteTime,
  countdown,
  customExpiry,
  isClosed,
  keepSecrets,
  parseSecrets,
  parseUses,
  secretFor,
  secretsKey,
  statusAt,
  tickMs,
  toLocalInput,
  useNow,
  usesText,
  withSecret,
  EXPIRY_MAX,
  type SecretBook,
  SHORT_PASSWORD,
  tooShort,
} from '../lib/passwords'
import type {
  CreatedPassword,
  NewPassword,
  PasswordStatus,
  ServerPassword,
  ServerPasswords,
} from '../lib/types'
import { WITH_OPTION, keepGuestsChoices } from './server_settings'
import {
  Dialog,
  FieldError,
  dangerBtn,
  fieldCls,
  filledBtn,
  sectionCls,
  textBtn,
  useCopied,
} from './ui'

const UNTITLED = 'Untitled password'

export const passwordName = (label: string | null) => label ?? UNTITLED

const nowSeconds = () => Math.floor(Date.now() / 1000)

const bookKey = (username: string) => home.scoped(secretsKey(username))

const readBook = (username: string) => {
  try {
    return parseSecrets(localStorage.getItem(bookKey(username)))
  } catch {
    return parseSecrets(null)
  }
}

const saveBook = (username: string, book: SecretBook) =>
  writeLocal(bookKey(username), Object.keys(book.servers).length ? JSON.stringify(book) : null)

const CHIP: Record<PasswordStatus, string> = {
  live: 'bg-primary-container text-on-primary-container',
  expired: 'bg-surface-container-highest text-on-surface-variant',
  used_up: 'bg-surface-container-highest text-on-surface-variant',
  revoked: 'bg-error-container text-on-error-container',
}

function Chip({ status }: { status: PasswordStatus }) {
  return (
    <span
      className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] leading-4 font-medium ${CHIP[status]}`}
    >
      {STATUS_LABEL[status]}
    </span>
  )
}

function CopyButton({
  text,
  label,
  disabled,
  why,
}: {
  text: string | null
  label: string
  disabled?: boolean
  why?: string
}) {
  const [copied, flashCopied] = useCopied()
  const off = disabled || text === null
  return (
    <span title={off ? why : copied ? 'Copied' : label}>
      <button
        type="button"
        aria-label={label}
        disabled={off}
        onClick={() => {
          if (text) void navigator.clipboard.writeText(text).then(flashCopied)
        }}
        className="rounded-full p-1.5 text-on-surface-variant hover:bg-surface-container-highest disabled:pointer-events-none disabled:opacity-40"
      >
        {copied ? <Check size={16} /> : <Copy size={16} />}
      </button>
    </span>
  )
}

function PasswordRow({
  server,
  password,
  now,
  secret,
  onRevoke,
}: {
  server: string
  password: ServerPassword
  now: number
  secret: string | null
  onRevoke: () => void
}) {
  const status = statusAt(password, now)
  const live = status === 'live'
  const { label, expires_at, max_uses, uses, created_by } = password
  return (
    <div className="rounded-xl px-2 py-1.5 hover:bg-surface-container-highest/50">
      <div className="flex min-w-0 items-center gap-2">
        <span
          className={`min-w-0 flex-1 truncate text-sm ${label ? 'text-on-surface' : 'text-on-surface-variant italic'}`}
        >
          {passwordName(label)}
        </span>
        <Chip status={status} />
        {live && (
          <CopyButton
            text={secret ? inviteUrl(server, secret) : null}
            label="Copy invite link"
            why="The password is only kept on the device that created it"
          />
        )}
        {(live || status === 'used_up') && (
          <button type="button" onClick={onRevoke} className={dangerBtn}>
            Revoke
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 pt-0.5 text-xs text-on-surface-variant">
        <span title={max_uses === null ? 'Unlimited uses' : `${max_uses - uses} left`}>
          {usesText(uses, max_uses)}
        </span>
        {expires_at === null ? (
          live && <span>No expiry</span>
        ) : live ? (
          <span title={absoluteTime(expires_at)}>{countdown(expires_at, now)}</span>
        ) : (
          status === 'expired' && <span>Expired {absoluteTime(expires_at)}</span>
        )}
        {created_by && (
          <span>
            by <span className="streamer">{created_by}</span>
          </span>
        )}
      </div>
    </div>
  )
}

function Radio({
  name,
  checked,
  onChange,
  title,
  detail,
  icon,
}: {
  name: string
  checked: boolean
  onChange: () => void
  title: string
  detail: string
  icon: ReactNode
}) {
  return (
    <label
      className={`flex min-w-0 flex-1 cursor-pointer gap-3 rounded-xl border px-3 py-2.5 ${
        checked
          ? 'border-primary bg-surface-container-highest'
          : 'border-outline-variant hover:bg-surface-container-highest'
      }`}
    >
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onChange}
        className="mt-0.5 shrink-0 accent-primary"
      />
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 text-sm font-medium text-on-surface">
          {icon}
          {title}
        </span>
        <span className="block pt-0.5 text-xs text-on-surface-variant">{detail}</span>
      </span>
    </label>
  )
}

function PermanentPassword({
  server,
  has,
  canRemove,
  refresh,
}: {
  server: string
  has: boolean
  canRemove: boolean
  refresh: () => void
}) {
  const askConfirm = useStore(s => s.askConfirm)
  const siteAdmin = useStore(s => s.me?.is_site_admin ?? false)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  return (
    <>
      <p className="pt-3 pb-1.5 text-sm font-medium text-on-surface">Permanent password</p>
      <form
        onSubmit={e => {
          e.preventDefault()
          const next = password.trim()
          setError(null)
          setDone(null)
          if (tooShort(next)) return setError(SHORT_PASSWORD)
          const prompt = passwordPrompt(has, next, canRemove, siteAdmin, true)
          const changed = has && next !== ''
          askConfirm({
            ...prompt,
            choices: keepGuestsChoices(prompt.choices, changed),
            action: choice => {
              const members = choice.startsWith('remove') ? 'remove' : 'keep'
              const keepGuests = choice === `keep${WITH_OPTION}`
              api
                .updateServer(server, {
                  password: next,
                  protected: true,
                  members,
                  keep_guests: keepGuests,
                })
                .then(
                  res => {
                    setPassword('')
                    const guests =
                      changed && members === 'keep'
                        ? keepGuests
                          ? ' Guests kept access.'
                          : ' Guests lost access.'
                        : ''
                    setDone(passwordDone(prompt.confirm, members, res.removed, res.kept) + guests)
                    refresh()
                  },
                  (err: unknown) => setError(errorText(err))
                )
            },
          })
        }}
        className="flex gap-2"
      >
        <input
          type="password"
          value={password}
          onChange={e => {
            setPassword(e.target.value)
            setDone(null)
          }}
          autoComplete="new-password"
          aria-label="Permanent password"
          placeholder={has ? 'New password (blank removes it)' : 'Set a permanent password'}
          className={fieldCls}
        />
        <button disabled={!password.trim() && !has} className={filledBtn}>
          {password.trim() ? (has ? 'Change' : 'Set') : has ? 'Remove' : 'Set'}
        </button>
      </form>
      <FieldError message={error} />
      {done && (
        <p role="status" className="pt-1.5 text-xs text-on-surface">
          {done}
        </p>
      )}
      <p className="pt-1.5 text-xs text-on-surface-variant">
        {has
          ? 'Works until you change or remove it.'
          : 'No permanent password. Only the passwords below let new people in.'}
      </p>
    </>
  )
}

type ExpiryChoice = 'never' | 'custom' | `${number}`
type UsesChoice = 'unlimited' | 'custom' | `${number}`

function NewPasswordDialog({
  server,
  onClose,
  onCreated,
}: {
  server: string
  onClose: () => void
  onCreated: (created: CreatedPassword) => void
}) {
  const ids = useId()
  const streamer = useStore(s => s.streamer)
  const [label, setLabel] = useState('')
  const [custom, setCustom] = useState(false)
  const [secret, setSecret] = useState('')
  const [expiry, setExpiry] = useState<ExpiryChoice>(`${86400}`)
  const [expiryAt, setExpiryAt] = useState(() => toLocalInput(Date.now() + 86400 * 1000))
  const [uses, setUses] = useState<UsesChoice>('unlimited')
  const [usesRaw, setUsesRaw] = useState('3')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<CreatedPassword | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return
      e.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onClose])

  const submit = () => {
    setError(null)
    const body: NewPassword = {}
    if (label.trim()) body.label = label.trim()
    if (custom) {
      if (!secret.trim()) return setError('Type a password or pick Generate')
      if (tooShort(secret)) return setError(SHORT_PASSWORD)
      body.password = secret.trim()
    }
    if (expiry === 'custom') {
      const picked = customExpiry(expiryAt, Date.now())
      if (picked.error !== null) return setError(picked.error)
      body.expires_at = picked.at
    } else if (expiry !== 'never') body.expires_in = Number(expiry)
    if (uses === 'custom') {
      const n = parseUses(usesRaw)
      if (n === null) return setError('Uses must be a whole number from 1 to 10000')
      body.max_uses = n
    } else if (uses !== 'unlimited') body.max_uses = Number(uses)
    setBusy(true)
    api.createPassword(server, body).then(
      res => {
        setBusy(false)
        setCreated(res)
        onCreated(res)
      },
      (err: unknown) => {
        setBusy(false)
        setError(errorText(err))
      }
    )
  }

  const selectCls = `${fieldCls} w-full bg-surface-container-high`
  const nowMs = Date.now()

  return (
    <Dialog title={created ? 'Password Created' : 'New Password'} onClose={onClose} layer="confirm">
      {created ? (
        <div>
          <p className="text-sm text-on-surface-variant">
            Copy it now. It is not shown again, but this device remembers it for the invite link.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <input
              readOnly
              value={created.password}
              aria-label="New password"
              onFocus={e => e.currentTarget.select()}
              className={`${fieldCls} streamer font-mono`}
            />
            <CopyButton text={created.password} label="Copy password" />
            <CopyButton text={inviteUrl(server, created.password)} label="Copy invite link" />
          </div>
          <div className="mt-6 flex justify-end">
            <button autoFocus onClick={onClose} className={filledBtn}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <form
          onSubmit={e => {
            e.preventDefault()
            submit()
          }}
          className="space-y-4"
        >
          <label className="block">
            <span className="block pb-1 text-xs text-on-surface-variant">Label</span>
            <input
              value={label}
              onChange={e => setLabel(e.target.value)}
              maxLength={100}
              placeholder="For example: Friends from school"
              className={`${fieldCls} w-full`}
            />
          </label>
          <fieldset>
            <legend className="pb-1 text-xs text-on-surface-variant">Password</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {(
                [
                  [false, 'Generate'],
                  [true, 'Custom'],
                ] as const
              ).map(([value, text]) => (
                <label key={text} className="flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name={`${ids}pw`}
                    checked={custom === value}
                    onChange={() => setCustom(value)}
                    className="accent-primary"
                  />
                  {text}
                </label>
              ))}
            </div>
            {custom ? (
              <input
                type={streamer ? 'password' : 'text'}
                value={secret}
                onChange={e => setSecret(e.target.value)}
                maxLength={200}
                autoComplete={streamer ? 'new-password' : 'off'}
                aria-label="Custom password"
                placeholder="At least 8 characters"
                className={`${fieldCls} streamer mt-2 w-full`}
              />
            ) : (
              <p className="pt-1 text-xs text-on-surface-variant">
                Four random words, shown once after you create it.
              </p>
            )}
          </fieldset>
          <label className="block">
            <span className="block pb-1 text-xs text-on-surface-variant">Expires after</span>
            <select
              value={expiry}
              onChange={e => setExpiry(e.target.value as ExpiryChoice)}
              className={selectCls}
            >
              <option value="never">Never</option>
              {EXPIRY_PRESETS.map(p => (
                <option key={p.seconds} value={p.seconds}>
                  {p.label}
                </option>
              ))}
              <option value="custom">Custom date and time</option>
            </select>
          </label>
          {expiry === 'custom' && (
            <input
              type="datetime-local"
              value={expiryAt}
              min={toLocalInput(nowMs + 60_000)}
              max={toLocalInput(nowMs + EXPIRY_MAX * 1000)}
              onChange={e => setExpiryAt(e.target.value)}
              aria-label="Expiry date and time"
              className={`${fieldCls} w-full`}
            />
          )}
          <label className="block">
            <span className="block pb-1 text-xs text-on-surface-variant">Max uses</span>
            <select
              value={uses}
              onChange={e => setUses(e.target.value as UsesChoice)}
              className={selectCls}
            >
              <option value="unlimited">Unlimited</option>
              {USE_PRESETS.map(n => (
                <option key={n} value={n}>
                  {n === 1 ? '1 use' : `${n} uses`}
                </option>
              ))}
              <option value="custom">Custom</option>
            </select>
          </label>
          {uses === 'custom' && (
            <input
              inputMode="numeric"
              value={usesRaw}
              onChange={e => setUsesRaw(e.target.value)}
              aria-label="Number of uses"
              placeholder="1 to 10000"
              className={`${fieldCls} w-full`}
            />
          )}
          <p className="text-xs text-on-surface-variant">
            Each join or guest visit uses it once. Previewing an invite does not.
          </p>
          <FieldError message={error} />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className={textBtn}>
              Cancel
            </button>
            <button disabled={busy} className={filledBtn}>
              {busy ? 'Creating…' : 'Create'}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  )
}

export function ServerAccessSection({
  server,
  hasPassword,
  canRemove,
}: {
  server: string
  hasPassword: boolean
  canRemove: boolean
}) {
  const username = useStore(s => s.me?.username ?? null)
  const askConfirm = useStore(s => s.askConfirm)
  const settings = useStore(s => s.settings)
  const publicReadable = joinableByName(false, settings)
  const name = useId()
  const [data, setData] = useState<ServerPasswords | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [book, setBook] = useState<SecretBook>(() =>
    username ? readBook(username) : parseSecrets(null)
  )
  const [creating, setCreating] = useState(false)
  const [rev, setRev] = useState(0)
  const refresh = useCallback(() => setRev(r => r + 1), [])

  useEffect(() => {
    let live = true
    api.listPasswords(server).then(
      res => {
        if (!live) return
        setData(res)
        setError(null)
      },
      (err: unknown) => live && setError(errorText(err))
    )
    return () => {
      live = false
    }
  }, [server, rev, hasPassword])

  useEffect(() => {
    if (!data || !username) return
    const now = nowSeconds()
    const live = data.passwords.filter(p => statusAt(p, now) === 'live').map(p => p.id)
    setBook(prev => {
      const next = keepSecrets(prev, server, live)
      if (next !== prev) saveBook(username, next)
      return next
    })
  }, [data, server, username])

  const soonest = (data?.passwords ?? [])
    .filter(p => p.status === 'live' && p.expires_at !== null)
    .reduce((min, p) => Math.min(min, (p.expires_at ?? 0) - nowSeconds()), Infinity)
  const now = useNow(tickMs(soonest))

  const setProtected = (on: boolean) => {
    if (!data || data.protected === on) return
    askConfirm(
      on
        ? {
            title: 'Require a Password',
            body: 'Current members stay. Nobody new can join until you set a permanent password or add one below.',
            confirm: 'Require password',
            action: () =>
              void api
                .updateServer(server, { protected: true })
                .then(refresh, (err: unknown) => setError(errorText(err))),
          }
        : {
            title: 'Make Server Public',
            body: `${goingPublic(settings, publicReadable)} The permanent password is removed and every other password is revoked.`,
            confirm: 'Make public',
            action: () =>
              void api
                .updateServer(server, { protected: false })
                .then(refresh, (err: unknown) => setError(errorText(err))),
          }
    )
  }

  const revoke = (p: ServerPassword) =>
    askConfirm({
      title: 'Revoke Password',
      body: `Revoke "${passwordName(p.label)}"? Nobody new can join with it and guests who used it lose access. Members stay.`,
      confirm: 'Revoke',
      action: () =>
        void api
          .revokePassword(server, p.id)
          .then(refresh, (err: unknown) => setError(errorText(err))),
    })

  const live = data?.passwords.filter(p => statusAt(p, now) === 'live').length ?? 0
  const closed = data ? isClosed(data, now) : false

  return (
    <>
      <p className={sectionCls}>Access</p>
      {!data ? (
        error ? (
          <FieldError message={error} />
        ) : (
          <p className="text-sm text-on-surface-variant">Loading…</p>
        )
      ) : (
        <>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Radio
              name={name}
              checked={!data.protected}
              onChange={() => setProtected(false)}
              title="Public"
              detail={publicDetail(settings, publicReadable)}
              icon={<LockOpen size={14} />}
            />
            <Radio
              name={name}
              checked={data.protected}
              onChange={() => setProtected(true)}
              title="Password protected"
              detail={protectedDetail(settings, false)}
              icon={<Lock size={14} />}
            />
          </div>
          {data.protected && (
            <>
              {closed && (
                <div
                  role="status"
                  className="mt-3 rounded-xl bg-error-container px-3 py-2 text-on-error-container"
                >
                  <p className="text-sm font-medium">Closed: nobody new can join</p>
                  <p className="pt-0.5 text-xs">
                    Set a permanent password or add a password below to let people in.
                  </p>
                </div>
              )}
              <PermanentPassword
                server={server}
                has={data.permanent}
                canRemove={canRemove}
                refresh={refresh}
              />
              <div className="flex items-center gap-2 pt-4 pb-1.5">
                <p className="flex-1 text-sm font-medium text-on-surface">
                  Passwords{' '}
                  <span className="text-xs font-normal text-on-surface-variant">
                    {live}/{ACTIVE_MAX} active
                  </span>
                </p>
                <button
                  type="button"
                  onClick={() => setCreating(true)}
                  disabled={live >= ACTIVE_MAX}
                  className={`${textBtn} flex items-center gap-1 disabled:opacity-40`}
                >
                  <Plus size={16} />
                  New password
                </button>
              </div>
              {data.passwords.length ? (
                data.passwords.map(p => (
                  <PasswordRow
                    key={p.id}
                    server={server}
                    password={p}
                    now={now}
                    secret={secretFor(book, server, p.id)}
                    onRevoke={() => revoke(p)}
                  />
                ))
              ) : (
                <p className="px-2 text-sm text-on-surface-variant">
                  No other passwords. Add temporary passwords or tickets with a use limit.
                </p>
              )}
              <p className="pt-1.5 text-xs text-on-surface-variant">
                Renaming the server revokes these passwords.
              </p>
            </>
          )}
          <FieldError message={error} />
        </>
      )}
      {creating && (
        <NewPasswordDialog
          server={server}
          onClose={() => setCreating(false)}
          onCreated={res => {
            if (username)
              setBook(prev => {
                const next = withSecret(prev, server, res.id, res.password)
                saveBook(username, next)
                return next
              })
            refresh()
          }}
        />
      )}
    </>
  )
}

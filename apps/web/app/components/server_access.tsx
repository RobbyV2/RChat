'use client'

import { Name, NameInput } from './name'
import { handleName } from '../lib/names'
import { useEffect, useId, useState, type ReactNode } from 'react'
import { Check, Copy, Lock, LockOpen, Plus } from 'lucide-react'
import { readLocal, writeLocal } from '../lib/instances'
import { errorText, useStore } from '../lib/store'
import { Loaded, useAccountSource } from './loaded'
import { useAccount, useApi } from '../lib/client/react'
import { inviteUrl } from '../lib/invite'
import { passwordDone, passwordPrompt } from '../lib/rules'
import { goingPublic, protectedDetail, publicDetail } from '../lib/joining'
import {
  choiceOf,
  optionOf,
  publicReadingAllowed,
  readableNow,
  readingChoices,
  readingLine,
  shownChoice,
  type PublicRead,
  type ReadingChoice,
} from '../lib/public_reading'
import { MEMBERS_VISIBLE_LABEL, membersVisibleLine } from '../lib/profile_choice'
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
import { SettingSwitch } from './settings_fields'
import { GUEST_VOICE_OFF, GUEST_VOICE_ON } from '../lib/guest_voice'
import { Button, IconButton } from './controls'
import { Grid, Row, Stack, Surface, Inset } from './layout'
import { Chips, Dialog, FieldError, fieldCls, useCopied } from './ui'
import { time } from '../lib/platform/time'

const UNTITLED = 'Untitled password'

export const passwordName = (label: string | null) => label ?? UNTITLED

const nowSeconds = () => Math.floor(time().now() / 1000)

const readBook = (key: string) => {
  try {
    return parseSecrets(readLocal(key))
  } catch {
    return parseSecrets(null)
  }
}

const saveBook = (key: string, book: SecretBook) =>
  writeLocal(key, Object.keys(book.servers).length ? JSON.stringify(book) : null)

const CHIP = {
  live: 'bg-primary-container text-on-primary-container',
  expired: 'bg-surface-container-highest text-on-surface-variant',
  used_up: 'bg-surface-container-highest text-on-surface-variant',
  revoked: 'bg-error-container text-on-error-container',
} as const satisfies Record<PasswordStatus, string>

function Chip({ status }: { status: PasswordStatus }) {
  return (
    <Inset
      as="span"
      pad="sm"
      inset="chip"
      look={`rounded-full text-2xs leading-4 font-medium ${CHIP[status]}`}
      place="shrink-0"
    >
      {STATUS_LABEL[status]}
    </Inset>
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
      <IconButton
        icon={copied ? Check : Copy}
        label={label}
        tooltip={copied ? 'Copied' : label}
        size="sm"
        disabled={off}
        onClick={() => {
          if (text) void navigator.clipboard.writeText(text).then(flashCopied)
        }}
        place="disabled:pointer-events-none"
      />
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
  const { shareOrigin } = useAccount()
  const status = statusAt(password, now)
  const live = status === 'live'
  const { label, expires_at, max_uses, uses, created_by } = password
  return (
    <div className="rounded-xl hover:bg-surface-container-highest/50">
      <Surface pad="sm" gap="3xs" tone="plain" radius="lg">
        <Row gap="sm">
          <span
            className={`min-w-0 flex-1 truncate text-sm ${label ? 'text-on-surface' : 'text-on-surface-variant italic'}`}
          >
            {passwordName(label)}
          </span>
          <Chip status={status} />
          {live && (
            <CopyButton
              text={secret ? inviteUrl(server, secret, shareOrigin) : null}
              label="Copy invite link"
              why="The password is only kept on the device that created it"
            />
          )}
          {(live || status === 'used_up') && (
            <Button variant="danger" onClick={onRevoke}>
              Revoke
            </Button>
          )}
        </Row>
        <div className="text-xs text-on-surface-variant">
          <Row gap="md" wrap>
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
                by <Name of={handleName(created_by)} />
              </span>
            )}
          </Row>
        </div>
      </Surface>
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
    <Surface
      as="label"
      pad="md"
      inset="bar"
      gap="md"
      row
      tone="plain"
      radius="lg"
      align="stretch"
      look={`cursor-pointer border ${
        checked
          ? 'border-primary bg-surface-container-highest'
          : 'border-outline-variant hover:bg-surface-container-highest'
      }`}
      place="min-w-0 flex-1"
    >
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onChange}
        className="shrink-0 accent-primary"
      />
      <span className="min-w-0">
        <Row as="span" gap="xs" text="sm" ink="strong" look="font-medium">
          {icon}
          {title}
        </Row>
        <span className="block text-xs text-on-surface-variant">{detail}</span>
      </span>
    </Surface>
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
  const api = useApi()
  const askConfirm = useStore(s => s.askConfirm)
  const siteAdmin = useStore(s => s.me?.is_site_admin ?? false)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  return (
    <Stack gap="xs">
      <p className="text-sm font-medium text-on-surface">Permanent password</p>
      <Row
        as="form"
        gap="sm"
        align="stretch"
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
        <Button type="submit" variant="filled" size="md" disabled={!password.trim() && !has}>
          {password.trim() ? (has ? 'Change' : 'Set') : has ? 'Remove' : 'Set'}
        </Button>
      </Row>
      <FieldError message={error} />
      {done && (
        <p role="status" className="text-xs text-on-surface">
          {done}
        </p>
      )}
      <p className="text-xs text-on-surface-variant">
        {has
          ? 'Works until you change or remove it.'
          : 'No permanent password. Only the passwords below let new people in.'}
      </p>
    </Stack>
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
  const { shareOrigin, api } = useAccount()
  const ids = useId()
  const streamer = useStore(s => s.streamer)
  const [label, setLabel] = useState('')
  const [custom, setCustom] = useState(false)
  const [secret, setSecret] = useState('')
  const [expiry, setExpiry] = useState<ExpiryChoice>(`${86400}`)
  const [expiryAt, setExpiryAt] = useState(() => toLocalInput(time().now() + 86400 * 1000))
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
      const picked = customExpiry(expiryAt, time().now())
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
  const nowMs = time().now()

  return (
    <Dialog title={created ? 'Password Created' : 'New Password'} onClose={onClose} layer="confirm">
      {created ? (
        <Stack gap="xl">
          <Stack gap="md">
            <p className="text-sm text-on-surface-variant">
              Copy it now. It is not shown again, but this device remembers it for the invite link.
            </p>
            <Row gap="sm">
              <NameInput
                readOnly
                value={created.password}
                aria-label="New password"
                onFocus={e => e.currentTarget.select()}
                className={`${fieldCls} font-mono`}
              />
              <CopyButton text={created.password} label="Copy password" />
              <CopyButton
                text={inviteUrl(server, created.password, shareOrigin)}
                label="Copy invite link"
              />
            </Row>
          </Stack>
          <Row gap="none" justify="end">
            <Button variant="filled" size="md" autoFocus onClick={onClose}>
              Done
            </Button>
          </Row>
        </Stack>
      ) : (
        <Stack
          as="form"
          gap="lg"
          onSubmit={e => {
            e.preventDefault()
            submit()
          }}
        >
          <Stack as="label" gap="2xs">
            <span className="text-xs text-on-surface-variant">Label</span>
            <input
              value={label}
              onChange={e => setLabel(e.target.value)}
              maxLength={100}
              placeholder="For example: Friends from school"
              className={`${fieldCls} w-full`}
            />
          </Stack>
          <Stack as="fieldset" gap={custom ? 'sm' : '2xs'}>
            <legend className="text-xs text-on-surface-variant">Password</legend>
            <Row gap="lg" wrap>
              {(
                [
                  [false, 'Generate'],
                  [true, 'Custom'],
                ] as const
              ).map(([value, text]) => (
                <label key={text} className="flex cursor-pointer text-sm">
                  <Row as="span" gap="sm">
                    <input
                      type="radio"
                      name={`${ids}pw`}
                      checked={custom === value}
                      onChange={() => setCustom(value)}
                      className="accent-primary"
                    />
                    {text}
                  </Row>
                </label>
              ))}
            </Row>
            {custom ? (
              <NameInput
                type={streamer ? 'password' : 'text'}
                value={secret}
                onChange={e => setSecret(e.target.value)}
                maxLength={200}
                autoComplete={streamer ? 'new-password' : 'off'}
                aria-label="Custom password"
                placeholder="At least 8 characters"
                className={`${fieldCls} w-full`}
              />
            ) : (
              <p className="text-xs text-on-surface-variant">
                Four random words, shown once after you create it.
              </p>
            )}
          </Stack>
          <Stack as="label" gap="2xs">
            <span className="text-xs text-on-surface-variant">Expires after</span>
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
          </Stack>
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
          <Stack as="label" gap="2xs">
            <span className="text-xs text-on-surface-variant">Max uses</span>
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
          </Stack>
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
          <Row gap="sm" justify="end">
            <Button size="md" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="filled" size="md" disabled={busy}>
              {busy ? 'Creating…' : 'Create'}
            </Button>
          </Row>
        </Stack>
      )}
    </Dialog>
  )
}

// "Anyone can read this server": follows the site, on, or off, with what it means right now.
function PublicReading({
  server,
  hasPassword,
  option,
}: {
  server: string
  hasPassword: boolean
  option: PublicRead
}) {
  const api = useApi()
  const settings = useStore(s => s.settings)
  const [error, setError] = useState<string | null>(null)
  const label = 'Anyone can read this server'
  const pick = (choice: ReadingChoice) => {
    if (choice === choiceOf(option)) return
    void api.updateServer(server, { public_read: optionOf(choice) }).then(
      () => setError(null),
      (err: unknown) => setError(errorText(err))
    )
  }
  return (
    <Stack gap="xs">
      <p className="text-sm font-medium text-on-surface">{label}</p>
      <Chips
        label={label}
        value={shownChoice(option, settings)}
        options={readingChoices(hasPassword, settings)}
        onChange={pick}
        disabled={!publicReadingAllowed(settings)}
      />
      <p className="text-xs text-on-surface-variant">
        {readingLine(option, hasPassword, settings)}
      </p>
      <FieldError message={error} />
    </Stack>
  )
}

export function GuestParticipation({ server }: { server: string }) {
  const api = useApi()
  const detail = useStore(s => s.servers[server])
  const site = useStore(s => s.settings)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const pick = (patch: { guest_voice_opt_in?: boolean; guest_chat_opt_in?: boolean }) => {
    setBusy(true)
    void api
      .updateServer(server, patch)
      .then(
        () => setError(null),
        (err: unknown) => setError(errorText(err))
      )
      .finally(() => setBusy(false))
  }
  return (
    <div>
      <div>
        <SettingSwitch
          label="Guests can send messages"
          hint={
            site.guest_chat_enabled
              ? 'Allows text and replies in writable text channels.'
              : 'Guest text chat is turned off for this site.'
          }
          value={detail?.guest_chat === true}
          disabled={busy || !detail || (!detail.guest_chat && !site.guest_chat_enabled)}
          onChange={on => pick({ guest_chat_opt_in: on })}
        />
        <SettingSwitch
          label="Guests can use voice"
          hint={
            !site.guest_voice_enabled
              ? 'Guest voice is turned off for this site.'
              : detail?.guest_voice
                ? GUEST_VOICE_ON
                : GUEST_VOICE_OFF
          }
          value={detail?.guest_voice === true}
          disabled={busy || !detail || (!detail.guest_voice && !site.guest_voice_enabled)}
          onChange={on => pick({ guest_voice_opt_in: on })}
        />
      </div>
      <FieldError message={error} />
    </div>
  )
}

// "Members can be seen by people outside this server": on or off.
function MemberPrivacy({ server, visible }: { server: string; visible: boolean }) {
  const api = useApi()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const flip = (next: boolean) => {
    if (busy || next === visible) return
    setBusy(true)
    void api
      .updateServer(server, { members_visible: next })
      .then(
        () => setError(null),
        (err: unknown) => setError(errorText(err))
      )
      .finally(() => setBusy(false))
  }
  return (
    <div>
      <div>
        <SettingSwitch
          label={MEMBERS_VISIBLE_LABEL}
          hint={membersVisibleLine(visible)}
          value={visible}
          onChange={flip}
          disabled={busy}
        />
      </div>
      <FieldError message={error} />
    </div>
  )
}

interface AccessProps {
  server: string
  canSettings: boolean
  canInvites: boolean
  hasPassword: boolean
  canRemove: boolean
  publicRead: PublicRead
  membersVisible: boolean | null
}

export function ServerAccessSection(props: AccessProps) {
  const { server, hasPassword, canSettings, canInvites } = props
  const [load, source] = useAccountSource(
    api => api.listPasswords(server),
    [server, hasPassword, canSettings, canInvites]
  )
  return (
    <Loaded load={load} what="who can join">
      {data => <AccessBody {...props} data={data} refresh={source.refresh} />}
    </Loaded>
  )
}

function AccessBody({
  data,
  refresh,
  server,
  canSettings,
  canInvites,
  canRemove,
  publicRead,
  membersVisible,
}: AccessProps & { data: ServerPasswords; refresh: () => void }) {
  const { api, conn: home } = useAccount()
  const username = useStore(s => s.me?.username ?? null)
  const key = username && home.scoped(secretsKey(username))
  const askConfirm = useStore(s => s.askConfirm)
  const settings = useStore(s => s.settings)
  const publicReadable = readableNow(publicRead, false, settings)
  const name = useId()
  const [error, setError] = useState<string | null>(null)
  const [book, setBook] = useState<SecretBook>(() => (key ? readBook(key) : parseSecrets(null)))
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    if (!canInvites || !key) return
    const now = nowSeconds()
    const live = data.passwords.filter(p => statusAt(p, now) === 'live').map(p => p.id)
    setBook(prev => {
      const next = keepSecrets(prev, server, live)
      if (next !== prev) saveBook(key, next)
      return next
    })
  }, [data, server, key, canInvites])

  const soonest = data.passwords
    .filter(p => p.status === 'live' && p.expires_at !== null)
    .reduce((min, p) => Math.min(min, (p.expires_at ?? 0) - nowSeconds()), Infinity)
  const now = useNow(tickMs(soonest))

  const setProtected = (on: boolean) => {
    if (data.protected === on) return
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

  const live = data.passwords.filter(p => statusAt(p, now) === 'live').length
  const closed = canInvites ? isClosed(data, now) : data.closed

  return (
    <>
      <Stack gap="md">
        {canSettings && (
          <Grid cols={{ base: 1, sm: 2 }} gap="sm">
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
              detail={protectedDetail(settings, readableNow(publicRead, true, settings))}
              icon={<Lock size={14} />}
            />
          </Grid>
        )}
        {data.protected && (
          <>
            {closed && (
              <Surface role="status" pad="md" gap="3xs" tone="error" radius="lg">
                <p className="text-sm font-medium">Closed: nobody new can join</p>
                <p className="text-xs">
                  Set a permanent password or add a password below to let people in.
                </p>
              </Surface>
            )}
            {canSettings && (
              <PermanentPassword
                server={server}
                has={data.permanent}
                canRemove={canRemove}
                refresh={refresh}
              />
            )}
            {canInvites && (
              <Stack gap="xs">
                <Row gap="sm">
                  <p className="flex-1 text-sm font-medium text-on-surface">
                    Passwords{' '}
                    <span className="text-xs font-normal text-on-surface-variant">
                      {live}/{ACTIVE_MAX} active
                    </span>
                  </p>
                  <Button
                    icon={Plus}
                    onClick={() => setCreating(true)}
                    disabled={live >= ACTIVE_MAX}
                  >
                    New password
                  </Button>
                </Row>
                {data.passwords.length ? (
                  <Stack gap="none">
                    {data.passwords.map(p => (
                      <PasswordRow
                        key={p.id}
                        server={server}
                        password={p}
                        now={now}
                        secret={secretFor(book, server, p.id)}
                        onRevoke={() => revoke(p)}
                      />
                    ))}
                  </Stack>
                ) : (
                  <Surface pad="sm" inset="bar" tone="plain" radius="none">
                    <p className="text-sm text-on-surface-variant">
                      No other passwords. Add temporary passwords or tickets with a use limit.
                    </p>
                  </Surface>
                )}
                <p className="text-xs text-on-surface-variant">
                  Renaming the server revokes these passwords.
                </p>
              </Stack>
            )}
          </>
        )}
        {canSettings && (
          <>
            <PublicReading server={server} hasPassword={data.protected} option={publicRead} />
            {membersVisible !== null && <MemberPrivacy server={server} visible={membersVisible} />}
            <GuestParticipation server={server} />
          </>
        )}
        <FieldError message={error} />
      </Stack>
      {creating && (
        <NewPasswordDialog
          server={server}
          onClose={() => setCreating(false)}
          onCreated={res => {
            if (key)
              setBook(prev => {
                const next = withSecret(prev, server, res.id, res.password)
                saveBook(key, next)
                return next
              })
            refresh()
          }}
        />
      )}
    </>
  )
}

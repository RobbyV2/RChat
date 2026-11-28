'use client'

import { asAccount } from '../lib/people'
import { instanceAddress, personName, serverCalled } from '../lib/names'
import { Name } from './name'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type Ref,
  type RefObject,
  type SyntheticEvent,
} from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import { ExternalLink, Globe, Hash, Link2Off, Lock, Paperclip } from 'lucide-react'
import { ApiError } from '../lib/api'
import type { InviteAccess } from '../lib/remote_invite'
import { accountPath } from '../lib/view'
import { knownLinkOrigin, routeInstanceLink, linkChoice } from '../lib/client/instance_links'
import { client } from '../lib/client/client'
import { routeOwnerFor } from '../lib/client/account_paths'
import { useAccount, useStoreApi } from '../lib/client/react'
import { InstanceError, type InstanceConnection } from '../lib/instances'
import { useForwardAccess } from '../lib/forward_access'
import { carriedTarget } from '../lib/forward_viewing'
import { errorText, useStore, type Nav } from '../lib/store'
import {
  autoStep,
  hostParts,
  pinnedPreview,
  previewParts,
  remoteInviteUrl,
  keepsPreview,
  refreshDelay,
  remoteKey,
  sharedByCode,
  stashInvite,
  targetPath,
  inviteUrl,
  type RemoteInvite,
} from '../lib/invite'
import { channelTarget } from '../lib/viewing'
import { formatQualified, hostOf } from '../lib/qualified'
import { deniedAccess, needsPassword } from '../lib/join_flow'
import { absoluteTime, countdown, tickMs, useNow, usesLeftText } from '../lib/passwords'
import { plainStamps } from '../lib/timestamps'
import { serverInitial } from '../lib/rules'
import { joinNeeds } from '../lib/joining'
import type { Invite, InviteStatus, Message } from '../lib/types'
import { ServerGlyph } from './server_rail'
import { openMessageLink } from '../lib/link_open'
import { AboutLine } from './server_about'
import { aboutText } from '../lib/server_about'
import { Button } from './controls'
import { Row, Stack, Surface } from './layout'
import { Dialog, fieldCls, FieldError, LinkPage, useOwn } from './ui'
import { SpoilerLine } from './replies'
import { PreviewFilename, RevealChannelPreview } from './preview_reveal'
import { InstanceChip } from './instance_badge'
import { UserAvatar } from './user_avatar'
import { profileTrigger } from './profile_card'
import { time } from '../lib/platform/time'

type InviteVariant = 'embed' | 'page'

const TTL = 30_000
const FRESH = 1_000
const CACHE_MAX = 100
type InviteResults = Map<string, { at: number; promise: Promise<Invite> }>
const results = new WeakMap<object, InviteResults>()

const fetchInvite = (
  owner: ReturnType<typeof useAccount>,
  key: string,
  server: string,
  password: string | null,
  code: string | null,
  maxAge: number
) => {
  const mark = owner.lifetime.sessionMark()
  const cache = results.get(mark) ?? new Map<string, { at: number; promise: Promise<Invite> }>()
  results.set(mark, cache)
  const api = owner.api
  const hit = cache.get(key)
  if (hit && time().now() - hit.at < maxAge) return hit.promise
  const promise = code ? api.inviteByCode(code) : api.getInvite(server, password, 'metadata')
  cache.delete(key)
  cache.set(key, { at: time().now(), promise })
  const oldest = cache.keys().next().value
  if (cache.size > CACHE_MAX && oldest !== undefined) cache.delete(oldest)
  promise.catch(() => {
    if (cache.get(key)?.promise === promise) cache.delete(key)
  })
  return promise
}

interface Loaded {
  key: string
  data: Invite | null
  error: unknown
}

function useVisible(ref: RefObject<HTMLElement | null>, always: boolean) {
  const [visible, setVisible] = useState(true)
  useEffect(() => {
    const el = ref.current
    if (always || !el || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(entries => {
      const last = entries.at(-1)
      if (last) setVisible(last.isIntersecting)
    })
    io.observe(el)
    return () => io.disconnect()
  }, [ref, always])
  return always || visible
}

function useSettledVersion(version: number, visible: boolean) {
  const [settled, setSettled] = useState(version)
  const stale = useRef<{ since: number; bump: number } | null>(null)
  const fetchedAt = useRef(0)
  useEffect(() => {
    const now = time().now()
    stale.current = { since: stale.current?.since ?? now, bump: now }
  }, [version])
  useEffect(() => {
    const due = stale.current
    if (version === settled) stale.current = null
    if (version === settled || !visible || !due) return
    const timer = time().after(
      refreshDelay(due.since, due.bump, fetchedAt.current, time().now()),
      () => {
        stale.current = null
        fetchedAt.current = time().now()
        setSettled(version)
      }
    )
    return () => timer()
  }, [version, settled, visible])
  return settled
}

const transient = (error: unknown) => keepsPreview(error instanceof ApiError ? error.status : null)

function useInvite(
  server: string,
  password: string | null,
  code: string | null,
  root: RefObject<HTMLElement | null>,
  always: boolean
) {
  const owner = useAccount()
  const { watchInvites, inviteVersion } = owner.inviteUpdates
  const viewer = useStore(s => s.me?.username ?? '')
  const epoch = useStore(s => s.channelLabelEpoch)
  const scope = `${owner.renderKey}\n${owner.conn.origin}\n${epoch}\n${viewer}`
  const key = code ? `${scope}\n\n\n${code}` : `${scope}\n${server}\n${password ?? ''}`
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const watched = code ? (loaded?.data?.server.name ?? '') : server
  const bumped = useSyncExternalStore(
    watchInvites,
    () => inviteVersion(watched),
    () => 0
  )
  const visible = useVisible(root, always)
  const version = useSettledVersion(bumped, visible)
  const [tick, setTick] = useState(0)
  const maxAge = useRef(TTL)
  useEffect(() => {
    let live = true
    const mark = owner.lifetime.sessionMark()
    const current = () => live && mark === owner.lifetime.sessionMark()
    fetchInvite(owner, `${key}\n${version}`, server, password, code, maxAge.current).then(
      data => {
        if (current()) setLoaded({ key, data, error: null })
      },
      (error: unknown) => {
        if (!current()) return
        setLoaded(prev =>
          prev?.key === key && prev.data && transient(error)
            ? { key, data: prev.data, error: null }
            : { key, data: null, error }
        )
      }
    )
    maxAge.current = TTL
    return () => {
      live = false
    }
  }, [owner, key, server, password, code, tick, version])
  const reload = useCallback(() => {
    maxAge.current = FRESH
    setTick(t => t + 1)
  }, [])
  const current = loaded?.key === key ? loaded : null
  return { data: current?.data ?? null, error: current?.error ?? null, reload }
}

const pins = new Map<HTMLElement, { ro: ResizeObserver; heights: Map<Element, number> }>()

const pinBottom = (list: HTMLElement, el: HTMLElement) => {
  const group = pins.get(list) ?? {
    heights: new Map<Element, number>(),
    ro: new ResizeObserver(entries => {
      let grew = 0
      for (const { target } of entries) {
        const height = target instanceof HTMLElement ? target.offsetHeight : 0
        grew += Math.max(0, height - (group.heights.get(target) ?? height))
        group.heights.set(target, height)
      }
      const gap = list.scrollHeight - list.scrollTop - list.clientHeight
      if (grew > 0 && gap - grew < 60) list.scrollTop = list.scrollHeight
    }),
  }
  pins.set(list, group)
  group.heights.set(el, el.offsetHeight)
  group.ro.observe(el)
  return () => {
    group.ro.unobserve(el)
    group.heights.delete(el)
    if (group.heights.size > 0) return
    group.ro.disconnect()
    pins.delete(list)
  }
}

function useKeepBottom(ref: RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    const el = ref.current
    const list = el?.closest<HTMLElement>('.overflow-y-auto')
    if (!active || !el || !list) return
    return pinBottom(list, el)
  }, [ref, active])
}

const stop = (e: SyntheticEvent) => e.stopPropagation()
const isolate = {
  onClick: stop,
  onContextMenu: stop,
  onPointerDown: stop,
  onTouchStart: stop,
  onTouchMove: stop,
  onTouchEnd: stop,
  onTouchCancel: stop,
}

function PasswordDialog({
  name,
  initialError,
  onSubmit,
  onClose,
  unlock = false,
}: {
  name: string
  initialError: string | null
  onSubmit: (password: string) => Promise<string | null>
  onClose: () => void
  unlock?: boolean
}) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState(initialError)
  const [busy, setBusy] = useState(false)
  return createPortal(
    <div {...isolate}>
      <Dialog title="Server password" onClose={onClose}>
        <Stack
          as="form"
          gap="lg"
          onSubmit={async e => {
            e.preventDefault()
            const pw = password.trim()
            if (!pw || busy) return
            setBusy(true)
            setError(null)
            const failed = await onSubmit(pw)
            setBusy(false)
            if (failed) setError(failed)
          }}
        >
          <p className="text-sm text-on-surface-variant">
            {unlock ? (
              <>
                Enter the password for{' '}
                <Name of={serverCalled(name)} look="font-medium text-on-surface" /> to view this
                invite.
              </>
            ) : (
              <>
                <Name of={serverCalled(name)} look="font-medium text-on-surface" /> is password
                protected. Enter its password to join.
              </>
            )}
          </p>
          <Stack gap="none">
            <input
              autoFocus
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Server password"
              aria-invalid={error !== null}
              className={`${fieldCls} w-full`}
            />
            <FieldError message={error} />
          </Stack>
          <Row gap="sm" justify="end">
            <Button size="md" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="filled" size="md" disabled={busy || !password.trim()}>
              {unlock ? (busy ? 'Checking…' : 'Continue') : busy ? 'Joining…' : 'Join'}
            </Button>
          </Row>
        </Stack>
      </Dialog>
    </div>,
    document.body
  )
}

function Tile({ big, children, tone }: { big: boolean; children: ReactNode; tone: string }) {
  return (
    <span
      className={`flex shrink-0 items-center justify-center overflow-hidden font-semibold ${tone} ${
        big ? 'size-20 rounded-3xl text-3xl' : 'size-12 rounded-2xl text-lg'
      }`}
    >
      {children}
    </span>
  )
}

function ServerTile({
  name,
  displayName,
  big,
  look,
}: {
  name: string
  displayName: string
  big: boolean
  look: { icon_kind?: string | null; banner_color?: string | null }
}) {
  return (
    <Tile
      big={big}
      tone={
        name === 'rchat'
          ? 'bg-surface-container-highest'
          : 'bg-primary-container text-on-primary-container'
      }
    >
      <ServerGlyph name={name} displayName={displayName} look={look} />
    </Tile>
  )
}

function Counts({ invite, center }: { invite: Invite; center: boolean }) {
  const { online_count, member_count } = invite
  return (
    <div
      className={`flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-on-surface-variant ${
        center ? 'justify-center' : ''
      }`}
    >
      <Row as="span" gap="xs">
        <span className="size-2 rounded-full bg-status-green" />
        {online_count} Online
      </Row>
      <Row as="span" gap="xs">
        <span className="size-2 rounded-full bg-outline" />
        {member_count} {member_count === 1 ? 'Member' : 'Members'}
      </Row>
    </div>
  )
}

function TicketNote({ invite, now, center }: { invite: Invite; now: number; center: boolean }) {
  const { password_expires_at: ends, password_uses_left: left } = invite
  if (ends === null && left === null) return null
  return (
    <p
      className={`flex flex-wrap gap-x-2 text-xs text-on-surface-variant ${center ? 'justify-center' : ''}`}
    >
      {ends !== null && <span title={absoluteTime(ends)}>{countdown(ends, now)}</span>}
      {ends !== null && left !== null && <span aria-hidden>·</span>}
      {left !== null && <span>{usesLeftText(left)}</span>}
    </p>
  )
}

export function PreviewLine({
  message,
  big,
  host,
  server,
  remote,
}: {
  message: Message
  big: boolean
  host?: string
  server?: string
  // Another instance's preview: only the label a copy carries can decide.
  remote?: InstanceConnection
}) {
  const store = useStoreApi()
  const account = useStore(s => s.me?.username ?? null)
  const { useViewing, canView } = useAccount().viewing
  useViewing(s => s.revision)
  const copy = useForwardAccess(remote ? null : message, { server })
  const carried =
    remote && server && message.forward
      ? carriedTarget(message.forward, account, server, remote)
      : null
  const hidden = remote ? !!carried && !canView(carried) : copy.access !== 'open'
  const reveal = remote ? carried : copy.target
  const { author, content, media } = message
  const own = useOwn(host || message.webhook ? null : author.username)
  const parts = previewParts(plainStamps(content))
  return (
    <Row gap="sm" align="start">
      <UserAvatar person={asAccount(author, 'invite')} size={big ? 24 : 18} />
      <p
        className={`min-w-0 flex-1 text-left break-words ${
          big ? 'line-clamp-2 text-sm' : 'truncate text-xs leading-4.5'
        }`}
      >
        <Name
          of={personName(asAccount(author, 'invite'))}
          withUsername
          link={!host}
          {...(host ? {} : profileTrigger(store, author, null))}
          titled={host ? formatQualified(author.username, host) : false}
          look="font-medium text-on-surface"
        />{' '}
        <span className="text-on-surface-variant">
          {hidden ? (
            <>
              <span className="italic">Forwarded message</span>{' '}
              {reveal && <RevealChannelPreview target={reveal} />}
            </>
          ) : (
            <SpoilerLine parts={parts} own={own && !message.forward} />
          )}
          {!hidden && media !== null && (
            <span className="ml-1 inline-flex items-center gap-0.5 align-middle">
              <Paperclip size={big ? 13 : 11} />
              <PreviewFilename
                key={media.id}
                name={media.filename}
                own={own && !message.forward}
                spoiler={media.spoiler}
              />
            </span>
          )}
        </span>
      </p>
    </Row>
  )
}

function Preview({
  invite,
  big,
  host,
  password,
  remote,
  access,
}: {
  invite: Invite
  big: boolean
  host?: string
  password: string | null
  remote?: InstanceConnection
  access?: InviteAccess
}) {
  const owner = useAccount()
  const { instanceTarget, canView, useViewing, requestViewing } = owner.viewing
  const conn = remote ?? owner.conn
  const account = useStore(s => s.me?.username ?? null)
  const [seen, setSeen] = useState<{
    of: Invite
    id: number | null
    label: boolean
    name: string | null
  } | null>(null)
  const fresh = seen?.of === invite && (!access || access.current()) ? seen : null
  const id = fresh ? fresh.id : invite.preview_channel_id
  const server = invite.server.name
  const label = fresh ? fresh.label : invite.preview_sensitive
  const preview_channel = fresh ? fresh.name : invite.preview_channel
  const local = useStore(s => {
    if (remote || id == null || !s.servers[server]) return undefined
    return instanceTarget(s, server, id)?.sensitive ?? null
  })
  useViewing(s => s.revision)
  const target =
    conn &&
    id != null &&
    typeof label === 'boolean' &&
    local !== null &&
    channelTarget(
      account,
      'instance',
      server,
      { id, name: preview_channel ?? server, sensitive: label || local === true },
      conn
    )
  const allowed = !!target && canView(target)
  const key = JSON.stringify([target && target.key, password, label])
  const [loaded, setLoaded] = useState<{
    key: string
    access?: InviteAccess
    data: Message[]
  } | null>(null)
  useEffect(() => {
    if (!remote && local === null)
      void owner.store
        .getState()
        .discoverChannels(server)
        .catch(() => {})
    if (!allowed || !conn) {
      setLoaded(null)
      return
    }
    let live = true
    const revision = { revision: `${id}.${label ? 1 : 0}` }
    const messages = access
      ? access.read(conn, server, password, revision)
      : conn.api.getInvite(server, password, revision)
    void messages
      .then(data => {
        if (!live || (access && !access.current())) return
        const answer = pinnedPreview({ id, label }, data)
        if (answer.changed) setSeen({ of: invite, ...answer.changed })
        else setLoaded({ key, access, data: answer.messages })
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [allowed, conn, id, label, key, server, password, remote, local, invite, owner, access])
  if (!target || !preview_channel) return null
  if (!allowed)
    return (
      <Button
        size="md"
        onClick={() => void requestViewing(target)}
        place={big ? 'self-center' : 'self-start'}
      >
        Open channel preview
      </Button>
    )
  if (!loaded || loaded.key !== key || loaded.access !== access) return null
  const preview = loaded.data
  if (preview_channel === null || (preview.length === 0 && !big)) return null
  return (
    <Surface tone="high" radius="lg" pad={big ? 'md' : 'sm'} gap={big ? 'sm' : 'xs'}>
      <p className="min-w-0 text-xs font-medium text-on-surface-variant">
        <Row as="span" gap="2xs">
          <Hash size={12} className="shrink-0" />
          <span className="truncate">{preview_channel}</span>
        </Row>
      </p>
      {preview.length ? (
        <Stack gap={big ? 'sm' : '2xs'}>
          {preview.map(m => (
            <PreviewLine
              key={m.id}
              message={m}
              big={big}
              host={host}
              server={server}
              remote={remote}
            />
          ))}
        </Stack>
      ) : (
        <p className="text-left text-xs text-on-surface-variant">No messages yet</p>
      )}
    </Surface>
  )
}

interface Body {
  icon: ReactNode
  title: ReactNode
  sub: ReactNode
  actions: ReactNode
  extra?: ReactNode
}

function Frame({
  big,
  invalid,
  ref,
  children,
  heading,
}: {
  big: boolean
  invalid: boolean
  ref: Ref<HTMLDivElement>
  children: ReactNode
  heading?: ReactNode
}) {
  if (big)
    return (
      <div ref={ref} className="w-full max-w-md rounded-hero text-center shadow-elevation-3">
        <Surface tone="low" radius="hero" pad="xl">
          {children}
        </Surface>
      </div>
    )
  return (
    <div ref={ref} className="@container mt-1.5 w-full max-w-md">
      <Surface tone="base" border pad="md" gap="sm">
        <p className="text-2xs font-semibold tracking-wide text-on-surface-variant uppercase">
          {heading ??
            (invalid ? "You've received an invite, but…" : "You've been invited to join a server")}
        </p>
        {children}
      </Surface>
    </div>
  )
}

function Layout({
  big,
  invalid,
  icon,
  title,
  sub,
  actions,
  extra,
  stack = false,
}: Body & { big: boolean; invalid: boolean; stack?: boolean }) {
  if (big)
    return (
      <Stack gap="xl">
        <Stack gap="md">
          <Stack gap="lg">
            <Row gap="none" justify="center">
              {icon}
            </Row>
            <Stack gap="sm">
              <Stack gap="2xs">
                {!invalid && (
                  <p className="text-sm text-on-surface-variant">
                    You&apos;ve been invited to join
                  </p>
                )}
                <h1 className="min-w-0 text-2xl font-semibold">
                  <Row as="span" gap="sm" justify="center">
                    {title}
                  </Row>
                </h1>
              </Stack>
              <div>{sub}</div>
            </Stack>
          </Stack>
          {extra}
        </Stack>
        {actions && <Stack gap="sm">{actions}</Stack>}
      </Stack>
    )
  return (
    <Stack gap="md">
      <Row gap="md" wrap>
        {icon}
        <Stack gap="3xs" place="flex-1">
          <p className="min-w-0 font-semibold">
            <Row as="span" gap="xs">
              {title}
            </Row>
          </p>
          <div>{sub}</div>
        </Stack>
        {actions && (
          <div
            className={`flex w-full flex-wrap gap-1.5 ${stack ? '' : '@sm:w-auto @sm:shrink-0 @sm:flex-col @sm:items-end'}`}
          >
            {actions}
          </div>
        )}
      </Row>
      {extra}
    </Stack>
  )
}

function Skeleton({ big }: { big: boolean }) {
  const lines = (
    <>
      <span className="h-4 w-36 max-w-full rounded-full bg-surface-container-highest" />
      <span className="h-3 w-24 rounded-full bg-surface-container-highest" />
    </>
  )
  return (
    <div aria-busy aria-label="Loading invite" className="animate-pulse">
      {big ? (
        <Stack gap="md" align="center">
          <span className="size-20 shrink-0 rounded-3xl bg-surface-container-highest" />
          <Stack gap="sm" align="center" place="w-full">
            {lines}
          </Stack>
          <span className="h-10 w-full rounded-full bg-surface-container-highest" />
        </Stack>
      ) : (
        <Row gap="md">
          <span className="size-12 shrink-0 rounded-2xl bg-surface-container-highest" />
          <Stack gap="sm" place="flex-1">
            {lines}
          </Stack>
          <span className="h-9 w-16 shrink-0 rounded-full bg-surface-container-highest" />
        </Row>
      )}
    </div>
  )
}

type Outcome = { ok: true } | { ok: false; password: boolean; banned: boolean; message: string }

export function InviteCard({
  server: named,
  password,
  code = null,
  variant,
  autoJoin = false,
}: {
  server: string
  password: string | null
  code?: string | null
  variant: InviteVariant
  autoJoin?: boolean
}) {
  const router = useRouter()
  const root = useRef<HTMLDivElement>(null)
  const owner = useAccount()
  const mark = owner.lifetime.sessionMark()
  const big = variant === 'page'
  const [unlocked, setUnlocked] = useState<string | null>(null)
  const given = code ?? unlocked ?? password
  const { data, error, reload } = useInvite(named, given, code, root, big)
  const server = code ? (data?.server.name ?? '') : named
  const me = useStore(s => s.me)
  const guest = useStore(s => s.guest)
  const hasGrant = useStore(s => server !== '' && s.guestGrants[server] !== undefined)
  const guestsEnabled = useStore(s => s.settings.guests_enabled)
  const joining = useStore(s => s.settings.server_joining)
  const consume = useStore(s => s.consumeInviteJoin)
  const joined = useStore(
    s =>
      server !== '' &&
      (s.me
        ? s.me.servers.some(x => x.name === server)
        : s.guest && s.guestServers.includes(server))
  )
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [asking, setAsking] = useState<{ guest: boolean; error: string | null } | null>(null)
  const [unlocking, setUnlocking] = useState<string | null | false>(false)
  const seen = useRef(joined)
  const nav: Nav = big ? 'replace' : 'push'
  const authed = me !== null || guest
  const status: InviteStatus | null = data ? (joined ? 'member' : data.status) : null
  useKeepBottom(root, !big)

  useEffect(() => {
    if (seen.current === joined) return
    seen.current = joined
    reload()
  }, [joined, reload])

  const attempt = async (pw: string | null, asGuest: boolean): Promise<Outcome> => {
    if (!data) return { ok: true }
    const { name, has_password } = data.server
    const sent = has_password && !(asGuest && hasGrant) ? (pw ?? undefined) : undefined
    setBusy(true)
    setNote(null)
    try {
      const s = owner.store.getState()
      if (asGuest) await s.guestJoinServer(name, sent, nav)
      else await s.joinServer(name, sent, nav)
      return { ok: true }
    } catch (e) {
      const retry = needsPassword(e) || deniedAccess(e)
      const banned = !asGuest && e instanceof ApiError && e.status === 403
      const message = needsPassword(e) ? 'Enter the server password' : errorText(e)
      return { ok: false, password: retry, banned, message }
    } finally {
      setBusy(false)
      reload()
    }
  }

  const join = async (asGuest: boolean) => {
    consume()
    const out = await attempt(given, asGuest)
    if (out.ok) return
    if (out.password) setAsking({ guest: asGuest, error: out.message })
    else if (!out.banned) setNote(out.message)
  }

  const submitPassword = async (pw: string) => {
    if (!asking) return null
    const out = await attempt(pw, asking.guest)
    if (out.ok) {
      setAsking(null)
      return null
    }
    if (out.password) return out.message
    setAsking(null)
    if (!out.banned) setNote(out.message)
    return null
  }

  const go = () => {
    consume()
    if (data) void owner.store.getState().openServer(data.server.name, undefined, nav)
  }

  const logIn = (reopen: boolean) => {
    if (client.shown() !== owner || mark !== owner.lifetime.sessionMark()) return
    consume()
    const target = code ? { server: '', password: null, code } : { server, password }
    if (reopen) stashInvite(target, owner.handoff)
    const next = accountPath(reopen ? targetPath(target) : '/', routeOwnerFor(owner))
    router.push(next === '/' ? '/login/' : '/login/?next=' + encodeURIComponent(next))
  }

  const continueAsGuest = async () => {
    consume()
    await owner.store.getState().enterGuest()
    await join(true)
  }

  const unlock = async (pw: string) => {
    try {
      await owner.api.getInvite(server, pw, 'metadata')
      setUnlocking(false)
      setUnlocked(pw)
      return null
    } catch (e) {
      return needsPassword(e) ? 'Enter the server password' : errorText(e)
    }
  }

  useEffect(() => {
    if (!autoJoin || !authed || !status || busy) return
    const step = autoStep(status, guest)
    if (step === 'open') go()
    else if (step === 'stop') consume()
    else void join(guest)
  })

  const btn = big ? 'w-full' : 'shrink-0'
  const fit = big ? 'break-words' : 'truncate'
  const errorCode = error instanceof ApiError ? error.status : null
  const ticketEnds = data?.password_expires_at ?? null
  const now = useNow(
    ticketEnds === null ? 60_000 : tickMs(ticketEnds - Math.floor(time().now() / 1000))
  )
  const ticketGone = ticketEnds !== null && ticketEnds <= now
  const hidden = !code && (needsPassword(error) || deniedAccess(error) || ticketGone)
  const invalid = (errorCode === 404 || (code !== null && ticketGone)) && !hidden
  const locked = !authed && errorCode === 401 && !hidden
  const label = code ? 'Server invite' : server

  const body = (): Body | null => {
    if (hidden)
      return {
        icon: (
          <Tile big={big} tone="bg-primary-container text-on-primary-container">
            <Name of={serverCalled(serverInitial(server))} />
          </Tile>
        ),
        title: <Name of={serverCalled(server)} place="min-w-0" look={fit} />,
        sub: (
          <p className="text-xs text-on-surface-variant">Enter the password to view this invite</p>
        ),
        actions: (
          <>
            <Button variant="filled" size="md" onClick={() => setUnlocking(null)} place={btn}>
              Enter password
            </Button>
            {!authed && (
              <Button size="md" onClick={() => logIn(true)} place={btn}>
                Log in
              </Button>
            )}
          </>
        ),
        extra: deniedAccess(error) && given && (
          <p role="alert" className="text-xs text-error">
            {errorText(error)}
          </p>
        ),
      }
    if (invalid)
      return {
        icon: (
          <Tile big={big} tone="bg-error-container text-on-error-container">
            <Link2Off size={big ? 36 : 22} />
          </Tile>
        ),
        title: 'Invalid invite',
        sub: (
          <p className="text-xs text-on-surface-variant">
            This invite may have expired, or the server no longer exists.
          </p>
        ),
        actions: big && (
          <Button
            variant="filled"
            size="md"
            onClick={() => (authed ? owner.store.getState().closeInvite() : logIn(false))}
            place={btn}
          >
            {authed ? 'Continue to RChat' : 'Log in'}
          </Button>
        ),
      }
    if (locked)
      return {
        icon: (
          <Tile big={big} tone="bg-primary-container text-on-primary-container">
            {code ? (
              <Lock size={big ? 32 : 20} />
            ) : (
              <Name of={serverCalled(serverInitial(server))} />
            )}
          </Tile>
        ),
        title: code ? label : <Name of={serverCalled(server)} place="min-w-0" look={fit} />,
        sub: <p className="text-xs text-on-surface-variant">Log in to see who&apos;s here.</p>,
        actions: (
          <Button variant="filled" size="md" onClick={() => logIn(true)} place={btn}>
            Log in to join
          </Button>
        ),
      }
    if (error !== null)
      return {
        icon: (
          <Tile big={big} tone="bg-surface-container-highest text-on-surface-variant">
            <Link2Off size={big ? 36 : 22} />
          </Tile>
        ),
        title: "Couldn't load this invite",
        sub: <p className="text-xs text-on-surface-variant">{errorText(error)}</p>,
        actions: (
          <Button size="md" onClick={reload} place={btn}>
            Retry
          </Button>
        ),
      }
    if (!data || !status) return null
    const { name, display_name, has_password } = data.server
    const needs = status === 'readable' ? joinNeeds(has_password, { server_joining: joining }) : ''
    return {
      icon: <ServerTile name={name} displayName={display_name} big={big} look={data.server} />,
      title: (
        <>
          <Name of={serverCalled(display_name)} place="min-w-0" look={fit} />
          {has_password && status !== 'member' && !sharedByCode(data.server.join_mode) && (
            <span title="Password protected" className="shrink-0 text-on-surface-variant">
              <Lock size={big ? 18 : 13} />
            </span>
          )}
        </>
      ),
      sub: (
        <Stack gap={big ? '2xs' : '3xs'}>
          <AboutLine
            text={aboutText(data.server.description)}
            className={big ? 'text-center' : ''}
          />
          <Counts invite={data} center={big} />
          <TicketNote invite={data} now={now} center={big} />
        </Stack>
      ),
      actions: !authed ? (
        <>
          <Button variant="filled" size="md" onClick={() => logIn(true)} place={btn}>
            Log in to join
          </Button>
          {guestsEnabled && (
            <Button size="md" onClick={() => void continueAsGuest()} place={btn}>
              Continue as guest
            </Button>
          )}
        </>
      ) : status === 'member' ? (
        <Button variant="tonal" size="md" onClick={go} title="You're already a member" place={btn}>
          Go to server
        </Button>
      ) : status === 'banned' ? (
        <Button
          variant="tonal"
          size="md"
          disabled
          title="You are banned from this server"
          place={btn}
        >
          Banned
        </Button>
      ) : status === 'readable' && !guest ? (
        <Button variant="filled" size="md" onClick={go} place={btn}>
          Open
        </Button>
      ) : (
        <Button
          variant="filled"
          size="md"
          disabled={busy}
          onClick={() => void join(guest)}
          place={btn}
        >
          {busy ? 'Joining…' : 'Join'}
        </Button>
      ),
      extra: (
        <>
          {status === 'banned' && (
            <p role="status" className="text-sm text-error">
              You are banned from this server
            </p>
          )}
          {needs && (
            <p className={`text-xs text-on-surface-variant ${big ? 'text-center' : ''}`}>{needs}</p>
          )}
          {note && (
            <p role="alert" className="text-xs text-error">
              {note}
            </p>
          )}
          <Preview invite={data} big={big} password={given} />
        </>
      ),
    }
  }

  const view = body()
  if (!big && view && !invalid) {
    const { choice } = linkChoice(owner, owner.conn.origin)
    if (choice.kind !== 'open' || choice.owner !== me?.username)
      view.actions = (
        <Button
          variant="filled"
          size="md"
          onClick={() =>
            void routeInstanceLink(owner, {
              origin: owner.conn.origin,
              path: code
                ? targetPath({ server: named, password, code })
                : inviteUrl(named, password, ''),
            })
          }
        >
          Open invite
        </Button>
      )
  }
  return (
    <>
      <Frame ref={root} big={big} invalid={invalid}>
        {view ? <Layout big={big} invalid={invalid} {...view} /> : <Skeleton big={big} />}
      </Frame>
      {asking && data && (
        <PasswordDialog
          name={data.server.display_name}
          initialError={asking.error}
          onSubmit={submitPassword}
          onClose={() => setAsking(null)}
        />
      )}
      {unlocking !== false && (
        <PasswordDialog
          unlock
          name={server}
          initialError={unlocking}
          onSubmit={unlock}
          onClose={() => setUnlocking(false)}
        />
      )}
    </>
  )
}

function RemoteOrigin({ host, name }: { host: string; name?: string }) {
  const streamer = useStore(s => s.streamer)
  return (
    <Row as="span" gap="xs" wrap lineGap="3xs" place="max-w-full min-w-0">
      <InstanceChip host={host} />
      {name && name !== host && (
        <span
          title={streamer ? 'The name this site gives itself' : `${host} calls itself ${name}`}
          className="streamer max-w-full min-w-0 truncate text-2xs text-on-surface-variant"
        >
          {name}
        </span>
      )}
    </Row>
  )
}

function useRemoteInvite(invite: RemoteInvite, enabled: boolean) {
  const owner = useAccount()
  const { remoteConnection } = owner.invites
  const { origin, server, password } = invite
  const observer = useMemo(() => owner.invites.watch(origin), [owner, origin])
  const access = useSyncExternalStore(observer.subscribe, observer.snapshot, observer.snapshot)
  const key = `${owner.renderKey}:${origin}\n${server}\n${password ?? ''}`
  const [loaded, setLoaded] = useState<{
    key: string
    access: InviteAccess
    data: Invite | null
    error: unknown
    connection: InstanceConnection | null
  } | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!enabled) return
    let live = true
    remoteConnection(origin).then(
      conn =>
        access.read(conn, server, password ?? null, 'metadata', tick > 0).then(
          data =>
            live &&
            access.current() &&
            setLoaded({ key, access, data, error: null, connection: conn }),
          (error: unknown) =>
            live &&
            access.current() &&
            setLoaded({ key, access, data: null, error, connection: conn })
        ),
      (error: unknown) =>
        live && access.current() && setLoaded({ key, access, data: null, error, connection: null })
    )
    return () => {
      live = false
    }
  }, [enabled, key, origin, server, password, tick, remoteConnection, access])
  const current = enabled && loaded?.key === key && loaded.access === access ? loaded : null
  return {
    access,
    ready: current !== null,
    instance: current?.connection?.info ?? null,
    connection: current?.connection,
    data: current?.data ?? null,
    error: current?.error ?? null,
    reload: () => setTick(t => t + 1),
  }
}

export function RemoteInviteCard({
  invite,
  onResolved,
}: {
  invite: RemoteInvite
  onResolved?: (key: string, ok: boolean) => void
}) {
  const previews = useStore(s => s.settings.asset_previews)
  const streamer = useStore(s => s.streamer)
  const key = remoteKey(invite)
  const owner = useAccount()
  const cache = owner.invites
  const [, refreshRequest] = useState(0)
  const wanted = previews && cache.previewRequested(key)
  const { access, ready, connection, instance, data, error, reload } = useRemoteInvite(
    invite,
    wanted
  )
  const root = useRef<HTMLDivElement>(null)
  const rchat = instance !== null
  useKeepBottom(root, ready)
  useEffect(() => {
    if (ready) onResolved?.(key, rchat)
  }, [ready, rchat, key, onResolved])
  if (!previews) return null
  const host = hostOf(invite.origin) ?? new URL(invite.origin).host
  const where = <RemoteOrigin host={host} name={instance?.name} />
  const load = () => {
    cache.requestPreview(key)
    refreshRequest(n => n + 1)
  }
  const internal = knownLinkOrigin(invite.origin) || rchat
  const path = invite.url.slice(invite.origin.length)
  const open = () =>
    internal
      ? void routeInstanceLink(owner, { origin: invite.origin, path })
      : openMessageLink(owner, remoteInviteUrl(invite), null, false)
  const openBtn = (
    <Button
      variant="filled"
      size="md"
      onClick={open}
      title={
        internal
          ? 'Open invite'
          : streamer
            ? 'Opens the invite in a new tab'
            : `Opens ${host} in a new tab`
      }
      place="max-w-full min-w-0"
    >
      <span className="min-w-0 truncate">
        Open on <Name of={instanceAddress(host)} />
      </span>
      {!internal && <ExternalLink size={14} className="shrink-0" />}
    </Button>
  )
  const hidden = needsPassword(error) || deniedAccess(error)
  const invalid = error instanceof ApiError && error.status === 404 && !hidden
  const heading = (
    <>
      Invite on <Name of={instanceAddress(host)} look="normal-case" />
    </>
  )
  const body = (): Body | null => {
    if (!wanted)
      return {
        icon: (
          <Tile big={false} tone="bg-surface-container-highest text-on-surface-variant">
            <Globe size={22} />
          </Tile>
        ),
        title: <span className="min-w-0 truncate">Server invite</span>,
        sub: (
          <p className="text-xs text-on-surface-variant">
            Loading the preview contacts <Name of={instanceAddress(host)} />.
          </p>
        ),
        actions: (
          <>
            {internal && openBtn}
            <Button
              variant="filled"
              size="md"
              onClick={load}
              title={
                streamer ? 'Fetch this invite from its site' : `Fetch this invite from ${host}`
              }
              place="shrink-0"
            >
              Load preview
            </Button>
          </>
        ),
      }
    if (!ready) return null
    if (hidden)
      return {
        icon: (
          <Tile big={false} tone="bg-primary-container text-on-primary-container">
            <Name of={serverCalled(serverInitial(invite.server))} />
          </Tile>
        ),
        title: <Name of={serverCalled(invite.server)} look="min-w-0 truncate" />,
        sub: (
          <Stack gap="2xs" align="start">
            {where}
            <p className="text-xs text-on-surface-variant">
              Enter the password to view this invite
            </p>
          </Stack>
        ),
        actions: openBtn,
      }
    if (invalid || (error !== null && !data))
      return {
        icon: (
          <Tile big={false} tone="bg-surface-container-highest text-on-surface-variant">
            <Link2Off size={22} />
          </Tile>
        ),
        title: invalid ? 'Invalid invite' : "Couldn't load this invite",
        sub: (
          <Stack gap="2xs" align="start">
            {where}
            <p className="text-xs text-on-surface-variant">
              {invalid
                ? 'This invite may have expired, or the server no longer exists.'
                : rchat
                  ? errorText(error)
                  : error instanceof InstanceError
                    ? hostParts(errorText(error), host).map((p, i) =>
                        p.host ? (
                          <span key={i} className="streamer">
                            {p.text}
                          </span>
                        ) : (
                          p.text
                        )
                      )
                    : 'This link is not an RChat invite, or that site could not be reached.'}
            </p>
          </Stack>
        ),
        actions:
          invalid || !rchat ? (
            openBtn
          ) : (
            <Button onClick={reload} place="shrink-0">
              Retry
            </Button>
          ),
      }
    if (!data) return null
    const { name, display_name, has_password } = data.server
    return {
      icon: (
        <span title={streamer ? 'Server icon' : `${display_name} on ${host}`}>
          <ServerTile name={name} displayName={display_name} big={false} look={data.server} />
        </span>
      ),
      title: (
        <>
          <Name of={serverCalled(display_name)} look="min-w-0 truncate" />
          {has_password && (
            <span title="Password protected" className="shrink-0 text-on-surface-variant">
              <Lock size={13} />
            </span>
          )}
        </>
      ),
      sub: (
        <Stack gap="2xs" align="start">
          {where}
          <AboutLine text={aboutText(data.server.description)} />
          <Counts invite={data} center={false} />
        </Stack>
      ),
      actions: openBtn,
      extra: (
        <Preview
          invite={data}
          big={false}
          host={host}
          password={invite.password ?? null}
          remote={connection ?? undefined}
          access={access}
        />
      ),
    }
  }
  const view = body()
  return (
    <Frame ref={root} big={false} invalid={invalid} heading={heading}>
      {view ? (
        <Layout big={false} invalid={invalid} stack={wanted} {...view} />
      ) : (
        <Skeleton big={false} />
      )}
    </Frame>
  )
}

export function InvitePage() {
  const invite = useStore(s => s.invite)
  const closeInvite = useStore(s => s.closeInvite)
  if (!invite) return null
  return (
    <LinkPage closeTitle="Close invite" onClose={closeInvite}>
      <InviteCard
        key={`${invite.server}\n${invite.password ?? ''}\n${invite.code ?? ''}`}
        variant="page"
        server={invite.server}
        password={invite.password}
        code={invite.code ?? null}
        autoJoin={invite.join}
      />
    </LinkPage>
  )
}

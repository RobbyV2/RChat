'use client'

import {
  useCallback,
  useEffect,
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
import { ExternalLink, Globe, Hash, Link2Off, Lock, Paperclip, X } from 'lucide-react'
import { ApiError } from '../lib/api'
import { InstanceError, api } from '../lib/instances'
import { errorText, useStore, type Nav } from '../lib/store'
import {
  hostParts,
  invitePath,
  inviteVersion,
  previewText,
  remoteInviteUrl,
  keepsPreview,
  refreshDelay,
  remoteKey,
  stashInvite,
  watchInvites,
  type RemoteInvite,
} from '../lib/invite'
import { formatQualified, hostOf } from '../lib/qualified'
import {
  previewRequested,
  remoteConnection,
  remoteInvite,
  requestPreview,
} from '../lib/remote_invite'
import { serverInitial } from '../lib/rules'
import type { InstanceInfo, Invite, InviteStatus, Message } from '../lib/types'
import { ServerGlyph } from './server_rail'
import { Dialog, FieldError, fieldCls, filledBtn, textBtn } from './server_settings'
import { ThemeToggle } from './status_clock'
import { InstanceChip } from './instance_badge'
import { UserAvatar } from './user_avatar'
import { profileTrigger } from './profile_card'

export type InviteVariant = 'embed' | 'page'

const TTL = 30_000
const FRESH = 1_000
const CACHE_MAX = 100
const cache = new Map<string, { at: number; promise: Promise<Invite> }>()

const fetchInvite = (key: string, server: string, password: string | null, maxAge: number) => {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < maxAge) return hit.promise
  const promise = api.getInvite(server, password)
  cache.delete(key)
  cache.set(key, { at: Date.now(), promise })
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
    const now = Date.now()
    stale.current = { since: stale.current?.since ?? now, bump: now }
  }, [version])
  useEffect(() => {
    const due = stale.current
    if (version === settled) stale.current = null
    if (version === settled || !visible || !due) return
    const timer = setTimeout(
      () => {
        stale.current = null
        fetchedAt.current = Date.now()
        setSettled(version)
      },
      refreshDelay(due.since, due.bump, fetchedAt.current, Date.now())
    )
    return () => clearTimeout(timer)
  }, [version, settled, visible])
  return settled
}

const transient = (error: unknown) => keepsPreview(error instanceof ApiError ? error.status : null)

function useInvite(
  server: string,
  password: string | null,
  root: RefObject<HTMLElement | null>,
  always: boolean
) {
  const viewer = useStore(s => s.me?.username ?? '')
  const key = `${viewer}\n${server}\n${password ?? ''}`
  const bumped = useSyncExternalStore(
    watchInvites,
    () => inviteVersion(server),
    () => 0
  )
  const visible = useVisible(root, always)
  const version = useSettledVersion(bumped, visible)
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [tick, setTick] = useState(0)
  const maxAge = useRef(TTL)
  useEffect(() => {
    let live = true
    fetchInvite(`${key}\n${version}`, server, password, maxAge.current).then(
      data => {
        if (live) setLoaded({ key, data, error: null })
      },
      (error: unknown) => {
        if (!live) return
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
  }, [key, server, password, tick, version])
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
}: {
  name: string
  initialError: string | null
  onSubmit: (password: string) => Promise<string | null>
  onClose: () => void
}) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState(initialError)
  const [busy, setBusy] = useState(false)
  return createPortal(
    <div {...isolate}>
      <Dialog title="Server password" onClose={onClose}>
        <form
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
            <span className="streamer font-medium text-on-surface">{name}</span> is password
            protected. Enter its password to join.
          </p>
          <input
            autoFocus
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="Server password"
            aria-invalid={error !== null}
            className={`${fieldCls} mt-4 w-full`}
          />
          <FieldError message={error} />
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" onClick={onClose} className={textBtn}>
              Cancel
            </button>
            <button disabled={busy || !password.trim()} className={filledBtn}>
              {busy ? 'Joining…' : 'Join'}
            </button>
          </div>
        </form>
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
}: {
  name: string
  displayName: string
  big: boolean
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
      <ServerGlyph name={name} displayName={displayName} />
    </Tile>
  )
}

function Counts({ invite, center }: { invite: Invite; center: boolean }) {
  const { online_count, member_count } = invite
  if (online_count === null || member_count === null)
    return invite.status === 'password_required' ? (
      <p className="text-xs text-on-surface-variant">Enter the password to see who&apos;s here.</p>
    ) : null
  return (
    <div
      className={`flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-on-surface-variant ${
        center ? 'justify-center' : ''
      }`}
    >
      <span className="flex items-center gap-1.5">
        <span className="size-2 rounded-full bg-status-green" />
        {online_count} Online
      </span>
      <span className="flex items-center gap-1.5">
        <span className="size-2 rounded-full bg-outline" />
        {member_count} {member_count === 1 ? 'Member' : 'Members'}
      </span>
    </div>
  )
}

function PreviewLine({ message, big, host }: { message: Message; big: boolean; host?: string }) {
  const streamer = useStore(s => s.streamer)
  const { author, content, media } = message
  const text = previewText(content)
  return (
    <div className="flex min-w-0 items-start gap-2">
      <UserAvatar
        username={author.username}
        avatarKind={author.avatar_kind}
        avatarColor={author.avatar_color}
        size={big ? 24 : 18}
      />
      <p
        className={`min-w-0 flex-1 text-left break-words ${
          big ? 'line-clamp-2 text-sm' : 'truncate text-xs leading-[18px]'
        }`}
      >
        <span
          {...(host ? {} : profileTrigger(author, null))}
          title={host && !streamer ? formatQualified(author.username, host) : undefined}
          className={`streamer font-medium text-on-surface ${host ? '' : 'cursor-pointer hover:underline'}`}
        >
          {author.display_name}
        </span>{' '}
        <span className="text-on-surface-variant">
          {text}
          {media !== null && (
            <span className="ml-1 inline-flex items-center gap-0.5 align-middle">
              <Paperclip size={big ? 13 : 11} />
              {media.spoiler ? 'Spoiler' : media.filename}
            </span>
          )}
        </span>
      </p>
    </div>
  )
}

function Preview({ invite, big, host }: { invite: Invite; big: boolean; host?: string }) {
  const { preview_channel, preview } = invite
  if (preview_channel === null || (preview.length === 0 && !big)) return null
  return (
    <div
      className={`rounded-xl bg-surface-container-high ${big ? 'mt-5 p-3' : 'mt-3 px-2.5 py-2'}`}
    >
      <p className="flex min-w-0 items-center gap-1 text-xs font-medium text-on-surface-variant">
        <Hash size={12} className="shrink-0" />
        <span className="truncate">{preview_channel}</span>
      </p>
      {preview.length ? (
        <div className={`flex flex-col ${big ? 'mt-2 gap-2' : 'mt-1.5 gap-1'}`}>
          {preview.map(m => (
            <PreviewLine key={m.id} message={m} big={big} host={host} />
          ))}
        </div>
      ) : (
        <p className="mt-1.5 text-left text-xs text-on-surface-variant">No messages yet</p>
      )}
    </div>
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
  return (
    <div
      ref={ref}
      className={
        big
          ? 'w-full max-w-md rounded-[28px] bg-surface-container-low p-6 text-center shadow-elevation-3 sm:p-8'
          : '@container mt-1.5 w-full max-w-md rounded-2xl border border-outline-variant bg-surface-container p-3 sm:p-4'
      }
    >
      {!big && (
        <p className="mb-2 text-[11px] font-semibold tracking-wide text-on-surface-variant uppercase">
          {heading ??
            (invalid ? "You've received an invite, but…" : "You've been invited to join a server")}
        </p>
      )}
      {children}
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
      <>
        <div className="flex justify-center">{icon}</div>
        {!invalid && (
          <p className="mt-5 text-sm text-on-surface-variant">You&apos;ve been invited to join</p>
        )}
        <h1
          className={`flex min-w-0 items-center justify-center gap-2 text-2xl font-semibold ${invalid ? 'mt-5' : 'mt-1'}`}
        >
          {title}
        </h1>
        <div className="mt-2">{sub}</div>
        {extra}
        {actions && <div className="mt-6 flex flex-col gap-2">{actions}</div>}
      </>
    )
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        {icon}
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 items-center gap-1.5 font-semibold">{title}</p>
          <div className="mt-0.5">{sub}</div>
        </div>
        {actions && (
          <div
            className={`flex w-full flex-wrap gap-1.5 ${stack ? '' : '@sm:w-auto @sm:shrink-0 @sm:flex-col @sm:items-end'}`}
          >
            {actions}
          </div>
        )}
      </div>
      {extra}
    </>
  )
}

function Skeleton({ big }: { big: boolean }) {
  return (
    <div
      aria-busy
      aria-label="Loading invite"
      className={`flex animate-pulse items-center gap-3 ${big ? 'flex-col' : ''}`}
    >
      <span
        className={`shrink-0 bg-surface-container-highest ${big ? 'size-20 rounded-3xl' : 'size-12 rounded-2xl'}`}
      />
      <div className={`flex flex-col gap-2 ${big ? 'mt-3 w-full items-center' : 'flex-1'}`}>
        <span className="h-4 w-36 max-w-full rounded-full bg-surface-container-highest" />
        <span className="h-3 w-24 rounded-full bg-surface-container-highest" />
      </div>
      <span
        className={`rounded-full bg-surface-container-highest ${big ? 'mt-4 h-10 w-full' : 'h-9 w-16 shrink-0'}`}
      />
    </div>
  )
}

type Outcome = { ok: true } | { ok: false; password: boolean; banned: boolean; message: string }

export function InviteCard({
  server,
  password,
  variant,
  autoJoin = false,
}: {
  server: string
  password: string | null
  variant: InviteVariant
  autoJoin?: boolean
}) {
  const router = useRouter()
  const me = useStore(s => s.me)
  const guest = useStore(s => s.guest)
  const hasGrant = useStore(s => s.guestGrants[server] !== undefined)
  const guestsEnabled = useStore(s => s.settings.guests_enabled)
  const consume = useStore(s => s.consumeInviteJoin)
  const joined = useStore(s =>
    s.me ? s.me.servers.some(x => x.name === server) : s.guest && s.guestServers.includes(server)
  )
  const root = useRef<HTMLDivElement>(null)
  const big = variant === 'page'
  const { data, error, reload } = useInvite(server, password, root, big)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [asking, setAsking] = useState<{ guest: boolean; error: string | null } | null>(null)
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
    const given = has_password && !(asGuest && hasGrant) ? (pw ?? undefined) : undefined
    setBusy(true)
    setNote(null)
    try {
      const s = useStore.getState()
      if (asGuest) await s.guestJoinServer(name, given, nav)
      else await s.joinServer(name, given, nav)
      return { ok: true }
    } catch (e) {
      const code = e instanceof ApiError ? e.status : 0
      const retry = code === 401 || (asGuest && code === 403)
      const banned = !asGuest && code === 403
      const message = retry && code === 403 ? 'Enter the server password' : errorText(e)
      return { ok: false, password: retry, banned, message }
    } finally {
      setBusy(false)
      reload()
    }
  }

  const join = async (asGuest: boolean) => {
    consume()
    if (status === 'password_required') {
      setAsking({ guest: asGuest, error: null })
      return
    }
    const out = await attempt(password, asGuest)
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
    if (data) void useStore.getState().openServer(data.server.name, undefined, nav)
  }

  const logIn = () => {
    consume()
    stashInvite({ server, password })
    router.push(`/login/?next=${encodeURIComponent(invitePath(server))}`)
  }

  const continueAsGuest = async () => {
    consume()
    await useStore.getState().enterGuest()
    await join(true)
  }

  useEffect(() => {
    if (!autoJoin || !authed || !status || busy) return
    if (status === 'member') go()
    else if (status === 'banned') consume()
    else void join(guest)
  })

  const btn = big ? 'w-full py-2.5' : 'shrink-0'
  const fit = big ? 'break-words' : 'truncate'
  const errorCode = error instanceof ApiError ? error.status : null
  const invalid = errorCode === 404
  const locked = !authed && errorCode === 401

  const body = (): Body | null => {
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
          <button
            onClick={() => (authed ? useStore.getState().closeInvite() : router.push('/login'))}
            className={`${filledBtn} ${btn}`}
          >
            {authed ? 'Continue to RChat' : 'Log in'}
          </button>
        ),
      }
    if (locked)
      return {
        icon: (
          <Tile big={big} tone="bg-primary-container text-on-primary-container">
            <span className="streamer">{serverInitial(server)}</span>
          </Tile>
        ),
        title: <span className={`streamer min-w-0 ${fit}`}>{server}</span>,
        sub: <p className="text-xs text-on-surface-variant">Log in to see who&apos;s here.</p>,
        actions: (
          <button onClick={logIn} className={`${filledBtn} ${btn}`}>
            Log in to join
          </button>
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
          <button onClick={reload} className={`${textBtn} ${btn}`}>
            Retry
          </button>
        ),
      }
    if (!data || !status) return null
    const { name, display_name, has_password } = data.server
    return {
      icon: <ServerTile name={name} displayName={display_name} big={big} />,
      title: (
        <>
          <span className={`streamer min-w-0 ${fit}`}>{display_name}</span>
          {has_password && status !== 'member' && (
            <span title="Password protected" className="shrink-0 text-on-surface-variant">
              <Lock size={big ? 18 : 13} />
            </span>
          )}
        </>
      ),
      sub: <Counts invite={data} center={big} />,
      actions: !authed ? (
        <>
          <button onClick={logIn} className={`${filledBtn} ${btn}`}>
            Log in to join
          </button>
          {guestsEnabled && (
            <button onClick={() => void continueAsGuest()} className={`${textBtn} ${btn}`}>
              Continue as guest
            </button>
          )}
        </>
      ) : status === 'member' ? (
        <button
          onClick={go}
          title="You're already a member"
          className={`rounded-full bg-secondary-container px-4 py-2 text-sm font-medium text-on-secondary-container hover:opacity-90 ${btn}`}
        >
          Go to server
        </button>
      ) : status === 'banned' ? (
        <button
          disabled
          title="You are banned from this server"
          className={`rounded-full bg-on-surface/10 px-4 py-2 text-sm font-medium text-on-surface/50 ${btn}`}
        >
          Banned
        </button>
      ) : (
        <button disabled={busy} onClick={() => void join(guest)} className={`${filledBtn} ${btn}`}>
          {busy ? 'Joining…' : 'Join'}
        </button>
      ),
      extra: (
        <>
          {status === 'banned' && (
            <p role="status" className="mt-3 text-sm text-error">
              You are banned from this server
            </p>
          )}
          {status === 'password_required' && big && (
            <p className="mt-3 text-xs text-on-surface-variant">
              This server is password protected.
            </p>
          )}
          {note && (
            <p role="alert" className="mt-3 text-xs text-error">
              {note}
            </p>
          )}
          <Preview invite={data} big={big} />
        </>
      ),
    }
  }

  const view = body()
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
    </>
  )
}

function RemoteOrigin({ host, name }: { host: string; name?: string }) {
  const streamer = useStore(s => s.streamer)
  return (
    <span className="flex max-w-full min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
      <InstanceChip host={host} />
      {name && name !== host && (
        <span
          title={streamer ? 'The name this site gives itself' : `${host} calls itself ${name}`}
          className="streamer max-w-full min-w-0 truncate text-[11px] text-on-surface-variant"
        >
          {name}
        </span>
      )}
    </span>
  )
}

function useRemoteInvite(invite: RemoteInvite, enabled: boolean) {
  const { origin, server, password } = invite
  const key = `${origin}\n${server}\n${password ?? ''}`
  const [loaded, setLoaded] = useState<{
    key: string
    data: Invite | null
    error: unknown
    instance: InstanceInfo | null
  } | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!enabled) return
    let live = true
    remoteConnection(origin).then(
      conn =>
        remoteInvite(origin, server, password, tick > 0).then(
          data => live && setLoaded({ key, data, error: null, instance: conn.info }),
          (error: unknown) => live && setLoaded({ key, data: null, error, instance: conn.info })
        ),
      (error: unknown) => live && setLoaded({ key, data: null, error, instance: null })
    )
    return () => {
      live = false
    }
  }, [enabled, key, origin, server, password, tick])
  const current = enabled && loaded?.key === key ? loaded : null
  return {
    ready: current !== null,
    instance: current?.instance ?? null,
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
  const [asked, setAsked] = useState(() => previewRequested(key))
  const wanted = previews && (asked || previewRequested(key))
  const { ready, instance, data, error, reload } = useRemoteInvite(invite, wanted)
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
    requestPreview(key)
    setAsked(true)
  }
  const open = () => window.open(remoteInviteUrl(invite), '_blank', 'noopener,noreferrer')
  const openBtn = (
    <button
      onClick={open}
      title={streamer ? 'Opens the invite in a new tab' : `Opens ${host} in a new tab`}
      className={`${filledBtn} inline-flex max-w-full min-w-0 items-center gap-1.5`}
    >
      <span className="min-w-0 truncate">
        Open on <span className="streamer">{host}</span>
      </span>
      <ExternalLink size={14} className="shrink-0" />
    </button>
  )
  const invalid = error instanceof ApiError && error.status === 404
  const heading = (
    <>
      Invite on <span className="streamer normal-case">{host}</span>
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
            Loading the preview contacts <span className="streamer">{host}</span>.
          </p>
        ),
        actions: (
          <button
            onClick={load}
            title={streamer ? 'Fetch this invite from its site' : `Fetch this invite from ${host}`}
            className={`${filledBtn} shrink-0`}
          >
            Load preview
          </button>
        ),
      }
    if (!ready) return null
    if (invalid || (error !== null && !data))
      return {
        icon: (
          <Tile big={false} tone="bg-surface-container-highest text-on-surface-variant">
            <Link2Off size={22} />
          </Tile>
        ),
        title: invalid ? 'Invalid invite' : "Couldn't load this invite",
        sub: (
          <div className="flex flex-col items-start gap-1">
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
          </div>
        ),
        actions:
          invalid || !rchat ? (
            openBtn
          ) : (
            <button onClick={reload} className={`${textBtn} shrink-0`}>
              Retry
            </button>
          ),
      }
    if (!data) return null
    const { name, display_name, has_password } = data.server
    return {
      icon: (
        <span title={streamer ? 'Server icon' : `${display_name} on ${host}`}>
          <ServerTile name={name} displayName={display_name} big={false} />
        </span>
      ),
      title: (
        <>
          <span className="streamer min-w-0 truncate">{display_name}</span>
          {has_password && (
            <span title="Password protected" className="shrink-0 text-on-surface-variant">
              <Lock size={13} />
            </span>
          )}
        </>
      ),
      sub: (
        <div className="flex flex-col items-start gap-1">
          {where}
          <Counts invite={data} center={false} />
        </div>
      ),
      actions: openBtn,
      extra: <Preview invite={data} big={false} host={host} />,
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
  const authed = useStore(s => s.me !== null || s.guest)
  const closeInvite = useStore(s => s.closeInvite)
  if (!invite) return null
  return (
    <div className="invite-backdrop fixed inset-x-0 top-0 z-40 flex h-app flex-col overflow-y-auto px-safe-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      <header className="flex shrink-0 items-center justify-between pt-[max(0.75rem,env(safe-area-inset-top))] pb-2">
        <img src="/rchat_logo.png" alt="RChat" className="h-9 w-auto" />
        <div className="flex items-center gap-1">
          <ThemeToggle />
          {authed && (
            <button
              title="Close invite"
              onClick={closeInvite}
              className="rounded-full p-2 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
            >
              <X size={20} />
            </button>
          )}
        </div>
      </header>
      <main className="my-auto flex w-full justify-center py-6">
        <InviteCard
          key={`${invite.server}\n${invite.password ?? ''}`}
          variant="page"
          server={invite.server}
          password={invite.password}
          autoJoin={invite.join}
        />
      </main>
    </div>
  )
}

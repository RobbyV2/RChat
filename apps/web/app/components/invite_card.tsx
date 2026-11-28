'use client'

import { asAccount } from '../lib/people'
import {
  handleName,
  instanceAddress,
  instanceName,
  labelWith,
  personName,
  serverCalled,
} from '../lib/names'
import { Name, useNameLabels } from './name'
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
import { background, statusOf } from '../lib/api_errors'
import type { InviteAccess } from '../lib/remote_invite'
import { accountPath } from '../lib/view'
import { knownLinkOrigin, routeInstanceLink, linkChoice } from '../lib/client/instance_links'
import { client } from '../lib/client/client'
import { routeOwnerFor } from '../lib/client/account_paths'
import { useAccount, useStoreApi } from '../lib/client/react'
import type { InstanceConnection } from '../lib/instances'
import { useForwardAccess } from '../lib/forward_access'
import { carriedTarget } from '../lib/forward_viewing'
import { errorText, useStore, type Nav } from '../lib/store'
import {
  autoStep,
  hostParts,
  previewParts,
  remoteInviteUrl,
  refreshDelay,
  remoteKey,
  sharedByCode,
  stashInvite,
  targetPath,
  inviteUrl,
  type RemoteInvite,
} from '../lib/invite'
import { channelTarget } from '../lib/viewing'
import { hostOf, normalizeHost } from '../lib/qualified'
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
import type { Load } from '../lib/load'
import {
  INVITE_FRESH,
  INVITE_TTL,
  afterRefusal,
  fetchInvite,
  fetchPreview,
  fetchRemoteInvite,
  tryInvitePassword,
  type InviteView,
  type PreviewAsk,
  type PreviewChange,
  type RemoteView,
} from '../lib/invite_load'
import { Loaded, useAccountWork, useRequest } from './loaded'
import { ErrorNotice } from './notices'
import { FUNCTIONAL } from '../lib/motion/functional'

type InviteVariant = 'embed' | 'page'

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

// The invite as a load, asked again when the instance says it changed (while the card is on
// screen) and by `reload`.
function useInviteLoad(
  server: string,
  password: string | null,
  code: string | null,
  root: RefObject<HTMLElement | null>,
  always: boolean
): [Load<InviteView>, () => void] {
  const owner = useAccount()
  const { watchInvites, inviteVersion } = owner.inviteUpdates
  const viewer = useStore(s => s.me?.username ?? '')
  const epoch = useStore(s => s.channelLabelEpoch)
  const scope = `${owner.renderKey}\n${owner.conn.origin}\n${epoch}\n${viewer}`
  const key = code ? `${scope}\n\n\n${code}` : `${scope}\n${server}\n${password ?? ''}`
  const [named, setNamed] = useState('')
  const watched = code ? named : server
  const bumped = useSyncExternalStore(
    watchInvites,
    () => inviteVersion(watched),
    () => 0
  )
  const visible = useVisible(root, always)
  const version = useSettledVersion(bumped, visible)
  const asked = useRef({ version, maxAge: INVITE_TTL })
  const shown = useRef<{ key: string; view: InviteView } | null>(null)
  const last = useRef<{ source: unknown; version: number } | null>(null)
  useEffect(() => {
    asked.current.version = version
  }, [version])
  const [load, source] = useAccountWork<InviteView>(() => {
    const maxAge = asked.current.maxAge
    asked.current.maxAge = INVITE_TTL
    return fetchInvite(
      owner,
      { key: `${key}\n${asked.current.version}`, server, password, code },
      maxAge
    )
      .then(
        (invite): InviteView => {
          if (code) setNamed(invite.server.name)
          return { kind: 'here', invite }
        },
        (error: unknown) =>
          afterRefusal(shown.current?.key === key ? shown.current.view : null, error, !!code)
      )
      .then(view => {
        shown.current = { key, view }
        return view
      })
  }, [key])
  useEffect(() => {
    const before = last.current
    last.current = { source, version }
    if (before && before.source === source && before.version !== version) source.refresh()
  }, [source, version])
  const reload = useCallback(() => {
    asked.current.maxAge = INVITE_FRESH
    source.refresh()
  }, [source])
  return [load, reload]
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
    <Row gap="md" lineGap="3xs" wrap justify={center ? 'center' : 'start'} text="xs" ink="muted">
      <Row as="span" gap="xs">
        <span className="size-2 rounded-full bg-status-green" />
        {online_count} Online
      </Row>
      <Row as="span" gap="xs">
        <span className="size-2 rounded-full bg-outline" />
        {member_count} {member_count === 1 ? 'Member' : 'Members'}
      </Row>
    </Row>
  )
}

function TicketNote({ invite, now, center }: { invite: Invite; now: number; center: boolean }) {
  const { password_expires_at: ends, password_uses_left: left } = invite
  if (ends === null && left === null) return null
  return (
    <Row
      as="p"
      gap="sm"
      wrap
      align="stretch"
      justify={center ? 'center' : 'start'}
      text="xs"
      ink="muted"
    >
      {ends !== null && <span title={absoluteTime(ends)}>{countdown(ends, now)}</span>}
      {ends !== null && left !== null && <span aria-hidden>·</span>}
      {left !== null && <span>{usesLeftText(left)}</span>}
    </Row>
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
  const say = useNameLabels()
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
          titled={
            host
              ? labelWith`${say(handleName(author.username))}@${say(instanceAddress(normalizeHost(host)))}`
              : false
          }
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
            <Row as="span" gap="3xs" look="align-middle" place="inline-flex">
              <Paperclip size={big ? 13 : 11} />
              <PreviewFilename
                key={media.id}
                name={media.filename}
                own={own && !message.forward}
                spoiler={media.spoiler}
              />
            </Row>
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
  useEffect(() => {
    if (!remote && local === null)
      void owner.store
        .getState()
        .discoverChannels(server)
        .catch(background('invite preview channels'))
  }, [owner, remote, local, server])
  if (!target || !conn || !preview_channel) return null
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
  return (
    <PreviewMessages
      ask={{ conn, server, password, id, label: label === true, access }}
      of={target.key}
      channel={preview_channel}
      big={big}
      host={host}
      remote={remote}
      onChanged={changed => setSeen({ of: invite, ...changed })}
    />
  )
}

function PreviewMessages({
  ask,
  of,
  channel,
  big,
  host,
  remote,
  onChanged,
}: {
  ask: PreviewAsk
  of: string
  channel: string
  big: boolean
  host?: string
  remote?: InstanceConnection
  onChanged: (to: PreviewChange) => void
}) {
  const { conn, server, password, id, label, access } = ask
  const load = useRequest(
    () => fetchPreview(ask, onChanged),
    [conn, server, password, id, label, access, of]
  )
  return (
    <Loaded load={load} skeleton={null} what="the channel preview">
      {preview =>
        preview.length === 0 && !big ? null : (
          <Surface tone="high" radius="lg" pad={big ? 'md' : 'sm'} gap={big ? 'sm' : 'xs'}>
            <p className="min-w-0 text-xs font-medium text-on-surface-variant">
              <Row as="span" gap="2xs">
                <Hash size={12} className="shrink-0" />
                <span className="truncate">{channel}</span>
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
    </Loaded>
  )
}

interface Body {
  icon: ReactNode
  title: ReactNode
  sub: ReactNode
  actions: ReactNode
  extra?: ReactNode
}

const INVITED = "You've been invited to join a server"

function Heading({ children }: { children: ReactNode }) {
  return (
    <p className="text-2xs font-semibold tracking-wide text-on-surface-variant uppercase">
      {children}
    </p>
  )
}

function Frame({
  big,
  ref,
  children,
}: {
  big: boolean
  ref: Ref<HTMLDivElement>
  children: ReactNode
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
    <div ref={ref} className="@container msg-part w-full max-w-md">
      <Surface tone="base" border pad="md" gap="sm">
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
          <Row
            gap="xs"
            wrap
            align="stretch"
            look={stack ? '' : '@sm:w-auto @sm:shrink-0'}
            place="w-full"
          >
            {actions}
          </Row>
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
    <div aria-busy aria-label="Loading invite" className={FUNCTIONAL.pulse}>
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
  const root = useRef<HTMLDivElement>(null)
  const big = variant === 'page'
  const [unlocked, setUnlocked] = useState<string | null>(null)
  const given = code ?? unlocked ?? password
  const [load, reload] = useInviteLoad(named, given, code, root, big)
  useKeepBottom(root, !big)
  return (
    <Frame ref={root} big={big}>
      <Loaded
        load={load}
        what="this invite"
        hold={false}
        skeleton={
          <>
            {!big && <Heading>{INVITED}</Heading>}
            <Skeleton big={big} />
          </>
        }
      >
        {view => (
          <InviteBody
            view={view}
            named={named}
            password={password}
            given={given}
            code={code}
            big={big}
            autoJoin={autoJoin}
            reload={reload}
            onUnlocked={setUnlocked}
          />
        )}
      </Loaded>
    </Frame>
  )
}

// The card of an invite that answered, in every state the answer can be.
export function InviteBody({
  view: answer,
  named,
  password,
  given,
  code,
  big,
  autoJoin,
  reload,
  onUnlocked,
}: {
  view: InviteView
  named: string
  password: string | null
  given: string | null
  code: string | null
  big: boolean
  autoJoin: boolean
  reload: () => void
  onUnlocked: (password: string) => void
}) {
  const router = useRouter()
  const owner = useAccount()
  const mark = owner.lifetime.sessionMark()
  const data = answer.kind === 'here' ? answer.invite : null
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
      const banned = !asGuest && statusOf(e) === 403
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
    const refused = await tryInvitePassword(owner, server, pw)
    if (refused !== null) return refused
    setUnlocking(false)
    onUnlocked(pw)
    return null
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
  const ticketEnds = data?.password_expires_at ?? null
  const now = useNow(
    ticketEnds === null ? 60_000 : tickMs(ticketEnds - Math.floor(time().now() / 1000))
  )
  const ticketGone = ticketEnds !== null && ticketEnds <= now
  const hidden = !code && (answer.kind === 'hidden' || ticketGone)
  const invalid = (answer.kind === 'gone' || (code !== null && ticketGone)) && !hidden
  const locked = !authed && answer.kind === 'locked' && !hidden
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
        extra: answer.kind === 'hidden' && answer.denied !== null && given && (
          <p role="alert" className="text-xs text-error">
            {answer.denied}
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
          <AboutLine text={aboutText(data.server.description)} center={big} />
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

  if (answer.kind === 'locked' && !locked && !hidden)
    return (
      <>
        {!big && <Heading>{INVITED}</Heading>}
        <ErrorNotice refusal={answer.refusal} lead="Could not load this invite." retry={reload} />
      </>
    )
  const view = body()
  if (!view) return null
  if (!big && !invalid) {
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
      {!big && <Heading>{invalid ? "You've received an invite, but…" : INVITED}</Heading>}
      <Layout big={big} invalid={invalid} {...view} />
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
  const say = useNameLabels()
  return (
    <Row as="span" gap="xs" wrap lineGap="3xs" place="max-w-full min-w-0">
      <InstanceChip host={host} />
      {name && name !== host && (
        <Name
          of={instanceName(name)}
          titled={labelWith`${say(instanceAddress(host))} calls itself ${say(instanceName(name))}`}
          place="max-w-full min-w-0"
          look="truncate text-2xs text-on-surface-variant"
        />
      )}
    </Row>
  )
}

const remoteHost = (invite: RemoteInvite) => hostOf(invite.origin) ?? new URL(invite.origin).host

// The way to the invite on its own site: inside the app for one of these sites, else a new tab.
function OpenRemote({ invite, site }: { invite: RemoteInvite; site: boolean }) {
  const owner = useAccount()
  const say = useNameLabels()
  const host = remoteHost(invite)
  const internal = knownLinkOrigin(invite.origin) || site
  const path = invite.url.slice(invite.origin.length)
  const open = () =>
    internal
      ? void routeInstanceLink(owner, { origin: invite.origin, path })
      : openMessageLink(owner, remoteInviteUrl(invite), null, false)
  return (
    <Button
      variant="filled"
      size="md"
      onClick={open}
      title={
        internal
          ? 'Open invite'
          : say.line(
              'Opens the invite in a new tab',
              () => labelWith`Opens ${say(instanceAddress(host))} in a new tab`
            )
      }
      place="max-w-full min-w-0"
    >
      <span className="min-w-0 truncate">
        Open on <Name of={instanceAddress(host)} />
      </span>
      {!internal && <ExternalLink size={14} className="shrink-0" />}
    </Button>
  )
}

const brokenTile = (
  <Tile big={false} tone="bg-surface-container-highest text-on-surface-variant">
    <Link2Off size={22} />
  </Tile>
)

// The card of an invite on another site, once that site answered or turned out not to be one.
export function RemoteBody({
  view,
  invite,
  access,
}: {
  view: RemoteView
  invite: RemoteInvite
  access?: InviteAccess
}) {
  const say = useNameLabels()
  const host = remoteHost(invite)
  const openBtn = <OpenRemote invite={invite} site={view.kind !== 'foreign'} />
  const where = (
    <RemoteOrigin host={host} name={view.kind === 'foreign' ? undefined : view.info?.name} />
  )
  const body = (): Body => {
    if (view.kind === 'hidden')
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
    if (view.kind === 'gone')
      return {
        icon: brokenTile,
        title: 'Invalid invite',
        sub: (
          <Stack gap="2xs" align="start">
            {where}
            <p className="text-xs text-on-surface-variant">
              This invite may have expired, or the server no longer exists.
            </p>
          </Stack>
        ),
        actions: openBtn,
      }
    if (view.kind === 'foreign')
      return {
        icon: brokenTile,
        title: "Couldn't load this invite",
        sub: (
          <Stack gap="2xs" align="start">
            {where}
            <p className="text-xs text-on-surface-variant">
              {view.line === null
                ? 'This link is not an RChat invite, or that site could not be reached.'
                : hostParts(view.line, host).map((p, i) =>
                    p.host ? <Name key={i} of={instanceAddress(p.text)} /> : p.text
                  )}
            </p>
          </Stack>
        ),
        actions: openBtn,
      }
    const { name, display_name, has_password } = view.invite.server
    return {
      icon: (
        <span
          title={say.line(
            'Server icon',
            () => labelWith`${say(serverCalled(display_name))} on ${say(instanceAddress(host))}`
          )}
        >
          <ServerTile
            name={name}
            displayName={display_name}
            big={false}
            look={view.invite.server}
          />
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
          <AboutLine text={aboutText(view.invite.server.description)} />
          <Counts invite={view.invite} center={false} />
        </Stack>
      ),
      actions: openBtn,
      extra: (
        <Preview
          invite={view.invite}
          big={false}
          host={host}
          password={invite.password ?? null}
          remote={view.conn}
          access={access}
        />
      ),
    }
  }
  return <Layout big={false} invalid={view.kind === 'gone'} stack {...body()} />
}

function RemoteLoaded({
  invite,
  onResolved,
}: {
  invite: RemoteInvite
  onResolved?: (key: string, ok: boolean) => void
}) {
  const owner = useAccount()
  const { origin, server, password } = invite
  const key = remoteKey(invite)
  const observer = useMemo(() => owner.invites.watch(origin), [owner, origin])
  const access = useSyncExternalStore(observer.subscribe, observer.snapshot, observer.snapshot)
  const run = useMemo(() => {
    let again = false
    return (signal: AbortSignal) => {
      const fresh = again
      again = true
      return fetchRemoteInvite(
        owner,
        { origin, server, password: password ?? null, access },
        fresh,
        site => {
          if (!signal.aborted) onResolved?.(key, site)
        }
      )
    }
  }, [owner, origin, server, password, access, key, onResolved])
  const load = useRequest(run, [run])
  return (
    <Loaded load={load} what="this invite" hold={false} skeleton={<Skeleton big={false} />}>
      {view => <RemoteBody view={view} invite={invite} access={access} />}
    </Loaded>
  )
}

export function RemoteInviteCard({
  invite,
  onResolved,
}: {
  invite: RemoteInvite
  onResolved?: (key: string, ok: boolean) => void
}) {
  const previews = useStore(s => s.settings.asset_previews)
  const say = useNameLabels()
  const key = remoteKey(invite)
  const owner = useAccount()
  const cache = owner.invites
  const [, refreshRequest] = useState(0)
  const wanted = previews && cache.previewRequested(key)
  const root = useRef<HTMLDivElement>(null)
  useKeepBottom(root, wanted)
  if (!previews) return null
  const host = remoteHost(invite)
  const load = () => {
    cache.requestPreview(key)
    refreshRequest(n => n + 1)
  }
  return (
    <Frame ref={root} big={false}>
      <Heading>
        Invite on <Name of={instanceAddress(host)} look="normal-case" />
      </Heading>
      {wanted ? (
        <RemoteLoaded invite={invite} onResolved={onResolved} />
      ) : (
        <Layout
          big={false}
          invalid={false}
          icon={
            <Tile big={false} tone="bg-surface-container-highest text-on-surface-variant">
              <Globe size={22} />
            </Tile>
          }
          title={<span className="min-w-0 truncate">Server invite</span>}
          sub={
            <p className="text-xs text-on-surface-variant">
              Loading the preview contacts <Name of={instanceAddress(host)} />.
            </p>
          }
          actions={
            <>
              {knownLinkOrigin(invite.origin) && <OpenRemote invite={invite} site={false} />}
              <Button
                variant="filled"
                size="md"
                onClick={load}
                title={say.line(
                  'Fetch this invite from its site',
                  () => labelWith`Fetch this invite from ${say(instanceAddress(host))}`
                )}
                place="shrink-0"
              >
                Load preview
              </Button>
            </>
          }
        />
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

'use client'
import { personCalled } from '../lib/names'
import { Name } from './name'

import { ActorLabel, useActorSuffix, useViewActor } from './view_actor'
import { useAccount, useStoreApi } from '../lib/client/react'
import { askKick, openBan, openTimeout } from '../lib/place/moderation'
import { HostedServer } from '../lib/place/place'

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from 'react'
import {
  ArrowRightLeft,
  Ban,
  Check,
  Copy,
  Eraser,
  Gavel,
  LockOpen,
  Pencil,
  Plus,
  ShieldMinus,
  ShieldPlus,
  Timer,
  TimerOff,
  UserCheck,
  UserMinus,
  UserX,
  X,
  type LucideIcon,
} from 'lucide-react'
import { missing } from '../lib/api_errors'
import { Refreshed, useAccountRequest } from './loaded'
import { formatQualified, isHomeHost } from '../lib/qualified'
import { InstanceChip } from './instance_badge'
import {
  memberState,
  myPerms,
  myRank,
  myRolePerms,
  type ProfileTarget,
  useMask,
  mayEditProfile,
  profilesShown,
  useStore,
} from '../lib/store'
import {
  HIDDEN_PROFILE,
  SHEET_QUERY,
  cachedProfile,
  canEditRoles,
  forgetProfile,
  freeRoles,
  heldRoles,
  joinedServer,
  placeCard,
  profileActions,
  profileKey,
  rememberProfile,
  roleEditable,
  serverJoinLine,
  type ActionInput,
  type Point,
  type ProfileAction,
} from '../lib/profile'
import { lockState } from '../lib/profile_reset'
import { memberPerms, rolePerms } from '../lib/rules'
import { shownBanner, shownBio, shownUser } from '../lib/server_profile'
import { memberRank } from '../lib/hierarchy'
import { useShallow } from 'zustand/react/shallow'
import { limitsOf } from '../lib/instance_limits'
import { sendKey } from '../lib/keys'
import type { Member, Profile, Role, UserRef } from '../lib/types'
import { useLook } from './shown_user'
import { UserAvatar } from './user_avatar'
import { Button, IconButton, LinkButton, ListRow } from './controls'
import { Row, Stack, Surface, Inset, Lift } from './layout'
import { Masked, Sheet, useCopied, useOwnServer, fieldCls } from './ui'
import { dmPlaceholder } from '../lib/display_name'
import { ProfileFriendButton } from './friends'
import { COARSE_QUERY, useMedia } from './context_menu'
import { TimeoutBadge, useMemberTimeout } from './timeout_dialog'
import { WebhookProfile } from './webhooks'
import { isWebhookAuthor } from '../lib/webhooks'
import { time } from '../lib/platform/time'

export function Badge({ tone, children }: { tone: 'primary' | 'tertiary'; children: string }) {
  const cls =
    tone === 'primary'
      ? 'bg-primary-container text-on-primary-container'
      : 'bg-tertiary-container text-on-tertiary-container'
  return (
    <Inset
      as="span"
      pad="xs"
      inset="chip"
      look={`rounded-md text-3xs font-medium ${cls}`}
      place="shrink-0"
    >
      {children}
    </Inset>
  )
}

const anchors = new WeakMap<ReturnType<typeof useStoreApi>, Element>()

const openFrom = (
  store: ReturnType<typeof useStoreApi>,
  el: Element,
  user: UserRef,
  server: string | null,
  x: number,
  y: number
) => {
  const s = store.getState()
  if (s.profile?.user.username === user.username && anchors.get(store) === el) {
    s.closeProfile()
    return
  }
  anchors.set(store, el)
  s.openProfile(user, server, x, y)
}

interface ProfileTriggerProps {
  role: 'button'
  tabIndex: number
  onClick: (e: ReactMouseEvent<HTMLElement>) => void
  onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void
}

export function profileTrigger(
  store: ReturnType<typeof useStoreApi>,
  user: UserRef,
  server: string | null,
  focusable = true
): ProfileTriggerProps {
  return {
    role: 'button',
    tabIndex: focusable ? 0 : -1,
    onClick: e => {
      e.stopPropagation()
      const r = e.currentTarget.getBoundingClientRect()
      const keyboard = e.detail === 0
      openFrom(
        store,
        e.currentTarget,
        user,
        server,
        keyboard ? r.right : e.clientX,
        keyboard ? r.top : e.clientY
      )
    },
    onKeyDown: e => {
      if (e.key !== 'Enter' && e.key !== ' ') return
      e.preventDefault()
      e.stopPropagation()
      const r = e.currentTarget.getBoundingClientRect()
      openFrom(store, e.currentTarget, user, server, r.right, r.top)
    },
  }
}

const asMember = (p: Profile): Member | null =>
  p.member && {
    ...p.user,
    is_admin: p.member.is_admin,
    is_creator: p.member.is_creator,
    online: p.member.online,
    perms: p.member.perms,
    role_ids: p.member.role_ids,
    ...(p.member.profile ? { profile: p.member.profile } : {}),
  }

const fmtDate = (ts: number) =>
  new Date(ts * 1000).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })

const ACTIONS: Record<ProfileAction, { label: string; icon: LucideIcon; danger?: boolean }> = {
  kick: { label: 'Kick', icon: UserMinus, danger: true },
  server_ban: { label: 'Ban from server', icon: Ban, danger: true },
  timeout: { label: 'Time out', icon: Timer, danger: true },
  untimeout: { label: 'Remove timeout', icon: TimerOff },
  profile_reset: { label: 'Reset server profile', icon: Eraser, danger: true },
  profile_unlock: { label: 'Unlock server profile', icon: LockOpen },
  promote: { label: 'Promote to Admin', icon: ShieldPlus },
  revoke: { label: 'Revoke Admin', icon: ShieldMinus, danger: true },
  transfer: { label: 'Transfer Admin', icon: ArrowRightLeft, danger: true },
  site_ban: { label: 'Ban site-wide', icon: Gavel, danger: true },
}

// As in the member menu: Change timeout, on someone timed out already, is not danger.
export const cardDanger = (a: ProfileAction, timedOut: boolean) =>
  !!ACTIONS[a].danger && !(a === 'timeout' && timedOut)

const labelCls = 'text-2xs font-semibold tracking-wide text-on-surface-variant uppercase'
// The account's handle, never masked: the card is where you check who an account is.
export function ProfileHandle({
  user,
  remote,
}: {
  user: Pick<UserRef, 'username'>
  remote: string | null
}) {
  return (
    <p className="streamer truncate text-sm text-on-surface-variant">
      @{remote ? formatQualified(user.username, remote) : user.username}
    </p>
  )
}

export function ProfileCard() {
  const target = useStore(s => s.profile)
  if (!target) return null
  const { user, server, x, y } = target
  return <Card key={`${user.username}\n${server ?? ''}\n${x},${y}`} target={target} />
}

// What the lookup of a profile says: the profile, or that it is hidden from the viewer.
interface Seen {
  profile: Profile | null
  hidden: boolean
}

function Card({ target }: { target: ProfileTarget }) {
  const {
    store,
    lifetime: { sessionMark },
  } = useAccount()
  const { noteTimeout } = store.menu
  const { server, rev } = target
  const username = target.user.username
  const hook = isWebhookAuthor(username)
  const [known] = useState<Seen>(() => ({
    profile: cachedProfile(profileKey(username, server), sessionMark()),
    hidden: false,
  }))
  const load = useAccountRequest<Seen>(
    async api => {
      if (hook) return known
      const key = profileKey(username, server)
      const at = sessionMark()
      try {
        const p = await api.userProfile(username, server)
        const mark = sessionMark()
        rememberProfile(key, p, at, mark)
        if (at !== mark) return { profile: p, hidden: false }
        const s = store.getState()
        if (server && s.servers[server]) s.rememberMember(server, username, asMember(p))
        if (server && p.member) noteTimeout(server, username, p.member.timeout)
        if (server && p.member) s.noteProfileLock(server, username, p.member.profile_locked_until)
        if (server && p.member) s.notePresence(server, username, p.member.online)
        store.setState(st =>
          st.profile?.user.username === username ? { profile: { ...st.profile, user: p.user } } : {}
        )
        return { profile: p, hidden: false }
      } catch (e) {
        if (!missing(e)) throw e
        if (at === sessionMark()) forgetProfile(key, at)
        return { profile: null, hidden: true }
      }
    },
    [username, server, rev, hook]
  )
  return (
    <Refreshed load={load} known={known} what="this profile">
      {(seen, notice) => (
        <CardBody target={target} seen={seen} failed={load.status === 'failed'} notice={notice} />
      )}
    </Refreshed>
  )
}

function CardBody({
  target,
  seen: { profile, hidden },
  failed,
  notice,
}: {
  target: ProfileTarget
  seen: Seen
  // Whether the lookup was refused: what the card says of the member is then what the app held.
  failed: boolean
  notice: ReactNode
}) {
  const account = useAccount()
  const {
    store,
    lifetime: { inSession },
  } = account
  const { confirmTransfer, revokeAdminFor } = store.menu
  const { server, x, y } = target
  const username = target.user.username
  const close = useStore(s => s.closeProfile)
  const view = useStore(s => s.view)
  const dialog = useStore(s => s.activeDialog)
  const me = useStore(s => s.me)
  const messageMax = useStore(s => limitsOf(s.instance).message_chars)
  const guest = useStore(s => s.guest)
  const streamer = useStore(s => s.streamer)
  const actor = useViewActor()
  const suffix = useActorSuffix(actor)
  const homeHost = useStore(s => s.instanceHost)
  const isBlocked = useStore(s => s.blocked[username] === true)
  const hook = isWebhookAuthor(username)
  const remote = isHomeHost(target.instance, homeHost) ? null : (target.instance as string)
  const live = useStore(s => (server ? memberState(s, server, username) : undefined))
  const serverRoles = useStore(s => (server ? s.servers[server]?.roles : undefined))
  const mine = useStore(s => (server ? myRolePerms(s, server) : 0))
  const channelLocked = useStore(s =>
    server ? s.servers[server]?.role_limits?.channel_grants : undefined
  )
  const channelDenies = useStore(s =>
    server ? s.servers[server]?.role_limits?.channel_denies : undefined
  )
  const serverName = useStore(s =>
    server
      ? (s.servers[server]?.display_name ??
        s.me?.servers.find(x => x.name === server)?.display_name ??
        server)
      : null
  )
  const perms = useStore(s => (server ? myPerms(s, server) : 0))
  const rank = useStore(useShallow(s => (server ? myRank(s, server) : undefined)))
  const ranked = useStore(s => (server ? s.servers[server]?.roles_order_confirmed === true : false))
  const timeout = useMemberTimeout(server, username)
  const coarse = useMedia(COARSE_QUERY)
  const small = useMedia(SHEET_QUERY)
  const sheet = coarse || small
  const titleId = useId()
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<Point | null>(null)
  const [text, setText] = useState('')
  const [adding, setAdding] = useState(false)
  const [copied, flashCopied] = useCopied()
  const opened = useRef({ view, dialog })
  const inside = useRef(false)

  useEffect(() => {
    if (view !== opened.current.view || dialog !== opened.current.dialog) close()
  }, [view, dialog, close])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    const outside = (e: Event) => {
      const t = e.target
      if (t instanceof Node && (ref.current?.contains(t) || anchors.get(store)?.contains(t))) return
      close()
    }
    window.addEventListener('keydown', onKey)
    if (!sheet) {
      document.addEventListener('pointerdown', outside, true)
      document.addEventListener('wheel', outside, { capture: true, passive: true })
      window.addEventListener('resize', close)
    }
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('wheel', outside, true)
      window.removeEventListener('resize', close)
    }
  }, [store, close, sheet])

  useLayoutEffect(() => {
    if (!sheet) return
    const active = document.activeElement
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) active.blur()
  }, [sheet])

  const shown = sheet || pos !== null
  const focused = useRef(false)
  useEffect(() => {
    if (!shown || focused.current) return
    focused.current = true
    ref.current?.focus({ preventScroll: true })
  }, [shown])

  useEffect(() => {
    const from = anchors.get(store)
    return () => {
      const lost = document.activeElement === null || document.activeElement === document.body
      if (inside.current && lost && from instanceof HTMLElement && from.isConnected)
        from.focus({ preventScroll: true })
    }
  }, [store])

  const focusProps = {
    tabIndex: -1,
    onFocus: () => {
      inside.current = true
    },
    onBlur: (e: React.FocusEvent<HTMLDivElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget)) inside.current = false
    },
  }

  useLayoutEffect(() => {
    if (sheet) return
    const el = ref.current
    if (!el) return
    const place = () =>
      setPos(
        placeCard(
          { x, y },
          { width: el.offsetWidth, height: el.offsetHeight },
          { width: window.innerWidth, height: window.innerHeight }
        )
      )
    place()
    const ro = new ResizeObserver(place)
    ro.observe(el)
    return () => ro.disconnect()
  }, [sheet, x, y])

  const self = me?.username === username
  const user: UserRef = self && me ? me : (live ?? target.user)
  // In a server the card leads with the name and avatar the member set there.
  const look = useLook(server, username)
  const placed = shownUser(user, look)
  const named = look?.name != null
  const banner = shownBanner(placed, {
    banner_color: self ? me?.banner_color : profile?.banner_color,
    server_banner: profile?.server_banner,
  })
  const bio = shownBio(user, {
    bio: self ? me?.bio : profile?.bio,
    server_bio: profile?.server_bio,
  })
  const profiles = useStore(s => (server ? profilesShown(s, server) : false))
  const editsProfile = useStore(s => (server ? mayEditProfile(s, server) : false))
  const lockedUntil = profile?.member?.profile_locked_until
  const ownServer = useOwnServer(server)
  const mask = useMask(ownServer)
  const fetched = profile?.member ?? null
  const known = server === null || live !== undefined || profile !== null || hidden
  const member = server === null ? null : live !== undefined ? live : fetched
  const join = serverJoinLine(
    server,
    serverName === null ? null : mask(serverName),
    joinedServer(member !== null, profile, hidden || failed),
    fetched?.joined_at
  )
  const roles: Role[] = member
    ? serverRoles
      ? heldRoles(serverRoles, member.role_ids)
      : (fetched?.roles ?? [])
    : []
  const input: ActionInput = {
    signedIn: me !== null && !guest,
    self,
    siteAdmin: me?.is_site_admin ?? false,
    inServer: server !== null,
    perms,
    member: member && { is_admin: member.is_admin, perms: member.perms },
    targetPerms: memberPerms(member, serverRoles ?? fetched?.roles ?? []),
    channelLocked,
    channelDenies,
    targetRolePerms: rolePerms(member, serverRoles ?? fetched?.roles ?? []),
    myRolePerms: mine,
    timedOut: timeout !== null,
    profiles,
    profileLocked: lockState(lockedUntil, Math.floor(time().now() / 1000)).locked,
    rank,
    order:
      ranked && rank
        ? { mine: rank, theirs: memberRank(member, serverRoles ?? fetched?.roles ?? []) }
        : undefined,
  }
  const actions = known ? profileActions(input) : []
  const editRoles = known && canEditRoles(input) && serverRoles !== undefined
  const addable =
    editRoles && serverRoles && member
      ? freeRoles(serverRoles, member.role_ids).filter(r => roleEditable(input, r, false))
      : []
  const showRoles = member !== null && (roles.length > 0 || addable.length > 0)

  const run = (action: ProfileAction) => {
    const s = store.getState()
    if (action === 'site_ban') {
      close()
      s.openDialog({ kind: 'ban_confirm', username })
      return
    }
    if (!server) return
    switch (action) {
      case 'kick':
        close()
        askKick(HostedServer.open(account, server), username)
        return
      case 'server_ban':
        close()
        openBan(HostedServer.open(account, server), username)
        return
      case 'timeout':
        close()
        openTimeout(HostedServer.open(account, server), username, {
          username: user.username,
          display_name: user.display_name,
          avatar_kind: user.avatar_kind,
          avatar_color: user.avatar_color,
        })
        return
      case 'untimeout':
        void s.removeTimeout(server, username)
        return
      case 'profile_reset':
        close()
        s.openDialog({
          kind: 'profile_reset',
          server,
          user: {
            username: user.username,
            display_name: user.display_name,
            avatar_kind: user.avatar_kind,
            avatar_color: user.avatar_color,
          },
        })
        return
      case 'profile_unlock':
        void s.unlockMemberProfile(server, username)
        return
      case 'promote':
        void s.grantAdmin(server, username)
        return
      case 'revoke':
        if (self) close()
        revokeAdminFor(server, username)
        return
      case 'transfer':
        close()
        confirmTransfer(server, username)
        return
    }
  }

  const roleChange = (role: Role, assign: boolean) => {
    if (!server) return
    setAdding(false)
    const s = store.getState()
    const done = assign
      ? s.assignRole(server, role.id, username)
      : s.unassignRole(server, role.id, username)
    void done.then(inSession(() => store.getState().refreshMember(server, username)))
  }

  const copyId = () => {
    void navigator.clipboard.writeText(username).then(flashCopied)
  }

  const send = () => {
    close()
    void store.getState().messageUser(username, text)
  }

  const body = hook ? (
    <WebhookProfile user={target.user} sheet={sheet} titleId={titleId} />
  ) : (
    <>
      <div
        aria-hidden
        style={{ background: banner }}
        className={`relative shrink-0 ${sheet ? 'h-24' : 'h-16'}`}
      >
        {sheet && (
          <div className="absolute top-2 left-1/2 h-1 w-8 -translate-x-1/2 rounded-full bg-surface-container-highest/80 ring-1 ring-outline-variant" />
        )}
      </div>
      <Inset pad="lg" inset="sides">
        <Stack gap="md">
          <Stack gap="sm">
            <Lift by="3xl">
              <Row gap="sm" align="end" justify="between">
                <Surface as="span" pad="xs" tone="high" radius="full" place="relative shrink-0">
                  <UserAvatar person={placed} size={80} />
                  {member && (
                    <span
                      title={member.online ? 'Online' : 'Offline'}
                      className={`absolute right-1.5 bottom-1.5 h-5 w-5 rounded-full border-4 border-surface-container-high ${
                        member.online ? 'bg-status-green' : 'bg-outline'
                      }`}
                    />
                  )}
                </Surface>
                {member && (member.is_creator || member.is_admin) && (
                  <Surface as="span" tone="plain" radius="none" pad="2xs">
                    <Row as="span" gap="2xs" justify="end">
                      {member.is_creator && <Badge tone="tertiary">Creator</Badge>}
                      {member.is_admin && <Badge tone="primary">Admin</Badge>}
                    </Row>
                  </Surface>
                )}
              </Row>
            </Lift>
            <Stack gap="2xs">
              <Stack gap="none">
                <Name
                  as="p"
                  id={titleId}
                  of={personCalled(placed.display_name, null, self)}
                  look="line-clamp-2 text-xl leading-7 font-semibold break-words text-on-surface"
                />
                {named && (
                  <Name
                    as="p"
                    data-account-name
                    of={personCalled(user.display_name, null, self)}
                    look="truncate text-sm text-on-surface"
                  />
                )}
                <ProfileHandle
                  user={user}
                  remote={remote ?? (actor ? new URL(actor.row.origin).host : null)}
                />
              </Stack>
              {(actor || remote) && (
                <Row gap="2xs">
                  <ActorLabel actor={actor} seen />
                  {remote && <InstanceChip host={remote} />}
                </Row>
              )}
              {bio && !hidden && (
                <p className="streamer text-sm break-words whitespace-pre-wrap text-on-surface">
                  <Masked text={bio} own={self} />
                </p>
              )}
              {((self && me && !guest) || (self && server && editsProfile)) && (
                <Row gap="md">
                  {self && me && !guest && (
                    <span className="text-xs">
                      <LinkButton
                        onClick={() => {
                          close()
                          store.getState().openDialog({ kind: 'settings', focus: 'bio' })
                        }}
                      >
                        {bio ? 'Edit description' : 'Add a description'}
                      </LinkButton>
                    </span>
                  )}
                  {self && server && editsProfile && (
                    <span className="text-xs">
                      <LinkButton
                        onClick={() => {
                          close()
                          store.getState().openDialog({ kind: 'server_profile', server })
                        }}
                      >
                        Edit server profile
                      </LinkButton>
                    </span>
                  )}
                </Row>
              )}
            </Stack>
          </Stack>
          <Stack gap="sm">
            {notice}
            {hidden && member === null ? (
              <Surface tone="low" radius="lg" pad="md">
                <p className="text-sm text-on-surface-variant">{HIDDEN_PROFILE}</p>
              </Surface>
            ) : (
              <Surface tone="low" radius="lg" pad="md" gap="md">
                {hidden && <p className="text-sm text-on-surface-variant">{HIDDEN_PROFILE}</p>}
                {(!hidden || timeout || join) && (
                  <Stack as="dl" gap="3xs">
                    {!hidden && (
                      <Row gap="md" align="baseline" justify="between">
                        <dt className="text-sm text-on-surface-variant">Member since</dt>
                        <dd className="shrink-0 text-sm text-on-surface">
                          {profile ? fmtDate(profile.created_at) : '…'}
                        </dd>
                      </Row>
                    )}
                    {timeout && (
                      <Row gap="md" justify="between">
                        <dt className="min-w-0 truncate text-sm text-on-surface-variant">
                          Timed out{timeout.reason ? `: ${timeout.reason}` : ''}
                        </dt>
                        <dd className="shrink-0 text-sm">
                          <TimeoutBadge t={timeout} />
                        </dd>
                      </Row>
                    )}
                    {join && (
                      <Row gap="md" align="baseline" justify="between">
                        <dt className="flex min-w-0 text-sm text-on-surface-variant">
                          <span className="shrink-0">Joined&nbsp;</span>
                          <span
                            className="streamer min-w-0 truncate"
                            title={streamer ? undefined : join.label}
                          >
                            <Masked text={serverName ?? join.name} own={ownServer} />
                          </span>
                        </dt>
                        <dd className="shrink-0 text-sm text-on-surface">
                          {join.joinedAt === null ? '…' : fmtDate(join.joinedAt)}
                        </dd>
                      </Row>
                    )}
                  </Stack>
                )}
                {showRoles && (
                  <Stack gap="xs">
                    <p className={labelCls}>{roles.length === 1 ? 'Role' : 'Roles'}</p>
                    <Row gap="xs" wrap>
                      {roles.map(r => (
                        <Surface
                          key={r.id}
                          as="span"
                          row
                          pad="sm"
                          inset="chip"
                          gap="xs"
                          tone="highest"
                          radius="full"
                          text="xs"
                          look="font-medium"
                          place="inline-flex max-w-full min-w-0"
                        >
                          <span
                            aria-hidden
                            style={{ background: r.color }}
                            className="h-2.5 w-2.5 shrink-0 rounded-full"
                          />
                          <span className="truncate">
                            <Masked text={r.name} own={ownServer} />
                          </span>
                          {editRoles && roleEditable(input, r, true) && (
                            <IconButton
                              icon={X}
                              label={`Remove ${r.name}`}
                              tone="danger"
                              size="xs"
                              onClick={() => roleChange(r, false)}
                            />
                          )}
                        </Surface>
                      ))}
                      {addable.length > 0 && (
                        <button
                          title="Add role"
                          aria-label="Add role"
                          aria-expanded={adding}
                          onClick={() => setAdding(a => !a)}
                          className={`flex h-6 w-6 items-center justify-center rounded-full border border-dashed text-on-surface-variant hover:border-primary hover:text-primary ${
                            adding ? 'border-primary text-primary' : 'border-outline'
                          }`}
                        >
                          <Plus size={14} />
                        </button>
                      )}
                    </Row>
                    {adding && addable.length > 0 && (
                      <div className="max-h-44 overflow-y-auto rounded-lg">
                        <Surface tone="high" radius="md" pad="2xs">
                          {addable.map(r => (
                            <ListRow
                              key={r.id}
                              onClick={() => roleChange(r, true)}
                              leading={
                                <span
                                  aria-hidden
                                  style={{ background: r.color }}
                                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                                />
                              }
                              label={<Masked text={r.name} own={ownServer} />}
                            />
                          ))}
                        </Surface>
                      </div>
                    )}
                  </Stack>
                )}
              </Surface>
            )}
            <Stack gap="none">
              {actions.map(a => {
                const { icon } = ACTIONS[a]
                const label = a === 'timeout' && timeout ? 'Change timeout' : ACTIONS[a].label
                return (
                  <ListRow
                    key={a}
                    onClick={() => run(a)}
                    tone={cardDanger(a, !!timeout) ? 'danger' : 'plain'}
                    icon={icon}
                    label={label}
                  />
                )
              })}
              <ListRow
                onClick={copyId}
                icon={copied ? Check : Copy}
                label={copied ? 'Copied' : 'Copy User ID'}
              />
              {me && !guest && !self && !remote && !isBlocked && (
                <ProfileFriendButton user={user} onDone={close} />
              )}
              {me && !guest && !self && !remote && (
                <ListRow
                  onClick={() => {
                    const s = store.getState()
                    if (isBlocked) void s.unblockUser(username, user.display_name)
                    else {
                      close()
                      s.askBlock(user)
                    }
                  }}
                  tone={isBlocked ? 'plain' : 'danger'}
                  icon={isBlocked ? UserCheck : UserX}
                  label={isBlocked ? 'Unblock' : 'Block'}
                />
              )}
            </Stack>
            {me && !guest && (
              <div>
                {self ? (
                  <Button
                    variant="tonal"
                    size="md"
                    icon={Pencil}
                    onClick={() => {
                      close()
                      store.getState().openDialog({ kind: 'settings' })
                    }}
                    place="w-full"
                  >
                    Edit profile
                  </Button>
                ) : isBlocked ? (
                  <Surface tone="low" radius="lg" pad="md">
                    <p className="text-sm text-on-surface-variant">You blocked this user.</p>
                  </Surface>
                ) : (
                  <input
                    value={text}
                    maxLength={messageMax}
                    onChange={e => setText(e.target.value)}
                    onKeyDown={e => {
                      if (sendKey(e)) {
                        e.preventDefault()
                        send()
                      }
                    }}
                    aria-label="Send a direct message"
                    placeholder={dmPlaceholder(user, streamer) + suffix}
                    className={`w-full ${fieldCls} bg-surface-container-low text-on-surface`}
                  />
                )}
              </div>
            )}
          </Stack>
        </Stack>
      </Inset>
    </>
  )

  if (sheet) {
    return (
      <Sheet
        grip={false}
        scroll
        overlay={{ onContextMenu: e => e.preventDefault() }}
        onClose={close}
        ref={ref}
        aria-labelledby={titleId}
        {...focusProps}
        onClick={e => e.stopPropagation()}
      >
        {body}
      </Sheet>
    )
  }

  return (
    <div
      ref={ref}
      role="dialog"
      aria-labelledby={titleId}
      {...focusProps}
      style={{
        left: pos?.x ?? x,
        top: pos?.y ?? y,
        visibility: pos ? 'visible' : 'hidden',
      }}
      className="fixed z-top flex max-h-screen-inset w-75 flex-col overflow-x-hidden overflow-y-auto overscroll-contain rounded-2xl bg-surface-container-high shadow-elevation-3 outline-none"
    >
      {body}
    </div>
  )
}

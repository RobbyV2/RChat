'use client'

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
  Gavel,
  Pencil,
  Plus,
  ShieldMinus,
  ShieldPlus,
  UserMinus,
  X,
} from 'lucide-react'
import { ApiError } from '../lib/api'
import { formatQualified, isHomeHost } from '../lib/qualified'
import { InstanceChip } from './instance_badge'
import { api } from '../lib/instances'
import {
  banMenuItem,
  confirmKick,
  confirmTransfer,
  memberState,
  myPerms,
  revokeAdminFor,
  useStore,
  type ProfileTarget,
} from '../lib/store'
import {
  SHEET_QUERY,
  bannerColor,
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
  serverJoinLine,
  type ActionInput,
  type Point,
  type ProfileAction,
} from '../lib/profile'
import { MESSAGE_MAX, memberPerms } from '../lib/rules'
import { sendKey } from '../lib/keys'
import type { Member, Profile, Role, UserRef } from '../lib/types'
import { UserAvatar } from './user_avatar'
import { COARSE_QUERY, useMedia } from './context_menu'

export function Badge({ tone, children }: { tone: 'primary' | 'tertiary'; children: string }) {
  const cls =
    tone === 'primary'
      ? 'bg-primary-container text-on-primary-container'
      : 'bg-tertiary-container text-on-tertiary-container'
  return (
    <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-medium ${cls}`}>
      {children}
    </span>
  )
}

let anchor: Element | null = null

const openFrom = (el: Element, user: UserRef, server: string | null, x: number, y: number) => {
  const s = useStore.getState()
  if (s.profile?.user.username === user.username && anchor === el) {
    s.closeProfile()
    return
  }
  anchor = el
  s.openProfile(user, server, x, y)
}

export interface ProfileTriggerProps {
  role: 'button'
  tabIndex: number
  onClick: (e: ReactMouseEvent<HTMLElement>) => void
  onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void
}

export function profileTrigger(
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
      openFrom(e.currentTarget, user, server, r.right, r.top)
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
  }

const fmtDate = (ts: number) =>
  new Date(ts * 1000).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })

const ACTIONS: Record<ProfileAction, { label: string; icon: ReactNode; danger?: boolean }> = {
  kick: { label: 'Kick', icon: <UserMinus size={16} />, danger: true },
  server_ban: { label: 'Ban from server', icon: <Ban size={16} />, danger: true },
  promote: { label: 'Promote to Admin', icon: <ShieldPlus size={16} /> },
  revoke: { label: 'Revoke Admin', icon: <ShieldMinus size={16} />, danger: true },
  transfer: { label: 'Transfer Admin', icon: <ArrowRightLeft size={16} /> },
  site_ban: { label: 'Ban site-wide', icon: <Gavel size={16} />, danger: true },
}

const labelCls = 'text-[11px] font-semibold tracking-wide text-on-surface-variant uppercase'
const rowCls = (sheet: boolean) =>
  `flex w-full items-center gap-3 rounded-lg px-2.5 text-left text-sm hover:bg-surface-container-highest active:bg-surface-container-highest ${
    sheet ? 'min-h-11' : 'py-1.5'
  }`

export function ProfileCard() {
  const target = useStore(s => s.profile)
  if (!target) return null
  const { user, server, x, y } = target
  return <Card key={`${user.username}\n${server ?? ''}\n${x},${y}`} target={target} />
}

function Card({ target }: { target: ProfileTarget }) {
  const { server, x, y, rev } = target
  const username = target.user.username
  const close = useStore(s => s.closeProfile)
  const view = useStore(s => s.view)
  const dialog = useStore(s => s.activeDialog)
  const me = useStore(s => s.me)
  const guest = useStore(s => s.guest)
  const streamer = useStore(s => s.streamer)
  const homeHost = useStore(s => s.instanceHost)
  const remote = isHomeHost(target.instance, homeHost) ? null : (target.instance as string)
  const live = useStore(s => (server ? memberState(s, server, username) : undefined))
  const serverRoles = useStore(s => (server ? s.servers[server]?.roles : undefined))
  const serverName = useStore(s =>
    server
      ? (s.servers[server]?.display_name ??
        s.me?.servers.find(x => x.name === server)?.display_name ??
        server)
      : null
  )
  const perms = useStore(s => (server ? myPerms(s, server) : 0))
  const coarse = useMedia(COARSE_QUERY)
  const small = useMedia(SHEET_QUERY)
  const sheet = coarse || small
  const titleId = useId()
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<Point | null>(null)
  const [profile, setProfile] = useState<Profile | null>(() =>
    cachedProfile(profileKey(username, server))
  )
  const [missing, setMissing] = useState(false)
  const [failed, setFailed] = useState(false)
  const [text, setText] = useState('')
  const [adding, setAdding] = useState(false)
  const [copied, setCopied] = useState(false)
  const opened = useRef({ view, dialog })
  const inside = useRef(false)

  useEffect(() => {
    let current = true
    const key = profileKey(username, server)
    api
      .userProfile(username, server)
      .then(p => {
        rememberProfile(key, p)
        if (!current) return
        setProfile(p)
        setFailed(false)
        const s = useStore.getState()
        if (server && s.servers[server]) s.rememberMember(server, username, asMember(p))
        if (server && p.member) s.notePresence(server, username, p.member.online)
        useStore.setState(st =>
          st.profile?.user.username === username ? { profile: { ...st.profile, user: p.user } } : {}
        )
      })
      .catch((e: unknown) => {
        if (!(e instanceof ApiError && e.status === 404)) {
          if (current) setFailed(true)
          return
        }
        forgetProfile(key)
        if (current) setMissing(true)
      })
    return () => {
      current = false
    }
  }, [username, server, rev])

  useEffect(() => {
    if (view !== opened.current.view || dialog !== opened.current.dialog) close()
  }, [view, dialog, close])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    const outside = (e: Event) => {
      const t = e.target
      if (t instanceof Node && (ref.current?.contains(t) || anchor?.contains(t))) return
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
  }, [close, sheet])

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
    const from = anchor
    return () => {
      const lost = document.activeElement === null || document.activeElement === document.body
      if (inside.current && lost && from instanceof HTMLElement && from.isConnected)
        from.focus({ preventScroll: true })
    }
  }, [])

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
  const banner = bannerColor(user, self ? me?.banner_color : profile?.banner_color)
  const bio = self ? (me?.bio ?? null) : (profile?.bio ?? null)
  const fetched = profile?.member ?? null
  const known = server === null || live !== undefined || profile !== null || missing
  const member = server === null ? null : live !== undefined ? live : fetched
  const join = serverJoinLine(
    server,
    serverName,
    joinedServer(member !== null, profile, missing || failed),
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
    member: member && { is_admin: member.is_admin },
    targetPerms: memberPerms(member, serverRoles ?? fetched?.roles ?? []),
  }
  const actions = known && !missing ? profileActions(input) : []
  const editRoles = known && !missing && canEditRoles(input) && serverRoles !== undefined
  const addable = editRoles && serverRoles && member ? freeRoles(serverRoles, member.role_ids) : []
  const showRoles = member !== null && (roles.length > 0 || addable.length > 0)

  const run = (action: ProfileAction) => {
    const s = useStore.getState()
    if (action === 'site_ban') {
      close()
      s.openDialog({ kind: 'ban_confirm', username })
      return
    }
    if (!server) return
    switch (action) {
      case 'kick':
        close()
        confirmKick(server, username)
        return
      case 'server_ban':
        close()
        banMenuItem(server, username).action()
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
    const s = useStore.getState()
    const done = assign
      ? s.assignRole(server, role.id, username)
      : s.unassignRole(server, role.id, username)
    void done.then(() => useStore.getState().refreshMember(server, username))
  }

  const copyId = () => {
    void navigator.clipboard.writeText(username).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  const send = () => {
    close()
    void useStore.getState().messageUser(username, text)
  }

  const body = (
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
      <div className={sheet ? 'px-5' : 'px-4'}>
        <div className="-mt-12 flex items-end justify-between gap-2">
          <span className="relative block shrink-0 rounded-full bg-surface-container-high p-1.5">
            <UserAvatar
              username={user.username}
              avatarKind={user.avatar_kind}
              avatarColor={user.avatar_color}
              size={80}
            />
            {member && (
              <span
                title={member.online ? 'Online' : 'Offline'}
                className={`absolute right-1.5 bottom-1.5 h-5 w-5 rounded-full border-4 border-surface-container-high ${
                  member.online ? 'bg-status-green' : 'bg-outline'
                }`}
              />
            )}
          </span>
          {member && (member.is_creator || member.is_admin) && (
            <span className="mb-1 flex flex-wrap justify-end gap-1">
              {member.is_creator && <Badge tone="tertiary">Creator</Badge>}
              {member.is_admin && <Badge tone="primary">Admin</Badge>}
            </span>
          )}
        </div>
        <div className="mt-2 min-w-0">
          <p
            id={titleId}
            className="streamer line-clamp-2 text-xl leading-7 font-semibold break-words text-on-surface"
          >
            {user.display_name}
          </p>
          <p className="streamer truncate text-sm text-on-surface-variant">
            @{remote ? formatQualified(user.username, remote) : user.username}
          </p>
          {remote && <InstanceChip host={remote} className="mt-1" />}
          {bio && !missing && (
            <p className="streamer mt-2 text-sm break-words whitespace-pre-wrap text-on-surface">
              {bio}
            </p>
          )}
          {self && me && !guest && (
            <button
              onClick={() => {
                close()
                useStore.getState().openDialog({ kind: 'settings', focus: 'bio' })
              }}
              className="mt-1 text-xs font-medium text-primary hover:underline"
            >
              {bio ? 'Edit description' : 'Add a description'}
            </button>
          )}
        </div>
        {missing ? (
          <p className="mt-3 rounded-xl bg-surface-container-low p-3 text-sm text-on-surface-variant">
            This account no longer exists.
          </p>
        ) : (
          <div className="mt-3 flex flex-col gap-3 rounded-xl bg-surface-container-low p-3">
            <dl className="flex flex-col gap-0.5 text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-on-surface-variant">Member since</dt>
                <dd className="shrink-0 text-on-surface">
                  {profile ? fmtDate(profile.created_at) : '…'}
                </dd>
              </div>
              {join && (
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="flex min-w-0 text-on-surface-variant">
                    <span className="shrink-0">Joined&nbsp;</span>
                    <span className="streamer min-w-0 truncate" title={join.label}>
                      {join.name}
                    </span>
                  </dt>
                  <dd className="shrink-0 text-on-surface">
                    {join.joinedAt === null ? '…' : fmtDate(join.joinedAt)}
                  </dd>
                </div>
              )}
            </dl>
            {showRoles && (
              <div>
                <p className={labelCls}>{roles.length === 1 ? 'Role' : 'Roles'}</p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {roles.map(r => (
                    <span
                      key={r.id}
                      className="inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-full bg-surface-container-highest py-0.5 pr-1 pl-2 text-xs font-medium text-on-surface"
                    >
                      <span
                        aria-hidden
                        style={{ background: r.color }}
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                      />
                      <span className={`truncate ${editRoles ? '' : 'pr-1'}`}>{r.name}</span>
                      {editRoles && (
                        <button
                          title={`Remove ${r.name}`}
                          onClick={() => roleChange(r, false)}
                          className="shrink-0 rounded-full p-0.5 text-on-surface-variant hover:bg-surface-container-high hover:text-error"
                        >
                          <X size={12} />
                        </button>
                      )}
                    </span>
                  ))}
                  {addable.length > 0 && (
                    <button
                      title="Add role"
                      aria-expanded={adding}
                      onClick={() => setAdding(a => !a)}
                      className={`flex h-6 w-6 items-center justify-center rounded-full border border-dashed text-on-surface-variant hover:border-primary hover:text-primary ${
                        adding ? 'border-primary text-primary' : 'border-outline'
                      }`}
                    >
                      <Plus size={14} />
                    </button>
                  )}
                </div>
                {adding && addable.length > 0 && (
                  <div className="mt-2 flex max-h-44 flex-col overflow-y-auto rounded-lg bg-surface-container-high p-1">
                    {addable.map(r => (
                      <button
                        key={r.id}
                        onClick={() => roleChange(r, true)}
                        className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-surface-container-highest"
                      >
                        <span
                          aria-hidden
                          style={{ background: r.color }}
                          className="h-2.5 w-2.5 shrink-0 rounded-full"
                        />
                        <span className="truncate">{r.name}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        <div className="mt-2 flex flex-col">
          {actions.map(a => {
            const { label, icon, danger } = ACTIONS[a]
            return (
              <button
                key={a}
                onClick={() => run(a)}
                className={`${rowCls(sheet)} ${danger ? 'text-error' : 'text-on-surface'}`}
              >
                <span className="shrink-0">{icon}</span>
                {label}
              </button>
            )
          })}
          <button onClick={copyId} className={`${rowCls(sheet)} text-on-surface`}>
            <span className="shrink-0">{copied ? <Check size={16} /> : <Copy size={16} />}</span>
            {copied ? 'Copied' : 'Copy User ID'}
          </button>
        </div>
        {me && !guest && !missing && (
          <div className="mt-2">
            {self ? (
              <button
                onClick={() => {
                  close()
                  useStore.getState().openDialog({ kind: 'settings' })
                }}
                className="flex w-full items-center justify-center gap-2 rounded-full bg-secondary-container px-4 py-2 text-sm font-medium text-on-secondary-container hover:opacity-90"
              >
                <Pencil size={14} />
                Edit profile
              </button>
            ) : (
              <input
                value={text}
                maxLength={MESSAGE_MAX}
                onChange={e => setText(e.target.value)}
                onKeyDown={e => {
                  if (sendKey(e)) {
                    e.preventDefault()
                    send()
                  }
                }}
                aria-label="Send a direct message"
                placeholder={streamer ? 'Send a direct message' : `Message @${user.display_name}`}
                className="w-full rounded-xl border border-outline-variant bg-surface-container-low px-3 py-2 text-base text-on-surface outline-none placeholder:text-on-surface-variant focus:border-primary md:text-sm"
              />
            )}
          </div>
        )}
      </div>
    </>
  )

  if (sheet) {
    return (
      <div
        className="fixed inset-x-0 top-0 z-50 flex h-app flex-col justify-end bg-scrim/40"
        onClick={close}
        onContextMenu={e => e.preventDefault()}
      >
        <div
          ref={ref}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          {...focusProps}
          onClick={e => e.stopPropagation()}
          className="animate-sheet-up flex max-h-[90%] flex-col overflow-y-auto overscroll-contain rounded-t-3xl bg-surface-container-high px-safe pb-[max(1rem,env(safe-area-inset-bottom))] shadow-elevation-3 outline-none"
        >
          {body}
        </div>
      </div>
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
      className="fixed z-50 flex max-h-[calc(100dvh-1rem)] w-75 flex-col overflow-x-hidden overflow-y-auto overscroll-contain rounded-2xl bg-surface-container-high pb-4 shadow-elevation-3 outline-none"
    >
      {body}
    </div>
  )
}

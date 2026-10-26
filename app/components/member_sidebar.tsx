'use client'

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Perm, hasPerm, type Member, type UserRef } from '../lib/types'
import { prefixHeights, visibleRange } from '../lib/window'
import { canModerate, memberPerms } from '../lib/rules'
import {
  banMenuItem,
  confirmKick,
  confirmTransfer,
  myPerms,
  revokeAdminFor,
  roleColor,
  roleMenuItems,
  useStore,
  type ContextMenuItem,
} from '../lib/store'
import { UserAvatar } from './user_avatar'
import { longPress } from './context_menu'
import { Badge, profileTrigger } from './profile_card'
import { Sentinel } from './server_settings'

const byName = (a: Member, b: Member) => a.display_name.localeCompare(b.display_name)

const rowFocus = 'outline-offset-[-2px] focus-visible:outline-2 focus-visible:outline-primary'

const ROW = 40
const HEAD = 32
const EDGE = 1
const OVERSCAN = 400

type Item =
  | { kind: 'head'; key: string; label: string }
  | { kind: 'member'; key: string; m: Member }
  | { kind: 'user'; key: string; u: UserRef }
  | { kind: 'more'; key: string; onVisible: () => void }

const heightOf = (item: Item) => (item.kind === 'head' ? HEAD : item.kind === 'more' ? EDGE : ROW)

function useWindowed(items: Item[]) {
  const [el, ref] = useState<HTMLElement | null>(null)
  const [port, setPort] = useState({ top: 0, height: 800 })
  useEffect(() => {
    if (!el) return
    let frame = 0
    const read = () => {
      frame = 0
      setPort(p =>
        p.top === el.scrollTop && p.height === el.clientHeight
          ? p
          : { top: el.scrollTop, height: el.clientHeight }
      )
    }
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(read)
    }
    read()
    el.addEventListener('scroll', onScroll, { passive: true })
    const ro = new ResizeObserver(onScroll)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', onScroll)
      ro.disconnect()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [el])
  const prefix = useMemo(() => prefixHeights(items.map(heightOf)), [items])
  const range = visibleRange(prefix, port.top, port.height, OVERSCAN)
  return { ref, range }
}

export default function MemberSidebar() {
  const detail = useStore(s => (s.view?.kind === 'channel' ? s.servers[s.view.server] : null))
  const cache = useStore(s => (s.view?.kind === 'channel' ? s.members[s.view.server] : undefined))
  const inter = useStore(s =>
    s.view?.kind === 'channel' ? s.interacted[s.view.server] : undefined
  )
  const me = useStore(s => s.me)
  const perms = useStore(s => (s.view?.kind === 'channel' ? myPerms(s, s.view.server) : 0))
  const loadMembers = useStore(s => s.loadMembers)
  const loadInteracted = useStore(s => s.loadInteracted)
  const openContextMenu = useStore(s => s.openContextMenu)
  const openDialog = useStore(s => s.openDialog)
  const startDm = useStore(s => s.startDm)
  const grantAdmin = useStore(s => s.grantAdmin)
  const server = detail?.name
  useEffect(() => {
    if (server) {
      void loadMembers(server, true)
      void loadInteracted(server, true)
    }
  }, [server, loadMembers, loadInteracted])
  const more = useCallback(() => {
    if (server) void loadMembers(server)
  }, [server, loadMembers])
  const moreInteracted = useCallback(() => {
    if (server) void loadInteracted(server)
  }, [server, loadInteracted])
  const items = useMemo(() => {
    if (!detail) return []
    const loaded = cache?.list ?? []
    const online = loaded.filter(m => m.online).sort(byName)
    const offline = loaded.filter(m => !m.online).sort(byName)
    const out: Item[] = []
    const section = (id: string, label: string, count: number, list: Member[]) => {
      if (count <= 0 && !list.length) return
      out.push({ kind: 'head', key: `h${id}`, label: `${label} (${count})` })
      for (const m of list) out.push({ kind: 'member', key: `m${m.username}`, m })
    }
    section('on', 'Online', detail.online_count, online)
    section('off', 'Offline', Math.max(0, detail.member_count - detail.online_count), offline)
    if (cache?.hasMore) out.push({ kind: 'more', key: `more${loaded.length}`, onVisible: more })
    const users = inter?.list ?? []
    if (users.length) {
      out.push({
        kind: 'head',
        key: 'hint',
        label: `Interacted (${users.length}${inter?.hasMore ? '+' : ''})`,
      })
      for (const u of users) out.push({ kind: 'user', key: `u${u.username}`, u })
      if (inter?.hasMore)
        out.push({ kind: 'more', key: `imore${users.length}`, onVisible: moreInteracted })
    }
    return out
  }, [detail, cache, inter, more, moreInteracted])
  const { ref, range } = useWindowed(items)
  if (!detail) return null

  const menuFor = (m: Member, x: number, y: number): ContextMenuItem[] => {
    if (!me) return []
    const self = m.username === me.username
    const items: ContextMenuItem[] = [
      {
        label: 'Direct Message',
        action: () => void startDm(m.username),
      },
    ]
    if (
      hasPerm(perms, Perm.Kick) &&
      !self &&
      canModerate(perms, me.is_site_admin, memberPerms(m, detail.roles))
    )
      items.push(
        {
          label: 'Kick',
          danger: true,
          action: () => confirmKick(detail.name, m.username),
        },
        banMenuItem(detail.name, m.username)
      )
    if (hasPerm(perms, Perm.ManageAdmins)) {
      items.push(
        m.is_admin
          ? {
              label: 'Revoke Admin',
              danger: true,
              action: () => revokeAdminFor(detail.name, m.username),
            }
          : { label: 'Promote to Admin', action: () => void grantAdmin(detail.name, m.username) }
      )
      if (!self)
        items.push({
          label: 'Transfer Admin',
          action: () => confirmTransfer(detail.name, m.username),
        })
      if (detail.roles.length)
        items.push({
          label: 'Assign Role',
          action: () => openContextMenu(x, y, roleMenuItems(detail.name, m.username)),
        })
    }
    if (me.is_site_admin && !self)
      items.push({
        label: 'Ban site-wide',
        danger: true,
        action: () => openDialog({ kind: 'ban_confirm', username: m.username }),
      })
    items.push({
      label: 'Copy User ID',
      action: () => void navigator.clipboard.writeText(m.username),
    })
    return items
  }

  const row = (m: Member) => {
    return (
      <div
        key={m.username}
        {...(me
          ? longPress((x, y) => {
              const items = menuFor(m, x, y)
              if (items.length) openContextMenu(x, y, items)
            })
          : {})}
        {...profileTrigger(m, detail.name)}
        className={`flex h-10 cursor-pointer items-center gap-2 rounded-xl px-2 hover:bg-surface-container-high ${rowFocus} ${
          m.online ? '' : 'opacity-50'
        }`}
      >
        <UserAvatar
          username={m.username}
          avatarKind={m.avatar_kind}
          avatarColor={m.avatar_color}
          size={28}
        />
        <span
          style={{ color: roleColor(detail.roles, m.role_ids) }}
          className="streamer min-w-0 flex-1 truncate text-sm"
        >
          {m.display_name}
        </span>
        {m.is_creator && <Badge tone="tertiary">Creator</Badge>}
        {m.is_admin && <Badge tone="primary">Admin</Badge>}
      </div>
    )
  }

  const interactedRow = (u: UserRef) => (
    <div
      key={u.username}
      {...(me
        ? longPress((x, y) =>
            openContextMenu(x, y, [
              {
                label: 'Direct Message',
                action: () => void startDm(u.username),
              },
              {
                label: 'Copy User ID',
                action: () => void navigator.clipboard.writeText(u.username),
              },
            ])
          )
        : {})}
      {...profileTrigger(u, detail.name)}
      className={`flex h-10 cursor-pointer items-center gap-2 rounded-xl px-2 opacity-70 hover:bg-surface-container-high ${rowFocus}`}
    >
      <UserAvatar
        username={u.username}
        avatarKind={u.avatar_kind}
        avatarColor={u.avatar_color}
        size={28}
      />
      <span className="streamer min-w-0 flex-1 truncate text-sm">{u.display_name}</span>
    </div>
  )

  const render = (item: Item): ReactNode => {
    switch (item.kind) {
      case 'head':
        return (
          <p
            key={item.key}
            className="flex h-8 items-end px-2 pb-1 text-xs font-medium tracking-wide text-on-surface-variant uppercase"
          >
            {item.label}
          </p>
        )
      case 'member':
        return row(item.m)
      case 'user':
        return interactedRow(item.u)
      case 'more':
        return <Sentinel key={item.key} onVisible={item.onVisible} />
    }
  }

  return (
    <aside ref={ref} className="h-full w-60 shrink-0 overflow-y-auto bg-surface-container-low p-2">
      <div style={{ height: range.before }} />
      {items.slice(range.start, range.end).map(render)}
      <div style={{ height: range.after }} />
    </aside>
  )
}

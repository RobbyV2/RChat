'use client'
import { ViewActorTag } from './view_actor'
import { useAccount } from '../lib/client/react'

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Member, UserRef } from '../lib/types'
import { prefixHeights, visibleRange } from '../lib/window'
import { onlineSection } from '../lib/presence'
import { MEMBERS_HIDDEN_LINE, seesMembers } from '../lib/profile_choice'
import { openActionMenu } from '../lib/actions/menu'
import { byShownName } from '../lib/server_profile'
import { roleLook, useStore } from '../lib/store'
import { FIRST_GROUPS, FIRST_ROWS, groupParts, serverGroups } from '../lib/member_groups'
import { RoleIcon } from './role_icon'
import type { Look } from '../lib/role_looks'
import { UserAvatar } from './user_avatar'
import { longPress } from './context_menu'
import { Badge, profileTrigger } from './profile_card'
import { Row, Surface } from './layout'
import { Sentinel } from './ui'
import { MemberListSkeleton } from './skeletons'
import { FitName } from './display_name'
import { useShownMembers } from './shown_user'
import { TimeoutBadge, useMemberTimeout } from './timeout_dialog'

const rowFocus = 'outline-offset-[-2px] focus-visible:outline-2 focus-visible:outline-primary'

const ROW = 40
const HEAD = 32
const EDGE = 1
const OVERSCAN = 400

type Item =
  | { kind: 'head'; key: string; label: string }
  | { kind: 'member'; key: string; m: Member; shown: Member }
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

// A row's name, sized to the room the badges leave, and its role icon; its title has the whole
// name.
export const MemberName = ({
  user,
  color,
  icon,
}: {
  user: UserRef
  color?: string
  icon?: Look['icon']
}) => (
  <Row as="span" gap="2xs" place="flex-1">
    <FitName
      user={user}
      style={color === undefined ? undefined : { color }}
      className="streamer min-w-0 truncate text-sm"
    />
    <RoleIcon emoji={icon?.emoji} role={icon?.role} />
  </Row>
)

export function MemberTimeout({ server, username }: { server: string; username: string }) {
  const t = useMemberTimeout(server, username)
  return t ? <TimeoutBadge t={t} compact /> : null
}

const asideCls = 'h-full w-60 shrink-0 overflow-y-auto bg-surface-container-low p-2'
const loadingCls = 'h-full w-60 shrink-0 overflow-hidden bg-surface-container-low p-2'

export default function MemberSidebar() {
  const acct = useAccount()
  const { store } = acct

  const viewServer = useStore(s => (s.view?.kind === 'channel' ? s.view.server : null))
  const detail = useStore(s => (s.view?.kind === 'channel' ? s.servers[s.view.server] : null))
  const cache = useStore(s => (s.view?.kind === 'channel' ? s.members[s.view.server] : undefined))
  const info = useStore(s => (s.view?.kind === 'channel' ? s.memberInfo[s.view.server] : undefined))
  const inter = useStore(s =>
    s.view?.kind === 'channel' ? s.interacted[s.view.server] : undefined
  )
  const me = useStore(s => s.me)
  const listed = useStore(s => {
    const v = s.view
    if (v?.kind !== 'channel') return true
    const member = s.me?.servers.some(x => x.name === v.server) ?? false
    return seesMembers(s.servers[v.server]?.members_visible, member, s.me?.is_site_admin ?? false)
  })
  const hoisted = useStore(s => (s.view?.kind === 'channel' ? s.hoisted[s.view.server] : undefined))
  const loadMembers = useStore(s => s.loadMembers)
  const loadGroup = useStore(s => s.loadGroup)
  const clearGroups = useStore(s => s.clearGroups)
  const loadInteracted = useStore(s => s.loadInteracted)
  const loadMissingOnline = useStore(s => s.loadMissingOnline)
  const server = listed ? detail?.name : undefined
  const groups = useMemo(() => serverGroups(detail?.roles), [detail?.roles])
  const groupIds = groups.map(g => g.id).join(',')
  const grouped = !!server && groups.length > 0
  const groupsLoaded = !!hoisted
  useEffect(() => {
    if (server) {
      void loadMembers(server, true)
      void loadInteracted(server, true)
    }
  }, [server, loadMembers, loadInteracted])
  useEffect(() => {
    if (server) clearGroups(server)
  }, [server, groupIds, clearGroups])
  useEffect(() => {
    if (!server || !groupIds || groupsLoaded) return
    for (const id of groupIds.split(',').slice(0, FIRST_GROUPS))
      void loadGroup(server, Number(id), true, FIRST_ROWS)
    void loadGroup(server, 'rest', true)
  }, [server, groupIds, groupsLoaded, loadGroup])
  const more = useCallback(() => {
    if (server) void loadMembers(server)
  }, [server, loadMembers])
  const moreOnline = useCallback(() => {
    if (server) void loadMissingOnline(server)
  }, [server, loadMissingOnline])
  const moreInteracted = useCallback(() => {
    if (server) void loadInteracted(server)
  }, [server, loadInteracted])
  const shownOf = useShownMembers(server)
  const items = useMemo(() => {
    if (!detail) return []
    const out: Item[] = []
    const interacted = () => {
      const users = inter?.list ?? []
      if (!users.length) return
      out.push({
        kind: 'head',
        key: 'hint',
        label: `Interacted (${users.length}${inter?.hasMore ? '+' : ''})`,
      })
      for (const u of users) out.push({ kind: 'user', key: `u${u.username}`, u })
      if (inter?.hasMore)
        out.push({ kind: 'more', key: `imore${users.length}`, onVisible: moreInteracted })
    }
    if (grouped) {
      for (const part of groupParts(groups, hoisted, m => shownOf(m).display_name))
        out.push(
          part.kind === 'more'
            ? {
                kind: 'more',
                key: part.key,
                onVisible: () => void loadGroup(detail.name, part.group),
              }
            : part.kind === 'member'
              ? { ...part, shown: shownOf(part.m) }
              : part
        )
      interacted()
      return out
    }
    // Each section in the order of the names the server shows.
    const byName = (list: Member[]) =>
      list.map(m => ({ m, shown: shownOf(m) })).sort((a, b) => byShownName(a.shown, b.shown))
    const loaded = cache?.list ?? []
    const {
      online,
      offline: away,
      totals,
      more: omore,
    } = onlineSection(detail.online_count, detail.member_count, cache, info)
    const section = (id: string, label: string, count: number, list: Member[]) => {
      if (count <= 0 && !list.length) return
      out.push({ kind: 'head', key: `h${id}`, label: `${label} (${count})` })
      for (const { m, shown } of byName(list))
        out.push({ kind: 'member', key: `m${m.username}`, m, shown })
    }
    section('on', 'Online', totals.online, online)
    if (omore) out.push({ kind: 'more', key: omore, onVisible: moreOnline })
    section('off', 'Offline', totals.offline, away)
    if (cache?.hasMore) out.push({ kind: 'more', key: `more${loaded.length}`, onVisible: more })
    interacted()
    return out
  }, [
    detail,
    cache,
    info,
    inter,
    more,
    moreOnline,
    moreInteracted,
    shownOf,
    grouped,
    groups,
    hoisted,
    loadGroup,
  ])
  const { ref, range } = useWindowed(items)
  if (!detail)
    return viewServer ? (
      <aside className={loadingCls}>
        <ViewActorTag header />
        <MemberListSkeleton seed={viewServer} />
      </aside>
    ) : null
  if (!listed)
    return (
      <aside className={asideCls}>
        <ViewActorTag header />
        <Surface pad="md" tone="plain" radius="none">
          <p className="text-sm text-on-surface-variant">{MEMBERS_HIDDEN_LINE}</p>
        </Surface>
      </aside>
    )
  if (detail.member_count > 0 && (!cache || (cache.loading && !cache.list.length)))
    return (
      <aside className={loadingCls}>
        <ViewActorTag header />
        <MemberListSkeleton seed={detail.name} />
      </aside>
    )

  const row = (m: Member, shown: Member) => {
    const look = roleLook(detail.roles, m.role_ids)
    return (
      <div
        key={m.username}
        {...(me
          ? longPress((x, y) =>
              openActionMenu(
                x,
                y,
                { kind: 'member', user: m, server: detail.name, where: 'list' },
                undefined,
                acct
              )
            )
          : {})}
        {...profileTrigger(store, m, detail.name)}
        className={`flex h-10 cursor-pointer items-center gap-2 rounded-xl px-2 hover:bg-surface-container-high ${rowFocus} ${
          m.online ? '' : 'opacity-50'
        }`}
      >
        <UserAvatar
          username={shown.username}
          avatarKind={shown.avatar_kind}
          avatarColor={shown.avatar_color}
          size={28}
        />
        <MemberName user={shown} color={look.color} icon={look.icon} />
        <MemberTimeout server={detail.name} username={m.username} />
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
            openActionMenu(
              x,
              y,
              { kind: 'member', user: u, server: null, where: 'interacted' },
              undefined,
              acct
            )
          )
        : {})}
      {...profileTrigger(store, u, detail.name)}
      className={`flex h-10 cursor-pointer items-center gap-2 rounded-xl px-2 opacity-70 hover:bg-surface-container-high ${rowFocus}`}
    >
      <UserAvatar
        username={u.username}
        avatarKind={u.avatar_kind}
        avatarColor={u.avatar_color}
        size={28}
      />
      <MemberName user={u} />
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
        return row(item.m, item.shown)
      case 'user':
        return interactedRow(item.u)
      case 'more':
        return <Sentinel key={item.key} onVisible={item.onVisible} />
    }
  }

  return (
    <aside ref={ref} className={asideCls}>
      <ViewActorTag header />
      <div style={{ height: range.before }} />
      {items.slice(range.start, range.end).map(render)}
      <div style={{ height: range.after }} />
    </aside>
  )
}

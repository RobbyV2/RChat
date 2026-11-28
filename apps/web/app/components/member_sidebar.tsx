'use client'

import { Pressable } from './controls'

import type { Person } from '../lib/people'
import { Name } from './name'
import { personName, p2pName } from '../lib/names'
import type { Cancel } from '../lib/clock'
import { useEffect, useMemo, useState } from 'react'
import { Crown } from 'lucide-react'
import { openActionMenu } from '../lib/actions/menu'
import { useAccount } from '../lib/client/react'
import { isUnsupported } from '../lib/place/feature'
import { members, type MemberEntry, type MemberItem, type Members } from '../lib/place/members'
import { useFeature, useLive, usePlace } from '../lib/place/react'
import type { Look } from '../lib/role_looks'
import { useMask } from '../lib/store'
import type { Timeout } from '../lib/timeouts'
import { prefixHeights, visibleRange } from '../lib/window'
import { longPress } from './context_menu'
import { Inset, Row, Surface } from './layout'
import { AccountChip, ContactShield, MemberAvatar, PresenceDot } from './p2p/p2p_badge'
import { MemberCard } from './p2p/p2p_server_roles'
import { Badge, ProfileButton } from './profile_card'
import { RoleIcon } from './role_icon'
import { MemberListSkeleton } from './skeletons'
import { MembersHiddenState } from './members_hidden'
import { TimeoutBadge, useMemberTimeout, useNow } from './timeout_dialog'
import { Masked, Sentinel } from './ui'
import { UserAvatar } from './user_avatar'
import { PeerActorTag, ViewActorTag } from './view_actor'
import { time } from '../lib/platform/time'

const ROW = 40
const HEAD = 32
const EDGE = 1
const OVERSCAN = 400
// What a line under the name adds to a row.
const LINE = 16
const linesOf = (entry: MemberEntry) => (entry.chip ? 1 : 0) + (entry.note ? 1 : 0)
const ROW_HEIGHT = ['h-10', 'h-14', 'h-18'] as const

const heightOf = (item: MemberItem) =>
  item.kind === 'head' ? HEAD : item.kind === 'more' ? EDGE : ROW + LINE * linesOf(item.entry)

function useWindowed(items: MemberItem[]) {
  const [el, ref] = useState<HTMLElement | null>(null)
  const [port, setPort] = useState({ top: 0, height: 800 })
  useEffect(() => {
    if (!el) return
    let frame: Cancel | null = null
    const read = () => {
      frame = null
      setPort(p =>
        p.top === el.scrollTop && p.height === el.clientHeight
          ? p
          : { top: el.scrollTop, height: el.clientHeight }
      )
    }
    const onScroll = () => {
      if (!frame) frame = time().frame(read)
    }
    read()
    el.addEventListener('scroll', onScroll, { passive: true })
    const ro = new ResizeObserver(onScroll)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', onScroll)
      ro.disconnect()
      frame?.()
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
  user: Person
  color?: string
  icon?: Look['icon']
}) => (
  <Row as="span" gap="2xs" place="flex-1">
    <Name
      of={personName(user)}
      withUsername
      fit
      color={color}
      place="min-w-0"
      look="truncate text-sm"
    />
    <RoleIcon emoji={icon?.emoji} role={icon?.role} />
  </Row>
)

export function MemberTimeout({ server, username }: { server: string; username: string }) {
  const t = useMemberTimeout(server, username)
  return t ? <TimeoutBadge t={t} compact /> : null
}

const asideCls = 'member-list h-full w-60 shrink-0 overflow-y-auto bg-surface-container-low'
const loadingCls = 'member-list h-full w-60 shrink-0 overflow-hidden bg-surface-container-low'

// The timer of a row's timeout, until it ends.
function RowTimeout({ t }: { t: Timeout | null }) {
  const now = useNow(t !== null && t.ends > time().now())
  return t && t.ends > now ? <TimeoutBadge t={t} compact /> : null
}

function Face({ entry }: { entry: MemberEntry }) {
  const { face } = entry
  return (
    <span className="relative shrink-0">
      {face.kind === 'account' ? (
        <UserAvatar person={face.user} size={28} />
      ) : (
        <MemberAvatar members={face.of} ik={face.ik} size={28} />
      )}
      {entry.dot && <PresenceDot presence={entry.online ? 'online' : 'offline'} />}
    </span>
  )
}

function MemberRow({
  entry,
  mask,
}: {
  entry: MemberEntry
  mask: ((text: string) => string) | null
}) {
  const acct = useAccount()
  const place = usePlace()
  const { face, look, opens } = entry
  const identity = place?.kind === 'p2pRoom' ? place.app : undefined
  const menu = (x: number, y: number) => {
    if (entry.menu)
      openActionMenu(
        x,
        y,
        entry.menu,
        opens.kind === 'card'
          ? { header: <MemberCard room={opens.room} ik={entry.who} /> }
          : undefined,
        acct,
        identity
      )
  }
  const under = (el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    menu(r.left + 24, r.bottom)
  }
  const icon = look.icon && { ...look.icon, role: mask ? mask(look.icon.role) : look.icon.role }
  const row = (
    <Surface
      as="span"
      row
      pad="sm"
      inset="sides"
      gap="sm"
      tone="plain"
      radius="lg"
      look={`${ROW_HEIGHT[linesOf(entry)]} hover:bg-surface-container-high ${entry.faded ? 'opacity-70' : entry.online ? '' : 'opacity-50'}`}
      place="w-full overflow-hidden"
    >
      <Face entry={entry} />
      <span className="flex min-w-0 flex-1 flex-col">
        {face.kind === 'account' ? (
          <MemberName user={face.user} color={look.color} icon={icon} />
        ) : (
          <Row as="span" gap="2xs" place="min-w-0">
            <Name
              of={p2pName(entry.name, entry.own)}
              color={look.color}
              look="min-w-0 truncate text-sm"
            />
            <RoleIcon emoji={icon?.emoji} role={icon?.role} />
          </Row>
        )}
        {entry.chip && (
          <span className="flex h-4 min-w-0">
            <AccountChip ik={entry.chip} size="short" />
          </span>
        )}
        {entry.note && (
          <span data-member-note className="h-4 truncate text-xs text-on-surface-variant">
            {entry.note}
          </span>
        )}
      </span>
      <RowTimeout t={entry.timeout} />
      {entry.tags.includes('creator') && <Badge tone="tertiary">Creator</Badge>}
      {entry.tags.includes('admin') && <Badge tone="primary">Admin</Badge>}
      {entry.tags.includes('owner') && (
        <span title="Owner" aria-label="Owner" role="img" className="flex shrink-0 text-tertiary">
          <Crown size={14} />
        </span>
      )}
      {entry.shield && <ContactShield kind={entry.shield} size={14} />}
    </Surface>
  )
  const press = entry.menu ? longPress(menu) : {}
  return opens.kind === 'profile' ? (
    <ProfileButton
      user={opens.user}
      server={opens.server}
      data-member={entry.who}
      {...press}
      shape="row"
    >
      {row}
    </ProfileButton>
  ) : (
    <Pressable
      data-member={entry.who}
      {...press}
      shape="row"
      aria-haspopup="menu"
      onClick={e => under(e.currentTarget)}
    >
      {row}
    </Pressable>
  )
}

function Head({ item, masked }: { item: Extract<MemberItem, { kind: 'head' }>; masked: boolean }) {
  return (
    <Inset
      data-member-group={item.key}
      as="p"
      row
      pad="sm"
      inset="sides"
      gap="xs"
      text="xs"
      ink="muted"
      look="h-8 font-medium tracking-wide uppercase"
    >
      {item.dot && (
        <span
          aria-hidden
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: item.dot }}
        />
      )}
      <span className="min-w-0 truncate">{masked ? <Masked text={item.label} /> : item.label}</span>
      {item.count !== null && <span className="shrink-0">({item.count})</span>}
    </Inset>
  )
}

// The member list of a hosted server or a P2P room: its groups, 50 members at a time, each row
// with the member's menu.
function MemberListView({ of }: { of: Members }) {
  const list = useLive(of.list)
  useEffect(() => of.watch(), [of])
  const mask = useMask(list.ownText)
  const { ref, range } = useWindowed(list.items)
  const actor = list.byIdentity ? <PeerActorTag header /> : <ViewActorTag header />
  if (list.state === 'none') return null
  if (list.state === 'loading')
    return (
      <aside className={loadingCls}>
        {actor}
        <MemberListSkeleton seed={list.seed} />
      </aside>
    )
  if (list.state === 'hidden')
    return (
      <aside className={asideCls}>
        {actor}
        <MembersHiddenState why={list.why ?? 'outside'} />
      </aside>
    )
  return (
    <aside ref={ref} data-members aria-label="Members" className={asideCls}>
      {actor}
      <div style={{ height: range.before }} />
      {list.items
        .slice(range.start, range.end)
        .map(item =>
          item.kind === 'head' ? (
            <Head key={item.key} item={item} masked={list.masked} />
          ) : item.kind === 'more' ? (
            <Sentinel key={item.key} onVisible={item.load} />
          ) : (
            <MemberRow key={item.key} entry={item.entry} mask={list.masked ? mask : null} />
          )
        )}
      <div style={{ height: range.after }} />
    </aside>
  )
}

export default function MemberSidebar() {
  const here = useFeature(members)
  return isUnsupported(here) ? null : <MemberListView of={here} />
}

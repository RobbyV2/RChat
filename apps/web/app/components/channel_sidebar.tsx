'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  FolderPlus,
  HeadphoneOff,
  Hash,
  ListFilter,
  Lock,
  MicOff,
  Pin,
  Plus,
  UserPlus,
  Volume2,
} from 'lucide-react'
import {
  badgePings,
  myPerms,
  scopeMuted,
  scopeUnread,
  serverAdminPerms,
  userRefFor,
  useMask,
  useStore,
} from '../lib/store'
import { openActionMenu } from '../lib/actions/menu'
import { useChannelEdit, type Editing } from '../lib/channel_edit'
import { STAFF_MUTED, isGuestName, voiceSelf } from '../lib/guest_voice'
import { useGuestMenu } from './guest_voice_menu'
import { dmSections, type DmSections } from '../lib/nav_layout'
import {
  clearDmFilters,
  dmListPrefs,
  dmRows,
  filtersOn,
  holdOrder,
  unreadDmIds,
  unreadListed,
  type DmListPrefs,
  type DmRows,
} from '../lib/dm_list'
import { enterKey } from '../lib/keys'
import { useAccount } from '../lib/client/react'
import { Perm, hasPerm, type Category, type Channel, type DmSummary } from '../lib/types'
import {
  CATEGORIES_ZONE,
  NO_CATEGORY,
  categoryKey,
  categoryOfZone,
  channelGroups,
  fullIndex,
  zoneOf,
  type ChannelGroup,
} from '../lib/categories'
import { UserAvatar } from './user_avatar'
import { ServerHeader } from './server_header'
import { longPress } from './context_menu'
import { FriendsEntry } from './friends'
import { dragScope, useDrag, type DragSpec } from './drag'
import { profileTrigger } from './profile_card'
import { LiveBadge, VoiceDock } from './voice_grid'
import { Masked, Sentinel, useOwnServer } from './ui'
import { NameWithUsername } from './display_name'
import { useAuthorMembers } from './message_pane'
import { PingBadge } from './ping_badge'
import { scopePings } from '../lib/pings'
import { MutedIcon } from './notify_menu'
import { shownMedia } from '../lib/timeouts'
import { p2p, useP2p } from '../lib/p2p/app'
import { addsContacts, p2pDmSection } from '../lib/p2p/conversations'
import { ContactRow, lastTsOf } from './p2p/p2p_home'
import { P2pBadge } from './p2p/p2p_badge'
import { canView, channelTarget, useViewing } from '../lib/viewing'

const base = 'flex h-full w-60 shrink-0 flex-col bg-surface-container-low'

export function DmRow({
  dm,
  active,
  unread,
  pings,
  shown,
}: {
  dm: DmSummary
  active: boolean
  unread: boolean
  pings: number
  // The rows as the list shows them, for a drop.
  shown?: () => DmSections<number>
}) {
  const acct = useAccount()

  const openDm = useStore(s => s.openDm)
  const placeDm = useStore(s => s.placeDm)
  const { id, other, is_self } = dm
  const muted = useStore(s => scopeMuted(s, { kind: 'dm', id }))
  return (
    <button
      data-dm={id}
      aria-current={active ? 'page' : undefined}
      onClick={() => {
        // A P2P conversation open beside the list gives way.
        if (useP2p.getState().dmList) p2p.closeHome()
        void openDm(id)
      }}
      {...longPress(
        (x, y) => openActionMenu(x, y, { kind: 'dm', dm, where: 'sidebar' }, undefined, acct),
        {
          group: 'dm',
          key: String(id),
          onDrop: ({ zone, index }) =>
            placeDm(id, zone === 'pinned' ? 'pinned' : 'recent', index, shown?.()),
        }
      )}
      className={`mx-2 flex shrink-0 items-center gap-2 rounded-lg px-2 py-1.5 text-sm ${
        active
          ? 'bg-secondary-container text-on-secondary-container'
          : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface'
      } ${muted && !active ? 'opacity-60' : ''}`}
    >
      <UserAvatar
        username={other.username}
        avatarKind={other.avatar_kind}
        avatarColor={other.avatar_color}
        size={28}
      />
      <span className="streamer truncate">
        <NameWithUsername user={other} />
      </span>
      <MutedIcon scope={{ kind: 'dm', id }} />
      {unread && !pings && (
        <span title="Unread" aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-error" />
      )}
      {is_self && (
        <span className="ml-auto shrink-0 rounded-full bg-secondary-container px-2 py-0.5 text-xs text-on-secondary-container">
          you
        </span>
      )}
      <PingBadge count={pings} className={is_self ? '' : 'ml-auto'} />
    </button>
  )
}

function PrivateIcon() {
  return (
    <span title="Private channel" aria-label="Private channel" role="img" className="flex shrink-0">
      <Lock size={12} />
    </span>
  )
}

const NO_ROSTER: string[] = []
// People in a room closed by a local viewing choice stay unnamed and uncounted.
const rosterOf = (
  account: string | null,
  rosters: Record<number, string[]>,
  server: string,
  c: Channel
) =>
  canView(channelTarget(account, 'instance', server, c)) ? (rosters[c.id] ?? NO_ROSTER) : NO_ROSTER

function VoiceChannelRow({
  channel,
  own,
  active,
  connected,
  count,
  onJoin,
  menu,
  drag,
}: {
  channel: Channel
  own: boolean
  active: boolean
  connected: boolean
  count: number
  onJoin: () => void
  menu: (x: number, y: number) => void
  drag?: DragSpec
}) {
  const mask = useMask(own)
  return (
    <button
      title={connected ? 'Open voice channel' : 'Join voice channel'}
      aria-label={`${connected ? 'Open' : 'Join'} voice channel ${mask(channel.name)}${
        count ? `, ${count} connected` : ''
      }`}
      onClick={onJoin}
      {...longPress(menu, drag)}
      className={`group mx-2 flex w-[calc(100%-1rem)] items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm outline-offset-[-2px] transition-colors focus-visible:outline-2 focus-visible:outline-primary active:scale-[0.98] ${
        active
          ? 'bg-secondary-container text-on-secondary-container'
          : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface'
      }`}
    >
      <Volume2 size={16} className={`shrink-0 ${connected ? 'text-status-green' : ''}`} />
      <span className="truncate">
        <Masked text={channel.name} own={own} />
      </span>
      {channel.restrict_view && <PrivateIcon />}
      {count > 0 && (
        <span
          title={`${count} in voice`}
          className="ml-auto shrink-0 rounded-full bg-surface-container-highest px-1.5 text-[11px] leading-4 font-medium text-on-surface-variant tabular-nums"
        >
          {count}
        </span>
      )}
    </button>
  )
}

function VoiceMemberRow({
  username,
  server,
  inRoom,
}: {
  username: string
  server: string
  inRoom: boolean
}) {
  const { rtc } = useAccount()
  const mine = useStore(voiceSelf)
  const selfAudio = useStore(s => s.selfAudio)
  useStore(s => s.rtcTick)
  const user = useStore(s => userRefFor(s, username))
  const self = mine === username
  const silenced = useStore(s => Object.values(s.voiceMuted).some(l => l.includes(username)))
  const hushed = useStore(s => Object.values(s.voiceHushed).some(l => l.includes(username)))
  const menu = useGuestMenu(server, username)
  const speaking = inRoom && rtc.isSpeaking(username) && !silenced && !hushed
  const muted =
    silenced ||
    hushed ||
    (inRoom && (self ? selfAudio.muted : (rtc.peer(username)?.muted ?? false)))
  const deafened = inRoom && self && selfAudio.deafened
  const live = inRoom && (self ? rtc.sharing : shownMedia(rtc.peer(username), silenced).screen)
  return (
    <div
      {...(isGuestName(username) ? (menu ? longPress(menu) : {}) : profileTrigger(user, server))}
      className={`mr-2 ml-7 flex items-center gap-2 rounded-md px-2 py-1 text-sm text-on-surface-variant outline-offset-[-2px] ${
        isGuestName(username)
          ? ''
          : 'cursor-pointer hover:bg-surface-container hover:text-on-surface focus-visible:outline-2 focus-visible:outline-primary active:bg-surface-container-high'
      }`}
    >
      <span
        className={`flex shrink-0 rounded-full transition-shadow ${
          speaking ? 'ring-2 ring-status-green ring-offset-1 ring-offset-surface-container-low' : ''
        }`}
      >
        <UserAvatar
          username={user.username}
          avatarKind={user.avatar_kind}
          avatarColor={user.avatar_color}
          size={22}
        />
      </span>
      <span className={`streamer min-w-0 flex-1 truncate ${speaking ? 'text-on-surface' : ''}`}>
        <NameWithUsername user={user} />
      </span>
      {live && (
        <LiveBadge size="sm" title={self ? "You're sharing your screen" : 'Sharing their screen'} />
      )}
      {muted && !deafened && (
        <span title={hushed ? STAFF_MUTED : 'Muted'} className="flex shrink-0 text-mute-fg">
          <MicOff size={14} />
        </span>
      )}
      {deafened && (
        <span title="Deafened" className="flex shrink-0 text-mute-fg">
          <HeadphoneOff size={14} />
        </span>
      )}
    </div>
  )
}

const DM_LIST_MENU = 'dm-list'

function DmListControl({ prefs }: { prefs: DmListPrefs }) {
  const acct = useAccount()

  const open = useStore(s => s.contextMenu?.owner === DM_LIST_MENU)
  const on = filtersOn(prefs)
  const label = on
    ? `Sort and filter, ${on === 1 ? '1 filter' : `${on} filters`} on`
    : 'Sort and filter'
  return (
    <button
      title={label}
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={e => {
        const r = e.currentTarget.getBoundingClientRect()
        openActionMenu(
          r.left,
          r.bottom + 4,
          { kind: 'dm_list' },
          {
            owner: DM_LIST_MENU,
            header: (
              <span className="text-xs font-medium text-on-surface-variant">Sort and filter</span>
            ),
          },
          acct
        )
      }}
      className={`relative rounded-full p-1 hover:bg-surface-container-high hover:text-on-surface ${
        on || open ? 'text-primary' : 'text-on-surface-variant'
      }`}
    >
      <ListFilter size={16} />
      {on > 0 && (
        <span
          aria-hidden
          data-filter-mark
          className="absolute top-0 right-0 size-2 rounded-full bg-primary ring-2 ring-surface-container-low"
        />
      )}
    </button>
  )
}

// Rows keep their places while the pointer or the keyboard focus is in the list; a layout change
// (a drop, a pin, another sort) shows the new order at once. `tail` is never held.
function useHeldOrder(
  next: DmRows<number>,
  hold: boolean,
  reset: unknown,
  alive: ReadonlySet<number>
): number[] {
  const last = useRef<{ rows: DmRows<number>; reset: unknown } | null>(null)
  const prev = last.current
  const rows = hold && prev && prev.reset === reset ? holdOrder(prev.rows, next, alive) : next
  last.current = { rows, reset }
  return rows.ids
}

// The P2P conversations under the instance's DMs, behind a dashed divider and outside their
// scroll, so loading more DMs never moves them. A conversation opens beside this list; message
// requests open the P2P home on its contacts.
function P2pDms() {
  const account = useP2p(s => s.account)
  const enabled = useP2p(s => s.enabled)
  const contacts = useP2p(s => s.contacts)
  const rooms = useP2p(s => s.rooms)
  const me = useP2p(s => s.me)
  const presence = useP2p(s => s.presence)
  const open = useP2p(s => (s.home && s.dmList ? (s.chat?.peer ?? null) : null))
  const adds = useP2p(addsContacts)
  const section = p2pDmSection({ account, enabled, contacts, lastTs: lastTsOf(rooms, me) })
  if (!section) return null
  return (
    <section
      data-p2p-dms
      aria-label="P2P direct messages"
      className="flex max-h-[45%] shrink-0 flex-col pb-1"
    >
      <div className="flex shrink-0 items-center gap-2 pt-3 pr-3 pb-1 pl-4">
        <span aria-hidden className="h-0 flex-1 border-t border-dashed border-tertiary/70" />
        <P2pBadge />
        <span aria-hidden className="h-0 flex-1 border-t border-dashed border-tertiary/70" />
        {adds && (
          <button
            title="Add contact"
            aria-label="Add contact"
            onClick={() => p2p.openDialog({ kind: 'add' })}
            className="rounded-full p-1 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
          >
            <UserPlus size={16} />
          </button>
        )}
      </div>
      <ul className="flex min-h-0 flex-col overflow-y-auto px-2">
        {section.rows.map(c => (
          <ContactRow
            key={c.ik}
            c={c}
            presence={presence[c.ik] ?? 'offline'}
            active={c.ik === open}
            where="dms"
          />
        ))}
      </ul>
      {section.requests > 0 && (
        <button
          data-p2p-requests
          onClick={p2p.openRequests}
          className="mx-2 shrink-0 rounded-lg px-2 py-1.5 text-left text-sm font-medium text-primary hover:bg-surface-container"
        >
          Message requests ({section.requests})
        </button>
      )}
    </section>
  )
}

function DmSidebar({ dmId }: { dmId: number }) {
  // While a P2P conversation is open beside the list, no instance DM is the current one.
  const beside = useP2p(s => s.home && s.dmList)
  const dms = useStore(s => s.dms)
  const layout = useStore(s => s.layout)
  const dmsMore = useStore(s => s.dmsMore)
  const dmsEdge = useStore(s => s.dmsEdge)
  const loadMoreDms = useStore(s => s.loadMoreDms)
  const ensureDms = useStore(s => s.ensureDms)
  const setDmList = useStore(s => s.setDmList)
  const startDm = useStore(s => s.startDm)
  const dmDrag = useDrag(s => s.group) === 'dm'
  const dragKey = useDrag(s => s.key)
  const dropZone = useDrag(s => s.zone)
  const reads = useStore(s => s.reads)
  const readsReady = useStore(s => s.readsReady)
  const unreadsCut = useStore(s => s.unreadsCut)
  useStore(s => s.notifyPrefs)
  const pings = useStore(badgePings)
  const unread = (scope: string) => scopeUnread(useStore.getState(), scope)
  const pingsOf = (scope: string) => scopePings(pings, scope)
  const [dmInput, setDmInput] = useState<string | null>(null)
  const settled = useRef(false)
  const [pointerIn, setPointerIn] = useState(false)
  const [keyFocus, setKeyFocus] = useState(false)
  const prefs = dmListPrefs(layout)
  const { pinned, recent: order } = useMemo(() => dmSections(dms, layout), [dms, layout])
  const marked = (d: DmSummary) => unread(`d${d.id}`) || pingsOf(`d${d.id}`) > 0
  const unreadAll = prefs.unread && readsReady && unreadListed(reads, unreadsCut)
  const paging = dmsMore && !unreadAll
  const edge = paging ? dmsEdge : null
  const byId = new Map(order.map(d => [d.id, d]))
  const next = dmRows(order, prefs, marked, dmId, edge)
  const held = useHeldOrder(next, pointerIn || keyFocus, layout, new Set(byId.keys()))
  const rest = held.flatMap(id => byId.get(id) ?? [])
  const shownRef = useRef<DmSections<number>>({ pinned: [], recent: [] })
  shownRef.current = { pinned: pinned.map(d => d.id), recent: held }
  const shown = () => shownRef.current
  const wantUnread = prefs.unread || prefs.unreadTop
  const unreadKey = useStore(s => (wantUnread ? unreadDmIds(s.reads).join(',') : ''))
  const [looked, setLooked] = useState('')
  useEffect(() => {
    if (!unreadKey) return
    void ensureDms(unreadKey.split(',').map(Number))
      .catch(() => {})
      .then(() => setLooked(unreadKey))
  }, [unreadKey, ensureDms])
  const submitDm = () => {
    const target = (dmInput ?? '').trim().toLowerCase()
    setDmInput(null)
    if (settled.current) return
    settled.current = true
    if (target) void startDm(target)
  }
  const pinZone = dmDrag && pinned.length === 0
  const pinning = dropZone === 'pinned' && !pinned.some(d => String(d.id) === dragKey)
  const sorted = prefs.sort !== 'custom'
  const row = (dm: DmSummary) => (
    <DmRow
      key={dm.id}
      dm={dm}
      active={!beside && dmId === dm.id}
      unread={unread(`d${dm.id}`)}
      pings={pingsOf(`d${dm.id}`)}
      shown={shown}
    />
  )
  return (
    <aside className={base}>
      <div
        onPointerEnter={() => setPointerIn(true)}
        onPointerLeave={() => setPointerIn(false)}
        onFocus={e => setKeyFocus(e.target.matches(':focus-visible'))}
        onBlur={e => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setKeyFocus(false)
        }}
        className="flex min-h-0 flex-1 flex-col pb-3 last:pb-[max(0.75rem,env(safe-area-inset-bottom))]"
      >
        <div data-dm-scroll ref={dragScope} className="flex min-h-0 flex-col overflow-y-auto">
          <FriendsEntry />
          {pinned.length > 0 && (
            <div
              data-drop-zone="pinned"
              data-drop-label="Pin"
              className={`flex shrink-0 flex-col pb-1 transition-colors ${
                pinning ? 'bg-primary-container/40' : ''
              }`}
            >
              <div className="sticky top-0 z-10 flex items-center gap-1.5 bg-surface-container-low px-4 pt-3 pb-1 text-xs font-medium tracking-wider text-on-surface-variant uppercase">
                <Pin size={12} className="shrink-0" />
                Pinned
              </div>
              {pinned.map(row)}
            </div>
          )}
          <div
            data-drop-zone={pinZone ? 'pinned' : undefined}
            data-drop-label={pinZone ? 'Pin' : undefined}
            className="sticky top-0 z-10 shrink-0 bg-surface-container-low"
          >
            {pinZone ? (
              <div
                className={`mx-2 my-1 flex h-8 items-center justify-center gap-1.5 rounded-lg border-2 border-dashed text-xs font-medium transition-colors ${
                  dropZone === 'pinned'
                    ? 'border-primary bg-primary-container text-on-primary-container'
                    : 'border-outline text-on-surface-variant'
                }`}
              >
                <Pin size={14} className="shrink-0" />
                Drop here to pin
              </div>
            ) : (
              <div className="flex items-center gap-0.5 pt-3 pr-3 pb-1 pl-4">
                <span className="min-w-0 flex-1 truncate text-xs font-medium tracking-wider text-on-surface-variant uppercase">
                  Direct Messages
                </span>
                <DmListControl prefs={prefs} />
                <button
                  title="New direct message"
                  aria-label="New direct message"
                  onClick={() => {
                    settled.current = false
                    setDmInput('')
                  }}
                  className="rounded-full p-1 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
                >
                  <Plus size={16} />
                </button>
              </div>
            )}
          </div>
          {dmInput !== null && (
            <input
              autoFocus
              value={dmInput}
              onChange={e => setDmInput(e.target.value)}
              onKeyDown={e => {
                if (enterKey(e)) submitDm()
                if (e.key === 'Escape') {
                  settled.current = true
                  setDmInput(null)
                }
              }}
              onBlur={submitDm}
              placeholder="username"
              className="mx-2 my-0.5 shrink-0 rounded-lg border border-primary bg-transparent px-2 py-1.5 text-base outline-none md:text-sm"
            />
          )}
          <div
            data-drop-zone="recent"
            data-drop-label="Unpin"
            data-drop-sorted={sorted ? '' : undefined}
            className="flex shrink-0 flex-col"
          >
            {rest.map(row)}
            {rest.length === 0 &&
              filtersOn(prefs) > 0 &&
              !paging &&
              (!unreadKey || looked === unreadKey) && (
                <p
                  data-dm-none
                  className="mx-4 my-2 flex flex-wrap items-baseline gap-x-2 text-sm text-on-surface-variant"
                >
                  <span>No conversations match</span>
                  <button
                    onClick={() => setDmList(clearDmFilters(prefs))}
                    className="rounded font-medium text-primary hover:underline"
                  >
                    Clear filters
                  </button>
                </p>
              )}
            {paging && <Sentinel key={dms.length} onVisible={loadMoreDms} />}
          </div>
        </div>
        <P2pDms />
      </div>
      <VoiceDock />
    </aside>
  )
}

export function ChannelSidebar() {
  const acct = useAccount()

  const view = useStore(s => s.view)
  const ownServer = useOwnServer(view?.kind === 'channel' ? view.server : null)
  const perms = useStore(s => (s.view?.kind === 'channel' ? myPerms(s, s.view.server) : 0))
  const panelPerms = useStore(s =>
    s.view?.kind === 'channel' ? serverAdminPerms(s, s.view.server) : 0
  )
  const servers = useStore(s => s.servers)
  const layout = useStore(s => s.layout)
  const dragGroup = useDrag(s => s.group)
  const dropZone = useDrag(s => s.zone)
  const openChannel = useStore(s => s.openChannel)
  const openDialog = useStore(s => s.openDialog)
  const createChannel = useStore(s => s.createChannel)
  const moveChannel = useStore(s => s.moveChannel)
  const moveCategory = useStore(s => s.moveCategory)
  const setCategoriesCollapsed = useStore(s => s.setCategoriesCollapsed)
  const renameChannel = useStore(s => s.renameChannel)
  const joinVoice = useStore(s => s.joinVoice)
  const voiceUsers = useStore(s => s.voiceUsers)
  const voice = useStore(s => s.voice)
  useStore(s => s.reads)
  useStore(s => s.notifyPrefs)
  const pings = useStore(badgePings)
  const unread = (scope: string) => scopeUnread(useStore.getState(), scope)
  const pingsOf = (scope: string) => scopePings(pings, scope)
  useStore(s => s.rtcTick)
  useStore(s => s.members)
  useStore(s => s.memberInfo)
  useStore(s => s.me)
  const editing = useChannelEdit(e => e.editing)
  const name = useChannelEdit(e => e.name)
  const voiceServer = view?.kind === 'channel' ? view.server : null
  useViewing(s => s.revision)
  const account = useStore(s => s.me?.username ?? null)
  const voiceKey = useStore(s => {
    const channels = voiceServer ? s.servers[voiceServer]?.channels : undefined
    if (!channels || !voiceServer) return ''
    const names = channels
      .flatMap(c =>
        c.kind === 'voice' ? rosterOf(s.me?.username ?? null, s.voiceUsers, voiceServer, c) : []
      )
      .filter(u => !isGuestName(u))
    return [...new Set(names)].sort().join('\n')
  })
  useAuthorMembers(voiceServer, voiceKey)

  if (view?.kind === 'dm') return <DmSidebar dmId={view.dmId} />

  if (!view) return null
  const detail = servers[view.server]
  if (!detail) return <aside className={base} />
  const canManage = hasPerm(perms, Perm.ManageChannels)
  const server = detail.name
  const groups = channelGroups(detail, canManage)
  const shut = new Set(layout.collapsed[server] ?? [])
  const activeId = view?.kind === 'channel' ? view.channelId : null
  const channelDrag = dragGroup === 'channel'

  // Here only: a field started for another server waits for it.
  const editingHere: Editing | null = editing?.server === server ? editing : null

  const submit = () => {
    const edit = acct.channelEdit.getState()
    const current = edit.editing
    const trimmed = edit.name.trim()
    edit.stop()
    if (!current || !trimmed) return
    switch (current.mode) {
      case 'create':
        void createChannel(
          current.server,
          trimmed,
          current.kind,
          current.category,
          current.kind === 'text' && current.textOnly
        )
        return
      case 'rename':
        void renameChannel(current.id, trimmed)
        return
    }
  }

  const createIn = (category: number | null) => {
    if (category !== null) setCategoriesCollapsed(server, [category], false)
    acct.channelEdit.getState().start({ mode: 'create', server, kind: 'text', category }, '')
  }

  const allCategories = groups.categories.map(g => g.category.id)

  const channelMenu = (channel: Channel) => (x: number, y: number) =>
    openActionMenu(x, y, { kind: 'channel', server, channel }, undefined, acct)

  const categoryMenu = (category: Category) => (x: number, y: number) =>
    openActionMenu(x, y, { kind: 'category', server, category }, undefined, acct)

  const keepShown = (c: Channel) => c.id === activeId || voice?.channelId === c.id

  const shownIn = (category: number | null) => {
    const group =
      category === null
        ? groups.uncategorized
        : groups.categories.find(g => g.category.id === category)?.channels
    if (!group) return { full: [], shown: [] }
    const full = group.map(c => c.id)
    const open = category === null || !shut.has(category)
    return { full, shown: open ? full : group.filter(c => keepShown(c)).map(c => c.id) }
  }

  const channelDragSpec = (c: Channel): DragSpec | undefined =>
    canManage
      ? {
          group: 'channel',
          key: `ch:${c.id}`,
          zones: zone => categoryOfZone(zone) !== undefined,
          onDrop: ({ zone, index }) => {
            const category = categoryOfZone(zone)
            if (category === undefined) return
            const { full, shown } = shownIn(category)
            moveChannel(server, c.id, category, fullIndex(full, shown, c.id, index))
          },
        }
      : undefined

  const categoryDragSpec = (category: Category): DragSpec | undefined =>
    canManage
      ? {
          group: 'category',
          key: categoryKey(category.id),
          zones: zone => zone === CATEGORIES_ZONE,
          onDrop: ({ index }) =>
            moveCategory(
              server,
              category.id,
              fullIndex(allCategories, allCategories, category.id, index)
            ),
        }
      : undefined

  const editInput = (
    <input
      autoFocus
      value={name}
      onChange={e => acct.channelEdit.getState().setName(e.target.value)}
      onKeyDown={e => {
        if (enterKey(e)) submit()
        if (e.key === 'Escape') acct.channelEdit.getState().stop()
      }}
      onBlur={editingHere?.mode === 'rename' ? submit : undefined}
      placeholder="channel name"
      className="mx-2 my-0.5 min-w-0 flex-1 rounded-lg border border-primary bg-transparent px-2 py-1.5 text-base outline-none md:text-sm"
    />
  )

  const createRow = (category: number | null) =>
    editingHere?.mode === 'create' && editingHere.category === category ? (
      <span
        className="flex flex-wrap items-center"
        onBlur={e => {
          if (!e.currentTarget.contains(e.relatedTarget)) submit()
        }}
      >
        <span className="flex shrink-0 gap-0.5 pl-2">
          <button
            title="Text channel"
            aria-label="Text channel"
            onMouseDown={e => e.preventDefault()}
            onClick={() => acct.channelEdit.getState().setKind('text')}
            className={`rounded-lg p-1.5 ${
              editingHere.kind === 'text'
                ? 'bg-secondary-container text-on-secondary-container'
                : 'text-on-surface-variant hover:bg-surface-container'
            }`}
          >
            <Hash size={14} />
          </button>
          <button
            title="Voice channel"
            aria-label="Voice channel"
            onMouseDown={e => e.preventDefault()}
            onClick={() => acct.channelEdit.getState().setKind('voice')}
            className={`rounded-lg p-1.5 ${
              editingHere.kind === 'voice'
                ? 'bg-secondary-container text-on-secondary-container'
                : 'text-on-surface-variant hover:bg-surface-container'
            }`}
          >
            <Volume2 size={14} />
          </button>
        </span>
        {editInput}
        {editingHere.kind === 'text' && (
          <label
            onMouseDown={e => e.preventDefault()}
            className="mx-2 flex basis-full items-center gap-2 py-1 text-sm"
          >
            <input
              type="checkbox"
              className="accent-primary"
              checked={!!editingHere.textOnly}
              onChange={e => acct.channelEdit.getState().setTextOnly(e.target.checked)}
            />
            Text only
          </label>
        )}
      </span>
    ) : null

  const textRow = (c: Channel) => (
    <button
      key={c.id}
      onClick={() => void openChannel(server, c.id)}
      {...longPress(channelMenu(c), channelDragSpec(c))}
      className={`mx-2 flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm ${
        activeId === c.id
          ? 'bg-secondary-container text-on-secondary-container'
          : `text-on-surface-variant hover:bg-surface-container hover:text-on-surface ${
              scopeMuted(useStore.getState(), { kind: 'channel', id: c.id, server })
                ? 'opacity-60'
                : ''
            }`
      }`}
    >
      <Hash size={16} className="shrink-0" />
      <span className="truncate">
        <Masked text={c.name} own={ownServer} />
      </span>
      {c.restrict_view && <PrivateIcon />}
      <MutedIcon scope={{ kind: 'channel', id: c.id, server }} />
      {pingsOf(`c${c.id}`) > 0 ? (
        <PingBadge count={pingsOf(`c${c.id}`)} className="ml-auto" />
      ) : (
        unread(`c${c.id}`) && (
          <span
            title="Unread"
            aria-hidden
            className="ml-auto h-2 w-2 shrink-0 rounded-full bg-error"
          />
        )
      )}
    </button>
  )

  const voiceRow = (c: Channel) => {
    const roster = rosterOf(account, voiceUsers, server, c)
    return (
      <div key={c.id} data-drag-box className="flex flex-col rounded-lg">
        <VoiceChannelRow
          channel={c}
          own={ownServer}
          active={activeId === c.id}
          connected={voice?.channelId === c.id}
          count={roster.length}
          onJoin={() => void joinVoice(server, c.id)}
          menu={channelMenu(c)}
          drag={channelDragSpec(c)}
        />
        {roster.map(u => (
          <VoiceMemberRow key={u} username={u} server={server} inRoom={voice?.channelId === c.id} />
        ))}
      </div>
    )
  }

  const row = (c: Channel) =>
    editingHere?.mode === 'rename' && editingHere.id === c.id ? (
      <span key={c.id} className="flex">
        {editInput}
      </span>
    ) : c.kind === 'voice' ? (
      voiceRow(c)
    ) : (
      textRow(c)
    )

  const zoneCls = (zone: string, empty: boolean) =>
    `flex flex-col rounded-lg transition-colors ${
      channelDrag && empty ? 'mx-2 min-h-8 border-2 border-dashed border-outline-variant' : ''
    } ${channelDrag && dropZone === zone ? 'bg-primary-container/40' : ''}`

  const categoryBlock = ({ category, channels }: ChannelGroup) => {
    const open = !shut.has(category.id)
    const visible = open ? channels : channels.filter(keepShown)
    const zone = zoneOf(category.id)
    const hiddenPings = open
      ? 0
      : channels.reduce((n, c) => n + (keepShown(c) ? 0 : pingsOf(`c${c.id}`)), 0)
    const hiddenUnread =
      !open && channels.some(c => c.kind === 'text' && !keepShown(c) && unread(`c${c.id}`))
    return (
      <div key={category.id} data-drag-box className="group/cat flex flex-col rounded-lg pt-3">
        <div className="flex items-center pr-2">
          <button
            aria-expanded={open}
            onClick={() => setCategoriesCollapsed(server, [category.id], open)}
            {...longPress(categoryMenu(category), categoryDragSpec(category))}
            className="flex min-w-0 flex-1 items-center gap-1 rounded-md py-1 pr-1 pl-2 text-xs font-medium tracking-wider text-on-surface-variant uppercase outline-offset-[-2px] hover:text-on-surface focus-visible:outline-2 focus-visible:outline-primary"
          >
            {open ? (
              <ChevronDown size={14} className="shrink-0" />
            ) : (
              <ChevronRight size={14} className="shrink-0" />
            )}
            <span className="truncate">
              <Masked text={category.name} own={ownServer} />
            </span>
            {hiddenPings > 0 ? (
              <PingBadge count={hiddenPings} className="ml-auto" />
            ) : (
              hiddenUnread && (
                <span
                  title="Unread"
                  aria-hidden
                  className="ml-auto h-2 w-2 shrink-0 rounded-full bg-error"
                />
              )
            )}
          </button>
          {canManage && (
            <button
              title={`Create channel in ${category.name}`}
              aria-label={`Create channel in ${category.name}`}
              onClick={() => createIn(category.id)}
              className="shrink-0 rounded-full p-1 text-on-surface-variant opacity-100 hover:bg-surface-container-high hover:text-on-surface focus-visible:opacity-100 md:opacity-0 md:group-hover/cat:opacity-100"
            >
              <Plus size={14} />
            </button>
          )}
        </div>
        <div
          data-drop-zone={zone}
          data-drop-label={category.name}
          className={zoneCls(zone, visible.length === 0)}
        >
          {visible.map(row)}
          {createRow(category.id)}
        </div>
      </div>
    )
  }

  return (
    <aside className={base}>
      <ServerHeader
        server={server}
        displayName={detail.display_name}
        bannerColor={detail.banner_color}
        nameColor={detail.name_color}
        onSettings={
          panelPerms !== 0 ? () => openDialog({ kind: 'server_settings', server }) : undefined
        }
      />
      <div className="flex items-center justify-between px-4 pt-3 pb-1">
        <span className="text-xs font-medium tracking-wider text-on-surface-variant uppercase">
          Channels
        </span>
        {canManage && (
          <span className="flex items-center gap-0.5">
            <button
              title="Create category"
              aria-label="Create category"
              onClick={() => openDialog({ kind: 'category', server })}
              className="rounded-full p-1 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
            >
              <FolderPlus size={16} />
            </button>
            <button
              title="Create channel"
              aria-label="Create channel"
              onClick={() => createIn(null)}
              className="rounded-full p-1 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
            >
              <Plus size={16} />
            </button>
          </span>
        )}
      </div>
      <div ref={dragScope} className="flex flex-1 flex-col overflow-y-auto pb-3">
        <div
          data-drop-zone={NO_CATEGORY}
          data-drop-label="No category"
          className={zoneCls(
            NO_CATEGORY,
            groups.uncategorized.length === 0 && groups.categories.length > 0
          )}
        >
          {groups.uncategorized.map(row)}
          {createRow(null)}
        </div>
        <div data-drop-zone={CATEGORIES_ZONE} className="flex flex-col">
          {groups.categories.map(categoryBlock)}
        </div>
      </div>
      <VoiceDock />
    </aside>
  )
}

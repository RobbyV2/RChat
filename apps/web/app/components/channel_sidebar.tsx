'use client'
import { asAccount } from '../lib/people'
import { personName } from '../lib/names'
import { Name } from './name'
import { useP2pApp, useP2p, P2pProvider } from '../lib/client/p2p_react'

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  ChevronDown,
  ChevronRight,
  FolderPlus,
  Hash,
  ListFilter,
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
  useStore,
} from '../lib/store'
import { openActionMenu } from '../lib/actions/menu'
import { useChannelEdit, type Editing } from '../lib/channel_edit'
import { isGuestName } from '../lib/guest_voice'
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
import { dmBlocks } from '../lib/client/dm_blocks'
import { routeName } from '../lib/client/route_name'
import { client } from '../lib/client/client'
import { ownInstance } from '../lib/instances'
import { createSwitcherSource, type SwitcherRow } from '../lib/client/switcher_rows'
import { switchActor, switcherSession } from '../lib/client/switch_actor'
import type { AccountSession } from '../lib/client/session'
import { useAddingAllowed } from './add_instance'
import { AccountProvider, useAccount, useStoreApi } from '../lib/client/react'
import { Perm, hasPerm, type Category, type Channel, type DmSummary } from '../lib/types'
import {
  CATEGORIES_ZONE,
  NO_CATEGORY,
  categoryKey,
  categoryOfZone,
  channelGroups,
  fullIndex,
  zoneOf,
} from '../lib/categories'
import { UserAvatar } from './user_avatar'
import { ServerHeader } from './server_header'
import { longPress } from './context_menu'
import { ChannelList } from './channel_list'
import { VoiceRow } from './voice_row'
import { featureAt, isUnsupported } from '../lib/place/feature'
import { channels as channelsFeature, noChannels, type ChannelEntry } from '../lib/place/channels'
import { FriendsEntry } from './friends'
import { dragScope, useDrag, type DragSpec } from './drag'
import { VoiceDock } from './voice_grid'
import { Button, IconButton, LinkButton } from './controls'
import { Row, Surface } from './layout'
import { Sentinel, useOwnServer } from './ui'
import { useAuthorMembers } from './message_pane'
import { PingBadge } from './ping_badge'
import { ChannelEnd, useHostedTypers } from './typing_indicator'
import { scopePings } from '../lib/pings'
import { MutedIcon } from './notify_menu'
import { useHostedServer, useLive } from '../lib/place/react'

import { addsContacts, p2pDmSection } from '../lib/p2p/conversations'
import { ContactRow, lastTsOf } from './p2p/p2p_home'
import { P2pBadge } from './p2p/p2p_badge'
import { ChannelListSkeleton, DmListSkeleton, Held } from './skeletons'
import { channelTarget } from '../lib/viewing'

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
        const switching = client.shown() !== acct
        if (switching && !client.show(acct)) return
        acct.identities.viewed()?.p2p.closeHome()
        void openDm(id, switching ? 'replace' : 'push')
      }}
      {...longPress(
        (x, y) => openActionMenu(x, y, { kind: 'dm', dm, where: 'sidebar' }, undefined, acct),
        {
          group: 'dm:' + acct.renderKey,
          key: String(id),
          onDrop: ({ zone, index }) =>
            placeDm(id, zone === 'pinned' ? 'pinned' : 'recent', index, shown?.()),
        }
      )}
      className={`mx-2 flex shrink-0 items-center gap-2 rounded-lg px-2 py-1.5 text-sm pointer-coarse:min-h-11 ${
        active
          ? 'bg-secondary-container text-on-secondary-container'
          : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface'
      } ${muted && !active ? 'opacity-60' : ''}`}
    >
      <UserAvatar person={asAccount(other, 'dm')} size={28} />
      <Name of={personName(asAccount(other, 'dm'))} withUsername look="truncate" />
      <MutedIcon scope={{ kind: 'dm', id }} />
      {is_self ? (
        <>
          <span className="ml-auto shrink-0 rounded-full bg-secondary-container px-2 py-0.5 text-xs text-on-secondary-container">
            you
          </span>
          <PingBadge count={pings} />
        </>
      ) : (
        <DmRowEnd id={id} unread={unread} pings={pings} />
      )}
    </button>
  )
}

// The end of a DM row: typing dots in place of the unread dot (just before a ping count), else
// the unread dot after the name and the ping count at the end.
function DmRowEnd({ id, unread, pings }: { id: number; unread: boolean; pings: number }) {
  const typers = useHostedTypers([`d${id}`], null)
  if (typers.length) return <ChannelEnd typers={typers} pings={pings} unread={unread} />
  return (
    <>
      {unread && !pings && (
        <span title="Unread" aria-hidden className="h-2 w-2 shrink-0 rounded-full bg-error" />
      )}
      <PingBadge count={pings} className="ml-auto" />
    </>
  )
}

// A channel row's (or a folded category's) end, with who types in `scopes`.
function HostedChannelEnd({
  scopes,
  server,
  pings,
  unread,
}: {
  scopes: readonly string[]
  server: string
  pings: number
  unread: boolean
}) {
  const typers = useHostedTypers(scopes, server)
  return <ChannelEnd typers={typers} pings={pings} unread={unread} />
}

const NO_ROSTER: string[] = []
// People in a room closed by a local viewing choice stay unnamed and uncounted.
const rosterOf = (
  owner: ReturnType<typeof useAccount>,
  account: string | null,
  rosters: Record<number, string[]>,
  server: string,
  c: Channel
) =>
  owner.viewing.canView(channelTarget(account, 'instance', server, c, owner.conn))
    ? (rosters[c.id] ?? NO_ROSTER)
    : NO_ROSTER

const DM_LIST_MENU = 'dm-list'

function DmListControl({ prefs }: { prefs: DmListPrefs }) {
  const acct = useAccount()

  const open = useStore(s => s.contextMenu?.owner === DM_LIST_MENU)
  const on = filtersOn(prefs)
  const label = on
    ? `Sort and filter, ${on === 1 ? '1 filter' : `${on} filters`} on`
    : 'Sort and filter'
  return (
    <IconButton
      icon={ListFilter}
      label={label}
      tone={on ? 'primary' : 'plain'}
      size="sm"
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
    >
      {on > 0 && (
        <span
          aria-hidden
          data-filter-mark
          className="absolute top-0 right-0 size-2 rounded-full bg-primary ring-2 ring-surface-container-low"
        />
      )}
    </IconButton>
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
function P2pDms({ peer, label }: { peer?: SwitcherRow; label?: string } = {}) {
  const owner = useAccount()
  const identity = useP2pApp()
  const p2p = identity?.p2p

  const account = useP2p(s => s.account)
  const enabled = useP2p(s => s.enabled)
  const contacts = useP2p(s => s.contacts)
  const rooms = useP2p(s => s.rooms)
  const me = useP2p(s => s.me)
  const presence = useP2p(s => s.presence)
  const open = useP2p(s => (s.home && s.dmList ? (s.chat?.peer ?? null) : null))
  const adds = useP2p(addsContacts)
  const loading = useP2p(s => s.loading)
  const section = p2pDmSection({ account, enabled, contacts, lastTs: lastTsOf(rooms, me) })
  if (!section && !peer) return null
  const selectIdentity = () => {
    if (!identity) return
    if (client.shown() !== owner) client.show(owner)
    owner.identities.show(identity)
  }
  return (
    <section
      data-p2p-dms
      aria-label="P2P direct messages"
      className={'flex shrink-0 flex-col pb-1' + (label ? '' : ' max-h-9/20')}
    >
      <Surface pad="lg" inset="bar" tone="plain" radius="none" place="shrink-0">
        <Row gap="sm">
          <span aria-hidden className="h-0 flex-1 border-t border-dashed border-tertiary/70" />
          <P2pBadge />
          {peer && (
            <button
              className="streamer truncate text-xs hover:underline"
              onClick={() =>
                void switchActor(peer, client.shown()).catch(e =>
                  owner.store.getState().setError(String(e))
                )
              }
            >
              {label}
            </button>
          )}
          <span aria-hidden className="h-0 flex-1 border-t border-dashed border-tertiary/70" />
          {adds && (
            <IconButton
              icon={UserPlus}
              label="Add contact"
              size="sm"
              onClick={() => {
                selectIdentity()
                p2p?.openDialog({ kind: 'add' })
              }}
            />
          )}
        </Row>
      </Surface>
      {loading && section && !section.rows.length && (
        <Held>
          <Surface pad="sm" tone="plain" radius="none">
            <DmListSkeleton seed={identity?.localId ?? 'p2p'} rows={3} label="Loading contacts" />
          </Surface>
        </Held>
      )}
      <Surface
        as="ul"
        onClickCapture={selectIdentity}
        pad="sm"
        tone="plain"
        radius="none"
        place="min-h-0 overflow-y-auto"
      >
        {section?.rows.map(c => (
          <ContactRow
            key={c.ik}
            c={c}
            presence={presence[c.ik] ?? 'offline'}
            active={
              c.ik === open &&
              (!label || (client.shown() === owner && owner.identities.viewed() === identity))
            }
            where="dms"
          />
        ))}
      </Surface>
      {section && section.requests > 0 && (
        <button
          data-p2p-requests
          onClick={() => {
            selectIdentity()
            p2p?.openRequests()
          }}
          className="mx-2 shrink-0 rounded-lg px-2 py-1.5 text-left text-sm font-medium text-primary hover:bg-surface-container pointer-coarse:min-h-11"
        >
          Message requests ({section.requests})
        </button>
      )}
    </section>
  )
}

// `connecting`: the account is starting, so its conversations may not be loaded yet.
export function DmBlock({
  dmId,
  label,
  peers,
  accounts,
  connecting = false,
}: {
  dmId: number
  label?: string
  peers?: { row: SwitcherRow; label: string }[]
  accounts: AccountSession[]
  connecting?: boolean
}) {
  const acct = useAccount()
  const [collapsed, collapse] = useState(false)
  const [as, setAs] = useState(acct)

  const store = useStoreApi()
  // While a P2P conversation is open beside the list, no instance DM is the current one.
  const beside = useP2p(s => s.home && s.dmList)
  const dms = useStore(s => s.dms)
  const starting = useStore(s => connecting && s.me === null && !s.bootError)
  const layout = useStore(s => s.layout)
  const dmsMore = useStore(s => s.dmsMore)
  const dmsEdge = useStore(s => s.dmsEdge)
  const loadMoreDms = useStore(s => s.loadMoreDms)
  const ensureDms = useStore(s => s.ensureDms)
  const setDmList = useStore(s => s.setDmList)
  const dmDrag = useDrag(s => s.group) === 'dm:' + acct.renderKey
  const dragKey = useDrag(s => s.key)
  const dropZone = useDrag(s => s.zone)
  const reads = useStore(s => s.reads)
  const readsReady = useStore(s => s.readsReady)
  const unreadsCut = useStore(s => s.unreadsCut)
  useStore(s => s.notifyPrefs)
  const pings = useStore(badgePings)
  const unread = (scope: string) => scopeUnread(store.getState(), scope)
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
  const submitDm = async () => {
    const target = (dmInput ?? '').trim().toLowerCase()
    setDmInput(null)
    if (settled.current) return
    settled.current = true
    if (!target) return
    const result = routeName(
      target,
      as,
      accounts
        .filter(a => {
          const state = a.store.getState()
          return !state.guest && (state.me || a.credentialTarget)
        })
        .map(a => ({ account: a, host: a.conn.host, lastShown: client.accounts.lastShown(a) }))
    )
    if (!result.account) {
      client.shown().store.getState().setError(result.error)
      return
    }
    const owner = result.account
    const username = owner.store.getState().me?.username ?? owner.credentialTarget
    const origin = owner.conn.origin
    const switching = client.shown() !== owner
    if (switching) client.show(owner)
    if (!owner.store.getState().me) {
      await owner.store
        .getState()
        .bootstrap()
        .catch(() => {})
      if (
        client.shown() !== owner ||
        owner.conn.origin !== origin ||
        !username ||
        owner.store.getState().me?.username !== username
      )
        return
    }
    owner.identities.viewed()?.p2p.closeHome()
    void owner.store.getState().startDm(result.name, switching ? 'replace' : 'push')
  }
  const pinZone = dmDrag && pinned.length === 0
  const pinning = dmDrag && dropZone === 'pinned' && !pinned.some(d => String(d.id) === dragKey)
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
    <>
      <div
        onPointerEnter={() => setPointerIn(true)}
        onPointerLeave={() => setPointerIn(false)}
        onFocus={e => setKeyFocus(e.target.matches(':focus-visible'))}
        onBlur={e => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setKeyFocus(false)
        }}
        className="flex min-h-0 flex-1 flex-col pb-3 last:pb-[max(0.75rem,env(safe-area-inset-bottom))]"
      >
        <div
          data-dm-scroll
          data-contained-drop={label ? '' : undefined}
          ref={dragScope}
          className="flex min-h-0 flex-col overflow-y-auto"
        >
          {!peers && <FriendsEntry />}
          {label && (
            <Surface pad="md" inset="bar" tone="plain" radius="none">
              <Row gap="none">
                <Row
                  as="button"
                  aria-expanded={!collapsed}
                  onClick={() => collapse(!collapsed)}
                  gap="2xs"
                  text="sm"
                  look="font-medium pointer-coarse:min-h-11"
                  place="min-w-0 flex-1"
                >
                  {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  <span className="streamer truncate">{label}</span>
                </Row>
                <IconButton
                  icon={Plus}
                  label="New direct message"
                  size="sm"
                  onClick={() => {
                    collapse(false)
                    settled.current = false
                    setAs(acct)
                    setDmInput('')
                  }}
                />
              </Row>
            </Surface>
          )}
          {!collapsed && (
            <>
              {pinned.length > 0 && (
                <div
                  data-drop-zone="pinned"
                  data-drop-label="Pin"
                  className={`flex shrink-0 flex-col pb-1 transition-colors ${
                    pinning ? 'bg-primary-container/40' : ''
                  }`}
                >
                  <Surface
                    pad="lg"
                    inset="bar"
                    tone="low"
                    radius="none"
                    place="sticky top-0 z-raised"
                  >
                    <p className="text-xs font-medium tracking-wider text-on-surface-variant uppercase">
                      <Row as="span" gap="xs">
                        <Pin size={12} className="shrink-0" />
                        Pinned
                      </Row>
                    </p>
                  </Surface>
                  {pinned.map(row)}
                </div>
              )}
              <div
                data-drop-zone={pinZone ? 'pinned' : undefined}
                data-drop-label={pinZone ? 'Pin' : undefined}
                className="sticky top-0 z-raised shrink-0 bg-surface-container-low"
              >
                {pinZone ? (
                  <Surface pad="sm" inset="bar" tone="plain" radius="none">
                    <div
                      className={`flex h-8 items-center justify-center rounded-lg border-2 border-dashed text-xs font-medium transition-colors ${
                        dropZone === 'pinned'
                          ? 'border-primary bg-primary-container text-on-primary-container'
                          : 'border-outline text-on-surface-variant'
                      }`}
                    >
                      <Row as="span" gap="xs">
                        <Pin size={14} className="shrink-0" />
                        Drop here to pin
                      </Row>
                    </div>
                  </Surface>
                ) : (
                  <Surface pad="lg" inset="bar" tone="plain" radius="none">
                    <Row gap="3xs">
                      <span className="min-w-0 flex-1 truncate text-xs font-medium tracking-wider text-on-surface-variant uppercase">
                        Direct Messages
                      </span>
                      <DmListControl prefs={prefs} />
                      {!label && (
                        <IconButton
                          icon={Plus}
                          label="New direct message"
                          size="sm"
                          onClick={() => {
                            settled.current = false
                            setAs(acct)
                            setDmInput('')
                          }}
                        />
                      )}
                    </Row>
                  </Surface>
                )}
              </div>
              {dmInput !== null && (
                <Surface pad="sm" gap="2xs" tone="plain" radius="none">
                  {accounts.length > 1 && (
                    <label className="text-xs">
                      As{' '}
                      <select
                        aria-label="As"
                        className="streamer"
                        value={as.renderKey}
                        onChange={e =>
                          setAs(accounts.find(a => a.renderKey === Number(e.target.value)) ?? acct)
                        }
                      >
                        {accounts.map(a => (
                          <option key={a.renderKey} value={a.renderKey}>
                            {a.store.getState().me?.username ?? a.credentialTarget}@{a.conn.host}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
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
                    onBlur={accounts.length > 1 ? undefined : submitDm}
                    placeholder={accounts.length > 1 ? 'username or username@host' : 'username'}
                    className="shrink-0 rounded-lg border border-primary bg-transparent px-2 py-1.5 text-base outline-none md:text-sm"
                  />
                  {accounts.length > 1 && (
                    <Button onClick={submitDm} place="self-start">
                      Start message
                    </Button>
                  )}
                </Surface>
              )}
              <div
                data-drop-zone="recent"
                data-drop-label="Unpin"
                data-drop-sorted={sorted ? '' : undefined}
                className="flex shrink-0 flex-col"
              >
                {rest.map(row)}
                {rest.length === 0 &&
                  (starting ||
                    (filtersOn(prefs) > 0 && !paging && !!unreadKey && looked !== unreadKey)) && (
                    <Surface pad="sm" tone="plain" radius="none">
                      <DmListSkeleton seed={label ?? 'dms'} label="Loading direct messages" />
                    </Surface>
                  )}
                {rest.length === 0 &&
                  filtersOn(prefs) > 0 &&
                  !paging &&
                  (!unreadKey || looked === unreadKey) && (
                    <Surface pad="lg" tone="plain" radius="none">
                      <Row as="p" data-dm-none gap="sm" align="baseline" wrap text="sm" ink="muted">
                        <span>No conversations match</span>
                        <LinkButton onClick={() => setDmList(clearDmFilters(prefs))}>
                          Clear filters
                        </LinkButton>
                      </Row>
                    </Surface>
                  )}
                {paging && <Sentinel key={dms.length} onVisible={loadMoreDms} />}
              </div>
            </>
          )}
        </div>
        {!collapsed &&
          (peers ? (
            peers.map(peer => (
              <P2pProvider
                key={peer.row.local}
                identity={acct.identities.get(peer.row.local!) ?? null}
              >
                <P2pDms peer={peer.row} label={peer.label} />
              </P2pProvider>
            ))
          ) : (
            <P2pDms />
          ))}
      </div>
    </>
  )
}

function DmSidebar({ dmId }: { dmId: number }) {
  const acct = useAccount()
  const allowed = useAddingAllowed()
  const [source] = useState(createSwitcherSource)
  const rows = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
  const groups = dmBlocks(rows.groups, allowed ? undefined : ownInstance()?.origin, switcherSession)
  const accounts = groups.flatMap(g => g.owners.map(o => o.owner))
  const grouped =
    accounts.length > 1 ||
    groups.some(g => g.peers.length > 1 || g.peers.some(p => p.status === 'Paused'))
  const incoming = useSyncExternalStore(
    fn => {
      const off = accounts.map(a => a.counts.subscribe(fn))
      return () => off.forEach(stop => stop())
    },
    () => accounts.reduce((n, a) => n + a.counts.breakdown().incoming, 0),
    () => accounts.reduce((n, a) => n + a.store.getInitialState().friendCounts.incoming, 0)
  )
  return (
    <aside className={base}>
      {grouped && <FriendsEntry incomingTotal={accounts.length > 1 ? incoming : undefined} />}
      {grouped ? (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {groups.map(g => (
            <div key={g.origin}>
              {groups.length > 1 && (
                <Surface pad="lg" inset="bar" tone="plain" radius="none">
                  <h3 className="streamer text-xs font-semibold uppercase">{g.name}</h3>
                </Surface>
              )}
              {g.owners.map(({ row, owner }) => (
                <section
                  key={JSON.stringify([owner.renderKey, row.username])}
                  data-dm-account={row.username}
                  data-dm-origin={g.origin}
                >
                  <AccountProvider session={owner}>
                    <P2pProvider identity={owner.identities.viewed() ?? null}>
                      <DmBlock
                        dmId={owner === acct ? dmId : -1}
                        accounts={accounts}
                        connecting={row.status === 'Connecting'}
                        label={accounts.length > 1 ? row.username + ' · ' + g.name : undefined}
                        peers={g.peers
                          .filter(p => p.username === row.username)
                          .map(p => ({
                            row: p,
                            label: p.display + ' · P2P · ' + row.username + ' · ' + g.name,
                          }))}
                      />
                    </P2pProvider>
                  </AccountProvider>
                </section>
              ))}
            </div>
          ))}
        </div>
      ) : (
        <DmBlock dmId={dmId} accounts={[acct]} />
      )}
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
  const openDialog = useStore(s => s.openDialog)
  const createChannel = useStore(s => s.createChannel)
  const moveChannel = useStore(s => s.moveChannel)
  const moveCategory = useStore(s => s.moveCategory)
  const setCategoriesCollapsed = useStore(s => s.setCategoriesCollapsed)
  const renameChannel = useStore(s => s.renameChannel)
  const voice = useStore(s => s.voice)
  useStore(s => s.reads)
  useStore(s => s.notifyPrefs)
  const pings = useStore(badgePings)
  const unread = (scope: string) => scopeUnread(acct.store.getState(), scope)
  const pingsOf = (scope: string) => scopePings(pings, scope)
  useStore(s => s.rtcTick)
  useStore(s => s.members)
  useStore(s => s.memberInfo)
  useStore(s => s.me)
  const editing = useChannelEdit(e => e.editing)
  const name = useChannelEdit(e => e.name)
  const voiceServer = view?.kind === 'channel' ? view.server : null
  acct.viewing.useViewing(s => s.revision)
  const voiceKey = useStore(s => {
    const channels = voiceServer ? s.servers[voiceServer]?.channels : undefined
    if (!channels || !voiceServer) return ''
    const names = channels
      .flatMap(c =>
        c.kind === 'voice'
          ? rosterOf(acct, s.me?.username ?? null, s.voiceUsers, voiceServer, c)
          : []
      )
      .filter(u => !isGuestName(u))
    return [...new Set(names)].sort().join('\n')
  })
  useAuthorMembers(voiceServer, voiceKey)

  const place = useHostedServer(view?.kind === 'channel' ? view.server : null)
  const list = place ? featureAt(channelsFeature, place) : null
  const listed = list && !isUnsupported(list) ? list : null
  const listState = useLive(listed?.state ?? noChannels)

  const dmBeside = useP2p(s => s.home && s.dmList && s.chat !== null)
  if (view?.kind === 'dm' || dmBeside)
    return <DmSidebar dmId={view?.kind === 'dm' ? view.dmId : -1} />

  if (!view) return null
  const detail = servers[view.server]
  if (!detail || !listed)
    return (
      <aside className={base}>
        <ChannelListSkeleton seed={view.server} header className="min-h-0 flex-1" />
      </aside>
    )
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
      className="min-w-0 flex-1 rounded-lg border border-primary bg-transparent px-2 py-1.5 text-base outline-none md:text-sm"
    />
  )

  const createRow = (category: number | null) =>
    editingHere?.mode === 'create' && editingHere.category === category ? (
      <Surface
        as="span"
        pad="sm"
        gap="2xs"
        tone="plain"
        radius="none"
        onBlur={e => {
          if (!e.currentTarget.contains(e.relatedTarget)) submit()
        }}
      >
        <Row as="span" gap="sm">
          <Row as="span" gap="3xs" place="shrink-0">
            <IconButton
              icon={Hash}
              label="Text channel"
              size="sm"
              shape="square"
              pressed={editingHere.kind === 'text'}
              onMouseDown={e => e.preventDefault()}
              onClick={() => acct.channelEdit.getState().setKind('text')}
            />
            <IconButton
              icon={Volume2}
              label="Voice channel"
              size="sm"
              shape="square"
              pressed={editingHere.kind === 'voice'}
              onMouseDown={e => e.preventDefault()}
              onClick={() => acct.channelEdit.getState().setKind('voice')}
            />
          </Row>
          {editInput}
        </Row>
        {editingHere.kind === 'text' && (
          <Row as="label" gap="sm" onMouseDown={e => e.preventDefault()}>
            <input
              type="checkbox"
              className="accent-primary"
              checked={!!editingHere.textOnly}
              onChange={e => acct.channelEdit.getState().setTextOnly(e.target.checked)}
            />
            <span className="text-sm">Text only</span>
          </Row>
        )}
      </Surface>
    ) : null

  const byKey = new Map(detail.channels.map(c => [String(c.id), c]))
  const categoryByKey = new Map((detail.categories ?? []).map(c => [String(c.id), c]))
  const channelOf = (entry: ChannelEntry) => byKey.get(entry.key)
  const renameRow = (entry: ChannelEntry) =>
    editingHere?.mode === 'rename' && String(editingHere.id) === entry.key ? (
      <Surface key={entry.key} as="span" pad="sm" inset="bar" tone="plain" radius="none">
        <Row as="span" gap="none">
          {editInput}
        </Row>
      </Surface>
    ) : null
  const textScopes = (entries: ChannelEntry[]) =>
    entries.filter(c => c.kind === 'text').map(c => `c${c.key}`)

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
        onMenu={(x, y) =>
          openActionMenu(x, y, { kind: 'server', server, folder: null, at: 0 }, undefined, acct)
        }
      />
      <Surface pad="lg" inset="bar" tone="plain" radius="none">
        <Row gap="sm" justify="between">
          <span className="text-xs font-medium tracking-wider text-on-surface-variant uppercase">
            Channels
          </span>
          {canManage && (
            <Row as="span" gap="3xs">
              <IconButton
                icon={FolderPlus}
                label="Create category"
                size="sm"
                onClick={() => openDialog({ kind: 'category', server })}
              />
              <IconButton
                icon={Plus}
                label="Create channel"
                size="sm"
                onClick={() => createIn(null)}
              />
            </Row>
          )}
        </Row>
      </Surface>
      <ChannelList
        channels={listed}
        state={listState}
        look={c => ({
          muted: scopeMuted(acct.store.getState(), { kind: 'channel', id: Number(c.key), server }),
          bold: false,
        })}
        end={c => (
          <>
            <MutedIcon scope={{ kind: 'channel', id: Number(c.key), server }} />
            <HostedChannelEnd
              scopes={[`c${c.key}`]}
              server={server}
              pings={pingsOf(`c${c.key}`)}
              unread={unread(`c${c.key}`)}
            />
          </>
        )}
        voice={entry => {
          const c = channelOf(entry)
          return (
            <VoiceRow
              key={entry.key}
              channel={entry}
              own={ownServer}
              menu={(x, y) => listed.channelMenu(entry.key, x, y)}
              drag={c ? channelDragSpec(c) : undefined}
            />
          )
        }}
        categoryEnd={(_category, hidden) => {
          const hiddenPings = hidden.reduce((n, c) => n + pingsOf(`c${c.key}`), 0)
          const scopes = textScopes(hidden)
          return hiddenPings > 0 ? (
            <PingBadge count={hiddenPings} className="ml-auto" />
          ) : (
            <HostedChannelEnd
              scopes={scopes}
              server={server}
              pings={0}
              unread={scopes.some(unread)}
            />
          )
        }}
        replace={renameRow}
        createRow={category => createRow(category === null ? null : Number(category))}
        onAdd={category => createIn(Number(category.key))}
        drag={{
          scope: dragScope,
          channel: entry => {
            const c = channelOf(entry)
            return c ? channelDragSpec(c) : undefined
          },
          category: entry => {
            const category = categoryByKey.get(entry.key)
            return category ? categoryDragSpec(category) : undefined
          },
          zoneOf: category => (category === null ? NO_CATEGORY : zoneOf(Number(category))),
          categoriesZone: CATEGORIES_ZONE,
          moving: channelDrag,
          over: dropZone,
        }}
      />
      <VoiceDock />
    </aside>
  )
}
